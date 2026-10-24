'use strict';
/**
 * 增量引擎自测 · 用假读数，不需要登录、不碰真账号
 * 跑：npm test
 */

const db = require('../lib/db');
const sync = require('../lib/sync');

let pass = 0;
const failures = [];

function section(t) {
  console.log(`\n${t}`);
}
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}
function eq(a, e, hint = '') {
  const sa = JSON.stringify(a);
  const se = JSON.stringify(e);
  if (sa !== se) throw new Error(`${hint}期望 ${se}，实际 ${sa}`);
}
function ok(c, m) {
  if (!c) throw new Error(m || '断言失败');
}

// ---------------------------------------------------------------- 夹具
const TODAY = '2026-10-23';
const NOW = '2026-10-23T11:00:00.000Z';
const ADAPTER = { paceMin: 20 };

function freshDb() {
  const d = db.open(':memory:');
  db.migrate(d, { dbPath: ':memory:' });
  d.prepare(`INSERT INTO accounts (id, plat, uid, nickname, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    'a1',
    '小红书',
    'xhs_001',
    '测试号',
    NOW
  );
  return d;
}

function getAccount(d) {
  return d.prepare(`SELECT * FROM accounts WHERE id = 'a1'`).get();
}

/** 造一个假读数器 */
function readerOf(read) {
  return {
    calls: 0,
    async readAccount() {
      this.calls++;
      return read;
    }
  };
}

function baseRead(over = {}) {
  return Object.assign(
    {
      status: 'ok',
      pages: 3,
      account: { followers: 1200, totalReads: 45000, worksTotal: 2 },
      works: [
        {
          platWorkId: 'n1',
          title: '为什么电网要改造',
          publishedAt: '2026-10-20',
          reads: 2100,
          likes: 110,
          saves: 48,
          comments: 12
        },
        {
          platWorkId: 'n2',
          title: '储能的三条路',
          publishedAt: '2026-10-10',
          reads: 800,
          likes: 40
        }
      ]
    },
    over
  );
}

// ====================================================== 1. 正常一次
(async () => {
  section('1. 正常读一次');

  let d = freshDb();
  let rd = readerOf(baseRead());

  await check('返回 ok 并统计新增作品', async () => {
    const r = await sync.syncAccount({
      database: d,
      account: getAccount(d),
      adapter: ADAPTER,
      reader: rd,
      now: NOW,
      today: TODAY
    });
    eq(r.result, 'ok');
    eq(r.newWorks, 2, '应新增 2 条作品；');
    eq(r.rescanned, 0, '首次没有可回扫的；');
  });

  await check('账号日快照落库', async () => {
    const s = d.prepare(`SELECT * FROM snapshots WHERE account_id = 'a1' AND date = ?`).get(TODAY);
    eq(s.followers, 1200);
    eq(s.total_reads, 45000);
    eq(s.works_total, 2);
  });

  await check('作品落库带封面与标题', async () => {
    const rows = d.prepare(`SELECT * FROM works WHERE account_id = 'a1' ORDER BY published_at DESC`).all();
    eq(rows.length, 2);
    eq(rows[0].title, '为什么电网要改造');
    eq(rows[0].plat_work_id, 'n1');
    ok(rows[0].id && rows[0].id.length >= 16, '作品 id 应由哈希生成');
  });

  await check('指标作为时序写入', async () => {
    const m = d
      .prepare(
        `SELECT m.reads, m.likes, m.saves, m.comments
         FROM work_metrics m JOIN works w ON w.id = m.work_id
         WHERE w.plat_work_id = 'n1'`
      )
      .get();
    eq(m.reads, 2100);
    eq(m.saves, 48);
    eq(m.comments, 12);
  });

  await check('账号状态转为 ok 且游标推进', async () => {
    const a = getAccount(d);
    eq(a.status, 'ok');
    eq(a.last_ok_at, NOW);
    eq(a.last_sync_at, NOW);
  });

  await check('写了一条成功日志', async () => {
    const logs = d.prepare(`SELECT * FROM sync_log WHERE account_id = 'a1'`).all();
    eq(logs.length, 1);
    eq(logs[0].result, 'ok');
    eq(logs[0].new_works, 2);
    eq(logs[0].trigger, 'manual');
  });

  // ------------------------------------------------ 2. 增量
  section('2. 增量：第二次只处理变化的部分');

  d.prepare(`UPDATE accounts SET last_sync_at = '2026-10-23T10:00:00.000Z' WHERE id = 'a1'`).run();

  await check('同样两条作品不再重复新增', async () => {
    const rd2 = readerOf(
      baseRead({
        works: [
          { platWorkId: 'n1', title: '为什么电网要改造', publishedAt: '2026-10-20', reads: 2600, likes: 130, saves: 61, comments: 15 },
          { platWorkId: 'n2', title: '储能的三条路', publishedAt: '2026-10-10', reads: 950, likes: 52 }
        ]
      })
    );
    const r = await sync.syncAccount({
      database: d,
      account: getAccount(d),
      adapter: ADAPTER,
      reader: rd2,
      now: '2026-10-23T12:00:00.000Z',
      today: TODAY
    });
    eq(r.newWorks, 0, '不应新增；');
    eq(r.rescanned, 2, '两条都应算回扫；');
    eq(d.prepare(`SELECT COUNT(*) AS c FROM works`).get().c, 2);
  });

  await check('老作品指标追加成第二行，形成曲线', async () => {
    const rows = d
      .prepare(
        `SELECT m.reads FROM work_metrics m JOIN works w ON w.id = m.work_id
         WHERE w.plat_work_id = 'n1' ORDER BY m.captured_at`
      )
      .all();
    eq(rows.map((r) => r.reads), [2100, 2600]);
  });

  await check('出现新作品时只加那一条', async () => {
    const rd3 = readerOf(
      baseRead({
        works: [
          { platWorkId: 'n1', reads: 2700 },
          { platWorkId: 'n2', reads: 960 },
          { platWorkId: 'n3', title: '新发的一条', publishedAt: '2026-10-23', reads: 120 }
        ]
      })
    );
    const r = await sync.syncAccount({
      database: d,
      account: getAccount(d),
      adapter: ADAPTER,
      reader: rd3,
      now: '2026-10-23T18:00:00.000Z',
      today: TODAY
    });
    eq(r.newWorks, 1);
    eq(d.prepare(`SELECT COUNT(*) AS c FROM works`).get().c, 3);
  });

  // ------------------------------------------------ 3. 空值与全空
  section('3. 空值不覆盖 / 全空不写库');

  await check('这次没给粉丝数，沿用上次的值（不能写 null）', async () => {
    d.prepare(`UPDATE accounts SET last_sync_at = '2026-10-23T17:00:00.000Z' WHERE id = 'a1'`).run();
    const rd4 = readerOf(baseRead({ account: { followers: null, totalReads: null }, works: [] }));
    await sync.syncAccount({
      database: d,
      account: getAccount(d),
      adapter: ADAPTER,
      reader: rd4,
      now: '2026-10-23T19:00:00.000Z',
      today: TODAY
    });
    const s = d.prepare(`SELECT followers, total_reads FROM snapshots WHERE date = ?`).get(TODAY);
    eq(s.followers, 1200, '粉丝数应保持 1200；');
    eq(s.total_reads, 45000, '累计阅读应保持；');
  });

  await check('读到 0 就会把 0 记下来（0 是有效事实）', async () => {
    d.prepare(`UPDATE accounts SET last_sync_at = '2026-10-23T18:00:00.000Z' WHERE id = 'a1'`).run();
    const rd0 = readerOf(baseRead({ account: { followers: 0, totalReads: null }, works: [] }));
    await sync.syncAccount({
      database: d,
      account: getAccount(d),
      adapter: ADAPTER,
      reader: rd0,
      now: '2026-10-23T20:00:00.000Z',
      today: TODAY
    });
    const s = d.prepare(`SELECT followers FROM snapshots WHERE date = ?`).get(TODAY);
    eq(s.followers, 0, '0 应保留为 0；');
  });

  await check('整次读数全空：记 empty，不动任何数据', async () => {
    const before = d.prepare(`SELECT COUNT(*) AS c FROM work_metrics`).get().c;
    d.prepare(`UPDATE accounts SET last_sync_at = '2026-10-23T19:00:00.000Z' WHERE id = 'a1'`).run();
    const rdEmpty = readerOf({
      status: 'ok',
      pages: 1,
      account: {},
      works: [{ platWorkId: 'n1', title: 'x' }]
    });
    const r = await sync.syncAccount({
      database: d,
      account: getAccount(d),
      adapter: ADAPTER,
      reader: rdEmpty,
      now: '2026-10-23T21:00:00.000Z',
      today: TODAY
    });
    eq(r.result, 'empty');
    eq(d.prepare(`SELECT COUNT(*) AS c FROM work_metrics`).get().c, before, '指标行数不应变化；');
    const last = d
      .prepare(`SELECT result FROM sync_log WHERE account_id = 'a1' ORDER BY id DESC LIMIT 1`)
      .get();
    eq(last.result, 'empty');
  });

  await check('empty 不算故障，账号状态仍是 ok', async () => {
    eq(getAccount(d).status, 'ok');
  });

  // ------------------------------------------------ 4. 登录失效
  section('4. 登录失效与身份不符');

  await check('登录失效：标状态、不动数据', async () => {
    d.prepare(`UPDATE accounts SET last_sync_at = '2026-10-23T20:00:00.000Z' WHERE id = 'a1'`).run();
    const before = d.prepare(`SELECT COUNT(*) AS c FROM works`).get().c;
    const r = await sync.syncAccount({
      database: d,
      account: getAccount(d),
      adapter: ADAPTER,
      reader: readerOf({ status: 'login_expired', pages: 1, account: {}, works: [] }),
      now: '2026-10-23T22:00:00.000Z',
      today: TODAY
    });
    eq(r.result, 'failed');
    eq(r.reason, 'login_expired');
    eq(getAccount(d).status, 'login_expired');
    eq(d.prepare(`SELECT COUNT(*) AS c FROM works`).get().c, before, '作品数不应变化；');
  });

  await check('身份与记录不符：停止写入', async () => {
    d.prepare(`UPDATE accounts SET last_sync_at = '2026-10-23T21:00:00.000Z' WHERE id = 'a1'`).run();
    const r = await sync.syncAccount({
      database: d,
      account: getAccount(d),
      adapter: ADAPTER,
      reader: readerOf({ status: 'fingerprint_mismatch', pages: 1, account: { followers: 9 }, works: [] }),
      now: '2026-10-23T23:00:00.000Z',
      today: TODAY
    });
    eq(r.result, 'failed');
    eq(getAccount(d).status, 'fingerprint_mismatch');
  });

  d.close();

  // ------------------------------------------------ 5. 节流
  section('5. 节流');

  d = freshDb();
  // 这里有 last_ok_at：表示「读到过数据」，所以走平台正式间隔。
  // 从没成功读过的号是另一套规则（见下面那条），不能用同一个账号测。
  d.prepare(
    `UPDATE accounts SET last_sync_at = '2026-10-23T10:50:00.000Z', last_ok_at = '2026-10-23T09:00:00.000Z' WHERE id = 'a1'`
  ).run();

  await check('10 分钟内再点一次会被挡（防误触连点）', async () => {
    const r = await sync.syncAccount({
      database: d,
      account: getAccount(d),
      adapter: ADAPTER,
      reader: readerOf(baseRead()),
      now: '2026-10-23T11:00:00.000Z',
      today: TODAY
    });
    eq(r.result, 'throttled');
    ok(r.detail.includes('20'), `说明里应带上限：${r.detail}`);
  });

  await check('节流时不写任何数据、不记 ok 日志', async () => {
    eq(d.prepare(`SELECT COUNT(*) AS c FROM snapshots`).get().c, 0);
    eq(d.prepare(`SELECT COUNT(*) AS c FROM sync_log`).get().c, 0);
  });

  await check('过 20 分钟后手动更新放行', async () => {
    const r = await sync.syncAccount({
      database: d,
      account: getAccount(d),
      adapter: ADAPTER,
      reader: readerOf(baseRead()),
      now: '2026-10-23T11:15:00.000Z',
      today: TODAY
    });
    eq(r.result, 'ok');
  });

  await check('从没成功读过的号：只拦 1 分钟内连点，不按平台间隔拦', async () => {
    const d2 = freshDb();
    d2.prepare(
      `UPDATE accounts SET last_sync_at = '2026-10-23T10:50:00.000Z', last_ok_at = '' WHERE id = 'a1'`
    ).run();
    // 距上次 10 分钟，平台间隔是 20 分钟 —— 但上次是失败的空读，什么都没读到，
    // 让人再等 10 分钟才准看数据没有道理
    const r = await sync.syncAccount({
      database: d2,
      account: getAccount(d2),
      adapter: ADAPTER,
      reader: readerOf(baseRead()),
      now: '2026-10-23T11:00:00.000Z',
      today: TODAY
    });
    eq(r.result, 'ok', '首次读取不该被平台间隔挡；');
  });

  await check('从没成功读过的号：30 秒内连点仍然挡住（防手抖）', async () => {
    const d3 = freshDb();
    d3.prepare(
      `UPDATE accounts SET last_sync_at = '2026-10-23T10:59:40.000Z', last_ok_at = '' WHERE id = 'a1'`
    ).run();
    const r = await sync.syncAccount({
      database: d3,
      account: getAccount(d3),
      adapter: ADAPTER,
      reader: readerOf(baseRead()),
      now: '2026-10-23T11:00:00.000Z',
      today: TODAY
    });
    eq(r.result, 'throttled');
  });

  await check('手动更新不受 6 小时间隔限制', async () => {
    d.prepare(`UPDATE accounts SET last_sync_at = '2026-10-23T11:15:00.000Z' WHERE id = 'a1'`).run();
    const r = await sync.syncAccount({
      database: d,
      account: getAccount(d),
      adapter: ADAPTER,
      reader: readerOf(baseRead()),
      trigger: 'manual',
      now: '2026-10-23T11:40:00.000Z',
      today: TODAY
    });
    eq(r.result, 'ok', '手动不该被 6 小时挡；');
  });

  await check('自动更新受 sync_interval_h 限制', async () => {
    d.prepare(`UPDATE accounts SET last_sync_at = '2026-10-23T11:40:00.000Z' WHERE id = 'a1'`).run();
    const r = await sync.syncAccount({
      database: d,
      account: getAccount(d),
      adapter: ADAPTER,
      reader: readerOf(baseRead()),
      trigger: 'scheduled',
      now: '2026-10-23T15:00:00.000Z',
      today: TODAY
    });
    eq(r.result, 'throttled', '3 小时不到 6 小时，应挡；');
  });

  d.close();

  // ------------------------------------------------ 6. 原子性
  section('6. 写入原子性');

  d = freshDb();

  await check('写入中途失败会整体回滚，不留半截数据', async () => {
    const ghost = Object.assign({}, getAccount(d), { id: '不存在的账号' });
    ghost.id = 'ghost';
    const r = await sync.syncAccount({
      database: d,
      account: ghost,
      adapter: ADAPTER,
      reader: readerOf(baseRead()),
      now: NOW,
      today: TODAY
    });
    eq(r.result, 'failed');
    eq(d.prepare(`SELECT COUNT(*) AS c FROM snapshots`).get().c, 0, '快照不应残留；');
    eq(d.prepare(`SELECT COUNT(*) AS c FROM works`).get().c, 0, '作品不应残留；');
  });

  await check('回滚后仍留下失败日志（可查原因）', async () => {
    const log = d.prepare(`SELECT * FROM sync_log WHERE account_id = 'ghost'`).get();
    ok(log, '应有失败日志');
    eq(log.result, 'failed');
    ok(log.detail.includes('回滚'), `日志应说明回滚：${log.detail}`);
  });

  d.close();

  // ------------------------------------------------ 7. 分层回扫
  section('7. 分层回扫');

  await check('年龄分档正确', () => {
    eq(sync.rescanEvery(3), 1, '7 天内每次；');
    eq(sync.rescanEvery(15), 3, '8-30 天每 3 天；');
    eq(sync.rescanEvery(60), 14, '31-90 天每 14 天；');
    eq(sync.rescanEvery(120), null, '超过 90 天不再自动扫；');
    eq(sync.rescanEvery(NaN), 1, '不知道发布时间时保守处理；');
  });

  await check('只挑到期的，且越新的越优先', () => {
    const rows = [
      { id: 'w_new', published_at: '2026-10-21', last_scanned_at: '2026-10-22', gone: 0 },
      { id: 'w_mid', published_at: '2026-10-05', last_scanned_at: '2026-10-22', gone: 0 },
      { id: 'w_old', published_at: '2026-06-01', last_scanned_at: '2026-10-22', gone: 0 },
      { id: 'w_gone', published_at: '2026-10-22', last_scanned_at: '', gone: 1 }
    ];
    const picked = sync.pickRescanTargets(rows, TODAY, 10);
    const ids = picked.map((p) => p.row.id);
    ok(ids.includes('w_new'), '7 天内的应被挑中');
    ok(!ids.includes('w_mid'), '15 天前刚扫过（3 天档）不该再扫');
    ok(!ids.includes('w_old'), '4 个月前的不再自动扫');
    ok(!ids.includes('w_gone'), '已删除的不扫');
  });

  await check('达到上限会截断（控制单次成本）', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: `w${i}`,
      published_at: '2026-10-22',
      last_scanned_at: '',
      gone: 0
    }));
    eq(sync.pickRescanTargets(rows, TODAY, 40).length, 40);
  });

  await check('作品 id 由账号与平台 id 决定，稳定可复现', () => {
    const a = sync.workId('acc1', 'note_1');
    const b = sync.workId('acc1', 'note_1');
    const c = sync.workId('acc2', 'note_1');
    eq(a, b, '同输入应同输出；');
    ok(a !== c, '不同账号必须算出不同 id');
  });

  // ------------------------------------------------ 汇总
  section('汇总');
  if (failures.length === 0) {
    console.log(`\n全部通过：${pass} 项`);
    process.exit(0);
  } else {
    console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  · ${f.name}\n    ${f.message}`);
    process.exit(1);
  }
})();
