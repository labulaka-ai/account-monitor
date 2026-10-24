'use strict';
/**
 * TikTok · 页面内取数脚本
 *
 * 这些函数会被 toString() 成字符串注入到平台页面里执行（见 lib/reader.js 的 scriptOf），
 * 所以铁律：**函数体不能引用文件外的东西**，连本文件里别的 const 也不行。
 * 需要小工具就写在函数体里面 —— test/scripts.test.js 会盯着这条。
 */

/**
 * TikTok 走个人主页，两步：
 *   1) 首页认人：从导航里那个带头像的 /@handle 链接认出「我是谁」
 *   2) 用这个 handle 打开主页，读粉丝 / 获赞 / 视频卡片上的播放量
 *
 * 为什么不走创作者中心：
 *   创作者中心要额外的创作者权限，而且它的接口半年改过三次地址；
 *   个人主页上粉丝、获赞、单条播放都是公开数字，反而更稳。
 *   代价是拿不到点赞/评论（那要进每条视频），所以 caps.work 只声明 reads。
 *
 * 一条铁律跟其他平台一致：只读「明确属于自己」的东西。
 * TikTok 首页信息流里全是别人的视频，作者名一抓一大把 ——
 * 任何「页面上第一个播放量」都不是自己的，必须钉在 handle 上。
 */


/**
 * 首页：认出自己的 handle。
 *
 * 为什么不在这一页读数据：首页是 For You 信息流，全是别人的视频。
 * 这里只做「认人」，一个数字都不取。
 */
const tiktokWho = async function () {
  const out = { platform: 'tiktok' };
  const text = (document.body && document.body.innerText) || '';

  // 没登录：TikTok 会在右侧给「登录」按钮，正文里出现 Log in / 登录
  const hasSession = /(^|;\s*)(sessionid|sessionid_ss|sid_tt)=/.test(String(document.cookie || ''));

  /**
   * 找自己：导航区那个 <a href="/@xxx"> 且里面带 img 的。
   *
   * 为什么必须带 img：首页正文里有大量 @用户名的纯文本链接（评论区、视频作者），
   * 只有「头像入口」那个链接才是当前登录账号。这个判断跟 Instagram 是同一套路。
   */
  let handle = '';
  let avatar = '';
  const NAV_HINT = /^(For You|Following|Explore|LIVE|上传|Upload|Profile|个人主页|首页|发现|关注)/i;
  for (const a of Array.from(document.querySelectorAll('a[href^="/@"]'))) {
    const img = a.querySelector('img');
    if (!img) continue;
    const href = String(a.getAttribute('href') || '');
    const m = /^\/@([A-Za-z0-9._-]+)/.exec(href);
    if (!m) continue;
    // 导航在页面顶部/左侧，用位置排除信息流里的作者链接
    const r = a.getBoundingClientRect();
    const inChrome = r.top < 200 || r.left < 260;
    const inNav = NAV_HINT.test(String(a.getAttribute('aria-label') || a.innerText || '').trim());
    if (!inChrome && !inNav) continue;
    handle = m[1];
    avatar = String(img.getAttribute('src') || '');
    break;
  }

  /**
   * 兜底：页面预置状态里当前用户是明确的 key。
   * TikTok 有两套：老版 SIGI_STATE，新版 __UNIVERSAL_DATA_FOR_REHYDRATION__。
   */
  if (!handle) {
    const pick = (o, path) => {
      let cur = o;
      for (const k of path) {
        if (!cur || typeof cur !== 'object') return null;
        cur = cur[k];
      }
      return cur;
    };
    const cands = [];
    try {
      const sigi = window.SIGI_STATE;
      if (sigi) {
        cands.push(pick(sigi, ['UserModule', 'users']), pick(sigi, ['AppContext', 'appContext']));
      }
    } catch {
      /* 页面没这个全局变量 */
    }
    try {
      const uni = window.__UNIVERSAL_DATA_FOR_REHYDRATION__;
      if (uni && uni.__DEFAULT_SCOPE__) {
        const d = uni.__DEFAULT_SCOPE__;
        cands.push(d['webapp.app-context'], d['webapp.user-detail']);
      }
    } catch {
      /* 同上 */
    }
    for (const c of cands) {
      if (!c || typeof c !== 'object') continue;
      const u =
        (c.userInfo && (c.userInfo.user || c.userInfo)) ||
        (c.user && c.user) ||
        (c.users && Object.values(c.users)[0]) ||
        null;
      const h = u && (u.uniqueId || u.unique_id || u.nickname);
      if (h && /^[A-Za-z0-9._-]+$/.test(String(h))) {
        handle = String(h);
        if (!avatar && u.avatarLarger) avatar = String(u.avatarLarger);
        break;
      }
    }
  }

  if (!handle) {
    // 没登录时 handle 认不出来是正常的，交给 reader 判「需要重新登录」
    if (!hasSession || /Log in to TikTok|登录 TikTok|Use phone \/ email/i.test(text.slice(0, 600))) {
      out.login = false;
      return out;
    }
    out.note = '认不出当前登录的是哪个号（首页没给出账号入口）';
    out.works = [];
    return out;
  }

  out.login = true;
  out.ctx = { handle };
  out.identity = { nickname: '', handle, uid: handle, avatar };
  return out;
};

