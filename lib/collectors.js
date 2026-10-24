'use strict';
/**
 * 平台取数脚本 · 在页面内执行
 *
 * 为什么长这样：
 *   之前用「在全部接口里按同义词模糊找 follower_count」这种启发式，结果是
 *   数字有时对、有时对到别人头上、有时干脆读不到，而且没有任何提示 ——
 *   用户没法判断屏幕上那个数到底是不是自己的。
 *
 *   现在每个平台一条固定路线：先看平台自己的后台页面/接口叫什么、字段叫什么，
 *   实测确认后写死在这个文件里。读不到就是读不到（并说明卡在哪一步），
 *   不再从别处捡一个数字凑上。
 *
 * 每个函数都在页面里跑（没有 require、没有 Node），返回统一结构：
 *   {
 *     login:    boolean        没登录时给 false，reader 据此判「需要重新登录」
 *     identity: { nickname, handle, uid, avatar }
 *     account:  { followers, totalReads, totalLikes }
 *     works:    [{ platWorkId, title, publishedAt, reads, likes, saves, comments, shares, completion, newFollowers, extra }]
 *     worksTotal: number|null  平台自报的作品总数（不是这次返回的条数）
 *     note:     string         平台侧的事实说明（例如「这个号还没有作品」）
 *     ctx:      object         给下一页用的参数（例如公众号的 token）
 *   }
 *
 * 账号级 totalReads 只在平台确实给「累计」时才填。抖音/小红书的概览是「近 7 天」，
 * 由适配器的 overviewWindow 标成 7d，界面标签跟着改口 —— 数字真但含义不能混。
 */

// ---------------------------------------------------------------- 公众号
/**
 * 首页：总用户数 + 昵称 + token。
 * 公众号后台所有 cgi-bin 接口都要带 token，token 就在首页地址里。
 */
const gzhAccount = async function () {
  const q = new URLSearchParams(location.search);
  const cd = (window.wx && window.wx.commonData && window.wx.commonData.data) || {};
  const token = String(cd.t || cd.token || q.get('token') || '');
  const text = (document.body && document.body.innerText) || '';
  const out = { platform: 'gzh', ctx: { token } };

  if (!token || /扫码登录|密码登录|请使用微信扫描/.test(text.slice(0, 1500))) {
    out.login = false;
    return out;
  }

  const grab = (label) => {
    const m = text.match(new RegExp(label + '\\s*\\n\\s*([0-9][0-9,]*)'));
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };

  let nickname = String(cd.nick_name || cd.nickname || '').trim();
  if (!nickname) {
    // 后台顶部账号名会在页面里出现两次（侧栏 + 顶部），菜单项只出现一次
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const cnt = new Map();
    for (const l of lines) cnt.set(l, (cnt.get(l) || 0) + 1);
    nickname =
      lines
        .slice(0, 40)
        .find((l) => l.length >= 2 && l.length <= 20 && (cnt.get(l) || 0) >= 2 && !/^\d/.test(l)) || '';
  }

  out.login = true;
  out.identity = {
    nickname,
    handle: '',
    uid: String(cd.uin || cd.user_name || ''),
    avatar: String(cd.headimgurl || '')
  };
  out.account = { followers: grab('总用户数') };
  return out;
};

/**
 * 发表记录：走后台自己的列表接口，不解析页面。
 *
 * 为什么不用页面 DOM（试过，会漏）：
 *   一次「群发」里可以有头条 + 若干次条，页面只把头条和部分次条渲染出来，
 *   实测同一个号接口里 32 篇、页面 DOM 里只有 20~21 篇 —— 少了三分之一。
 *   更糟的是这 20 篇被当成了「全部」，于是没渲染出来的文章全被标成已删除。
 *
 * 接口：/cgi-bin/appmsgpublish?...&f=json&ajax=1&begin=0&count=20
 *   publish_page 是一个 **被字符串化了两次的 JSON**，里层 publish_list 是每次群发，
 *   每次群发里的 publish_info 又是一段 JSON，文章在它的 appmsg_info 数组里。
 *   数字直接带：read_num（阅读）/ like_num（赞）/ share_num（分享）/
 *   comment_num（评论）/ old_like_num（在看）。已与页面逐个核对一致。
 *
 * 文章 id 用 appmsgid + itemidx：content_url 有时是老格式（/s?__biz=…），
 * 从中拿不到 /s/<hash>，而 appmsgid_itemidx 每篇都有且不会变。
 */
