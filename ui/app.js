'use strict';
/**
 * 渲染进程 · 主界面
 * 只做三件事：画平台宫格、开关右侧登录面板、把状态显示出来。
 *
 * 平台符号在 icons.js（svgOf(key)），平台数据由主进程给（含品牌色与账号数），
 * 这个文件不维护任何平台清单 —— 加平台只改 lib/adapters/platforms.js。
 */

// 自测用：一条 eval 就能问出前端报错
window.__ipErr = [];
window.addEventListener('error', (e) => {
  window.__ipErr.push(String(e.message));
  console.error('[ui]', e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  window.__ipErr.push(String(e.reason));
  console.error('[ui:promise]', e.reason);
});

const $ = (id) => document.getElementById(id);

let PLATS = [];
let currentPlat = null;

// ---------------------------------------------------------------- 偏好
/**
 * 只存两件纯界面的事：显示哪些平台、用哪套配色。
 * 放在 localStorage 而不是数据库：这是「这台机器上这个人的习惯」，
 * 换机器重设不心疼，也不该跟账号数据一起被备份/导出。
 */
const PREF_KEY = 'aml.prefs';
const prefs = Object.assign(
  // onboard: '' 还没处理 / 'done' 知道了 / 'never' 不再显示
  { theme: 'dark', hidden: [], onboard: '' },
  (() => {
    try {
      return JSON.parse(localStorage.getItem(PREF_KEY)) || {};
    } catch {
      return {};
    }
  })()
);

function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    /* 隐私模式下写不进去，不影响使用 */
  }
}

const mqLight = window.matchMedia('(prefers-color-scheme: light)');

function applyTheme() {
  const t = prefs.theme === 'auto' ? (mqLight.matches ? 'light' : 'dark') : prefs.theme;
  document.body.classList.toggle('light', t === 'light');
  const seg = $('themeSeg');
  if (seg) {
    for (const b of seg.querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.theme === prefs.theme);
    }
  }
  // 图的颜色是画的时候从 CSS 变量读的，主题一换就得重画，否则图还停在旧配色
  if (typeof window.__chRefresh === 'function') window.__chRefresh();
}

mqLight.addEventListener('change', () => {
  if (prefs.theme === 'auto') applyTheme();
});

// ---------------------------------------------------------------- 格式化
/**
 * 数字显示。超过一万用「万」，超过一亿用「亿」。
 * null 一律显示「—」——「还没读到」和「确认是 0」是两件事，
 * 混成一个「0」会让人以为这个号真的没粉丝。
 */
function fmt(n) {
  if (n === null || n === undefined || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  /** 不到 10 留一位小数（1.2万），10 以上取整（12万） */
  const num = (x) => (x >= 10 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ''));
  if (a >= 1e8) return sign + num(a / 1e8) + '亿';
  if (a >= 1e4) {
    /**
     * 四舍五入会**跨档**：99,999,999 / 1e4 = 9999.9999，取整成 10000，
     * 拼上单位就成了「10000万」。数字没错、看着荒谬，而且这种数偏偏出现在
     * 「快到一个亿」的账号上，最容易被截图。跨档就升到「亿」。
     */
    if (Math.round(a / 1e4) >= 1e4) return sign + num(a / 1e8) + '亿';
    return sign + num(a / 1e4) + '万';
  }
  return sign + a.toLocaleString('en-US');
}

/** 和上一次比，涨了多少。没有可比的数据就返回空串，不印「0」。 */
function delta(now, before) {
  if (now == null || before == null) return '';
  const d = Number(now) - Number(before);
  if (!Number.isFinite(d)) return '';
  if (d === 0) return '持平';
  return (d > 0 ? '+' : '−') + fmt(Math.abs(d));
}

/** "2026-10-22T12:00:00.000Z" → "10-22 20:00"，相对现在太久就显示日期 */
function whenText(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} 小时前`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------- 文案

/** 页脚的默认文案（读取结束后要恢复成它），由 boot 填上版本号 */
let footHomeText = '数据存在本机';
let footResetTimer = 0;

function stateText(p) {
  if (p.status === 'none') return '未设置';
  // 卡片右下角已经给了「重新登录」按钮，这里就不必再重复一遍
  if (p.status === 'login_expired') return '登录已失效';
  if (p.status === 'unknown') return '还没登录';
  if (p.status === 'fingerprint_mismatch') return '账号不符，已停止写入';

  // 登录着但读数通道被关掉的平台，要说清「不是坏了，是我故意不读」
  if (p.disabled) return '登录着，这个平台暂不读数';

  const a = p.accounts && p.accounts[0];
  if (a) {
    const bits = [];
    if (a.nickname) bits.push(a.nickname);
    // 没昵称但有账号名时也要露出来，否则卡片上只剩一个数字，像是没认出人
    else if (a.handle) bits.push(`@${a.handle}`);
    if (a.followers != null) bits.push(`${fmt(a.followers)} 粉丝`);
    else if (a.worksCount) bits.push(`${a.worksCount} 条作品`);
    if (bits.length) {
      /**
       * 数字之外还有一句「平台事实」时（个人号不显示粉丝数 / 还没有内容），
       * 缩成很短的一截跟在后面。
       * 不缩的话卡片会被撑爆；完全不说的话，用户会以为「没读到」。
       */
      if (a.note) {
        const short =
          a.note.length > 18 ? a.note.slice(0, 17).replace(/[，,、]$/, '') + '…' : a.note;
        bits.push(short);
      }
      return bits.join(' · ');
    }
    // 一个数字都没有，但平台说了原因 —— 照原话说
    if (a.note) return a.note;
    return '登录着，还没读到数据';
  }
  if (p.status === 'ok') return '已登录，等待首次读取';
  return '环境已建好，等待首次读取';
}

// ---------------------------------------------------------------- 渲染

/** 只画用户勾选的平台。藏在设置里的平台不影响它自己的环境与数据。 */
function shownPlats() {
  const hid = new Set(prefs.hidden || []);
  return PLATS.filter((p) => !hid.has(p.plat));
}

function renderGrid() {
  const grid = $('grid');
  const list = shownPlats();

  if (!list.length) {
    grid.innerHTML =
      '<div class="empty">一个平台都没选。<br />点右上角的设置，把要用的勾回来。</div>';
  } else {
    grid.innerHTML = list
      .map(
        (p) => `
    <div class="card" role="button" tabindex="0" data-plat="${p.plat}"
         data-brand="${p.brand}" data-brand-light="${p.brandLight || p.brand}"
         title="${esc(p.notes || '')}">
      <span class="tile">${svgOf(p.icon)}</span>
      <span class="card-body">
        <span class="name">${esc(p.plat)}${
          p.count > 1 ? `<span class="badge">${p.count} 个号</span>` : ''
        }</span>
        <span class="state"><i class="d ${p.status}"></i>${esc(stateText(p))}</span>
      </span>
      ${
        p.status === 'login_expired'
          ? (() => {
              // 过期的是哪个号，就重登哪个号 —— 别让用户重新猜一遍
              const bad = (p.accounts || []).find((a) => a.status === 'login_expired');
              return `<button class="relogin" data-relogin="${p.plat}" data-slug="${
                (bad && bad.slug) || ''
              }" title="打开面板重新登录">重新登录</button>`;
            })()
          : p.count > 0
          ? `<button class="add" data-add="${p.plat}" title="再添加一个号（独立环境）">＋</button>`
          : ''
      }
    </div>`
      )
      .join('');
  }

  // 品牌色只能用 CSSOM 注入：CSP 的 style-src 'self' 会拦掉 style="--brand:…"，
  // 而直接改 el.style 不算内联样式，不受限制。这样不用为了配色去开 'unsafe-inline'。
  for (const el of grid.querySelectorAll('.card')) {
    el.style.setProperty('--b-dark', el.dataset.brand);
    el.style.setProperty('--b-light', el.dataset.brandLight || el.dataset.brand);
  }

  $('stPlat').textContent = list.length;
  // 统计按「真实登录」算，不按「建过环境」算：建过但没登的号用不了，不该算进来
  $('stReady').textContent = list.filter((p) => p.status === 'ok').length;
  $('stTodo').textContent = list.filter((p) => p.status !== 'ok').length;

  renderOnboard(list);
}

/**
 * 第一次打开的三步引导。
 *
 * 只在一个号都没登录成的时候出现 —— 登进去任意一个之后自动消失，
 * 不用用户再回来关一遍（那是最招人烦的引导）。
 * 「知道了」和「✕」都记在本地偏好里，不上传、不入库。
 */
function renderOnboard(list) {
  const box = $('onboard');
  if (!box) return;
  const settled = prefs.onboard === 'done' || prefs.onboard === 'never';
  const anyReady = list.some((p) => p.status === 'ok');
  // 一个平台都没勾时，「一个平台都没选」那句话比三步引导更该出现
  const show = !(settled || anyReady || !list.length);
  const wasHidden = box.hidden;
  box.hidden = !show;
  /**
   * 引导条从「藏」变「显」的同一帧，网格可用高度突然少掉 ~180px。
   * Chromium 的滚动锚定会为了「保持原来看见的内容」把 scrollTop 往下推，
   * 结果第一次打开时最上面那行（公众号 / 小红书 / 抖音）正好被推出视野 ——
   * 交付到别人手上，一进来就像是少了三个平台。
   *
   * 只在「由藏变显」这一刻压回顶部，日常刷新数据不会打断用户已经滚到的位置。
   * 下一次动画帧再压一次：高度变化引发的锚定调整发生在本次帧之后。
   */
  if (show && wasHidden) {
    const grid = $('grid');
    if (grid) {
      grid.scrollTop = 0;
      requestAnimationFrame(() => {
        grid.scrollTop = 0;
      });
    }
  }
}

// ---------------------------------------------------------------- 项目主页 / Star
/**
 * 开源项目的「Star」入口。
 *
 * 分寸比按钮重要：一进应用就要 star 会让人反感，所以三条限制——
 * 用满三天、打开过三次、两周最多问一次；正在做别的事（面板/浮层/详情页）时一律让路。
 * 「不再提示」写到偏好里，之后永不再出现。
 */
const REPO_URL = 'https://github.com/labulaka-ai/account-monitor';
const STAR_QUIET = 3 * 864e5;   // 装上先自己用三天
const STAR_GAP = 14 * 864e5;    // 两次提示之间至少两周

/**
 * 打开外部链接。
 *
 * 统一走这里，是因为直接 `window.api.openExternal(url)` 不接返回的 Promise：
 * 系统里没配默认浏览器、或者被安全策略拦掉时，会变成一个**未处理的 Promise 拒绝**，
 * 用户看到的是「点了没反应」，控制台里才有原因。
 */
function openLink(url) {
  if (!url) return;
  const fail = (err) => toast(`打不开浏览器：${esc((err && err.message) || '未知原因')}`, 'bad');
  try {
    const p = window.api.openExternal(url);
    if (p && typeof p.catch === 'function') p.catch(fail);
  } catch (err) {
    fail(err);
  }
}

function openRepo() {
  openLink(REPO_URL);
}

/** 每次启动记一笔：既算「打开过几次」，也记下第一次用的日子 */
function noteLaunch() {
  const s = (prefs.star = prefs.star || {});
  s.opens = (s.opens || 0) + 1;
  if (!s.first) s.first = Date.now();
  savePrefs();
}

function starDue() {
  const s = prefs.star || {};
  if (s.never) return false;
  if ((s.opens || 0) < 3) return false;
  if (Date.now() - (s.first || 0) < STAR_QUIET) return false;
  if (s.last && Date.now() - s.last < STAR_GAP) return false;
  // 手上正有事就别插话：面板是原生视图，浮层和详情页占着注意力
  if (document.body.classList.contains('panel-open')) return false;
  if (!$('settings').hidden || !$('exportSheet').hidden || !$('detail').hidden) return false;
  return true;
}

let nudgeTimer = 0;

function hideNudge() {
  clearTimeout(nudgeTimer);
  const n = $('starNudge');
  if (n) n.hidden = true;
}

function showNudge() {
  const n = $('starNudge');
  if (!n) return;
  n.hidden = false;
  clearTimeout(nudgeTimer);
  // 20 秒自己收走，不赖在那儿
  nudgeTimer = setTimeout(hideNudge, 20000);
}

/** 记一笔：last 让下一次提示至少隔两周；never 就是永久别再提 */
function markStar(flag) {
  const s = (prefs.star = prefs.star || {});
  s.last = Date.now();
  if (flag) s[flag] = true;
  savePrefs();
}

/** 首屏、自动更新都跑完再说，别和「正在读取」抢注意力 */
function armStarNudge() {
  setTimeout(() => {
    if (starDue()) showNudge();
  }, 12000);
}

// ---------------------------------------------------------------- 设置
function renderPicker() {
  const box = $('platPicker');
  const hid = new Set(prefs.hidden || []);
  box.innerHTML = PLATS.map((p) => {
    const dot = p.status === 'ok' ? 'ok' : p.status === 'login_expired' ? 'warn' : '';
    return `<label class="pick">
      <input type="checkbox" data-plat="${p.plat}" ${hid.has(p.plat) ? '' : 'checked'}>
      <span class="pn">${p.plat}</span>
      <i class="pd ${dot}"></i>
    </label>`;
  }).join('');
}

function openSettings() {
  hideNudge();          // 角落提示和浮层不叠在一起
  renderPicker();
  applyTheme();
  renderAiBox();
  renderDailyBox();
  $('settings').hidden = false;
}

function closeSettings() {
  $('settings').hidden = true;
}

/**
 * AI 接入那一块。
 *
 * 密钥显示成明文是有意的：用户要把它（或它的位置）告诉另一个工具，
 * 遮起来只会逼人去翻文件。这个面板只在这台电脑上、只在应用里能看到。
 */
/**
 * 每日自动更新那一块。
 *
 * 必须让人看到「下次什么时候」和「今天跑过没有」——
 * 只说「已开启」，用户会怀疑它到底动没动。
 */
async function renderDailyBox() {
  let s = null;
  try {
    s = await window.api.dailyStatus();
  } catch (err) {
    $('dailyState').textContent = `查不到状态：${err.message}`;
    return;
  }
  $('dailyOn').checked = !!s.enabled;
  $('dailyBox').hidden = !s.enabled;

  const hh = String(s.hour).padStart(2, '0');
  const mm = String(s.minute).padStart(2, '0');
  $('dailyTime').value = `${hh}:${mm}`;

  if (!s.enabled) {
    $('dailyState').textContent = '已关闭';
    return;
  }
  if (s.running) {
    $('dailyState').textContent = '正在更新…';
  } else if (s.ranToday) {
    $('dailyState').textContent = `今天已更新（${s.lastResult || '完成'}）`;
  } else {
    $('dailyState').textContent = '今天还没更新';
  }

  // 下次时间：说人话（「明天 08:30」比 ISO 字符串好懂）
  let hint = '';
  if (s.nextAt) {
    const t = new Date(s.nextAt);
    const today = new Date();
    const isTomorrow =
      t.getFullYear() !== today.getFullYear() ||
      t.getMonth() !== today.getMonth() ||
      t.getDate() !== today.getDate();
    const hh2 = String(t.getHours()).padStart(2, '0');
    const mm2 = String(t.getMinutes()).padStart(2, '0');
    hint = `下次自动更新：${isTomorrow ? '明天' : '今天'} ${hh2}:${mm2}`;
  }
  if (s.ranToday && s.lastResult) hint += `　·　${s.lastResult}`;
  $('dailyHint').textContent = hint;
}

async function renderAiBox() {
  let s = null;
  try {
    s = await window.api.aiStatus();
  } catch (err) {
    $('aiState').textContent = `查不到状态：${err.message}`;
    return;
  }
  const on = !!(s && s.enabled && s.running);
  $('aiToggle').checked = on;
  $('aiState').textContent = on ? `开着 · 端口 ${s.port}` : s && s.error ? `启动失败：${s.error}` : '未开启';
  $('aiBox').hidden = !on;
  if (!on) return;

  $('aiToken').textContent = s.token || '—';
  $('aiUrl').textContent = s.url || `http://127.0.0.1:${s.port}`;

  /**
   * 配置片段不再用开发时的脚本路径。
   *
   * 主进程会把 mcp-server.js 复制到**用户自己的数据目录**，并用应用自身
   * 以纯 Node 模式运行它 —— 这样：
   *   · 路径里没有开发者的用户名（打包给别人也能用）
   *   · 用户不需要另外装 node
   */
  let conf = null;
  let note = '';
  try {
    const m = await window.api.aiMcpConfig();
    conf = m && m.config;
    note = (m && m.note) || '';
    if (m && !m.ok) {
      $('aiConf').textContent = `配置生成失败：没能把 MCP 脚本写到数据目录。\n${m.scriptPath || ''}`;
      return;
    }
  } catch (err) {
    $('aiConf').textContent = `配置生成失败：${err.message}`;
    return;
  }
  /**
   * 路径里带用户名是必然的 —— 这是本地工具，AI 客户端要连的就是这台电脑。
   * 但必须说清楚「打包后会自动变」，否则用户会以为配置写错了、
   * 或者以为自己把个人信息打包进去了。
   */
  const noteEl = document.getElementById('aiConfNote');
  if (noteEl) {
    noteEl.textContent = note;
    noteEl.hidden = !note;
  }
  $('aiConf').textContent = JSON.stringify(conf, null, 2);
}

