'use strict';
/**
 * Instagram · 页面内取数脚本
 *
 * 这些函数会被 toString() 成字符串注入到平台页面里执行（见 lib/reader.js 的 scriptOf），
 * 所以铁律：**函数体不能引用文件外的东西**，连本文件里别的 const 也不行。
 * 需要小工具就写在函数体里面 —— test/scripts.test.js 会盯着这条。
 */

/**
 * Instagram：API 已经基本不可用了，所以顺序反过来 —— 先 DOM，再页面自己的 GraphQL。
 *
 * 2026-10-24 实测（登录态确实正常）：
 *   i.instagram.com/api/v1/users/<uid>/info/     → 403
 *   www.instagram.com/api/v1/users/<uid>/info/   → 429
 *   /api/v1/accounts/current_user/               → 200，但回的是 HTML
 * 「按 uid 直接打接口」这条路被封了，硬顶只会一直 429。能用的只有两条：
 *
 *   1) 主页 DOM 头部：`示例handle / 示例昵称 / 0帖子 / 0粉丝 / 12关注`
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
   * 2026-10-24 实测（在某个个人号主页上）发现两个关键事实：
   *
   * 1) 帖子数据**不在 `/api/graphql`**，而在 `/graphql/query`。
   *    原来的判断是 `/graphql/.test(url)`，理论上两个都匹配 ——
   *    但字段名对不上：`/api/graphql` 里的媒体是 `shortcode`，
   *    而 `/graphql/query` 里是 **`code`**，类型是 `XDTMediaDict`。
   *    只认 shortcode 的话，真帖子一条都进不来。
   *
   * 2) 同一个响应里**混着别人的帖子**（探索/推荐流）：
   *    实测 5 个节点只有 1 个是本人的（user.username === 本人 handle），
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

module.exports = {
  key: 'ig',
  name: 'Instagram',
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
};
