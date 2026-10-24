'use strict';
/**
 * Threads · 页面内取数脚本
 *
 * 这些函数会被 toString() 成字符串注入到平台页面里执行（见 lib/reader.js 的 scriptOf），
 * 所以铁律：**函数体不能引用文件外的东西**，连本文件里别的 const 也不行。
 * 需要小工具就写在函数体里面 —— test/scripts.test.js 会盯着这条。
 */

/**
 * Threads 走页面自己的 GraphQL：签名在页面里，我们不复刻。
 *
 * 这个平台有个跟微博一样的坑：首页 `/` 给的是「你的信息流」，里面全是别人的帖子。
 * 所以分两步：
 *   第一页 `/`            —— 只为了拿到「这是哪个号」（左侧导航里指向自己的链接）
 *   第二页 `/@<handle>`   —— 只读这一页，且只认 user.username === handle 的帖子
 */
const threadsHandle = async function () {
  const out = { platform: 'threads' };
  const text = (document.body && document.body.innerText) || '';
  if (/使用 Instagram 账号登录|Log in with Instagram|登录 Threads/i.test(text.slice(0, 400))) {
    out.login = false;
    return out;
  }
  /**
   * 找自己的 handle。
   *
   * 2026-10-24 实测：原来找「带头像 img 的 /@xxx 链接」是错的 ——
   * 导航里那个「主页」按钮的文本是「主页」，里面**没有 img**；
   * 而推荐位里的帖子反而带头像。按 img 找会挑到别人的账号。
   *
   * 现在按「链接文字就是『主页』/ Profile」来认，这是最直接的语义。
   * 中文界面是「主页」、英文是「Profile」，两种都认。
   */
  let handle = '';
  for (const a of Array.from(document.querySelectorAll('a[href^="/@"]'))) {
    const m = /^\/@([A-Za-z0-9._]{1,30})/.exec(String(a.getAttribute('href') || ''));
    if (!m) continue;
    const label = String(a.textContent || a.innerText || '').trim();
    if (/^(主页|個人檔案|Profile)$/i.test(label)) {
      handle = m[1];
      break;
    }
  }
  // 退路：aria-label 里写「主页」的那种（有些版本文字在 aria 里）
  if (!handle) {
    for (const a of Array.from(document.querySelectorAll('a[href^="/@"]'))) {
      const m = /^\/@([A-Za-z0-9._]{1,30})/.exec(String(a.getAttribute('href') || ''));
      if (!m) continue;
      if (/主页|Profile/i.test(String(a.getAttribute('aria-label') || ''))) {
        handle = m[1];
        break;
      }
    }
  }
  if (!handle) {
    out.login = true;
    out.note = '登录态在，但左侧导航没渲染出来，找不到自己的账号名';
    return out;
  }
  out.login = true;
  out.ctx = { handle };
  out.identity = { nickname: '', handle, uid: '', avatar: '' };
  return out;
};

