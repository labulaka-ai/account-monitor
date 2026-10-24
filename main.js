'use strict';
/**
 * 账号监控 · 主进程
 *
 * 界面在主窗口里，平台后台用 WebContentsView 嵌在右侧面板 —— 不弹外面的窗口。
 * 每个平台一个 persist:acct-<slug> 分区：Cookie、缓存、IndexedDB 完全隔离，不串号。
 */

const { app, BrowserWindow, WebContentsView, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const db = require('./lib/db');
const sync = require('./lib/sync');
const { makeRegistry } = require('./lib/adapters');
const { makeReader } = require('./lib/reader');
const { capture } = require('./lib/capture');
const extract = require('./lib/extract');
const localApi = require('./lib/local_api');
const aiView = require('./lib/ai_view');
const platProfile = require('./lib/plat_profile');
const export2 = require('./lib/export2');
const reportLib = require('./lib/report');
const { createScheduler } = require('./lib/scheduler');

/** BFS 遍历，只给自测通道用（找字段落在哪个接口） */
function extractWalk(root, visit) {
  extract.bfsWalk(root, visit, { maxDepth: 8 });
}
const chromeCookies = require('./lib/chrome_cookies');
const exporter = require('./lib/export');

// ---------------------------------------------------------------- 路径
const DATA_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'monitor.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const ADAPTER_DIR = path.join(DATA_DIR, 'adapters');

/** 右侧网页面板宽度：够一个创作者后台正常显示，又不把左栏挤没 */
const PANEL_W = 620;

const { UA, FP_FIX, setupSession } = require('./lib/fp');

let win = null;
let panel = null;
let panelSlug = null;
/** 当前面板对应哪个平台 / 哪个环境 / 是不是新开的号 */
let panelCtx = null;
let database = null;
let registry = null;
let reader = null;

const DIAG_DIR = path.join(DATA_DIR, 'diag');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');

/**
 * 读数全局串行。
 *
 * 不串行的后果不是慢，是错：同时开两个隐藏窗口读同一个平台，
 * 两个窗口都写库，SQLite 会报 database is locked；更糟的是两边都以为自己是
 * 「这次唯一的一次读数」，快照互相覆盖。宁可排队，也不要并行。
 */
let syncChain = Promise.resolve();
function queueSync(fn) {
  const run = syncChain.then(fn, fn);
  syncChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// ---------------------------------------------------------------- 工具
function partitionOf(slug) {
  return `persist:acct-${slug}`;
}

/** 库里的 partition 值反解出 slug */
function slugOf(partition) {
  return String(partition || '').replace(/^persist:acct-/, '');
}

function partitionsDir() {
  return path.join(app.getPath('userData'), 'Partitions');
}

/** 分区目录存在 = 这个环境在这台机器上建过（可能已登录） */
function envExists(slug) {
  const dir = path.join(partitionsDir(), `acct-${slug}`);
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function accountsOf(plat) {
  try {
    return database.prepare(`SELECT * FROM accounts WHERE plat = ? ORDER BY created_at ASC`).all(plat) || [];
  } catch {
    return [];
  }
}

/**
 * 这个平台下一个可用的分区序号。
 *
 * 同时看库里和磁盘：只看库里会撞上「删了记录但目录还在」的情况，
 * 一旦复用同一个分区，新号就会拿到上一个号的登录态 —— 这是看不见的串号。
 */
function nextSlug(key, plat) {
  const used = new Set(accountsOf(plat).map((a) => slugOf(a.partition)));
  try {
    for (const d of fs.readdirSync(partitionsDir())) {
      if (d.startsWith(`acct-${key}-`)) used.add(d.slice(5));
    }
  } catch {
    /* 目录还没建 */
  }
  let n = 1;
  while (used.has(`${key}-${n}`)) n++;
  return `${key}-${n}`;
}

/**
 * 老版本是「一个平台一个分区」（acct-xhs），改账号级之后要变成 acct-xhs-1。
 * 不迁移的话，用户已经登好的号会突然显示未登录 —— 这是最容易让人骂人的一次升级。
 */
function migrateLegacyPartitions() {
  const dir = partitionsDir();
  if (!fs.existsSync(dir)) return;

  for (const item of registry.list()) {
    // 老版本 X 分中英两个号，分区名是 x-cn / x-en；现在合成一个 X
    const candidates = [item.key, `${item.key}-cn`, `${item.key}-en`];
    for (const name of candidates) {
      const from = path.join(dir, `acct-${name}`);
      const to = path.join(dir, `acct-${item.key}-1`);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      try {
        fs.renameSync(from, to);
        database
          .prepare(`UPDATE accounts SET partition = ? WHERE partition = ?`)
          .run(partitionOf(`${item.key}-1`), partitionOf(name));
        console.log(`分区迁移：acct-${name} → acct-${item.key}-1（登录态保留）`);
      } catch (err) {
        console.warn(`分区迁移失败 acct-${name}：${err.message}`);
      }
    }
  }
}

/**
 * 接管「磁盘上有环境、库里没记录」的分区。
 *
 * 真实场景：用户在面板里登录完了，但直接关窗口没点「完成登录」。
 * 那个环境是真的、登录态也在，如果不接管，界面会显示未设置，
 * 用户以为白登了一遍 —— 迁移改目录名之后更容易撞上。
 *
 * 但「打开过又取消」也会留下目录。所以不能只看目录在不在，
 * 必须真的有登录凭证才接管 —— 否则点开看一眼就变成「已建环境」，
 * 十二个平台全挂着「已建环境」，用户根本分不清哪个真能用。
 */
async function adoptOrphanPartitions() {
  let names = [];
  try {
    names = fs.readdirSync(partitionsDir());
  } catch {
    return;
  }

  const known = new Set();
  try {
    for (const r of database.prepare('SELECT partition FROM accounts').all()) known.add(slugOf(r.partition));
  } catch {
    /* 表还没建 */
  }

  for (const item of registry.list()) {
    for (const name of names) {
      if (!name.startsWith(`acct-${item.key}-`)) continue;
      const slug = name.slice(5); // 去掉 'acct-'
      if (known.has(slug) || !envExists(slug)) continue;
      // 只有真的登录过才认：没登录态的空环境不算「已建」
      if (!(await hasAuth(session.fromPartition(partitionOf(slug)), item))) continue;

      const id = `acc_${slug}_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
      try {
        database
          .prepare(
            `INSERT INTO accounts (id, plat, partition, created_at, status, backfill_target, auto_sync, sync_interval_h)
             VALUES (?, ?, ?, ?, 'unknown', 'week', 1, 6)`
          )
          .run(id, item.plat, partitionOf(slug), db.nowIso());
        known.add(slug);
        console.log(`接管已有环境：${name} → ${item.plat}`);
      } catch (err) {
        console.warn(`接管 ${name} 失败：${err.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------- 读数
function emit(channel, payload) {
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send(channel, payload);
    } catch {
      /* 窗口正在关 */
    }
  }
}

/** 把这次读数的现场写下来。字段认不出时，靠它一眼看出卡在哪。 */
function saveDiag(slug, debug) {
  try {
    fs.mkdirSync(DIAG_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DIAG_DIR, `${slug}.json`),
      JSON.stringify(Object.assign({ at: db.nowIso(), slug }, debug), null, 2),
      'utf8'
    );
  } catch (err) {
    console.warn('诊断文件写入失败：', err.message);
  }
}

/**
 * 身份锚定。
 *
 * uid 变了 = 同一个环境里换成了别人（串号），必须立刻停写；
 * 昵称变了 = 人家改了名，正常事，更新就行。
 * 用昵称判串号会天天误报，用 uid 才准。
 */
function applyIdentity(account, identity) {
  let cur = null;
  try {
    cur = database
      .prepare('SELECT nickname, handle, uid, fp_nickname, fp_uid FROM accounts WHERE id = ?')
      .get(account.id);
  } catch {
    return { mismatch: false };
  }
  if (!cur) return { mismatch: false };

  const nn = String(identity.nickname || '').slice(0, 60);
  const hd = String(identity.handle || '').slice(0, 60);
  const uid = String(identity.uid || '').slice(0, 60);

  /**
   * 身份锚点：优先 uid，没有 uid 就退回 handle。
   *
   * 原来的判断只看 uid，可 X 和小红书都拿不到稳定 uid
   * （X 的接口里全是别人的用户对象；小红书的 red_num 是「小红书号」，可改），
   * 这两个平台的 uid 一直是空字符串 —— 于是 `cur.fp_uid && uid` 永远为假，
   * **换号了也不会报**。而这两个恰恰是用户最容易登错的平台。
   *
   * handle 会变（改名），但换号时它一定也变，且改名是极低频操作。
   * 所以用 handle 兜底：能发现换号，误报可控。
   */
  const anchor = uid || hd;
  const prevAnchor = cur.fp_uid || '';
  if (prevAnchor && anchor && prevAnchor !== anchor) {
    return {
      mismatch: true,
      why: uid ? `uid 从 ${prevAnchor} 变成 ${anchor}` : `账号从 ${prevAnchor} 变成 ${anchor}`
    };
  }

  try {
    database
      .prepare(
        `UPDATE accounts SET nickname = ?, handle = ?, uid = ?, fp_nickname = ?, fp_uid = ?
         WHERE id = ?`
      )
      .run(
        nn || cur.nickname,
        hd || cur.handle,
        uid || cur.uid,
        cur.fp_nickname || nn,
        cur.fp_uid || anchor,
        account.id
      );
  } catch (err) {
    // 唯一索引撞了：这个 uid 已经绑在另一个号上，确实是串号
    if (/UNIQUE/i.test(err.message)) return { mismatch: true, why: '这个 uid 已经绑在另一个号上' };
    console.warn('身份写回失败：', err.message);
  }
  return { mismatch: false };
}

/**
 * 「登录完成」之后的全部动作。
 *
 * 单独抽出来是因为它有三个调用方：界面上点按钮、自测通道、以及将来「批量导入」。
 * 三处各写一遍必然会漂移 —— 有一处忘了读数据，用户就会看到一个什么都不发生的界面。
 */
async function finishLogin(plat, slug, isNew) {
  const item = registry.get(plat);
  const ses = session.fromPartition(partitionOf(slug));
  const authed = item ? await hasAuth(ses, item) : false;

  let accountId = null;
  const same = accountsOf(plat).find((a) => slugOf(a.partition) === slug);
  if (same) {
    accountId = same.id;
  } else {
    accountId = `acc_${slug}_${Date.now().toString(36)}`;
    try {
      database
        .prepare(
          `INSERT INTO accounts (id, plat, partition, created_at, status, backfill_target, auto_sync, sync_interval_h)
           VALUES (?, ?, ?, ?, 'unknown', 'week', 1, 6)`
        )
        .run(accountId, plat, partitionOf(slug), db.nowIso());
    } catch (err) {
      console.warn('记账号失败：', err.message);
      accountId = null;
    }
  }

  // 刚登录完，平台可能还在回写 Cookie。等一小会儿再动，
  // 否则隐藏窗口拿到的登录态是「半份」，会直接读到登录墙。
  await new Promise((r) => setTimeout(r, 700));
  closePanel();
  emit('plats:update', platSnapshot());

  if (accountId && authed) {
    // 故意不 await：第一次读取要几十秒，不能让「完成登录」按钮一直转圈
    syncQueued(accountId, { trigger: 'first_run' }).catch((err) => {
      console.warn('首次读取异常：', err.message);
      emit('sync:progress', { accountId, plat, slug, phase: 'done', step: `读取出错：${err.message}` });
    });
  }

  return { ok: true, plat, slug, isNew, accountId, authed, started: !!authed };
}

/** 读数的结果翻成人话 —— 界面上只显示这一句 */
function describeResult(res) {
  if (!res) return '没有结果';
  if (res.result === 'throttled') return res.detail || '距上次太近，过一会儿再读';
  if (res.result === 'empty') return res.note || '平台这次没有给出数字';
  if (res.result === 'failed') {
    if (res.reason === 'login_expired') return '登录已失效，需要你本人重新登录';
    if (res.reason === 'fingerprint_mismatch') return '这个环境里的账号和记录不符，已停止写入';
    return res.detail || '读取失败';
  }
  const bits = [];
  if (res.newWorks) bits.push(`新发现 ${res.newWorks} 条作品`);
  if (res.rescanned) bits.push(`更新 ${res.rescanned} 条`);
  if (!bits.length) bits.push('读到数据，没有变化');
  return bits.join('，');
}

/**
 * 读一个号。
 * @returns {Promise<object>} sync.syncAccount 的返回值
 */
async function syncOne(accountId, { trigger = 'manual' } = {}) {
  const account = database.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) return { result: 'failed', detail: '这个号已经不在库里了' };

  const item = registry.get(account.plat);
  if (!item) return { result: 'failed', detail: `没有「${account.plat}」的适配器` };

  const slug = slugOf(account.partition);
  const ses = setupSession(session.fromPartition(partitionOf(slug)));
  const base = { accountId, plat: account.plat, slug };

  emit('sync:progress', Object.assign({}, base, { phase: 'start', step: '准备读取' }));

  const res = await sync.syncAccount({
    database,
    account,
    adapter: item,
    trigger,
    reader: {
      async readAccount(acc, opts) {
        const read = await reader.readAccount(
          acc,
          Object.assign({}, opts, {
            ses,
            firstRun: !acc.last_ok_at,
            onProgress: (step) => emit('sync:progress', Object.assign({}, base, { phase: 'reading', step })),
            onInject: FP_FIX
          })
        );
        if (read.debug) saveDiag(slug, read.debug);

        if (read.identity && (read.identity.nickname || read.identity.uid)) {
          const idr = applyIdentity(acc, read.identity);
          if (idr.mismatch) {
            return {
              status: 'fingerprint_mismatch',
              account: {},
              works: [],
              pages: read.pages || 0,
              note: idr.why,
              debug: read.debug
            };
          }
        }
        return read;
      }
    }
  });

  emit(
    'sync:progress',
    Object.assign({}, base, { phase: 'done', step: describeResult(res), result: res })
  );
  emit('plats:update', platSnapshot());
  return res;
}

/** 排队读，返回值给调用方 */
function syncQueued(accountId, opts) {
  return queueSync(() => syncOne(accountId, opts));
}

function latestSnapshot(accountId) {
  try {
    return (
      database
        .prepare('SELECT * FROM snapshots WHERE account_id = ? ORDER BY date DESC LIMIT 1')
        .get(accountId) || null
    );
  } catch {
    return null;
  }
}

function countWorks(accountId) {
  try {
    return database.prepare('SELECT COUNT(*) AS c FROM works WHERE account_id = ? AND gone = 0').get(accountId).c;
  } catch {
    return 0;
  }
}

function platSnapshot() {
  return registry.list().map(({ plat, slug, icon, brand, brandLight, region, adapter }) => {
    const list = accountsOf(plat);
    return {
      plat,
      slug,
      icon,
      brand,
      brandLight,
      region,
      name: adapter ? adapter.name : plat,
      mode: adapter ? adapter.mode : 'web',
      verifiedAt: adapter ? adapter.verifiedAt : '',
      notes: adapter ? adapter.notes : '',
      // 概览接口的统计口径（'' = 累计，'7d' = 近 7 天）。界面按它改标签 ——
      // 把近 7 天写成「总阅读」是数字真、标签错，最难被发现的那种错。
      overviewWindow: adapter ? adapter.overviewWindow || '' : '',
      // 登录着但暂时不读的平台（读数通道还不可信），界面上要明说
      disabled: !!(adapter && adapter.disabled),
      disabledReason: adapter ? adapter.disabledReason || '' : '',
      caps: adapter ? adapter.caps : { account: [], work: [], extra: [] },
      // 这个平台该看什么：主指标、指标卡顺序、分析角度
      profile: platProfile.profileOf(plat),
      accounts: list.map((a) => {
        const snap = latestSnapshot(a.id);
        return {
          id: a.id,
          nickname: a.nickname,
          handle: a.handle,
          slug: slugOf(a.partition),
          status: a.status,
          lastOkAt: a.last_ok_at,
          lastSyncAt: a.last_sync_at,
          note: a.note || '',
          // 一次都没读过就是 null，界面印「—」而不是 0（0 是「确认没有」）
          followers: snap ? snap.followers : null,
          worksTotal: snap ? snap.works_total : null,
          worksCount: countWorks(a.id)
        };
      }),
      count: list.length,
      // none = 还没建环境  ready = 环境已建但没读过  ok / login_expired = 读过之后的状态
      status: aggStatus(list, slug)
    };
  });
}

/** 一个平台可能挂多个号，卡片只显示最需要人管的那个状态 */
function aggStatus(list, defaultSlug) {
  if (!list.length) return envExists(defaultSlug) ? 'ready' : 'none';
  if (list.some((a) => a.status === 'login_expired')) return 'login_expired';
  if (list.some((a) => a.status === 'fingerprint_mismatch')) return 'fingerprint_mismatch';
  if (list.every((a) => a.status === 'ok')) return 'ok';
  // 有号建了环境但没登录过 —— 这跟「读过了但数据没到」不是一回事，得分开说
  if (list.some((a) => a.status === 'unknown')) return 'unknown';
  return 'ready';
}

// ---------------------------------------------------------------- 窗口
function createWindow() {
  /**
   * 无边框标题栏只在 macOS 上成立。
   *
   * `hiddenInset` 让内容延伸进标题栏，靠左上角的红绿灯按钮拖动窗口。
   * Windows / Linux 上没有这套交通灯 —— 传了会得到一个没有标题栏、
   * 也没有关闭按钮、还拖不动的窗口，等于把窗口锁死。
   * 所以这两个参数只在 darwin 上加，其他平台用系统默认标题栏。
   */
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 940,
    minHeight: 640,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 20 } }
      : {}),
    /**
     * 窗口底色。深色主题下是 #08090B，但浅色主题下用这个深色会闪一下黑。
     * 取中间的浅灰：两种主题下都不刺眼，闪一下也看不出来。
     * 真正的底色由 CSS 决定，这里只负责「还没来得及渲染」的那几十毫秒。
     */
    backgroundColor: '#F1F2F5',
    title: '账号监控',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('resize', layoutPanel);
  win.on('closed', () => {
    win = null;
    panel = null;
  });
}

