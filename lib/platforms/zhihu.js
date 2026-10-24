'use strict';
/**
 * 知乎 · 页面内取数脚本
 *
 * 这些函数会被 toString() 成字符串注入到平台页面里执行（见 lib/reader.js 的 scriptOf），
 * 所以铁律：**函数体不能引用文件外的东西**，连本文件里别的 const 也不行。
 * 需要小工具就写在函数体里面 —— test/scripts.test.js 会盯着这条。
 */

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

module.exports = {
  key: 'zhihu',
  name: '知乎',
  pages: [{ url: 'https://www.zhihu.com/creator/manage/creation/all', fn: zhihu }]
};
