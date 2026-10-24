'use strict';
/**
 * 平台取数脚本 · 注册表
 *
 * 为什么是「一平台一个文件」：
 *   取数逻辑是这套系统里最不稳定的一块 —— 平台三个月改一次页面，
 *   而每个平台改的东西互不相干。原来 2700 行全挤在一个文件里，
 *   改 A 平台的字段要在 B 平台的一堆正则中间找位置，diff 也看不出来动了谁。
 *
 *   现在一个平台一个文件（lib/platforms/<key>.js），每个文件自己声明
 *   走得通的页面顺序（pages），这里只负责把它们拼成一张表。
 *   加平台 = 新建一个文件 + 在这张表里加一行，不碰别人的代码。
 *
 * 每个页面脚本都在平台页面里跑（没有 require、没有 Node），返回统一结构：
 *   {
 *     login:    boolean        没登录时给 false，reader 据此判「需要重新登录」
 *     identity: { nickname, handle, uid, avatar }
 *     account:  { followers, totalReads, totalLikes }
 *     works:    [{ platWorkId, title, publishedAt, reads, likes, saves, comments,
 *                  shares, completion, newFollowers, extra }]
 *     worksTotal: number|null  平台自报的作品总数（不是这次返回的条数）
 *     note:     string         平台侧的事实说明（例如「这个号还没有作品」）
 *     ctx:      object         给下一页用的参数（例如公众号的 token）
 *   }
 *
 * 账号级 totalReads 只在平台确实给「累计」时才填。抖音/小红书的概览是「近 7 天」，
 * 由适配器的 overviewWindow 标成 7d，界面标签跟着改口 —— 数字真但含义不能混。
 */

const MODULES = [
  require('./platforms/gzh'),      // 公众号
  require('./platforms/xhs'),      // 小红书
  require('./platforms/douyin'),   // 抖音
  require('./platforms/channels'), // 视频号
  require('./platforms/bili'),     // B站
  require('./platforms/weibo'),    // 微博
  require('./platforms/zhihu'),    // 知乎
  require('./platforms/x'),        // X
  require('./platforms/yt'),       // YouTube
  require('./platforms/ig'),       // Instagram
  require('./platforms/threads'),  // Threads
  require('./platforms/tiktok')    // TikTok
];

const COLLECTORS = {};
for (const m of MODULES) {
  COLLECTORS[m.key] = { pages: m.pages, name: m.name };
}

function getCollector(key) {
  return COLLECTORS[key] || null;
}

/**
 * 页面脚本要变成一段能直接执行的源码。
 * 之所以能这么干：每个脚本都是自包含的（不引用外部变量），
 * 所以 toString() 之后照样跑得起来。这条约束由 test/scripts.test.js 守着。
 */
function scriptOf(fn) {
  return `(${fn.toString()})()`;
}

module.exports = { COLLECTORS, getCollector, scriptOf, PLATFORM_MODULES: MODULES };
