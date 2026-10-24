'use strict';
/**
 * 数据层自测 · 零依赖
 * 跑：npm test  或  node --no-warnings test/run.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../lib/db');

// ---------------------------------------------------------- 极简断言器
let pass = 0;
const failures = [];

function section(title) {
  console.log(`\n${title}`);
}

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function eq(actual, expected, hint = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${hint}期望 ${e}，实际 ${a}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function throwsWith(fn, needle) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  if (!caught) throw new Error(`期望抛错（${needle}），但没有抛`);
  if (needle && !String(caught.message).includes(needle)) {
    throw new Error(`抛错信息不含「${needle}」，实际：${caught.message}`);
  }
  return caught;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-test-'));

// ====================================================== 1. 建库与迁移
section('1. 建库与迁移');

const memPath = ':memory:';
let m = db.open(memPath);
let res;

check('空库迁移到最新版本', () => {
  res = db.migrate(m, { dbPath: memPath });
  eq(res.from, 0, '起始版本应为 0；');
  eq(res.to, db.LATEST, '应迁移到最新；');
  ok(res.applied.length > 0, '应至少应用一条迁移');
});

check('schema_version 与代码一致', () => {
  eq(db.schemaVersion(m), db.LATEST);
});

check('五张业务表齐全', () => {
  const tables = db.listTables(m);
  for (const t of ['accounts', 'snapshots', 'works', 'work_metrics', 'sync_log', 'meta']) {
    ok(tables.includes(t), `缺少表 ${t}，实际有 ${tables.join(', ')}`);
  }
});

check('迁移幂等：再跑一次不重复应用', () => {
  const again = db.migrate(m, { dbPath: memPath });
  eq(again.applied.length, 0, '第二次不应有迁移；');
  eq(again.from, db.LATEST);
});

// ====================================================== 2. 账号与约束
section('2. 账号表与约束');

const now = db.nowIso();

function addAccount(overrides = {}) {
  const a = {
    id: overrides.id || `acc_${Math.random().toString(36).slice(2, 8)}`,
    plat: overrides.plat || '小红书',
    nickname: overrides.nickname || '测试号',
    handle: overrides.handle || 'test',
    uid: overrides.uid === undefined ? 'xhs_001' : overrides.uid,
    partition: overrides.partition || 'persist:acct-1',
    created_at: now,
    ...overrides
  };
  m.prepare(
    `INSERT INTO accounts (id, plat, nickname, handle, uid, partition, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(a.id, a.plat, a.nickname, a.handle, a.uid, a.partition, a.created_at);
  return a;
}

check('插入账号并读回', () => {
  const a = addAccount({ id: 'a1', uid: 'xhs_001', nickname: '老王说能源' });
  const row = m.prepare('SELECT * FROM accounts WHERE id = ?').get('a1');
  eq(row.nickname, '老王说能源');
  eq(row.status, 'unknown', '新账号状态应为 unknown；');
  // 默认改成开：用户要的是「一直在登录，每天早上自动读一次」。
  // 默认关的话，功能建好了却永不生效 —— 那比没有更糟（界面显示已开启，实际没动）。
  eq(row.auto_sync, 1, '自动更新默认必须是开（1）；');
  eq(row.sync_interval_h, 6, '默认间隔应为 6 小时；');
  eq(row.backfill_target, 'week', '默认回溯档位应为 week；');
  ok(row.id === a.id);
});

check('同平台同 uid 不能重复', () => {
  throwsWith(() => addAccount({ uid: 'xhs_001' }), 'UNIQUE');
});

check('uid 为空的账号可以有多条（尚未读到身份时）', () => {
  addAccount({ id: 'a_empty_1', uid: '' });
  addAccount({ id: 'a_empty_2', uid: '' });
  const n = m.prepare(`SELECT COUNT(*) AS c FROM accounts WHERE uid = ''`).get().c;
  eq(n, 2);
});

check('自动更新间隔小于 6 小时被数据库拒绝', () => {
  throwsWith(
    () =>
      m
        .prepare(`INSERT INTO accounts (id, plat, sync_interval_h, created_at) VALUES (?, ?, ?, ?)`)
        .run('bad_interval', '抖音', 3, now),
    'CHECK'
  );
});

check('状态只能是四种取值之一', () => {
  throwsWith(
    () =>
      m
        .prepare(`INSERT INTO accounts (id, plat, status, created_at) VALUES (?, ?, ?, ?)`)
        .run('bad_status', '抖音', 'weird', now),
    'CHECK'
  );
});

check('回溯档位只能是 today/week/all', () => {
  throwsWith(
    () =>
      m
        .prepare(`INSERT INTO accounts (id, plat, backfill_target, created_at) VALUES (?, ?, ?, ?)`)
        .run('bad_target', '抖音', 'forever', now),
    'CHECK'
  );
});

// ====================================================== 3. 快照
section('3. 日快照');

check('同一天只能有一个快照点', () => {
  const stmt = m.prepare(
    `INSERT INTO snapshots (account_id, date, followers, captured_at) VALUES (?, ?, ?, ?)`
  );
  stmt.run('a1', '2026-10-23', 1200, now);
  throwsWith(() => stmt.run('a1', '2026-10-23', 1300, now), 'UNIQUE');
});

check('同一天重复写入用替换语义更新', () => {
  m.prepare(
    `INSERT OR REPLACE INTO snapshots (account_id, date, followers, captured_at)
     VALUES (?, ?, ?, ?)`
  ).run('a1', '2026-10-23', 1250, now);
  const row = m.prepare(`SELECT followers FROM snapshots WHERE account_id = ? AND date = ?`).get(
    'a1',
    '2026-10-23'
  );
  eq(row.followers, 1250);
  const count = m.prepare(`SELECT COUNT(*) AS c FROM snapshots WHERE account_id = 'a1'`).get().c;
  eq(count, 1, '一天一个点，不应新增行；');
});

check('NULL 与 0 是两件事，都能存', () => {
  m.prepare(
    `INSERT INTO snapshots (account_id, date, followers, total_reads, captured_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run('a1', '2026-10-22', null, 0, now);
  const row = m.prepare(`SELECT followers, total_reads FROM snapshots WHERE date = '2026-10-22'`).get();
  eq(row.followers, null, '没读到应存 null；');
  eq(row.total_reads, 0, '读到 0 应存 0；');
});

// ====================================================== 4. 作品与指标时序
section('4. 作品与指标时序');

check('插入作品', () => {
  m.prepare(
    `INSERT INTO works (id, account_id, plat_work_id, title, published_at, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('w1', 'a1', 'note_1001', '为什么电网要改造', '2026-10-20', now, now);
  const row = m.prepare('SELECT * FROM works WHERE id = ?').get('w1');
  eq(row.gone, 0);
  eq(row.title, '为什么电网要改造');
});

check('同账号同平台作品 id 不能重复（增量去重靠它）', () => {
  throwsWith(
    () =>
      m
        .prepare(
          `INSERT INTO works (id, account_id, plat_work_id, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run('w1_dup', 'a1', 'note_1001', now, now),
    'UNIQUE'
  );
});

check('指标是追加的时序，同一作品可以有多行', () => {
  const stmt = m.prepare(
    `INSERT INTO work_metrics (work_id, captured_at, reads, likes, saves, completion)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  stmt.run('w1', '2026-10-21T10:00:00.000Z', 800, 40, 12, 0.32);
  stmt.run('w1', '2026-10-22T10:00:00.000Z', 1500, 75, 30, 0.35);
  stmt.run('w1', '2026-10-23T10:00:00.000Z', 2100, 110, 48, 0.36);
  const rows = m
    .prepare(`SELECT reads FROM work_metrics WHERE work_id = ? ORDER BY captured_at`)
    .all('w1');
  eq(rows.map((r) => r.reads), [800, 1500, 2100], '应按时间拿到三条曲线点；');
});

check('同一时刻不会重复采（主键挡住）', () => {
  throwsWith(
    () =>
      m
        .prepare(`INSERT INTO work_metrics (work_id, captured_at, reads) VALUES (?, ?, ?)`)
        .run('w1', '2026-10-23T10:00:00.000Z', 9999),
    'UNIQUE'
  );
});

// ====================================================== 5. 日志与级联
section('5. 更新日志与级联删除');

check('写一条更新日志', () => {
  m.prepare(
    `INSERT INTO sync_log (account_id, started_at, finished_at, trigger, pages, new_works, result)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('a1', now, now, 'manual', 4, 2, 'ok');
  const row = m.prepare('SELECT * FROM sync_log WHERE account_id = ?').get('a1');
  eq(row.result, 'ok');
  eq(row.trigger, 'manual');
});

check('result 只接受约定取值（空读数是 empty 不是 failed）', () => {
  throwsWith(
    () =>
      m
        .prepare(`INSERT INTO sync_log (account_id, started_at, result) VALUES (?, ?, ?)`)
        .run('a1', now, 'nothing'),
    'CHECK'
  );
});

check('删除账号会带走快照、作品、指标', () => {
  m.prepare('DELETE FROM accounts WHERE id = ?').run('a1');
  eq(m.prepare(`SELECT COUNT(*) AS c FROM snapshots WHERE account_id = 'a1'`).get().c, 0);
  eq(m.prepare(`SELECT COUNT(*) AS c FROM works WHERE account_id = 'a1'`).get().c, 0);
  eq(m.prepare(`SELECT COUNT(*) AS c FROM work_metrics WHERE work_id = 'w1'`).get().c, 0);
});

check('删除账号后更新日志仍保留（审计）', () => {
  const n = m.prepare(`SELECT COUNT(*) AS c FROM sync_log WHERE account_id = 'a1'`).get().c;
  eq(n, 1, '日志不应随账号删除；');
});

check('外键约束是开着的', () => {
  throwsWith(
    () =>
      m
        .prepare(`INSERT INTO works (id, account_id, plat_work_id, first_seen_at, last_seen_at)
                  VALUES (?, ?, ?, ?, ?)`)
        .run('w_orphan', '不存在的账号', 'x', now, now),
    'FOREIGN KEY'
  );
});

m.close();

// ====================================================== 6. 备份与恢复
section('6. 备份与恢复');

const filePath = path.join(TMP, 'data', 'monitor.db');
const backupDir = path.join(TMP, 'backups');

let fileDb = db.open(filePath);
db.migrate(fileDb, { dbPath: filePath, backupDir });

fileDb
  .prepare(`INSERT INTO accounts (id, plat, uid, nickname, created_at) VALUES (?, ?, ?, ?, ?)`)
  .run('acc_file', '公众号', 'gh_001', '备份前', now);
fileDb.close();

let backupPath = '';

check('备份产出文件且是合法 SQLite', () => {
  const d = db.open(filePath);
  backupPath = db.makeBackup(d, filePath, backupDir, 'test');
  d.close();
  ok(fs.existsSync(backupPath), '备份文件应存在');
  ok(db.looksLikeSqlite(backupPath), '备份应是合法 SQLite 文件');
});

check('备份之后改的东西，恢复后应消失', () => {
  let d = db.open(filePath);
  d.prepare(`UPDATE accounts SET nickname = ? WHERE id = ?`).run('备份后改的', 'acc_file');
  eq(d.prepare(`SELECT nickname FROM accounts WHERE id = 'acc_file'`).get().nickname, '备份后改的');
  d.close();

  db.restore(filePath, backupPath);

  d = db.open(filePath);
  const row = d.prepare(`SELECT nickname FROM accounts WHERE id = 'acc_file'`).get();
  eq(row.nickname, '备份前', '恢复后应回到备份时的数据；');
  eq(db.integrityCheck(d), 'ok', '恢复后完整性检查应通过；');
  d.close();
});

check('恢复前会把现有库留一份底', () => {
  const kept = fs.readdirSync(path.join(TMP, 'data')).filter((f) => f.includes('before-restore'));
  ok(kept.length > 0, '应留下 .before-restore 文件');
});

check('拒绝恢复非 SQLite 文件', () => {
  const fake = path.join(TMP, 'not-a-db.txt');
  fs.writeFileSync(fake, '这不是数据库');
  throwsWith(() => db.restore(filePath, fake), '不是有效的数据库备份');
});

check('拒绝恢复不存在的文件', () => {
  throwsWith(() => db.restore(filePath, path.join(TMP, 'nope.db')), '备份文件不存在');
});

// ====================================================== 7. 日期工具
section('7. 日期与时间工具');

check('todayLocal 用本地日期而非 UTC', () => {
  const d = new Date(2026, 9, 23, 23, 30);
  eq(db.todayLocal(d), '2026-10-23');
});

check('dateOffset 往前推 7 天', () => {
  eq(db.dateOffset(-7, new Date(2026, 9, 23, 12)), '2026-10-16');
});

check('daysBetween 计算天数差', () => {
  eq(db.daysBetween('2026-10-16', '2026-10-23'), 7);
  eq(db.daysBetween('2026-10-23', '2026-10-16'), -7);
});

check('nowIso 带毫秒（同一秒内两次采集不撞主键）', () => {
  const a = db.nowIso();
  const b = db.nowIso(new Date(Date.parse(a) + 1));
  ok(a !== b && a.includes('.'), `时间戳应带毫秒：${a} / ${b}`);
});

// ====================================================== 8. 平台适配器
section('8. 平台适配器');

const adapters = require('../lib/adapters');

check('平台清单包含国内 7 个 + 海外 5 个', () => {
  const list = adapters.makeRegistry().list();
  eq(list.length, 12);
  for (const it of list) ok(it.adapter, `${it.plat} 缺少适配器`);

  const cn = list.filter((x) => x.region === 'cn').map((x) => x.plat);
  const gl = list.filter((x) => x.region === 'global').map((x) => x.plat);
  eq(cn.length, 7);
  eq(gl.length, 5);

  // 国内在前、海外在后：界面顺序就是这个顺序
  eq(list.slice(0, 7).map((x) => x.region).join(','), 'cn,cn,cn,cn,cn,cn,cn');
  eq(list.slice(7).map((x) => x.region).join(','), 'global,global,global,global,global');
});

check('X 只保留一个入口（不再分中英文两个号）', () => {
  const reg = adapters.makeRegistry();
  const xs = reg.list().filter((x) => x.key === 'x');
  eq(xs.length, 1);
  eq(xs[0].plat, 'X');
});

check('每个平台都有图标与合法品牌色，界面不会出现空洞', () => {
  for (const it of adapters.makeRegistry().list()) {
    ok(it.icon, `${it.plat} 缺 icon`);
    ok(/^#[0-9A-Fa-f]{6}$/.test(it.brand), `${it.plat} 品牌色不合法：${it.brand}`);
  }
});

check('没验证过取数的平台必须关掉读数，不拿来源不明的数字充数', () => {
  const reg = adapters.makeRegistry();
  for (const { plat, adapter } of reg.list()) {
    if (adapter.verifiedAt === '') {
      eq(adapter.disabled, true, `${plat} 没验证取数路线却开着读数`);
    }
  }
});

check('所有内置适配器通过校验', () => {
  for (const { plat, adapter } of adapters.makeRegistry().list()) {
    eq(adapters.validate(adapter), [], `${plat} 校验失败；`);
  }
});

/**
 * 这一条原来要求「每个平台都能读粉丝数」。
 * 现在多了一条真实的例外：YouTube 的 Google 账号可能压根没有频道，
 * 这种号一个数字都不该有 —— 声明空、但不装。
 */
