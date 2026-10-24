'use strict';
/**
 * 小红书 · 页面内取数脚本
 *
 * 这些函数会被 toString() 成字符串注入到平台页面里执行（见 lib/reader.js 的 scriptOf），
 * 所以铁律：**函数体不能引用文件外的东西**，连本文件里别的 const 也不行。
 * 需要小工具就写在函数体里面 —— test/scripts.test.js 会盯着这条。
 */

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

module.exports = {
  key: 'xhs',
  name: '小红书',
  pages: [
    { url: 'https://creator.xiaohongshu.com/new/note-manager', fn: xhsWorks },
    { url: 'https://creator.xiaohongshu.com/statistics/account', fn: xhsOverview }
  ]
};
