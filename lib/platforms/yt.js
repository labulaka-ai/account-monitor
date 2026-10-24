'use strict';
/**
 * YouTube · 页面内取数脚本
 *
 * 这些函数会被 toString() 成字符串注入到平台页面里执行（见 lib/reader.js 的 scriptOf），
 * 所以铁律：**函数体不能引用文件外的东西**，连本文件里别的 const 也不行。
 * 需要小工具就写在函数体里面 —— test/scripts.test.js 会盯着这条。
 */

/**
 * Google 账号登着、但名下没有频道时，YouTube 侧一个数字都不会有。
 * 这不是读取失败，页面会明说「创建频道」—— 照实返回，别让界面去猜。
 */
/**
 * YouTube：读**工作室后台**，不是 youtube.com 首页。
 *
 * 2026-10-24 实测结论：
 *   · `youtube.com/feed/you` 那页什么都读不到（它是「你」的推荐页，没有数据面板），
 *     原来采集器打那页，所以永远只有一句「没有可读的数字」。
 *   · `studio.youtube.com` 才是真后台，页面直出这些数：
 *       频道信息中心 → 当前订阅人数 / 过去 28 天观看次数 / 观看时长
 *       最新 Shorts 表现 → 每条的前 N 分钟观看、平均观看百分比、赞
 *   · 频道 ID 在地址里：studio.youtube.com/channel/UCxxxx，稳定，直接当 uid。
 *
 * 没频道时（`创建频道`）单独报事实，不是故障。
 */
const youtube = async function () {
  const out = { platform: 'yt' };
  const text = (document.body && document.body.innerText) || '';
  const cfg = window.ytcfg && window.ytcfg.data_ ? window.ytcfg.data_ : {};

  // 登录判定：studio 里 LOGGED_IN 可靠；也认「我的频道」这个只有登录后才有的入口
  const loggedIn = !!cfg.LOGGED_IN || /我的频道|Your channel/.test(text);
  if (!loggedIn) {
    out.login = false;
    return out;
  }

  /**
   * 频道 ID：从地址 /channel/UCxxxx 取。
   * 这是 YouTube 的稳定主键（改频道名也不变），比昵称可靠。
   */
  const cid = (/\/channel\/(UC[A-Za-z0-9_-]{20,})/.exec(String(location.pathname || '')) || [])[1] || '';

  /**
   * 有没有频道，用 **CHANNEL_ID 是否为空** 来判断，不用页面上有没有「创建频道」四个字。
   *
   * 为什么换：实测这个号明明有频道（@示例账号，1 条视频），
   * 旧逻辑却因为页面别处出现过「创建频道」（引导浮层之类）就判定「没频道」，
   * 把已有的数据处理成了 note。CHANNEL_ID 由 YouTube 自己给，有就是有。
   */
  if (!cid) {
    out.login = true;
    out.noChannel = true;
    out.note = '这个 Google 账号还没有 YouTube 频道';
    out.works = [];
    out.worksTotal = 0;
    return out;
  }

  /**
   * 数字解析。
   * studio 里的数字有两种形态：`1,234` 和 `1.2万` / `1.2K`。
   * 同一套解析给所有指标用，避免每处写一遍正则。
   */
  const num = (s) => {
    if (s == null) return null;
    const m = /([\d,.]+)\s*([KMB万]?)/i.exec(String(s));
    if (!m) return null;
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(v)) return null;
    const un = (m[2] || '').toUpperCase();
    const mul = un === 'K' || un === '千' ? 1e3 : un === 'M' ? 1e6 : un === 'B' || un === '亿' ? (un === '亿' ? 1e8 : 1e9) : un === '万' ? 1e4 : 1;
    return Math.round(v * mul);
  };

  /**
   * 按「标签 → 值」成对扫描文本。
   *
   * studio 的排版极稳定：标签一行、值一行。
   * 所以找标签所在行，再取下一行作为值 —— 比正则跨行匹配稳得多。
   */
  const pairs = text.split('\n').map((x) => x.trim()).filter(Boolean);
  const after = (labelRe) => {
    for (let i = 0; i < pairs.length; i++) {
      if (!labelRe.test(pairs[i])) continue;
      // 值可能就在同一行（用 tab 隔开），也可能在下一行
      const same = pairs[i].split(/\t+/).filter(Boolean);
      if (same.length > 1) return same[same.length - 1];
      for (let k = i + 1; k < Math.min(i + 4, pairs.length); k++) {
        if (/^[\d][\d,.]*\s*[KMB万]?$/.test(pairs[k])) return pairs[k];
        if (/^—$|^-$/.test(pairs[k])) return null;
      }
    }
    return null;
  };

  // ---- 频道级
  const subs = after(/当前订阅人数|Current subscribers/);
  const views28 = after(/^观看次数|^Views$/);
  const hours28 = after(/^观看时长（小时）|^Watch time \(hours\)/);

  // ---- 昵称：左侧「我的频道」下面那行就是频道名
  let nickname = '';
  {
    const i = pairs.findIndex((l) => /^(我的频道|Your channel)$/.test(l));
    if (i >= 0 && pairs[i + 1] && pairs[i + 1].length <= 60) nickname = pairs[i + 1];
    if (!nickname) {
      const nm = /"title":\{"runs":\[\{"text":"([^"]{1,60})"/.exec(JSON.stringify(window.ytInitialData || {}));
      if (nm) nickname = nm[1];
    }
  }

  /**
   * ---- 作品：**首页不产出作品**
   *
   * 首页「最新 Shorts 表现」那块虽然有几条数据，但有两个硬伤：
   *   · 没有视频 ID，只能用「日期+序号」编临时 key
   *   · 数字是「发布后前 N 分钟」的，不是累计
   * 而 /videos/short 页的接口给的是**真 ID + 累计观看/赞/评论**。
   * 两边都收就会同一视频出现两行（实测确实重复了）。
   *
   * 所以作品统一由 ytVideos 读，这里只负责频道级数字（订阅、28 天观看）。
   */
  const works = [];

  out.login = true;
  // 后两页要靠它拼地址（studio 的内容页必须带 channel id）
  if (cid) out.ctx = { cid };
  out.identity = {
    nickname: String(nickname || ''),
    handle: cid, // 频道 ID 就是最稳的 handle
    uid: cid,
    avatar: ''
  };
  out.account = { followers: num(subs) };
  /**
   * 首页**不报 worksTotal**，也不标 truncated。
   *
   * 因为作品由后面两个页签负责读。如果这里报一个 0 或 1，
   * reader 会把它和后面读到的数取 max —— 报 0 会拉低总数、报 1 会掩盖真实条数。
   * 干脆不报：让 ytVideos 那一页说了算（它拿到的是平台给的准确总数）。
   *
   * 订阅数读不到时说明原因，但**不写 note**——
   * note 会覆盖账号备注，而后面两页还会再给更准的信息。
   */
  /**
   * 关键是**不设 out.works**（连空数组都不给）。
   *
   * reader 的对账逻辑是「返回了 works 数组的页面才算参与作品对账」。
   * 首页只负责频道级数字，如果给了 `works: []`，它就会被当成
   * 「一个读到 0 条、又没自报总数的作品页」—— complete 永远判 false，
   * 而实际两个内容页都对得上（实测 got=1/total=1、got=0/total=0）。
   *
   * 所以这里什么都不返回，让内容页说了算。
   */
  out.extraAccount = {
    ...(num(views28) == null ? {} : { views28d: num(views28) }),
    ...(hours28 == null ? {} : { watchHours28d: Number(hours28) || 0 })
  };
  return out;
};

