'use strict';
/**
 * 平台适配器 · 数据定义
 *
 * 这里只放「数据」，不放逻辑。逻辑在 reader.js。
 * 目的：平台改版时只改这个文件（或外部覆盖的 JSON），不用碰代码。
 *
 * 字段说明
 *   key           内部标识，也用于分区名前缀 persist:acct-<key>-<序号>
 *   name          界面上显示的名字，也是 accounts.plat 存的值
 *   icon          前端图标键，对应 ui/icons.js 里的图形
 *   brand         品牌色，只用于图标底色与悬停微光，不当强调色用
 *   region        cn / global，只影响排序分组
 *   mode          读数通道
 *                   web    = 已登录页面直接读（默认）
 *                   cookie = 从系统浏览器导入 Cookie 后读
 *                   api    = 走官方 API
 *   pages         后台地址；detail 为 null 表示不单独访问详情页
 *   caps.account  账号级能读到的指标
 *   caps.work     作品级能读到的指标（列表页通常就能给）
 *   caps.extra    该平台独有的指标，存进 work_metrics.extra（JSON）
 *   paceMin       同一个号在这个平台两次读数的最小硬间隔（分钟），防误触连点
 *   verifiedAt    最后一次人工实测的日期；空的表示还没验过
 *
 * ⚠ caps 的含义是「这个平台真的给不给你」，不是「我们想不想读」。
 *   界面按这个决定显示哪些列 —— 小红书没有完播率就不该显示完播率那一列。
 *
 * ⚠ 没实测过的平台把 disabled 打开，读数入口直接关掉。
 *   宁可少读一个平台，也不能让界面上出现来源不明的数字。
 */

const CN = 'cn';
const GLOBAL = 'global';

