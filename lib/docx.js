'use strict';
/**
 * docx 写入器（零依赖）
 *
 * docx 也是一个 zip 包 XML。必需的部分：
 *   [Content_Types].xml
 *   _rels/.rels
 *   word/document.xml        正文
 *   word/styles.xml          样式（标题、正文、表格）
 *   word/_rels/document.xml.rels
 *
 * 为什么自己做而不是调 textutil 或 pandoc：
 *   textutil 只能出老式 .doc，而且只有 macOS 有；pandoc 要用户另装。
 *   报告要发给别人看，格式不能依赖接收方装了什么。
 *
 * 只支持报告需要的这几种块：标题、段落、列表、表格、分隔线、引用块。
 * 不做富文本编辑器 —— 那需要处理样式继承、编号、浮动对象，代价和收益不成比例。
 */

const { makeZip } = require('./zip');

function xesc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/**
 * 一段文字 → 一个 w:p。
 *
 * 支持极简的行内标记：`**粗**` 和 `` `代码` ``。
 * 为什么只支持这两个：报告里的强调只有「这个数很重要」和「这是个字段名」两种，
 * 再多就得写解析器，没必要。
 */
function para(text, opts = {}) {
  const style = opts.style ? `<w:pPr><w:pStyle w:val="${opts.style}"/></w:pPr>` : '';
  // mono 样式下整段不解析行内标记 —— 条形图里的字符不能被当成 Markdown
  if (opts.style === 'Mono') {
    return `<w:p>${style}<w:r><w:t xml:space="preserve">${xesc(text)}</w:t></w:r></w:p>`;
  }
  const align = opts.align ? `<w:pPr><w:jc w:val="${opts.align}"/></w:pPr>` : '';
  const pPr = opts.style ? style : align;

  const runs = [];
  const src = String(text == null ? '' : text);
  // 按 ** 和 ` 切成片段，交替处理，避免嵌套带来的复杂度
  const parts = src.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((x) => x !== '');
  for (const p of parts) {
    if (/^\*\*[^*]+\*\*$/.test(p)) {
      runs.push(`<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xesc(p.slice(2, -2))}</w:t></w:r>`);
    } else if (/^`[^`]+`$/.test(p)) {
      runs.push(
        `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:color w:val="2F5FD8"/></w:rPr>` +
          `<w:t xml:space="preserve">${xesc(p.slice(1, -1))}</w:t></w:r>`
      );
    } else {
      runs.push(`<w:r><w:t xml:space="preserve">${xesc(p)}</w:t></w:r>`);
    }
  }
  if (!runs.length) runs.push('<w:r><w:t/></w:r>');
  return `<w:p>${pPr}${runs.join('')}</w:p>`;
}

/** 表格。第一行当表头，加粗 + 底色 */
function table(rows, opts = {}) {
  const nCols = Math.max(...rows.map((r) => r.length), 1);
  // A4 正文宽约 9360 twips（扣除页边距），平均分
  const w = Math.floor(9360 / nCols);

  const grid = Array.from({ length: nCols }, () => `<w:gridCol w:w="${w}"/>`).join('');

  const body = rows
    .map((r, ri) => {
      const isHead = ri === 0;
      const cells = [];
      for (let i = 0; i < nCols; i++) {
        const v = r[i] == null ? '' : String(r[i]);
        const shade = isHead ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F4F8"/>' : '';
        const bold = isHead ? '<w:rPr><w:b/></w:rPr>' : '';
        cells.push(
          `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${shade}</w:tcPr>` +
            `<w:p><w:pPr><w:pStyle w:val="TableText"/></w:pPr>` +
            `<w:r>${bold}<w:t xml:space="preserve">${xesc(v)}</w:t></w:r></w:p></w:tc>`
        );
      }
      return `<w:tr>${cells.join('')}</w:tr>`;
    })
    .join('');

  return `<w:tbl>
<w:tblPr>
  <w:tblStyle w:val="ReportTable"/>
  <w:tblW w:w="9360" w:type="dxa"/>
  <w:tblBorders>
    <w:top w:val="single" w:sz="4" w:color="D8DCE4"/>
    <w:left w:val="single" w:sz="4" w:color="D8DCE4"/>
    <w:bottom w:val="single" w:sz="4" w:color="D8DCE4"/>
    <w:right w:val="single" w:sz="4" w:color="D8DCE4"/>
    <w:insideH w:val="single" w:sz="4" w:color="D8DCE4"/>
    <w:insideV w:val="single" w:sz="4" w:color="D8DCE4"/>
  </w:tblBorders>
</w:tblPr>
<w:tblGrid>${grid}</w:tblGrid>
${body}
</w:tbl>${para('')}`;
}

/** 项目符号列表 */
function bullets(items) {
  return items
    .map(
      (t) =>
        `<w:p><w:pPr><w:pStyle w:val="Bullet"/></w:pPr><w:r><w:t xml:space="preserve">• ${xesc(
          String(t).replace(/\*\*/g, '')
        )}</w:t></w:r></w:p>`
    )
    .join('');
}

/** 视觉分隔：一条细横线，用来切章节 */
function rule() {
  return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="D8DCE4"/></w:pBdr></w:pPr></w:p>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
  <w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:hAnsi="Microsoft YaHei"/>
  <w:sz w:val="21"/><w:szCs w:val="21"/>
</w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>
  <w:pPr><w:spacing w:before="0" w:after="240"/></w:pPr>
  <w:rPr><w:b/><w:sz w:val="44"/><w:color w:val="14161B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
  <w:pPr><w:spacing w:before="360" w:after="120"/><w:keepNext/></w:pPr>
  <w:rPr><w:b/><w:sz w:val="30"/><w:color w:val="14161B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>
  <w:pPr><w:spacing w:before="240" w:after="100"/><w:keepNext/></w:pPr>
  <w:rPr><w:b/><w:sz w:val="24"/><w:color w:val="2F3A4A"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/>
  <w:pPr><w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="2F5FD8"/></w:pBdr></w:pPr>
  <w:rPr><w:color w:val="4B5058"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Bullet"><w:name w:val="Bullet"/>
  <w:pPr><w:ind w:left="360" w:hanging="240"/><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Mono"><w:name w:val="Mono"/>
  <w:pPr><w:spacing w:before="20" w:after="20" w:line="250" w:lineRule="auto"/></w:pPr>
  <w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/><w:sz w:val="17"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Num"><w:name w:val="Num Item"/>
  <w:pPr><w:spacing w:before="40" w:after="40"/><w:ind w:left="240" w:hanging="240"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/>
  <w:pPr><w:spacing w:before="40" w:after="40" w:line="240" w:lineRule="auto"/></w:pPr>
  <w:rPr><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="ReportTable"><w:name w:val="Report Table"/>
  <w:tblPr><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/>
  <w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

/**
 * 生成 docx。
 * @param {object} o
 * @param {Array<string>} o.blocks 已经拼好的 wordprocessingml 片段，或
 * @param {Array<{type:string, ...}>} o.items 结构化块
 */
function makeDocx(o = {}) {
  let bodyXml = '';
  if (Array.isArray(o.blocks)) {
    bodyXml = o.blocks.join('');
  } else {
    for (const it of o.items || []) {
      switch (it.type) {
        case 'title':
          bodyXml += para(it.text, { style: 'Title' });
          break;
        case 'h1':
          bodyXml += para(it.text, { style: 'Heading1' });
          break;
        case 'h2':
          bodyXml += para(it.text, { style: 'Heading2' });
          break;
        case 'p':
          bodyXml += para(it.text);
          break;
        case 'quote':
          bodyXml += para(it.text, { style: 'Quote' });
          break;
        case 'bullets':
          bodyXml += bullets(it.items || []);
          break;
        case 'bullet':
          // 单条项目符号：按平台分段时结论要一条一条排，用这个免去自己包数组
          bodyXml += bullets([it.text]);
          break;
        case 'table':
          bodyXml += table(it.rows || []);
          break;
        case 'rule':
          bodyXml += rule();
          break;
        case 'mono':
          // 等宽段落：文本条形图靠它对齐
          bodyXml += para(it.text, { style: 'Mono' });
          break;
        case 'pagebreak':
          bodyXml += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
          break;
        default:
          if (it.text) bodyXml += para(it.text);
      }
    }
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${bodyXml}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/>
</w:sectPr>
</w:body>
</w:document>`;

  return makeZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
    },
    { name: 'word/styles.xml', data: STYLES_XML },
    { name: 'word/document.xml', data: document }
  ]);
}

module.exports = { makeDocx, xesc };