/**
 * YouTube 内容列表（真正带全部指标的那一页）
 *
 * 两个页签要分别读，因为它们列的是不同的东西：
 *   /videos/short   → Shorts 短视频
 *   /videos/upload  → 普通视频
 * （实测：发的是 Shorts 时，/videos/upload 会显示「没有可显示的内容」）
 *
 * **数据来源是页面自己发的接口，不是 DOM**：
 *   POST /youtubei/v1/creator/list_creator_videos?alt=json
 * 返回结构（实测）：
 *   {
 *     videosTotalSize: { size:"1", accuracy:"ACCURACY_EXACT" },   ← 准确总数
 *     videos: [{
 *       videoId, title, description, privacy, contentType,
 *       timePublishedSeconds, lengthSeconds, watchUrl,
 *       publicMetrics: { externalViewCount, likeCount, commentCount }
 *     }]
 *   }
 *
 * 为什么不用 DOM 解析：DOM 里的列是「当前显示的列」，用户没开的列就不在
 * 页面上；而接口永远返回整套 publicMetrics。而且 DOM 里 Shorts 没有标题、
 * 数字顺序还会变，解析一遍就错一遍。
 *
 * 分页：每页 30 条，多了就点 `#navigate-after` 翻。实测按钮 id 固定。
 */
