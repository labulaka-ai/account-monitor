'use strict';
/**
 * B站 · 页面内取数脚本
 *
 * 这些函数会被 toString() 成字符串注入到平台页面里执行（见 lib/reader.js 的 scriptOf），
 * 所以铁律：**函数体不能引用文件外的东西**，连本文件里别的 const 也不行。
 * 需要小工具就写在函数体里面 —— test/scripts.test.js 会盯着这条。
 */

/**
 * 三处数据：
 *   /x/web-interface/nav            登录态 + mid + 昵称
 *   /x/relation/stat?vmid=<mid>     粉丝数
 *   /x/web/archives                稿件列表，每条带 stat（播放/点赞/收藏/投币/弹幕/评论/分享）
 */
const bili = async function () {
  const out = { platform: 'bili' };
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

  const nav = await j('https://api.bilibili.com/x/web-interface/nav');
  const nd = (nav && nav.data) || null;
  if (!nd || !nd.isLogin) {
    out.login = false;
    return out;
  }

  const rel = await j('https://api.bilibili.com/x/relation/stat?vmid=' + nd.mid);
  const ar = await j(
    'https://member.bilibili.com/x/web/archives?status=is_pubing,pubed,not_pubed&pn=1&ps=20&co=0&interactive=1'
  );
  const audits = ((ar && ar.data && ar.data.arc_audits) || []).slice();
  const cls = (ar && ar.data && ar.data.class) || {};
  let total = Object.keys(cls).reduce((n, k) => n + (Number(cls[k]) || 0), 0);

  // ps=20 一页，稿件多于 20 就必须翻页。class 里的分类合计是平台自己数的总数，
  // 拿它对账：没读够就继续翻，直到读满或平台不再给新条目。
  const seen = new Set(audits.map((a) => String((a.Archive || {}).bvid || (a.Archive || {}).aid || '')));
  for (let pn = 2; pn <= 30 && audits.length < total; pn++) {
    await new Promise((r) => setTimeout(r, 600 + Math.round(Math.random() * 900)));
    const more = await j(
      'https://member.bilibili.com/x/web/archives?status=is_pubing,pubed,not_pubed&pn=' +
        pn +
        '&ps=20&co=0&interactive=1'
    );
    const arr = (more && more.data && more.data.arc_audits) || [];
    if (!arr.length) break;
    for (const a of arr) {
      const A = a.Archive || {};
      const id = String(A.bvid || A.aid || '');
      if (id && !seen.has(id)) {
        seen.add(id);
        audits.push(a);
      }
    }
    const c2 = (more.data && more.data.class) || {};
    const t2 = Object.keys(c2).reduce((n, k) => n + (Number(c2[k]) || 0), 0);
    if (t2 > total) total = t2;
  }

  out.login = true;
  out.identity = {
    nickname: String(nd.uname || ''),
    handle: String(nd.mid || ''),
    uid: String(nd.mid || ''),
    avatar: String(nd.face || '')
  };
  out.account = { followers: rel && rel.data ? Number(rel.data.follower) : null };
  /**
   * 只有「平台的 class 统计真的给出了分类」时，这个总数才可信。
   *
   * 不能写 `Math.max(total, audits.length)`：接口改版或请求失败时 cls 是空对象，
   * total=0，兜底会变成「总数 = 这次读到的条数」，reader 拿它逐页对账必然通过，
   * 于是 complete=true，库里没出现在这次列表里的稿件全被标成已删除。
   * 读不到就干脆不写 —— reader 见到 undefined 会判「这次没读全」，什么都不删。
   *
   * 另外**不要**在这里取 `Math.max(total, audits.length)`：把总数抬到等于读到条数，
   * 会让 reader 的逐页对账 `got >= total` 变成恒真，等于把这道保险丝剪了。
   * 展示用的数字 reader 自己会补（它保证不小于表里的行数），采集器只报平台原话。
   *
   * `total >= audits.length` 这半个条件是第二道保险：class 统计是「按分类相加」得来的，
   * 万一它没覆盖到某一类稿件，算出来会比实际列表**还少**。那时逐页对账 `got >= total`
   * 同样恒真，库里其余稿件会被判成已删除。总数比读到条数还小的这种数不可信，
   * 干脆不报 —— 不报就是「没读全」，一条都不删。
   */
  if (Object.keys(cls).length > 0 && total >= audits.length) out.worksTotal = total;
  if (audits.length < total) out.truncated = true;
  out.works = audits.map((a) => {
    const A = a.Archive || {};
    const s = a.stat || A.stat || {};
    return {
      platWorkId: String(A.bvid || A.aid || ''),
      title: String(A.title || '').slice(0, 300),
      publishedAt: A.ptime ? dstr(A.ptime) : '',
      reads: s.view == null ? null : Number(s.view),
      likes: s.like == null ? null : Number(s.like),
      saves: s.favorite == null ? null : Number(s.favorite),
      comments: s.reply == null ? null : Number(s.reply),
      shares: s.share == null ? null : Number(s.share),
      extra: {
        ...(s.coin == null ? {} : { coins: Number(s.coin) }),
        ...(s.danmaku == null ? {} : { danmaku: Number(s.danmaku) })
      }
    };
  });
  if (total === 0) out.note = '这个号还没有投过稿';
  return out;
};

module.exports = {
  key: 'bili',
  name: 'B站',
  pages: [{ url: 'https://member.bilibili.com/platform/home', fn: bili }]
};