async function refresh() {
  /**
   * 刷新失败不能把界面清空。
   *
   * 这个函数在几十处被 await（登录完、读完数、关面板、切设置…），
   * 以前 `PLATS = await …` 一旦后端偶尔回一个错误，异常就一路抛到调用者，
   * 而多数调用者没有 catch —— 表现是「点了没反应」，界面还停在上一次的数据上。
   * 保留旧 PLATS 再画一遍，至少界面是活的。
   */
  try {
    PLATS = await window.api.listPlats();
  } catch (err) {
    console.error('刷新平台列表失败', err);
  }
  renderGrid();
}

// ---------------------------------------------------------------- 提示条
let toastTimer = 0;
/**
 * 提示条。
 *
 * `sticky` 用于「要人做决定」的提示（比如扫描完了、问要不要看数据）：
 * 那种提示不该 5 秒就消失，人对时间的感知没那么准，走开一下就错过了。
 */
function toast(html, kind, opts = {}) {
  const el = $('toast');
  if (!el) return;
  el.innerHTML = html;
  el.className = kind ? `toast ${kind}` : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  const stay = opts.sticky ? 0 : kind === 'bad' ? 9000 : 5000;
  if (stay) {
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, stay);
  }
}

/**
 * 提示条里可以放按钮（「看数据」）。
 * 内容每次都是新 innerHTML，所以只能在容器上委托一次，不能逐个绑定。
 */
function bindToastActions() {
  const el = $('toast');
  if (!el || el.dataset.bound === '1') return;
  el.dataset.bound = '1';
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.toastgo');
    if (!b) return;
    el.hidden = true;
    // 诊断包：不是「跳到哪」，而是「做一件事」，所以先看 data-act
    const act = b.dataset.act;
    if (act === 'diagpack') {
      packDiag();
      return;
    }
    const plat = b.dataset.go;
    const acc = b.dataset.acc;
    if (plat) openDetail(plat, acc || undefined);
  });
}

/** 登录完之后等着「读完了」那条提示用的：哪个平台读完就在提示里给个入口 */
let pendingOpen = '';

// ---------------------------------------------------------------- 详情页
/** 帖子类型的中文名。X 上原创/回复/转发混在一列里，必须标出来 */
const TYPE_LABELS = { original: '原创', reply: '回复', repost: '转发', quote: '引用' };

/**
 * 作品列表当前按哪种类型筛选。
 * '' = 全部。切账号时要重置 —— 否则从 X（有转发）切到公众号（没有类型），
 * 会停在一个永远为空的筛选上，看起来像「公众号没数据」。
 */
let dxWorkType = '';

let dxPlat = null;
let dxAcc = null;
let dxPlatName = '';
/** 这次开面板是从详情页进来的（取消后要退回去） */
let dxBackFrom = false;

/** 作品指标列。顺序固定 —— 每列一会儿有一会儿没有，表格就没法对比了。 */
const WORK_COLS = [
  ['reads', '阅读'],
  ['likes', '赞'],
  ['saves', '藏'],
  ['comments', '评'],
  ['shares', '享'],
  ['completion', '完播'],
  ['new_followers', '涨粉']
];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 作品「发布」列怎么显示。
 *
 * 库里统一存 `YYYY-MM-DD`（写入时已按本地日期归一），这里只负责让它读起来省地方：
 * 今年的作品省掉年份 —— 一屏八行全是「2026-」纯属浪费列宽；而这一列只有 84px，
 * 一条 `2026-10-23T07:29:30.922Z` 会直接压到右边的「观看」数字上（叠成一团）。
 * 只显示到日、不显示时分：这一列回答的是「哪天发的」，同一列有的带时间有的不带最难看。
 * 带时分的旧数据仍按本地时区换算 —— 23:30Z 在 +8 区已经是第二天，不能直接截前 10 位。
 * 认不出的写法（「3 天前」「10月23日」）原样返回：猜一个日期比显示原话更糟。
 */
function fmtPub(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  let y = Number(m[1]);
  let mo = Number(m[2]);
  let da = Number(m[3]);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) {
      const d = new Date(t);
      y = d.getFullYear();
      mo = d.getMonth() + 1;
      da = d.getDate();
    }
  }
  const p2 = (n) => String(n).padStart(2, '0');
  return y === new Date().getFullYear() ? `${p2(mo)}-${p2(da)}` : `${y}-${p2(mo)}-${p2(da)}`;
}