/**
 * 个人主页：粉丝 / 获赞 / 每条视频的播放·赞·评·转发·收藏。
 *
 * 数据来源优先级（三段，逐级降级）：
 *   1. `/api/post/item_list/` —— 一次给全所有指标 + 发布日期（createTime）
 *   2. window.__cap —— 页面自己发的同一条请求（带签名），只在 1 被拒时用
 *   3. DOM 视频卡片 —— 只有播放量，前两条都失败才退到这儿
 *
 * 为什么不一上来就刮 DOM：主页卡片上只有一个播放量，
 * 拿它算互动率是算不出来的；而这个接口连收藏数、发布日期都给。
 * 有了 createTime 才能把视频归到正确的时间段 —— 否则「本月发了什么」永远是空的。
 *
 * 不接参数：页面脚本统一由 scriptOf(fn) 以 `(fn)()` 无参调用，
 * handle 从 location.pathname 自己解析（跟 xProfile 同一套）。
 */
const tiktokProfile = async function () {
  const out = { platform: 'tiktok' };

  /** 数字文字转数值：TikTok 用 1.2M / 3.4K / 12.3万 这类缩写 */
  const ttNum = function (raw) {
    const t = String(raw == null ? '' : raw).replace(/\s/g, '');
    if (!t) return null;
    const m = /([\d.,]+)\s*([KMBkmb万亿]?)/.exec(t);
    if (!m) return null;
    // 「1,234」「1.234」都当同一个数：先看有没有逗号分隔的三位组
    let num = m[1];
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(num)) num = num.replace(/,/g, '');
    else num = num.replace(/,/g, '.');
    const v = parseFloat(num);
    if (!Number.isFinite(v)) return null;
    const u = (m[2] || '').toUpperCase();
    const mul = u === 'K' ? 1e3 : u === 'M' ? 1e6 : u === 'B' ? 1e9 : u === '万' ? 1e4 : u === '亿' ? 1e8 : 1;
    return Math.round(v * mul);
  };

  const handle = (() => {
    const m = /^\/@([A-Za-z0-9._-]+)/.exec(String(location.pathname || ''));
    return m ? m[1] : '';
  })();
  if (!handle) {
    out.login = false;
    return out;
  }

  const text = (document.body && document.body.innerText) || '';
  if (/\/login|Log in to TikTok|登录 TikTok/i.test(String(location.pathname || '') + text.slice(0, 400))) {
    out.login = false;
    return out;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** 抖动：别做成机器节奏（600~1200ms） */
  const jitter = () => sleep(600 + Math.round(Math.random() * 600));

  const q = (sel) => {
    const e = document.querySelector(sel);
    return e ? String(e.textContent || '').trim() : '';
  };
  const qn = (sel) => {
    const v = q(sel);
    return v ? ttNum(v) : null;
  };

  /**
   * 粉丝：优先 data-e2e，其次从文字里找。
   * 文字兜底必须钉死在「粉丝 / Followers」这个词上 ——
   * 主页上还有「关注 / Following」「获赞 / Likes」两组数字，混了就是灾难。
   */
  let followers = qn('[data-e2e="followers-count"]');
  if (followers == null) {
    const m = /([\d.,]+\s*[KMB万亿]?)\s*(?:粉丝|Followers?)\b/i.exec(text);
    if (m) followers = ttNum(m[1]);
  }
  let likesTotal = qn('[data-e2e="likes-count"]');
  if (likesTotal == null) {
    const m = /([\d.,]+\s*[KMB万亿]?)\s*(?:获赞|Likes?)\b/i.exec(text);
    if (m) likesTotal = ttNum(m[1]);
  }

  let nickname = '';
  {
    const h1 = document.querySelector('h1[data-e2e="user-title"], h1');
    if (h1) nickname = String(h1.textContent || '').trim().split('\n')[0].slice(0, 60);
    if (!nickname) {
      // og:title 是「昵称(@handle) on TikTok」，比 innerText 干净
      const og = document.querySelector('meta[property="og:title"]');
      if (og) {
        nickname = String(og.getAttribute('content') || '')
          .replace(/\(@[^)]*\).*$/i, '')
          .replace(/\s*on TikTok.*$/i, '')
          .trim()
          .slice(0, 60);
      }
    }
  }

  let avatar = '';
  let secUid = '';
  {
    const im = document.querySelector('[data-e2e="user-avatar"] img, header img');
    if (im) avatar = String(im.getAttribute('src') || '');
  }
  /**
   * secUid 是调 item_list 的必需参数。
   * 主页 SSR 一定会把它塞进 __UNIVERSAL_DATA_FOR_REHYDRATION__，
   * 拿不到就说明这个页面结构变了，直接走 DOM 兜底。
   */
  try {
    const d =
      window.__UNIVERSAL_DATA_FOR_REHYDRATION__ &&
      window.__UNIVERSAL_DATA_FOR_REHYDRATION__.__DEFAULT_SCOPE__;
    const u =
      d && d['webapp.user-detail'] && d['webapp.user-detail'].userInfo
        ? d['webapp.user-detail'].userInfo.user
        : null;
    if (u) {
      secUid = String(u.secUid || '');
      if (!nickname) nickname = String(u.nickname || '').slice(0, 60);
      if (!avatar) avatar = String(u.avatarLarger || u.avatarMedium || '');
      // 主页头部数字也常在 SSR 里，比 DOM 先读到就先信它（DOM 还没渲染完时 DOM 是空的）
      if (followers == null && u.stats) {
        const v = Number(u.stats.followerCount);
        if (Number.isFinite(v)) followers = v;
      }
      if (likesTotal == null && u.stats) {
        const v = Number(u.stats.heartCount);
        if (Number.isFinite(v)) likesTotal = v;
      }
    }
  } catch {
    /* 页面没这段状态 */
  }

  /** 把 item_list 的一条记录转成统一的作品结构 */
  const fromItem = (it) => {
    const st = (it && it.stats) || {};
    const nz = (v) => {
      const n2 = Number(v);
      return Number.isFinite(n2) ? n2 : null;
    };
    const ts = Number(it && it.createTime);
    const publishedAt = Number.isFinite(ts) && ts > 0
      ? new Date(ts * 1000).toISOString().slice(0, 10)
      : '';
    return {
      platWorkId: String((it && it.id) || ''),
      title: String((it && it.desc) || '').replace(/\s+/g, ' ').slice(0, 300),
      publishedAt,
      reads: nz(st.playCount),
      likes: nz(st.diggCount),
      comments: nz(st.commentCount),
      shares: nz(st.shareCount),
      saves: nz(st.collectCount),
      extra: {}
    };
  };

  /** 从任何一份 item_list 响应里取 items */
  const itemsOf = (j) => (j && Array.isArray(j.itemList) ? j.itemList : []);

  const byId = new Map();
  const absorb = (items) => {
    for (const it of items) {
      const w = fromItem(it);
      if (w.platWorkId && !byId.has(w.platWorkId)) byId.set(w.platWorkId, w);
    }
  };

  // ---- 1) 直接调接口（同源、带 cookie）
  let apiOk = false;
  if (secUid) {
    for (const cursor of [0, 30]) {
      const u =
        `/api/post/item_list/?aid=1988&count=30&cursor=${cursor}` +
        `&secUid=${encodeURIComponent(secUid)}`;
      try {
        const r = await fetch(u, {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        });
        if (!r.ok) break;
        const j = await r.json();
        const items = itemsOf(j);
        if (!items.length) break;
        absorb(items);
        apiOk = true;
        if (!j.hasMore) break;
        await jitter();
      } catch {
        break; // 被签名拦了，走下一段
      }
    }
  }

  // ---- 2) 页面自己发过的请求（带签名，一定合法）
  if (!apiOk) {
    for (const c of window.__cap || []) {
      if (!/\/api\/post\/item_list/.test(String(c.url || ''))) continue;
      try {
        absorb(itemsOf(JSON.parse(c.body)));
        apiOk = true;
      } catch {
        /* 这一条不是 JSON */
      }
    }
  }

  /**
   * ---- 3) 真拿不到接口数据，就滚一下让页面自己去请求。
   *
   * 这是「模拟用户浏览」而不是「高频抓取」：只是滚到底，
   * 页面自己决定要不要发请求、发几次；间隔带抖动。
   */
  if (!apiOk) {
    const count = () => document.querySelectorAll('[data-e2e="user-post-item"]').length;
    let last = -1;
    for (let round = 0; round < 5; round++) {
      const now = count();
      if (now === last && round > 0) break;
      last = now;
      window.scrollTo(0, document.body.scrollHeight);
      await jitter();
      for (const c of window.__cap || []) {
        if (!/\/api\/post\/item_list/.test(String(c.url || ''))) continue;
        try {
          absorb(itemsOf(JSON.parse(c.body)));
          apiOk = true;
        } catch {
          /* 跳过非 JSON */
        }
      }
      if (apiOk) break;
    }
  }

  /**
   * ---- 4) 最后的兜底：DOM 卡片。
   *
   * 只有播放量，没有发布日期 —— 所以这类作品归不到任何时间段，
   * 会以「发布日期未知」的形式出现在作品表里，但不进本期统计。
   */
  if (!byId.size) {
    const cards = Array.from(
      document.querySelectorAll('[data-e2e="user-post-item"], div[class*="DivItemContainer"]')
    );
    for (const card of cards) {
      const a = card.querySelector('a[href*="/video/"]');
      if (!a) continue;
      const m = /\/video\/(\d+)/.exec(String(a.getAttribute('href') || ''));
      if (!m) continue;
      const wid = m[1];
      if (byId.has(wid)) continue;

      let reads = null;
      const vEl = card.querySelector('[data-e2e="video-views"], strong[data-e2e*="views"]');
      if (vEl) reads = ttNum(vEl.textContent);
      if (reads == null) {
        const nums = String(card.innerText || '').match(/[\d.,]+\s*[KMB万亿]?/g);
        if (nums && nums.length) reads = ttNum(nums[nums.length - 1]);
      }

      let title = '';
      const im = card.querySelector('img[alt]');
      if (im) title = String(im.getAttribute('alt') || '').trim();
      if (!title) {
        title = String(card.innerText || '')
          .split('\n')
          .map((x) => x.trim())
          .find((x) => x && !/^[\d.,]+\s*[KMB万亿]?$/.test(x)) || '';
      }

      byId.set(wid, {
        platWorkId: wid,
        title: String(title).replace(/\s+/g, ' ').slice(0, 300),
        publishedAt: '',
        reads,
        likes: null,
        comments: null,
        shares: null,
        saves: null
      });
    }
  }

  const works = Array.from(byId.values());

  /**
   * 作品总数：tab 上那个「视频 12」，或者 SSR 里的 videoCount。
   * 读不到就留 null（reader 会当成「没读到」而不是「0 条」）。
   */
  let worksTotal = null;
  {
    const vc = document.querySelector('[data-e2e="video-count"]');
    if (vc) worksTotal = ttNum(vc.textContent);
    if (worksTotal == null) {
      const m = /([\d.,]+)\s*(?:个作品|条作品|videos?)\b/i.exec(text);
      if (m) worksTotal = ttNum(m[1]);
    }
  }

  out.login = true;
  out.identity = { nickname, handle, uid: secUid || handle, avatar };
  out.account = { followers };
  if (likesTotal != null) out.account.totalLikes = likesTotal;
  out.works = works;
  if (worksTotal != null) out.worksTotal = worksTotal;

  /**
   * 必须标 truncated：主页是懒加载的，滚多少加载多少。
   * 不标的话，某次只读到 8 条会把上次那 12 条里少的 4 条判成「已删除」。
   */
  out.truncated = true;

  if (!works.length) {
    out.note = worksTotal === 0 ? '这个号还没有发过视频' : '主页没有加载出视频';
  } else if (!apiOk) {
    out.note = '接口没通，播放量取自主页卡片；点赞/评论/发布日期读不到';
  }
  return out;
};

module.exports = {
  key: 'tiktok',
  name: 'TikTok',
  /**
   * 两步，跟 IG / Threads 同样的道理：
   *   首页只用来认「我是哪个号」，自己的主页才读数字。
   * 合成一步试过（直接在首页找数字），结果首页信息流里全是别人的播放量。
   */
  pages: [
    { url: 'https://www.tiktok.com/', fn: tiktokWho },
    {
      url: (ctx) => `https://www.tiktok.com/@${encodeURIComponent(ctx.handle || '')}`,
      fn: tiktokProfile,
      when: (ctx) => !!ctx.handle
    }
  ]
};
