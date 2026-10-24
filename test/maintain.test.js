'use strict';
/**
 * 数据库日常维护自测
 * 跑：npm test
 *
 * 这里守的是「清理不会误伤」：日志该清的清掉，快照和作品指标一条都不许动。
 * 后者是这工具的立身之本 —— 把历史数据当垃圾清掉，比不做维护糟得多。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../lib/db');

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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-maint-'));
let seq = 0;

/**
 * 每个用例一个独立库。
 * 共用一个库会让上一个用例的数据留到下一个（比如那条 3 天前的日志），
 * 断言就会莫名其妙地对不上 —— 这种失败最费时间。
 */
function fresh() {
  const file = path.join(TMP, `db-${++seq}.db`);
  const d = db.open(file);
  db.migrate(d, { dbPath: file, backupDir: path.join(TMP, 'backup') });
  return d;
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

function addLog(d, startedAt) {
  d.prepare(
    `INSERT INTO sync_log (account_id, started_at, result) VALUES (?, ?, 'ok')`
  ).run('acc_test-1_abcdef', startedAt);
}

function count(d, sql) {
  return d.prepare(sql).get().n;
}

(async () => {
  section('1. 清旧日志');
  await check('半年前的日志被清掉，近期的留着', () => {
    const d = fresh();
    addLog(d, daysAgo(400));
    addLog(d, daysAgo(200));
    addLog(d, daysAgo(3));
    eq(count(d, 'SELECT COUNT(*) n FROM sync_log'), 3, '初始应有 3 条：');

    const r = db.maintain(d);
    eq(r.deleted, 2, '应清掉 2 条（400 天和 200 天前）：');
    eq(count(d, 'SELECT COUNT(*) n FROM sync_log'), 1, '只剩 1 条：');
    d.close();
  });

  await check('再跑一次不会重复清（幂等）', () => {
    const d = fresh();
    addLog(d, daysAgo(3));
    const r = db.maintain(d);
    eq(r.deleted, 0, '没有可清的：');
    d.close();
  });

  await check('keepLogDays 可调', () => {
    const d = fresh();
    addLog(d, daysAgo(40));
    const r = db.maintain(d, { keepLogDays: 30 });
    eq(r.deleted, 1, '按 30 天保留，40 天前的该清掉：');
    d.close();
  });

  section('2. 不许误伤历史');
  await check('快照和作品指标一条不动', () => {
    const d = fresh();
    d.prepare(
      `INSERT INTO accounts (id, plat, partition, status, created_at)
       VALUES ('acc_test-1_abcdef', 'xhs', 'persist:acct-test-1', 'ok', ?)`
    ).run(daysAgo(500));
    d.prepare(
      `INSERT INTO snapshots (account_id, date, followers, captured_at)
       VALUES ('acc_test-1_abcdef', '2025-01-01', 100, ?)`
    ).run(daysAgo(500));
    addLog(d, daysAgo(500));

    const before = {
      snap: count(d, 'SELECT COUNT(*) n FROM snapshots'),
      acc: count(d, 'SELECT COUNT(*) n FROM accounts')
    };
    db.maintain(d);
    eq(count(d, 'SELECT COUNT(*) n FROM snapshots'), before.snap, '快照：');
    eq(count(d, 'SELECT COUNT(*) n FROM accounts'), before.acc, '账号：');
    eq(count(d, 'SELECT COUNT(*) n FROM sync_log'), 0, '日志：');
    d.close();
  });

  section('3. 边界');
  await check('空表也能跑（首次启动就是这种状态）', () => {
    const d = fresh();
    const r = db.maintain(d);
    eq(r.deleted, 0, '空表：');
    ok(typeof r.vacuumed === 'boolean', 'vacuumed 应是布尔值');
    d.close();
  });

  await check('返回值字段齐全', () => {
    const d = fresh();
    const r = db.maintain(d);
    for (const k of ['deleted', 'vacuumed', 'freedBytes', 'freeRatio', 'keepLogDays']) {
      ok(k in r, `缺字段 ${k}`);
    }
    eq(r.keepLogDays, 180, '默认保留天数：');
    d.close();
  });

  await check('forceVacuum 不抛异常', () => {
    const d = fresh();
    addLog(d, daysAgo(400));
    const r = db.maintain(d, { forceVacuum: true });
    ok(r.vacuumed === true, '强制整理应该真的执行了');
    d.close();
  });

  section('汇总');
  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures.length === 0) {
    console.log(`\n全部通过：${pass} 项`);
    process.exit(0);
  } else {
    console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  · ${f.name}\n    ${f.message}`);
    process.exit(1);
  }
})();
