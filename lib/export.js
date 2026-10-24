'use strict';
/**
 * 导出
 *
 * 只做一件事：把一个号的数据导成别人打得开的文件。
 *
 * 为什么 CSV 要带 BOM：不带的话 Excel 打开是乱码。这不是可选项 ——
 * 用户导出就是为了用 Excel 看，打开乱码等于导出失败。
 *
 * 为什么不导出 Excel（xlsx）：要引第三方库，为了一个文件引入几十 MB 依赖不值得。
 * CSV 能被 Excel、Numbers、WPS、Google Sheets 全部直接打开。
 */

const fs = require('node:fs');
const path = require('node:path');

const CSV_BOM = '\ufeff';

/** CSV 单元格转义：含逗号、引号、换行就整体加引号，内部引号翻倍 */
function cell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function row(cells) {
  return cells.map(cell).join(',');
}

/** 文件名里不能有的字符，换掉而不是删掉（删了会两截粘一起看不懂） */
function safeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\n\r\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 作品指标列。顺序固定，不随平台变 —— 列一会儿有一会儿没有，Excel 里没法对比 */
const WORK_COLS = [
  ['reads', '阅读/播放'],
  ['likes', '点赞'],
  ['saves', '收藏'],
  ['comments', '评论'],
  ['shares', '分享'],
  ['completion', '完播率%'],
  ['new_followers', '涨粉']
];

function loadAccount(db, accountId) {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!acc) throw new Error('这个号不在库里');
  return acc;
}

function loadWorks(db, accountId) {
  return db
    .prepare(
      `SELECT w.plat_work_id, w.title, w.published_at, w.excerpt, w.last_scanned_at,
              m.reads, m.likes, m.saves, m.comments, m.shares, m.completion,
              m.new_followers, m.extra, m.captured_at
         FROM works w
         LEFT JOIN work_metrics m
           ON m.work_id = w.id
          AND m.captured_at = (SELECT MAX(captured_at) FROM work_metrics WHERE work_id = w.id)
        WHERE w.account_id = ? AND w.gone = 0
        ORDER BY w.published_at DESC, w.first_seen_at DESC`
    )
    .all(accountId);
}

function loadSnapshots(db, accountId) {
  return db.prepare('SELECT * FROM snapshots WHERE account_id = ? ORDER BY date ASC').all(accountId);
}

/**
 * 导出成文件。
 * @param {object} db        已打开的库
 * @param {string} accountId
 * @param {string} format    csv | json
 * @param {string} outDir    导出目录
 * @returns {string} 文件路径
 */
function exportAccount(db, accountId, format = 'csv', outDir) {
  const acc = loadAccount(db, accountId);
  const works = loadWorks(db, accountId);
  const snaps = loadSnapshots(db, accountId);

  fs.mkdirSync(outDir, { recursive: true });
  const name = safeName(`${acc.plat}-${acc.nickname || acc.handle || acc.id}`);

  if (format === 'json') {
    const file = path.join(outDir, `${name}-${stamp()}.json`);
    const payload = {
      exportedAt: new Date().toISOString(),
      account: {
        plat: acc.plat,
        nickname: acc.nickname,
        handle: acc.handle,
        uid: acc.uid,
        createdAt: acc.created_at,
        lastOkAt: acc.last_ok_at
      },
      snapshots: snaps,
      works
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
  }

  // ---------------- CSV：一张表，作品明细 + 账号列
  const head = [
    '平台',
    '账号昵称',
    '账号ID',
    '作品ID',
    '标题',
    '发布日期',
    ...WORK_COLS.map(([, label]) => label),
    '平台独有指标',
    '最近采集时间'
  ];

  const lines = [row(head)];
  for (const w of works) {
    let extra = '';
    try {
      const e = w.extra ? JSON.parse(w.extra) : {};
      extra = Object.entries(e)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
    } catch {
      extra = '';
    }
    lines.push(
      row([
        acc.plat,
        acc.nickname,
        acc.handle || acc.uid,
        w.plat_work_id,
        w.title,
        w.published_at,
        ...WORK_COLS.map(([k]) => (w[k] === null || w[k] === undefined ? '' : w[k])),
        extra,
        w.captured_at || ''
      ])
    );
  }

  // 账号级指标单独放一个文件：混在同一张表里，行长不一致，Excel 会错位
  const file = path.join(outDir, `${name}-作品-${stamp()}.csv`);
  fs.writeFileSync(file, CSV_BOM + lines.join('\r\n') + '\r\n', 'utf8');

  if (snaps.length) {
    const accHead = ['日期', '粉丝', '总阅读', '总点赞', '作品数', '采集时间'];
    const accLines = [row(accHead)];
    for (const s of snaps) {
      accLines.push(row([s.date, s.followers, s.total_reads, s.total_likes, s.works_total, s.captured_at]));
    }
    fs.writeFileSync(
      path.join(outDir, `${name}-账号趋势-${stamp()}.csv`),
      CSV_BOM + accLines.join('\r\n') + '\r\n',
      'utf8'
    );
  }

  return file;
}

module.exports = { exportAccount, cell, row, safeName, CSV_BOM, WORK_COLS };
