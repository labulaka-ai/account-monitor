'use strict';
/**
 * 导出与报告的落盘
 *
 * 这里只做「把已经算好的东西写成文件」，算的部分在：
 *   lib/export.js  数据导出（csv / xlsx / json）
 *   lib/report.js  报告内容（md / docx / html）
 *
 * PDF 是唯一需要浏览器的地方，所以放到主进程用 printToPDF ——
 * 中文、字体、分页都由 Chromium 负责，比自己拼 PDF 可靠得多。
 * （自己写 PDF 要嵌中文字体，光字体子集化就能写几百行，还容易缺字。）
 */

const fs = require('node:fs');
const path = require('node:path');
const { makeXlsx } = require('./xlsx');
const { cell, row, safeName, CSV_BOM, WORK_COLS } = require('./export');

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

// ---------------------------------------------------------------- 数据取

function loadAccount(db, accountId) {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!acc) throw new Error('这个号不在库里');
  return acc;
}

/** 作品 + 最新指标。按发布日期倒序 */
function loadWorks(db, accountId) {
  return db
    .prepare(
      `SELECT w.plat_work_id, w.title, w.published_at, w.excerpt, w.last_scanned_at,
              m.reads, m.likes, m.saves, m.comments, m.shares, m.completion,
              m.new_followers, m.extra, m.captured_at
         FROM works w
         LEFT JOIN work_metrics m ON m.work_id = w.id
          AND m.captured_at = (SELECT MAX(captured_at) FROM work_metrics WHERE work_id = w.id)
        WHERE w.account_id = ? AND w.gone = 0
        ORDER BY w.published_at DESC, w.first_seen_at DESC`
    )
    .all(accountId);
}

function loadSnapshots(db, accountId) {
  return db.prepare('SELECT * FROM snapshots WHERE account_id = ? ORDER BY date ASC').all(accountId);
}