const PLATFORMS = [
  // ============================================================ 国内
  {
    key: 'gzh',
    name: '公众号',
    icon: 'gzh',
    brand: '#07C160',
    region: CN,
    mode: 'web',
    pages: {
      account: 'https://mp.weixin.qq.com/',
      // 公众号后台没有「作品列表页」这东西：近期发表和完整列表都是首页那个
      // appmsgpublish 接口给的。单独再开一页只是多一次请求，什么也读不到。
      works: null,
      detail: null
    },
    /**
     * 数字全部来自「发表记录」页：那个页面每篇文章都带
     * appmsg-view / appmsg-like / appmsg-share / appmsg-haokan / appmsg-comment 五个类名，
     * 是平台自己标的指标名，不是我们猜的。接口 appmsgpublish 只给标题和时间。
     */
    caps: {
      account: ['followers'],
      work: ['reads', 'likes', 'comments', 'shares'],
      extra: ['recommend']
    },
    listPageSize: 20,
    paceMin: 8,
    verifiedAt: '2026-10',
    notes: '粉丝数来自后台首页；每篇文章的阅读、点赞、评论、分享、推荐来自「发表记录」页。'
  },

  {
    key: 'xhs',
    name: '小红书',
    icon: 'xhs',
    brand: '#FF2442',
    region: CN,
    mode: 'web',
    pages: {
      account: 'https://creator.xiaohongshu.com/new/note-manager',
      works: null,
      detail: null
    },
    /**
     * 粉丝/获赞来自 personal_info（fans_count 是累计关注数）；
     * 观看/点赞等来自数据看板的「近 7 日」总览 —— 两处口径不同，标签已分开。
     */
    caps: {
      account: ['followers', 'totalReads', 'totalLikes'],
      work: ['reads', 'likes', 'saves', 'comments', 'shares'],
      extra: []
    },
    listPageSize: 20,
    paceMin: 20,
    overviewWindow: '7d',
    verifiedAt: '2026-10',
    notes:
      '粉丝数是累计关注数；观看/点赞等概览是「近 7 日」口径，标签已按 7 天写。' +
      '每条笔记的阅读、点赞、收藏、评论、分享来自笔记管理列表。'
  },

  {
    key: 'douyin',
    name: '抖音',
    icon: 'douyin',
    brand: '#FE2C55',
    region: CN,
    mode: 'web',
    pages: {
      account: 'https://creator.douyin.com/creator-micro/content/manage',
      works: null,
      detail: null
    },
    caps: {
      account: ['followers', 'totalReads', 'totalLikes'],
      work: ['reads', 'likes', 'saves', 'comments', 'shares'],
      extra: []
    },
    listPageSize: 20,
    paceMin: 20,
    // 数据中心的概览是「近 7 日」，不是累计 —— 标签要如实写
    overviewWindow: '7d',
    verifiedAt: '2026-10',
    notes:
      '粉丝数是累计值；播放/点赞是「近 7 日」口径。' +
      '每条作品的播放、点赞、评论、分享、收藏来自作品列表接口。'
  },

  {
    key: 'channels',
    name: '视频号',
    icon: 'channels',
    brand: '#FA9D3B',
    region: CN,
    mode: 'web',
    pages: {
      account: 'https://channels.weixin.qq.com/platform/post/list',
      works: null,
      detail: null
    },
    caps: {
      account: ['followers'],
      work: ['reads', 'likes', 'saves', 'comments', 'shares', 'completion', 'newFollowers'],
      extra: ['avgPlaySec']
    },
    listPageSize: 20,
    paceMin: 15,
    verifiedAt: '2026-10',
    notes: '关注者、视频数来自账号信息；每条视频带播放/点赞/收藏/转发/评论/完播率/涨粉。'
  },

  // ------------------------------------------------------------ 微博
  {
    key: 'weibo',
    name: '微博',
    icon: 'weibo',
    brand: '#E6162D',
    region: CN,
    mode: 'web',
    pages: {
      // data.weibo.com 对没有「数据中心」权限的号会无限重定向（ERR_TOO_MANY_REDIRECTS），
      // 落到 weibo.com 反而稳：页面里的 $CONFIG.uid 就是登录者本人的 uid，
      // 后面两个接口都按 uid 取，不读页面上任何「别人的数字」
      account: 'https://weibo.com/',
      works: null,
      detail: null,
      login: 'https://weibo.com/login.php'
    },
    authCookie: { url: 'https://weibo.com', name: 'SUB' },
    caps: {
      account: ['followers', 'worksTotal'],
      // 微博后台不常规给「收藏」，先不假装有
      work: ['reads', 'likes', 'comments', 'shares'],
      extra: []
    },
    listPageSize: 20,
    paceMin: 20,
    verifiedAt: '2026-10',
    notes: '粉丝、微博数来自本人资料接口；每条微博带阅读、赞、评论、转发。'
  },

  // ------------------------------------------------------------ 知乎
  {
    key: 'zhihu',
    name: '知乎',
    icon: 'zhihu',
    brand: '#0084FF',
    region: CN,
    mode: 'web',
    pages: {
      account: 'https://www.zhihu.com/creator/manage/creation/all',
      works: null,
      detail: null
    },
    caps: {
      account: ['followers'],
      work: ['reads', 'likes', 'comments'],
      extra: []
    },
    listPageSize: 20,
    paceMin: 20,
    verifiedAt: '2026-10',
    notes: '粉丝数来自用户资料接口；内容列表里每条带浏览、赞同、评论。'
  },

  {
    key: 'bili',
    name: 'B站',
    icon: 'bili',
    brand: '#00A1D6',
    region: CN,
    mode: 'web',
    pages: {
      account: 'https://member.bilibili.com/platform/home',
      works: null,
      detail: null
    },
    caps: {
      account: ['followers'],
      // 投币、弹幕是 B站独有的
      work: ['reads', 'likes', 'saves', 'comments', 'shares'],
      extra: ['coins', 'danmaku']
    },
    listPageSize: 20,
    paceMin: 15,
    verifiedAt: '2026-10',
    notes: '粉丝数来自关系接口；稿件列表每条带播放/点赞/收藏/评论/分享，外加投币和弹幕。'
  },

  // ============================================================ 海外
  {
    key: 'x',
    name: 'X',
    icon: 'x',
    brand: '#E7E9EA',
    // 近白品牌色在浅色主题下会隐形，浅色模式用深色版
    brandLight: '#0F1419',
    region: GLOBAL,
    mode: 'web',
    pages: {
      account: 'https://x.com/home',
      works: null,
      detail: null,
      // 未登录直接开数据页会被甩到中间页，先给登录页，路径最短
      login: 'https://x.com/i/flow/login'
    },
    // 判断「这个环境到底登没登过」只看这一枚 Cookie，
    // 目录存在不代表登录过——点开又取消也会留下目录
    authCookie: { url: 'https://x.com', name: 'auth_token' },
    caps: {
      account: ['followers'],
      work: ['reads', 'likes', 'comments', 'shares'],
      /**
       * 查看次数是 X 最有价值的指标（平台自己也算它），引用数只在接口里有。
       * `bookmarks` 不列进来：它和 `saves` 是同一件事（X 的收藏就是书签），
       * 列两遍会让人以为有两个不同的指标；英文名还会直接漏到表头上。
       */
      extra: ['quotes', 'type']
    },
    listPageSize: 20,
    paceMin: 15,
    verifiedAt: '2026-10',
    notes:
      '粉丝数和帖子列表取自主页；查看、赞、回复、转发、引用、收藏取自 X 自己的接口，' +
      '并标明每一条是原创、回复还是转发。'
  },

  {
    key: 'yt',
    name: 'YouTube',
    icon: 'yt',
    brand: '#FF0033',
    region: GLOBAL,
    mode: 'cookie',
    pages: {
      // 读数走工作室后台；登录仍在 YouTube 主页（那是用户认识的地方）
      account: 'https://studio.youtube.com/',
      works: null,
      detail: null,
      login: 'https://www.youtube.com/'
    },
    /**
     * 判断「登没登」用哪一枚 Cookie。
     *
     * 原来这里**根本没配 authCookie**，于是 hasAuth() 一律返回 false ——
     * 无论登录态在不在，界面都显示「未登录」。这是「导入也不准确、
     * 识别不到」的最直接原因：不是导入失败，是判断依据是空的。
     *
     * 选 LOGIN_INFO：它只在真正登录过之后才由 YouTube 自己写入，
     * 且带账号信息，比 SID/SAPISID 更能代表「YouTube 认得这个号」。
     */
    authCookie: { url: 'https://www.youtube.com', name: 'LOGIN_INFO' },
    caps: {
      // 有频道才有这些数；没频道时界面会照实说「还没创建频道」
      account: ['followers'],
      work: ['reads', 'likes', 'comments'],
      // 时长是 YouTube 特有的（Shorts 列表里就列这个）
      extra: ['lengthSec']
    },
    listPageSize: 30,
    paceMin: 15,
    verifiedAt: '2026-10',
    notes:
      'Google 拒绝在 Electron 里走 OAuth，登录只能用「从 Chrome/Edge 导入 Cookie」。' +
      '导入后如果仍显示未登录，多半是 Chrome 里没有 LOGIN_INFO —— 去 youtube.com 打开一次让它写入。'
  },

  // ------------------------------------------------------------ Instagram
  {
    key: 'ig',
    name: 'Instagram',
    icon: 'ig',
    brand: '#E1306C',
    region: GLOBAL,
    mode: 'web',
    pages: {
      account: 'https://www.instagram.com/',
      works: null,
      detail: null,
      // 别用 /accounts/login/：那个路径对非浏览器客户端直接回 429（空文档），
      // 首页未登录时同样会给登录墙，走首页更稳
      login: 'https://www.instagram.com/'
    },
    authCookie: { url: 'https://www.instagram.com', name: 'sessionid' },
    caps: {
      // IG 的「触达/展示」只有专业账号才有；播放量（play_count）个人号也有，
      // 在帖子详情接口里，所以 reads 这一列是能填上的
      account: ['followers', 'worksTotal'],
      work: ['reads', 'likes', 'saves', 'comments', 'shares'],
      extra: []
    },
    listPageSize: 24,
    paceMin: 20,
    verifiedAt: '2026-10',
    notes:
      '粉丝数、帖子数来自本人资料接口；播放量、赞、评论、收藏来自每条帖子的详情接口。' +
      '「触达/展示」只有专业账号才有。'
  },

  // ------------------------------------------------------------ Threads
  {
    key: 'threads',
    name: 'Threads',
    icon: 'threads',
    brand: '#E7E9EA',
    brandLight: '#101010',
    region: GLOBAL,
    mode: 'web',
    pages: {
      account: 'https://www.threads.com/',
      works: null,
      detail: null,
      login: 'https://www.threads.com/login'
    },
    authCookie: { url: 'https://www.threads.com', name: 'sessionid' },
    caps: {
      account: ['followers', 'worksTotal'],
      work: ['reads', 'likes', 'comments', 'shares'],
      extra: ['reposts', 'quotes']
    },
    listPageSize: 20,
    paceMin: 20,
    verifiedAt: '2026-10',
    notes: '粉丝数取本人主页头部；帖子来自页面自己的接口，浏览量只有专业账号才有。'
  },

  // ------------------------------------------------------------ TikTok
  /**
   * 为什么把 Facebook 换掉：
   * 个人号根本不给数据 —— 没有粉丝数、没有单帖浏览量、没有触达，
   * 一个「取消掉」的判断比留着读三个不准的赞实际得多。
   *
   * TikTok 走个人主页（不依赖创作者中心）：
   *   主页头部的粉丝/获赞是公开数字，视频卡片的播放量也在主页上，
   *   创作者中心要额外权限、接口还常改，先不碰。
   */
  {
    key: 'tiktok',
    name: 'TikTok',
    icon: 'tiktok',
    brand: '#FE2C55',
    region: GLOBAL,
    mode: 'web',
    pages: {
      // /profile 会 302 到自己的主页，但拿不到 handle；真正的 two-step 在采集器里
      account: 'https://www.tiktok.com/',
      works: null,
      detail: null,
      login: 'https://www.tiktok.com/login'
    },
    // 登录用 sessionid / sessionid_ss 都算，认第一个能读到的
    authCookie: { url: 'https://www.tiktok.com', name: 'sessionid' },
    caps: {
      account: ['followers', 'worksTotal'],
      /**
       * 五项都由主页的 item_list 接口给（stats 里的 play/digg/comment/share/collect）。
       * 接口被签名拦掉时会退到主页卡片，那时只剩播放量 ——
       * 所以这里是「平台能给什么」，不是「每次一定读到」。
       */
      work: ['reads', 'likes', 'comments', 'shares', 'saves'],
      extra: []
    },
    listPageSize: 30,
    paceMin: 20,
    verifiedAt: '2026-10',
    notes: '播放/赞/评/转发/收藏来自主页的 item_list 接口；接口被拦时只剩播放量。'
  }
];

