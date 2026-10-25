'use strict';
/**
 * xlsx 写入器（零依赖）
 *
 * 做法：一个 xlsx 本质是 zip 里放几个固定的 XML。这里只生成它必需的最小集合：
 *   [Content_Types].xml
 *   _rels/.rels
 *   xl/workbook.xml
 *   xl/_rels/workbook.xml.rels
 *   xl/styles.xml
 *   xl/worksheets/sheet1.xml ...
 *
 * 几个关键决定：
 *   · 文本一律用 **inlineStr**，不建 sharedStrings 表。
 *     少一个文件、少一层引用，出错面小很多。代价是文件略大 —— 这点代价换简单值得。
 *   · **数字写成真数字**，不写成文本。用户导出就是为了在 Excel 里排序、求和，
 *     都变成文本的话 SUM 出来是 0，等于白导。
 *   · 列宽按内容估，不设固定值 —— 中文标题很长，固定 8 字符会把表挤成一堆 ####。
 *   · 表头冻结 + 加粗，行多的时候看得清。
 */

const { makeZip } = require('./zip');

/** XML 转义。& 必须第一个换，否则会把后面换出来的 &amp; 再换一次 */
function xesc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // 控制字符会让 Excel 直接报「文件损坏」，直接删掉
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** 0 → A, 25 → Z, 26 → AA */
function colName(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * 显示宽度：中文/全角算 2，其余算 1。
 * 用来定列宽 —— 按字符数算的话中文列总是窄一半，标题全被 ### 盖掉。
 */
function dispWidth(v) {
  const s = String(v == null ? '' : v);
  let w = 0;
  for (const ch of s) {
    w += /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(
      ch
    )
      ? 2
      : 1;
  }
  return w;
}

/**
 * 一个单元格。
 * @param {*} v 值
 * @param {number} styleIdx 样式索引（0 默认，1 表头加粗，2 数字，3 日期，4 百分比）
 */
function cellXml(v, styleIdx, ref) {
  const st = styleIdx ? ` s="${styleIdx}"` : '';
  if (v === null || v === undefined || v === '') return `<c r="${ref}"${st}/>`;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return `<c r="${ref}"${st}><v>${v}</v></c>`;
  }
  if (typeof v === 'boolean') return `<c r="${ref}"${st} t="b"><v>${v ? 1 : 0}</v></c>`;
  // 文本一律 inlineStr：不依赖 sharedStrings，少一层出错的可能
  return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xesc(v)}</t></is></c>`;
}

/**
 * 生成一个 sheet 的 XML。
 * @param {Array<Array<*>>} rows 第一行当表头
 * @param {object} opts freeze 是否冻结首行
 */
function sheetXml(rows, opts = {}) {
  /**
   * 列数用循环求，不用 Math.max(...rows.map(...))。
   *
   * spread 展开的实参个数受引擎栈限制（V8 大约 6 万多个）。
   * 导出「全部作品」时行数可以上万，一旦超过这个数不是返回错值，
   * 而是直接 RangeError: Maximum call stack size exceeded —— 整个导出失败。
   */
  let nCols = 1;
  for (const r of rows) {
    if (Array.isArray(r) && r.length > nCols) nCols = r.length;
  }

  // 列宽：取该列所有值的最大显示宽度，夹在 8~60 之间
  const widths = [];
  for (let c = 0; c < nCols; c++) {
    let w = 8;
    for (const r of rows) {
      const dw = dispWidth(r[c]);
      if (dw > w) w = dw;
    }
    widths.push(Math.min(60, w + 2));
  }

  const cols = widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('');

  const body = rows
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = colName(ci) + (ri + 1);
          // 表头用样式 1（加粗），数据行按类型给样式
          if (ri === 0) return cellXml(v, 1, ref);
          return cellXml(v, 0, ref);
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');

  // 冻结首行：表再长，往下翻也能看见列名
  const pane = opts.freeze === false
    ? ''
    : '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView${opts.tabSelected ? ' tabSelected="1"' : ''} workbookViewId="0">${pane}</sheetView></sheetViews>
<cols>${cols}</cols>
<sheetData>${body}</sheetData>
</worksheet>`;
}

/** 样式表：0 默认 / 1 表头加粗 / 2 数字千分位 / 3 百分比 */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
  <numFmt numFmtId="164" formatCode="#,##0"/>
  <numFmt numFmtId="165" formatCode="0.0&quot;%&quot;"/>
</numFmts>
<fonts count="2">
  <font><sz val="11"/><name val="Microsoft YaHei"/></font>
  <font><b/><sz val="11"/><name val="Microsoft YaHei"/></font>
</fonts>
<fills count="2">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
</fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * 生成 xlsx。
 * @param {Array<{name:string, rows:Array<Array<*>>}>} sheets
 * @returns {Buffer}
 */
function makeXlsx(sheets) {
  const list = (sheets || []).filter((s) => s && s.rows && s.rows.length);
  if (!list.length) throw new Error('没有内容可以导出');

  /**
   * 工作表名有硬限制，超了 Excel 直接报文件损坏：
   *   · 最长 31 字符
   *   · 不能含 : \ / ? * [ ]
   *   · 不能重名
   */
  const used = new Set();
  const safeSheets = list.map((s, i) => {
    let n = String(s.name || `Sheet${i + 1}`)
      .replace(/[:\\/?*[\]]/g, '_')
      .slice(0, 31);
    if (!n) n = `Sheet${i + 1}`;
    let base = n;
    let k = 2;
    while (used.has(n)) {
      const suffix = `_${k++}`;
      n = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(n);
    return { name: n, rows: s.rows };
  });

  const files = [];

  files.push({
    name: '[Content_Types].xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${safeSheets
  .map(
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )
  .join('\n')}
</Types>`
  });

  files.push({
    name: '_rels/.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  });

  files.push({
    name: 'xl/workbook.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${safeSheets
  .map((s, i) => `<sheet name="${xesc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
  .join('\n')}
</sheets>
</workbook>`
  });

  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${safeSheets
  .map(
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  )
  .join('\n')}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
  });

  files.push({ name: 'xl/styles.xml', data: STYLES_XML });

  safeSheets.forEach((s, i) => {
    files.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: sheetXml(s.rows, { tabSelected: i === 0 })
    });
  });

  return makeZip(files);
}

module.exports = { makeXlsx, xesc, colName, dispWidth };
