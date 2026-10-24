'use strict';
/**
 * 诊断包：把各平台的诊断记录打成一个 zip，方便贴给维护者看
 *
 * 关键点不是打包，是**脱敏**。
 * 诊断文件里存的是平台页面原文 —— 它是唯一能说清「为什么读不到」的东西，
 * 但同一份原文里也躺着昵称、handle、头像地址、本机路径、甚至 Cookie 片段。
 * 直接发出去等于把自己的号连 cookie 一起公开。
 *
 * 三条防线，缺一不可（前两条都是实测踩出来的）：
 *   1. **按值**替换：数据库里有哪些昵称 / handle / uid，就把它们从文本里抹掉。
 *      只按字段名判断是不够的 —— 平台把身份塞在 title（"拉布拉卡 (@ruixue258) / X"）
 *      和 url（"https://www.tiktok.com/@hanruixue3"）里，一个字段名规则永远追不上。
 *   2. 页面标题整体隐去：标题几乎总是「昵称 (@handle) - 平台」，而它对排查的价值很低。
 *   3. 剩下的 @handle、绝对路径、邮箱、超长串（令牌 / cookie）按形状兜底。
 *
 * 脱敏在本机完成，包打出来就是干净的 —— 不存在「先上传再处理」这一步。
 */

const fs = require('node:fs');
const path = require('node:path');
const { makeZip } = require('./zip');

/** 这些字段的值一律整段替换（保留长度，长度对排查仍有意义） */
const SENSITIVE_KEYS = /^(nickname|nickName|handle|userName|uniqueId|secUid|uid|sec_uid|avatar|avatarUrl|avatarLarger|signature|author|owner|email|phone|mobile|title|pageTitle)$/i;

/**
 * 按库里的真实身份做字面替换。
 * 长的先替换 —— 否则「ruixue258」会先被「ruixue」啃掉一半，留下散落的碎片。
 */
function makeScrubber(identities) {
  const words = [...new Set((identities || []).filter((s) => typeof s === 'string'))]
    // 太短的字面替换会把正常文字也啃掉，2 字以内的昵称交给字段名规则兜底
    .filter((s) => s.trim().length >= 3)
    .sort((a, b) => b.length - a.length);
  return (str) => {
    let out = str;
    for (const w of words) out = out.split(w).join('<已隐藏>');
    return out;
  };
}

/** 形状兜底：路径 / 邮箱 / @handle / 超长串 */
function scrubShapes(s) {
  return s
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, '/<home>')
    .replace(/[A-Za-z]:\\+Users\\+[^\\\s"']+/g, 'C:\\Users\\<user>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g, '<email>')
    // @handle：文本里、URL 路径里都是这个形状
    .replace(/@[A-Za-z0-9_.-]{2,}/g, '@<已隐藏>')
    // 32 位以上字母数字串：令牌、cookie 值、会话 id
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, (m) => `<${m.length}位串>`);
}

function makeScrub(identities) {
  const byValue = makeScrubber(identities);

  return function scrub(value, key) {
    if (value == null) return value;
    if (typeof value === 'string') {
      if (SENSITIVE_KEYS.test(key || '')) {
        return value ? `<已隐藏 · ${value.length} 字>` : value;
      }
      return scrubShapes(byValue(value));
    }
    if (Array.isArray(value)) return value.map((v) => scrub(v, key));
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k);
      return out;
    }
    return value;
  };
}

/**
 * @param {object} opts
 * @param {string} opts.diagDir    诊断文件目录
 * @param {string} opts.outPath    输出 zip 路径
 * @param {object} opts.env        { version, platform, arch, electron, chrome, node }
 * @param {string[]} [opts.identities] 库里已知的昵称 / handle / uid，按值抹掉
 * @param {string} [opts.note]     用户填的一句话
 */
function build({ diagDir, outPath, env = {}, identities = [], note = '' }) {
  const scrub = makeScrub(identities);
  const files = [];
  let count = 0;

  if (fs.existsSync(diagDir)) {
    for (const name of fs.readdirSync(diagDir).sort()) {
      if (!name.endsWith('.json')) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(diagDir, name), 'utf8'));
      } catch {
        // 坏文件也留着，但它本身就是线索
        files.push({ name: `diag/${name}.broken`, data: '这个文件不是合法 JSON' });
        continue;
      }
      files.push({
        name: `diag/${name}`,
        data: JSON.stringify(scrub(parsed, ''), null, 2)
      });
      count++;
    }
  }

  const lines = [
    '账号监控 · 诊断包',
    '',
    `生成时间  ${new Date().toISOString()}`,
    `应用版本  ${env.version || '?'}`,
    `系统      ${env.platform || process.platform} ${env.arch || process.arch}`,
    `Electron  ${env.electron || '?'}`,
    `Chromium  ${env.chrome || '?'}`,
    `Node      ${env.node || '?'}`,
    '',
    `诊断文件  ${count} 个`,
    '',
    '说明：',
    `  库里 ${identities.length} 个身份词（昵称 / handle / uid）已按值替换成「<已隐藏>」。`,
    '  页面标题、头像、uid 等字段整段隐去（保留字数）。',
    '  本机路径、邮箱、@handle、32 位以上的长串（令牌 / cookie）都替换过。',
    '  其余字段和返回值形状原样保留 —— 排查要看的就是这个。',
    '',
    note ? `用户留言：${scrubShapes(String(note)).slice(0, 300)}` : ''
  ];

  files.unshift({ name: 'README.txt', data: lines.join('\n') });

  const buf = makeZip(files);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);

  return { file: outPath, count, size: buf.length };
}

module.exports = { build, makeScrub, scrubShapes };