function parseExtra(s) {
  if (!s) return {};
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/** 类型的显示名。导出给别人看的时候，`reply` 不如「回复」清楚 */
const TYPE_LABELS = { original: '原创', reply: '回复', repost: '转发', quote: '引用' };

// ---------------------------------------------------------------- 数据导出

/**
 * 导出成一个文件。
 *
 * @param {object} db
 * @param {object} o
 * @param {string[]} o.accountIds  要导哪些号（空 = 全部）
 * @param {string[]} [o.plats]     只要这几个平台（空 = 全部）
 * @param {'xlsx'|'json'|'csv'} o.format
 * @param {'week'|'month'|'year'|'all'|''} [o.range] 按发布日期筛
 * @param {string} o.outDir
 * @returns {{file:string, files:string[], rows:number, accounts:number}}
 */
function exportData(db, o) {
  const ids = Array.isArray(o.accountIds) && o.accountIds.length ? o.accountIds : null;
  let accs = db.prepare('SELECT * FROM accounts ORDER BY plat, created_at').all();
  if (ids) {
    const want = new Set(ids);
    accs = accs.filter((a) => want.has(a.id));
  }
  // 按平台筛：给平台负责人发数据时，别把他不管的几个号一起塞过去
  const plats = Array.isArray(o.plats) && o.plats.length ? new Set(o.plats) : null;
  if (plats) accs = accs.filter((a) => plats.has(a.plat));
  if (!accs.length) throw new Error('没有可导出的账号');

  // 时间范围（按发布日期）。不传就是全部
  let from = '';
  let to = '';
  if (o.range) {
    // 这里不 require report.js 免得循环依赖，直接用同样规则算
    const now = new Date();
    if (o.range === 'week') {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dow = (d.getDay() + 6) % 7;
      const s = new Date(d);
      s.setDate(d.getDate() - dow);
      const e = new Date(s);
      e.setDate(s.getDate() + 6);
      from = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
      to = `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}`;
    } else if (o.range === 'month') {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      const e = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      from = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
      to = `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}`;
    } else if (o.range === 'year') {
      from = `${now.getFullYear()}-01-01`;
      to = `${now.getFullYear()}-12-31`;
    }
  }
  const inRange = (d) => {
    if (!from) return true;
    if (!d) return false;
    return d >= from && d <= to;
  };

  const bundles = accs.map((a) => {
    const works = loadWorks(db, a.id).filter((w) => inRange(w.published_at));
    return { acc: a, works, snaps: loadSnapshots(db, a.id) };
  });

  fs.mkdirSync(o.outDir, { recursive: true });
  const tag = o.range && o.range !== 'all' ? `-${o.range}` : '';
  const uniqPlats = [...new Set(bundles.map((b) => b.acc.plat))];
  const base =
    bundles.length === 1
      ? safeName(`${bundles[0].acc.plat}-${bundles[0].acc.nickname || bundles[0].acc.handle || '账号'}`)
      : uniqPlats.length === 1
        ? safeName(`${uniqPlats[0]}-全部号`)   // 单平台多号：文件名标平台，别写成「全部账号」
        : '全部账号';
  const totalRows = bundles.reduce((n, b) => n + b.works.length, 0);

  // ---------------- JSON
  if (o.format === 'json') {
    const file = path.join(o.outDir, `${base}-数据${tag}-${stamp()}.json`);
    const payload = {
      exportedAt: new Date().toISOString(),
      range: from ? { from, to } : null,
      note: 'null 表示平台没有给出这个数，不是 0',
      accounts: bundles.map((b) => {
        const s = b.snaps[b.snaps.length - 1] || null;
        return {
          plat: b.acc.plat,
          nickname: b.acc.nickname,
          handle: b.acc.handle,
          uid: b.acc.uid,
          status: b.acc.status,
          note: b.acc.note || '',
          createdAt: b.acc.created_at,
          lastOkAt: b.acc.last_ok_at,
          latestSnapshot: s,
          worksCount: b.works.length,
          snasphots: undefined,
          snapshots: b.snaps,
          works: b.works.map((w) => {
            const ex = parseExtra(w.extra);
            return {
              id: w.plat_work_id,
              title: w.title,
              publishedAt: w.published_at,
              type: TYPE_LABELS[ex.type] || '',
              reads: w.reads,
              likes: w.likes,
              saves: w.saves,
              comments: w.comments,
              shares: w.shares,
              completion: w.completion,
              newFollowers: w.new_followers,
              quotes: ex.quotes == null ? null : ex.quotes,
              bookmarks: ex.bookmarks == null ? null : ex.bookmarks,
              coins: ex.coins == null ? null : ex.coins,
              danmaku: ex.danmaku == null ? null : ex.danmaku,
              recommend: ex.recommend == null ? null : ex.recommend,
              capturedAt: w.captured_at
            };
          })
        };
      })
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return { file, files: [file], rows: totalRows, accounts: bundles.length };
  }

  // ---------------- CSV（多号时按账号分文件，Excel 里不容易混）
  if (o.format === 'csv') {
    const head = [
      '平台',
      '账号昵称',
      '账号ID',
      '作品ID',
      '标题',
      '类型',
      '发布日期',
      ...WORK_COLS.map(([, label]) => label),
      '引用',
      '投币',
      '弹幕',
      '平台独有指标',
      '最近采集'
    ];
    const written = [];
    for (const b of bundles) {
      const lines = [row(head)];
      for (const w of b.works) {
        const ex = parseExtra(w.extra);
        const other = Object.entries(ex)
          .filter(([k]) => !['type', 'quotes', 'bookmarks', 'coins', 'danmaku', 'recommend'].includes(k))
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
        lines.push(
          row([
            b.acc.plat,
            b.acc.nickname,
            b.acc.handle || b.acc.uid,
            w.plat_work_id,
            w.title,
            TYPE_LABELS[ex.type] || '',
            w.published_at,
            ...WORK_COLS.map(([k]) => (w[k] == null ? '' : w[k])),
            ex.quotes == null ? '' : ex.quotes,
            ex.coins == null ? '' : ex.coins,
            ex.danmaku == null ? '' : ex.danmaku,
            other,
            w.captured_at || ''
          ])
        );
      }
      const name = safeName(`${b.acc.plat}-${b.acc.nickname || b.acc.handle || b.acc.id}`);
      const f = path.join(o.outDir, `${name}-作品${tag}-${stamp()}.csv`);
      // BOM 不能省：不带的话 Excel 打开中文是乱码
      fs.writeFileSync(f, CSV_BOM + lines.join('\r\n') + '\r\n', 'utf8');
      written.push(f);
    }
    return { file: written[0], files: written, rows: totalRows, accounts: bundles.length };
  }

  // ---------------- XLSX
  /**
   * 三张表：
   *   1. 总览   一个号一行，横向对比用
   *   2. 作品   全部作品，带平台和账号两列，可以透视
   *   3. 每日   账号级快照，画趋势用
   *
   * 为什么分表而不是一张大表：总览的行长和作品完全不同，
   * 硬塞进一张表 Excel 会错位，而且没法排序。
   */
  const summaryRows = [
    ['平台', '账号', '账号ID', '粉丝', '作品数', '阅读', '点赞', '评论', '分享', '收藏', '互动率%', '最近采集', '备注']
  ];
  const workRows = [
    ['平台', '账号', '作品ID', '标题', '类型', '发布日期', '阅读', '点赞', '收藏', '评论', '分享', '完播率%', '引用', '投币', '弹幕', '平台独有指标', '最近采集']
  ];
  const dailyRows = [['日期', '平台', '账号', '粉丝', '总阅读', '总点赞', '作品数']];

  for (const b of bundles) {
    const s = b.snaps[b.snaps.length - 1] || {};
    const sum = (k) => {
      const v = b.works.map((w) => Number(w[k])).filter((x) => Number.isFinite(x));
      return v.length ? v.reduce((a, c) => a + c, 0) : null;
    };
    const inter = (() => {
      let rd = 0;
      let it = 0;
      for (const w of b.works) {
        const r = Number(w.reads);
        if (!Number.isFinite(r) || r <= 0) continue;
        rd += r;
        it += (Number(w.likes) || 0) + (Number(w.comments) || 0) + (Number(w.shares) || 0) + (Number(w.saves) || 0);
      }
      return rd ? Math.round((it / rd) * 1000) / 10 : null;
    })();

    summaryRows.push([
      b.acc.plat,
      b.acc.nickname || '',
      b.acc.handle || b.acc.uid || '',
      s.followers == null ? null : Number(s.followers),
      b.works.length,
      sum('reads'),
      sum('likes'),
      sum('comments'),
      sum('shares'),
      sum('saves'),
      inter,
      s.captured_at || '',
      b.acc.note || ''
    ]);

    for (const w of b.works) {
      const ex = parseExtra(w.extra);
      const other = Object.entries(ex)
        .filter(([k]) => !['type', 'quotes', 'bookmarks', 'coins', 'danmaku', 'recommend'].includes(k))
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      workRows.push([
        b.acc.plat,
        b.acc.nickname || '',
        w.plat_work_id,
        w.title || '',
        TYPE_LABELS[ex.type] || '',
        w.published_at || '',
        w.reads == null ? null : Number(w.reads),
        w.likes == null ? null : Number(w.likes),
        w.saves == null ? null : Number(w.saves),
        w.comments == null ? null : Number(w.comments),
        w.shares == null ? null : Number(w.shares),
        w.completion == null ? null : Number(w.completion),
        ex.quotes == null ? null : Number(ex.quotes),
        ex.coins == null ? null : Number(ex.coins),
        ex.danmaku == null ? null : Number(ex.danmaku),
        other,
        w.captured_at || ''
      ]);
    }

    for (const sn of b.snaps) {
      dailyRows.push([
        sn.date,
        b.acc.plat,
        b.acc.nickname || '',
        sn.followers == null ? null : Number(sn.followers),
        sn.total_reads == null ? null : Number(sn.total_reads),
        sn.total_likes == null ? null : Number(sn.total_likes),
        sn.works_total == null ? null : Number(sn.works_total)
      ]);
    }
  }

  const buf = makeXlsx([
    { name: '总览', rows: summaryRows },
    { name: '作品', rows: workRows },
    { name: '每日趋势', rows: dailyRows }
  ]);

  const file = path.join(o.outDir, `${base}-数据${tag}-${stamp()}.xlsx`);
  fs.writeFileSync(file, buf);
  return { file, files: [file], rows: totalRows, accounts: bundles.length };
}

// ---------------------------------------------------------------- 报告落盘

/**
 * 写报告文件。
 * @param {'md'|'docx'|'pdf'|'html'} format
 * @param {() => Promise<Buffer>} [pdfPrinter] 只有 pdf 需要
 */
async function writeReport(report, format, outDir, o = {}) {
  const report2 = require('./report');
  fs.mkdirSync(outDir, { recursive: true });
  const kindLabel = { week: '周报', month: '月报', year: '年报', all: '全量报告' }[report.period.kind] || '报告';
  /**
   * 文件名里带上平台范围。
   *
   * 单平台导出如果还叫「账号运营-月报」，存三个文件到同一个目录
   * 就完全分不出谁是谁 —— 早晚会拿错发给别人。
   */
  const sc = Array.isArray(report.scoped) && report.scoped.length ? report.scoped : null;
  const scopeTag = sc ? `-${sc.join('+')}` : '';
  const base = safeName(`账号运营-${kindLabel}${scopeTag}-${report.period.from || '全部'}`);
  const name = `${base}-${stamp()}`;

  if (format === 'md') {
    const file = path.join(outDir, `${name}.md`);
    fs.writeFileSync(file, report2.toMarkdown(report), 'utf8');
    return { file };
  }
  if (format === 'docx') {
    const file = path.join(outDir, `${name}.docx`);
    fs.writeFileSync(file, report2.toDocx(report));
    return { file };
  }
  if (format === 'html') {
    const file = path.join(outDir, `${name}.html`);
    fs.writeFileSync(file, report2.toHtml(report), 'utf8');
    return { file };
  }
  if (format === 'pdf') {
    if (typeof o.pdfPrinter !== 'function') throw new Error('PDF 需要在应用内生成');
    const html = report2.toHtml(report);
    const buf = await o.pdfPrinter(html);
    const file = path.join(outDir, `${name}.pdf`);
    fs.writeFileSync(file, buf);
    return { file };
  }
  throw new Error(`不支持的格式：${format}`);
}

module.exports = { exportData, writeReport, loadWorks, TYPE_LABELS };