/**
 * 排序：国内在前、海外在后。顺序就是界面上的顺序，改这里即改界面。
 * slug 只是默认值 —— 真正的分区名是「账号级」的（acct-<key>-<序号>），
 * 因为同一个平台可能有第二个号，共用分区就会串号。
 */
const DISPLAY = PLATFORMS.map((p) => ({ plat: p.name, key: p.key, slug: p.key }));

/**
 * 从 Chrome 导入登录态时，每个平台只碰这些域名。
 *
 * 这是隐私边界，不是技术限制：用户 Chrome 里有几百个站点的 Cookie，
 * 只有这些跟「读自己号后台」有关系的才允许被读走。
 * 想加平台就加一行，没配的平台不会导入任何东西（不是导全部）。
 */
const COOKIE_DOMAINS = {
  gzh: ['weixin.qq.com', 'qq.com'],
  xhs: ['xiaohongshu.com'],
  douyin: ['douyin.com', 'bytedance.com'],
  channels: ['weixin.qq.com', 'qq.com'],
  weibo: ['weibo.com', 'weibo.cn', 'sina.com.cn'],
  zhihu: ['zhihu.com'],
  bili: ['bilibili.com'],
  x: ['x.com', 'twitter.com'],
  yt: ['youtube.com', 'google.com'],
  ig: ['instagram.com'],
  threads: ['threads.com', 'threads.net', 'instagram.com'],
  tiktok: ['tiktok.com']
};