const threadsProfile = async function () {
  const out = { platform: 'threads' };
  const text = (document.body && document.body.innerText) || '';
  if (/使用 Instagram 账号登录|Log in with Instagram/i.test(text.slice(0, 400))) {
    out.login = false;
    return out;
  }
  const handle = String((location.pathname || '').split('/')[1] || '').replace(/^@/, '').toLowerCase();
  const me = handle;

  /**
   * Threads 的帖子**不在 GraphQL 响应里**。
   *
   * 2026-10-24 实测（@示例账号 主页）：把全部 /api/graphql 和 /graphql/query
   * 响应翻遍，找不到任何 `code` + `user.username` 的帖子节点 ——
   * 那 4 条帖子的内容只渲染在 DOM 里（服务端直出）。
   * 之前靠 GraphQL 找，结果永远读到 0 条，而页面上明明有 4 条。
   *
   * 所以改用 DOM，并且**按页面顺序对齐三个数组**：
   *   codes  —— a[href*="/post/"] 的出现顺序（每条帖子一个短码）
   *   times  —— <time datetime> 的出现顺序（ISO 时间，最可靠）
   *   lines  —— innerText 拆行后，「自己 handle / 时间文字 / 正文」三行一组
   *
   * 实测三者严格一一对应：
   *   codes = [DeuTIHemt4f, DerEFSgG0i6, Dehar1hmjL6, DeTbPeEG-TD]
   *   times = [2026-10-20, 2026-10-19, 2026-10-15, 2026-10-10]
   *   行    = [3天/发型, 4天/接单, 10-16/想下海, 10-10/股票]
   *
   * 注意：资料区（昵称、简介）也会出现自己的 handle，所以要用
   * 「下一行像不像时间」来过滤掉它们。
   */
  const codes = [];
  {
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/post/"]')) {
      const m = /\/post\/([A-Za-z0-9_-]+)/.exec(String(a.getAttribute('href') || ''));
      if (!m || seen.has(m[1])) continue;
      // 只认本人的帖子（别人的推荐帖也是 /@someone/post/xxx）
      const owner = (/^\/@([A-Za-z0-9._]+)\//.exec(String(a.getAttribute('href') || '')) || [])[1];
      if (owner && me && owner.toLowerCase() !== me) continue;
      seen.add(m[1]);
      codes.push(m[1]);
    }
  }

  const times = [...document.querySelectorAll('time')]
    .map((t) => String(t.getAttribute('datetime') || ''))
    .filter(Boolean);

  // 「时间文字」长什么样：3天 / 4小时 / 昨天 / 2026-10-16 / 3周
  const looksLikeTime = (s) =>
    /^(?:\d+\s*(?:秒|分钟|小时|天|周|个月|年)|昨天|前天|\d{4}-\d{2}-\d{2}|\d+\s*(?:s|m|h|d|w))$/i.test(
      String(s || '').trim()
    );

  // 按「自己 handle / 时间 / 正文」三行一组扫描整页
  const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
  const groups = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase() !== me) continue;
    const t = lines[i + 1] || '';
    if (!looksLikeTime(t)) continue; // 资料区的昵称/简介会被这一条挡掉
    groups.push({ timeText: t, body: String(lines[i + 2] || '').trim() });
  }

  /**
   * 把三组数据拼起来。
   * 数量可能不一致（虚拟列表、滚动位置不同），所以按最小长度对齐，
   * 并且**只信前 N 条** —— 宁可少一条，也不要把 A 的时间配到 B 的正文上。
   */
  const n = Math.min(codes.length, groups.length);
  const works = [];
  for (let i = 0; i < n; i++) {
    const code = codes[i];
    const g = groups[i];
    // 时间优先用 <time datetime>（精确），没有才退回页面上的相对文字
    const iso = times[i] || '';
    let publishedAt = '';
    if (/^\d{4}-\d{2}-\d{2}T/.test(iso)) {
      publishedAt = iso.slice(0, 10);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(g.timeText)) {
      publishedAt = g.timeText;
    }
    works.push({
      platWorkId: code,
      title: g.body.slice(0, 300),
      publishedAt,
      // Threads 个人主页不显示单条浏览量（只有专业账号才有 insights），留 null 不填 0
      reads: null,
      likes: null,
      comments: null,
      shares: null,
      saves: null,
      extra: { kind: 'post' }
    });
  }

  // 粉丝：页面上「N 位粉丝」/「N followers」，只在本人主页读
  const fol = /([\d.,]+\s*[KMB万]?)\s*(?:位粉丝|粉丝|followers?)/i.exec(text);
  const numOf = (s) => {
    if (!s) return null;
    const m = /([\d,.]+)\s*([KMB万]?)/i.exec(s);
    if (!m) return null;
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(v)) return null;
    const un = (m[2] || '').toUpperCase();
    const mul = un === 'K' ? 1e3 : un === 'M' ? 1e6 : un === 'B' ? 1e9 : un === '万' ? 1e4 : 1;
    return Math.round(v * mul);
  };

  /**
   * 昵称。
   *
   * 2026-10-24 实测页面文字顺序是：
   *   …导航… / 在这里查找你的提示音设置 / 示例handle / 示例昵称 / 示例handle / 简介 / 签名
   * 所以「handle 上一行」拿到的是导航文案「在这里查找你的提示音设置」，
   * 这就是之前昵称显示成那句话的原因。
   *
   * 可靠顺序：
   *   1. og:title —— `示例昵称（@示例handle）• Threads，畅所欲言`，取括号前那段
   *   2. h2 —— 页面上显示的显示名（h1 是 handle）
   *   3. handle 的**下一行**（顺序是 handle/昵称/handle/简介）
   */
  let nickname = '';
  {
    const og = document.querySelector('meta[property="og:title"]');
    if (og) {
      const t = String(og.getAttribute('content') || '');
      const m = /^(.+?)\s*[（(]\s*@/.exec(t);
      if (m && m[1].trim() && m[1].trim().toLowerCase() !== me) nickname = m[1].trim();
    }
    if (!nickname) {
      const h2 = document.querySelector('h2');
      const t = h2 ? String(h2.innerText || '').trim() : '';
      if (t && t.length <= 40 && t.toLowerCase() !== me && !looksLikeTime(t)) nickname = t;
    }
    if (!nickname) {
      const at = lines.findIndex((l) => l.toLowerCase() === me);
      const cand = at >= 0 ? lines[at + 1] || '' : '';
      if (cand && cand.length <= 40 && cand.toLowerCase() !== me && !looksLikeTime(cand)) {
        nickname = cand;
      }
    }
  }

  out.login = true;
  out.identity = { nickname, handle, uid: '', avatar: '' };
  out.account = { followers: fol ? numOf(fol[1]) : null };
  /**
   * 作品总数：页面上没有一个「共 N 条」的数字，只能报「这次读到几条」。
   * 由于拿不到平台口径，**必须标 truncated**，
   * 否则下次少读到一条就会被判成「已删除」。
   */
  out.worksTotal = works.length;
  out.works = works;
  out.truncated = true;
  return out;
};

module.exports = {
  key: 'threads',
  name: 'Threads',
  pages: [
    // 第一页只为拿 handle（左侧导航指向自己的链接），第二页才读帖子
    { url: 'https://www.threads.com/', fn: threadsHandle },
    {
      url: (ctx) => `https://www.threads.com/@${encodeURIComponent(ctx.handle || '')}`,
      fn: threadsProfile,
      when: (ctx) => !!ctx.handle
    }
  ]
};
