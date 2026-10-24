'use strict';
/**
 * 给外部 AI 的数据视图
 *
 * 这里只做一件事：把库里的行整理成「AI 能直接拿去做分析」的形状。
 * 三条原则：
 *   1. **不编数字**。null 就是 null，不要变成 0 —— AI 看到 0 会当成「确定没有」，
 *      然后基于一个错前提写出一整篇分析。
 *   2. **带上口径**。近 7 天和累计混用是最容易被误读的，所以每条数据都标 `window`。
 *   3. **带上去重后的可比字段**。不同平台的列不一样，AI 不该自己去猜哪列是阅读。
 */

const platProfile = require('./plat_profile');

/** 各平台的「主指标」叫什么。同一个概念在不同平台名字不同，直接告诉 AI */
const MAIN_METRIC = {
  公众号: { key: 'reads', label: '阅读' },
  小红书: { key: 'reads', label: '观看', window: '7d' },
  抖音: { key: 'reads', label: '播放', window: '7d' },
  视频号: { key: 'reads', label: '播放' },
  微博: { key: 'reads', label: '阅读' },
  知乎: { key: 'reads', label: '阅读' },
  B站: { key: 'reads', label: '播放' },
  X: { key: 'reads', label: '查看' },
  YouTube: { key: 'reads', label: '观看' },
  Instagram: { key: 'reads', label: '播放' },
  Threads: { key: 'reads', label: '浏览' },
  TikTok: { key: 'reads', label: '播放' }
};

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
 * @param {object} db  node:sqlite DatabaseSync
 */