function showDetail(on) {
  $('detail').hidden = !on;
  $('grid').hidden = !!on;
  // 详情页里不需要「账号监控 / 数据不出这台电脑 / 平台统计」这一套抬头，
  // 它占的是最值钱的顶部空间，而且用户已经在看具体数据了
  document.body.classList.toggle('view-detail', !!on);
  if (!on) {
    dxPlat = null;
    dxAcc = null;
    dxPlatName = '';
    setProgress(false);
  }
}

function setProgress(on, text) {
  const el = $('dProgress');
  if (!el) return;
  el.hidden = !on;
  if (text) $('dProgText').textContent = text;
}

async function openDetail(plat, accountId) {
  dxPlatName = plat;
  const p = PLATS.find((x) => x.plat === plat) || {};
  $('dTitle').textContent = plat;
  $('dSub').textContent = '正在加载…';
  $('dIcon').style.setProperty('--b-dark', p.brand || 'var(--accent)');
  $('dIcon').style.setProperty('--b-light', p.brandLight || p.brand || 'var(--accent)');
  $('dIcon').innerHTML = svgOf(p.icon || 'unknown');
  $('dMetrics').innerHTML = '';
  $('dHead').innerHTML = '';
  $('dBody').innerHTML = '';
  $('dTabs').innerHTML = '';
  $('dNote').hidden = true;
  $('dCharts').innerHTML = '';
  showDetail(true);

  let d = null;
  try {
    d = await window.api.platDetail(plat);
  } catch (err) {
    d = { ok: false, error: err.message };
  }
  if (!d || !d.ok) {
    $('dSub').textContent = (d && d.error) || '读不到这个平台';
    return;
  }
  dxPlat = d;
  renderTabs();

  const first = accountId || (d.accounts[0] && d.accounts[0].id);
  if (!first) {
    $('dSub').textContent = '这个平台还没有登录过的号';
    $('dBody').innerHTML = '<div class="dempty">先在平台列表里登录一个号。</div>';
    return;
  }
  await loadAccount(first);
}

async function loadAccount(id) {
  // 换号就回到「全部」：上一个号停在「转发」上，这个号可能一条转发都没有
  dxWorkType = '';
  let r = null;
  try {
    r = await window.api.accountDetail(id);
  } catch (err) {
    r = { ok: false, error: err.message };
  }
  if (!r || !r.ok) {
    $('dSub').textContent = (r && r.error) || '读不到这个号';
    return;
  }
  dxAcc = r;
  const a = r.account;

  $('dTitle').textContent = a.nickname || dxPlatName;
  $('dSub').textContent = [
    dxPlatName,
    a.handle ? `@${a.handle}` : '',
    a.slug,
    a.lastOkAt ? `上次成功 ${whenText(a.lastOkAt)}` : '还没成功读过'
  ]
    .filter(Boolean)
    .join(' · ');

  renderTabs();
  renderMetrics();
  renderWorks();
  renderNote();
  renderCharts($('dCharts'), r, dxPlat && dxPlat.caps, (dxPlat && dxPlat.overviewWindow) || '', {
    profile: dxPlat && dxPlat.profile
  });
}