check('平台不能在没有任何账号指标的同时还声称能读数', () => {
  for (const { plat, adapter } of adapters.makeRegistry().list()) {
    if (adapter.caps.account.length) continue;
    ok(!!adapter.notes, `${plat} 没有账号指标，也没说明原因`);
  }
});

check('每个平台的账号级指标都在已知集合里', () => {
  const known = ['followers', 'totalReads', 'totalLikes', 'worksTotal'];
  for (const { plat, adapter } of adapters.makeRegistry().list()) {
    for (const k of adapter.caps.account) ok(known.includes(k), `${plat} 声明了未知指标 ${k}`);
  }
});

check('声明了作品指标的平台至少给三个', () => {
  for (const { plat, adapter } of adapters.makeRegistry().list()) {
    // 公众号的「已发表」接口一个数字都不给，声明 0 个是如实的；
    // 为了凑数写上三项，界面就会多三列空表头。
    if (!adapter.caps.work.length) continue;
    ok(adapter.caps.work.length >= 3, `${plat} 作品指标只有 ${adapter.caps.work.length} 个`);
  }
});

check('口径标记只有「累计」和「近7天」两种', () => {
  for (const { plat, adapter } of adapters.makeRegistry().list()) {
    const w = adapter.overviewWindow || '';
    ok(w === '' || w === '7d', `${plat} 的 overviewWindow 写成了 ${w}`);
  }
});

