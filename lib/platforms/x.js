'use strict';
/**
 * X · 页面内取数脚本
 *
 * 这些函数会被 toString() 成字符串注入到平台页面里执行（见 lib/reader.js 的 scriptOf），
 * 所以铁律：**函数体不能引用文件外的东西**，连本文件里别的 const 也不行。
 * 需要小工具就写在函数体里面 —— test/scripts.test.js 会盯着这条。
 */

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
      /**
       * 单位必须**一起捕获**再交给 num()。
       *
       * 以前写成 `([\d.,]+)\s*[KMB万]?\s*(?:赞)`，单位在捕获组外面，
       * `num(m[1])` 只拿到「1.2」，单位丢了 —— 一条「1.2 万次喜欢」会被记成 1，
       * 而且是安安静静记成 1，谁也不会怀疑。数字越小越难发现。
       */
      const re = new RegExp(`([\\d.,]+)\\s*([KMB万亿千])?\\s*(?:${word})`, 'i');
      const m = re.exec(label);
      // 一个纯操作按钮（还没人赞过）的 label 是「赞」/「Like」，没有数字，那就是 0
      if (m) return num(m[1] + (m[2] || ''));
      if (new RegExp(`^(?:${word})$`, 'i').test(label)) return 0;
    }
    const s = String(el.innerText || '').trim();
    if (!s) return null;
    const m2 = /^([\d.,]+\s*[KMB万亿千]?)/.exec(s);
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
   * 不过滤就会把别人的帖子算成自己发的（推荐流里的爆款那类）。
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
  // 头部读不到「N posts」时不写：留空 = reader 判「没读全」，一条都不会误标删除。
  // 写成 works.length 等于声称「这次读到的就是全部」，两页都没渲染出来时会把整库推文清空。
  // 只报页面自己写的条数。取 Math.max(want, works.length) 会把总数抬成读到条数，
  // reader 的逐页对账 `got >= total` 于是恒真 —— 读少一半也判「读全了」，接着就误删。
  //
  // `want >= works.length` 是第二道保险：既然并集本来就可能比头部数字多，
  // 那「总数比读到的还少」就是口径不一致的确凿信号。这种数不能拿去做对账，
  // 否则并集之外的那几条会被判成已删除。不报 = 没读全 = 一条不删。
  if (want != null && want >= works.length) out.worksTotal = want;
  out.works = works;
  // 这里不写「还没有发过帖子」：这一页可能只是没渲染出来，
  // 而另一页明明读到了帖子 —— 那种假话会被存进账号备注，一路显示到界面上。
  // 「一篇都没有」由 reader 按整体结果判断。
  return out;
};

module.exports = {
  key: 'x',
  name: 'X',
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
};