function layoutPanel() {
  if (!panel || !win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  // 窗口被拉窄时面板跟着收，但不少于 480 —— 再窄平台后台的布局会崩
  const pw = Math.max(480, Math.min(PANEL_W, Math.round(w * 0.56)));
  panel.setBounds({ x: Math.max(0, w - pw), y: 0, width: pw, height: h });
  // 面板是原生视图，永远盖在网页上面。左栏必须知道它占了多宽，
  // 否则内容会伸到面板底下被遮住——按钮上的字就是这么消失的。
  win.webContents.send('panel:width', pw);
}

/**
 * 这个环境里到底有没有这个平台的登录凭证。
 *
 * item 有两种传法：registry.list() 的包装项（有 .adapter），
 * 或者 registry.get() 直接返回的适配器本身。两种都要认 ——
 * 只认一种的话，某个调用点会永远返回「没登录」，而且不报错，
 * 表现是「明明登上了，点完成却说没检测到」。
 */
async function hasAuth(ses, item) {
  const adapter = item && (item.adapter || item);
  const c = adapter && adapter.authCookie;
  if (!c) return false;
  // 有的平台多个站各写一枚不同的 Cookie（小红书就是这样），任一命中即算登录
  const cands = Array.isArray(c.any) ? c.any : [c];
  for (const cand of cands) {
    if (!cand || !cand.name) continue;
    try {
      const q = cand.url ? { url: cand.url, name: cand.name } : { name: cand.name };
      const list = await ses.cookies.get(q);
      if (list.some((x) => x && x.value)) return true;
    } catch {
      /* 这一枚查不到就试下一枚 */
    }
  }
  return false;
}

/**
 * 逐个核对账号的登录凭证还在不在，写回 status。
 *
 * 为什么不信任库里的旧值：登录态会过期（平台踢人、改密码、长时间不用），
 * 而界面上那个绿点直接决定用户「点不点进去看」。写死成 ok 就等于骗人。
 */
async function refreshAuthStatus() {
  let rows = [];
  try {
    rows = database.prepare('SELECT id, plat, partition, status FROM accounts').all();
  } catch {
    return;
  }
  for (const a of rows) {
    const item = registry.list().find((x) => x.plat === a.plat);
    if (!item || !item.adapter) continue;
    const slug = slugOf(a.partition);
    const ok = await hasAuth(session.fromPartition(partitionOf(slug)), item);
    // 三种状态：登着 / 登过但过期了 / 建了环境压根没登过。
    // 最后一种复用 'unknown'——schema 的 CHECK 只认这四个值，改它要重建表，不值当。
    const next = ok ? 'ok' : a.status === 'ok' ? 'login_expired' : 'unknown';
    if (a.status !== next) {
      try {
        const res = database.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(next, a.id);
        console.log(`状态核对 ${a.plat}: ${a.status} → ${next}（影响 ${res.changes} 行）`);
      } catch (e) {
        console.log(`状态写回失败 ${a.plat}: ${e.message}`);
        /* 写不进就算了，界面下次会再核对 */
      }
    }
  }
}

// ---------------------------------------------------------------- 面板

/**
 * 把面板当前地址和标题报给界面。
 *
 * 用途单一但重要：Google 拒绝在嵌入式浏览器里走 OAuth，用户一点「用 Google 登录」
 * 就会落到「此浏览器或应用可能不安全」那一页，看起来像我们坏了，其实是 Google 的策略。
 * 这时候界面要立刻改口，告诉人换一条路，而不是让人对着报错页反复点重试。
 */
async function reportPanelUrl() {
  if (!panel || !win || win.isDestroyed()) return;
  if (!panel.webContents || panel.webContents.isDestroyed()) return;
  try {
    const url = panel.webContents.getURL();
    const title = panel.webContents.getTitle() || '';
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      /* about:blank 之类的 */
    }
    const onGoogle = /(^|\.)google\.com$/.test(host) || /(^|\.)youtube\.com$/.test(host);
    // 只认真正的拒绝页标题。别用「安全」这种宽词，Google 正常登录页正文里就有它。
    const blocked =
      onGoogle && (/无法登录/.test(title) || /couldn.t sign you in/i.test(title) || /may not be secure/i.test(title));
    win.webContents.send('panel:url', { url, title, host, onGoogle, blocked });
  } catch {
    /* 面板已经没了，忽略 */
  }
}