check('登录凭证判定支持多种写法', () => {
  const reg = adapters.makeRegistry();
  for (const { plat, adapter } of reg.list()) {
    const c = adapter.authCookie;
    ok(!!c, `${plat} 没配 authCookie`);
    const list = Array.isArray(c.any) ? c.any : [c];
    ok(list.length >= 1, `${plat} 的 authCookie 是空的`);
    for (const x of list) ok(!!x.name, `${plat} 有一项没写 Cookie 名`);
  }
  // 小红书有主站和创作者后台两个站，必须两枚都试 —— 只认 web_session 就会
  // 得出「明明登上了，说没检测到」，而用户自己修不了这个错。
  ok(reg.get('小红书').authCookie.any.length >= 2, '小红书应同时认主站和创作者后台');
});

check('can() 按平台真实能力判定，不是一刀切', () => {
  const reg = adapters.makeRegistry();
  eq(reg.can('小红书', 'completion'), false, '小红书没有完播率；');
  eq(reg.can('视频号', 'completion'), true, '视频号有完播率；');
  eq(reg.can('小红书', 'saves'), true);
});

check('平台独有指标走 extra，不污染通用列', () => {
  const reg = adapters.makeRegistry();
  eq(reg.can('B站', 'coins'), true, 'B站有投币；');
  eq(reg.can('小红书', 'coins'), false);
});