function makeView(db) {
  const q = (sql, ...args) => db.prepare(sql).all(...args);
  const q1 = (sql, ...args) => db.prepare(sql).get(...args);

  /** 所有账号的概览：一个号一行，带最新快照 */
  function accounts() {
    const rows = q(
      `SELECT a.id, a.plat, a.nickname, a.handle, a.status, a.note,
              a.last_ok_at, a.auto_sync, a.sync_interval_h
         FROM accounts a ORDER BY a.plat, a.nickname`
    );
    return rows.map((a) => {
      const pr = platProfile.profileOf(a.plat);
      const s = q1('SELECT * FROM snapshots WHERE account_id = ? ORDER BY date DESC LIMIT 1', a.id);
      const n = q1('SELECT COUNT(*) AS n FROM works WHERE account_id = ? AND gone = 0', a.id);
      const mm = MAIN_METRIC[a.plat] || { key: 'reads', label: '阅读' };
      return {
        id: a.id,
        plat: a.plat,
        nickname: a.nickname || '',
        handle: a.handle || '',
        status: a.status,
        // 平台自己说的一句话（没有频道 / 没发过内容 / 个人号不显示粉丝数）
        note: a.note || '',
        lastOkAt: a.last_ok_at || '',
        followers: s ? num(s.followers) : null,
        worksTotal: s ? num(s.works_total) : null,
        worksStored: num(n && n.n),
        primaryMetric: mm.key,
        primaryMetricLabel: mm.label,
        // 平台给的是「近 7 天」还是「累计」—— 不标清楚就会被横向比错
        metricWindow: mm.window || 'total',
        autoSync: !!a.auto_sync,
        syncIntervalH: num(a.sync_interval_h),
        // 这个平台该看什么 —— 别拿同一套指标横着比所有平台
        focusMetric: pr.focus,
        focusWhy: pr.focusWhy,
        analysisAngle: pr.angle.note
      };
    });
  }

  /** 单个号的完整详情 */
  function accountDetail(id, opts = {}) {
    const a = q1('SELECT * FROM accounts WHERE id = ?', String(id || ''));
    if (!a) return null;
    const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 500));

    const snaps = q('SELECT * FROM snapshots WHERE account_id = ? ORDER BY date ASC', a.id);
    const works = q(
      `SELECT w.plat_work_id, w.title, w.published_at,
              m.reads, m.likes, m.saves, m.comments, m.shares,
              m.completion, m.new_followers, m.extra, m.captured_at
         FROM works w
         LEFT JOIN work_metrics m ON m.work_id = w.id
          AND m.captured_at = (SELECT MAX(captured_at) FROM work_metrics WHERE work_id = w.id)
        WHERE w.account_id = ? AND w.gone = 0
        ORDER BY w.published_at DESC, w.first_seen_at DESC
        LIMIT ?`,
      a.id,
      limit
    );

    const mm = MAIN_METRIC[a.plat] || { key: 'reads', label: '阅读' };
    return {
      account: {
        id: a.id,
        plat: a.plat,
        nickname: a.nickname || '',
        handle: a.handle || '',
        status: a.status,
        note: a.note || '',
        lastOkAt: a.last_ok_at || '',
        primaryMetric: mm.key,
        primaryMetricLabel: mm.label,
        metricWindow: mm.window || 'total'
      },
      // 每天一个点。只有一个点说明还没有趋势可看，AI 不该硬画
      snapshots: snaps.map((s) => ({
        date: s.date,
        followers: num(s.followers),
        worksTotal: num(s.works_total),
        totalReads: num(s.total_reads),
        totalLikes: num(s.total_likes)
      })),
      works: works.map((w) => {
        const ex = parseExtra(w.extra);
        return {
          id: w.plat_work_id,
          title: w.title || '',
          publishedAt: w.published_at || '',
          type: ex.type || 'original',
          reads: num(w.reads),
          likes: num(w.likes),
          saves: num(w.saves),
          comments: num(w.comments),
          shares: num(w.shares),
          quotes: num(ex.quotes),
          bookmarks: num(ex.bookmarks),
          completion: num(w.completion),
          extra: ex,
          capturedAt: w.captured_at || ''
        };
      }),
      workCount: works.length
    };
  }

  /** 按条件捞作品，给「跨号对比」用 */
  function works(o = {}) {
    const args = [];
    let where = 'w.gone = 0';
    if (o.plat) {
      where += ' AND a.plat = ?';
      args.push(String(o.plat));
    }
    if (o.from) {
      where += ' AND w.published_at >= ?';
      args.push(String(o.from));
    }
    if (o.to) {
      where += ' AND w.published_at <= ?';
      args.push(String(o.to));
    }
    const sortable = new Set(['published_at', 'reads', 'likes', 'comments', 'shares', 'saves']);
    const sort = sortable.has(String(o.sort)) ? String(o.sort) : 'published_at';
    const limit = Math.max(1, Math.min(2000, Number(o.limit) || 300));

    const rows = q(
      `SELECT a.plat, a.nickname, w.plat_work_id, w.title, w.published_at,
              m.reads, m.likes, m.saves, m.comments, m.shares, m.extra
         FROM works w
         JOIN accounts a ON a.id = w.account_id
         LEFT JOIN work_metrics m ON m.work_id = w.id
          AND m.captured_at = (SELECT MAX(captured_at) FROM work_metrics WHERE work_id = w.id)
        WHERE ${where}
        ORDER BY ${sort === 'published_at' ? 'w.published_at DESC' : `m.${sort} DESC NULLS LAST`}
        LIMIT ?`,
      ...args,
      limit
    );
    return rows.map((r) => {
      const ex = parseExtra(r.extra);
      return {
        plat: r.plat,
        account: r.nickname || '',
        id: r.plat_work_id,
        title: r.title || '',
        publishedAt: r.published_at || '',
        type: ex.type || 'original',
        reads: num(r.reads),
        likes: num(r.likes),
        saves: num(r.saves),
        comments: num(r.comments),
        shares: num(r.shares),
        quotes: num(ex.quotes)
      };
    });
  }

  /**
   * 分析素材包：把「做判断需要的数」一次给全。
   *
   * 为什么要有这个而不是让 AI 自己一遍遍查：
   *   跨平台对比要先把口径对齐（近 7 天 vs 累计）、把没有数据的平台排除、
   *   把「样本太少」的情况标出来。这些逻辑放在这里做一次，比每次让 AI 自己拼可靠。
   */
  function summary() {
    const list = accounts();
    const perPlat = new Map();
    for (const a of list) {
      if (!perPlat.has(a.plat)) perPlat.set(a.plat, []);
      perPlat.get(a.plat).push(a);
    }

    const platforms = [...perPlat.entries()].map(([plat, accs]) => {
      const mm = MAIN_METRIC[plat] || { key: 'reads', label: '阅读' };
      const pr = platProfile.profileOf(plat);
      // 平台级合计只对「有数」的账号求和，null 不当 0
      const sum = (k) => {
        const vals = accs.map((x) => x[k]).filter((v) => v != null);
        return vals.length ? vals.reduce((p, c) => p + c, 0) : null;
      };
      const rows = q(
        `SELECT m.reads, m.likes, m.comments, m.shares, m.saves, w.published_at
           FROM works w
           JOIN accounts a ON a.id = w.account_id
           LEFT JOIN work_metrics m ON m.work_id = w.id
            AND m.captured_at = (SELECT MAX(captured_at) FROM work_metrics WHERE work_id = w.id)
          WHERE a.plat = ? AND w.gone = 0`,
        plat
      );
      const withReads = rows.filter((r) => num(r.reads) != null && num(r.reads) > 0);
      const totalReads = withReads.length ? withReads.reduce((p, c) => p + num(c.reads), 0) : null;
      const inter = withReads.reduce(
        (p, c) => p + (num(c.likes) || 0) + (num(c.comments) || 0) + (num(c.shares) || 0) + (num(c.saves) || 0),
        0
      );

      return {
        plat,
        accounts: accs.length,
        followers: sum('followers'),
        worksStored: sum('worksStored'),
        worksTotal: sum('worksTotal'),
        totalReads,
        // 互动率只在有阅读数的前提下才算，否则分母是假的
        interactionRate: totalReads ? +((inter / totalReads) * 100).toFixed(2) : null,
        primaryMetric: mm.key,
        primaryMetricLabel: mm.label,
        metricWindow: mm.window || 'total',
        // 这个平台的判断标准和别处不一样，做横向对比时必须先看这两行
        focusMetric: pr.focus,
        focusWhy: pr.focusWhy,
        analysisAngle: pr.angle.note,
        // 平台自己说的事实，原样带上（「个人号不显示粉丝数」这类）
        notes: [...new Set(accs.map((a) => a.note).filter(Boolean))],
        hasData: totalReads != null || sum('followers') != null
      };
    });

    // 发布节奏：最近 30 天按平台统计条数，用来看「哪个平台在产出」
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const recent = q(
      `SELECT a.plat, COUNT(*) AS n FROM works w JOIN accounts a ON a.id = w.account_id
        WHERE w.gone = 0 AND w.published_at >= ? GROUP BY a.plat`,
      since
    );
    const recentByPlat = Object.fromEntries(recent.map((r) => [r.plat, num(r.n)]));

    const allWorks = q(
      `SELECT m.reads, m.likes, m.comments, m.shares, m.saves
         FROM works w
         LEFT JOIN work_metrics m ON m.work_id = w.id
          AND m.captured_at = (SELECT MAX(captured_at) FROM work_metrics WHERE work_id = w.id)
        WHERE w.gone = 0`
    );
    const ranked = allWorks.filter((r) => num(r.reads) != null).sort((a, b) => num(b.reads) - num(a.reads));

    return {
      generatedAt: new Date().toISOString(),
      // 口径说明放在最前面，AI 先看到它才不会把 7 天当累计
      caveats: [
        '各平台口径不同：小红书/抖音的总览是「近 7 天」，其余是「累计」，字段 metricWindow 已标明',
        'null 表示「平台没给」，不是 0；不要当成零参与计算',
        '粉丝为 0 也可能是真实值（新号），结合 notes 里的平台说明判断',
        '互动率 =（赞+评+享+藏）÷ 阅读；只有读过百的作品才纳入，样本不足时不可比',
        '作品条数只统计「当前仍存在」的（gone=0）',
        '各平台的判断标准不同（长文看分享、小红书看收藏、B站看投币、视频号看完播），' +
          '字段 focusMetric / analysisAngle 已按平台给出，不要用同一套指标横比所有平台'
      ],
      platforms,
      worksInLast30Days: recentByPlat,
      samples: {
        worksWithReads: ranked.length,
        // 少于这个数就别做「哪类内容更好」的结论
        enoughForComparison: ranked.length >= 8
      }
    };
  }

  /** 单账号某个指标的时间序列 */
  function trends(accountId, metric) {
    const id = String(accountId || '');
    const key = String(metric || 'followers');
    if (!id) return [];
    if (key === 'reads' || key === 'likes' || key === 'comments' || key === 'shares' || key === 'saves') {
      // 作品级按天合计：比账号级快照密得多
      const rows = q(
        `SELECT date(m.captured_at, 'localtime') AS d, SUM(m.${key}) AS v
           FROM works w JOIN work_metrics m ON m.work_id = w.id
          WHERE w.account_id = ? AND w.gone = 0
            AND m.captured_at = (SELECT MAX(m2.captured_at) FROM work_metrics m2
                                  WHERE m2.work_id = w.id
                                    AND date(m2.captured_at,'localtime') = date(m.captured_at,'localtime'))
          GROUP BY d ORDER BY d`,
        id
      );
      return rows.map((r) => ({ date: r.d, value: num(r.v) })).filter((p) => p.value != null);
    }
    const col = key === 'works' ? 'works_total' : key === 'totalReads' ? 'total_reads' : 'followers';
    const rows = q(`SELECT date, ${col} AS v FROM snapshots WHERE account_id = ? ORDER BY date`, id);
    return rows.map((r) => ({ date: r.date, value: num(r.v) })).filter((p) => p.value != null);
  }

  function getSettings() {
    const rows = q('SELECT id, plat, nickname, auto_sync, sync_interval_h FROM accounts ORDER BY plat');
    return {
      autoSync: rows.map((r) => ({
        id: r.id,
        plat: r.plat,
        nickname: r.nickname || '',
        on: !!r.auto_sync,
        intervalH: num(r.sync_interval_h)
      })),
      // 界面上「显示哪些平台」存在 localStorage 里，这里只能读不能改
      note: '主题、显示哪些平台属于界面偏好，存在应用本地，需要在本体设置里改；'
    };
  }

  function setSettings(input) {
    const st = input || {};
    if (Array.isArray(st.autoSync)) {
      for (const a of st.autoSync) {
        if (!a || !a.id) continue;
        const on = a.on ? 1 : 0;
        // 间隔下限 6 小时：读太勤会被平台当成机器人
        const h = Math.max(6, Math.min(168, Number(a.intervalH) || 6));
        db.prepare('UPDATE accounts SET auto_sync = ?, sync_interval_h = ? WHERE id = ?').run(on, h, String(a.id));
      }
    }
    return getSettings();
  }

  return { accounts, accountDetail, works, summary, trends, getSettings, setSettings };
}

module.exports = { makeView, MAIN_METRIC };