function closePanel(notify = true) {
  if (!win || win.isDestroyed()) return;
  if (panel) {
    try {
      win.contentView.removeChildView(panel);
      panel.webContents.close();
    } catch {
      /* 已经没了 */
    }
    panel = null;
    panelSlug = null;
    panelCtx = null;
  }
  // notify=false 用于「开新面板前先清场」，此时不该让界面误以为用户取消了
  if (notify && win && !win.isDestroyed()) {
    win.webContents.send('panel:state', { open: false });
    win.webContents.send('plats:update', platSnapshot());
  }
}

async function openPanel(plat, opts = {}) {
  const item = registry.list().find((x) => x.plat === plat);
  if (!item || !item.adapter) throw new Error(`未知平台：${plat}`);

  closePanel(false);

  // 点卡片 = 打开这个平台已有的号；点「＋」= 开一个全新的隔离环境
  const list = accountsOf(plat);
  let slug;
  let isNew;
  if (list.length === 0) {
    // 第一个号固定用 1 号槽：上一次没点「完成」留下的目录可以直接复用，
    // 不能因为目录存在就跳到 2 号槽，否则点几次取消就攒出一堆空环境。
    slug = `${item.key}-1`;
    isNew = true;
  } else if (opts.newAccount) {
    slug = nextSlug(item.key, plat);
    isNew = true;
  } else if (opts.slug && list.some((a) => slugOf(a.partition) === opts.slug)) {
    // 详情页点「重新登录」：要开的正是这个号，不是最后一个
    slug = opts.slug;
    isNew = false;
  } else {
    slug = slugOf(list[list.length - 1].partition) || `${item.key}-1`;
    isNew = false;
  }

  const ses = setupSession(session.fromPartition(partitionOf(slug)));

  panel = new WebContentsView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  panelSlug = slug;
  panelCtx = { plat, slug, isNew };

  win.contentView.addChildView(panel);
  layoutPanel();

  // 指纹补齐必须在页面脚本之前跑，否则对方的检测代码已经读过旧值了
  const inject = () => {
    panel && panel.webContents.executeJavaScript(FP_FIX).catch(() => {});
  };
  panel.webContents.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
    if (isMainFrame) inject();
  });
  panel.webContents.on('did-finish-load', () => {
    inject();
    reportPanelUrl();
  });
  panel.webContents.on('did-navigate-in-page', () => reportPanelUrl());
  // 标题晚于页面加载才更新（Google 那页就是），单独监听一次
  panel.webContents.on('page-title-updated', () => reportPanelUrl());

  // 站内弹窗（OAuth、扫码确认）不走系统浏览器，直接在当前面板里打开，保住登录态
  panel.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) panel.webContents.loadURL(url);
    return { action: 'deny' };
  });

  // 没登录过就直接给登录页：先开数据页会被甩到「无法访问」或中间跳转页，
  // 人得自己找路，多绕一步。已经登录过的号照常进数据页。
  const authed = await hasAuth(ses, item);
  const start = (!authed && item.adapter.pages.login) || item.adapter.pages.account;
  await panel.webContents.loadURL(start).catch(() => {});

  win.webContents.send('panel:state', {
    open: true,
    plat,
    slug,
    isNew,
    // 这个环境是第几个号，界面上要写清楚，否则用户不知道自己在登哪个
    index: list.length + (isNew ? 1 : 0),
    url: start
  });
  return { ok: true, slug, isNew };
}