check('未验证的平台会被标为可能失效', () => {
  const reg = adapters.makeRegistry();
  // 微博 2026-10-24 用 uid + profile/mymblog 实测通过，不该再被标「可能失效」
  eq(reg.staleness('微博').warn, false, '微博已验证，不该再提示');
  eq(reg.staleness('抖音').warn, false, '刚验证过的不该提示');
  // 没写 verifiedAt 的平台必须老实报「未知」，不能假装验证过
  for (const p of reg.list()) {
    if (p.adapter.verifiedAt) continue;
    eq(reg.staleness(p.plat).known, false, `${p.plat} 没写 verifiedAt，应报未知；`);
  }
});

check('校验能抓出坏适配器', () => {
  const errs = adapters.validate({ key: 'x', name: 'x', mode: 'telepathy', pages: {}, paceMin: -1 });
  ok(errs.length >= 4, `应报多处错误，实际只有 ${errs.length} 条：${errs.join('；')}`);
});

check('外部 JSON 能覆盖内置适配器（平台改版时只换文件）', () => {
  const dir = path.join(TMP, 'adapters');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'xhs.json'),
    JSON.stringify({
      pages: { works: 'https://creator.xiaohongshu.com/statistics/v2' },
      paceMin: 30,
      caps: { work: ['reads', 'likes', 'saves'] }
    })
  );
  const reg = adapters.makeRegistry(dir);
  const a = reg.byKey('xhs');
  eq(a.paceMin, 30, '覆盖生效；');
  eq(a.pages.works, 'https://creator.xiaohongshu.com/statistics/v2');
  eq(a.pages.account, 'https://creator.xiaohongshu.com/new/note-manager', '没覆盖的字段应保留；');
  eq(a.caps.work, ['reads', 'likes', 'saves']);
  eq(a.caps.extra, [], 'caps 里没提到的键应保留原值；');
})

