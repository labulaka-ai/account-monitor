'use strict';
/**
 * 报告生成
 *
 * 一份报告要做三件事，缺一不可：
 *   1. **说清是哪段时间** —— 「月报」必须写明起止日期，否则两个月后没人分得清
 *   2. **按平台各自的判断标准写** —— 公众号说分享、B站说投币，不能一律写「阅读」
 *   3. **标明口径和缺失** —— 小红书是近 7 天、TikTok 主页不给发布日期，
 *      这些不说清，报告就成了看上去很专业但会误导人的东西
 *
 * 输出三种格式，同一份数据结构：
 *   · markdown —— 给人看、给 AI 读、能进 git
 *   · docx     —— 自己能改、能发给人
 *   · pdf      —— 定稿、打印、发群里
 */

const platProfile = require('./plat_profile');
const { makeDocx } = require('./docx');

// ---------------------------------------------------------------- 时间范围

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * 解析时间范围。
 *
 * 全部用「本地日期」算，不用 UTC —— 用户在 UTC+8，
 * 用 UTC 算「10 月」会把 10 月 1 日早上 8 点前的东西算进 9 月。
 */
function periodOf(kind, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (kind === 'week') {
    // 周一到周日。getDay() 里周日是 0，先转成「周一为 0」
    const dow = (d.getDay() + 6) % 7;
    const start = new Date(d);
    start.setDate(d.getDate() - dow);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return {
      kind: 'week',
      // short 给标题用：完整区间已经印在下面那行 meta 里，
      // 21pt 的标题再塞一遍日期就会折行（PDF 里实测折过）
      short: `${start.getFullYear()} 年第 ${isoWeek(start)} 周`,
      label: `${start.getFullYear()} 年第 ${isoWeek(start)} 周（${ymd(start)} ~ ${ymd(end)}）`,
      from: ymd(start),
      to: ymd(end)
    };
  }
  if (kind === 'year') {
    const start = new Date(d.getFullYear(), 0, 1);
    const end = new Date(d.getFullYear(), 11, 31);
    return {
      kind: 'year',
      short: `${d.getFullYear()} 年`,
      label: `${d.getFullYear()} 年（${ymd(start)} ~ ${ymd(end)}）`,
      from: ymd(start),
      to: ymd(end)
    };
  }
  if (kind === 'all') {
    return { kind: 'all', short: '全部数据', label: '全部数据', from: '', to: '' };
  }
  // 默认月报
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return {
    kind: 'month',
    short: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`,
    label: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月（${ymd(start)} ~ ${ymd(end)}）`,
    from: ymd(start),
    to: ymd(end)
  };
}

/** ISO 周号，用来在标题里定位「这是今年第几周」 */
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

