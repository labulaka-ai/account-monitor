'use strict';
/**
 * 读数判定自测 · 驱动**真实** reader + 真实 sync（不打桩）
 *
 * 为什么单独一个文件：
 *   sync.test.js 里的读数器是假的（readerOf），只验了 sync 这一半；
 *   reader 自己算 `complete` 的那段（每一页读到的 >= 每一页自报的）一直是空白区。
 *   而这条判据一旦判错，后果是「作品静默消失」—— 所以必须把
 *   「平台报多少 / 实际读到多少 / 中途有没有出错」的组合全排一遍。
 *
 * 跑：npm test
 */

const db = require('../lib/db');
const sync = require('../lib/sync');
const { makeReader } = require('../lib/reader');
const { makeRegistry } = require('../lib/adapters');

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
const PLAT = '抖音'; // 单页采集器：没有页间抖动，测试不会等
const registry = makeRegistry();

/** 库里先有 8 条旧作品，全部是「昨天看到的」 */
function freshDb() {
  const d = db.open(':memory:');
  db.migrate(d, { dbPath: ':memory:' });
  d.prepare(`INSERT INTO accounts (id, plat, uid, nickname, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    'a1',
    PLAT,
    'dy_001',
    '测试号',
    NOW
  );
  const ins = d.prepare(
    `INSERT INTO works (id, account_id, plat_work_id, title, published_at, first_seen_at, last_seen_at)
     VALUES (?, 'a1', ?, ?, ?, ?, ?)`
  );
  const ids = [];
  for (let i = 0; i < 8; i++) {
    ins.run(`w${i}`, `n${i}`, `旧作品 ${i}`, '2026-10-20', '2026-09-01T00:00:00.000Z', '2026-10-22T00:00:00.000Z');
    ids.push(`n${i}`);
  }
  return { d, ids };
}

/** 造一页的返回。字段名照采集器真实输出的那一套。 */
function pageOf(c) {
  const works = [];
  for (let i = 0; i < c.read; i++) {
    works.push({ platWorkId: `n${i}`, title: `作品 ${i}`, publishedAt: '2026-10-20', reads: 100 + i });
  }
  const r = {
    platform: 'douyin',
    login: true,
    // 真实空号也有粉丝数（只是 0 篇作品）。这里不给的话整条读数会被当「空读」丢掉，
    // 后面的断言就变成假通过。
    account: { followers: c.followers === undefined ? 32000 : c.followers },
    identity: { nickname: '测试号' },
    works
  };
  if (c.reported !== null) r.worksTotal = c.reported;
  if (c.truncated) r.truncated = true;
  return { jsonUrls: [], title: 't', loadErr: '', evalResult: r };
}

/** 跑一轮：真 reader 读数 → 真 sync 落库 → 把关心的结果拿出来 */
async function round(c) {
  let n = 0;
  const capture = async () => {
    n++;
    if (c.failPage && n === 1) throw new Error('模拟页面打不开');
    return pageOf(c);
  };
  const reader = makeReader({ capture, getAdapter: (p) => registry.get(p) });
  const { d } = freshDb();
  const acc = d.prepare(`SELECT * FROM accounts WHERE id = 'a1'`).get();
  const read = await reader.readAccount(acc, { ses: {} });
  await sync.syncAccount({
    database: d,
    account: acc,
    adapter: { paceMin: 20 },
    reader: { readAccount: async () => read },
    now: NOW,
    today: TODAY
  });
  const snap =
    d.prepare(`SELECT works_total, followers FROM snapshots WHERE account_id = 'a1'`).get() || {};
  return {
    read,
    snap,
    gone: d.prepare(`SELECT COUNT(*) AS c FROM works WHERE account_id='a1' AND gone=1`).get().c,
    alive: d.prepare(`SELECT COUNT(*) AS c FROM works WHERE account_id='a1' AND gone=0`).get().c,
    metrics: d.prepare(`SELECT COUNT(*) AS c FROM work_metrics`).get().c
  };
}

(async () => {
  // ------------------------------------------------ 一、原本工作正常的路，不能被改坏
  section('一、读全了：删除判定仍然是有效的');

  await check('平台报 8、读到 8：判读全，且一条都不误删', async () => {
    const r = await round({ reported: 8, read: 8 });
    eq(r.read.complete, true, '全读时应判「读全了」；');
    eq(r.read.worksTotal, 8, '总数应是平台报的 8；');
    eq(r.gone, 0, '没有谁消失，不该标删；');
    eq(r.alive, 8, '8 条都要还在；');
    eq(r.snap.works_total, 8, '快照作品数应写 8；');
  });

  await check('平台报 5、读到 5：作者真删了 3 条 → 必须标删 3 条', async () => {
    const r = await round({ reported: 5, read: 5 });
    eq(r.read.complete, true, '全读时应判「读全了」；');
    eq(r.gone, 3, '读全了才敢判删，且只删没出现的 3 条；');
    eq(r.alive, 5, '这次读到的 5 条必须还在；');
  });

  await check('平台报 0、读到 0：空号 → 旧的 8 条应判删，且快照写 0', async () => {
    const r = await round({ reported: 0, read: 0 });
    eq(r.read.complete, true, '平台明说 0 条，「空」本身就是结论；');
    eq(r.gone, 8, '这个号确实清空了，8 条都该标删；');
    eq(r.snap.works_total, 0, '快照应写 0（0 是事实，不是未知）；');
  });

  // ------------------------------------------------ 二、读不全的路，一条都不许删
  section('二、没读全：宁可不判，也不许误删');

  await check('平台报 100、只读到 8：不判读全，不删', async () => {
    const r = await round({ reported: 100, read: 8 });
    eq(r.read.complete, false, '读到的远少于自报，不能判读全；');
    eq(r.gone, 0, '没读全就不许标删；');
    eq(r.alive, 8, '原有 8 条原样留着；');
    eq(r.snap.works_total, 100, '展示用总数取平台报的 100；');
  });

  await check('平台不报总数、读到 8：不判读全，不删，但数字照样显示', async () => {
    const r = await round({ reported: null, read: 8 });
    eq(r.read.complete, false, '没有自报值 = 不知道，不知道就不判；');
    eq(r.read.worksTotalKnown, false, '要如实标出「这个总数不是平台说的」；');
    eq(r.read.worksTotal, 8, '展示值仍兜到读到条数，界面不会变成「—」；');
    eq(r.gone, 0, '不许标删；');
    eq(r.snap.works_total, 8, '快照仍写 8（不能因为「未知」就留空）；');
  });

  await check('平台不报总数、只读到 3：数字退到 3，但不删', async () => {
    const r = await round({ reported: null, read: 3 });
    eq(r.read.complete, false, '不能判读全；');
    eq(r.read.worksTotal, 3, '展示值只能报读到的 3；');
    eq(r.gone, 0, '另外 5 条只是没翻到，不是被删了；');
    eq(r.alive, 8, '库里 8 条都该还在；');
  });

  await check('采集器说「没翻完」时，即使条数对得上也不判删', async () => {
    const r = await round({ reported: 8, read: 8, truncated: true });
    eq(r.read.complete, false, 'truncated 一票否决；');
    eq(r.gone, 0, '不许标删；');
  });

  await check('平台报 0 但读到 8（自相矛盾）：不判删', async () => {
    const r = await round({ reported: 0, read: 8 });
    eq(r.gone, 0, '两边打架时按「拿不准」处理，不删；');
    eq(r.alive, 8, '8 条都要在；');
  });

  await check('整页打不开：整体失败，不写库、不删', async () => {
    let threw = false;
    try {
      await round({ reported: 8, read: 8, failPage: true });
    } catch (err) {
      threw = true;
      ok(/页面打不开/.test(err.message), '错误信息要能说清是页面打不开；');
    }
    ok(threw, '一页都没打开时应整体失败，而不是带着空数据继续写库；');
  });

  // ------------------------------------------------ 三、账号数字：空串 ≠ 0
  section('三、账号数字：没读到不能当成 0');

  await check('粉丝字段是空串 → 不写成 0（否则界面上是一次假掉粉）', async () => {
    const r = await round({ reported: 8, read: 8, followers: '' });
    eq(r.snap.followers, null, '空串应留空，等下次读到；');
  });

  await check('粉丝确实是 0 → 写 0（0 是事实）', async () => {
    const r = await round({ reported: 8, read: 8, followers: 0 });
    eq(r.snap.followers, 0, '平台明确给 0 时就要写 0；');
  });

  await check('这次读数真的落库了（防止上面的断言假通过）', async () => {
    const r = await round({ reported: 8, read: 8 });
    eq(r.read.status, 'ok', '读数状态应是 ok；');
    eq(r.metrics, 8, '8 条作品的指标应已写入；');
  });

  // ------------------------------------------------ 三、时间预算
  section('三、时间预算：一轮最多花多久');

  /**
   * `maxDurationMs` 以前从 sync 一路传下来，reader 里**没有任何地方读它** ——
   * 等于没有预算，一个作品多的号会把采集器的翻页循环跑到底。
   * 「慢」本身就是风控特征，所以这里把预算接上，并用测试钉死：
   * 预算用完 = 不开新页面 = 标 truncated = 不判读全 = 一条不删。
   */
  await check('不给预算时，多页采集器照旧把页面读完', async () => {
    let opened = 0;
    const capture = async () => {
      opened++;
      return pageOf({ reported: 8, read: 8 });
    };
    const reader = makeReader({ capture, getAdapter: () => registry.get('小红书') });
    const read = await reader.readAccount({ id: 'a1', plat: '小红书' }, { ses: {} });
    eq(opened, 2, '两个页面都要打开；');
    eq(read.complete, true, '每页都对得上就该判读全；');
  });

  await check('预算用完就不再开页面：标「没读全」，且一条都不删', async () => {
    let opened = 0;
    const capture = async () => {
      opened++;
      return pageOf({ reported: 8, read: 8 });
    };
    const reader = makeReader({ capture, getAdapter: () => registry.get('小红书') });
    const { d } = freshDb();
    const acc = d.prepare(`SELECT * FROM accounts WHERE id = 'a1'`).get();
    const read = await reader.readAccount(Object.assign({}, acc, { plat: '小红书' }), {
      ses: {},
      maxDurationMs: 100
    });
    eq(opened, 1, '第一页之后预算就没了，后面的页面不该再打开；');
    eq(read.truncated, true, '要明说「这轮没翻完」；');
    eq(read.complete, false, '没翻完绝不能判读全；');

    await sync.syncAccount({
      database: d,
      account: acc,
      adapter: { paceMin: 20 },
      reader: { readAccount: async () => read },
      now: NOW,
      today: TODAY
    });
    eq(
      d.prepare(`SELECT COUNT(*) AS c FROM works WHERE account_id='a1' AND gone=1`).get().c,
      0,
      '预算用完只是「没读全」，不许删作品；'
    );
  });

  // ------------------------------------------------ 汇总
  section('汇总');
  console.log(`  通过 ${pass} 项`);
  if (failures.length) {
    console.log(`  失败 ${failures.length} 项`);
    process.exitCode = 1;
  } else {
    console.log('  全部通过');
  }
})();