check('坏 JSON 不崩，回退默认并给警告', () => {
  const dir = path.join(TMP, 'adapters-bad');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'douyin.json'), '{这不是 JSON');
  const reg = adapters.makeRegistry(dir);
  ok(reg.warnings.length > 0, '应有警告');
  eq(reg.byKey('douyin').paceMin, 20, '应回退内置默认；');
});

check('外部覆盖写了非法值会被拒绝并回退', () => {
  const dir = path.join(TMP, 'adapters-invalid');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bili.json'), JSON.stringify({ mode: 'telepathy' }));
  const reg = adapters.makeRegistry(dir);
  eq(reg.byKey('bili').mode, 'web', '非法值应回退；');
  ok(
    reg.warnings.some((w) => w.includes('bili')),
    '警告里应指明是哪个平台'
  );
});

// ====================================================== 7. 指标抽取
section('7. 指标抽取（extract）');

const extract = require('../lib/extract');

check('数字带单位要换算成真实值', () => {
  eq(extract.toNum('1.2万'), 12000);
  eq(extract.toNum('3.4亿'), 340000000);
  eq(extract.toNum('12,345'), 12345);
  eq(extract.toNum('2.1K'), 2100);
  eq(extract.toNum('10万+'), 100000);
  eq(extract.toNum('１２３'), 123, '全角数字；');
});