// ---------------------------------------------------------------- 取数

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseExtra(s) {
  if (!s) return {};
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/**
 * 把一个号在指定时间范围内的数据收集起来。
 *
 * 作品按**发布日期**筛选，不按采集时间 ——
 * 「这个月发了什么」问的是发布，不是我们什么时候读到的。
 */
function collectAccount(db, acc, period) {
  const works = db
    .prepare(
      `SELECT w.plat_work_id, w.title, w.published_at,
              m.reads, m.likes, m.saves, m.comments, m.shares,
              m.completion, m.extra, m.captured_at
         FROM works w
         LEFT JOIN work_metrics m ON m.work_id = w.id
          AND m.captured_at = (SELECT MAX(captured_at) FROM work_metrics WHERE work_id = w.id)
        WHERE w.account_id = ? AND w.gone = 0
        ORDER BY w.published_at DESC`
    )
    .all(acc.id)
    .map((w) => Object.assign({}, w, { extra: parseExtra(w.extra) }));

  const inRange = (d) => {
    if (!period.from) return true;
    if (!d) return false;
    return d >= period.from && d <= period.to;
  };

  const scoped = works.filter((w) => inRange(w.published_at));

  const snaps = db
    .prepare('SELECT * FROM snapshots WHERE account_id = ? ORDER BY date ASC')
    .all(acc.id)
    .filter((s) => inRange(s.date));

  // 全量快照（不受时间限制）用来算「这个号现在多少粉丝」
  const latest = db
    .prepare('SELECT * FROM snapshots WHERE account_id = ? ORDER BY date DESC LIMIT 1')
    .get(acc.id);

  return { acc, works: scoped, allWorks: works, snaps, latest };
}

/** 求和：null 不当 0，一个都没有就返回 null */
function sumOf(list, key) {
  const vals = list.map((w) => num(key === 'extra' ? null : w[key])).filter((v) => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

function sumExtra(list, key) {
  const vals = list.map((w) => num(w.extra && w.extra[key])).filter((v) => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

function avgOf(list, key) {
  const vals = list.map((w) => num(w[key])).filter((v) => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/** 互动率：赞+评+享+藏 ÷ 阅读。阅读为 0 的不进分母 */
function interRate(list) {
  let inter = 0;
  let reads = 0;
  for (const w of list) {
    const r = num(w.reads);
    if (r == null || r <= 0) continue;
    reads += r;
    inter += (num(w.likes) || 0) + (num(w.comments) || 0) + (num(w.shares) || 0) + (num(w.saves) || 0);
  }
  return reads ? (inter / reads) * 100 : null;
}

/**
 * 这个平台该看的那个数。
 * 报告里每个平台用自己最重要的指标，不强行统一成「阅读」。
 */
function primaryValue(list, key) {
  if (key === 'completion') return avgOf(list, 'completion');
  if (['coins', 'danmaku', 'quotes', 'bookmarks', 'recommend'].includes(key)) return sumExtra(list, key);
  if (key === 'likes') return sumOf(list, 'likes');
  if (key === 'comments') return sumOf(list, 'comments');
  if (key === 'shares') return sumOf(list, 'shares');
  if (key === 'saves') return sumOf(list, 'saves');
  return sumOf(list, 'reads');
}

// ---------------------------------------------------------------- 组报告

/**
 * @param {object} db
 * @param {object} o
 * @param {'week'|'month'|'year'|'all'} o.range
 * @param {string[]} [o.accountIds] 只报告这些号，不传就是全部
 * @param {Date} [o.now]
 */
function buildReport(db, o = {}) {
  const period = periodOf(o.range || 'month', o.now || new Date());

  let rows = db.prepare('SELECT * FROM accounts ORDER BY plat, created_at').all();
  if (Array.isArray(o.accountIds) && o.accountIds.length) {
    const want = new Set(o.accountIds);
    rows = rows.filter((a) => want.has(a.id));
  }
  /**
   * 按平台筛选。
   *
   * 为什么要这个：一个号一个号地看，和「所有平台放一份报告里」是两种完全不同的读法。
   * 给公众号运营看的时候，抖音那几行只会分散注意力。
   * 传了 plats 就只算这些平台（环比也只跟自己在上一周期的同一批平台比）。
   */
  if (Array.isArray(o.plats) && o.plats.length) {
    const want = new Set(o.plats);
    rows = rows.filter((a) => want.has(a.plat));
  }
  if (!rows.length) {
    return {
      period,
      generatedAt: new Date().toISOString(),
      title: `账号运营报告 · ${period.short || period.label}`,
      total: { platforms: 0, accounts: 0, works: 0, reads: null, followers: null },
      platforms: [],
      ranked: [],
      similar: null,
      deltas: [],
      dailySeries: [],
      weeklySeries: [],
      weekdaySeries: [],
      quadrant: [],
      shareOfReads: [],
      compare: null,
      accountProfiles: [],
      findings: [],
      platFindings: {},
      rankedByPlat: {},
      caveats: ['这个范围内没有账号'],
      scoped: Array.isArray(o.plats) ? o.plats.slice() : []
    };
  }

  const items = rows.map((a) => collectAccount(db, a, period));

  // 按平台聚合
  const byPlat = new Map();
  for (const it of items) {
    if (!byPlat.has(it.acc.plat)) byPlat.set(it.acc.plat, []);
    byPlat.get(it.acc.plat).push(it);
  }

  const platforms = [];
  for (const [plat, list] of byPlat) {
    const prof = platProfile.profileOf(plat);
    const works = list.flatMap((x) => x.works);
    const followers = list.map((x) => num(x.latest && x.latest.followers)).filter((v) => v != null);

    platforms.push({
      plat,
      profile: prof,
      accounts: list.length,
      // 粉丝是账号级、时效性的，用最新快照；不是区间内的
      followers: followers.length ? followers.reduce((a, b) => a + b, 0) : null,
      works: works.length,
      reads: sumOf(works, 'reads'),
      likes: sumOf(works, 'likes'),
      comments: sumOf(works, 'comments'),
      shares: sumOf(works, 'shares'),
      saves: sumOf(works, 'saves'),
      quotes: sumExtra(works, 'quotes'),
      coins: sumExtra(works, 'coins'),
      danmaku: sumExtra(works, 'danmaku'),
      recommend: sumExtra(works, 'recommend'),
      completion: avgOf(works, 'completion'),
      /**
       * 互动率：阅读太小的不算。
       *
       * 平台级有个噪音：YouTube 那条只有 1 次观看、1 个赞，
       * 算出来是 100% 互动率，会排到全平台第一 —— 那是纯噪音，
       * 拿去做判断会得出完全错误的结论。
       * 门槛定 30：低于这个数，一个赞就能让比例翻倍。
       */
      interRate: (() => {
        const good = works.filter((w) => num(w.reads) != null && num(w.reads) >= 30);
        return good.length ? interRate(good) : null;
      })(),
      primary: primaryValue(works, prof.angle.primary),
      notes: [...new Set(list.map((x) => (x.acc.note || '').trim()).filter(Boolean))],
      hasData: works.length > 0 || followers.length > 0
    });
  }

  // 排序：有数据的、作品多的在前 —— 报告最前面应该是重点
  platforms.sort((a, b) => {
    if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
    return (b.reads || 0) - (a.reads || 0);
  });

  // 亮点：全平台里阅读最高的几条（只算带阅读的）
  const allWorks = items.flatMap((it) =>
    it.works.map((w) => ({
      plat: it.acc.plat,
      account: it.acc.nickname || it.acc.handle || '',
      title: w.title || '',
      publishedAt: w.published_at || '',
      reads: num(w.reads),
      likes: num(w.likes),
      comments: num(w.comments),
      shares: num(w.shares),
      saves: num(w.saves)
    }))
  );
  const ranked = allWorks
    .filter((w) => w.reads != null && w.reads > 0)
    .sort((a, b) => b.reads - a.reads)
    .slice(0, 8)
    .map((w) => {
      const inter = (w.likes || 0) + (w.comments || 0) + (w.shares || 0) + (w.saves || 0);
      return Object.assign({}, w, { interRate: w.reads ? (inter / w.reads) * 100 : null });
    });

  /**
   * 按平台分组的作品列表（阅读降序）。
   *
   * 「各平台明细」那一节要列出这个平台本期发了什么 —— 只看一行汇总数字，
   * 想知道「哪几条在跑」还得切回 App 里翻。分组放在 buildReport 里算一次，
   * 三个渲染器（md/html/docx）直接用，别各算各的。
   */
  const rankedByPlat = {};
  for (const w of allWorks) {
    (rankedByPlat[w.plat] = rankedByPlat[w.plat] || []).push(w);
  }
  for (const k of Object.keys(rankedByPlat)) {
    rankedByPlat[k].sort((a, b) => (num(b.reads) || -1) - (num(a.reads) || -1));
  }

  /**
   * 同类对比：按标题里的共同主题分组，只在同组内比。
   *
   * 为什么报告里必须有这个：全量排行榜第一名经常是「平台给了曝光」的产物。
   * 而同一题材内谁更好，才是能拿去指导下一篇的结论。
   * 一组至少 3 条才出结论 —— 两条凑出来的「第一」没意义。
   */
  const similar = (() => {
    const usable = allWorks.filter((w) => w.reads != null && w.reads > 0 && w.title);
    if (usable.length < 6) return null;
    const STOP = new Set(['的', '了', '是', '在', '和', '与', '就', '都', '也', '这', '那', '一个', '我们',
      '可以', '什么', '怎么', '为什么', '如何', '不是', '没有', '这个', '那个', '一下']);
    const freq = new Map();
    for (const w of usable) {
      const t = String(w.title).replace(/[\s\p{P}]/gu, '');
      const seen = new Set();
      for (let i = 0; i + 2 <= t.length; i++) {
        const g = t.slice(i, i + 2);
        if (STOP.has(g) || seen.has(g)) continue;
        seen.add(g);
        freq.set(g, (freq.get(g) || 0) + 1);
      }
    }
    let key = '';
    let group = [];
    for (const [k, n] of freq) {
      if (n < 3) continue;
      const g = usable.filter((w) => String(w.title).includes(k));
      if (g.length > group.length || (g.length === group.length && k.length > key.length)) {
        key = k;
        group = g;
      }
    }
    if (group.length < 3) return null;
    return {
      label: key,
      count: group.length,
      rows: group.slice().sort((a, b) => b.reads - a.reads).slice(0, 5)
    };
  })();

  // 粉丝从期初到期末的变化（用区间内第一条和最后一条快照）
  const deltas = [];
  for (const it of items) {
    const s = it.snaps.filter((x) => x.followers != null);
    if (s.length < 2) continue;
    const d = num(s[s.length - 1].followers) - num(s[0].followers);
    if (d === 0) continue;
    deltas.push({
      plat: it.acc.plat,
      account: it.acc.nickname || it.acc.handle || '',
      from: num(s[0].followers),
      to: num(s[s.length - 1].followers),
      delta: d
    });
  }
  deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const total = {
    platforms: platforms.length,
    accounts: items.length,
    works: allWorks.length,
    reads: platforms.reduce((a, p) => a + (p.reads || 0), 0) || null,
    followers: (() => {
      const v = platforms.map((p) => p.followers).filter((x) => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) : null;
    })()
  };

  /**
   * ─────────────────────────────────────────────────────────────
   * 以下是「让报告有内容」的部分。
   *
   * 之前报告空洞的根因不是排版，是**只把数抄了一遍**，
   * 没有对比、没有分布、没有结论。一份报告要能回答三个问题：
   *   1. 这段时间整体怎么样（趋势 + 结构）
   *   2. 哪个部分好、哪个拖后腿（分布 + 对比）
   *   3. 下一步该做什么（从数据能推出来的建议）
   * 所以这里补齐：环比、按天/按周分布、四象限、平台占比、单号画像。
   * ─────────────────────────────────────────────────────────────
   */

  /** 按发布日聚合：每天发了多少条、一共多少阅读。用来画趋势。 */
  const dailySeries = (() => {
    const map = new Map();
    for (const w of allWorks) {
      if (!w.publishedAt) continue;
      const cur = map.get(w.publishedAt) || { date: w.publishedAt, works: 0, reads: 0 };
      cur.works += 1;
      if (w.reads != null) cur.reads += w.reads;
      map.set(w.publishedAt, cur);
    }
    return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  })();

  /** 按周聚合（周一为一周起点），用于看发布节奏 */
  const weeklySeries = (() => {
    const map = new Map();
    for (const w of allWorks) {
      if (!w.publishedAt) continue;
      const d = new Date(w.publishedAt + 'T00:00:00');
      if (Number.isNaN(d.getTime())) continue;
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const p2 = (x) => String(x).padStart(2, '0');
      const key = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      const cur = map.get(key) || { week: key, works: 0, reads: 0 };
      cur.works += 1;
      if (w.reads != null) cur.reads += w.reads;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
  })();

  /** 按星期几聚合：哪一天发的东西表现更好 */
  const weekdaySeries = (() => {
    const WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const buckets = WD.map((label) => ({ label, works: 0, reads: 0, n: 0 }));
    for (const w of allWorks) {
      if (!w.publishedAt || w.reads == null) continue;
      const d = new Date(w.publishedAt + 'T00:00:00');
      if (Number.isNaN(d.getTime())) continue;
      const i = (d.getDay() + 6) % 7;
      buckets[i].works += 1;
      buckets[i].reads += w.reads;
      buckets[i].n += 1;
    }
    return buckets.map((b) => ({
      label: b.label,
      works: b.works,
      // 平均值比总量有意义：周三发得多不代表周三内容好
      avgReads: b.n ? Math.round(b.reads / b.n) : null
    }));
  })();

  /**
   * 四象限：阅读 × 互动率。
   * 报告里最有判断力的一张图 —— 它能分出「平台给的曝光」和「内容真的抓人」。
   */
  const quadrant = allWorks
    .filter((w) => w.reads != null && w.reads >= 100)
    .map((w) => {
      const inter = (w.likes || 0) + (w.comments || 0) + (w.shares || 0) + (w.saves || 0);
      return {
        plat: w.plat,
        title: w.title || '',
        reads: w.reads,
        interRate: +((inter / w.reads) * 100).toFixed(2)
      };
    })
    .sort((a, b) => b.reads - a.reads)
    .slice(0, 40);

  /** 平台占比：谁贡献了主要阅读量。用来看结构。 */
  const shareOfReads = (() => {
    const withReads = platforms.filter((p) => p.reads != null && p.reads > 0);
    const sum = withReads.reduce((a, p) => a + p.reads, 0);
    if (!sum) return [];
    return withReads
      .map((p) => ({ plat: p.plat, reads: p.reads, pct: +((p.reads / sum) * 100).toFixed(1) }))
      .sort((a, b) => b.reads - a.reads);
  })();

  /**
   * 环比：和「上一个等长周期」比。
   * 没有对比就没有判断 —— 单看「本月 1.2 万阅读」说明不了好坏。
   * 只有区间有起止日期时才算（全部数据没法比）。
   */
  const compare = (() => {
    if (!period.from || !period.to) return null;
    const fromD = new Date(period.from + 'T00:00:00');
    const toD = new Date(period.to + 'T00:00:00');
    const days = Math.round((toD - fromD) / 86400000) + 1;
    if (!Number.isFinite(days) || days <= 0) return null;
    const prevTo = new Date(fromD.getTime() - 86400000);
    const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86400000);
    const ymd2 = (d) => {
      const p2 = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    };
    const pf = ymd2(prevFrom);
    const pt = ymd2(prevTo);

    // 上一个周期的作品（按发布日期落在区间内）
    /**
     * 必须按本轮报告的账号过滤。
     *
     * 这份 SQL 原来没有 account_id 条件 —— 单平台报告（比如只导公众号）时，
     * 「上一周期」会把所有平台的作品都算进来，而「本期」只算公众号，
     * 于是环比里上期虚高、本期看起来暴跌。数字全是真的，结论是错的。
     */
    const ids = items.map((it) => it.acc.id);
    if (!ids.length) return null;
    const ph = ids.map(() => '?').join(',');
    const prevWorks = db
      .prepare(
        `SELECT w.published_at AS publishedAt, m.reads, m.likes, m.comments, m.shares, m.saves
           FROM works w
           LEFT JOIN work_metrics m ON m.work_id = w.id
            AND m.captured_at = (SELECT MAX(captured_at) FROM work_metrics WHERE work_id = w.id)
          WHERE w.gone = 0 AND w.account_id IN (${ph})
            AND w.published_at >= ? AND w.published_at <= ?`
      )
      .all(...ids, pf, pt);

    const sum = (arr, k) => {
      const v = arr.map((x) => x[k]).filter((x) => x != null);
      return v.length ? v.reduce((a, b) => a + Number(b), 0) : null;
    };
    const cur = { works: allWorks.length, reads: sum(allWorks, 'reads') };
    const prev = { works: prevWorks.length, reads: sum(prevWorks, 'reads') };
    const pct = (a, b) => (a == null || b == null || b === 0 ? null : +(((a - b) / b) * 100).toFixed(1));
    return {
      prevFrom: pf,
      prevTo: pt,
      days,
      works: { cur: cur.works, prev: prev.works, pct: pct(cur.works, prev.works) },
      reads: { cur: cur.reads, prev: prev.reads, pct: pct(cur.reads, prev.reads) }
    };
  })();

  /**
   * 单号画像：每个号在这段时间的表现。
   * 单号画像：篇均阅读比总量公平，发得多的号不会靠数量排前面。
   */
  const accountProfiles = items
    .map((it) => {
      const ws = it.works;
      const reads = ws.map((w) => w.reads).filter((v) => v != null);
      const inter = ws.reduce(
        (a, w) => a + (w.likes || 0) + (w.comments || 0) + (w.shares || 0) + (w.saves || 0),
        0
      );
      const totalReads = reads.length ? reads.reduce((a, b) => a + b, 0) : null;
      const best = ws
        .filter((w) => w.reads != null)
        .sort((a, b) => b.reads - a.reads)[0];
      return {
        plat: it.acc.plat,
        account: it.acc.nickname || it.acc.handle || '',
        works: ws.length,
        reads: totalReads,
        avgReads: reads.length ? Math.round(totalReads / reads.length) : null,
        // 同一道门槛：阅读太小的号不算互动率，否则「1 阅读 1 赞」会排第一
        interRate: totalReads && totalReads >= 30 ? +((inter / totalReads) * 100).toFixed(2) : null,
        followers: it.latest ? num(it.latest.followers) : null,
        bestTitle: best ? best.title || '' : '',
        bestReads: best ? best.reads : null
      };
    })
    .filter((x) => x.works > 0 || x.followers != null)
    .sort((a, b) => (b.reads || 0) - (a.reads || 0));

  /**
   * 自动结论：**只写能从数字直接算出来的事实**。
   *
   * 一条硬标准：把这句话里的数字全擦掉，它应该什么都不剩。
   *   ✓「公众号 12,409 阅读，占全平台 78.6%」  → 擦掉数字就没了
   *   ✗「公众号是主力」                        → 擦掉数字还剩一个判断词
   *   ✗「说明内容没接住曝光」                  → 这是推断，不是数据
   *
   * 为什么不写推断：报告是代码生成的，代码不知道你的选题意图、不知道这条
   * 内容是被平台限流还是读者不感兴趣。它只能算数，那就只报数。
   * 判断留给人 —— 但前提是我先把数摆清楚。
   */
  const findings = [];
  {
    /**
     * 单平台报告写成「公众号占 100%」是废话 —— 所以占比这条只在
     * 有两个以上平台时才出。下面凡是带平台名的结论都按这个开关走。
     */
    const multiPlat = shareOfReads.length > 1;
    const pfx = (p) => (multiPlat ? `${p} ` : '');

    // 1) 平台占比：谁贡献了多少阅读
    if (multiPlat && total.reads) {
      const top = shareOfReads[0];
      findings.push(
        `${top.plat} 阅读 ${fmtN(top.reads)}，占全平台 ${top.pct}%` +
          (shareOfReads.length > 1
            ? `；第二名 ${shareOfReads[1].plat} ${fmtN(shareOfReads[1].reads)}（${shareOfReads[1].pct}%）`
            : '')
      );
    }

    // 2) 互动率：只列数字，不评价好坏
    const withRate = platforms
      .filter((p) => p.hasData && p.interRate != null)
      .sort((a, b) => b.interRate - a.interRate);
    if (withRate.length) {
      const hi = withRate[0];
      const lo = withRate[withRate.length - 1];
      findings.push(
        withRate.length > 1
          ? `互动率最高 ${hi.plat} ${fmtP(hi.interRate)}，最低 ${lo.plat} ${fmtP(lo.interRate)}`
          : `互动率 ${pfx(hi.plat)}${fmtP(hi.interRate)}`
      );
    }

    // 3) 环比：只报两期数字和差值
    if (compare && compare.reads.pct != null) {
      findings.push(
        `本期阅读 ${fmtN(compare.reads.cur)}，上一周期（${compare.prevFrom} ~ ${compare.prevTo}）` +
          `${fmtN(compare.reads.prev)}，差 ${compare.reads.pct >= 0 ? '+' : ''}${compare.reads.pct}%`
      );
    }
    if (compare && compare.works.pct != null) {
      findings.push(
        `本期发布 ${fmtN(compare.works.cur)} 条，上一周期 ${fmtN(compare.works.prev)} 条，` +
          `差 ${compare.works.pct >= 0 ? '+' : ''}${compare.works.pct}%`
      );
    }

    // 4) 发布节奏：只报最多和最少的周各几条
    if (weeklySeries.length >= 2) {
      const ws = weeklySeries.map((w) => w.works);
      const maxW = Math.max(...ws);
      const minW = Math.min(...ws);
      const maxWeek = weeklySeries.find((w) => w.works === maxW);
      const minWeek = weeklySeries.find((w) => w.works === minW);
      if (maxW !== minW) {
        findings.push(
          `发布最多的一周 ${maxWeek.week} 共 ${maxW} 条，最少的一周 ${minWeek.week} 共 ${minW} 条`
        );
      }
    }

    // 5) 单条最高：报标题 + 数字
    if (ranked.length && ranked[0].reads != null) {
      const t = String(ranked[0].title || '（无标题）').slice(0, 26);
      findings.push(
        `阅读最高的一条是${multiPlat ? ranked[0].plat : ''}《${t}》，${fmtN(ranked[0].reads)} 阅读`
      );
    }

    // 6) 粉丝变化：只报数字和差值
    if (deltas.length) {
      findings.push(
        `粉丝变化：${deltas
          .map((d) => `${d.plat} ${fmtN(d.from)}→${fmtN(d.to)}（${d.delta > 0 ? '+' : ''}${d.delta}）`)
          .join('；')}`
      );
    }
  }

  /**
   * 每个平台自己的一组数字结论。
   *
   * 用户要看的是「按平台分段」，那每段就该有自己的小结论 ——
   * 不然翻到公众号那一节只能看到一张表，还得自己心算。
   * 同样只写数字，不写建议。
   */
  const platFindings = new Map();
  for (const p2 of platforms) {
    if (!p2.hasData) {
      platFindings.set(p2.plat, []);
      continue;
    }
    const list = [];
    /**
     * 一个平台可以挂多个号（这是产品的核心场景），必须把**所有号**的当期作品合起来。
     *
     * 原来写的是 items.find(...) —— 只取该平台的第一个号。
     * 而上面那句「本期发布 N 条」里的 N 是 p2.works，也就是全部号的合计。
     * 两个数来自不同样本，篇均必然错：号越多、差异越大，偏得越离谱。
     */
    const works = items.filter((it) => it.acc.plat === p2.plat).flatMap((it) => it.works);

    // 本期发布 + 篇均
    if (p2.works) {
      const withReads = works.filter((w) => num(w.reads) != null);
      const avg = withReads.length
        ? Math.round(withReads.reduce((a, w) => a + num(w.reads), 0) / withReads.length)
        : null;
      list.push(
        `本期发布 ${fmtN(p2.works)} 条` + (avg != null ? `，篇均 ${fmtN(avg)} 阅读` : '（这个平台不给单条阅读数）')
      );
    }

    // 本平台的主指标数值（分享/收藏/投币/完播…）
    const pk = p2.profile.angle && p2.profile.angle.primary;
    if (pk) {
      const labelMap = {
        shares: '分享',
        saves: '收藏',
        coins: '投币',
        completion: '完播率',
        likes: '点赞',
        comments: '评论',
        quotes: '引用'
      };
      const v = p2[pk];
      if (v != null) {
        list.push(
          pk === 'completion'
            ? `平均完播率 ${fmtP(v)}`
            : `合计${labelMap[pk] || pk} ${fmtN(v)}`
        );
      }
    }

    // 本平台最好的一条
    const best = works
      .filter((w) => num(w.reads) != null)
      .sort((a, b) => num(b.reads) - num(a.reads))[0];
    if (best) {
      list.push(
        `最好的一条《${String(best.title || '（无标题）').slice(0, 24)}》${fmtN(num(best.reads))} 阅读`
      );
    }

    // 本平台的粉丝（有才写）
    if (p2.followers != null) {
      list.push(`当前粉丝 ${fmtN(p2.followers)}`);
    }

    platFindings.set(p2.plat, list);
  }

  return {
    period,
    generatedAt: new Date().toISOString(),
    title: `账号运营报告 · ${period.short || period.label}`,
    total,
    platforms,
    ranked,
    similar,
    deltas,
    // 新增的分析素材（报告要「有内容」靠的就是这些）
    dailySeries,
    weeklySeries,
    weekdaySeries,
    quadrant,
    shareOfReads,
    compare,
    accountProfiles,
    findings,
    // 每个平台自己的数字结论（按平台分段时用）
    platFindings: Object.fromEntries(platFindings),
    // 按平台分组的作品（阅读降序），「各平台明细」里列本期作品用
    rankedByPlat,
    // 这次报告限定了哪些平台，空数组 = 全部
    scoped: Array.isArray(o.plats) ? o.plats.slice() : [],
    // 只保留真正需要提醒的：平台自己说过的事实
    caveats: [
      ...new Set(platforms.flatMap((p) => p.notes))
    ]
  };
}

// ---------------------------------------------------------------- 图（SVG）
/**
 * 报告里的图表用内联 SVG 画。
 *
 * 为什么不用图表库：报告要能离线打开、单文件发送。
 * 引一个库就得连 JS 一起带走，邮件里打开还会被拦。
 * 内联 SVG 是纯文本，跟着 HTML 走，哪台机器都能显示。
 *
 * 尺寸全部用固定 viewBox（900 宽），让它随纸张缩放 —— PDF 里是按 A4 排版，
 * 用百分比宽度反而会在分页时被拉变形。
 */

const SVG_W = 900;

const esc2 = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 横轴文字太多时隔几个标一个 —— 宁可少标，也不能糊成一片 */
function pickTicks(n, max = 8) {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil(n / max);
  const out = [];
  for (let i = 0; i < n; i += step) out.push(i);
  if (out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}

/**
 * 双轴折线：柱（发布量）+ 线（阅读量）。
 * 一张图同时回答「发了多少」和「效果如何」—— 只看一个都得不出判断。
 */
function svgTrend(series) {
  const data = (series || []).slice(-30);
  if (data.length < 2) return '';
  const W = SVG_W;
  const H = 260;
  const padL = 52;
  const padR = 52;
  const padT = 16;
  const padB = 34;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  const maxWorks = Math.max(...data.map((d) => d.works), 1);
  const maxReads = Math.max(...data.map((d) => d.reads), 1);
  const X = (i) => padL + (i / (data.length - 1)) * iw;
  const Yr = (v) => padT + (1 - v / maxReads) * ih;
  const barW = Math.max(3, Math.min(18, (iw / data.length) * 0.55));

  let g = `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="PingFang SC, Microsoft YaHei, sans-serif">`;

  // 横网格 + 右侧阅读刻度
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const y = padT + t * ih;
    g += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#e8ebf0" stroke-width="1"/>`;
    g += `<text x="${W - padR + 6}" y="${y + 4}" font-size="11" fill="#8a9099">${fmtN(Math.round(maxReads * (1 - t)))}</text>`;
  }
  // 左侧发布量刻度（只标满格，避免和右轴混）
  g += `<text x="${padL - 8}" y="${padT + 4}" font-size="11" fill="#b9bec7" text-anchor="end">${maxWorks} 条</text>`;

  // 柱：发布量
  data.forEach((d, i) => {
    const h = (d.works / maxWorks) * ih * 0.55;
    if (h <= 0) return;
    g += `<rect x="${(X(i) - barW / 2).toFixed(1)}" y="${(padT + ih - h).toFixed(1)}" width="${barW.toFixed(
      1
    )}" height="${h.toFixed(1)}" fill="#cfd9ee" rx="2"/>`;
  });

  // 线：阅读量
  const pts = data.map((d, i) => `${X(i).toFixed(1)},${Yr(d.reads).toFixed(1)}`);
  g += `<polyline points="${pts.join(' ')}" fill="none" stroke="#3d6ff0" stroke-width="2.2" stroke-linejoin="round"/>`;
  data.forEach((d, i) => {
    if (data.length > 12 && i !== 0 && i !== data.length - 1) return;
    g += `<circle cx="${X(i).toFixed(1)}" cy="${Yr(d.reads).toFixed(1)}" r="3" fill="#3d6ff0"/>`;
  });

  // 横轴日期
  for (const i of pickTicks(data.length, 7)) {
    g += `<text x="${X(i).toFixed(1)}" y="${H - 12}" font-size="10.5" fill="#8a9099" text-anchor="middle">${esc2(
      data[i].date.slice(5)
    )}</text>`;
  }
  g += `<text x="${padL}" y="${H - 12}" font-size="10.5" fill="#b9bec7">柱=发布量　线=阅读量</text>`;
  return g + '</svg>';
}

/** 横向条形：平台对比。条长按最大值归一，右边跟数值 */
function svgBars(rows, opts = {}) {
  const data = (rows || []).filter((r) => r.value != null && r.value > 0).slice(0, opts.limit || 10);
  if (!data.length) return '';
  const W = SVG_W;
  const rowH = 30;
  const H = data.length * rowH + 12;
  const labelW = opts.labelW || 150;
  const valW = 96;
  const barMax = W - labelW - valW - 8;
  const max = Math.max(...data.map((d) => d.value), 1);

  let g = `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="PingFang SC, Microsoft YaHei, sans-serif">`;
  data.forEach((d, i) => {
    const y = 6 + i * rowH;
    const bw = Math.max(2, (d.value / max) * barMax);
    g += `<text x="0" y="${y + 15}" font-size="12" fill="#3c424b">${esc2(
      String(d.label || '').slice(0, opts.labelMax || 12)
    )}</text>`;
    g += `<rect x="${labelW}" y="${y + 8}" width="${barMax}" height="10" rx="5" fill="#eef1f6"/>`;
    g += `<rect x="${labelW}" y="${y + 8}" width="${bw.toFixed(1)}" height="10" rx="5" fill="${d.color || '#3d6ff0'}"/>`;
    g += `<text x="${W}" y="${y + 16}" font-size="12" fill="#14161b" text-anchor="end" font-weight="600">${esc2(
      opts.fmt ? opts.fmt(d.value) : fmtN(d.value)
    )}</text>`;
  });
  return g + '</svg>';
}

/** 环形图：平台阅读占比。中心写总量 */
function svgDonut(parts, opts = {}) {
  const data = (parts || []).filter((p) => p.value > 0);
  if (!data.length) return '';
  const total = data.reduce((a, p) => a + p.value, 0);
  const W = SVG_W;
  const H = 250;
  const size = 200;
  const cx = size / 2 + 20;
  const cy = H / 2;
  const r = size / 2 - 8;
  const ir = r * 0.6;
  const COLORS = ['#3d6ff0', '#0a805a', '#a86a00', '#7a45d0', '#c2306b', '#0d7a8c', '#8a5a00', '#5b6472'];

  const arc = (a0, a1) => {
    const p = (rad, ang) => [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)];
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const [x1, y1] = p(r, a0);
    const [x2, y2] = p(r, a1);
    const [x3, y3] = p(ir, a1);
    const [x4, y4] = p(ir, a0);
    return `M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(
      1
    )} L${x3.toFixed(1)},${y3.toFixed(1)} A${ir},${ir} 0 ${large} 0 ${x4.toFixed(1)},${y4.toFixed(1)} Z`;
  };

  let g = `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="PingFang SC, Microsoft YaHei, sans-serif">`;
  let a0 = -Math.PI / 2;
  data.forEach((p, i) => {
    const a1 = a0 + (p.value / total) * Math.PI * 2;
    g += `<path d="${arc(a0, a1)}" fill="${COLORS[i % COLORS.length]}"/>`;
    a0 = a1;
  });
  g += `<text x="${cx}" y="${cy - 2}" font-size="20" font-weight="700" fill="#14161b" text-anchor="middle">${esc2(
    opts.center || fmtN(total)
  )}</text>`;
  g += `<text x="${cx}" y="${cy + 18}" font-size="11" fill="#8a9099" text-anchor="middle">${esc2(
    opts.centerSub || '总阅读'
  )}</text>`;

  // 图例右置，两列
  const lx = size + 60;
  data.forEach((p, i) => {
    const col = i < 5 ? 0 : 1;
    const row = i % 5;
    const x = lx + col * 330;
    const y = 42 + row * 38;
    g += `<rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" fill="${COLORS[i % COLORS.length]}"/>`;
    g += `<text x="${x + 18}" y="${y}" font-size="12" fill="#3c424b">${esc2(p.plat)}</text>`;
    g += `<text x="${x + 300}" y="${y}" font-size="12" fill="#14161b" text-anchor="end" font-weight="600">${esc2(
      (opts.fmt ? opts.fmt(p.value) : fmtN(p.value)) + ' · ' + p.pct + '%'
    )}</text>`;
  });
  return g + '</svg>';
}

/** 四象限散点：阅读（横）× 互动率（纵） */
function svgScatter(points) {
  const data = (points || []).filter((p) => p.reads > 0 && p.interRate != null);
  if (data.length < 3) return '';
  const W = SVG_W;
  const H = 320;
  const padL = 54;
  const padR = 22;
  const padT = 18;
  const padB = 46;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  const maxX = Math.max(...data.map((d) => d.reads), 1);
  const maxY = Math.max(...data.map((d) => d.interRate), 1);
  // 分界线用中位数，不用平均 —— 一条爆款会把平均拉高，其余全挤到下半区
  const med = (arr) => {
    const a = arr.slice().sort((p, q) => p - q);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const midX = med(data.map((d) => d.reads));
  const midY = med(data.map((d) => d.interRate));

  const X = (v) => padL + (v / maxX) * iw;
  const Y = (v) => padT + (1 - v / maxY) * ih;

  let g = `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="PingFang SC, Microsoft YaHei, sans-serif">`;
  // 右上角（既有人看又有互动）淡色底
  g += `<rect x="${X(midX).toFixed(1)}" y="${padT}" width="${(W - padR - X(midX)).toFixed(1)}" height="${(
    Y(midY) - padT
  ).toFixed(1)}" fill="#3d6ff0" fill-opacity="0.07"/>`;
  g += `<line x1="${X(midX).toFixed(1)}" y1="${padT}" x2="${X(midX).toFixed(1)}" y2="${H - padB}" stroke="#d6dbe4" stroke-dasharray="4 4"/>`;
  g += `<line x1="${padL}" y1="${Y(midY).toFixed(1)}" x2="${W - padR}" y2="${Y(midY).toFixed(
    1
  )}" stroke="#d6dbe4" stroke-dasharray="4 4"/>`;

  data.forEach((d) => {
    const good = d.reads >= midX && d.interRate >= midY;
    g += `<circle cx="${X(d.reads).toFixed(1)}" cy="${Y(d.interRate).toFixed(1)}" r="${
      good ? 5 : 3.6
    }" fill="${good ? '#3d6ff0' : '#aab2bf'}" fill-opacity="${good ? 0.9 : 0.6}"/>`;
  });

  // 象限标签
  g += `<text x="${W - padR - 6}" y="${padT + 16}" font-size="11" fill="#3d6ff0" text-anchor="end" font-weight="600">有曝光 · 也抓人</text>`;
  g += `<text x="${W - padR - 6}" y="${H - padB - 8}" font-size="11" fill="#8a9099" text-anchor="end">有曝光 · 没接住</text>`;
  g += `<text x="${padL + 6}" y="${padT + 16}" font-size="11" fill="#8a9099">小众 · 但抓人</text>`;
  // 轴标题
  g += `<text x="${padL}" y="${H - 8}" font-size="11" fill="#8a9099">阅读 →</text>`;
  g += `<text x="${W - padR}" y="${H - 8}" font-size="11" fill="#8a9099" text-anchor="end">最高 ${fmtN(
    maxX
  )}</text>`;
  g += `<text x="0" y="${padT + 8}" font-size="11" fill="#8a9099">互动率 ↑</text>`;
  g += `<text x="0" y="${Y(midY).toFixed(1)}" font-size="10.5" fill="#b9bec7">中位 ${midY.toFixed(
    1
  )}%</text>`;
  return g + '</svg>';
}

/**
 * 文本条形图。
 *
 * Markdown 和 Word 里塞不进 SVG，但没有图表的报告就是「一堆数字」。
 * 用方块字符画横条是纯文本界唯一稳的可视化 ——
 * 等宽字体下长度就是比例，被复制到聊天窗口、邮件里也不会走形。
 *
 * @param {Array<{label:string, value:number}>} rows
 * @param {{width?:number, fmt?:Function, max?:number}} opts
 */
function textBar(rows, opts = {}) {
  const data = (rows || []).filter((r) => r.value != null && r.value > 0).slice(0, opts.limit || 10);
  if (!data.length) return [];
  const width = opts.width || 28;
  const max = opts.max || Math.max(...data.map((d) => d.value), 1);
  const fmt = opts.fmt || fmtN;
  // 标签宽度对齐，让条形起点成一条直线
  const labelW = Math.min(24, Math.max(...data.map((d) => Array.from(String(d.label)).length)));
  const pad = (s, n) => {
    const arr = Array.from(String(s));
    if (arr.length >= n) return arr.slice(0, n - 1).join('') + '…';
    return String(s) + '　'.repeat(Math.ceil((n - arr.length) / 1));
  };
  return data.map((d) => {
    const len = Math.max(1, Math.round((d.value / max) * width));
    return `| ${pad(d.label, labelW)} | ${'█'.repeat(len)}${'　'.repeat(
      Math.max(0, width - len)
    )} | ${fmt(d.value)} |`;
  });
}

/**
 * 文本趋势图：按天，用不同高度的方块表示量级。
 * 和 SVG 那张双轴图同一个意思，只是精度低一点 —— 但比没有强得多。
 */
function textSpark(series, key = 'reads', opts = {}) {
  const data = (series || []).slice(-(opts.limit || 28));
  if (data.length < 2) return '';
  const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const max = Math.max(...data.map((d) => d[key] || 0), 1);
  const line = data
    .map((d) => {
      const v = d[key] || 0;
      if (v <= 0) return '·';
      const i = Math.min(BLOCKS.length - 1, Math.floor((v / max) * (BLOCKS.length - 1)));
      return BLOCKS[i];
    })
    .join('');
  const first = data[0].date || '';
  const last = data[data.length - 1].date || '';
  return `${line}  ${first.slice(5)} → ${last.slice(5)}（最高 ${fmtN(max)}）`;
}

// ---------------------------------------------------------------- Markdown

const fmtN = (v) => (v == null ? '—' : Number(v).toLocaleString('zh-CN'));
const fmtP = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`);

/**
 * 报告封面上那一行「覆盖平台」。
 *
 * 单平台导出时，读者第一眼必须知道这份只含一个平台 —— 否则会拿
 * 「公众号 12,409 阅读」当全平台总量用。
 */
function scopeLabel(rep) {
  const sc = rep.scoped || [];
  if (sc.length) return sc.join('、');
  /**
   * 不说「全部 11 个平台」—— 那句读起来像「系统一共只有 11 个平台」。
   * 实际是「系统里有 12 个，这次有 11 个读到数据」。
   * 差一个平台的读者会以为是漏了。
   */
  return `全部平台（${rep.total.platforms} 个有数据）`;
}

function toMarkdown(rep) {
  const L = [];
  const p = rep.period;

  /**
   * 表格单元格 / 行内文本的统一清洗。
   *
   * 三个字符各自会毁掉一段排版，而且全都是「看起来正常、读起来是错的」那种：
   *   |  → 直接把表格切出一列，后面的数全错位
   *   换行 → 表格从这里断成两行
   *   <  → markdown 会当成 HTML 标签，标签连同后面的文字一起不显示
   * 作品标题是平台给的，这几种字符都会出现（「A|B 对比」「<3 分钟」）。
   */
  const mdCell = (x) =>
    String(x == null ? '' : x)
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ')
      .replace(/</g, '&lt;');

  L.push(`# ${rep.title}`);
  L.push('');
  L.push(`> 生成时间：${new Date(rep.generatedAt).toLocaleString('zh-CN')}`);
  if (p.from) L.push(`> 统计区间：${p.from} ~ ${p.to}`);
  L.push(`> 覆盖平台：${scopeLabel(rep)}`);
  L.push('');

  // ---------- 结论（最重要，放最前）
  if (rep.findings.length) {
    L.push('## 本期结论');
    L.push('');
    rep.findings.forEach((f, i) => L.push(`${i + 1}. ${mdCell(f)}`));
    L.push('');
  }

  // ---------- 概览 + 环比
  L.push('## 概览');
  L.push('');
  L.push('| 项目 | 数值 |');
  L.push('| --- | --- |');
  L.push(`| 平台 | ${rep.total.platforms} |`);
  L.push(`| 账号 | ${rep.total.accounts} |`);
  L.push(`| 本期发布 | ${fmtN(rep.total.works)} 条 |`);
  L.push(`| 总粉丝 | ${fmtN(rep.total.followers)} |`);
  L.push(`| 总阅读 | ${fmtN(rep.total.reads)} |`);
  L.push('');

  if (rep.compare) {
    const c = rep.compare;
    const sgn = (v) => (v == null ? '—' : `${v > 0 ? '↑' : v < 0 ? '↓' : '→'}${Math.abs(v)}%`);
    L.push(`**与上一周期对比**（${c.prevFrom} ~ ${c.prevTo}，同样 ${c.days} 天）`);
    L.push('');
    L.push('| 指标 | 本期 | 上期 | 变化 |');
    L.push('| --- | --- | --- | --- |');
    L.push(`| 发布量 | ${fmtN(c.works.cur)} | ${fmtN(c.works.prev)} | ${sgn(c.works.pct)} |`);
    L.push(`| 阅读量 | ${fmtN(c.reads.cur)} | ${fmtN(c.reads.prev)} | ${sgn(c.reads.pct)} |`);
    L.push('');
  }

  // ---------- 趋势（文本图）
  if (rep.dailySeries.length >= 2) {
    L.push('## 发布与阅读趋势');
    L.push('');
    L.push('```');
    L.push('阅读 ' + textSpark(rep.dailySeries, 'reads'));
    L.push('发布 ' + textSpark(rep.dailySeries, 'works'));
    L.push('```');
    L.push('');
    L.push('按天看：上面一行是阅读量的高低，下面一行是发了多少条。');
    L.push('两条一起看才能区分「发得多」和「发得好」。');
    L.push('');
  }

  // ---------- 平台占比（文本条形）：只有一个平台时就是 100%，不必出现
  if (rep.shareOfReads.length > 1) {
    L.push('## 阅读量从哪来');
    L.push('');
    L.push('| 平台 | 占比 | 阅读 |');
    L.push('| --- | --- | --- |');
    for (const x of rep.shareOfReads.slice(0, 12)) {
      const len = Math.max(1, Math.round((x.pct / 100) * 30));
      L.push(`| ${x.plat} | ${'█'.repeat(len)} ${x.pct}% | ${fmtN(x.reads)} |`);
    }
    L.push('');
  }

  // ---------- 四象限
  if (rep.quadrant.length >= 3) {
    L.push('## 内容四象限：曝光 × 抓人');
    L.push('');
    L.push('横轴是阅读（平台给多少曝光），纵轴是互动率（读者愿不愿意动手）。');
    L.push('分界线取中位数，不是平均值 —— 一条爆款会把平均拉高，其余全被挤到下半区。');
    L.push('');
    const med = (arr) => {
      const a = arr.slice().sort((x, y) => x - y);
      const m = Math.floor(a.length / 2);
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    };
    const midX = med(rep.quadrant.map((d) => d.reads));
    const midY = med(rep.quadrant.map((d) => d.interRate));
    const groups = {
      '有曝光 · 也抓人': [],
      '有曝光 · 没接住': [],
      '小众 · 但抓人': [],
      其余: []
    };
    for (const d of rep.quadrant) {
      const hiX = d.reads >= midX;
      const hiY = d.interRate >= midY;
      const k = hiX && hiY ? '有曝光 · 也抓人' : hiX ? '有曝光 · 没接住' : hiY ? '小众 · 但抓人' : '其余';
      groups[k].push(d);
    }
    for (const [name, list] of Object.entries(groups)) {
      if (!list.length) continue;
      L.push(`**${name}**（${list.length} 条）`);
      L.push('');
      for (const d of list.slice(0, 4)) {
        L.push(`- [${d.plat}] ${mdCell(d.title || '（无标题）').slice(0, 34)} — ${fmtN(d.reads)} 阅读 / ${d.interRate}%`);
      }
      L.push('');
    }
    L.push(`_分界线：阅读 ≥ ${fmtN(Math.round(midX))}，互动率 ≥ ${midY.toFixed(1)}%_`);
    L.push('');
  }

  // ---------- 周几发
  const wdRows = rep.weekdaySeries.filter((x) => x.avgReads != null && x.works > 0);
  if (wdRows.length >= 2) {
    L.push('## 周几发效果更好');
    L.push('');
    L.push('用「平均阅读」而不是总量 —— 周三发得多不代表周三的内容好。');
    L.push('');
    L.push('| 星期 | 条数 | 平均阅读 |');
    L.push('| --- | --- | --- |');
    const wdMax = Math.max(...wdRows.map((x) => x.avgReads), 1);
    for (const x of wdRows) {
      const len = Math.max(1, Math.round((x.avgReads / wdMax) * 24));
      L.push(`| ${x.label} | ${x.works} | ${'█'.repeat(len)} ${fmtN(x.avgReads)} |`);
    }
    L.push('');
  }

  // ---------- 账号画像
  if (rep.accountProfiles.length) {
    L.push('## 各账号画像');
    L.push('');
    L.push('篇均阅读按总量比更公平，发得多的号不会靠数量排前面。');
    L.push('');
    L.push('| 平台 | 账号 | 作品 | 阅读 | 篇均 | 互动率 | 最好的一条 |');
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const a of rep.accountProfiles.slice(0, 14)) {
      const t = mdCell(a.bestTitle || '—').slice(0, 22);
      L.push(
        `| ${a.plat} | ${mdCell(a.account || '—')} | ${fmtN(a.works)} | ${fmtN(
          a.reads
        )} | ${fmtN(a.avgReads)} | ${fmtP(a.interRate)} | ${t}${
          a.bestReads != null ? `（${fmtN(a.bestReads)}）` : ''
        } |`
      );
    }
    L.push('');
  }

  // ---------- 分平台明细（每个平台自成一节：结论 + 指标 + 本期作品）
  const withData = rep.platforms.filter((x) => x.hasData);
  const noData = rep.platforms.filter((x) => !x.hasData);
  // 单平台报告里写「各平台明细」很怪 —— 就一个平台，直接叫它的名字
  L.push(`## ${withData.length === 1 ? `${withData[0].plat}明细` : '各平台明细'}`);
  L.push('');
  L.push('每个平台自成一节。上面的数只跟自己的历史比 —— 长文看分享、小红书看收藏、');
  L.push('B站看投币、视频号看完播，用同一套指标横着比是比不出东西的。');
  L.push('');

  if (!withData.length) {
    L.push('_本期没有任何平台读到数据。_');
    L.push('');
  }
  for (const p2 of withData) {
    // 单平台报告里标题已经写了平台名，这里再写一遍就重复了，改成「几个号」
    if (withData.length > 1) {
      L.push(`### ${p2.plat}${p2.accounts > 1 ? `（${p2.accounts} 个号）` : ''}`);
    } else if (p2.accounts > 1) {
      L.push(`### ${p2.accounts} 个号合计`);
    }
    L.push('');

    // 这个平台自己的数字结论
    const pf = (rep.platFindings && rep.platFindings[p2.plat]) || [];
    if (pf.length) {
      for (const x of pf) L.push(`- ${mdCell(x)}`);
      L.push('');
    }

    L.push('| 指标 | 数值 |');
    L.push('| --- | --- |');
    if (withData.length === 1) L.push(`| 账号 | ${p2.accounts} 个 |`);
    L.push(`| 粉丝 | ${fmtN(p2.followers)} |`);
    L.push(`| 本期发布 | ${fmtN(p2.works)} 条 |`);
    L.push(`| 阅读 | ${fmtN(p2.reads)} |`);
    L.push(`| 互动率 | ${fmtP(p2.interRate)} |`);
    for (const [k, label] of [
      ['shares', '分享'],
      ['saves', '收藏'],
      ['coins', '投币'],
      ['quotes', '引用'],
      ['danmaku', '弹幕'],
      ['recommend', '推荐'],
      ['completion', '完播率']
    ]) {
      const v = p2[k];
      if (v == null) continue;
      L.push(`| ${label} | ${k === 'completion' ? fmtP(v) : fmtN(v)} |`);
    }
    L.push('');

    // 该平台本期作品（前 5 条，按阅读降序）
    const pw = rep.rankedByPlat && rep.rankedByPlat[p2.plat];
    if (pw && pw.length) {
      L.push('本期作品（按阅读排序，前 5 条）');
      L.push('');
      L.push('| 标题 | 发布 | 阅读 | 赞 | 评 |');
      L.push('| --- | --- | --- | --- | --- |');
      for (const w of pw.slice(0, 5)) {
        const t = mdCell(w.title || '（无标题）').slice(0, 30);
        L.push(
          `| ${t} | ${w.publishedAt || '—'} | ${fmtN(w.reads)} | ${fmtN(w.likes)} | ${fmtN(w.comments)} |`
        );
      }
      L.push('');
    }

    if (p2.profile.angle && p2.profile.angle.note) {
      L.push(`_${p2.profile.angle.note}_`);
      L.push('');
    }
  }

  if (noData.length) {
    L.push('### 本期没有数据');
    L.push('');
    for (const p2 of noData) {
      L.push(`- **${p2.plat}**${p2.notes.length ? `：${mdCell(p2.notes.join('；'))}` : ''}`);
    }
    L.push('');
  }

  // ---------- 亮点
  if (rep.ranked.length) {
    L.push('## 本期表现最好的内容');
    L.push('');
    L.push('| 平台 | 标题 | 发布 | 阅读 | 互动率 |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const w of rep.ranked) {
      const t = mdCell(w.title || '（无标题）').slice(0, 40);
      L.push(`| ${w.plat} | ${t} | ${w.publishedAt || '—'} | ${fmtN(w.reads)} | ${fmtP(w.interRate)} |`);
    }
    L.push('');
  }

  // ---------- 同类对比
  if (rep.similar) {
    L.push(`## 同类对比（主题：${rep.similar.label}）`);
    L.push('');
    L.push(`同一题材共 ${rep.similar.count} 条。同一组内比才看得出「这个方向下哪种写法更好」，`);
    L.push('拿不同题材互相比，第一名往往只是平台给了曝光。');
    L.push('');
    L.push('| 标题 | 阅读 |');
    L.push('| --- | --- |');
    for (const w of rep.similar.rows) {
      const t = mdCell(w.title || '（无标题）').slice(0, 40);
      L.push(`| ${t} | ${fmtN(w.reads)} |`);
    }
    L.push('');
  }

  // ---------- 粉丝变化
  if (rep.deltas.length) {
    L.push('## 粉丝变化');
    L.push('');
    for (const d of rep.deltas) {
      const sign = d.delta > 0 ? '+' : '';
      L.push(`- **${d.plat} · ${d.account}**：${fmtN(d.from)} → ${fmtN(d.to)}（${sign}${d.delta}）`);
    }
    L.push('');
  }

  // ---------- 口径
  L.push('## 口径说明');
  L.push('');
  L.push('- 「—」表示平台没有给出这个数，不是 0');
  L.push('- 小红书、抖音的阅读是「近 7 天」口径，其余是累计');
  L.push('- 互动率 =（赞 + 评论 + 分享 + 收藏）÷ 阅读；平台和账号级只算阅读 ≥ 30 的作品（低于这个数一个赞就能让比例翻倍）');
  L.push('- 篇均阅读 = 该号本期总阅读 ÷ 条数，比总量公平');
  for (const c of rep.caveats) L.push(`- ${mdCell(c)}`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('_本报告由账号监控自动生成。数据全部来自本机，未经任何第三方服务器。_');

  return L.join('\n');
}


// ---------------------------------------------------------------- docx

function toDocx(rep) {
  const items = [];
  const p = rep.period;

  items.push({ type: 'title', text: rep.title });
  items.push({
    type: 'p',
    text:
      `生成时间：${new Date(rep.generatedAt).toLocaleString('zh-CN')}` +
      (p.from ? `　统计区间：${p.from} ~ ${p.to}` : '') +
      `　覆盖平台：${scopeLabel(rep)}`
  });
  items.push({ type: 'rule' });

  // ---------- 结论：放最前，老板只看这里
  if (rep.findings.length) {
    items.push({ type: 'h1', text: '本期结论' });
    rep.findings.forEach((f, i) => items.push({ type: 'p', text: `${i + 1}. ${f}` }));
  }

  // ---------- 概览 + 环比
  items.push({ type: 'h1', text: '概览' });
  items.push({
    type: 'table',
    rows: [
      ['项目', '数值'],
      ['平台', rep.total.platforms],
      ['账号', rep.total.accounts],
      ['本期发布', `${fmtN(rep.total.works)} 条`],
      ['总粉丝', fmtN(rep.total.followers)],
      ['总阅读', fmtN(rep.total.reads)]
    ]
  });

  if (rep.compare) {
    const c = rep.compare;
    const sgn = (v) => (v == null ? '—' : `${v > 0 ? '↑' : v < 0 ? '↓' : '→'}${Math.abs(v)}%`);
    items.push({ type: 'h2', text: `与上一周期对比（${c.prevFrom} ~ ${c.prevTo}，同样 ${c.days} 天）` });
    items.push({
      type: 'table',
      rows: [
        ['指标', '本期', '上期', '变化'],
        ['发布量', fmtN(c.works.cur), fmtN(c.works.prev), sgn(c.works.pct)],
        ['阅读量', fmtN(c.reads.cur), fmtN(c.reads.prev), sgn(c.reads.pct)]
      ]
    });
  }

  // ---------- 趋势（等宽块字符，Word 里也能看出高低）
  if (rep.dailySeries.length >= 2) {
    items.push({ type: 'h1', text: '发布与阅读趋势' });
    items.push({ type: 'mono', text: '阅读 ' + textSpark(rep.dailySeries, 'reads') });
    items.push({ type: 'mono', text: '发布 ' + textSpark(rep.dailySeries, 'works') });
    items.push({
      type: 'p',
      text: '按天看：第一行是阅读量高低，第二行是当天发了多少条。两条一起看才能区分「发得多」和「发得好」。'
    });
  }

  // ---------- 平台占比
  if (rep.shareOfReads.length > 1) {
    items.push({ type: 'h1', text: '阅读量从哪来' });
    items.push({
      type: 'p',
      text: '这张表回答「精力主要花在哪个平台上是有效的」。占比过低的平台，要么补内容，要么承认它只是占位。'
    });
    items.push({
      type: 'table',
      rows: [
        ['平台', '占比', '阅读'],
        ...rep.shareOfReads
          .slice(0, 12)
          .map((x) => [
            x.plat,
            `${'█'.repeat(Math.max(1, Math.round((x.pct / 100) * 24)))} ${x.pct}%`,
            fmtN(x.reads)
          ])
      ]
    });
  }

  // ---------- 四象限
  if (rep.quadrant.length >= 3) {
    items.push({ type: 'h1', text: '内容四象限：曝光 × 抓人' });
    items.push({
      type: 'p',
      text: '横轴是阅读（平台给多少曝光），纵轴是互动率（读者愿不愿意动手）。分界线取中位数，不是平均值 —— 一条爆款会把平均拉高，其余全被挤到下半区。'
    });
    const med = (arr) => {
      const a = arr.slice().sort((x, y) => x - y);
      const m = Math.floor(a.length / 2);
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    };
    const midX = med(rep.quadrant.map((d) => d.reads));
    const midY = med(rep.quadrant.map((d) => d.interRate));
    const groups = { '有曝光 · 也抓人': [], '有曝光 · 没接住': [], '小众 · 但抓人': [] };
    for (const d of rep.quadrant) {
      const hiX = d.reads >= midX;
      const hiY = d.interRate >= midY;
      const k = hiX && hiY ? '有曝光 · 也抓人' : hiX ? '有曝光 · 没接住' : hiY ? '小众 · 但抓人' : null;
      if (k) groups[k].push(d);
    }
    const rows = [['象限', '标题', '阅读', '互动率']];
    for (const [name, list] of Object.entries(groups)) {
      for (const d of list.slice(0, 4)) {
        rows.push([name, String(d.title || '（无标题）').slice(0, 26), fmtN(d.reads), `${d.interRate}%`]);
      }
    }
    if (rows.length > 1) items.push({ type: 'table', rows });
    items.push({ type: 'p', text: `分界线：阅读 ≥ ${fmtN(Math.round(midX))}，互动率 ≥ ${midY.toFixed(1)}%` });
  }

  // ---------- 周几发
  const wdRows = rep.weekdaySeries.filter((x) => x.avgReads != null && x.works > 0);
  if (wdRows.length >= 2) {
    items.push({ type: 'h1', text: '周几发效果更好' });
    items.push({ type: 'p', text: '用「平均阅读」而不是总量 —— 周三发得多不代表周三的内容好。' });
    const wdMax = Math.max(...wdRows.map((x) => x.avgReads), 1);
    items.push({
      type: 'table',
      rows: [
        ['星期', '条数', '平均阅读'],
        ...wdRows.map((x) => [
          x.label,
          x.works,
          `${'█'.repeat(Math.max(1, Math.round((x.avgReads / wdMax) * 20)))} ${fmtN(x.avgReads)}`
        ])
      ]
    });
  }

  // ---------- 账号画像
  if (rep.accountProfiles.length) {
    items.push({ type: 'h1', text: '各账号画像' });
    items.push({ type: 'p', text: '篇均阅读按总量比更公平，发得多的号不会靠数量排前面。' });
    items.push({
      type: 'table',
      rows: [
        ['平台', '账号', '作品', '阅读', '篇均', '互动率'],
        ...rep.accountProfiles
          .slice(0, 14)
          .map((a) => [a.plat, a.account || '—', fmtN(a.works), fmtN(a.reads), fmtN(a.avgReads), fmtP(a.interRate)])
      ]
    });
  }

  // ---------- 分平台明细（每平台一节：数字结论 + 指标 + 本期作品）
  const withDataD = rep.platforms.filter((x) => x.hasData);
  items.push({ type: 'h1', text: withDataD.length === 1 ? `${withDataD[0].plat}明细` : '各平台明细' });
  items.push({
    type: 'p',
    text: '每个平台自成一节。上面的数只跟自己的历史比 —— 长文看分享、小红书看收藏、B站看投币、视频号看完播。用同一套指标横着比是比不出东西的。'
  });

  if (!withDataD.length) items.push({ type: 'p', text: '本期没有任何平台读到数据。' });

  for (const p2 of withDataD) {
    if (withDataD.length > 1) {
      items.push({ type: 'h2', text: `${p2.plat}${p2.accounts > 1 ? `（${p2.accounts} 个号）` : ''}` });
    } else if (p2.accounts > 1) {
      items.push({ type: 'h2', text: `${p2.accounts} 个号合计` });
    }

    // 这个平台自己的数字结论
    const pfD = (rep.platFindings && rep.platFindings[p2.plat]) || [];
    for (const x of pfD) items.push({ type: 'bullet', text: x });

    const rows = [
      ['指标', '数值'],
      ...(withDataD.length === 1 ? [['账号', `${p2.accounts} 个`]] : []),
      ['粉丝', fmtN(p2.followers)],
      ['本期发布', `${fmtN(p2.works)} 条`],
      ['阅读', fmtN(p2.reads)],
      ['互动率', fmtP(p2.interRate)]
    ];
    for (const [k, label] of [
      ['shares', '分享'],
      ['saves', '收藏'],
      ['coins', '投币'],
      ['quotes', '引用'],
      ['danmaku', '弹幕'],
      ['recommend', '推荐'],
      ['completion', '完播率']
    ]) {
      const v = p2[k];
      if (v == null) continue;
      rows.push([label, k === 'completion' ? fmtP(v) : fmtN(v)]);
    }
    items.push({ type: 'table', rows });

    // 本期作品前 5（按阅读降序）
    const pwD = rep.rankedByPlat && rep.rankedByPlat[p2.plat];
    if (pwD && pwD.length) {
      items.push({ type: 'p', text: '本期作品（按阅读排序，前 5 条）' });
      items.push({
        type: 'table',
        rows: [
          ['标题', '发布', '阅读', '赞', '评'],
          ...pwD
            .slice(0, 5)
            .map((w) => [
              String(w.title || '（无标题）').slice(0, 30),
              w.publishedAt || '—',
              fmtN(w.reads),
              fmtN(w.likes),
              fmtN(w.comments)
            ])
        ]
      });
    }

    if (p2.profile.angle && p2.profile.angle.note) {
      items.push({ type: 'quote', text: p2.profile.angle.note });
    }
  }

  const noDataD = rep.platforms.filter((x) => !x.hasData);
  if (noDataD.length) {
    items.push({ type: 'h2', text: '本期没有数据' });
    for (const p2 of noDataD) {
      items.push({
        type: 'bullet',
        text: `${p2.plat}${p2.notes.length ? `：${p2.notes.join('；')}` : ''}`
      });
    }
  }

  const noData = rep.platforms.filter((x) => !x.hasData);
  if (noData.length) {
    items.push({ type: 'h2', text: '本期没有数据' });
    items.push({
      type: 'bullets',
      items: noData.map((x) => `${x.plat}${x.notes.length ? '：' + x.notes.join('；') : ''}`)
    });
  }

  // ---------- 亮点
  if (rep.ranked.length) {
    items.push({ type: 'h1', text: '本期表现最好的内容' });
    items.push({
      type: 'table',
      rows: [
        ['平台', '标题', '发布', '阅读', '互动率'],
        ...rep.ranked.map((w) => [
          w.plat,
          String(w.title || '（无标题）').slice(0, 30),
          w.publishedAt || '—',
          fmtN(w.reads),
          fmtP(w.interRate)
        ])
      ]
    });
  }

  // ---------- 同类对比
  if (rep.similar) {
    items.push({ type: 'h1', text: `同类对比（主题：${rep.similar.label}）` });
    items.push({
      type: 'p',
      text: `同一题材共 ${rep.similar.count} 条。同组内比才看得出「这个方向下哪种写法更好」；拿不同题材互相比，第一名往往只是平台给了曝光。`
    });
    const simMax = Math.max(...rep.similar.rows.map((w) => w.reads || 0), 1);
    items.push({
      type: 'table',
      rows: [
        ['标题', '阅读'],
        ...rep.similar.rows.map((w) => [
          String(w.title || '（无标题）').slice(0, 30),
          `${'█'.repeat(Math.max(1, Math.round(((w.reads || 0) / simMax) * 16)))} ${fmtN(w.reads)}`
        ])
      ]
    });
  }

  // ---------- 粉丝变化
  if (rep.deltas.length) {
    items.push({ type: 'h1', text: '粉丝变化' });
    items.push({
      type: 'bullets',
      items: rep.deltas.map(
        (d) => `${d.plat} · ${d.account}：${fmtN(d.from)} → ${fmtN(d.to)}（${d.delta > 0 ? '+' : ''}${d.delta}）`
      )
    });
  }

  // ---------- 口径
  items.push({ type: 'h1', text: '口径说明' });
  items.push({
    type: 'bullets',
    items: [
      '「—」表示平台没有给出这个数，不是 0',
      '小红书、抖音的阅读是「近 7 天」口径，其余是累计',
      '互动率 =（赞 + 评论 + 分享 + 收藏）÷ 阅读；平台和账号级只算阅读 ≥ 30 的作品，四象限只画阅读 ≥ 100 的',
      '篇均阅读 = 该号本期总阅读 ÷ 条数，比总量公平',
      ...rep.caveats
    ]
  });

  items.push({ type: 'rule' });
  items.push({ type: 'p', text: '本报告由账号监控自动生成。数据全部来自本机，未经任何第三方服务器。' });

  return makeDocx({ items });
}


// ---------------------------------------------------------------- HTML（给 PDF 用）

function toHtml(rep) {
  const esc = (x) =>
    String(x == null ? '' : x)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const p = rep.period;

  /**
   * 分区顺序就是阅读顺序：
   *   1. 结论先行（老板只看这一页）
   *   2. 整体趋势（这段时间在往哪走）
   *   3. 结构（谁贡献的、谁拖后腿）
   *   4. 内容层面（哪条好、哪类好）
   *   5. 分平台明细（要查数时看）
   */
  const findingsBlock = rep.findings.length
    ? `<section class="findings">
        <h2>本期结论</h2>
        <ol>${rep.findings
          .map((f) =>
            `<li>${esc(f)
              .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
              .replace(/《(.+?)》/g, '<b>《$1》</b>')}</li>`
          )
          .join('')}</ol>
      </section>`
    : '';

  // 环比：没有对比就没有判断
  const compareBlock = rep.compare
    ? (() => {
        const c = rep.compare;
        const arrow = (v) => (v == null ? '' : v > 0 ? '↑' : v < 0 ? '↓' : '→');
        const cls = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
        return `<div class="cmp">
          <div class="cmp-h">与上一周期对比（${esc(c.prevFrom)} ~ ${esc(c.prevTo)}，同样 ${c.days} 天）</div>
          <div class="cmp-row">
            <div class="cmp-item">
              <div class="k">发布量</div>
              <div class="v">${fmtN(c.works.cur)} <span class="${cls(c.works.pct)}">${arrow(
                c.works.pct
              )}${c.works.pct == null ? '—' : Math.abs(c.works.pct) + '%'}</span></div>
              <div class="s">上期 ${fmtN(c.works.prev)}</div>
            </div>
            <div class="cmp-item">
              <div class="k">阅读量</div>
              <div class="v">${fmtN(c.reads.cur)} <span class="${cls(c.reads.pct)}">${arrow(
                c.reads.pct
              )}${c.reads.pct == null ? '—' : Math.abs(c.reads.pct) + '%'}</span></div>
              <div class="s">上期 ${fmtN(c.reads.prev)}</div>
            </div>
          </div>
        </div>`;
      })()
    : '';

  // 趋势图
  const trendSvg = svgTrend(rep.dailySeries);
  const trendBlock = trendSvg
    ? `<section>
        <h2>发布与阅读趋势</h2>
        <p class="why">按天看：柱子是当天发了多少条，折线是当天带来的阅读。两条一起看才能区分「发得多」和「发得好」。</p>
        <figure>${trendSvg}</figure>
      </section>`
    : '';

  // 平台占比
  const shareSvg =
    rep.shareOfReads.length > 1
      ? svgDonut(
          rep.shareOfReads.map((x) => ({ plat: x.plat, value: x.reads, pct: x.pct })),
          { center: fmtN(rep.total.reads), centerSub: '总阅读' }
        )
      : '';
  const shareBlock = shareSvg
    ? `<section>
        <h2>阅读量从哪来</h2>
        <p class="why">这张图回答「我的精力主要花在哪个平台上是有效的」。占比过低的平台，要么补内容，要么承认它只是占位。</p>
        <figure>${shareSvg}</figure>
      </section>`
    : '';

  // 四象限
  const scatterSvg = svgScatter(rep.quadrant);
  const scatterBlock = scatterSvg
    ? `<section>
        <h2>内容四象限：曝光 × 抓人</h2>
        <p class="why">横轴是阅读（平台给多少曝光），纵轴是互动率（读者愿不愿意动手）。分界线取中位数，不是平均值 —— 一条爆款会把平均拉高，其余全被挤到下半区。右上角两项都在中位数以上，左下角两项都在中位数以下。</p>
        <figure>${scatterSvg}</figure>
      </section>`
    : '';

  // 星期分布
  const wdRows = rep.weekdaySeries.filter((x) => x.avgReads != null);
  const wdSvg = wdRows.length
    ? svgBars(
        wdRows.map((x) => ({ label: `${x.label}（${x.works} 条）`, value: x.avgReads })),
        { labelMax: 12 }
      )
    : '';
  const wdBlock = wdSvg
    ? `<section>
        <h2>周几发效果更好</h2>
        <p class="why">用「平均阅读」而不是总量 —— 周三发得多不代表周三的内容好。</p>
        <figure>${wdSvg}</figure>
      </section>`
    : '';

  // 单号画像
  const profileRows = rep.accountProfiles.slice(0, 14);
  const profileBlock = profileRows.length
    ? `<section>
        <h2>各账号画像</h2>
        <p class="why">篇均阅读按总量比更公平，发得多的号不会靠数量排前面。</p>
        <table class="list">
          <thead><tr>
            <th>平台</th><th>账号</th><th class="num">作品</th><th class="num">阅读</th>
            <th class="num">篇均</th><th class="num">互动率</th><th>最好的一条</th>
          </tr></thead>
          <tbody>${profileRows
            .map(
              (a) => `<tr>
                <td>${esc(a.plat)}</td>
                <td>${esc(a.account || '—')}</td>
                <td class="num">${fmtN(a.works)}</td>
                <td class="num">${fmtN(a.reads)}</td>
                <td class="num">${fmtN(a.avgReads)}</td>
                <td class="num">${fmtP(a.interRate)}</td>
                <td class="cell-title">${esc(String(a.bestTitle || '—').slice(0, 24))}${
                a.bestReads != null ? `（${fmtN(a.bestReads)}）` : ''
              }</td>
              </tr>`
            )
            .join('')}</tbody>
        </table>
      </section>`
    : '';

  // 分平台明细：每平台自成一节（数字结论 + 指标 + 本期作品）
  const platRows = rep.platforms.filter((x) => x.hasData);
  const platBlock = platRows
    .map((p2) => {
      const rows = [
        ...(platRows.length === 1 ? [['账号', `${p2.accounts} 个`]] : []),
        ['粉丝', fmtN(p2.followers)],
        ['本期发布', `${fmtN(p2.works)} 条`],
        ['阅读', fmtN(p2.reads)],
        ['互动率', fmtP(p2.interRate)]
      ];
      for (const [k, label] of [
        ['shares', '分享'],
        ['saves', '收藏'],
        ['coins', '投币'],
        ['quotes', '引用'],
        ['danmaku', '弹幕'],
        ['recommend', '推荐'],
        ['completion', '完播率']
      ]) {
        const v = p2[k];
        if (v == null) continue;
        rows.push([label, k === 'completion' ? fmtP(v) : fmtN(v)]);
      }

      // 这个平台自己的数字结论
      const pf = (rep.platFindings && rep.platFindings[p2.plat]) || [];
      const pfHtml = pf.length
        ? `<ul class="pf">${pf
            .map((x) => `<li>${esc(x).replace(/《(.+?)》/g, '<b>《$1》</b>')}</li>`)
            .join('')}</ul>`
        : '';

      // 本期作品前 5（按阅读降序）
      const pw = (rep.rankedByPlat && rep.rankedByPlat[p2.plat]) || [];
      const pwHtml = pw.length
        ? `<table class="list">
            <thead><tr><th>标题</th><th class="num">发布</th><th class="num">阅读</th><th class="num">赞</th><th class="num">评</th></tr></thead>
            <tbody>${pw
              .slice(0, 5)
              .map(
                (w) => `<tr>
                  <td class="cell-title">${esc(String(w.title || '（无标题）').slice(0, 30))}</td>
                  <td class="num">${esc(w.publishedAt || '—')}</td>
                  <td class="num">${fmtN(w.reads)}</td>
                  <td class="num">${fmtN(w.likes)}</td>
                  <td class="num">${fmtN(w.comments)}</td>
                </tr>`
              )
              .join('')}</tbody>
          </table>`
        : '';

      return `
      <div class="plat">
        ${
          platRows.length > 1
            ? `<h3>${esc(p2.plat)}${p2.accounts > 1 ? `（${p2.accounts} 个号）` : ''}</h3>`
            : p2.accounts > 1
              ? `<h3>${p2.accounts} 个号合计</h3>`
              : ''
        }
        ${p2.profile.focusWhy ? `<p class="why">${esc(p2.profile.focusWhy)}</p>` : ''}
        ${pfHtml}
        <table class="kv">
          ${rows.map(([a, b]) => `<tr><td>${esc(a)}</td><td class="num">${esc(b)}</td></tr>`).join('')}
        </table>
        ${pwHtml}
        ${p2.profile.angle && p2.profile.angle.note ? `<p class="why">${esc(p2.profile.angle.note)}</p>` : ''}
      </div>`;
    })
    .join('');

  const noData = rep.platforms.filter((x) => !x.hasData);
  const noDataBlock = noData.length
    ? `<div class="plat">
        <h3>本期没有数据</h3>
        <ul>${noData
          .map((x) => `<li><b>${esc(x.plat)}</b>${x.notes.length ? `：${esc(x.notes.join('；'))}` : ''}</li>`)
          .join('')}</ul>
      </div>`
    : '';

  const rankBlock = rep.ranked.length
    ? `<section>
        <h2>本期表现最好的内容</h2>
        <table class="list">
          <thead><tr><th>平台</th><th>标题</th><th class="num">发布</th><th class="num">阅读</th><th class="num">互动率</th></tr></thead>
          <tbody>${rep.ranked
            .map(
              (w) =>
                `<tr><td>${esc(w.plat)}</td><td class="cell-title">${esc(
                  String(w.title || '（无标题）').slice(0, 36)
                )}</td><td class="num">${esc(w.publishedAt || '—')}</td>` +
                `<td class="num">${esc(fmtN(w.reads))}</td><td class="num">${esc(fmtP(w.interRate))}</td></tr>`
            )
            .join('')}</tbody>
        </table>
      </section>`
    : '';

  const simBlock = rep.similar
    ? `<section>
        <h2>同类对比（主题：${esc(rep.similar.label)}）</h2>
        <p class="why">同一题材共 ${rep.similar.count} 条。同组内比才看得出「这个方向下哪种写法更好」；拿不同题材互相比，第一名往往只是平台给了曝光。</p>
        <figure>${svgBars(
          rep.similar.rows.map((w) => ({ label: String(w.title || '无标题').slice(0, 20), value: w.reads })),
          { labelMax: 20 }
        )}</figure>
        <table class="list">
          <thead><tr><th>标题</th><th class="num">阅读</th></tr></thead>
          <tbody>${rep.similar.rows
            .map(
              (w) =>
                `<tr><td class="cell-title">${esc(String(w.title || '（无标题）').slice(0, 40))}</td>` +
                `<td class="num">${esc(fmtN(w.reads))}</td></tr>`
            )
            .join('')}</tbody>
        </table>
      </section>`
    : '';

  const deltaBlock = rep.deltas.length
    ? `<section>
        <h2>粉丝变化</h2>
        <ul>${rep.deltas
          .map(
            (d) =>
              `<li><b>${esc(d.plat)} · ${esc(d.account)}</b>：${esc(fmtN(d.from))} → ${esc(
                fmtN(d.to)
              )}（<span class="${d.delta > 0 ? 'up' : 'down'}">${d.delta > 0 ? '+' : ''}${d.delta}</span>）</li>`
          )
          .join('')}</ul>
      </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Source Han Sans SC", sans-serif;
    font-size: 10.5pt; line-height: 1.65; color: #14161b;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  h1 { font-size: 21pt; margin: 0 0 4pt; letter-spacing: -0.01em; }
  h2 { font-size: 13pt; margin: 16pt 0 6pt; padding-bottom: 4pt; border-bottom: 1px solid #dfe3ea; }
  h3 { font-size: 11pt; margin: 10pt 0 4pt; }
  .meta { color: #5a6068; font-size: 9.5pt; margin-bottom: 12pt; }
  .why { color: #5a6068; font-size: 9.5pt; margin: 3pt 0 6pt; line-height: 1.6; }
  section { page-break-inside: avoid; }
  figure { margin: 6pt 0 4pt; }
  figure svg { display: block; width: 100%; height: auto; }

  /* 结论区：整份报告最重要的一块，视觉上要压得住 */
  .findings { background: #f5f8ff; border-left: 3px solid #3d6ff0; border-radius: 0 6pt 6pt 0; padding: 8pt 12pt 8pt 14pt; }
  .findings h2 { margin-top: 0; border: 0; padding: 0; }
  .findings ol { margin: 4pt 0 0; padding-left: 15pt; }
  .findings li { margin: 3pt 0; font-size: 10pt; line-height: 1.65; }
  .findings b { color: #1f3f9e; }

  /* 概览卡片 */
  .cards { display: flex; gap: 8pt; margin: 10pt 0 4pt; }
  .card { flex: 1; border: 1px solid #dfe3ea; border-radius: 6pt; padding: 7pt 10pt; }
  .card .k { font-size: 8.5pt; color: #6a7078; }
  .card .v { font-size: 15pt; font-weight: 700; font-variant-numeric: tabular-nums; }

  /* 环比 */
  .cmp { margin: 8pt 0; }
  .cmp-h { font-size: 9.5pt; color: #6a7078; margin-bottom: 4pt; }
  .cmp-row { display: flex; gap: 10pt; }
  .cmp-item { flex: 1; border: 1px solid #dfe3ea; border-radius: 6pt; padding: 7pt 10pt; background: #fbfcfd; }
  .cmp-item .k { font-size: 8.5pt; color: #6a7078; }
  .cmp-item .v { font-size: 14pt; font-weight: 700; font-variant-numeric: tabular-nums; }
  .cmp-item .s { font-size: 8.5pt; color: #8a9099; }

  table { width: 100%; border-collapse: collapse; margin: 5pt 0; }
  table.kv td { padding: 3pt 6pt; border-bottom: 1px solid #eef0f4; }
  table.kv td.num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  table.list th { text-align: left; padding: 4pt 6pt; background: #f3f5f9; font-size: 9pt; font-weight: 600; }
  table.list td { padding: 4pt 6pt; border-bottom: 1px solid #eef0f4; font-size: 9.5pt; }
  table.list td.num, table.list th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .cell-title { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .plat { page-break-inside: avoid; margin-bottom: 8pt; }
  ul.pf { margin: 2pt 0 5pt; padding-left: 15pt; }
  ul.pf li { font-size: 9.5pt; line-height: 1.6; }
  ul.pf b { color: #1f3f9e; }
  ul { margin: 3pt 0; padding-left: 15pt; }
  li { margin: 2pt 0; }
  .up { color: #c62828; font-weight: 700; }
  .down { color: #0a805a; font-weight: 700; }
  .foot { margin-top: 14pt; padding-top: 8pt; border-top: 1px solid #dfe3ea; color: #7a8088; font-size: 8.5pt; }
  .pagebreak { page-break-before: always; }
</style></head>
<body>
  <h1>${esc(rep.title)}</h1>
  <p class="meta">生成时间 ${esc(new Date(rep.generatedAt).toLocaleString('zh-CN'))}${
    p.from ? `　·　统计区间 ${esc(p.from)} ~ ${esc(p.to)}` : ''
  }　·　覆盖平台 ${esc(scopeLabel(rep))}</p>

  <div class="cards">
    <div class="card"><div class="k">平台</div><div class="v">${rep.total.platforms}</div></div>
    <div class="card"><div class="k">账号</div><div class="v">${rep.total.accounts}</div></div>
    <div class="card"><div class="k">本期发布</div><div class="v">${fmtN(rep.total.works)}</div></div>
    <div class="card"><div class="k">总粉丝</div><div class="v">${fmtN(rep.total.followers)}</div></div>
    <div class="card"><div class="k">总阅读</div><div class="v">${fmtN(rep.total.reads)}</div></div>
  </div>

  ${findingsBlock}
  ${compareBlock}
  ${trendBlock}
  ${shareBlock}
  ${scatterBlock}
  ${wdBlock}
  ${profileBlock}
  ${rankBlock}
  ${simBlock}
  ${deltaBlock}

  <div class="pagebreak"></div>
  <h2>${platRows.length === 1 ? `${esc(platRows[0].plat)}明细` : '分平台明细'}</h2>
  <p class="why">每个平台看自己最重要的那个数 —— 长文看分享、小红书看收藏、B站看投币、视频号看完播。用同一套指标横着比是比不出东西的。</p>
  ${platBlock}
  ${noDataBlock}

  <section>
    <h2>口径说明</h2>
    <ul>
      <li>「—」表示平台没有给出这个数，不是 0</li>
      <li>小红书、抖音的阅读是「近 7 天」口径，其余是累计</li>
      <li>互动率 =（赞 + 评论 + 分享 + 收藏）÷ 阅读；平台和账号级只算阅读 ≥ 30 的作品，四象限只画阅读 ≥ 100 的</li>
      <li>篇均阅读 = 该号本期总阅读 ÷ 条数，比总量公平</li>
      ${rep.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}
    </ul>
  </section>

  <div class="foot">本报告由账号监控自动生成。数据全部来自本机，未经任何第三方服务器。</div>
</body></html>`;
}

module.exports = { buildReport, periodOf, toMarkdown, toDocx, toHtml, fmtN, fmtP };
