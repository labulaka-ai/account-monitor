'use strict';
/**
 * 微博 · 页面内取数脚本
 *
 * 这些函数会被 toString() 成字符串注入到平台页面里执行（见 lib/reader.js 的 scriptOf），
 * 所以铁律：**函数体不能引用文件外的东西**，连本文件里别的 const 也不行。
 * 需要小工具就写在函数体里面 —— test/scripts.test.js 会盯着这条。
 */

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

module.exports = {
  key: 'weibo',
  name: '微博',
  // 只在本人主页那条线上取数：$CONFIG.uid → profile/info + mymblog
  pages: [{ url: 'https://weibo.com/', fn: weibo }]
};
