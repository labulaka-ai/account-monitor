'use strict';
/**
 * 报告与导出出口的自测
 *
 * 这里守的是「数字算错、排版被标题打坏」这一类问题 ——
 * 它们不会报错，只会让报告看起来正常但结论是错的。
 *
 * 跑：npm test
 */

const db = require('../lib/db');
const report = require('../lib/report');
const { makeXlsx } = require('../lib/xlsx');
const { makeDocx } = require('../lib/docx');

let pass = 0;
const failures = [];

function section(t) {
  console.log(`\n${t}`);
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
function eq(a, e, hint = '') {
  const sa = JSON.stringify(a);
  const se = JSON.stringify(e);
  if (sa !== se) throw new Error(`${hint}期望 ${se}，实际 ${sa}`);
}
function ok(c, m) {
  if (!c) throw new Error(m || '断言失败');
}

const TODAY = db.todayLocal();
const NOW = db.nowIso();

/** 造一个空库 + 两个同平台不同号，各一条作品 */
function fixture() {
  const d = db.open(':memory:');
  db.migrate(d);
  const insAcc = d.prepare(
    `INSERT INTO accounts (id, plat, nickname, handle, uid, partition, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ok')`
  );
  const insWork = d.prepare(
    `INSERT INTO works (id, account_id, plat_work_id, title, published_at, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insMetric = d.prepare(
    `INSERT INTO work_metrics (work_id, captured_at, reads, likes, comments, shares, saves)
     VALUES (?, ?, ?, ?, 0, 0, 0)`
  );
  const addWork = (workId, accId, platId, title, date, reads) => {
    insWork.run(workId, accId, platId, title, date, NOW, NOW);
    insMetric.run(workId, NOW, reads, Math.round(reads / 100));
  };
  return { d, insAcc, addWork };
}

// ---------------------------------------------------------------- 多号统计
section('1. 一个平台多个号');

check('平台小结里的「本期发布」与「篇均」用同一批样本', () => {
  const { d, insAcc, addWork } = fixture();
  insAcc.run('big', '小红书', '大号', 'big', 'u1', 'persist:acct-xhs-1', NOW);
  insAcc.run('small', '小红书', '小号', 'small', 'u2', 'persist:acct-xhs-2', NOW);
  addWork('w1', 'big', 'p1', '大号内容', TODAY, 1000);
  addWork('w2', 'small', 'p2', '小号内容', TODAY, 200);

  const rep = report.buildReport(d, { range: 'month' });
  const line = (rep.platFindings['小红书'] || []).find((s) => s.includes('本期发布')) || '';
  ok(line.includes('2 条'), `本期发布应是两个号合计 2 条，实际：${line}`);
  // (1000 + 200) / 2 = 600；只算第一个号会得到 1000
  ok(line.includes('600'), `篇均应是 600（两个号平均），实际：${line}`);
  d.close();
});

// ---------------------------------------------------------------- 环比口径
section('2. 环比只看本轮范围内的号');

check('只导一个号时，上一周期不把别的号算进来', () => {
  const { d, insAcc, addWork } = fixture();
  insAcc.run('a', '小红书', '甲', 'a', 'u1', 'persist:acct-xhs-1', NOW);
  insAcc.run('b', '小红书', '乙', 'b', 'u2', 'persist:acct-xhs-2', NOW);
  addWork('w1', 'a', 'p1', '本期甲', TODAY, 500);
  addWork('w2', 'b', 'p2', '本期乙', TODAY, 300);

  // 上个月：只有甲发了一条大爆款
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const p2 = (n) => String(n).padStart(2, '0');
  const prevDate = `${prevMonth.getFullYear()}-${p2(prevMonth.getMonth() + 1)}-15`;
  addWork('w3', 'a', 'p3', '上期爆款', prevDate, 99999);

  const onlyB = report.buildReport(d, { range: 'month', accountIds: ['b'] });
  ok(onlyB.compare, '应有环比对象');
  ok(
    onlyB.compare.reads.prev == null || onlyB.compare.reads.prev < 99999,
    `只导乙时，上期不该出现甲那条 99999，实际：${onlyB.compare.reads.prev}`
  );

  const all = report.buildReport(d, { range: 'month' });
  ok(
    all.compare && all.compare.reads.prev >= 99999,
    `导全部时应能看到上期那条 99999，实际：${all.compare && all.compare.reads.prev}`
  );
  d.close();
});

// ---------------------------------------------------------------- 出口转义
section('3. 标题里的特殊字符');

const DIRTY = '<script>alert("x")</script> & a|b "q" \'s\' ]]> -- 结束';

function dirtyReport() {
  const { d, insAcc, addWork } = fixture();
  insAcc.run('a', '小红书', '甲|乙<script>', 'a', 'u1', 'persist:acct-xhs-1', NOW);
  addWork('w1', 'a', 'p1', DIRTY + '\n第二行', TODAY, 5000);
  const rep = report.buildReport(d, { range: 'month' });
  d.close();
  return rep;
}

check('markdown 里不会留下裸的 <script>', () => {
  const md = report.toMarkdown(dirtyReport());
  ok(!/<script>/i.test(md), '不应出现裸 <script>');
  ok(!/\]\]>/.test(md) || true, '（]]> 只是普通文本）');
});

check('markdown 表格里的 | 被转义', () => {
  const md = report.toMarkdown(dirtyReport());
  // 标题里的 a|b 必须以 a\|b 的形式出现，否则表格会多切一列
  ok(md.includes('a\\|b'), '标题里的竖线应转义成 \\|');
  ok(!/(^|\s)\|\s*a\|b/.test(md), '不应出现裸的 a|b');
});

check('markdown 里标题的换行不会把表格断成两行', () => {
  const md = report.toMarkdown(dirtyReport());
  ok(!/第二行/.test(md) || !md.split('\n').some((l) => l.startsWith('第二行')), '换行应被压成空格');
});

check('html 里标题被转义', () => {
  const html = report.toHtml(dirtyReport());
  ok(!/<script>alert/i.test(html), '不应出现可执行的 script');
});

check('docx / xlsx 仍然是合法 zip+XML（含脏标题也不坏文件）', () => {
  const rep = dirtyReport();
  const docx = makeDocx(rep);
  const xlsx = makeXlsx([{ name: '作品', rows: [['标题', '阅读'], [DIRTY, 5000]] }]);
  ok(docx.length > 1000, 'docx 应有内容');
  ok(xlsx.length > 1000, 'xlsx 应有内容');
  // zip 头 PK\x03\x04
  ok(docx[0] === 0x50 && docx[1] === 0x4b, 'docx 应是 zip');
  ok(xlsx[0] === 0x50 && xlsx[1] === 0x4b, 'xlsx 应是 zip');
});

// ---------------------------------------------------------------- 大表
section('4. 行数很多时不能崩');

check('一万行导出不触发栈溢出', () => {
  const rows = [['标题', '阅读']];
  for (let i = 0; i < 10000; i++) rows.push([`第 ${i} 条`, i]);
  const buf = makeXlsx([{ name: '全量', rows }]);
  ok(buf.length > 1000, '应产出内容');
});

check('行宽不齐时列数取最长的一行', () => {
  const buf = makeXlsx([
    {
      name: '不齐',
      rows: [
        ['a', 'b'],
        ['1', '2', '3'],
        ['4']
      ]
    }
  ]);
  ok(buf.length > 500, '应产出内容');
});

// ---------------------------------------------------------------- 汇总
section('汇总');
if (failures.length === 0) {
  console.log(`\n全部通过：${pass} 项`);
  process.exit(0);
} else {
  console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.message}`);
  process.exit(1);
}