// ---------------------------------------------------------------- IPC
function wireIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    chrome: process.versions.chrome,
    electron: process.versions.electron
  }));

  ipcMain.handle('plats:list', () => platSnapshot());

  ipcMain.handle('panel:open', async (_e, plat, opts) => {
    await openPanel(plat, opts || {});
    return { ok: true };
  });

  /** 用户取消登录：面板关掉，但环境目录已经落地了，要收编，否则下次点会新建一份 */
  ipcMain.handle('panel:close', async () => {
    await adoptOrphanPartitions();
    await refreshAuthStatus();
    closePanel();
    return { ok: true };
  });

  /**
   * 从本机 Chrome 导入登录态。
   *
   * YouTube 和 Meta 全系在面板里几乎登不进去：Google 判「不安全」，Meta 回「请稍后重试」。
   * 但用户自己的 Chrome 里通常是登着的——把那份登录态搬进这个号的隔离分区，
   * 就绕开了整个登录流程。导入的 cookie 只落在该账号的分区里，和其他号互不影响。
   */
  /**
   * 列出本机 Chrome / Edge 的资料，供用户选。
   *
   * 为什么必须能选：Chrome 一台机器上常有 6~7 个资料（Default、Profile 1…），
   * 登录不同账号。**只取 Default 会漏掉真正登录着的那个**。
   * 实测这台机器：Default 里没有 LOGIN_INFO（YouTube 认不出登录），
   * 而 Profile 1 / 3 / 6 里都有 —— 用户点了「导入」却一直显示未登录，
   * 根因就是默认挑了 Default。
   */
  ipcMain.handle('chrome:profiles', () => {
    try {
      const list = chromeCookies.listProfiles().map((p) => ({ name: p.name }));
      return { ok: true, profiles: list };
    } catch (err) {
      return { ok: false, error: err.message, profiles: [] };
    }
  });

  /**
   * 导入登录态。
   * @param {string} [profileName] 指定 Chrome 资料；不传就挨个试，
   *   直到找到「真的能登录」的那一份 —— 这比让用户自己猜哪份是对的友好得多。
   */
  ipcMain.handle('panel:importChrome', async (_e, profileName) => {
    if (!panelCtx) return { ok: false, error: '没有打开的面板' };
    const item = registry.list().find((x) => x.plat === panelCtx.plat);
    if (!item || !item.adapter) return { ok: false, error: '未知平台' };

    const domains = item.adapter.cookieDomains || [];
    if (!domains.length) return { ok: false, error: '这个平台还没配 Cookie 白名单' };

    const authName = item.adapter.authCookie ? item.adapter.authCookie.name : '';

    /**
     * 候选资料：指定了就只试那一个；没指定就试全部。
     * 每份都看「有没有那枚关键 Cookie」—— 有才值得导，
     * 否则导进去一堆无关 Cookie，用户还是会看到「未登录」。
     */
    let names = [];
    try {
      const all = chromeCookies.listProfiles().map((p) => p.name);
      names = profileName ? [profileName] : all;
    } catch (err) {
      return { ok: false, error: '读取 Chrome 失败：' + err.message };
    }
    if (!names.length) return { ok: false, error: '这台电脑上没找到 Chrome 资料' };

    const tried = [];
    let picked = null;
    let res = null;
    for (const name of names) {
      let r = null;
      try {
        r = await chromeCookies.readCookiesFor(domains, name);
      } catch (err) {
        tried.push({ name, error: err.message.slice(0, 60) });
        continue;
      }
      const cookies = (r && r.cookies) || [];
      const hasAuth = authName ? cookies.some((c) => c.name === authName) : cookies.length > 0;
      tried.push({ name, count: cookies.length, hasAuth });
      if (!picked && cookies.length && hasAuth) {
        picked = name;
        res = { cookies };
        break; // 找到能用的就停，不白导其他人的号
      }
      // 没指定资料时，把「第一条有 Cookie 的」留作兜底
      if (!res && cookies.length) res = { cookies };
    }

    if (!res || !res.cookies.length) {
      return {
        ok: false,
        error: `Chrome 里没有 ${panelCtx.plat} 的登录态。请先在 Chrome 里登录一次，再回来导入。`,
        tried
      };
    }
    if (authName && !picked && !profileName) {
      // 有 Cookie 但都不含关键那枚 —— 说清楚是「哪一枚缺了」，别让人瞎猜
      return {
        ok: false,
        error:
          `Chrome 里有 ${panelCtx.plat} 的 Cookie，但都缺「${authName}」（判断登录用的那一枚）。` +
          `到 ${panelCtx.plat} 网站上打开一次，让它自己写入，然后再导入。`,
        tried
      };
    }

    const ses = session.fromPartition(partitionOf(panelCtx.slug));
    let count = 0;
    let failed = 0;
    for (const c of res.cookies) {
      try {
        await ses.cookies.set(c);
        count++;
      } catch {
        failed++;
      }
    }

    /**
     * 导完必须**验证**，不能只看「写进去几条」。
     *
     * 之前的问题是：导了 60 条 Cookie 就说成功，但其中没有关键那枚，
     * 页面照样是未登录 —— 用户以为成功了，实际什么也没发生。
     * 现在导完立刻用 hasAuth 复查，如实说结果。
     */
    let authed = false;
    try {
      const ses2 = setupSession(session.fromPartition(partitionOf(panelCtx.slug)));
      authed = await hasAuth(ses2, item);
    } catch {
      authed = false;
    }

    // 导完必须重新加载，页面才会带上新 Cookie
    if (panel && !panel.webContents.isDestroyed()) {
      panel.webContents.reloadIgnoringCache();
    }

    const usedProfile = picked || profileName || (tried[0] && tried[0].name) || '';
    return {
      ok: true,
      count,
      failed,
      profile: usedProfile,
      tried,
      // 关键：告诉界面「写完这么多条之后，登录态到底生效了没有」
      authed: !!authed,
      authName,
      locked: res.encrypted || 0,
      warning: authed
        ? ''
        : `写进去 ${count} 条 Cookie，但登录态还没生效` +
          (authName ? `（缺「${authName}」）` : '') +
          '。到网站上打开一次让它写入，或者换一个 Chrome 资料再试。'
    };
  });

  /** 面板里加载别的页面（登录入口、帮助页） */
  ipcMain.handle('panel:go', async (_e, url) => {
    if (!panel || !/^https?:\/\//.test(url)) return { ok: false };
    await panel.webContents.loadURL(url).catch(() => {});
    return { ok: true };
  });

  /**
   * 用户在面板里登录完了，点「完成登录」。
   *
   * 这一步不只是一个确认动作，它是「读数的起点」：
   *   1. 先核对登录凭证真的在（不然会造出一个永远读不到东西的空号）
   *   2. 记账号
   *   3. 关面板，自动开始第一次读取（队列里跑，不阻塞界面）
   *
   * 用户在这个界面上看到的应该是「正在读取」，而不是「已记录」之后什么都没有。
   */
  ipcMain.handle('panel:done', async () => {
    if (!panelCtx) return { ok: false, error: '没有打开的面板' };
    const { plat, slug, isNew } = panelCtx;
    return finishLogin(plat, slug, isNew);
  });

  /**
   * 退出登录：直接清掉这个账号专属分区里的登录态。
   *
   * 为什么必须有这个：平台的退出按钮经常点不动 —— 有的藏在三层菜单里，
   * 有的页面被「验证你的身份」卡死、整个界面只剩一个弹窗，这时候
   * 用户其实没有任何操作空间，只能看着错误账号干着急。
   *
   * 能这么干的前提是这个 App 的结构：**一个号一个分区**，
   * 清 acct-x-1 不会碰到 acct-ig-1，也不会动到用户真实的浏览器。
   * 清的内容：cookie + 各种 storage + 缓存索引，等于「这个环境从没用过」。
   *
   * 不清数据库：作品和指标留着。用户可能只是想换个号再登回来，
   * 历史数据不该因为换登录态就消失。要清数据是另一个动作（导出/删除账号）。
   */
  ipcMain.handle('account:logout', async (_e, accountId) => {
    const acc = database.prepare('SELECT * FROM accounts WHERE id = ?').get(String(accountId || ''));
    if (!acc) return { ok: false, error: '这个号不在库里' };

    const slug = slugOf(acc.partition);
    const ses = session.fromPartition(acc.partition);
    const item = registry.get(acc.plat);
    const authName = item && item.authCookie ? item.authCookie.name : '';

    let hadAuth = false;
    try {
      const all = await ses.cookies.get({});
      hadAuth = authName ? all.some((c) => c.name === authName) : all.length > 0;
    } catch {
      /* 读不到就当没有 */
    }

    // 面板正开着这个分区就先关掉，否则它会在内存里继续持有会话
    if (panelCtx && panelCtx.slug === slug) closePanel(false);

    try {
      await ses.clearStorageData({
        storages: [
          'cookies',
          'localstorage',
          'indexdb',
          'websql',
          'serviceworkers',
          'cachestorage',
          'shadercache'
        ]
      });
      await ses.clearCache();
    } catch (err) {
      return { ok: false, error: `清理登录态失败：${err.message}` };
    }

    // 状态改成「还没登录」，但保留 nickname 之外的身份锚点，好让下次登录能比对
    database
      .prepare("UPDATE accounts SET status = 'unknown', note = '' WHERE id = ?")
      .run(acc.id);

    console.log(`退出登录：${acc.plat} ${slug}（清掉了 ${hadAuth ? '有效' : '空的'}登录态）`);
    emit('plats:update', platSnapshot());
    return { ok: true, plat: acc.plat, slug, hadAuth };
  });

  /**
   * 想知道「这个环境现在到底是谁」—— 不打开面板也能问。
   * 换号之后界面要能立刻反映，不能等下一次读数。
   */
  ipcMain.handle('account:whoami', async (_e, accountId) => {
    const acc = database.prepare('SELECT * FROM accounts WHERE id = ?').get(String(accountId || ''));
    if (!acc) return { ok: false, error: '这个号不在库里' };
    const item = registry.get(acc.plat);
    if (!item) return { ok: false, error: '未知平台' };
    const ses = setupSession(session.fromPartition(acc.partition));
    const authed = await hasAuth(ses, item);
    return {
      ok: true,
      authed,
      plat: acc.plat,
      slug: slugOf(acc.partition),
      nickname: acc.nickname,
      status: acc.status
    };
  });

  /** 某平台下所有号的概要 —— 点平台卡片进来先看这个 */
  ipcMain.handle('plat:detail', (_e, plat) => {
    const item = registry.get(plat);
    if (!item) return { ok: false, error: '未知平台' };
    const list = accountsOf(plat).map((a) => {
      const snap = latestSnapshot(a.id);
      return {
        id: a.id,
        nickname: a.nickname,
        handle: a.handle,
        slug: slugOf(a.partition),
        status: a.status,
        lastOkAt: a.last_ok_at,
        lastSyncAt: a.last_sync_at,
        note: a.note || '',
        followers: snap ? snap.followers : null,
        totalReads: snap ? snap.total_reads : null,
        totalLikes: snap ? snap.total_likes : null,
        worksTotal: snap ? snap.works_total : null,
        worksCount: countWorks(a.id)
      };
    });
    return {
      ok: true,
      plat,
      caps: item.caps,
      // 详情页要用它决定「指标卡摆哪几张、以哪个为主」
      profile: platProfile.profileOf(plat),
      verifiedAt: item.verifiedAt || '',
      notes: item.notes || '',
      overviewWindow: item.overviewWindow || '',
      disabled: !!item.disabled,
      disabledReason: item.disabledReason || '',
      accounts: list
    };
  });

  /** 一个号的完整数据：指标、作品、最近几次读取记录 */
  ipcMain.handle('account:detail', (_e, accountId, opts = {}) => {
    const acc = database.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!acc) return { ok: false, error: '这个号不在库里' };

    const limit = Math.max(1, Math.min(1000, opts.limit || 200));
    const snaps = database
      .prepare('SELECT * FROM snapshots WHERE account_id = ? ORDER BY date DESC LIMIT 120')
      .all(acc.id);

    // 每条作品只取最新一次指标：历史留在库里，但表格里只显示当前值
    const works = database
      .prepare(
        `SELECT w.id, w.plat_work_id, w.title, w.published_at, w.cover_path, w.last_scanned_at,
                m.reads, m.likes, m.saves, m.comments, m.shares, m.completion,
                m.new_followers, m.extra, m.captured_at
           FROM works w
           LEFT JOIN work_metrics m
             ON m.work_id = w.id
            AND m.captured_at = (SELECT MAX(captured_at) FROM work_metrics WHERE work_id = w.id)
          WHERE w.account_id = ? AND w.gone = 0
          ORDER BY w.published_at DESC, w.first_seen_at DESC
          LIMIT ?`
      )
      .all(acc.id, limit);

    const logs = database
      .prepare(
        `SELECT started_at, trigger, pages, new_works, rescanned, result, detail
           FROM sync_log WHERE account_id = ? ORDER BY started_at DESC LIMIT 8`
      )
      .all(acc.id);

    /**
     * 每个作品的「读数历史」：发布后多久读到多少。
     *
     * 为什么要这个：判断一条内容好不好，只看现在的累计值是不够的 ——
     * 一条发了 7 天读到 500 和一条发了 2 小时读到 500 完全不是一回事。
     * 有了这条时间轴才能做「发布后 24 小时」的横比（那才是公平的口径）。
     *
     * 只取最近 30 个采样点：再早的要么是同一天的重复读数，要么已经没比较价值。
     */
    const samplesByWork = new Map();
    try {
      const rows = database
        .prepare(
          `SELECT m.work_id, m.captured_at, m.reads, m.likes, m.age_hours
             FROM work_metrics m
             JOIN works w ON w.id = m.work_id
            WHERE w.account_id = ? AND w.gone = 0 AND m.reads IS NOT NULL
            ORDER BY m.work_id, m.captured_at ASC`
        )
        .all(acc.id);
      for (const r of rows) {
        if (!samplesByWork.has(r.work_id)) samplesByWork.set(r.work_id, []);
        const arr = samplesByWork.get(r.work_id);
        if (arr.length >= 30) continue;
        arr.push({
          at: r.captured_at,
          reads: r.reads == null ? null : Number(r.reads),
          likes: r.likes == null ? null : Number(r.likes),
          ageHours: r.age_hours == null ? null : Number(r.age_hours)
        });
      }
    } catch (e) {
      // 老库还没跑 v3 迁移时没有 age_hours 列，这里不该让整个详情页打不开
      console.warn('作品采样历史读不到：', e.message);
    }

    /**
     * 每日序列：作品指标的按天合计。
     *
     * 为什么不能直接用「每条作品的最新值」去画趋势：那只有一个点。
     * 同一个作品每次读数都会落一行 work_metrics，所以按天把「当天最后一次读数」加起来，
     * 就是「这一天结束时，这个号所有作品一共多少阅读 / 多少赞」—— 这才是能画的曲线。
     *
     * 分组用本地时区（localtime）：captured_at 存的是 UTC，凌晨读的那次如果按 UTC
     * 算会落到前一天，图上就会出现「昨天涨了、今天跌了」的假波动。
     */
    let daily = [];
    try {
      daily = database
        .prepare(
          `SELECT date(m.captured_at, 'localtime') AS d,
                  SUM(m.reads)     AS reads,
                  SUM(m.likes)     AS likes,
                  SUM(m.saves)     AS saves,
                  SUM(m.comments)  AS comments,
                  SUM(m.shares)    AS shares,
                  COUNT(*)         AS works
             FROM works w
             JOIN work_metrics m ON m.work_id = w.id
            WHERE w.account_id = ? AND w.gone = 0
              AND m.captured_at = (
                    SELECT MAX(m2.captured_at) FROM work_metrics m2
                     WHERE m2.work_id = w.id
                       AND date(m2.captured_at, 'localtime') = date(m.captured_at, 'localtime'))
            GROUP BY date(m.captured_at, 'localtime')
            ORDER BY d`
        )
        .all(acc.id);
    } catch (e) {
      // 老库没有这些列也不要整个详情页都打不开
      console.warn('每日序列算不出来：', e.message);
    }

    let diag = null;
    try {
      const p = path.join(DIAG_DIR, `${slugOf(acc.partition)}.json`);
      if (fs.existsSync(p)) diag = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      /* 诊断文件坏了不影响主流程 */
    }

    return {
      ok: true,
      account: {
        id: acc.id,
        plat: acc.plat,
        nickname: acc.nickname,
        handle: acc.handle,
        slug: slugOf(acc.partition),
        status: acc.status,
        createdAt: acc.created_at,
        lastOkAt: acc.last_ok_at,
        lastSyncAt: acc.last_sync_at,
        note: acc.note || ''
      },
      latest: snaps[0] || null,
      prev: snaps[1] || null,
      series: snaps.slice().reverse(),
      // 作品级按天合计（阅读/赞/评/享/条数），比「每次读数一个点」密得多
      daily,
      works: works.map((w) => {
        let extra = {};
        try {
          extra = w.extra ? JSON.parse(w.extra) : {};
        } catch {
          extra = {};
        }
        return Object.assign({}, w, { extra, samples: samplesByWork.get(w.id) || [] });
      }),
      logs,
      diag
    };
  });

  /** 手动刷新一个号 */
  ipcMain.handle('account:sync', async (_e, accountId) => {
    const res = await syncQueued(accountId, { trigger: 'manual' });
    return Object.assign({ ok: res.result !== 'failed' }, res, { message: describeResult(res) });
  });

  /** 刷新一个平台下的所有号（排队依次读，不并行） */
  ipcMain.handle('plat:syncAll', async (_e, plat) => {
    const list = accountsOf(plat);
    const out = [];
    for (const a of list) out.push(await syncQueued(a.id, { trigger: 'manual' }));
    return { ok: true, results: out.map((r) => Object.assign({ message: describeResult(r) }, r)) };
  });

  /** 导出：CSV 落在 data/exports/，导完在访达里定位到它 */
  ipcMain.handle('account:export', (_e, accountId, format) => {
    try {
      const file = exporter.exportAccount(database, accountId, format || 'csv', EXPORT_DIR);
      shell.showItemInFolder(file);
      return { ok: true, file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * 把 MCP 脚本复制到用户自己的数据目录，并算出「用户该怎么配」。
   *
   * 为什么不能直接用开发时的路径：
   *   1. 打包后 __dirname 在 app.asar 里面，外部的 node 打不开 asar 里的 .js
   *   2. 更根本的是：那是**开发者的**路径，别人的机器上根本不存在
   *
   * 复制到 DATA_DIR（打包后就是 userData/data）之后：
   *   · 路径属于用户自己，跟着用户的账号数据走
   *   · 不在 asar 里，任何 node 都能跑
   *   · 脚本按 __dirname/.. 找数据，正好对上
   *
   * 每次启动都覆盖一次：app 升级时 MCP 协议跟着更新，用户不用手动换文件。
   */
  ipcMain.handle('ai:mcpConfig', async () => {
    const src = path.join(__dirname, 'mcp', 'server.js');
    const dest = path.join(DATA_DIR, 'mcp-server.js');
    let copied = false;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.copyFileSync(src, dest);
      copied = true;
    } catch (err) {
      console.warn('MCP 脚本复制失败：', err.message);
    }

    /**
     * 用哪一个程序去跑这个脚本？
     *
     * 优先用**应用自己**（`process.execPath`）—— Electron 内置 Node，
     * 用户机器上一定有，加 ELECTRON_RUN_AS_NODE=1 就以纯 Node 模式运行、不开窗口。
     * 这样用户不需要另外装 node，少一个失败点。
     *
     * 关键：`process.execPath` 是**运行时算出来的**，所以：
     *   开发态 → …/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
     *   打包后 → /Applications/账号监控.app/Contents/MacOS/账号监控
     * 别人装了他的包，配置里自动是他自己机器上的路径，不会带我的用户名。
     *
     * 开发态多给一个 `node` 版本：路径更干净（不含 node_modules），
     * 适合开发机上已经装了 node 的人。
     */
    const exec = process.execPath;
    const isPackaged = app.isPackaged;

    return {
      ok: copied,
      scriptPath: dest,
      /**
       * 明确告诉界面：这份配置是**这台电脑**的。
       * 本地工具的配置天生带用户名和绝对路径 —— 没法避免，
       * 但只要说清楚「打包后会自动变」，用户就不会以为哪里错了。
       */
      isLocal: true,
      note: isPackaged
        ? '这份配置是这台电脑上的。别人装了他自己的安装包，配置里会是他的路径。'
        : '你现在跑的是开发版，所以路径指向项目目录。打包成 .app 之后，这里会自动变成安装位置和用户数据目录。',
      // 给用户看的配置（可直接粘贴）
      config: {
        mcpServers: {
          'account-monitor': {
            command: exec,
            args: [dest],
            env: {
              // 让 Electron 走纯 Node 模式；没有这一行它会试图开窗口
              ELECTRON_RUN_AS_NODE: '1',
              AM_DATA_DIR: DATA_DIR
            }
          }
        }
      },
      // 装了 node 的人也可以用更干净的方式
      nodeConfig: {
        mcpServers: {
          'account-monitor': {
            command: 'node',
            args: [dest],
            env: { AM_DATA_DIR: DATA_DIR }
          }
        }
      },
      exec,
      packaged: isPackaged
    };
  });

  /**
   * 每日自动更新：状态、改时间、立刻跑一轮。
   *
   * 界面上要能看到三件事：开没开、下次什么时候、今天跑过没有。
   * 只说「已开启」不够 —— 用户会怀疑它到底有没有动。
   */
  ipcMain.handle('daily:status', () => {
    const p = dailyPrefs();
    const st = daily ? daily.state() : { date: '', result: '' };
    let nextAt = '';
    try {
      const { nextRunAt } = require('./lib/scheduler');
      if (p.enabled) nextAt = nextRunAt(p.hour, p.minute).toISOString();
    } catch {
      /* 算不出来就不显示 */
    }
    return {
      ok: true,
      enabled: p.enabled,
      hour: p.hour,
      minute: p.minute,
      // 今天跑过没有 + 结果摘要
      lastDate: st.date,
      lastResult: st.result,
      ranToday: st.date === require('./lib/scheduler').localDate(),
      nextAt,
      running: daily ? daily.isRunning() : false
    };
  });

  ipcMain.handle('daily:save', (_e, p = {}) => {
    const next = setDailyPrefs(p);
    // 改了设置要重排 —— 否则用户把时间从 8:30 改成 9:00，今天还是按 8:30 走
    if (daily) {
      daily.stop();
      if (next.enabled) daily.start();
    }
    return { ok: true, ...next };
  });

  /** 手动跑一轮全部（设置里的「现在全部更新」） */
  ipcMain.handle('daily:runNow', async () => {
    if (!daily) return { ok: false, error: '调度器还没起来' };
    if (daily.isRunning()) return { ok: false, error: '已经在跑了，等这一轮结束' };
    const r = await daily.runNow();
    /**
     * 注意别让 `ok` 打架：外层 `ok` 是「这次请求有没有成功」，
     * 里面统计的成功个数用 `succeeded`。
     * 两个都叫 ok 的话，界面拿 `r.ok` 当作成功数会永远显示 1。
     */
    return {
      ok: true,
      total: r.total,
      succeeded: r.ok,
      throttled: r.throttled,
      failed: r.failed,
      details: r.details
    };
  });

  /**
   * AI 接入：查状态、开关、换密钥。
   *
   * 开关状态落在 data/ai.json，密钥落在 data/ai-token.txt（权限 600）。
   * 关掉的时候会真的把端口关掉，不是「关了但还能连」。
   */
  ipcMain.handle('ai:status', () => ({
    ok: true,
    ...localApi.readState(DATA_DIR),
    running: !!aiServer,
    url: aiInfo.url || `http://127.0.0.1:${localApi.readState(DATA_DIR).port || localApi.PORT_DEFAULT}`,
    token: aiInfo.token || localApi.ensureToken(DATA_DIR),
    tokenFile: localApi.tokenPath(DATA_DIR),
    // MCP 脚本的绝对路径：用户要把它抄进 AI 客户端的配置里，
    // 相对路径在他那边是无效的
    serverPath: path.join(__dirname, 'mcp', 'server.js'),
    error: aiInfo.error || ''
  }));

  ipcMain.handle('ai:toggle', async (_e, on) => {
    const st = localApi.readState(DATA_DIR);
    st.enabled = !!on;
    if (!st.port) st.port = localApi.PORT_DEFAULT;
    st.createdAt = st.createdAt || new Date().toISOString();
    localApi.writeState(DATA_DIR, st);
    await stopAiApi();
    if (st.enabled) await startAiApiIfEnabled();
    else aiInfo = { enabled: false, port: 0, token: '' };
    return {
      ok: !aiInfo.error,
      enabled: st.enabled,
      running: !!aiServer,
      port: st.port,
      url: st.enabled ? `http://127.0.0.1:${st.port}` : '',
      token: localApi.ensureToken(DATA_DIR),
      tokenFile: localApi.tokenPath(DATA_DIR),
      serverPath: path.join(__dirname, 'mcp', 'server.js'),
      error: aiInfo.error || ''
    };
  });

  /** 换一个密钥：旧密钥立刻失效（服务会被重启） */
  ipcMain.handle('ai:rotate', async () => {
    const p = localApi.tokenPath(DATA_DIR);
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* 不存在就算了 */
    }
    const token = localApi.ensureToken(DATA_DIR);
    if (aiServer) {
      await stopAiApi();
      await startAiApiIfEnabled();
    }
    return { ok: true, token };
  });

  /**
   * 资料导出：csv / xlsx / json。
   *
   * 与旧 account:export 的区别：可以选择多个账号、可以按时间范围。
   * 旧的那个只导一个号、没有时间范围，保留着不动（下面还在用）。
   */
  ipcMain.handle('data:export', (_e, opts = {}) => {
    try {
      const r = export2.exportData(database, {
        accountIds: Array.isArray(opts.accountIds) ? opts.accountIds : [],
        plats: Array.isArray(opts.plats) ? opts.plats.map(String) : [],
        format: String(opts.format || 'xlsx'),
        range: opts.range ? String(opts.range) : '',
        outDir: EXPORT_DIR
      });
      // 导完在访达里定位到第一个文件 —— 用户马上要用的就是它
      try {
        shell.showItemInFolder(r.file);
      } catch {
        /* 定位失败不影响导出成功 */
      }
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * 生成报告。
   *
   * PDF 走 Electron 自己的 printToPDF：中文、字体、分页都由 Chromium 负责。
   * 自己拼 PDF 要嵌中文字体并做子集化，几百行代码还有缺字风险，不值得。
   *
   * 隐藏窗口用完必须销毁 —— 不然每生成一次报告就漏一个渲染进程，
   * 生成十几次之后内存就吃紧了。
   */
  ipcMain.handle('report:generate', async (_e, opts = {}) => {
    let hidden = null;
    try {
      /**
       * 导出范围：全部 / 某个平台 / 某几个平台。
       *
       * split = true 时给每个平台各出一份独立文件 —— 给平台负责人发的时候
       * 只要发他自己那一份，不用让他从全平台报告里挑。
       */
      const plats = Array.isArray(opts.plats) ? opts.plats.map(String).filter(Boolean) : [];
      const split = !!opts.split;
      const fmt = String(opts.format || 'md');

      let jobs = [{ plats }];
      if (split) {
        const all = plats.length
          ? plats
          : [...new Set(
              database
                .prepare('SELECT DISTINCT plat FROM accounts')
                .all()
                .map((r) => r.plat)
            )];
        jobs = all.map((p) => ({ plats: [p] }));
      }

      const pdfPrinter = async (html) => {
        const { BrowserWindow } = require('electron');
        hidden = new BrowserWindow({
          show: false,
          width: 900,
          height: 1200,
          webPreferences: { javascript: false, sandbox: true, offscreen: true }
        });
        // data: URL 不用写临时文件；base64 避免中文被 URL 编码破坏
        const b64 = Buffer.from(html, 'utf8').toString('base64');
        await hidden.loadURL(`data:text/html;charset=utf-8;base64,${b64}`);
        const buf = await hidden.webContents.printToPDF({
          pageSize: 'A4',
          printBackground: true,
          margins: { marginType: 'custom', top: 0.55, bottom: 0.55, left: 0.5, right: 0.5 }
        });
        // 每次都要销毁再建：同一个窗口连续 printToPDF 会拿到上一份的版面
        try {
          hidden.destroy();
        } catch {
          /* 已经没了 */
        }
        hidden = null;
        return buf;
      };

      const files = [];
      let last = null;
      for (const job of jobs) {
        const rep = reportLib.buildReport(database, {
          range: String(opts.range || 'month'),
          accountIds: Array.isArray(opts.accountIds) ? opts.accountIds : [],
          plats: job.plats
        });
        const r = await export2.writeReport(rep, fmt, EXPORT_DIR, { pdfPrinter });
        files.push(r.file);
        last = rep;
      }

      try {
        shell.showItemInFolder(files[0]);
      } catch {
        /* 同上 */
      }
      return {
        ok: true,
        file: files[0],
        files,
        split,
        period: last.period.label,
        platforms: last.total.platforms,
        accounts: last.total.accounts,
        works: last.total.works
      };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      if (hidden) {
        try {
          hidden.destroy();
        } catch {
          /* 已经没了 */
        }
      }
    }
  });

  /** 报告预览（界面里先看，再决定导不导出） */
  ipcMain.handle('report:preview', (_e, opts = {}) => {
    try {
      const rep = reportLib.buildReport(database, {
        range: String(opts.range || 'month'),
        accountIds: Array.isArray(opts.accountIds) ? opts.accountIds : [],
        plats: Array.isArray(opts.plats) ? opts.plats.map(String).filter(Boolean) : []
      });
      return {
        ok: true,
        period: rep.period,
        total: rep.total,
        scoped: rep.scoped || [],
        markdown: reportLib.toMarkdown(rep)
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /** 打开诊断文件所在目录 —— 读不到数据时，这是唯一能看现场的地方 */
  ipcMain.handle('diag:open', () => {
    fs.mkdirSync(DIAG_DIR, { recursive: true });
    shell.openPath(DIAG_DIR);
    return { ok: true };
  });

  ipcMain.handle('panel:reload', () => {
    if (panel) panel.webContents.reload();
    return { ok: true };
  });

  ipcMain.handle('shell:openData', () => {
    shell.openPath(DATA_DIR);
    return { ok: true };
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { ok: true };
  });
}

// ---------------------------------------------------------------- 自测通道
/**
 * 开发期自测通道：往 data/dev/cmd.json 写一条命令，主进程执行后把结果写进 out.json。
 *
 * 为什么需要它：读数是「打开真页面 → 抓接口 → 认字段」，而平台页面改动是常态。
 * 没有这条通道，每调一个平台都得关掉 App、开测试进程、再开回来，
 * 而且两个进程抢同一个分区目录会锁死。
 *
 * 只在没打包时启用（app.isPackaged 为真时整段不运行）。
 * 命令只认几种固定操作，不执行任意 shell，不联网。
 */
async function runDevCmd(cmd) {
  const op = String((cmd && cmd.op) || '');

  if (op === 'read') {
    const slug = String(cmd.slug || '');
    const item = registry.list().find((x) => slug.startsWith(`${x.key}-`));
    if (!item) throw new Error(`没有匹配的平台：${slug}`);

    const ses = setupSession(session.fromPartition(partitionOf(slug)));
    const account =
      database.prepare('SELECT * FROM accounts WHERE partition = ?').get(partitionOf(slug)) || {
        id: 'probe',
        plat: item.plat,
        partition: partitionOf(slug),
        last_ok_at: ''
      };

    const t0 = Date.now();
    const read = await reader.readAccount(account, { ses, firstRun: true, onInject: FP_FIX });
    if (read.debug) saveDiag(slug, read.debug);

    return {
      slug,
      plat: item.plat,
      ms: Date.now() - t0,
      status: read.status,
      note: read.note,
      pages: read.pages,
      account: read.account,
      identity: read.identity,
      worksCount: read.works.length,
      // 对账用：平台说的总数 vs 实际读到的条数。两个数不一样就说明没读全。
      worksTotal: read.worksTotal,
      worksTotalKnown: read.worksTotalKnown,
      complete: read.complete,
      // 逐页对账明细：调到「为什么没读全」时只有这个说得清
      pageStats: read.pageStats,
      works: read.works.slice(0, 10),
      workPath: read.debug ? read.debug.workPath : '',
      interfaceCount: read.debug ? read.debug.interfaceCount : 0,
      interfaces: read.debug ? read.debug.interfaces : [],
      textHead: read.debug ? String(read.debug.textHead || '').slice(0, 700) : ''
    };
  }

  if (op === 'eval') {
    if (!win || win.isDestroyed()) throw new Error('窗口没开');
    const value = await win.webContents.executeJavaScript(String(cmd.code || 'null'), true);
    return { value };
  }

  /**
   * 面板当前在哪一页。
   *
   * 面板是 WebContentsView：主窗口的 eval 看不见它，capturePage 也抓不到它。
   * 没有这个口，一旦「登录页白屏」，在主界面这边完全无法判断到底是没加载、
   * 还是被平台拦了、还是加载到了别的地址。
   */
  if (op === 'panel') {
    if (!panel || !panel.webContents || panel.webContents.isDestroyed()) return { open: false };
    const url = panel.webContents.getURL();
    const title = panel.webContents.getTitle() || '';
    let text = '';
    try {
      text = await panel.webContents.executeJavaScript(
        'String((document.body && document.body.innerText) || "").slice(0, 600)',
        true
      );
    } catch {
      /* 页面还没就绪 */
    }
    // 顺便把面板里的输入框情况报出来：判断「能不能登录」就看这个
    let inputs = null;
    try {
      inputs = await panel.webContents.executeJavaScript(
        '({ user: !!document.querySelector("input[name=username],input[name=email]"), pwd: !!document.querySelector("input[type=password]") })',
        true
      );
    } catch {
      /* 同上 */
    }
    return { open: true, url, title, text: String(text).replace(/\n{2,}/g, '\n').slice(0, 600), inputs };
  }

  /**
   * 调试协议探针。
   * 读不到接口数据时，先分清是「页面本来就没发请求」还是「调试协议挂不上」。
   * 这两种情况的修法完全不同：前者要换读数通道，后者要换 attach 方式。
   */
  if (op === 'dbg') {
    const { BrowserWindow } = require('electron');
    const w = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: { sandbox: !!cmd.sandbox, backgroundThrottling: false }
    });
    const d = w.webContents.debugger;
    const race = (p, ms) =>
      Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`超时 ${ms}ms`)), ms))]);
    const out = { attached: false, isAttached: false, versions: [], err: '' };

    for (const v of ['1.3', '1.2', null]) {
      try {
        if (v) d.attach(v);
        else d.attach();
        out.attached = true;
        out.usedVersion = v || '(默认)';
        break;
      } catch (e) {
        out.versions.push(`${v || '默认'}: ${e.message}`);
      }
    }
    out.isAttached = d.isAttached ? d.isAttached() : null;

    if (out.attached) {
      try {
        out.runtime = await race(d.sendCommand('Runtime.enable'), 3000);
        out.runtimeOk = true;
      } catch (e) {
        out.runtimeErr = e.message;
      }
      try {
        await race(d.sendCommand('Network.enable'), 4000);
        out.netOk = true;
      } catch (e) {
        out.netErr = e.message;
      }
    }

    try {
      await w.loadURL(String(cmd.url || 'https://example.com'));
      out.url = w.webContents.getURL();
      out.jsOk = await race(w.webContents.executeJavaScript('1+1'), 4000);
    } catch (e) {
      out.err = e.message;
    }

    try {
      if (d.isAttached && d.isAttached()) d.detach();
    } catch {
      /* 已断开 */
    }
    try {
      w.destroy();
    } catch {
      /* 已关闭 */
    }
    return out;
  }

  if (op === 'plats') return platSnapshot();

  /**
   * 列一个分区里到底有哪些 Cookie（只给名字和域名，不给值）。
   *
   * 用来回答一个很具体的问题：「这个平台登录后到底写哪一枚 Cookie」。
   * 判登录态靠猜名字是不行的 —— 猜错的表现是「明明登上了，说没检测到」，
   * 而那种错用户没法自己修。
   */
  if (op === 'cookies') {
    const ses = session.fromPartition(partitionOf(String(cmd.slug || '')));
    const all = await ses.cookies.get({});
    const byDomain = {};
    for (const c of all) {
      const d = String(c.domain || '').replace(/^\./, '');
      (byDomain[d] = byDomain[d] || []).push({ name: c.name, httpOnly: !!c.httpOnly, session: !!c.session });
    }
    return { count: all.length, byDomain };
  }

  /**
   * 直接开一个页面看原料。参数：slug / url / kw[]
   *
   * 与 read 的区别：read 走适配器规定的页面，这个是「我想看这一页」。
   * 调字段时靠它 —— 想看某平台的指标藏在哪个接口，就得能自己指定地址。
   */
  if (op === 'cap') {
    const slug = String(cmd.slug || '');
    const ses = setupSession(session.fromPartition(partitionOf(slug)));
    const page = await capture({
      ses,
      url: String(cmd.url),
      timeoutMs: Number(cmd.timeoutMs) || 32000,
      minWaitMs: 4500,
      quietMs: 1600,
      onInject: FP_FIX,
      // 在页面里跑一段 JS：查 DOM、点按钮、设日期都用它。
      // 调字段时很多页面要「先操作再出数」，没有这一步就只能干看着空表。
      evalAfter: cmd.js ? String(cmd.js) : ''
    });

    const kws = (cmd.kw || []).map((s) => String(s).toLowerCase());
    const hits = [];
    if (kws.length) {
      page.json.forEach((blob, i) => {
        const url = String(page.jsonUrls[i] || '(nested)').replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
        extractWalk(blob, (v, d, p) => {
          if (!v || typeof v !== 'object' || Array.isArray(v)) return;
          for (const k of Object.keys(v)) {
            if (!kws.includes(k.toLowerCase())) continue;
            if (hits.length >= 120) return;
            hits.push({
              url,
              path: `${p}.${k}`.replace(/^\./, '').slice(0, 110),
              key: k,
              value: JSON.stringify(v[k]).slice(0, 90)
            });
          }
        });
      });
    }

    // 原样看某个接口的返回：调字段时唯一靠谱的办法，比猜快得多
    const dumps = [];
    if (cmd.dumpUrl) {
      const want = String(cmd.dumpUrl);
      page.jsonUrls.forEach((u, i) => {
        if (!String(u).includes(want)) return;
        if (dumps.length >= 3) return;
        dumps.push({
          url: String(u).slice(0, 300),
          body: JSON.stringify(page.json[i]).slice(0, Number(cmd.dumpLen) || 3000)
        });
      });
    }

    return {
      slug,
      finalUrl: page.finalUrl,
      title: page.title,
      interfaceCount: page.json.length,
      interfaces: page.jsonUrls.map((u) => String(u).replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '')),
      hits,
      hitCount: hits.length,
      dumps,
      evalResult: page.evalResult,
      textHead: String(page.text || '').slice(0, 900)
    };
  }

  // 截图：主界面是普通 BrowserWindow，capturePage 能抓到。
  // 右侧平台面板是 WebContentsView，抓不到（截图里永远是空的），所以别指望这张图里有网页。
  if (op === 'shot') {
    if (!win || win.isDestroyed()) throw new Error('窗口没开');
    const file = String(cmd.file || path.join(DATA_DIR, 'dev', 'shot.png'));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file, img.toPNG());
    return { file, width: img.getSize().width, height: img.getSize().height };
  }

  // 探针：只用来看「隐藏窗口能不能正常载入页面、能不能执行 JS」。
  // 读不到数据时，先分清是窗口起不来还是页面没数据，省得瞎猜。
  if (op === 'probe') {
    const { BrowserWindow } = require('electron');
    const t0 = Date.now();
    const w = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: { sandbox: true, backgroundThrottling: false }
    });
    const out = { ms: 0, url: '', title: '', visibility: '', value: null, err: '' };
    try {
      await w.loadURL(String(cmd.url || 'https://example.com'));
      out.url = w.webContents.getURL();
      out.title = w.webContents.getTitle();
      out.value = await w.webContents.executeJavaScript(
        '({ v: 1 + 1, vis: document.visibilityState, hidden: document.hidden, text: (document.body.innerText||"").slice(0,200) })'
      );
      out.visibility = out.value ? out.value.vis : '';
    } catch (err) {
      out.err = err.message;
    }
    out.ms = Date.now() - t0;
    try {
      w.destroy();
    } catch {
      /* 已经关了 */
    }
    return out;
  }

  if (op === 'sync') {
    const res = await syncOne(String(cmd.id), { trigger: 'manual' });
    return Object.assign({ message: describeResult(res) }, res);
  }

  // 「完成登录」的完整动作。界面上点按钮走的是同一条路，
  // 这里能测就不用真去登录一遍。
  if (op === 'done') {
    return finishLogin(String(cmd.plat), String(cmd.slug), false);
  }

  throw new Error(`不认识的命令：${op}`);
}