check('认不出的数字返回 null，不是 0', () => {
  eq(extract.toNum('粉丝'), null);
  eq(extract.toNum(''), null);
  eq(extract.toNum('--'), null);
  ok(extract.toNum('粉丝') !== 0, 'null 与 0 必须区分开');
});

check('比例与百分比', () => {
  eq(extract.toPct('45.6%'), 45.6);
  eq(extract.toPct(0.456), 45.6, '0~1 的小数按比例处理；');
  eq(extract.toPct(45.6), 45.6, '已经大于 1 的值原样保留；');
});

check('时间戳与日期串都归成 YYYY-MM-DD', () => {
  eq(extract.toDate(1729555200), '2024-10-22', '10 位秒级；');
  eq(extract.toDate(1729555200000), '2024-10-22', '13 位毫秒级；');
  eq(extract.toDate('2026-10-22 10:30'), '2026-10-22');
  eq(extract.toDate('garbage'), '');
  eq(extract.toDate(0), '', '0 不是有效时间；');
});

check('账号指标优先取接口，且跳过「推荐关注」里的同名字段', () => {
  const blobs = [
    {
      data: {
        // 这一坨是推荐列表里的别人，follower 大得离谱
        recommendUsers: [{ nickname: '大V', follower_count: 9800000 }],
        user: { nickname: '我', follower_count: '1.2万', totalLike: 3400 }
      }
    }
  ];
  const r = extract.extractAccount({ jsonBlobs: blobs });
  eq(r.values.followers, 12000, '应取自己那 1.2 万；');
  eq(r.values.totalLikes, 3400);
});

check('接口里没有就从页面文本里按中文标签取', () => {
  const r = extract.extractAccount({ pageText: '公众号\n粉丝数\n1.2万\n昨日新增 12' });
  eq(r.values.followers, 12000);
});

check('作品数组能认出来，字段映射正确', () => {
  const blobs = [
    {
      data: {
        list: [
          { noteId: 'n1', title: '第一篇', createTime: 1729555200, viewCount: '1.2万', likeCount: 234, collectCount: 45, commentCount: 8, shareCount: 3 },
          { noteId: 'n2', title: '第二篇', createTime: 1729641600, viewCount: 3400, likeCount: 12, collectCount: 1, commentCount: 0, shareCount: 0 },
          { noteId: 'n3', title: '第三篇', createTime: 1729728000, viewCount: 990, likeCount: 5, collectCount: 0, commentCount: 1, shareCount: 2 }
        ]
      }
    }
  ];
  const { works, path: p } = extract.extractWorks({ jsonBlobs: blobs });
  eq(works.length, 3);
  ok(p.includes('list'), `路径应指向 list，实际 ${p}`);
  eq(works[0].platWorkId, 'n1');
  eq(works[0].title, '第一篇');
  eq(works[0].reads, 12000);
  eq(works[0].saves, 45);
  eq(works[0].publishedAt, '2024-10-22');
});

check('没有 id 的条目要丢掉，否则每次刷新都会重复建行', () => {
  const blobs = [{ list: [{ title: '无 id 的条目', viewCount: 100, likeCount: 3 }] }];
  const { works } = extract.extractWorks({ jsonBlobs: blobs });
  eq(works.length, 0);
});

check('登录墙判定：有指标就不算墙，空白页也不算', () => {
  ok(extract.looksLoginWall('扫码登录', {}) === true);
  ok(extract.looksLoginWall('扫码登录', { followers: 100 }) === false, '有数据时不该判成墙；');
  ok(extract.looksLoginWall('', {}) === false, '空白页交给 empty 处理；');
});

// ====================================================== 汇总
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${'-'.repeat(52)}`);
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`);
  process.exit(0);
} else {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.message}`);
  process.exit(1);
}
