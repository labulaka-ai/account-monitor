'use strict';
/**
 * 抖音 · 页面内取数脚本
 *
 * 这些函数会被 toString() 成字符串注入到平台页面里执行（见 lib/reader.js 的 scriptOf），
 * 所以铁律：**函数体不能引用文件外的东西**，连本文件里别的 const 也不行。
 * 需要小工具就写在函数体里面 —— test/scripts.test.js 会盯着这条。
 */

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

module.exports = {
  key: 'douyin',
  name: '抖音',
  pages: [{ url: 'https://creator.douyin.com/creator-micro/content/manage', fn: douyin }]
};