const ytVideos = async function () {
  const out = { platform: 'yt' };
  const text = (document.body && document.body.innerText) || '';
  const cfg = window.ytcfg && window.ytcfg.data_ ? window.ytcfg.data_ : {};
  if (!cfg.LOGGED_IN && !/我的频道|Your channel/.test(text)) {
    out.login = false;
    return out;
  }
  const cid = (/\/channel\/(UC[A-Za-z0-9_-]{20,})/.exec(String(location.pathname || '')) || [])[1] || '';
  if (!cid) {
    // 没频道的情况由首页那一页负责说，这里不重复
    out.login = true;
    out.works = [];
    out.worksTotal = 0;
    return out;
  }

  const num = (v) => {
    if (v == null) return null;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const iso = (sec) => {
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n * 1000);
    const p2 = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };

  /** 从 __cap 里把一份份 list_creator_videos 响应合并成一张表 */
  const bag = new Map();
  let totalSize = null;
  const absorb = () => {
    for (const c of window.__cap || []) {
      if (!String(c.url || '').includes('list_creator_videos')) continue;
      let j2 = null;
      try {
        j2 = JSON.parse(c.body);
      } catch {
        continue;
      }
      const ts = j2 && j2.videosTotalSize;
      if (ts && ts.size != null) {
        const n = Number(ts.size);
        if (Number.isFinite(n)) totalSize = totalSize == null ? n : Math.max(totalSize, n);
      }
      for (const v of (j2 && j2.videos) || []) {
        const id = String(v.videoId || '');
        if (!id) continue;
        const pm = v.publicMetrics || {};
        bag.set(id, {
          platWorkId: id,
          title: String(v.title || '').replace(/\s+/g, ' ').slice(0, 300),
          publishedAt: iso(v.timePublishedSeconds),
          // externalViewCount 是「公开观看次数」，和自己后台看到的那个数一致
          reads: num(pm.externalViewCount),
          likes: num(pm.likeCount),
          comments: num(pm.commentCount),
          shares: null,
          saves: null,
          extra: {
            // 时长（秒）：Shorts 一栏列的就是这个，很实用
            ...(v.lengthSeconds == null ? {} : { lengthSec: num(v.lengthSeconds) }),
            // Shorts 还是普通视频 —— 两类东西的指标含义不同
            kind: /SHORTS/i.test(String(v.contentType || '')) ? 'shorts' : 'video',
            // 可见性：公开 / 不公开 / 私享。不公开的视频观看数天然低，不该混在一起比
            privacy: String(v.privacy || '').replace(/^VIDEO_PRIVACY_/, '').toLowerCase()
          }
        });
      }
    }
    return bag.size;
  };

  absorb();

  /**
   * 翻页：目标数来自 videosTotalSize（平台自己给的准确总数）。
   * 最多翻 10 页（300 条），再多就标 truncated —— 
   * 一个号几百条视频全翻完要几十秒，而且更容易被风控。
   */
  let truncated = false;
  for (let page = 0; page < 10; page++) {
    if (totalSize != null && bag.size >= totalSize) break;
    const nextBtn = document.getElementById('navigate-after');
    if (!nextBtn) break;
    const disabled =
      nextBtn.hasAttribute('disabled') ||
      nextBtn.getAttribute('aria-disabled') === 'true' ||
      String(nextBtn.className || '').includes('disabled');
    if (disabled) break;
    const before = bag.size;
    nextBtn.click();
    // 翻页间隔抖动：固定节拍是机器特征
    await new Promise((r) => setTimeout(r, 1400 + Math.round(Math.random() * 1200)));
    absorb();
    if (bag.size === before) break; // 没有新增，到底了
  }
  if (totalSize != null && bag.size < totalSize) truncated = true;

  const works = Array.from(bag.values());

  out.login = true;
  out.identity = { nickname: '', handle: cid, uid: cid, avatar: '' };
  out.works = works;
  // 有准确总数就用它；没有才退回「这次读到几条」
  out.worksTotal = totalSize != null ? Math.max(totalSize, works.length) : works.length;
  if (truncated) out.truncated = true;
  if (totalSize != null && works.length < totalSize) out.truncated = true;
  return out;
};

module.exports = {
  key: 'yt',
  name: 'YouTube',
  /**
   * 三页，各管一段，缺一不可：
   *   1. studio 首页        → 频道级：订阅数、28 天观看
   *   2. /videos/short      → 全部 Shorts（带观看/赞/评论）
   *   3. /videos/upload     → 全部普通视频
   * 后两页读的是同一个接口（list_creator_videos），但两个页签列的内容不同 ——
   * 实测发 Shorts 的号在 /videos/upload 会显示「没有可显示的内容」。
   */
  pages: [
    { url: 'https://studio.youtube.com/', fn: youtube },
    {
      url: (ctx) => `https://studio.youtube.com/channel/${encodeURIComponent(ctx.cid || '')}/videos/short`,
      fn: ytVideos,
      when: (ctx) => !!ctx.cid
    },
    {
      url: (ctx) => `https://studio.youtube.com/channel/${encodeURIComponent(ctx.cid || '')}/videos/upload`,
      fn: ytVideos,
      when: (ctx) => !!ctx.cid
    }
  ]
};