function renderTabs() {
  const box = $('dTabs');
  const list = (dxPlat && dxPlat.accounts) || [];
  if (list.length <= 1) {
    box.innerHTML = '';
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const cur = dxAcc && dxAcc.account.id;
  box.innerHTML = list
    .map(
      (a, i) => `<button class="dtab${a.id === cur ? ' on' : ''}" data-acc="${a.id}">
        <span class="dt-n">${esc(a.nickname || `号 ${i + 1}`)}</span>
        <span class="dt-f">${a.followers == null ? '未读' : fmt(a.followers) + ' 粉丝'}</span>
      </button>`
    )
    .join('');
}

function renderMetrics() {
  const r = dxAcc;
  const l = r.latest || {};
  const p = r.prev || {};
  const caps = (dxPlat && dxPlat.caps && dxPlat.caps.account) || [];

  /**
   * 指标卡只画「这个平台声称给、并且真的读到过」的。
   *
   * 原来的做法是把四个卡都画出来，读不到就印一个「—」。结果是一屏破折号 ——
   * 用户没法区分「还没读」和「平台就是不给」，只会觉得整个软件是坏的。
   * 读不到的集中放一行说清楚，比摊成四个空卡诚实，也省地方。
   */
  /**
   * 有的平台概览给的是「近 7 天」窗口值，不是累计。
   * 标签必须跟着改口：把近 7 天的播放量印成「总阅读」，数字是真的但含义是错的，
   * 用户拿它算转化率就会发现对不上，而且怎么查都查不出原因。
   */
  const win = (dxPlat && dxPlat.overviewWindow) || '';
  const pre = win === '7d' ? '近 7 天' : '';

  /**
   * 指标卡按**平台特性**排，不是所有平台都摆同样四张。
   *
   * 为什么必须不一样：X 只看粉丝和作品两张卡，右边空四格；
   * 而它最有价值的「查看次数」「引用数」根本没出现在最上面。
   * B站有投币和弹幕、视频号有完播率、公众号的分享才是关键 ——
   * 这些数字都读到了，却因为没有卡位而不显示。
   *
   * profile.cards 就是「这个平台该看什么」的顺序，由 lib/plat_profile.js 定义。
   */
  const prof = (dxPlat && dxPlat.profile) || null;
  const works = r.works || [];
  const num = (v) => (v == null ? null : Number(v));
  const sumOf = (k) => {
    const vals = works.map((w) => num(w[k])).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const sumExtra = (k) => {
    const vals = works.map((w) => num(w.extra && w.extra[k])).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const avgOf = (k) => {
    const vals = works.map((w) => num(w[k])).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  /** 互动率：赞+评+享+藏 ÷ 阅读。阅读为 0 时不算，否则会得到 Infinity */
  const interRate = () => {
    let inter = 0;
    let reads = 0;
    for (const w of works) {
      const rd = num(w.reads);
      if (rd == null || rd <= 0) continue;
      reads += rd;
      inter += (num(w.likes) || 0) + (num(w.comments) || 0) + (num(w.shares) || 0) + (num(w.saves) || 0);
    }
    return reads ? (inter / reads) * 100 : null;
  };

  /** 一张卡：值 + 说明它是什么口径 */
  const mk = (k, v, opts = {}) => ({
    k,
    v,
    unit: opts.unit || '',
    d: opts.d || '',
    // 这张卡是不是「这个平台的主指标」—— 主指标高亮，其余退一层
    focus: !!opts.focus,
    sub: opts.sub || ''
  });

  const capturedText = r.latest ? '采于 ' + whenText(r.latest.captured_at) : '';
  const dim = (v) => (works.length ? `${works.length} 条合计` : '');

  const pickCard = (key) => {
    switch (key) {
      case 'followers':
        if (!caps.length || caps.includes('followers')) {
          if (l.followers != null || p.followers != null) {
            return mk('粉丝', l.followers, {
              d: delta(l.followers, p.followers),
              sub:
                l.followers == null
                  ? `沿用 ${whenText(r.prev.captured_at)} 的数`
                  : capturedText
            });
          }
        }
        return null;
      case 'works': {
        /**
         * 作品卡的副标题要能说清「为什么和平台显示的不一样」。
         * X 的主页头部写「6 posts」，但那是「帖子」标签的数，不含回复；
         * 我们把 Posts + Replies 并起来是 9 条 —— 两个都对，口径不同。
         * 把构成写出来（原创5+引用1+回复3），人才对得上账。
         */
        const byType = {};
        for (const w of works) {
          const k = (w.extra && w.extra.type) || 'original';
          byType[k] = (byType[k] || 0) + 1;
        }
        const parts = ['original', 'quote', 'reply', 'repost']
          .filter((k) => byType[k])
          .map((k) => `${TYPE_LABELS[k]}${byType[k]}`);
        const mix = parts.length > 1 ? parts.join('·') : '';
        /**
         * 「作品」这个卡位的数字必须 ≥ 下面列表里能看到的条数，否则同一屏自相矛盾：
         * 平台总数会滞后、口径可能不同（X 头部只算 Posts 不含 Replies），
         * 快照也可能还留着上一轮的旧数 —— 这时显示 3、列表里 8 条，只会让人以为坏了。
         *
         * 取 worksCount（库里实有条数，不受 200 条展示上限影响）兜底；
         * 真的多出来时，副标题直接说清「平台报 3、库里 8」，不装作没这回事。
         */
        const platTotal = l.works_total == null ? null : Number(l.works_total);
        const storedN =
          r.account && r.account.worksCount != null ? Number(r.account.worksCount) : works.length;
        const shownN = platTotal == null ? (storedN || null) : Math.max(platTotal, storedN);
        /**
         * 这轮到底读完没有，只有 accounts.last_read 知道（快照里只有一个数）。
         * 没读完时宁可说「读到 20 / 共 240」，也不要把 240 写成已经到手的数。
         */
        const lr = (r.account && r.account.lastRead) || null;
        const partial = !!(lr && lr.complete === false);
        const sub = (() => {
          if (partial && lr.total != null && lr.got < lr.total) {
            return `读到 ${lr.got} / 共 ${lr.total} 条，这轮没翻完`;
          }
          if (partial && lr.total == null && lr.got) return `平台没给总数，读到 ${lr.got} 条`;
          if (platTotal == null) {
            if (storedN) return `平台没给总数，已读到 ${storedN} 条`;
            return (r.account && r.account.note) ? '平台确认是 0 条' : '还没读到作品';
          }
          if (shownN === 0 && r.account && r.account.note) return r.account.note;
          if (shownN > platTotal) return `平台报 ${platTotal} 条，库里实有 ${storedN} 条`;
          return mix || `已入库 ${storedN} 条`;
        })();
        return mk('作品', shownN, { sub });
      }
      case 'reads':
      case 'plays':
      case 'views': {
        // 优先账号级（平台自己给的），没有就按作品求和
        let v = l.total_reads;
        let sub = win === '7d' ? '平台总览口径' : capturedText;
        if (v == null) {
          v = sumOf('reads');
          sub = v == null ? '' : dim(v);
        }
        if (v == null) return null;
        /**
         * 「阅读/播放/查看」是同一个位置上的三种叫法，全由平台决定。
         * X 叫查看、抖音叫播放、公众号叫阅读 —— 标签写错比数字错更让人困惑。
         * 主指标判断也要认这三种，否则 X 的重点标记永远亮不起来。
         */
        /**
         * 标签用平台自己的叫法：IG/抖音/B站是「播放」、X 是「查看」、
         * 公众号是「阅读」、Threads 是「浏览」。
         * 把 148 次播放印成「阅读」，用户会以为是文章阅读量。
         */
        const readWord = (prof && prof.readLabel) || (key === 'views' ? '查看' : '阅读');
        return mk(`${pre}${readWord}`, v, {
          d: key === 'reads' ? delta(l.total_reads, p.total_reads) : '',
          sub,
          focus: !!(prof && prof.focus === 'reads')
        });
      }
      case 'likes': {
        let v = l.total_likes;
        let sub = win === '7d' ? '平台总览口径' : capturedText;
        if (v == null) {
          v = sumOf('likes');
          sub = v == null ? '' : dim(v);
        }
        if (v == null) return null;
        return mk(`${pre}赞`, v, { d: delta(l.total_likes, p.total_likes), sub });
      }
      case 'comments': {
        const v = sumOf('comments');
        return v == null ? null : mk('评论', v, { sub: dim(v) });
      }
      case 'shares': {
        const v = sumOf('shares');
        return v == null ? null : mk('分享', v, { sub: dim(v) });
      }
      case 'saves': {
        const v = sumOf('saves');
        return v == null ? null : mk('收藏', v, { sub: dim(v) });
      }
      case 'quotes': {
        const v = sumExtra('quotes');
        return v == null ? null : mk('引用', v, { sub: dim(v) });
      }
      case 'coins': {
        const v = sumExtra('coins');
        return v == null ? null : mk('投币', v, { sub: dim(v) });
      }
      case 'danmaku': {
        const v = sumExtra('danmaku');
        return v == null ? null : mk('弹幕', v, { sub: dim(v) });
      }
      case 'recommend': {
        const v = sumExtra('recommend');
        return v == null ? null : mk('推荐', v, { sub: dim(v) });
      }
      case 'completion': {
        const v = avgOf('completion');
        return v == null ? null : mk('完播率', Math.round(v * 10) / 10, { unit: '%', sub: '平均' });
      }
      case 'interRate': {
        const v = interRate();
        return v == null ? null : mk('互动率', Math.round(v * 10) / 10, { unit: '%', sub: '互动 ÷ 阅读' });
      }
      case 'perWork': {
        const v = avgOf('reads');
        return v == null ? null : mk('篇均阅读', Math.round(v), { sub: '阅读 ÷ 条数' });
      }
      default:
        return null;
    }
  };

  const order = (prof && prof.cards) || ['followers', 'works', 'reads', 'likes', 'interRate'];
  const cards = [];
  for (const key of order) {
    const c = pickCard(key);
    if (c) cards.push(c);
  }
  // 平台画像里没写、但确实读到过的，补在后面 —— 不让数据白读
  if (prof && prof.angle && prof.angle.only) {
    for (const key of prof.angle.only) {
      if (order.includes(key)) continue;
      const c = pickCard(key);
      if (c) cards.push(c);
    }
  }

  // 一张卡都没有时，别留一片空白。
  // 平台已经说过一句事实（没有频道之类），就直接把它写进来 —— 比「还没有数据」有用
  if (cards.length === 1 && cards[0].v == null) {
    const fact = (r.account && r.account.note) || '';
    $('dMetrics').innerHTML =
      '<div class="mcard wide"><span class="mk">还没有数据</span><span class="mv">—</span>' +
      `<span class="md">&nbsp;</span><span class="ms">${esc(fact || '点右上「刷新数据」读一次')}</span></div>`;
    return;
  }

  $('dMetrics').innerHTML = cards
    .map(
      (c) => `<div class="mcard${c.focus ? ' focus' : ''}">
        <span class="mk">${c.k}${c.focus ? '<i class="mfoc">重点</i>' : ''}</span>
        <span class="mv">${fmt(c.v)}${c.unit ? `<small>${c.unit}</small>` : ''}</span>
        <span class="md">${esc(c.d || '') || '&nbsp;'}</span>
        <span class="ms">${esc(c.sub || '')}</span>
      </div>`
    )
    .join('');
}

function renderWorks() {
  const r = dxAcc;
  if (!r) return;
  const caps = (dxPlat && dxPlat.caps) || { work: [] };
  const declared = caps.work || [];
  const hasVal = (k) => r.works.some((w) => w[k] != null);

  /**
   * 只画「平台声明会给」**并且**「这次真的读到过」的列。
   *
   * 少了后半句，公众号那种平台会留下五列全「—」的空表 ——
   * 用户看到的是「数据都是空的」，其实是平台列表接口根本不给单篇阅读数。
   * 空列不等于「数据是 0」，它只会让人以为软件坏了。
   */
  /**
   * reads 那一列的表头要跟着平台改口：
   * IG/抖音/B站是「播放」、X 是「查看」、公众号是「阅读」、Threads 是「浏览」。
   * 把 155 次播放印成「阅读」，用户会以为是文章阅读量。
   */
  const readWord = (dxPlat && dxPlat.profile && dxPlat.profile.readLabel) || '阅读';
  const cols = WORK_COLS.filter(([k]) => declared.includes(k) && hasVal(k)).map(([k, label]) =>
    k === 'reads' ? [k, readWord] : [k, label]
  );

  // 平台独有指标：只画适配器**声明过**的那几个，并且要真的读到值。
  // 不能「作品对象里有哪些数字就画哪些」—— 那样会冒出 type、share_count
  // 这种内部字段，用户既看不懂也不知道该不该信。
  const EXTRA_LABELS = {
    lengthSec: '时长',
    coins: '投币',
    danmaku: '弹幕',
    recommend: '推荐',
    avgPlaySec: '播放秒',
    watchHours: '观看时长',
    reach: '触达',
    impressions: '展示',
    reactions: '互动',
    reposts: '转发',
    quotes: '引用',
    profileVisits: '主页访问',
    avgWatchTime: '平均观看'
  };
  /**
   * 附加列只接受「数值」。
   * `type`（原创/回复/转发）也是 extra 里的，但它是字符串 ——
   * 混进来会变成一列全是「—」的空白列。
   */
  const extras = (caps.extra || []).filter(
    (k) =>
      k !== 'type' &&
      r.works.some((w) => w.extra && typeof w.extra[k] === 'number' && Number.isFinite(w.extra[k]))
  );

  const tpl = ['minmax(0, 1fr)', '84px', ...cols.map(() => '68px'), ...extras.map(() => '72px')].join(' ');
  document.documentElement.style.setProperty('--tpl', tpl);

  /**
   * 按类型分组。
   *
   * X 的「作品」其实是三种完全不同的东西混在一起：
   *   · 原创 —— 我写的，看的是内容好不好
   *   · 转发 —— 别人的内容，看的是我挑得准不准
   *   · 回复 —— 我说的一句话，看的是参与度
   * 混在一个列表里求和、算平均值都没有意义（把转发当成自己写的，
   * 数据就全错了）。所以分开看，各看各的指标。
   *
   * 别的平台不给 type，这里就整块不显示，不留空壳。
   */
  const hasTypes = r.works.some((w) => w.extra && w.extra.type && w.extra.type !== 'original');
  const tabs = $('dWorkTabs');
  if (hasTypes) {
    // 顺序固定：原创在前 —— 那是最该被看的
    const order = ['original', 'quote', 'reply', 'repost'];
    const counts = {};
    for (const w of r.works) {
      const k = (w.extra && w.extra.type) || 'original';
      counts[k] = (counts[k] || 0) + 1;
    }
    const keys = order.filter((k) => counts[k]);
    if (!keys.includes(dxWorkType) && dxWorkType !== '') dxWorkType = '';
    tabs.hidden = false;
    tabs.innerHTML = [
      `<button type="button" class="dwt${dxWorkType === '' ? ' on' : ''}" data-t="">全部<b>${r.works.length}</b></button>`,
      ...keys.map(
        (k) =>
          `<button type="button" class="dwt${dxWorkType === k ? ' on' : ''}" data-t="${k}">${
            TYPE_LABELS[k] || k
          }<b>${counts[k]}</b></button>`
      )
    ].join('');
  } else {
    tabs.hidden = true;
    tabs.innerHTML = '';
    dxWorkType = '';
  }

  const rows = dxWorkType
    ? r.works.filter((w) => ((w.extra && w.extra.type) || 'original') === dxWorkType)
    : r.works;

  if (!r.works.length) {
    $('dHead').innerHTML = '';
    $('dWorkTabs').hidden = true;
    // 平台明说了「一篇都没有」就照实讲；只有真没读到才让人去重试
    const known = r.account && r.account.note;
    $('dBody').innerHTML = known
      ? `<div class="dempty">${esc(r.account.note)}<br />发第一条内容之后，这里会出现它的数据。</div>`
      : '<div class="dempty">这个号还没有读到作品。<br />点右上「刷新数据」再读一次；' +
        '如果反复读不到，点「诊断」看看卡在哪一步。</div>';
    const t = document.querySelector('.dtable');
    if (t) t.classList.add('is-empty');
    return;
  }
  const t = document.querySelector('.dtable');
  if (t) t.classList.remove('is-empty');

  $('dHead').innerHTML = [
    '<span>作品</span>',
    '<span>发布</span>',
    ...cols.map(([, label]) => `<span class="wnum">${label}</span>`),
    ...extras.map((k) => `<span class="wnum">${esc(EXTRA_LABELS[k] || k)}</span>`)
  ].join('');

  $('dBody').innerHTML = rows
    .map((w) => {
      const cells = cols.map(([k]) => {
        const v = w[k];
        if (v === null || v === undefined) return '<span class="wnum">—</span>';
        if (k === 'completion') return `<span class="wnum">${v}%</span>`;
        return `<span class="wnum">${fmt(v)}</span>`;
      });
      const ex = extras.map((k) => {
        const v = w.extra ? w.extra[k] : null;
        if (v == null) return '<span class="wnum">—</span>';
        // 时长按「分:秒」显示，印 61 没人知道是 61 秒还是 61 分钟
        if (k === 'lengthSec') {
          const sec = Number(v);
          if (Number.isFinite(sec)) {
            const m = Math.floor(sec / 60);
            const s2 = sec % 60;
            return `<span class="wnum">${m}:${String(s2).padStart(2, '0')}</span>`;
          }
        }
        return `<span class="wnum">${fmt(v)}</span>`;
      });
      const title = esc(w.title) || '<i class="untitled">无标题</i>';
      /**
       * 类型角标：原创 / 回复 / 转发 / 引用。
       * X 上这三种混在同一个列表里，光看数字分不清「这条是我写的还是我说的一句话」。
       * 只在平台真的给了类型时才画，别的平台不留空位。
       */
      const t = w.extra && w.extra.type;
      const badge = t && t !== 'original' ? `<i class="wtype ${t}">${TYPE_LABELS[t] || t}</i>` : '';
      return `<div class="drow">
        <span class="wtitle" title="${esc(w.title)}">${badge}${title}</span>
        <span class="wdate" title="${esc(w.published_at || '')}">${esc(
          fmtPub(w.published_at)
        )}</span>
        ${cells.join('')}${ex.join('')}
      </div>`;
    })
    .join('');
}

function renderNote() {
  const r = dxAcc;
  const box = $('dNote');
  const bits = [];

  /**
   * 平台这次给出的「事实」优先，例如「这个 Google 账号还没有 YouTube 频道」。
   *
   * 但空作品时表格里已经写了同一句（renderWorks 的 dempty），这里再说一遍就是
   * 同一句话出现两次 —— 只留表格里那处，它离数据更近。
   */
  const shownInTable = !r.works.length && !!(r.account && r.account.note);
  if (r.account && r.account.note && !shownInTable) bits.push(r.account.note);
  if (dxPlat && dxPlat.disabled) bits.push(dxPlat.disabledReason || '这个平台暂不读数。');
  /**
   * 平台的「说明」不再显示。
   *
   * `platforms.notes` 写的是取数方式（「粉丝数和帖子列表取自主页；查看、赞、
   * 回复、转发、引用、收藏取自 X 自己的接口…」）—— 那是给开发看的实现细节，
   * 用户在这页要看的是数字。它占一行，还让人以为是在解释什么异常。
   * 平台能力现在通过「看哪些指标」直接体现在界面上，不用一句散文来解释。
   */

  // 读取失败才提示重试；读成功就只说数据本身
  const last = r.logs && r.logs[0];
  if (last && (last.result === 'failed' || last.result === 'throttled') && !r.account.note) {
    bits.push(`最近一次读取没有成功：${last.detail || last.result}`);
  }

  if (!bits.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = bits.map((b) => `<p>${esc(b)}</p>`).join('');
}

// ---------------------------------------------------------------- 导出
/**
 * 导出面板的状态。
 *
 * 数据和报告放在同一个入口：用户想的是「我要把这个拿出去」，
 * 不会先分辨自己要的是「导出」还是「生成报告」。
 */
const exState = {
  kind: 'data', // data | report
  range: 'month', // week | month | year | all
  format: '', // 由 kind 决定可选集合
  picked: new Set(), // 空 = 全部
  /**
   * 平台范围，空 = 全部平台。
   *
   * 为什么平台要放在账号前面：报告是按平台分节写的，用户脑子里先有
   * 「我要公众号那一份」，再看具体哪几个号。先勾号再勾平台会很别扭。
   */
  plats: new Set(),
  split: false // 报告专用：每个平台各出一份文件
};

/** 两种类型各自的格式选项。docx 和 xlsx 都是真文件，CSV 留在里面给需要的人 */
const EX_FORMATS = {
  data: [
    ['xlsx', 'Excel', '.xlsx 三个工作表：总览 / 作品 / 每日趋势'],
    ['json', 'JSON', '.json 完整结构，给程序或 AI 用'],
    ['csv', 'CSV', '.csv 按账号分文件，Excel 也能开']
  ],
  report: [
    ['md', 'Markdown', '.md 纯文本，能进 git、能给 AI 读'],
    ['docx', 'Word', '.docx 能自己改、能发给人'],
    ['pdf', 'PDF', '.pdf 定稿、打印、发群里']
  ]
};

async function openExport(kind, opts = {}) {
  exState.kind = kind || 'data';
  exState.format = EX_FORMATS[exState.kind][0][0];
  /**
   * 上一次留下的勾选要**先跟当前账号对一遍**再沿用。
   *
   * 两个坑：
   *   · 勾过的号后来被删掉了 —— 界面上写着「已选 1 个号」，列表里却没有这个号，
   *     导出出来是空文件，看起来像坏功能；
   *   · 从详情页导出会把平台范围收窄成当前平台，而主页的「导出全部」如果不重置，
   *     用户会以为别的平台的号不见了（其实是被上一次的筛选挡住了）。
   * 所以：号按现存过滤；平台范围只有调用方明确要求保留时才保留。
   */
  const aliveAcc = new Set();
  const alivePlat = new Set();
  for (const p of PLATS) {
    alivePlat.add(p.plat);
    for (const a of p.accounts || []) aliveAcc.add(a.id);
  }
  exState.picked = new Set([...exState.picked].filter((id) => aliveAcc.has(id)));
  if (!opts.keepPlats) exState.plats = new Set([...exState.plats].filter((n) => alivePlat.has(n)));
  await renderExport();
  $('exportSheet').hidden = false;
}

function closeExport() {
  $('exportSheet').hidden = true;
}

async function renderExport() {
  const isData = exState.kind === 'data';

  // 类型
  for (const b of $('exKind').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.kind === exState.kind);
  }

  // 时间范围：报告叫「月报」，数据叫「本月」，同一个 range
  const LABELS = isData
    ? { week: '本周', month: '本月', year: '今年', all: '全部' }
    : { week: '周报', month: '月报', year: '年报', all: '全部数据' };
  for (const b of $('exRange').querySelectorAll('button')) {
    b.textContent = LABELS[b.dataset.range] || b.dataset.range;
    b.classList.toggle('on', b.dataset.range === exState.range);
  }
  $('exRangeLabel').textContent = isData ? '时间范围（按发布日期）' : '报告周期';

  // 格式
  const list = EX_FORMATS[exState.kind];
  if (!list.some(([k]) => k === exState.format)) exState.format = list[0][0];
  $('exFormat').innerHTML = list
    .map(
      ([k, name, desc]) =>
        `<button type="button" data-fmt="${k}" class="${k === exState.format ? 'on' : ''}" title="${esc(desc)}">${name}</button>`
    )
    .join('');
  const cur = list.find(([k]) => k === exState.format);
  $('exHint').textContent = cur ? cur[2] : '';

  // 平台范围（「全部」永远在最前，点了就清空选择）
  const platNames = PLATS.filter((p) => (p.accounts || []).length).map((p) => p.plat);
  $('exPlats').innerHTML =
    `<button type="button" data-plat="" class="${exState.plats.size ? '' : 'on'}">全部</button>` +
    platNames
      .map(
        (n) =>
          `<button type="button" data-plat="${esc(n)}" class="${
            exState.plats.has(n) ? 'on' : ''
          }">${esc(n)}</button>`
      )
      .join('');

  // 拆分成多个文件只对报告有意义（数据表本来就是一个格式一个文件）
  // 选「全部」时也允许勾 —— 那样就是 11 个平台各一份，不用先一个个点平台
  $('exSplitWrap').hidden = isData;
  if (isData) exState.split = false;
  $('exSplit').checked = !!exState.split;

  // 账号：跟着平台筛选走，选了一个平台就只列那个平台的号
  const all = [];
  for (const p of PLATS) {
    if (exState.plats.size && !exState.plats.has(p.plat)) continue;
    for (const a of p.accounts || []) all.push({ plat: p.plat, ...a });
  }
  const scopeBit = exState.plats.size ? `${[...exState.plats].join('、')} · ` : '';
  $('exScopeNote').textContent = exState.picked.size
    ? `${scopeBit}已选 ${exState.picked.size} 个号（导出时只导这些）`
    : `${scopeBit}默认全部账号。取消勾选就只导选中的。`;
  $('exAccounts').innerHTML = all.length
    ? all
        .map(
          (a) => `<label class="expickrow">
            <input type="checkbox" data-acc="${esc(a.id)}" ${
              exState.picked.has(a.id) ? 'checked' : ''
            } />
            <span class="explat">${esc(a.plat)}</span>
            <span class="exname">${esc(a.nickname || a.handle || '未命名')}</span>
            <span class="exnum">${a.followers == null ? '—' : fmt(a.followers) + ' 粉'}</span>
          </label>`
        )
        .join('')
    : '<p class="sheet-note">这个范围里还没有登录任何账号。</p>';
}

async function doExport() {
  const btn = $('btnDoExport');
  if (btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  const label = btn.textContent;
  btn.textContent = exState.format === 'pdf' ? '正在生成 PDF…' : '正在导出…';

  const ids = [...exState.picked];
  const plats = [...exState.plats];
  let r = null;
  try {
    if (exState.kind === 'data') {
      r = await window.api.exportData({
        accountIds: ids,
        plats,
        format: exState.format,
        range: exState.range
      });
    } else {
      r = await window.api.genReport({
        accountIds: ids,
        plats,
        split: !!exState.split,
        format: exState.format,
        range: exState.range
      });
    }
  } catch (err) {
    r = { ok: false, error: err.message };
  }

  btn.dataset.busy = '0';
  btn.textContent = label;

  if (r && r.ok) {
    closeExport();
    const detail =
      exState.kind === 'data'
        ? `${r.accounts} 个号 · ${r.rows} 条作品`
        : `${r.period} · ${r.platforms} 个平台`;
    toast(
      `<b>已导出</b>${esc(detail)}<br /><span class="tosmall">${
        r.files && r.files.length > 1 ? `${r.files.length} 个文件，` : ''
      }已在访达里定位到它</span>`,
      'ok',
      { sticky: true }
    );
  } else {
    toast(`导出失败：${esc((r && r.error) || '未知原因')}`, 'bad');
  }
}

/** 详情页重新取一遍（刷新、读完自动回填都用它） */
async function reloadDetail() {
  if (!dxAcc) return;
  const id = dxAcc.account.id;
  /**
   * 平台详情取失败不能让整个详情页停在旧状态。
   *
   * 这一步只影响「平台能力/牌子颜色」这类外壳信息，accountDetail 才是主体；
   * 以前这里抛出去，后面的 renderTabs / loadAccount 全不执行，
   * 用户看到的是点了「刷新数据」以后界面一动不动。
   */
  try {
    const pl = await window.api.platDetail(dxPlatName);
    if (pl && pl.ok) dxPlat = pl;
  } catch (err) {
    console.error('取平台详情失败', err);
  }
  renderTabs();
  await loadAccount(id);
}

/**
 * 手动刷新一个号。
 *
 * 加了一道**点击前**的判断，不只是让后端拒掉：
 *   以前是点下去、转两秒、然后弹一句「距上次才 4 分钟」——
 *   用户白等，还不知道到底该等多久。
 *   现在先看上次读的时间，没到就直接说「还要等几分钟」，
 *   并给出「仍然要读」的选择（有时候就是想立刻看，让他自己决定）。
 *
 * 平台的硬下限（抖音/小红书 20 分钟、其余 15 分钟）由后端把关，
 * 这里只是提前告知，不替代后端判断。
 */
async function refreshCurrent() {
  if (!dxAcc) return;
  const btn = $('btnRefresh');
  if (btn.dataset.busy === '1') return;

  const id = dxAcc.account.id;
  const lastAt = dxAcc.account && dxAcc.account.lastOkAt;
  const plat = dxPlatName;
  // 各平台的间隔下限（和后端 adapters.paceMin 一致）
  const PACE = { 抖音: 20, 小红书: 20, 公众号: 8 };
  const pace = PACE[plat] || 15;

  if (lastAt) {
    const mins = (Date.now() - new Date(lastAt).getTime()) / 60000;
    if (mins < pace) {
      const left = Math.ceil(pace - mins);
      const ok = window.confirm(
        `距上次读取才 ${Math.max(1, Math.floor(mins))} 分钟。\n\n` +
          `${plat} 建议每 ${pace} 分钟最多读一次 —— 读太勤会被平台当成机器人，` +
          `账号有被限制的风险。\n\n` +
          `建议再等 ${left} 分钟。要现在强行读吗？`
      );
      if (!ok) {
        toast(`已取消。再等 ${left} 分钟就好。`, 'ok');
        return;
      }
    }
  }

  btn.dataset.busy = '1';
  btn.textContent = '读取中…';
  setProgress(true, '准备读取');

  let r = null;
  try {
    r = await window.api.syncAccount(id);
  } catch (err) {
    r = { ok: false, message: err.message };
  }

  btn.dataset.busy = '0';
  btn.textContent = '刷新数据';
  setProgress(false);

  await reloadDetail();
  toast(esc((r && r.message) || '读完了'), r && r.ok ? 'ok' : 'bad');
}

/**
 * 详情页的「导出」。
 *
 * 不再是「点了就导一个 CSV」—— 现在打开面板，并且**预先勾好当前这个号**，
 * 因为人在这里点导出，十有八九就是要这个号的数。
 * 平台也一并选上：不然上次留在别的平台，这个号根本不在列表里，看着像丢了。
 */
function exportCurrent() {
  if (!dxAcc) return;
  exState.picked = new Set([dxAcc.account.id]);
  const pl = dxAcc.account.plat;
  if (pl && PLATS.some((p) => p.plat === pl && (p.accounts || []).length)) {
    exState.plats = new Set([pl]);
  } else {
    exState.plats = new Set();
  }
  // 平台预选是这一次的意图，必须明确保留 —— 否则 openExport 会把它当「上次残留」清掉
  openExport('data', { keepPlats: true });
}

/**
 * 退出登录：只清这个号专属环境里的登录态。
 *
 * 加这个按钮的原因很实际：平台的退出按钮经常点不动 ——
 * 有的藏在三层菜单里，有的页面被「验证身份」卡死、整个界面只剩一个弹窗，
 * 那时候用户完全没有操作空间。而这个 App 一个号一个分区，
 * 清掉分区里的 cookie 就等于退出了，根本不需要平台配合。
 *
 * 数据不动：作品和历史指标都留着，换号登回来还能对上。
 */
async function logoutCurrent() {
  if (!dxAcc) return;
  const name = dxAcc.account.nickname || dxAcc.account.handle || '这个号';
  const ok = window.confirm(
    `退出「${name}」的登录？\n\n` +
      '只会清掉这个号专属环境里的登录信息。\n' +
      '已读到的作品和历史数据都会保留，重新登录后可以继续用。\n' +
      '其他平台和其他号完全不受影响。'
  );
  if (!ok) return;

  const btn = $('btnLogout');
  if (btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  btn.textContent = '正在退出…';

  let r = null;
  try {
    r = await window.api.logout(dxAcc.account.id);
  } catch (err) {
    r = { ok: false, error: err.message };
  }

  btn.dataset.busy = '0';
  btn.textContent = '退出登录';

  if (r && r.ok) {
    toast(
      `<b>已退出 ${esc(name)}</b>这个环境里的登录信息清掉了（${r.hadAuth ? '原本是登录状态' : '原本就没登录'}）。` +
        '要重新登录就点「重新登录」。',
      'ok'
    );
    await refresh();
    await reloadDetail();
  } else {
    toast('退出没成功：' + esc((r && r.error) || '未知原因'), 'bad');
  }
}

/**
 * 诊断：把上一次读数的现场摊开。
 *
 * 这里只说事实 —— 打开了哪几页、每页各拿到多少、有没有报错。
 * 原来那套「认出的字段：一个都没认出」是旧模糊抽取路线的话术，
 * 现在每个平台都是固定路线，不存在「认字段」这一步，写出来只会让人以为又读错了。
 */
function showDiag() {
  if (!dxAcc || !dxAcc.diag) {
    toast('还没有诊断记录。先点一次「刷新数据」。', 'bad');
    return;
  }
  const d = dxAcc.diag;
  const pages = d.pages || [];
  const path = (u) => {
    try {
      return (new URL(u).pathname || '/') + (new URL(u).search ? '…' : '');
    } catch {
      return String(u).slice(0, 60);
    }
  };

  const lines = [
    `<b>上次读数打开了 ${pages.length} 页</b>`,
    ...pages.map((p) => {
      if (p.error) return `· ${esc(path(p.url))}：打不开 —— ${esc(p.error)}`;
      const bits = [];
      if (p.login === false) bits.push('没有登录态');
      if (p.account) {
        const kv = Object.keys(p.account)
          .filter((k) => p.account[k] != null)
          .map((k) => `${k}=${p.account[k]}`);
        if (kv.length) bits.push(kv.join(' '));
      }
      if (p.works != null) bits.push(`作品 ${p.works} 条`);
      if (p.note) bits.push(p.note);
      return `· ${esc(path(p.url))}：${esc(bits.join('；') || '没有数字')}`;
    }),
    `接口响应 ${d.interfaceCount || 0} 个`,
    d.loadErr ? `页面报错：${esc(d.loadErr)}` : ''
  ].filter(Boolean);
  toast(
    lines.join('<br />') +
      '<div class="toast-acts"><button class="toastgo" data-act="diagpack" type="button">打包诊断（已脱敏）</button></div>',
    'bad',
    { sticky: true }
  );
}

/**
 * 打包诊断。
 *
 * 诊断原文里有昵称、handle、本机路径 —— 直接让人贴出来等于公开账号。
 * 所以这个按钮做的是「先脱敏再打包」，包里只有字段结构和平台返回的形状。
 * 打完在访达里选中，用户拖着发出去就行，不用找路径。
 */
async function packDiag() {
  toast('正在打包诊断…', 'ok');
  try {
    const r = await window.api.diagPack('');
    if (!r.ok) {
      toast('打包失败：' + esc(r.error || '未知原因'), 'bad');
      return;
    }
    const kb = Math.max(1, Math.round(r.size / 1024));
    toast(
      `诊断包已生成（${r.count} 个文件，${kb} KB），已在访达里选中。<br />` +
        '昵称、handle、头像、uid 都换成了「已隐藏 · N 字」，本机路径也替换过了 —— 建议发出去前自己解压看一眼。',
      'ok',
      { sticky: true }
    );
  } catch (err) {
    toast('打包失败：' + esc(err.message), 'bad');
  }
}

// ---------------------------------------------------------------- 面板
function hideHint() {
  const el = $('sideHint');
  el.hidden = true;
  el.innerHTML = '';
}

function showHint(html, kind) {
  const el = $('sideHint');
  el.innerHTML = html;
  el.className = kind === 'ok' ? 'hint ok' : 'hint';
  el.hidden = false;
}

/**
 * 面板地址变了。
 *
 * 唯一要处理的是「Google 授权被拒」：X 和 Instagram 都提供「用 Google 登录」，
 * 而 Google 对嵌入式浏览器有一道检测。指纹补齐之后绝大多数情况能过，
 * 一旦还是落到「此浏览器或应用可能不安全」，那点重试永远不会好，
 * 所以必须当场改口，指一条真能走通的路。
 *
 * 注意：停在 Google 页本身不是错误，正常登录表单就该停在那儿，别乱报警。
 */
function onPanelUrl(s) {
  if (!s) return;
  if (s.blocked) {
    showHint(
      '<b>Google 拒绝了应用内授权</b>这是 Google 的策略，重试不会好。' +
        '请点左上「返回平台」重开，改用账号密码或手机号验证码登录。'
    );
  } else {
    hideHint();
  }
}

function setPanelOpen(open, plat, meta = {}) {
  document.body.classList.toggle('panel-open', !!open);
  $('side').hidden = !open;
  $('grid').hidden = !!open;

  if (!open) {
    currentPlat = null;
    hideHint();
    /**
     * 关面板必须把「进来之前那一屏」放回去。
     *
     * 以前只清 currentPlat：body 上的 `view-detail` 类留在原处，而 #detail 还是隐藏的，
     * 于是用户看到的是平台列表**少了顶部抬头**（那套抬头只在非详情页显示）。
     * 最容易撞上的路径：从详情页点「重新登录」→ 面板里没登成 → 点「完成」，
     * 既不进详情也不回列表，界面像被截了一半。
     */
    const back = !!(dxBackFrom && dxPlatName);
    const backPlat = dxPlatName;
    const backAcc = dxAcc && dxAcc.account ? dxAcc.account.id : '';
    dxBackFrom = false;
    showDetail(false); // 先把详情页状态清干净（会重置 dxAcc / dxPlatName）
    if (back) openDetail(backPlat, backAcc); // 重新读一遍，别把登录前的旧数据当新的
    return;
  }

  // 从详情页点「重新登录」时把详情页收起来，但记住回来的路 ——
  // 取消登录之后不该被丢回平台列表
  dxBackFrom = !!(dxAcc && dxPlatName);
  $('detail').hidden = true;

  currentPlat = plat;
  const p = PLATS.find((x) => x.plat === plat);
  hideHint();

  $('sideTitle').textContent = meta.index > 0 ? `${plat} · 第 ${meta.index} 个环境` : plat;
  $('sideSub').textContent = meta.slug ? `${meta.slug} · 独立环境` : '独立环境';
  $('sideIcon').style.setProperty('--b-dark', (p && p.brand) || 'var(--accent)');
  $('sideIcon').style.setProperty('--b-light', (p && (p.brandLight || p.brand)) || 'var(--accent)');
  $('sideIcon').innerHTML = svgOf((p && p.icon) || 'unknown');
}

async function openPlatform(plat, opts) {
  setPanelOpen(true, plat);
  try {
    await window.api.openPanel(plat, opts || {});
  } catch (err) {
    $('footLeft').textContent = `打开失败：${err.message}`;
    setPanelOpen(false);
  }
}

/**
 * 点平台卡片。
 *
 * 分叉点只有一个判断：这个平台有没有「登录过并且认得出是谁」的号。
 * 有 → 直接给人看数据（登录这步已经做完了，再让人对着登录页是浪费时间）；
 * 没有 → 走登录。
 */
function openCard(plat) {
  const p = PLATS.find((x) => x.plat === plat);
  const hasAcc = !!(p && p.accounts && p.accounts.length);
  if (hasAcc && p.status !== 'unknown') openDetail(plat);
  else openPlatform(plat);
}

/**
 * 读数进度。
 *
 * start / reading 只是换一行字；done 才是结果 —— 读完了要立刻把数字摆到人眼前，
 * 否则用户会以为又卡住了。读完自动进详情页，是这一整段交互的落点。
 */
function onSync(p) {
  if (!p) return;
  const live = p.phase === 'start' || p.phase === 'reading';

  if (live) {
    const text = p.step || '正在读取…';
    $('footLeft').textContent = `${p.plat}：${text}`;
    if (dxPlatName === p.plat) setProgress(true, text);
    return;
  }

  setProgress(false);
  $('footLeft').textContent = `${p.plat}：${p.step}`;
  // 页脚是「刚才那一步做了什么」的临时位置，不是常驻说明。
  // 不自动恢复的话，上一次读数的结果会一直挂在底下，看起来像这个平台的常驻状态。
  clearTimeout(footResetTimer);
  footResetTimer = setTimeout(() => {
    if (!dxAcc && !pendingOpen) $('footLeft').textContent = footHomeText;
  }, 8000);

  const r = p.result || {};
  const good = r.result === 'ok' || r.result === 'partial';

  /**
   * 读完不再强制跳进详情页。
   *
   * 之前是「读完全自动打开详情」，本意是让数字立刻出现在眼前。
   * 但真实用法是：登录完先去干别的，回来发现自己被弹到了另一个页面，
   * 正在看的东西没了 —— 而且多个平台排队读的时候会连续被弹好几次。
   * 改成一条可点的提示：想看就点，不想看就放着。
   */
  if (pendingOpen === p.plat) {
    pendingOpen = '';
    toast(
      `<b>${esc(p.plat)} 读完了</b>${esc(p.step || '')}` +
        '<button class="toastgo" type="button" data-go="' +
        esc(p.plat) +
        '" data-acc="' +
        esc(p.accountId || '') +
        '">看数据</button>',
      good ? 'ok' : 'bad',
      // 这条要人决定「现在看还是待会儿看」，不能让它在人走开的时候悄悄消失
      { sticky: true }
    );
    if (dxPlatName === p.plat && dxAcc) reloadDetail();
  } else {
    toast(`${esc(p.plat)}　${esc(p.step || '')}`, good ? 'ok' : 'bad');
    if (dxPlatName === p.plat && dxAcc) reloadDetail();
  }
  refresh();
}

/**
 * 点「完成登录」。
 *
 * 这一步之后必须立刻有动静：关面板 → 后台开始读 → 界面上显示进度。
 * 原来这里只写一句「已记录」，用户面对的是一个没有任何下一步的界面，
 * 那等于告诉人「东西坏了」。
 */
async function finish() {
  const btn = $('btnDone');
  if (btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  const label = btn.textContent;
  btn.textContent = '正在确认登录…';

  let r = null;
  try {
    r = await window.api.donePanel();
  } catch (err) {
    r = { ok: false, error: err.message };
  }

  btn.dataset.busy = '0';
  btn.textContent = label;
  setPanelOpen(false);
  await refresh();

  if (!r || !r.ok) {
    toast('完成登录没成功：' + esc((r && r.error) || '未知原因'), 'bad');
    return;
  }

  if (!r.authed) {
    toast(
      '<b>没检测到这个平台的登录状态</b>可能是还没登上去，或者登的不是这个平台。' +
        '重新点卡片、在右边把登录走完再点这一次。',
      'bad'
    );
    $('footLeft').textContent = '没检测到登录状态';
    return;
  }

  pendingOpen = r.plat;
  dxBackFrom = false;
  $('footLeft').textContent = `已登录 ${r.plat}。正在读取数据，第一次要几十秒…`;
  toast(
    `<b>登录好了，正在读 ${esc(r.plat)} 的数据</b>第一次会把能看到的作品都读一遍，` +
      '大概几十秒。读完自动打开详情页，你可以先去干别的。',
    'ok'
  );
}

async function cancel() {
  // 关面板失败也必须把界面放回去——否则用户被卡在一个什么都没有的面板里
  try {
    await window.api.closePanel();
  } catch (err) {
    console.error('关面板失败', err);
  }
  // 从详情页进来的话，setPanelOpen(false) 会把详情页重新打开并重读 ——
  // 「退回哪一屏」这件事只在那一处判断，别在这里再来一遍
  setPanelOpen(false);
  await refresh();
}

/**
 * 从 Chrome 搬登录态。
 *
 * 这条路的用处很具体：YouTube 和 Meta 全系在面板里几乎登不进去
 * （Google 判不安全、Meta 回「请稍后重试」），但用户自己的 Chrome 里通常是登着的。
 * 第一次点会弹一次系统授权框（读 Keychain 需要），属于正常现象。
 */
/**
 * 从 Chrome 导入登录态。
 *
 * 关键改动：**导完必须验证**。
 * 以前只要写进去 N 条就说「已导入」，可其中没有关键那枚 Cookie 时
 * 页面照样是未登录 —— 用户以为成功了，其实什么都没变。
 * 现在按 `authed` 如实说话，并给出下一步该干什么。
 */
async function importFromChrome() {
  const btn = $('btnImport');
  if (btn.dataset.busy === '1') return;

  /**
   * 让用户选 Chrome 资料。
   *
   * 为什么必须给这个选择：一台机器上常有 6~7 个资料，登录着不同账号。
   * 只取 Default 会漏掉真正登录的那个 —— 实测这台机器的 Default 里
   * 没有 YouTube 的 LOGIN_INFO，而 Profile 1/3/6 里都有。
   */
  let profileName = '';
  try {
    const p = await window.api.chromeProfiles();
    const list = (p && p.profiles) || [];
    if (list.length > 1) {
      const names = list.map((x) => x.name);
      const pick = window.prompt(
        `要用 Chrome 的哪个资料？输入序号：\n\n` +
          names.map((n, i) => `${i + 1}. ${n}`).join('\n') +
          `\n\n留空 = 逐个试，直到找到能登录的那一份`,
        '1'
      );
      if (pick === null) return; // 用户取消
      const idx = Number(pick);
      if (Number.isFinite(idx) && idx >= 1 && idx <= names.length) profileName = names[idx - 1];
    }
  } catch {
    /* 列不出来就按自动试——不影响主流程 */
  }

  btn.dataset.busy = '1';
  const label = btn.textContent;
  btn.textContent = '正在读取 Chrome…';

  let r = null;
  try {
    r = await window.api.importChrome(profileName);
  } catch (err) {
    r = { ok: false, error: err.message };
  }

  btn.dataset.busy = '0';
  btn.textContent = label;

  if (r && r.ok && r.authed) {
    showHint(
      `<b>登录态已导入并生效</b>来自「${esc(r.profile)}」资料的 ${r.count} 条。` +
        '页面正在重新加载，几秒后右边应该就是登录状态了。',
      'ok'
    );
    return;
  }

  if (r && r.ok && !r.authed) {
    // 导进去了但没生效 —— 这是最容易误判成「成功」的情况，必须说清楚
    const tried = (r.tried || [])
      .map((t) => `${esc(t.name)}${t.hasAuth ? ' ✓' : t.error ? ' ✗' : ''}`)
      .join('、');
    showHint(
      `<b>Cookie 写进去了，但登录没生效</b>${esc(r.warning || '')}` +
        (tried ? `<br /><span class="tosmall">试过的资料：${tried}</span>` : ''),
      'bad'
    );
    return;
  }

  const tried = (r && r.tried || [])
    .map((t) => `${esc(t.name)}${t.hasAuth ? ' ✓' : ''}`)
    .join('、');
  showHint(
    `<b>导入没成功</b>${esc((r && r.error) || '未知原因')}` +
      (tried ? `<br /><span class="tosmall">试过的资料：${tried}</span>` : ''),
    'bad'
  );
}

/**
 * 重画图表：窗口缩放、主题切换、右侧面板开关都会改变可用宽度。
 * SVG 是按像素画的，宽度变了不重画就会停在旧尺寸上（右边留一大块空白，
 * 或者字被裁掉）。charts.js 的 resize 监听通过这个名字回调。
 */
window.__chRefresh = () => {
  if (!dxAcc) return;
  renderCharts($('dCharts'), dxAcc, dxPlat && dxPlat.caps, (dxPlat && dxPlat.overviewWindow) || '', {
    profile: dxPlat && dxPlat.profile
  });
};

// ---------------------------------------------------------------- 启动
async function boot() {
  bindToastActions();
  noteLaunch();
  try {
    const info = await window.api.info();
    footHomeText = `数据存在本机 · v${info.version}`;
    $('footLeft').textContent = footHomeText;
    $('aboutVer').textContent = `v${info.version}`;
    $('btnRepo').title = REPO_URL;
    await refresh();
  } catch (err) {
    $('footLeft').textContent = `启动失败：${err.message}`;
  }

  const grid = $('grid');

  grid.addEventListener('click', (e) => {
    const add = e.target.closest('.add');
    if (add) {
      e.stopPropagation();
      openPlatform(add.dataset.add, { newAccount: true });
      return;
    }
    // 登录过期不该只剩一个小圆点：卡片上直接给「重新登录」，少一次点击
    const relogin = e.target.closest('.relogin');
    if (relogin) {
      e.stopPropagation();
      openPlatform(relogin.dataset.relogin, { slug: relogin.dataset.slug || undefined });
      return;
    }
    const card = e.target.closest('.card');
    if (card) openCard(card.dataset.plat);
  });

  // 卡片是 div[role=button]，键盘也要能开
  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    openCard(card.dataset.plat);
  });

  // 首次引导的两个出口。都写本地偏好：'done' 之后不再提，'never' 永不再提
  const settleOnboard = (how) => {
    prefs.onboard = how;
    savePrefs();
    renderOnboard(shownPlats());
  };
  $('obOk').addEventListener('click', () => settleOnboard('done'));
  $('obNever').addEventListener('click', () => settleOnboard('never'));

  // ------------------------------------------------------------ 详情页
  $('btnBackGrid').addEventListener('click', async () => {
    showDetail(false);
    await refresh();
  });
  $('btnRefresh').addEventListener('click', refreshCurrent);
  $('btnExport').addEventListener('click', exportCurrent);
  // 主页也能导出（不选号就是全部）—— 详情页不在时也要有入口
  $('btnExportAll').addEventListener('click', () => {
    // 「全部」就要真的全部：号和平台范围都清空，
    // 否则会接着上一轮（从详情页导出时收窄的）平台范围，看着像别的号消失了
    exState.picked = new Set();
    exState.plats = new Set();
    openExport('data');
  });
  $('btnDiag').addEventListener('click', showDiag);
  $('btnRelogin').addEventListener('click', () => {
    if (!dxAcc) return;
    openPlatform(dxPlatName, { slug: dxAcc.account.slug });
  });
  $('btnLogout').addEventListener('click', logoutCurrent);
  $('dTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.dtab');
    if (b && b.dataset.acc !== (dxAcc && dxAcc.account.id)) loadAccount(b.dataset.acc);
  });

  // 作品类型筛选：只重画表格，不重新请求数据
  $('dWorkTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.dwt');
    if (!b) return;
    dxWorkType = b.dataset.t || '';
    renderWorks();
  });

  window.api.onSyncProgress(onSync);

  $('btnDone').addEventListener('click', finish);
  $('btnBack').addEventListener('click', cancel);
  $('btnCancel').addEventListener('click', cancel);
  $('btnReload').addEventListener('click', () => window.api.reloadPanel());
  $('btnImport').addEventListener('click', importFromChrome);
  $('btnData').addEventListener('click', () => window.api.openData());

  window.api.onPanelState((s) => {
    if (s.open) setPanelOpen(true, s.plat, s);
    else setPanelOpen(false);
  });

  window.api.onPanelUrl(onPanelUrl);

  // 面板是原生的，压在网页上层。它占多宽，左栏就得让出多宽。
  window.api.onPanelWidth((pw) => {
    document.documentElement.style.setProperty('--panel-w', pw + 'px');
    // 左栏变窄不会触发 window resize，图表得手动重画，否则会伸出可视区
    setTimeout(() => window.__chRefresh && window.__chRefresh(), 60);
  });

  // ------------------------------------------------------------ 设置
  $('btnSettings').addEventListener('click', openSettings);

  // ---------------------------------------------------------- 导出面板
  $('exKind').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b || b.dataset.kind === exState.kind) return;
    exState.kind = b.dataset.kind;
    exState.format = EX_FORMATS[exState.kind][0][0];
    renderExport();
  });

  $('exRange').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    exState.range = b.dataset.range;
    renderExport();
  });

  $('exFormat').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-fmt]');
    if (!b) return;
    exState.format = b.dataset.fmt;
    renderExport();
  });

  $('exAccounts').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-acc]');
    if (!cb) return;
    if (cb.checked) exState.picked.add(cb.dataset.acc);
    else exState.picked.delete(cb.dataset.acc);
    // 只改提示文字，不重画整个列表 —— 重画会让刚点的复选框失去焦点
    const prefix = exState.plats.size ? `${[...exState.plats].join('、')} · ` : '';
    $('exScopeNote').textContent = exState.picked.size
      ? `${prefix}已选 ${exState.picked.size} 个号（导出时只导这些）`
      : `${prefix}默认全部账号。取消勾选就只导选中的。`;
  });

  // 平台范围
  $('exPlats').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-plat]');
    if (!b) return;
    const name = b.dataset.plat;
    if (!name) {
      exState.plats.clear();
    } else if (exState.plats.has(name)) {
      exState.plats.delete(name);
    } else {
      exState.plats.add(name);
    }
    /**
     * 换平台就清掉已勾的账号。
     *
     * 不清的话会出一个很难解释的现象：勾了抖音的号、再切到公众号，
     * 抖音的 id 还在 picked 里，导出来「公众号的报告」里混进抖音的数。
     */
    exState.picked.clear();
    renderExport();
  });

  $('exSplit').addEventListener('change', (e) => {
    exState.split = e.target.checked;
  });

  $('btnDoExport').addEventListener('click', doExport);
  $('exportSheet').addEventListener('click', (e) => {
    if (e.target.id === 'exportSheet') closeExport();
  });
  $('btnCloseSettings').addEventListener('click', closeSettings);

  // 点浮层空白处关闭，但点卡片里的任何地方都不关
  $('settings').addEventListener('click', (e) => {
    if (e.target.id === 'settings') closeSettings();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('settings').hidden) closeSettings();
  });

  // ---------------------------------------------------------- 关于 / Star
  $('btnRepo').addEventListener('click', openRepo);
  $('btnStar').addEventListener('click', openRepo);

  // 检查更新：点了才联网。这工具对外承诺「断网也能用」，所以不挂定时器、不偷偷请求
  let updateUrl = '';
  $('btnCheckUpdate').addEventListener('click', async () => {
    const btn = $('btnCheckUpdate');
    const msg = $('updateMsg');
    updateUrl = '';
    btn.disabled = true;
    btn.textContent = '检查中…';
    msg.textContent = '';
    msg.classList.remove('up-new');
    try {
      const r = await window.api.checkUpdate(true);
      if (!r.ok) {
        // 连不上 GitHub 是常事，不该红着脸报错
        msg.textContent = '检查失败，稍后再试';
        msg.title = r.error || '';
      } else if (r.noRelease) {
        msg.textContent = '还没有发布版本';
      } else if (r.hasUpdate) {
        msg.textContent = `有新版本 v${r.latest}`;
        msg.classList.add('up-new');
        updateUrl = r.url || '';
        msg.title = '点击打开下载页';
      } else {
        msg.textContent = '已是最新';
      }
    } catch (err) {
      msg.textContent = '检查失败，稍后再试';
      msg.title = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '检查更新';
    }
  });
  $('updateMsg').addEventListener('click', () => {
    if (updateUrl) openLink(updateUrl);
  });
  $('nudgeGo').addEventListener('click', () => {
    openRepo();
    markStar('clicked');
    hideNudge();
  });
  $('nudgeLater').addEventListener('click', () => {
    markStar();
    hideNudge();
  });
  $('nudgeNever').addEventListener('click', () => {
    markStar('never');
    hideNudge();
  });
  $('nudgeClose').addEventListener('click', () => {
    markStar();
    hideNudge();
  });

  $('platPicker').addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const plat = cb.dataset.plat;
    prefs.hidden = (prefs.hidden || []).filter((x) => x !== plat);
    if (!cb.checked) prefs.hidden.push(plat);
    savePrefs();
    renderGrid();
  });

  // ---------------------------------------------------------- 每日自动更新
  $('dailyOn').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
      await window.api.dailySave({ enabled: on });
      toast(on ? '<b>已开启每日自动更新</b>应用开着就会在设定时间自动读一次。' : '已关闭每日自动更新。', 'ok');
    } catch (err) {
      toast(`保存失败：${esc(err.message)}`, 'bad');
      e.target.checked = !on;
    }
    await renderDailyBox();
  });

  $('dailyTime').addEventListener('change', async (e) => {
    const v = String(e.target.value || '');
    const m = /^(\d{1,2}):(\d{2})$/.exec(v);
    if (!m) return;
    try {
      await window.api.dailySave({ hour: Number(m[1]), minute: Number(m[2]) });
      toast(`已改成每天 <b>${m[1].padStart(2, '0')}:${m[2]}</b> 自动更新`, 'ok');
    } catch (err) {
      toast(`保存失败：${esc(err.message)}`, 'bad');
    }
    await renderDailyBox();
  });

  $('btnDailyNow').addEventListener('click', async () => {
    const btn = $('btnDailyNow');
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    const label = btn.textContent;
    btn.textContent = '更新中…';
    let r = null;
    try {
      r = await window.api.dailyRunNow();
    } catch (err) {
      r = { ok: false, error: err.message };
    }
    btn.dataset.busy = '0';
    btn.textContent = label;
    if (r && r.ok) {
      toast(
        `<b>全部更新完成</b>共 ${r.total || 0} 个号：成功 ${r.succeeded || 0}，` +
          `受限 ${r.throttled || 0}，失败 ${r.failed || 0}`,
        'ok',
        { sticky: true }
      );
    } else {
      toast(`更新失败：${esc((r && r.error) || '未知原因')}`, 'bad');
    }
    await renderDailyBox();
    await refresh();
  });

  // 每日更新进度：读的时候在页脚显示「正在读第几个」
  if (window.api.onDailyEvent) {
    window.api.onDailyEvent((ev) => {
      if (!ev) return;
      if (ev.phase === 'daily-start' || ev.phase === 'daily-progress') {
        $('footLeft').textContent = `每日更新：${ev.step || ''}`;
      } else if (ev.phase === 'daily-done') {
        $('footLeft').textContent = `每日更新完成：${ev.step || ''}`;
        clearTimeout(footResetTimer);
        footResetTimer = setTimeout(() => {
          $('footLeft').textContent = footHomeText;
        }, 10000);
        renderDailyBox().catch(() => {});
      } else if (ev.phase === 'daily-armed' && ev.at) {
        // 排好了就说一声，但别盖住用户正在看的东西
        if ($('footLeft').textContent === footHomeText) {
          const t = new Date(ev.at);
          $('footLeft').textContent = `下次自动更新：${t.toLocaleString('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          })}`;
        }
      }
    });
  }

  // ---------------------------------------------------------- AI 接入
  $('aiToggle').addEventListener('change', async (e) => {
    const on = e.target.checked;
    $('aiState').textContent = on ? '正在打开…' : '正在关闭…';
    try {
      const r = await window.api.aiToggle(on);
      if (r && r.ok === false) {
        toast(`打开失败：${esc(r.error || '未知原因')}`, 'bad');
        $('aiToggle').checked = false;
      } else {
        toast(on ? '<b>AI 接入已打开</b>密钥在设置里，只监听本机。' : 'AI 接入已关闭，端口不再监听。', 'ok');
      }
    } catch (err) {
      toast(`操作失败：${esc(err.message)}`, 'bad');
    }
    await renderAiBox();
  });

  $('btnCopyToken').addEventListener('click', async () => {
    const t = $('aiToken').textContent || '';
    try {
      await navigator.clipboard.writeText(t);
      toast('密钥已复制', 'ok');
    } catch {
      // 剪贴板被拒时选中文本，让人手动复制，不要静默失败
      const r = document.createRange();
      r.selectNodeContents($('aiToken'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      toast('已选中密钥，按 ⌘C 复制', 'bad');
    }
  });

  $('btnCopyConf').addEventListener('click', async () => {
    const t = $('aiConf').textContent || '';
    try {
      await navigator.clipboard.writeText(t);
      toast('配置已复制，粘到 AI 客户端的配置里即可', 'ok');
    } catch {
      toast('复制失败，请手动选中上面那段', 'bad');
    }
  });

  $('btnRotateToken').addEventListener('click', async () => {
    if (!window.confirm('换一个密钥？旧的会立刻失效，已经连上的 AI 需要重新配置。')) return;
    try {
      const r = await window.api.aiRotate();
      if (r && r.ok) toast('已换新密钥', 'ok');
    } catch (err) {
      toast(`换密钥失败：${esc(err.message)}`, 'bad');
    }
    await renderAiBox();
  });

  $('themeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme]');
    if (!b) return;
    prefs.theme = b.dataset.theme;
    savePrefs();
    applyTheme();
  });

  window.api.onPlatsUpdate((list) => {
    PLATS = list;
    renderGrid();
  });

  armStarNudge();
}

// 先上主题再拉数据：晚一步用户会看到深色闪一下
applyTheme();
boot();
