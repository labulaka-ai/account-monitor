'use strict';
/**
 * 视频号 · 页面内取数脚本
 *
 * 这些函数会被 toString() 成字符串注入到平台页面里执行（见 lib/reader.js 的 scriptOf），
 * 所以铁律：**函数体不能引用文件外的东西**，连本文件里别的 const 也不行。
 * 需要小工具就写在函数体里面 —— test/scripts.test.js 会盯着这条。
 */

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

module.exports = {
  key: 'channels',
  name: '视频号',
  pages: [{ url: 'https://channels.weixin.qq.com/platform/post/list', fn: channels }]
};