function startDevBridge() {
  if (app.isPackaged) return;
  const dir = path.join(DATA_DIR, 'dev');
  const cmdPath = path.join(dir, 'cmd.json');
  const outPath = path.join(dir, 'out.json');
  fs.mkdirSync(dir, { recursive: true });

  let busy = false;
  setInterval(async () => {
    if (busy || !fs.existsSync(cmdPath)) return;
    busy = true;
    let cmd = null;
    try {
      cmd = JSON.parse(fs.readFileSync(cmdPath, 'utf8'));
    } catch {
      /* 文件写了一半，下一轮再读 */
      busy = false;
      return;
    }
    try {
      fs.unlinkSync(cmdPath);
    } catch {
      /* 已经没了 */
    }
    let out = null;
    try {
      // 必须给个上限：读数偶发卡住时，runDevCmd 永远不 settle，
      // busy 就一直是 true，整条自测通道从此瘫痪（后面每条命令都石沉大海）。
      out = {
        ok: true,
        data: await Promise.race([
          runDevCmd(cmd),
          new Promise((_, rej) => setTimeout(() => rej(new Error('自测命令超时（150 秒）')), 150000))
        ])
      };
    } catch (err) {
      out = { ok: false, error: err.message };
    }
    try {
      fs.writeFileSync(outPath, JSON.stringify({ at: db.nowIso(), cmd, out }, null, 2), 'utf8');
    } catch {
      /* 写不进就算了 */
    }
    busy = false;
  }, 900);
}

