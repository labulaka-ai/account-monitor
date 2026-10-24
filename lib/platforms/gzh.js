'use strict';
/**
 * 公众号 · 页面内取数脚本
 *
 * 这些函数会被 toString() 成字符串注入到平台页面里执行（见 lib/reader.js 的 scriptOf），
 * 所以铁律：**函数体不能引用文件外的东西**，连本文件里别的 const 也不行。
 * 需要小工具就写在函数体里面 —— test/scripts.test.js 会盯着这条。
 */

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

module.exports = {
  key: 'gzh',
  name: '公众号',
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
};