for (const p of PLATFORMS) p.cookieDomains = COOKIE_DOMAINS[p.key] || [];

/**
 * 「这个环境到底登没登」只看这一枚 Cookie。
 *
 * 不能看目录在不在，也不能数 Cookie 有多少 —— 页面一打开就会写匿名 Cookie
 * （ttwid、_gid 之类），数出来每个分区都「有登录态」，等于没判断。
 * 只认登录之后才会有的那一个名字，才能区分「登过」和「只是打开过」。
 *
 * 有的平台不止一个站，登录后写的 Cookie 也不同名。这时用 { any: [...] }，
 * 任一命中即算登录 —— 写死一枚会得出「明明登上了，说没检测到」，
 * 而这种错用户自己没法修。小红书就是这样：创作者后台根本不写 web_session。
 */
const AUTH_COOKIE = {
  gzh: { url: 'https://mp.weixin.qq.com', name: 'slave_sid' },
  xhs: {
    any: [
      // 创作者后台（creator.xiaohongshu.com）实际写的三枚，实测确认
      { url: 'https://creator.xiaohongshu.com', name: 'galaxy_creator_session_id' },
      { url: 'https://creator.xiaohongshu.com', name: 'access-token-creator.xiaohongshu.com' },
      // 主站的登录态，用户也可能只登了主站
      { url: 'https://www.xiaohongshu.com', name: 'web_session' }
    ]
  },
  douyin: { url: 'https://www.douyin.com', name: 'sessionid' },
  channels: { url: 'https://channels.weixin.qq.com', name: 'sessionid' },
  weibo: { url: 'https://weibo.com', name: 'SUB' },
  zhihu: { url: 'https://www.zhihu.com', name: 'z_c0' },
  bili: { url: 'https://www.bilibili.com', name: 'SESSDATA' },
  yt: { url: 'https://www.youtube.com', name: 'SID' },
  ig: {
    any: [
      { url: 'https://www.instagram.com', name: 'sessionid' },
      { url: 'https://www.instagram.com', name: 'ds_user_id' }
    ]
  },
  threads: { url: 'https://www.threads.com', name: 'sessionid' }
};

for (const p of PLATFORMS) {
  if (!p.authCookie && AUTH_COOKIE[p.key]) p.authCookie = AUTH_COOKIE[p.key];
}

module.exports = { PLATFORMS, DISPLAY };