// ---------------------------------------------------------------- 启动
app.whenReady().then(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  database = db.open(DB_PATH);
  const migrated = db.migrate(database, { dbPath: DB_PATH, backupDir: BACKUP_DIR });
  if (migrated.applied.length) {
    console.log(`数据库已迁移：v${migrated.from} → v${migrated.to}`, migrated.applied);
  }
  if (migrated.backupPath) console.log('迁移前备份：', migrated.backupPath);

  registry = makeRegistry(fs.existsSync(ADAPTER_DIR) ? ADAPTER_DIR : undefined);
  if (registry.warnings.length) console.warn('适配器警告：', registry.warnings);

  // 读数器：capture 负责开页面取原料，registry 负责说清这个平台该开哪几页
  reader = makeReader({ capture, getAdapter: (plat) => registry.get(plat) });

  migrateLegacyPartitions();
  await adoptOrphanPartitions();
  await refreshAuthStatus();

  wireIpc();
  createWindow();
  startDevBridge();
  startDailySync();
  // AI 接入：默认不开。用户在设置里打开之后才有监听端口
  await startAiApiIfEnabled();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * AI 接口：只在用户打开时启动。
 *
 * 这里刻意把「读」和「写」的权限分开：
 *   - 读（账号、作品、趋势、素材包）随时可用，不消耗平台配额
 *   - 写只有「触发一次读数」和「改自动刷新间隔」两类，
 *     而且读数照常走 syncQueued，节流、指纹校验、上限全都还在
 * 换句话说，外部 AI 拿不到任何能绕过防封号规则的能力。
 */
/** 每日自动更新的调度器（lib/scheduler.js） */
let daily = null;

let aiServer = null;
let aiInfo = { enabled: false, port: 0, token: '' };

/**
 * 每日自动更新的用户设置。
 * 存在 meta 表里 —— 跟着库走，换机器不用重设。
 */
function dailyPrefs() {
  const read = (k, d) => {
    try {
      const r = database.prepare('SELECT value FROM meta WHERE key = ?').get(k);
      return r ? r.value : d;
    } catch {
      return d;
    }
  };
  const hour = Math.max(0, Math.min(23, Number(read('daily_hour', 8)) || 0));
  const minute = Math.max(0, Math.min(59, Number(read('daily_minute', 30)) || 0));
  return {
    hour,
    minute,
    // 总开关：默认开。用户要求「每天早上自动更新一次」
    enabled: read('daily_enabled', '1') !== '0'
  };
}

function setDailyPrefs(p = {}) {
  const put = (k, v) => {
    try {
      database.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(k, String(v));
    } catch {
      /* 写不进去不该崩 */
    }
  };
  if (p.enabled != null) put('daily_enabled', p.enabled ? '1' : '0');
  if (p.hour != null) put('daily_hour', Math.max(0, Math.min(23, Number(p.hour) || 0)));
  if (p.minute != null) put('daily_minute', Math.max(0, Math.min(59, Number(p.minute) || 0)));
  return dailyPrefs();
}

/**
 * 起每日调度。
 *
 * 用户的原话是「一直在登录，每天早上都会自动更新一次，其他时候要用户自己点」。
 * 所以这里只排一个每日定时，不做小时级轮询 ——
 * 轮询对这些平台是纯负担，一天读十几次拿到的信息差不多，被封概率差十几倍。
 */
function startDailySync() {
  daily = createScheduler({
    db: database,
    getTime: () => {
      const p = dailyPrefs();
      return { hour: p.hour, minute: p.minute };
    },
    listAccounts: () => {
      try {
        return database.prepare('SELECT * FROM accounts ORDER BY plat').all();
      } catch {
        return [];
      }
    },
    syncOne: (id) => syncQueued(id, { trigger: 'scheduled' }),
    onEvent: (ev) => {
      // 让界面能看到「下次什么时候」「正在读第几个」
      emit('daily:event', ev);
      if (ev.phase === 'daily-done') {
        // 读完了刷一次平台列表，数字立刻更新
        emit('plats:update', platSnapshot());
      }
    }
  });

  const p = dailyPrefs();
  if (!p.enabled) {
    console.log('每日自动更新：用户关掉了');
    return;
  }
  const r = daily.start();
  console.log(`每日自动更新：${p.hour}:${String(p.minute).padStart(2, '0')}（模式 ${r.mode}）`);
}

function aiDeps() {
  const view = aiView.makeView(database);
  return {
    version: () => app.getVersion(),
    accounts: () => view.accounts(),
    accountDetail: (id, opts) => view.accountDetail(id, opts),
    works: (o) => view.works(o),
    summary: () => view.summary(),
    trends: (id, m) => view.trends(id, m),
    getSettings: () => view.getSettings(),
    setSettings: (o) => {
      const r = view.setSettings(o);
      emit('plats:update', platSnapshot());
      return r;
    },
    async sync(input) {
      // 指定账号：只读那一个
      if (input && input.accountId) {
        const res = await syncQueued(String(input.accountId), { trigger: 'manual' });
        return { accountId: input.accountId, result: res.result, message: describeResult(res) };
      }
      // 指定平台：把这个平台下的号依次读完（不并行，避免同时开太多页面）
      if (input && input.plat) {
        const list = accountsOf(String(input.plat));
        if (!list.length) throw new Error(`没有「${input.plat}」的账号`);
        const out = [];
        for (const a of list) {
          const res = await syncQueued(a.id, { trigger: 'manual' });
          out.push({ accountId: a.id, result: res.result, message: describeResult(res) });
        }
        return { plat: input.plat, results: out };
      }
      throw new Error('要指定 accountId 或 plat');
    },
    exportCsv(accountId) {
      if (!accountId) throw new Error('要指定 accountId');
      const file = exporter.exportAccount(database, accountId, 'csv', EXPORT_DIR);
      return { file };
    }
  };
}

async function startAiApiIfEnabled() {
  const st = localApi.readState(DATA_DIR);
  if (!st.enabled) {
    aiInfo = { enabled: false, port: 0, token: '', tokenFile: localApi.tokenPath(DATA_DIR) };
    return aiInfo;
  }
  try {
    const r = await localApi.start({ dataDir: DATA_DIR, port: st.port, deps: aiDeps() });
    aiServer = r.server;
    aiInfo = {
      enabled: true,
      port: r.port,
      token: r.token,
      tokenFile: localApi.tokenPath(DATA_DIR),
      url: `http://127.0.0.1:${r.port}`
    };
    console.log(`AI 接口已启动：${aiInfo.url}（只监听本机）`);
  } catch (err) {
    aiInfo = { enabled: false, port: 0, token: '', error: err.message };
    console.warn('AI 接口启动失败：', err.message);
  }
  return aiInfo;
}

async function stopAiApi() {
  if (aiServer) {
    await new Promise((r) => aiServer.close(() => r()));
    aiServer = null;
  }
  aiInfo = { enabled: false, port: 0, token: '' };
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (daily) {
    daily.stop();
    daily = null;
  }
  if (aiServer) {
    try {
      aiServer.close();
    } catch {
      /* 已经关了 */
    }
    aiServer = null;
  }
  if (database) {
    try {
      database.close();
    } catch {
      /* 已经关了 */
    }
  }
});