const gzhWorks = async function () {
  const out = { platform: 'gzh' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const text = (document.body && document.body.innerText) || '';
  if (/扫码登录|请使用微信扫描|登录后查看/.test(text.slice(0, 1200))) {
    out.login = false;
    return out;
  }

  const token = new URLSearchParams(location.search).get('token') || '';
  const pad = (n) => String(n).padStart(2, '0');
  const dstr = (ts) => {
    if (!ts) return '';
    const d = new Date(Number(ts) * 1000);
    if (!Number.isFinite(d.getTime())) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const n0 = (v) => (v == null || v === '' ? null : Number(v));

  const works = [];
  const seen = new Set();

  const takePage = (raw) => {
    const pp = typeof raw.publish_page === 'string' ? JSON.parse(raw.publish_page) : raw.publish_page || {};
    const groups = pp.publish_list || [];
    for (const g of groups) {
      let pi = g.publish_info;
      if (typeof pi === 'string') {
        try {
          pi = JSON.parse(pi);
        } catch {
          pi = {};
        }
      }
      pi = pi || {};
      const sentAt = (pi.sent_info && pi.sent_info.time) || 0;
      for (const a of pi.appmsg_info || []) {
        const mid = a.appmsgid;
        const idx = a.itemidx == null ? 0 : a.itemidx;
        const url = String(a.content_url || '');
        const m = /\/s\/([A-Za-z0-9_-]+)/.exec(url);
        const id = mid ? `${mid}_${idx}` : m ? m[1] : String(a.title || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        works.push({
          platWorkId: id,
          title: String(a.title || '').slice(0, 300),
          publishedAt: dstr(a.create_time || a.update_time || sentAt),
          reads: n0(a.read_num),
          likes: n0(a.like_num),
          shares: n0(a.share_num),
          comments: n0(a.comment_num),
          extra: { recommend: n0(a.old_like_num) }
        });
      }
    }
    return { total: Number(pp.total_count || 0), groups: groups.length };
  };

  let gzhDone = !token; // 走 DOM 兜底时本来就不全，不算「翻完了」
  if (token) {
    const base =
      '/cgi-bin/appmsgpublish?sub=list&token=' + encodeURIComponent(token) + '&lang=zh_CN&f=json&ajax=1';
    let total = null;
    gzhDone = false;
    for (let begin = 0, round = 0; round < 20; round++, begin += 20) {
      // begin/count 按「群发」计数，不是按篇（一次群发可以带 4 篇）
      if (total != null && begin >= total) {
        gzhDone = true;
        break;
      }
      let raw = null;
      try {
        const r = await fetch(`${base}&begin=${begin}&count=20`, { credentials: 'include' });
        raw = await r.json();
      } catch {
        break;
      }
      const got = takePage(raw);
      // 总数先落下来：空账号返回的就是 total_count=0 加上空列表，
      // 这时「一页都没有」本身就是读完了，不能算没翻完
      if (total == null) total = got.total;
      if (!got.groups) {
        gzhDone = begin >= total;
        break;
      }
      await sleep(600 + Math.round(Math.random() * 800));
    }
  }

  // 接口这条路走不通时（比如没有 token），退回到页面 DOM。
  // 这时数字是对的，但只会拿到页面上渲染出来的那部分。
  if (!works.length) {
    const rows = Array.from(document.querySelectorAll('.weui-desktop-mass-appmsg__bd_container'));
    const num = (root, cls) => {
      const el = root.querySelector('.' + cls + ' .weui-desktop-mass-media__data__inner');
      if (!el) return null;
      const v = parseInt(String(el.textContent || '').replace(/[^\d]/g, ''), 10);
      return Number.isFinite(v) ? v : null;
    };
    for (const r of rows) {
      const a = r.querySelector('a.weui-desktop-mass-appmsg__title');
      const title = a ? String(a.innerText || '').split('\n')[0].trim().slice(0, 300) : '';
      const m = a ? /\/s\/([A-Za-z0-9_-]+)/.exec(String(a.getAttribute('href') || '')) : null;
      const id = m ? m[1] : title;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      works.push({
        platWorkId: id,
        title,
        publishedAt: '',
        reads: num(r, 'appmsg-view'),
        likes: num(r, 'appmsg-like'),
        shares: num(r, 'appmsg-share'),
        comments: num(r, 'appmsg-comment'),
        extra: { recommend: num(r, 'appmsg-haokan') }
      });
    }
  }

  out.works = works;
  out.worksTotal = works.length;
  if (!gzhDone) out.truncated = true;
  if (!works.length && gzhDone) out.note = '这个号还没有发表过文章';
  return out;
};

// ---------------------------------------------------------------- 小红书
/**
 * 笔记管理页：粉丝/关注/获赞在 personal_info，笔记列表在 v2 posted。
 * 两处都是创作者后台自己用的接口，字段名固定（fans_count / view_count / collected_count）。
 */
const xhsWorks = async function () {
  const out = { platform: 'xhs' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const j = async (u) => {
    const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
    const t = await r.text();
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };

  /**
   * 笔记列表这个接口要平台自己算的签名头，直接 fetch 会被拒。
   * 但页面自己发的那次请求（带签名）会落在 window.__cap 里 —— 直接拿它的响应，
   * 等于「用户翻到哪儿，我们就读到哪儿」，不需要伪造签名。
   *
   * 关键：分页参数是 page=0 / page=1 / page=2，**每页只回自己那一段**。
   * 所以必须把所有页按 id 合并。之前只取「最后一条」响应，
   * 结果翻到第二页时反而只剩那一页的 2 条 —— 12 条笔记只读到 10 条就是这么来的。
   */
  const notesFromCap = () => {
    const bag = new Map();
    for (const x of window.__cap || []) {
      if (!/\/note\/user\/posted/.test(String(x.url || ''))) continue;
      let j2 = null;
      try {
        j2 = JSON.parse(x.body);
      } catch {
        continue; // 这一条不是 JSON
      }
      const list = (j2 && j2.data && j2.data.notes) || [];
      for (const n of list) {
        const id = String(n.id || '');
        if (id && !bag.has(id)) bag.set(id, n);
      }
    }
    return Array.from(bag.values());
  };

  /**
   * 列表页自己滚自己（div.content），不是整页滚。
   * 之前滚 window 一点用都没有：页面高度只有一屏，window 根本没得滚，
   * 所以第二页永远不会被请求。
   */
  const scroller = () => {
    const prefer = document.querySelector('.note-list, .content');
    if (prefer && prefer.scrollHeight > prefer.clientHeight + 40) return prefer;
    let best = null;
    for (const el of document.querySelectorAll('div')) {
      if (el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 240) {
        if (!best || el.scrollHeight > best.scrollHeight) best = el;
      }
    }
    return best;
  };

  const info = await j('/api/galaxy/creator/home/personal_info');
  const d = (info && info.data) || null;
  if (!d || (d.name == null && d.fans_count == null)) {
    out.login = false;
    return out;
  }

  const totalInPage = () => {
    const m = /全部\s*(\d+)/.exec(String((document.body && document.body.innerText) || ''));
    return m ? Number(m[1]) : null;
  };

  // 先把首屏已经加载好的那一页吃掉，再一段一段往下滚，直到拿满「全部 N」
  let notes = notesFromCap();
  let stall = 0;
  for (let i = 0; i < 6; i++) {
    const total = totalInPage();
    if (total != null && notes.length >= total) break;
    const el = scroller();
    if (el) {
      el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.round(el.clientHeight * 0.85));
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
    window.scrollTo(0, document.body.scrollHeight);
    // 间隔必须抖：固定节奏是机器特征
    await sleep(1100 + Math.round(Math.random() * 800));
    const more = notesFromCap();
    if (more.length > notes.length) {
      notes = more;
      stall = 0;
    } else if (++stall >= 2) {
      break; // 连续两轮没有新笔记，就是没有更多了
    }
  }

  const totalNow = totalInPage();

  out.login = true;
  out.identity = {
    nickname: String(d.name || ''),
    handle: String(d.red_num || ''),
    // personal_info 不返回稳定的用户 id（red_num 是「小红书号」，可以改），
    // 所以 uid 留空，不拿它冒充身份锚点 —— 否则改个小红书号就会被当成串号。
    uid: '',
    avatar: String(d.avatar || '')
  };
  out.account = { followers: d.fans_count == null ? null : Number(d.fans_count) };
  out.worksTotal = totalNow != null ? totalNow : notes.length;
  out.works = notes.map((n) => ({
    platWorkId: String(n.id || ''),
    title: String(n.display_title || n.title || '').slice(0, 300),
    publishedAt: String(n.time || '').slice(0, 10),
    reads: n.view_count == null ? null : Number(n.view_count),
    likes: n.likes == null ? null : Number(n.likes),
    saves: n.collected_count == null ? null : Number(n.collected_count),
    comments: n.comments_count == null ? null : Number(n.comments_count),
    shares: n.shared_count == null ? null : Number(n.shared_count)
  }));
  if (!out.works.length) out.note = '这个号还没有发过笔记';
  return out;
};

/** 数据看板：近 7 日总览。标签是平台自己写在页面上的（观看/点赞/评论/收藏/笔记分享/笔记涨粉）。 */
const xhsOverview = async function () {
  const out = { platform: 'xhs' };
  const text = (document.body && document.body.innerText) || '';
  if (/登录|扫码/.test(text.slice(0, 200)) && !/创作服务平台/.test(text)) {
    out.login = false;
    return out;
  }
  const grab = (label) => {
    // 总览卡片的排版固定是「标签 / 数字 / 环比」
    const m = text.match(new RegExp(label + '\\s*\\n\\s*([0-9][0-9,.]*)\\s*\\n\\s*环比'));
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };
  out.overview = {
    reads: grab('观看'),
    likes: grab('点赞'),
    comments: grab('评论'),
    saves: grab('收藏'),
    shares: grab('笔记分享'),
    newFollowers: grab('笔记涨粉')
  };
  return out;
};

// ---------------------------------------------------------------- 抖音
/**
 * 作品管理页 + 数据总览接口。
 *   /janus/douyin/creator/pc/work_list   作品列表，每条带 statistics 全套数字
 *   /janus/douyin/creator/data/overview/dashboard        近 7 天播放/点赞
 *   /janus/douyin/creator/data/overview/dashboard/fans   总粉丝（total_fans_cnt）
 * 这三个都是创作者后台自己的接口，不需要 a_bogus 签名，带 Cookie 就能取。
 */
const douyin = async function () {
  const out = { platform: 'douyin' };
  const j = async (u) => {
    try {
      const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
      return await r.json();
    } catch {
      return null;
    }
  };
  const pad = (n) => String(n).padStart(2, '0');
  const dstr = (ts) => {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const wl = await j('/janus/douyin/creator/pc/work_list?count=20&cursor=0');
  const list = (wl && wl.aweme_list) || [];
  if (!wl || (wl.status_code != null && wl.status_code !== 0)) {
    out.login = false;
    return out;
  }

  const dash = await j('/janus/douyin/creator/data/overview/dashboard?recent_days=7');
  const fans = await j('/janus/douyin/creator/data/overview/dashboard/fans?recent_days=7');
  const metric = (root, key) => {
    const m = ((root && root.metrics) || []).find((x) => x.english_metric_name === key);
    return m && m.metric_value != null ? Number(m.metric_value) : null;
  };

  // 昵称/头像从自己作品的作者对象取：作品一定是自己的，作者就是登录账号本人
  const author = (list[0] && list[0].author) || {};
  const avatar =
    (author.avatar_thumb && author.avatar_thumb.url_list && author.avatar_thumb.url_list[0]) || '';

  out.login = true;
  out.identity = {
    nickname: String(author.nickname || ''),
    handle: String(author.unique_id || ''),
    uid: String(author.uid || ''),
    avatar: String(avatar || '')
  };
  out.account = {
    followers: metric(fans, 'total_fans_cnt'),
    totalReads: metric(dash, 'play_cnt'),
    totalLikes: metric(dash, 'digg_cnt')
  };
  // 一页 20 条。作品多于 20 的号必须接着翻，否则「已入库」永远差一截，
  // 而平台那边的总数是准的 —— 差的那几条会被当成「这次没读到」，一直不补。
  // 翻页要带抖动：固定节拍是最容易被认出来的机器特征。
  let all = list.slice();
  let total = wl.total == null ? all.length : Number(wl.total);
  let cursor = wl.max_cursor != null ? Number(wl.max_cursor) : all.length;
  for (let i = 0; i < 20 && wl.has_more && all.length < total; i++) {
    await new Promise((r) => setTimeout(r, 600 + Math.round(Math.random() * 900)));
    const next = await j(`/janus/douyin/creator/pc/work_list?count=20&cursor=${cursor}`);
    const arr = (next && next.aweme_list) || [];
    if (!arr.length) break;
    const seen = new Set(all.map((a) => String(a.aweme_id || a.item_id || '')));
    for (const a of arr) {
      const id = String(a.aweme_id || a.item_id || '');
      if (id && !seen.has(id)) all.push(a);
    }
    if (next.total != null) total = Math.max(total, Number(next.total));
    if (next.max_cursor != null && Number(next.max_cursor) !== cursor) cursor = Number(next.max_cursor);
    else cursor += arr.length;
    if (!next.has_more) break;
  }

  out.worksTotal = Math.max(total, all.length);
  if (all.length < total) out.truncated = true;
  out.works = all.map((a) => {
    const s = a.statistics || {};
    return {
      platWorkId: String(a.aweme_id || a.item_id || ''),
      title: String(a.desc || a.item_title || '').slice(0, 300),
      publishedAt: a.create_time ? dstr(a.create_time) : '',
      reads: s.play_count == null ? null : Number(s.play_count),
      likes: s.digg_count == null ? null : Number(s.digg_count),
      comments: s.comment_count == null ? null : Number(s.comment_count),
      shares: s.share_count == null ? null : Number(s.share_count),
      saves: s.collect_count == null ? null : Number(s.collect_count)
    };
  });
  // 「一篇都没有」必须是平台自己报的总数为 0，不能因为某次拿到空列表就这么说
  if (total === 0) out.note = '这个号还没有发布过作品';
  return out;
};

// ---------------------------------------------------------------- 视频号
/**
 * 视频号助手：作品列表走 post/post_list（POST），账号信息走 auth/auth_data。
 * 作品字段：readCount=播放，likeCount=赞，favCount=收藏，forwardCount=转发，fullPlayRate=完播率。
 */
const channels = async function () {
  const out = { platform: 'channels' };
  const post = async (u, body) => {
    try {
      const r = await fetch(u, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      return await r.json();
    } catch {
      return null;
    }
  };
  const pad = (n) => String(n).padStart(2, '0');
  const dstr = (ts) => {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const auth = await post('/cgi-bin/mmfinderassistant-bin/auth/auth_data', {});
  const fu = (auth && auth.data && auth.data.finderUser) || null;
  if (!fu) {
    out.login = false;
    return out;
  }

  const pl = await post('/cgi-bin/mmfinderassistant-bin/post/post_list', {
    pageSize: 20,
    currentPage: 1,
    needPublish: true
  });
  const list = (pl && pl.data && pl.data.list) || [];

  const titleOf = (desc) => {
    let s = '';
    if (!desc) return '';
    if (typeof desc === 'string') {
      try {
        const o = JSON.parse(desc);
        s = String(o.description || o.title || '');
      } catch {
        s = desc;
      }
    } else {
      s = String(desc.description || desc.title || '');
    }
    // 视频号的描述常常是一整篇文案：列表里只留第一行，够认人就行
    return s.split('\n')[0].trim().slice(0, 120);
  };

  out.login = true;
  out.identity = {
    nickname: String(fu.nickname || ''),
    handle: String(fu.uniqId || ''),
    uid: String(fu.finderUsername || '').split('@')[0].slice(0, 40),
    avatar: String(fu.headImgUrl || '')
  };
  out.account = {
    followers: fu.fansCount == null ? null : Number(fu.fansCount)
  };
  // 同样要翻页：pageSize 一页 20 条，总数以平台给的 totalCount 为准
  let all = list.slice();
  let total = pl && pl.data && pl.data.totalCount != null ? Number(pl.data.totalCount) : all.length;
  const seen = new Set(all.map((p) => String(p.objectId || '')));
  for (let page = 2; page <= 25 && all.length < total; page++) {
    await new Promise((r) => setTimeout(r, 600 + Math.round(Math.random() * 900)));
    const more = await post('/cgi-bin/mmfinderassistant-bin/post/post_list', {
      pageSize: 20,
      currentPage: page,
      needPublish: true
    });
    const arr = (more && more.data && more.data.list) || [];
    if (!arr.length) break;
    for (const p of arr) {
      const id = String(p.objectId || '');
      if (id && !seen.has(id)) {
        seen.add(id);
        all.push(p);
      }
    }
    if (more.data.totalCount != null) total = Math.max(total, Number(more.data.totalCount));
  }

  out.worksTotal = Math.max(total, all.length);
  if (all.length < total) out.truncated = true;
  out.works = all.map((p) => ({
    platWorkId: String(p.objectId || ''),
    title: titleOf(p.desc),
    publishedAt: p.createTime ? dstr(p.createTime) : '',
    reads: p.readCount == null ? null : Number(p.readCount),
    likes: p.likeCount == null ? null : Number(p.likeCount),
    saves: p.favCount == null ? null : Number(p.favCount),
    comments: p.commentCount == null ? null : Number(p.commentCount),
    shares: p.forwardCount == null ? null : Number(p.forwardCount),
    completion: p.fullPlayRate == null ? null : Math.round(Number(p.fullPlayRate) * 1000) / 10,
    newFollowers: p.followCount == null ? null : Number(p.followCount),
    extra: p.avgPlayTimeSec == null ? undefined : { avgPlaySec: Math.round(Number(p.avgPlayTimeSec) * 10) / 10 }
  }));
  if (total === 0) out.note = '这个号还没有发表过视频';
  return out;
};

// ---------------------------------------------------------------- B站
/**
 * 三处数据：
 *   /x/web-interface/nav            登录态 + mid + 昵称
 *   /x/relation/stat?vmid=<mid>     粉丝数
 *   /x/web/archives                稿件列表，每条带 stat（播放/点赞/收藏/投币/弹幕/评论/分享）
 */
const bili = async function () {
  const out = { platform: 'bili' };
  const j = async (u) => {
    try {
      const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
      return await r.json();
    } catch {
      return null;
    }
  };
  const pad = (n) => String(n).padStart(2, '0');
  const dstr = (ts) => {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const nav = await j('https://api.bilibili.com/x/web-interface/nav');
  const nd = (nav && nav.data) || null;
  if (!nd || !nd.isLogin) {
    out.login = false;
    return out;
  }

  const rel = await j('https://api.bilibili.com/x/relation/stat?vmid=' + nd.mid);
  const ar = await j(
    'https://member.bilibili.com/x/web/archives?status=is_pubing,pubed,not_pubed&pn=1&ps=20&co=0&interactive=1'
  );
  const audits = ((ar && ar.data && ar.data.arc_audits) || []).slice();
  const cls = (ar && ar.data && ar.data.class) || {};
  let total = Object.keys(cls).reduce((n, k) => n + (Number(cls[k]) || 0), 0);

  // ps=20 一页，稿件多于 20 就必须翻页。class 里的分类合计是平台自己数的总数，
  // 拿它对账：没读够就继续翻，直到读满或平台不再给新条目。
  const seen = new Set(audits.map((a) => String((a.Archive || {}).bvid || (a.Archive || {}).aid || '')));
  for (let pn = 2; pn <= 30 && audits.length < total; pn++) {
    await new Promise((r) => setTimeout(r, 600 + Math.round(Math.random() * 900)));
    const more = await j(
      'https://member.bilibili.com/x/web/archives?status=is_pubing,pubed,not_pubed&pn=' +
        pn +
        '&ps=20&co=0&interactive=1'
    );
    const arr = (more && more.data && more.data.arc_audits) || [];
    if (!arr.length) break;
    for (const a of arr) {
      const A = a.Archive || {};
      const id = String(A.bvid || A.aid || '');
      if (id && !seen.has(id)) {
        seen.add(id);
        audits.push(a);
      }
    }
    const c2 = (more.data && more.data.class) || {};
    const t2 = Object.keys(c2).reduce((n, k) => n + (Number(c2[k]) || 0), 0);
    if (t2 > total) total = t2;
  }

  out.login = true;
  out.identity = {
    nickname: String(nd.uname || ''),
    handle: String(nd.mid || ''),
    uid: String(nd.mid || ''),
    avatar: String(nd.face || '')
  };
  out.account = { followers: rel && rel.data ? Number(rel.data.follower) : null };
  out.worksTotal = Math.max(total, audits.length);
  if (audits.length < total) out.truncated = true;
  out.works = audits.map((a) => {
    const A = a.Archive || {};
    const s = a.stat || A.stat || {};
    return {
      platWorkId: String(A.bvid || A.aid || ''),
      title: String(A.title || '').slice(0, 300),
      publishedAt: A.ptime ? dstr(A.ptime) : '',
      reads: s.view == null ? null : Number(s.view),
      likes: s.like == null ? null : Number(s.like),
      saves: s.favorite == null ? null : Number(s.favorite),
      comments: s.reply == null ? null : Number(s.reply),
      shares: s.share == null ? null : Number(s.share),
      extra: {
        ...(s.coin == null ? {} : { coins: Number(s.coin) }),
        ...(s.danmaku == null ? {} : { danmaku: Number(s.danmaku) })
      }
    };
  });
  if (total === 0) out.note = '这个号还没有投过稿';
  return out;
};

// ---------------------------------------------------------------- 微博
/**
 * 只在「本人主页」这条线上取数，不碰首页信息流。
 *
 * 之前微博被关掉的原因是：weibo.com 首页给已登录用户的是关注流，页面上那些
 * 「989 万粉丝」「85 万粉丝」属于信息流里的博主 —— 连着读两次会读到两个不同的人。
 * 那种数字比没有数据危险得多：看着真实，拿去决策才发现是别人的。
 *
 * 现在改成用登录态自己的 uid 去打两个接口，来源只有本人：
 *   window.$CONFIG.uid                                   —— 页面自己声明的登录 uid
 *   /ajax/profile/info?uid=<uid>                         —— 粉丝、关注、微博数
 *   /ajax/statuses/mymblog?uid=<uid>&page=N&feature=0    —— 本人微博列表，每条带阅读/赞/评/转
 * 这两个接口都只认 Cookie，不需要签名。
 */
const weibo = async function () {
  const out = { platform: 'weibo' };
  const j = async (u) => {
    try {
      const r = await fetch(u, {
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/plain, */*',
          // 微博的 ajax 前缀在没有这个头时会回登录页
          'x-requested-with': 'XMLHttpRequest'
        }
      });
      return await r.json();
    } catch {
      return null;
    }
  };
  const pad = (n) => String(n).padStart(2, '0');
  const dstr = (s) => {
    if (!s) return '';
    // 微博的时间是 "Sat Oct 17 01:50:16 +0800 2026" 这种格式，Date 能直接解析
    const d = new Date(s);
    if (!Number.isFinite(d.getTime())) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const plain = (s) =>
    String(s || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

  const cfg = window.$CONFIG || {};
  const uid = String(cfg.uid || '');
  if (!uid) {
    out.login = false;
    return out;
  }

  const info = await j('https://weibo.com/ajax/profile/info?uid=' + uid);
  const u = (info && info.data && info.data.user) || null;
  if (!u) {
    out.login = false;
    return out;
  }

  // 微博总数以 profile/info 的 statuses_count 为准；mymblog 一页 20 条
  const wantTotal = u.statuses_count == null ? null : Number(u.statuses_count);
  const bag = new Map();
  let pageDone = false;
  for (let page = 1; page <= 30; page++) {
    // 翻页要抖：固定 1 秒一节拍是最容易被认出来的机器特征
    if (page > 1) await new Promise((res) => setTimeout(res, 600 + Math.round(Math.random() * 900)));
    const batch = await j(`https://weibo.com/ajax/statuses/mymblog?uid=${uid}&page=${page}&feature=0`);
    const list = (batch && batch.data && batch.data.list) || [];
    if (!list.length) {
      pageDone = true;
      break;
    }
    for (const m of list) {
      const id = String(m.mblogid || m.id || '');
      if (!id || bag.has(id)) continue;
      bag.set(id, {
        platWorkId: id,
        title: plain(m.text_raw || m.text).slice(0, 300),
        publishedAt: dstr(m.created_at),
        reads: m.reads_count == null ? null : Number(m.reads_count),
        likes: m.attitudes_count == null ? null : Number(m.attitudes_count),
        comments: m.comments_count == null ? null : Number(m.comments_count),
        shares: m.reposts_count == null ? null : Number(m.reposts_count)
      });
    }
    if (wantTotal != null && bag.size >= wantTotal) {
      pageDone = true;
      break;
    }
  }

  const works = Array.from(bag.values());
  out.login = true;
  out.identity = {
    nickname: String(u.screen_name || ''),
    handle: String(u.id || uid),
    uid: String(u.id || uid),
    avatar: String(u.avatar_large || u.profile_image_url || '')
  };
  out.account = {
    followers: u.followers_count == null ? null : Number(u.followers_count)
  };
  out.worksTotal = wantTotal != null ? Math.max(wantTotal, works.length) : works.length;
  out.works = works;
  if (!pageDone) out.truncated = true;
  return out;
};

// ---------------------------------------------------------------- 知乎
/**
 *   /api/v4/me                         昵称、头像、url_token
 *   /api/v4/members/<token>            粉丝数（follower_count）
 *   /api/v4/creators/creations/v2/all  内容列表，每条 reaction 里带浏览/赞同/评论
 */
const zhihu = async function () {
  const out = { platform: 'zhihu' };
  const j = async (u) => {
    try {
      const r = await fetch(u, { credentials: 'include', headers: { Accept: 'application/json' } });
      return await r.json();
    } catch {
      return null;
    }
  };
  const pad = (n) => String(n).padStart(2, '0');
  const dstr = (ts) => {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const strip = (html) => String(html || '').replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim();

  // 一次请求就够：带上 include=follower_count 之后 /me 自己就返回粉丝数。
  // 之前另开一次 /members/<token> 是白跑 —— 多一次请求就多一分被风控看见的机会。
  const me = await j('/api/v4/me?include=follower_count');
  if (!me || !me.name) {
    out.login = false;
    return out;
  }
  const token = me.url_token || '';
  let followers = me.follower_count != null ? Number(me.follower_count) : null;
  if (followers == null && token) {
    const member = await j('/api/v4/members/' + encodeURIComponent(token) + '?include=follower_count');
    if (member && member.follower_count != null) followers = Number(member.follower_count);
  }
  const cr = await j('/api/v4/creators/creations/v2/all?offset=0&limit=20&type=all');
  const rows = ((cr && cr.data) || []).slice();
  let ztotal = cr && cr.paging && cr.paging.totals != null ? Number(cr.paging.totals) : rows.length;

  // limit=20，内容多于 20 就要按 offset 往后翻，否则永远少一截
  const zseen = new Set(rows.map((row) => String((row.data || {}).id || (row.data || {}).url_token || '')));
  for (let off = 20; off <= 600 && rows.length < ztotal; off += 20) {
    await new Promise((r) => setTimeout(r, 600 + Math.round(Math.random() * 900)));
    const more = await j(`/api/v4/creators/creations/v2/all?offset=${off}&limit=20&type=all`);
    const arr = (more && more.data) || [];
    if (!arr.length) break;
    for (const row of arr) {
      const d0 = row.data || {};
      const id = String(d0.id || d0.url_token || '');
      if (id && !zseen.has(id)) {
        zseen.add(id);
        rows.push(row);
      }
    }
    if (more.paging && more.paging.totals != null) ztotal = Math.max(ztotal, Number(more.paging.totals));
  }

  out.login = true;
  out.identity = {
    nickname: String(me.name || ''),
    handle: token,
    uid: String(me.id || ''),
    avatar: String(me.avatar_url || '')
  };
  out.account = { followers };
  out.worksTotal = Math.max(ztotal, rows.length);
  if (rows.length < ztotal) out.truncated = true;
  out.works = rows.map((row) => {
    const d = row.data || {};
    const r = row.reaction || {};
    const title =
      row.type === 'pin'
        ? strip(d.content && d.content[0] && d.content[0].content)
        : String(d.title || strip(d.excerpt) || '').slice(0, 300);
    const created = d.created_time || d.created || d.updated_time || d.updated;
    return {
      platWorkId: String(d.id || d.url_token || ''),
      title: String(title || '').slice(0, 300),
      publishedAt: created ? dstr(created) : '',
      reads: r.read_count != null ? Number(r.read_count) : r.view_count != null ? Number(r.view_count) : null,
      likes: r.vote_up_count != null ? Number(r.vote_up_count) : r.like_count != null ? Number(r.like_count) : null,
      saves: r.collect_count == null ? null : Number(r.collect_count),
      comments: r.comment_count == null ? null : Number(r.comment_count),
      shares: r.repin_count == null ? null : Number(r.repin_count)
    };
  });
  if (ztotal === 0) out.note = '这个号还没有发布过内容';
  return out;
};

// ---------------------------------------------------------------- X
/** 第一页：/home 只为拿自己的 handle（左侧「个人资料」入口的链接就是它）。 */
const xHandle = async function () {
  const out = { platform: 'x' };
  const a =
    document.querySelector('[data-testid="AppTabBar_Profile_Link"]') ||
    document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  const href = a ? String(a.getAttribute('href') || '') : '';
  const m = /^\/([A-Za-z0-9_]{1,20})$/.exec(href);
  if (!m) {
    const text = (document.body && document.body.innerText) || '';
    out.login = !/Sign in to X|登录|Log in/.test(text.slice(0, 600));
    return out;
  }
  out.login = true;
  out.ctx = { handle: m[1] };
  return out;
};

/**
 * 第二页 / 第三页：个人主页的「帖子」标签和「回复」标签。
 *
 * 为什么两个标签都要读，不能只读一个：
 *   平台头部那行「6 posts」和任一单个标签都对不上 —— 实测「帖子」标签 2 条、
 *   「回复」标签 6 条，两边不是包含关系。只读其中一个，另一个里的帖子
 *   就会在「这次读全了」的判定里被当成已删除，从表里消失。
 *   两个标签取并集，才是这个号在 X 上的全部内容。
 *
 * 粉丝数仍然只从「xxx Followers」这行读：X 的接口里全是别人的用户对象
 * （推荐关注），只有主页 DOM 上的数字才是自己的。
 */
const xProfile = async function () {
  const out = { platform: 'x' };
  const text = (document.body && document.body.innerText) || '';
  if (/Sign in to X|Log in|登录 X/.test(text.slice(0, 500))) {
    out.login = false;
    return out;
  }

  const num = (s) => {
    if (!s) return null;
    const m = /([\d.,]+)\s*([KMB万亿])?/i.exec(s);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    // 亿 = 1e8。之前写成 1e9，一处「1.2 亿」会读成 12 亿，差十倍
    const unit = (m[2] || '').toUpperCase();
    const mul =
      unit === 'K' || unit === '千'
        ? 1e3
        : unit === '万'
          ? 1e4
          : unit === 'M'
            ? 1e6
            : unit === '亿'
              ? 1e8
              : unit === 'B'
                ? 1e9
                : 1;
    return Math.round(n * mul);
  };

  // handle 直接取地址里的那一段：这一页就是我们按 handle 打开的主页，
  // 比在整页文字里正则找 @ 稳（导航栏越长，@ 越往后，找一个区间很容易漏）
  const fromPath = String((location.pathname || '').split('/')[1] || '').replace(/[^A-Za-z0-9_]/g, '');
  const hm = /@([A-Za-z0-9_]{1,20})/.exec(text.slice(0, 1200));
  const handle = fromPath || (hm ? hm[1] : '');

  /**
   * 本人那条 UserByScreenName 响应 —— 粉丝数只认它。
   *
   * 两个坑都踩过：
   *   1) 字段搬过家：老版 legacy.followers_count，新版 relationship_counts.followers，
   *      只认一个迟早读空。
   *   2) 这个接口里同时混着「推荐关注」的别人，随手取一条就把别人的粉丝数
   *      记到自己头上（之前 1 → 0 的抖动就是这么来的）。
   *      所以必须 core.screen_name 与当前 handle 完全一致才采用。
   */
  const selfFromApi = () => {
    const key = String(handle || '').toLowerCase();
    if (!key) return null;
    for (const c of window.__cap || []) {
      if (!/UserByScreenName/.test(String(c.url || ''))) continue;
      let j = null;
      try {
        j = JSON.parse(c.body);
      } catch {
        continue;
      }
      const r = j && j.data && j.data.user && j.data.user.result;
      if (!r) continue;
      const screen = String((r.core && r.core.screen_name) || (r.legacy && r.legacy.screen_name) || '');
      if (screen.toLowerCase() !== key) continue;
      const rel = r.relationship_counts || {};
      const lg = r.legacy || {};
      const pick = (a, b) => (a == null ? (b == null ? null : b) : a);
      return {
        followers: pick(rel.followers, lg.followers_count),
        follows: pick(rel.following, lg.friends_count),
        tweets: pick(r.tweet_counts && r.tweet_counts.tweets, lg.statuses_count),
        nickname: String((r.core && r.core.name) || lg.name || '')
      };
    }
    return null;
  };
  const api = selfFromApi();

  // 文案随界面语言变（Followers / 粉丝），两种都要认，否则中文界面直接读空
  const fol = /([\d.,]+\s*[KMB万亿]?)\s*(Followers|粉丝)/i.exec(text);
  const following = /([\d.,]+\s*[KMB万亿]?)\s*(Following|正在关注)/i.exec(text);
  const posts = /([\d.,]+\s*[KMB万亿]?)\s*(posts?|帖子)/i.exec(text);

  const nameEl = document.querySelector('[data-testid="UserName"]');
  let nickname = nameEl ? String(nameEl.innerText || '').split('\n')[0].trim() : '';
  if (!nickname && api && api.nickname) nickname = api.nickname;
  if (!nickname && handle) nickname = handle;

  /**
   * 读某个操作按钮上的计数。
   *
   * 只取「数字 + 对应的词」，不取首数字 ——
   * 一条 aria-label 可能是「75 条回复，查看对话」，首数字确实是 75，
   * 但如果元素选错（或者 X 改了结构），首数字就成了别人的数。
   * 明确要求数字后面跟着「回复/赞/转帖」，读不到就老实返回 null。
   */
  const tweetNum = (a, testid, word) => {
    const el = a.querySelector(`[data-testid="${testid}"]`);
    if (!el) return null;
    const label = String(el.getAttribute('aria-label') || '').trim();
    if (label) {
      const re = new RegExp(`([\\d.,]+)\\s*[KMB万]?\\s*(?:${word})`, 'i');
      const m = re.exec(label);
      // 一个纯操作按钮（还没人赞过）的 label 是「赞」/「Like」，没有数字，那就是 0
      if (m) return num(m[1]);
      if (new RegExp(`^(?:${word})$`, 'i').test(label)) return 0;
    }
    const s = String(el.innerText || '').trim();
    if (!s) return null;
    const m2 = /^([\d.,]+\s*[KMB万]?)/.exec(s);
    return m2 ? num(m2[1]) : null;
  };

  /**
   * 从页面自己的 GraphQL 响应里读「精确数字」。
   *
   * 为什么必须走这条路：DOM 上根本没有两个数 ——
   *   · 引用数（quote_count）在时间线上**不显示**，只在接口里
   *   · 查看次数（views）DOM 上偶尔渲染、滚动走的节点还会丢
   * 而 UserTweets 的响应里两者都是现成的：`views.count` 和 `legacy.quote_count`。
   *
   * 顺便解决「分不清原创/回复/转发」：
   *   · 转发 → 外层对象带 `legacy.retweeted_status_result`
   *   · 回复 → `legacy.in_reply_to_status_id_str` 非空
   *   · 引用 → `legacy.is_quote_status === true` 或带 `quoted_status_result`
   *   · 其余 → 原创
   *
   * 关键一点：**按外层 author 过滤**。转发的对象里同时含原作者的推文，
   * 不过滤就会把别人的帖子算成自己发的（「独角兽要统治世界了吗」那类）。
   */
  const fromCap = () => {
    const mine = new Map();
    const key = String(handle || '').toLowerCase();
    if (!key) return mine;

    const textOf = (lg, res) => {
      // 长推文的完整正文在 note_tweet 里，legacy.full_text 会被截断
      const note = res && res.note_tweet && res.note_tweet.note_tweet_results;
      const long = note && note.result && note.result.text;
      return String(long || (lg && lg.full_text) || '').replace(/\s+/g, ' ').trim();
    };
    const createdAt = (s) => {
      if (!s) return '';
      const d = new Date(s);
      if (!Number.isFinite(d.getTime())) return '';
      const pad2 = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    };
    const userOf = (res) => {
      const u = res && res.core && res.core.user_results && res.core.user_results.result;
      return {
        screen: String((u && u.core && u.core.screen_name) || (u && u.legacy && u.legacy.screen_name) || ''),
        name: String((u && u.core && u.core.name) || (u && u.legacy && u.legacy.name) || '')
      };
    };

    const take = (res) => {
      // TweetWithVisibilityResults 是「带可见性包装」的推文，内容在 .tweet 里；
      // 只认 __typename === 'Tweet' 会把受限可见的帖子整条丢掉
      if (res && res.__typename === 'TweetWithVisibilityResults' && res.tweet) res = res.tweet;
      if (!res || res.rest_id == null || !res.legacy) return;
      const lg = res.legacy;
      const who = userOf(res);
      // 只认自己发的。转发的原帖作者是别人，靠外层 author 才能认出来
      if (who.screen.toLowerCase() !== key) return;

      const id = String(res.rest_id);
      const rt = lg.retweeted_status_result && lg.retweeted_status_result.result;
      let type = 'original';
      let title = textOf(lg, res);
      if (rt) {
        type = 'repost';
        // 转发要显示「原文说了什么」，显示转发者自己的空正文没有意义
        title = textOf(rt.legacy, rt);
      } else if (lg.in_reply_to_status_id_str || lg.in_reply_to_screen_name) {
        type = 'reply';
      } else if (lg.is_quote_status || lg.quoted_status_result) {
        type = 'quote';
      }

      // 新版在 res.views.count；旧版/部分响应在 legacy.ext_views.count。
      // 只认一个会让一半帖子「没有查看数」，而这正是最该有的指标。
      const views =
        res.views && res.views.count != null
          ? Number(res.views.count)
          : lg.ext_views && lg.ext_views.count != null
            ? Number(lg.ext_views.count)
            : null;
      const prev = mine.get(id);
      // 同一条可能被多个响应带回来（首屏 + 翻页），保留数字更全的那一份
      const score = (w) => (w.reads != null ? 2 : 0) + (w.quotes != null ? 1 : 0);
      const cur = {
        platWorkId: id,
        title: String(title || '').slice(0, 300),
        publishedAt: createdAt(lg.created_at),
        reads: views,
        likes: lg.favorite_count == null ? null : Number(lg.favorite_count),
        comments: lg.reply_count == null ? null : Number(lg.reply_count),
        shares: lg.retweet_count == null ? null : Number(lg.retweet_count),
        extra: {
          type,
          // 引用数：时间线上看不见，这是唯一来源
          quotes: lg.quote_count == null ? null : Number(lg.quote_count),
          bookmarks: lg.bookmark_count == null ? null : Number(lg.bookmark_count),
          // 回复对象：知道「我在跟谁说话」，比只看数量有用
          replyTo: lg.in_reply_to_screen_name || '',
          // 转发时记下原作者，列表里才说得清「这是转的谁」
          repostOf: rt ? userOf(rt).screen : ''
        }
      };
      if (!prev || score(cur) >= score(prev)) mine.set(id, cur);
    };

    const walk = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 18) return;
      if (Array.isArray(v)) {
        for (const x of v) walk(x, depth + 1);
        return;
      }
      take(v);
      for (const k of Object.keys(v)) walk(v[k], depth + 1);
    };

    for (const c of window.__cap || []) {
      const u = String(c.url || '');
      if (!/graphql|api\//.test(u)) continue;
      // 只解析推文相关的响应，首页推荐流里的别人也在这里，靠 screen_name 挡掉
      let root = null;
      try {
        root = JSON.parse(c.body);
      } catch {
        continue;
      }
      walk(root, 0);
    }
    return mine;
  };

  /**
   * DOM 兜底：接口没抓到（比如页面复用缓存没发请求）时至少还能拿到数量和类型。
   * 类型靠 socialContext 那行小字判断，中英文都要认。
   */
  const collectTweets = () => {
    const list = [];
    const seen2 = new Set();
    for (const a of Array.from(document.querySelectorAll('article[data-testid="tweet"]'))) {
      const t = a.querySelector('[data-testid="tweetText"]');
      const time = a.querySelector('time');
      const link = a.querySelector('a[href*="/status/"]');
      const href = link ? String(link.getAttribute('href') || '') : '';
      const idm2 = /\/status\/(\d+)/.exec(href);
      if (!idm2 || seen2.has(idm2[1])) continue;

      /**
       * 必须校验作者 —— 这一步之前漏了，代价很重。
       *
       * `with_replies` 页里，每一条「我回复的原帖」也是 article，
       * 而且它的操作栏（75 Replies / 16975 views）就挂在这个 article 里。
       * 不校验作者的话：
       *   · 别人的帖子会被当成我的作品入库（实测把 Miles Ma 的
       *     「整个大活！给吉利做培训」记成了我的，75 条回复也算成我的评论数）
       *   · 那些嵌套文章没有 tweetText，标题就成了空白
       * 也就是说 9 条「我的作品」里有 3 条根本不是我的。
       *
       * 作者的取法：article 内第一个 User-Name 里的第一个 /xxx 链接，
       * 就是这条推文的作者（外层在前）。
       */
      const authorLink = a.querySelector('[data-testid="User-Name"] a[href^="/"]');
      const author = String((authorLink && authorLink.getAttribute('href')) || '')
        .replace(/^\//, '')
        .replace(/\/.*$/, '')
        .toLowerCase();
      const me = String(handle || '').toLowerCase();
      if (me && author && author !== me) continue;
      if (me && !author) continue;

      /**
       * 查看数：必须**整串匹配**，不能包含匹配。
       *
       * 原来写的是 `/查看|Views/i.test(label)` —— 包含匹配。
       * 而中文 X 的回复按钮 aria-label 是「75 条回复，查看对话」这种东西，
       * 也含「查看」两个字 → 找到的是回复按钮，
       * 于是「阅读」和「评论」读到同一个数字（实测 75/75、31/31、15/15，
       * 三个都是阅读==评论，一眼就该看出是同一个来源）。
       *
       * 现在只认「整串就是一个数字 + 查看/views」的元素。
       */
      const viewsEl = Array.from(a.querySelectorAll('[aria-label]')).find((e) =>
        /^[\d.,]+\s*[KMB万]?\s*(?:次查看|次浏览|views?)$/i.test(
          String(e.getAttribute('aria-label') || '').trim()
        )
      );
      const ctxEl = a.querySelector('[data-testid="socialContext"]');
      const ctx = ctxEl ? String(ctxEl.innerText || '') : '';
      // 引用推文：卡片里套了一张带作者名的推文
      const nestedAuthors = a.querySelectorAll('[data-testid="User-Name"]').length;
      let type = 'original';
      if (/已转帖|转推|Reposted/i.test(ctx)) type = 'repost';
      else if (/正在回复|Replying to|回复/i.test(ctx)) type = 'reply';
      else if (nestedAuthors > 1) type = 'quote';

      list.push({
        platWorkId: idm2[1],
        title: t ? String(t.innerText || '').slice(0, 300) : '',
        publishedAt: time ? String(time.getAttribute('datetime') || '').slice(0, 10) : '',
        reads: viewsEl ? num(String(viewsEl.getAttribute('aria-label'))) : null,
        likes: tweetNum(a, 'like', '个赞|赞|likes?'),
        comments: tweetNum(a, 'reply', '条回复|回复|replies|reply'),
        shares: tweetNum(a, 'retweet', '次转帖|转帖|转推|reposts?|retweets?'),
        extra: { type, quotes: null, bookmarks: null, replyTo: '', repostOf: '' }
      });
    }
    return list;
  };

  /**
   * 时间线是虚拟列表：滚过去的节点会被移除。
   * 所以只能「边滚边往篮子里放」，每次重新 collect 再整体覆盖，
   * 滚得越深前面丢得越多 —— 那正是「头部 6 条、列表 2 条」的另一半原因。
   */
  const bag = new Map();
  const absorb = () => {
    // 接口的优先：它有引用数、精确查看数和准确的类型
    for (const [id, w] of fromCap()) {
      const prev = bag.get(id);
      if (!prev) {
        bag.set(id, w);
        continue;
      }
      /**
       * 同一条会出现两次：一次来自 DOM（有赞评转，没引用数），
       * 一次来自接口（有查看数、引用数，但正文可能是空的）。
       * 所以是**逐字段补齐**，不是「看 reads 有没有」——
       * 原来的条件 `w.reads != null && prev.reads == null` 有个死角：
       * DOM 已经给了 reads 时，接口带来的 quotes 永远补不上。
       */
      const merged = Object.assign({}, prev, {
        reads: prev.reads != null ? prev.reads : w.reads,
        likes: prev.likes != null ? prev.likes : w.likes,
        comments: prev.comments != null ? prev.comments : w.comments,
        shares: prev.shares != null ? prev.shares : w.shares,
        // 正文以「更长的那份」为准：接口的 full_text 比 DOM 截断的完整
        title: (w.title || '').length > (prev.title || '').length ? w.title : prev.title,
        publishedAt: prev.publishedAt || w.publishedAt,
        extra: Object.assign({}, w.extra, prev.extra, {
          quotes: prev.extra && prev.extra.quotes != null ? prev.extra.quotes : w.extra.quotes,
          bookmarks: prev.extra && prev.extra.bookmarks != null ? prev.extra.bookmarks : w.extra.bookmarks,
          // 类型只认接口的判断，DOM 的 socialContext 会漏（回复不带那行字）
          type: (w.extra && w.extra.type) || (prev.extra && prev.extra.type) || 'original'
        })
      });
      bag.set(id, merged);
    }
    for (const w of collectTweets()) if (!bag.has(w.platWorkId)) bag.set(w.platWorkId, w);
    return bag.size;
  };
  absorb();

  const want = posts ? num(posts[1]) : null;
  let stall = 0;
  for (let i = 0; i < 5; i++) {
    if (want != null && bag.size >= want) break;
    window.scrollTo(0, document.body.scrollHeight);
    // 固定节拍是机器特征；X 对高频滚动很敏感，间隔必须抖
    await new Promise((r) => setTimeout(r, 1400 + Math.round(Math.random() * 900)));
    const before = bag.size;
    if (absorb() === before) {
      if (++stall >= 2) break; // 连续两轮没有新帖，就是到底了
    } else {
      stall = 0;
    }
  }
  const works = Array.from(bag.values());

  out.login = true;
  out.identity = { nickname, handle, uid: '', avatar: '' };
  out.account = {
    // 接口有就用接口（本人那条），没有再退回主页文字；0 是有效值，不能当「没读到」
    followers: api && api.followers != null ? api.followers : fol ? num(fol[1]) : null,
    follows: api && api.follows != null ? api.follows : following ? num(following[1]) : null
  };
  // 头部那个数字只当参考：两个标签的并集可能比它多（平台自己数的口径不同），
  // 界面上的「作品」绝不能比列出来的条数还少 —— reader 会再兜一次
  out.worksTotal = want != null ? Math.max(want, works.length) : works.length;
  out.works = works;
  // 这里不写「还没有发过帖子」：这一页可能只是没渲染出来，
  // 而另一页明明读到了帖子 —— 那种假话会被存进账号备注，一路显示到界面上。
  // 「一篇都没有」由 reader 按整体结果判断。
  return out;
};

// ---------------------------------------------------------------- YouTube
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

// ---------------------------------------------------------------- Instagram
/**
 * Instagram：API 已经基本不可用了，所以顺序反过来 —— 先 DOM，再页面自己的 GraphQL。
 *
 * 2026-10-24 实测（登录态确实正常）：
 *   i.instagram.com/api/v1/users/<uid>/info/     → 403
 *   www.instagram.com/api/v1/users/<uid>/info/   → 429
 *   /api/v1/accounts/current_user/               → 200，但回的是 HTML
 * 「按 uid 直接打接口」这条路被封了，硬顶只会一直 429。能用的只有两条：
 *
 *   1) 主页 DOM 头部：`ruixuehan213 / Rui / 0帖子 / 0粉丝 / 12关注`
 *      中英文都是这个排版，数字就在文字里，比接口还准。
 *   2) 页面加载主页时自己发的 /api/graphql 响应里有 follower_count 和每条帖子的
 *      点赞/评论数 —— 从 window.__cap 拿，不需要伪造签名。
 *
 * 两处都拿不到才报「读不到」，绝不用猜的。
 * 身份不认「页面上第一个像用户名的链接」，那多半是推荐账号；只认当前这一页
 * 确实是自己主页（有「编辑主页」/「分享首张照片」这类只有本人才看得见的按钮）。
 */
const igHandle = async function () {
  /**
   * 第一步：只回答「我是哪个号」。
   *
   * 为什么必须单独一页：IG 首页的时间线里全是别人的帖子和推荐账号，
   * 直接在首页读，粉丝数随时可能记到 cristiano 头上。
   * 这里只做一件事 —— 从导航里找出指向自己的那条链接。
   *
   * 认人的依据：IG 左侧导航第一组里必定有一个 `/xxx/` 且带头像 img 的链接，
   * 那就是 Profile。推荐账号也会带头像，但它们出现在时间线里、排在后面，
   * 所以「导航内 + 带 img + 第一个」这三条一起用才稳。
   */
  const out = { platform: 'ig' };
  const dsUid = (String(document.cookie || '').match(/ds_user_id=(\d+)/) || [])[1] || '';
  if (!dsUid) {
    out.login = false;
    return out;
  }

  const skip = new Set([
    'explore', 'reels', 'direct', 'accounts', 'emails', 'challenge', 'developer', 'about',
    'legal', 'api', 'privacy', 'terms', 'directory', 'web', 'lite', 'your_activity',
    'session', 'oauth', 'stories', 'create', 'topics', 'popular', 'p', 'reel'
  ]);
  const scopes = [
    ...document.querySelectorAll('nav a[href], [role="navigation"] a[href]'),
    ...document.querySelectorAll('a[href]')
  ];
  let handle = '';
  for (const a of scopes) {
    const m = /^\/([A-Za-z0-9._]{2,30})\/?$/.exec(String(a.getAttribute('href') || ''));
    if (!m || skip.has(m[1].toLowerCase())) continue;
    // 必须有头像图：导航里指向自己的那条一定带头像
    if (!a.querySelector('img')) continue;
    handle = m[1];
    break;
  }

  if (!handle) {
    // 兜底：地址栏本身就在某人主页时，用路径那一段（只有确实是自己主页才算）
    const pathUser = String((location.pathname || '').split('/')[1] || '').replace(/[^A-Za-z0-9._]/g, '');
    const t = (document.body && document.body.innerText) || '';
    if (pathUser && /编辑主页|Edit profile|分享首张照片|Share your first photo/i.test(t)) handle = pathUser;
  }

  out.login = true;
  if (!handle) {
    out.note = '登录态是好的，但导航里没找到自己的主页入口';
    return out;
  }
  out.ctx = { handle };
  out.identity = { nickname: '', handle, uid: dsUid, avatar: '' };
  return out;
};

const instagram = async function () {
  const out = { platform: 'ig' };
  const APP_ID = '936619743392459';
  const j = async (u) => {
    try {
      const r = await fetch(u, {
        credentials: 'include',
        headers: { 'x-ig-app-id': APP_ID, Accept: '*/*' }
      });
      const t = await r.text();
      if (!t || t.charAt(0) !== '{') return null; // HTML / 空 → 被拦
      return JSON.parse(t);
    } catch {
      return null;
    }
  };

  const text = (document.body && document.body.innerText) || '';
  const selfUid = () => {
    const c = (String(document.cookie || '').match(/ds_user_id=(\d+)/) || [])[1];
    if (c) return c;
    for (const x of window.__cap || []) {
      const m = /"ds_user_id"\s*:\s*"?(\d+)/.exec(String(x.body || ''));
      if (m) return m[1];
    }
    return '';
  };
  const dsUid = selfUid();
  if (!dsUid) {
    out.login = false;
    return out;
  }

  const pathUser = String((location.pathname || '').split('/')[1] || '').replace(/[^A-Za-z0-9._]/g, '');
  // 这几个按钮只有本人看自己的主页时才有 —— 用它确认「这页就是我」
  const onOwnProfile =
    !!pathUser && /编辑主页|Edit profile|分享首张照片|Share your first photo|你的快拍|Your story/i.test(text);

  /** DOM 头部那几个数字。`0帖子` 和 `0 帖子` 都可能出现，中英文都要认 */
  const domCounts = () => {
    const n = (s) => {
      if (!s) return null;
      const m = /([\d.,]+)\s*([KMB万]?)/i.exec(s);
      if (!m) return null;
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (!Number.isFinite(v)) return null;
      const un = (m[2] || '').toUpperCase();
      const mul = un === 'K' ? 1e3 : un === 'M' ? 1e6 : un === 'B' ? 1e9 : un === '万' ? 1e4 : 1;
      return Math.round(v * mul);
    };
    const grab = (re) => {
      const m = re.exec(text);
      return m ? n(m[1]) : null;
    };
    return {
      media: grab(/([\d.,]+\s*[KMB万]?)\s*(?:帖子|posts?)/i),
      followers: grab(/([\d.,]+\s*[KMB万]?)\s*(?:粉丝|followers?)/i),
      following: grab(/([\d.,]+\s*[KMB万]?)\s*(?:关注|following)/i)
    };
  };

  /** 页面自己的 GraphQL 响应：唯一还能拿到精确数字和单帖指标的通道 */
  /**
   * 从页面自己的响应里翻出「本人」的资料和帖子。
   *
   * 2026-10-24 实测（在 ruixuehan213 主页上）发现两个关键事实：
   *
   * 1) 帖子数据**不在 `/api/graphql`**，而在 `/graphql/query`。
   *    原来的判断是 `/graphql/.test(url)`，理论上两个都匹配 ——
   *    但字段名对不上：`/api/graphql` 里的媒体是 `shortcode`，
   *    而 `/graphql/query` 里是 **`code`**，类型是 `XDTMediaDict`。
   *    只认 shortcode 的话，真帖子一条都进不来。
   *
   * 2) 同一个响应里**混着别人的帖子**（探索/推荐流）：
   *    实测 5 个节点只有 1 个是本人的（user.username === ruixuehan213），
   *    其余是 cristiano（344 万赞）、nasa 之类。
   *    **必须按 node.user.username 过滤**，否则粉丝数会记到别人头上、
   *    作品列表里全是别人的爆款。
   *
   * 字段对应（XDTMediaDict）：
   *   code          短码，用来拼 /reel/<code>/ 或 /p/<code>/
   *   like_count    点赞
   *   comment_count 评论
   *   play_count    播放（reel/视频才有）
   *   taken_at      发布时间（秒）
   *   caption.text  正文
   *   product_type  clips=短视频 / carousel_container=多图 / feed=普通
   */
  const fromGraphql = () => {
    const found = { user: null, works: [] };
    const bag = new Map();
    const me = String(onOwnProfile ? pathUser : '').toLowerCase();

    // 本人身份：先记住，后面用来过滤帖子
    for (const c of window.__cap || []) {
      let root = null;
      try {
        root = JSON.parse(c.body);
      } catch {
        continue;
      }
      const findUser = (v, depth) => {
        if (!v || typeof v !== 'object' || depth > 16 || found.user) return;
        if (Array.isArray(v)) {
          for (const x of v) findUser(x, depth + 1);
          return;
        }
        // 同时带 follower_count 和 username 的对象就是账号本体
        if (v.follower_count != null && v.username) {
          const name = String(v.username).toLowerCase();
          // 有当前页 handle 时只认它，避免把推荐位里的账号当成自己
          if (!me || name === me) {
            found.user = {
              username: String(v.username),
              full_name: String(v.full_name || ''),
              followers: Number(v.follower_count),
              following: v.following_count == null ? null : Number(v.following_count),
              media: v.media_count == null ? null : Number(v.media_count)
            };
            return;
          }
        }
        for (const k of Object.keys(v)) findUser(v[k], depth + 1);
      };
      findUser(root, 0);
    }

    // 过滤帖子时用哪个 handle：优先「当前页路径」，其次接口给的
    const selfName = String(me || (found.user && found.user.username) || '').toLowerCase();
    if (!selfName) {
      // 连自己是谁都不知道，就别猜 —— 猜错等于把别人的帖子记成自己的
      return found;
    }

    for (const c of window.__cap || []) {
      if (!/graphql/.test(String(c.url || ''))) continue;
      let root = null;
      try {
        root = JSON.parse(c.body);
      } catch {
        continue;
      }
      const walk = (v, depth) => {
        if (!v || typeof v !== 'object' || depth > 16) return;
        if (Array.isArray(v)) {
          for (const x of v) walk(x, depth + 1);
          return;
        }
        // 两种结构都认：新版 code，旧版 shortcode
        const code = v.code || v.shortcode;
        if (code) {
          const owner = String((v.user && v.user.username) || '').toLowerCase();
          // 关键：只收本人的。别人的爆款混进来是最难发现的数据错误
          if (owner && owner === selfName) {
            const id = String(code);
            if (!bag.has(id)) {
              const capText =
                (v.caption && (v.caption.text || v.caption)) ||
                (v.edge_media_to_caption &&
                  v.edge_media_to_caption.edges &&
                  v.edge_media_to_caption.edges[0] &&
                  v.edge_media_to_caption.edges[0].node &&
                  v.edge_media_to_caption.edges[0].node.text) ||
                '';
              const taken = v.taken_at != null ? Number(v.taken_at) : v.taken_at_timestamp;
              /**
               * mediaId 是调「帖子详情」用的键，格式 `<pk>_<uid>`。
               * 主页列表不返回播放量，必须拿它去问 /api/v1/media/<id>/info/。
               */
              const ownerId = String((v.user && (v.user.pk || v.user.id)) || '');
              const mediaId =
                String(v.id || '') ||
                (v.pk && ownerId ? `${v.pk}_${ownerId}` : '');
              bag.set(id, {
                platWorkId: id,
                mediaId,
                title: String(typeof capText === 'string' ? capText : '')
                  .replace(/\s+/g, ' ')
                  .slice(0, 300),
                publishedAt: taken ? new Date(Number(taken) * 1000).toISOString().slice(0, 10) : '',
                // 播放只有 reel / 视频有；图文留 null（不是 0）
                reads:
                  v.play_count != null
                    ? Number(v.play_count)
                    : v.video_play_count != null
                      ? Number(v.video_play_count)
                      : v.view_count != null
                        ? Number(v.view_count)
                        : null,
                likes:
                  v.like_count != null
                    ? Number(v.like_count)
                    : v.edge_liked_by
                      ? Number(v.edge_liked_by.count)
                      : null,
                comments:
                  v.comment_count != null
                    ? Number(v.comment_count)
                    : v.edge_media_to_comment
                      ? Number(v.edge_media_to_comment.count)
                      : null,
                shares: null,
                saves: null,
                extra: {
                  // 让界面能区分短视频和图文（IG 两种东西的指标含义不同）
                  kind:
                    v.product_type === 'clips'
                      ? 'reel'
                      : v.product_type === 'carousel_container'
                        ? 'album'
                        : 'post'
                }
              });
            }
          }
        }
        for (const k of Object.keys(v)) walk(v[k], depth + 1);
      };
      walk(root, 0);
    }
    found.works = Array.from(bag.values());
    return found;
  };

  const dom = domCounts();
  const gql = fromGraphql();

  /**
   * 补齐每条帖子的播放量。
   *
   * 为什么要额外一趟：主页的 GraphQL 列表只给 like_count / comment_count，
   * **view_count 永远是 null**；播放量在「帖子详情」接口里：
   *   GET /api/v1/media/<pk>_<uid>/info/  →  play_count / ig_play_count / content_views_count
   * 实测自己那条 reel 主页读到 view_count=null，详情接口里 play_count=148。
   * 也就是说「自己能看到浏览」是真的，只是要看对地方。
   *
   * 两条纪律：
   *   · **限条数**（最多 20 条）：每条一次请求，全量跑大号会被风控。
   *     超出的标 truncated，不谎称读全了。
   *   · **间隔抖动** 700~1500ms：固定节拍是机器特征。
   *   · 单条失败不影响其它条，读不到就留 null，不猜。
   */
  let enriched = 0;
  let enrichTruncated = false;
  {
    const MAX_DETAIL = 20;
    for (let i = 0; i < gql.works.length; i++) {
      const w = gql.works[i];
      if (!w.mediaId) continue;
      if (enriched >= MAX_DETAIL) {
        enrichTruncated = true;
        break;
      }
      // 页面自己已经发过这条的 info 请求时，先看 __cap 里有没有现成的（省一次请求）
      let it = null;
      for (const c of window.__cap || []) {
        const u = String(c.url || '');
        if (!u.includes('/media/' + w.mediaId + '/info')) continue;
        try {
          const j2 = JSON.parse(c.body);
          it = j2 && j2.items && j2.items[0] ? j2.items[0] : null;
        } catch {
          it = null;
        }
        if (it) break;
      }
      if (!it) {
        await new Promise((r) => setTimeout(r, 700 + Math.round(Math.random() * 800)));
        const info = await j('https://www.instagram.com/api/v1/media/' + w.mediaId + '/info/');
        it = info && info.items && info.items[0] ? info.items[0] : null;
      }
      enriched++;
      if (!it) continue;
      // 三个字段是同一件事的不同叫法，按优先级取第一个有值的
      const play =
        it.play_count != null
          ? Number(it.play_count)
          : it.ig_play_count != null
            ? Number(it.ig_play_count)
            : it.content_views_count != null
              ? Number(it.content_views_count)
              : null;
      if (play != null) w.reads = play;
      if (it.like_count != null) w.likes = Number(it.like_count);
      if (it.comment_count != null) w.comments = Number(it.comment_count);
      // 保存/分享：IG 只对自己的内容给这两个数
      if (it.save_count != null) w.saves = Number(it.save_count);
      if (it.share_count != null) w.shares = Number(it.share_count);
    }
  }
  // 在自己主页上就别再打那个必 429 的接口了，白白多一次风控计数
  const api = onOwnProfile ? null : await j('https://www.instagram.com/api/v1/users/' + dsUid + '/info/');
  const apiUser = api && api.user ? api.user : null;

  const username =
    (gql.user && gql.user.username) || (apiUser && apiUser.username) || (onOwnProfile ? pathUser : '');
  const pick = (...vals) => {
    for (const v of vals) if (v != null) return v;
    return null;
  };
  const followers = pick(gql.user && gql.user.followers, apiUser && apiUser.follower_count, dom.followers);
  const mediaTotal = pick(gql.user && gql.user.media, apiUser && apiUser.media_count, dom.media);

  if (!username && followers == null && mediaTotal == null) {
    out.login = true;
    out.note = '登录态是好的，但这一页既没资料也没帖子（接口被限流，换个页面再试）';
    return out;
  }

  const works = gql.works;
  out.login = true;
  out.identity = {
    nickname: String((gql.user && gql.user.full_name) || (apiUser && apiUser.full_name) || username || ''),
    handle: String(username || ''),
    uid: dsUid,
    avatar: ''
  };
  out.account = { followers: followers == null ? null : Number(followers) };
  out.worksTotal = mediaTotal != null ? Math.max(Number(mediaTotal), works.length) : works.length;
  out.works = works;
  // 帖子总数没读到、或详情没跑完，都别声称「读全了」—— 否则会把还在的帖子判成已删除
  if (mediaTotal == null || enrichTruncated) out.truncated = true;
  if (mediaTotal === 0) out.note = '这个号还没有发过内容';
  return out;
};

// ---------------------------------------------------------------- Threads
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

// ---------------------------------------------------------------- TikTok
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

// ---------------------------------------------------------------- 注册表
const COLLECTORS = {
  gzh: {
    pages: [
      { url: 'https://mp.weixin.qq.com/', fn: gzhAccount },
      {
        url: (ctx) =>
          `https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&token=${encodeURIComponent(ctx.token || '')}&lang=zh_CN`,
        fn: gzhWorks,
        // token 没拿到就别开这一页（会落到登录页，白跑一趟）
        when: (ctx) => !!ctx.token
      }
    ]
  },
  xhs: {
    pages: [
      { url: 'https://creator.xiaohongshu.com/new/note-manager', fn: xhsWorks },
      { url: 'https://creator.xiaohongshu.com/statistics/account', fn: xhsOverview }
    ]
  },
  douyin: {
    pages: [{ url: 'https://creator.douyin.com/creator-micro/content/manage', fn: douyin }]
  },
  channels: {
    pages: [{ url: 'https://channels.weixin.qq.com/platform/post/list', fn: channels }]
  },
  bili: {
    pages: [{ url: 'https://member.bilibili.com/platform/home', fn: bili }]
  },
  zhihu: {
    pages: [{ url: 'https://www.zhihu.com/creator/manage/creation/all', fn: zhihu }]
  },
  weibo: {
    // 只在本人主页那条线上取数：$CONFIG.uid → profile/info + mymblog
    pages: [{ url: 'https://weibo.com/', fn: weibo }]
  },
  x: {
    pages: [
      { url: 'https://x.com/home', fn: xHandle },
      // 两个标签各读一次再取并集：只读一个会把另一个里的帖子当成已删除
      {
        url: (ctx) => `https://x.com/${encodeURIComponent(ctx.handle || '')}`,
        fn: xProfile,
        when: (ctx) => !!ctx.handle
      },
      {
        url: (ctx) => `https://x.com/${encodeURIComponent(ctx.handle || '')}/with_replies`,
        fn: xProfile,
        when: (ctx) => !!ctx.handle
      }
    ]
  },
  yt: {
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
  },
  ig: {
    // 两步：首页只用来认「我是哪个号」，自己的主页才读数字。
    // 合成一步做过，结果是在时间线里读到了别人的粉丝数。
    pages: [
      { url: 'https://www.instagram.com/', fn: igHandle },
      {
        url: (ctx) => `https://www.instagram.com/${encodeURIComponent(ctx.handle || '')}/`,
        fn: instagram,
        when: (ctx) => !!ctx.handle
      }
    ]
  },
  threads: {
    pages: [
      // 第一页只为拿 handle（左侧导航指向自己的链接），第二页才读帖子
      { url: 'https://www.threads.com/', fn: threadsHandle },
      {
        url: (ctx) => `https://www.threads.com/@${encodeURIComponent(ctx.handle || '')}`,
        fn: threadsProfile,
        when: (ctx) => !!ctx.handle
      }
    ]
  },
  tiktok: {
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
  }
};

function getCollector(key) {
  return COLLECTORS[key] || null;
}

// 给测试用：验证每个页面脚本都能被序列化成可执行字符串
function scriptOf(fn) {
  return `(${fn.toString()})()`;
}

module.exports = { COLLECTORS, getCollector, scriptOf };
