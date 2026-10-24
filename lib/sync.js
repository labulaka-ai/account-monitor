'use strict';
/**
 * 增量同步引擎
 *
 * 设计要点
 *  1. 读数与落库分离：reader 只负责「读出来」，本文件负责「怎么存」。
 *     好处：核心逻辑可以拿假数据测透，不用真登录、不用开浏览器。
 *  2. 原子写入：一次更新要么全写，要么全不写。绝不出现半截数据。
 *  3. 全空不写：所有指标都没读到 → 只记一条 empty 日志，不动任何数据。
 *     违反这条会出现「面板停几秒把总粉丝冲掉」那种假掉粉。
 *  4. 空值不覆盖：这次没给粉丝数就沿用上次的（COALESCE），不要写 null。
 */

const db = require('./db');

const LIMITS = {
  maxPages: 12, // 单次访问页面数上限
  maxDurationMs: 6 * 60 * 1000, // 单次总时长上限
  maxRescan: 40, // 单次回扫作品数上限
  maxNewDetails: 8 // 一次最多点开几条新作品看详情
};

const ACCOUNT_FIELDS = ['followers', 'totalReads', 'totalLikes', 'worksTotal'];
const WORK_FIELDS = ['reads', 'likes', 'saves', 'comments', 'shares', 'completion', 'newFollowers'];

// ------------------------------------------------------------------ 工具
/**
 * 回扫间隔（天）。返回 null 表示这个年龄的作品不再自动回扫。
 * 依据：作品发布越久数据越稳，回扫频率随之降低，控制总量。
 */
function rescanEvery(ageDays) {
  if (ageDays == null || Number.isNaN(ageDays)) return 1; // 不知道发布时间 → 每次都看，保守
  if (ageDays <= 7) return 1;
  if (ageDays <= 30) return 3;
  if (ageDays <= 90) return 14;
  return null;
}

function hasValue(v) {
  return v !== null && v !== undefined && v !== '';
}

function hasAny(obj, fields) {
  return fields.some((k) => hasValue(obj && obj[k]));
}

/** 整次读数是不是空 —— 空就别写库 */
function isEmptyRead(read) {
  const accHas = hasAny(read.account, ACCOUNT_FIELDS);
  const workHas = (read.works || []).some((w) => hasAny(w, WORK_FIELDS));
  return !accHas && !workHas;
}

// ---------------------------------------------------------------- 节流
/**
 * 能不能现在跑。
 *  - paceMin：平台硬下限，手动点也不放过（防误触连点）
 *  - sync_interval_h：用户的更新频率，只约束自动更新；手动的客户自己负责
 */
function checkGate(account, adapter, { now, trigger }) {
  const nowTs = Date.parse(now);

  if (account.last_sync_at) {
    const last = Date.parse(account.last_sync_at);
    if (!Number.isNaN(last)) {
      const minutes = (nowTs - last) / 60000;
      const pace = (adapter && adapter.paceMin) || 15;
      if (minutes < pace) {
        return {
          ok: false,
          result: 'throttled',
          // 说人话：为什么不让读、什么时候能读。写成「未到 15 分钟下限」没人看得懂。
          // 分钟数用 floor：向上取整会出现「才 15 分钟，未到 15 分钟」这种自相矛盾的话
          detail: `距上次读取才 ${Math.max(1, Math.floor(minutes))} 分钟，为避免被平台当成机器人，满 ${pace} 分钟后再读`
        };
      }
    }
  }

  if (trigger === 'scheduled' && account.last_sync_at) {
    const last = Date.parse(account.last_sync_at);
    const hours = (nowTs - last) / 3600000;
    const want = account.sync_interval_h || 6;
    if (hours < want) {
      return {
        ok: false,
        result: 'throttled',
        detail: `你设的是每 ${want} 小时更新一次，上次到现在才 ${hours.toFixed(1)} 小时，还没到下一次`
      };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------- 写库
const SQL_SNAPSHOT_UPSERT = `
INSERT INTO snapshots (account_id, date, followers, total_reads, total_likes, works_total, captured_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (account_id, date) DO UPDATE SET
  followers   = COALESCE(excluded.followers, snapshots.followers),
  total_reads = COALESCE(excluded.total_reads, snapshots.total_reads),
  total_likes = COALESCE(excluded.total_likes, snapshots.total_likes),
  works_total = COALESCE(excluded.works_total, snapshots.works_total),
  captured_at = excluded.captured_at
`;

function workId(accountId, platWorkId) {
  return require('node:crypto')
    .createHash('sha1')
    .update(`${accountId}\u0000${platWorkId}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * 把一次读数写进库。调用方负责事务边界（见 syncAccount）。
 * @returns {{newWorks:number, rescanned:number, updatedWorks:number}}
 */
function writeRead(database, account, read, { today, now }) {
  const stmtSnap = database.prepare(SQL_SNAPSHOT_UPSERT);
  const stmtNewWork = database.prepare(`
    INSERT INTO works (id, account_id, plat_work_id, title, published_at, cover_path, excerpt,
                       first_seen_at, last_seen_at, last_scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtTouch = database.prepare(`
    UPDATE works SET title = ?, published_at = ?, last_seen_at = ?, gone = 0
    WHERE id = ?
  `);
  const stmtScan = database.prepare(`UPDATE works SET last_scanned_at = ? WHERE id = ?`);
  const stmtMetric = database.prepare(`
    INSERT INTO work_metrics (work_id, captured_at, reads, likes, saves, comments, shares,
                              completion, new_followers, extra, age_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtFind = database.prepare(`SELECT * FROM works WHERE account_id = ? AND plat_work_id = ?`);

  let newWorks = 0;
  let rescanned = 0;
  let updatedWorks = 0;

  // 1. 账号级日快照 —— 只写有值的字段，其余沿用旧值
  const acc = read.account || {};
  const worksTotal = read.worksTotal != null ? read.worksTotal : (read.works || []).length;
  /**
   * 写 0 还是留空，是两件事：
   *   平台明说「0 篇」        → 写 0（这是事实，界面上该显示 0）
   *   这次没拿到总数          → 留空（写 0 会被当成「确认没有」，把之前的数冲掉）
   * 之前一句 `worksTotal > 0 ? worksTotal : null` 把 0 一律丢掉了，
   * 结果 IG 这种空号永远显示「— 还没读到作品」。
   */
  const totalToWrite = read.worksTotalKnown ? worksTotal : worksTotal > 0 ? worksTotal : null;
  if (hasAny(acc, ACCOUNT_FIELDS) || totalToWrite != null) {
    stmtSnap.run(
      account.id,
      today,
      hasValue(acc.followers) ? acc.followers : null,
      hasValue(acc.totalReads) ? acc.totalReads : null,
      hasValue(acc.totalLikes) ? acc.totalLikes : null,
      totalToWrite,
      now
    );
  }

  // 2. 作品
  for (const w of read.works || []) {
    if (!w || !w.platWorkId) continue;

    const existing = stmtFind.get(account.id, w.platWorkId);
    const id = existing ? existing.id : workId(account.id, w.platWorkId);

    if (!existing) {
      stmtNewWork.run(
        id,
        account.id,
        w.platWorkId,
        w.title || '',
        w.publishedAt || '',
        w.coverPath || '',
        w.excerpt || '',
        now,
        now,
        now
      );
      newWorks++;
    } else {
      stmtTouch.run(w.title || existing.title, w.publishedAt || existing.published_at, now, id);
      updatedWorks++;
    }

    // 3. 指标：只有至少一个有效值时才追加一行
    const metrics = {};
    for (const k of WORK_FIELDS) metrics[k] = hasValue(w[k]) ? w[k] : null;
    /**
     * extra 也要算进「这条有没有数据」。
     * 否则一条 0 赞 0 评的帖子会被判成「什么都没读到」，里面带的
     * 类型（原创/回复/转发）、引用数、查看数就全丢了 —— 而这几项
     * 恰恰是表里唯一能区分「这条到底是不是我原创」的依据。
     */
    const extraObj = w.extra && typeof w.extra === 'object' ? w.extra : {};
    const extraUseful = Object.keys(extraObj).some(
      (k) => extraObj[k] != null && extraObj[k] !== ''
    );
    const extra = extraUseful ? JSON.stringify(extraObj) : '{}';

    /**
     * 这条指标是「发布后多久」采的。
     *
     * 只算得出来源可靠的：published_at 到采集时刻的小时数。
     * 算不出来（没发布日期、日期在将来、超过一年）就留 null ——
     * 宁可没有，也不要用一个假的时间刻度去做「24 小时对比」。
     */
    const ageHours = (() => {
      const p = String(w.publishedAt || existing.published_at || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p)) return null;
      const t0 = Date.parse(p + 'T00:00:00');
      const t1 = Date.parse(now);
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
      const h = (t1 - t0) / 3600000;
      // 负数是「发布日期在将来」（时区或平台填错），超过 365 天没有比较价值
      if (h < -24 || h > 24 * 365) return null;
      return Math.round(h * 10) / 10;
    })();

    if (hasAny(metrics, WORK_FIELDS) || extraUseful) {
      try {
        stmtMetric.run(
          id,
          now,
          metrics.reads,
          metrics.likes,
          metrics.saves,
          metrics.comments,
          metrics.shares,
          metrics.completion,
          metrics.newFollowers,
          extra,
          ageHours
        );
        if (existing) rescanned++;
      } catch (err) {
        // 同一毫秒重复采（几乎不可能），跳过这一条不影响整体
        if (!String(err.message).includes('UNIQUE')) throw err;
      }
    }

    if (existing) stmtScan.run(now, id);
  }

  // 4. 账号状态与游标：只有真的读到东西才推进 last_ok_at
  //    note 是这次读到的「事实说明」（没作品 / 没频道 / 平台不提供某项），跟着账号走
  database
    .prepare(`UPDATE accounts SET status = 'ok', last_ok_at = ?, last_sync_at = ?, note = ? WHERE id = ?`)
    .run(now, now, read.note || '', account.id);

  // 5. 这次把列表读全了，就把没再出现的作品标成已删除。
  //    不这么做，换过解析方式之后旧行会一直留在表里 —— 用户看到的是两拨数据混在一起。
  if (read.complete) {
    database
      .prepare(`UPDATE works SET gone = 1 WHERE account_id = ? AND gone = 0 AND last_seen_at < ?`)
      .run(account.id, now);
  }

  return { newWorks, rescanned, updatedWorks };
}

function writeLog(database, accountId, { now, trigger, pages, newWorks, rescanned, result, detail }) {
  database
    .prepare(
      `INSERT INTO sync_log (account_id, started_at, finished_at, trigger, pages, new_works, rescanned, result, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(accountId, now, now, trigger, pages, newWorks, rescanned, result, detail || '');
}

// ------------------------------------------------------------ 待回扫挑选
/**
 * 按作品年龄分层挑出这次该回扫的。
 * @param {Array} rows works 表里的行
 * @param {string} today YYYY-MM-DD
 * @param {number} limit 本次上限
 */
function pickRescanTargets(rows, today, limit) {
  const picked = [];
  for (const r of rows) {
    if (r.gone) continue;
    const age = r.published_at ? db.daysBetween(r.published_at, today) : NaN;
    const every = rescanEvery(age);
    if (every == null) continue; // 超过 90 天，不再自动回扫

    const since = r.last_scanned_at ? db.daysBetween(r.last_scanned_at, today) : Infinity;
    if (since < every) continue; // 还没到该扫的时候

    picked.push({ row: r, age: Number.isNaN(age) ? 9999 : age, every });
  }
  // 越新的作品越该先看
  picked.sort((a, b) => a.age - b.age);
  return picked.slice(0, limit);
}

// ------------------------------------------------------------ 主流程
/**
 * 同步一个账号。
 *
 * @param {object} ctx
 * @param {object} ctx.database   已打开的库
 * @param {object} ctx.account    accounts 表里的行
 * @param {object} ctx.adapter    平台适配器（提供 paceMin）
 * @param {object} ctx.reader     读数器：{ readAccount(account, opts) → read }
 * @param {string} [ctx.trigger]  manual | scheduled | first_run | backfill
 * @param {string} [ctx.now]      ISO 时间，测试可注入
 * @param {string} [ctx.today]    YYYY-MM-DD，测试可注入
 * @param {object} [ctx.limits]   覆盖 LIMITS
 */
async function syncAccount(ctx) {
  const {
    database,
    account,
    adapter,
    reader,
    trigger = 'manual',
    now = db.nowIso(),
    today = db.todayLocal(),
    limits = {}
  } = ctx;
  const L = Object.assign({}, LIMITS, limits);

  // 1. 节流
  //
  // 「从没成功读过」的号只拦 1 分钟内的连点，不按平台的正式间隔拦 ——
  // 用户刚登录完点了「完成」，上一次很可能是失败的空读（什么数据都没有），
  // 让他干等 8 分钟才准看数据，只会让人以为坏了。
  const neverOk = !account.last_ok_at;
  let gate;
  if (neverOk && account.last_sync_at) {
    const mins = (Date.parse(now) - Date.parse(account.last_sync_at)) / 60000;
    gate =
      mins < 1
        ? { ok: false, result: 'throttled', detail: `刚读过一次，${Math.max(5, Math.ceil(60 - mins * 60))} 秒后再试` }
        : { ok: true };
  } else {
    gate = checkGate(account, adapter, { now, trigger });
  }
  if (!gate.ok) {
    return { result: 'throttled', detail: gate.detail, newWorks: 0, rescanned: 0, pages: 0 };
  }

  // 2. 挑出这次要回扫的老作品（先挑，读的时候一起带上，省一次访问）
  const recent = database
    .prepare(`SELECT * FROM works WHERE account_id = ? AND gone = 0 ORDER BY published_at DESC LIMIT 500`)
    .all(account.id);
  const targets = pickRescanTargets(recent, today, L.maxRescan);

  // 3. 读
  let read;
  try {
    read = await reader.readAccount(account, {
      today,
      rescan: targets.map((t) => t.row),
      maxPages: L.maxPages,
      maxDurationMs: L.maxDurationMs,
      maxNewDetails: L.maxNewDetails
    });
  } catch (err) {
    writeLog(database, account.id, {
      now,
      trigger,
      pages: 0,
      newWorks: 0,
      rescanned: 0,
      result: 'failed',
      detail: `读数异常：${err.message}`
    });
    return { result: 'failed', detail: err.message, newWorks: 0, rescanned: 0, pages: 0 };
  }

  const pages = read.pages || 0;

  // 4. 登录失效 —— 这不是数据问题，是得人来处理
  if (read.status === 'login_expired' || read.status === 'fingerprint_mismatch') {
    database.prepare(`UPDATE accounts SET status = ?, last_sync_at = ? WHERE id = ?`).run(
      read.status,
      now,
      account.id
    );
    writeLog(database, account.id, {
      now,
      trigger,
      pages,
      newWorks: 0,
      rescanned: 0,
      result: 'failed',
      detail: read.status === 'login_expired' ? '登录已失效，需要本人重新登录' : '账号身份与记录不符，已停止写入'
    });
    return { result: 'failed', reason: read.status, newWorks: 0, rescanned: 0, pages };
  }

  /**
   * 5. 全空 —— 不建快照、不动 last_ok_at，但要把「这次到底是什么情况」写准。
   *
   * 这里有两个完全不同的情形，之前被混成一种：
   *
   *   a) **登录态是好的，平台就是没数字**（新频道 0 订阅、个人号不显示粉丝数）。
   *      这不是故障。如果只写 last_sync_at 不动 status，账号会一直停在
   *      `unknown` —— 界面显示「未登录」，而实际登录是好的（实测 YouTube
   *      就是这个表现：cookie 有效、读到了频道，卡片却说没登录）。
   *
   *   b) **真的什么都没读到**（页面没渲染、被拦）。这时才该保留原状态。
   *
   * 区分依据：采集器明确说了 `login: true`，并且给了 note（平台给的事实）。
   */
  if (isEmptyRead(read)) {
    // 登录确认过了 → status 就是 ok，别让「没有数字」被当成「没登录」
    const loginOk = read.status !== 'login_expired' && read.note;
    writeLog(database, account.id, {
      now,
      trigger,
      pages,
      newWorks: 0,
      rescanned: 0,
      result: 'empty',
      detail: read.note || '平台这次没有给出任何数字'
    });
    if (loginOk) {
      database
        .prepare(`UPDATE accounts SET status = 'ok', last_sync_at = ?, note = ? WHERE id = ?`)
        .run(now, read.note || '', account.id);
    } else {
      database
        .prepare(`UPDATE accounts SET last_sync_at = ?, note = ? WHERE id = ?`)
        .run(now, read.note || '', account.id);
    }
    return { result: 'empty', newWorks: 0, rescanned: 0, pages, note: read.note || '' };
  }

  // 6. 原子写入
  let stats;
  database.exec('BEGIN IMMEDIATE');
  try {
    stats = writeRead(database, account, read, { today, now });
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    writeLog(database, account.id, {
      now,
      trigger,
      pages,
      newWorks: 0,
      rescanned: 0,
      result: 'failed',
      detail: `写入失败已回滚：${err.message}`
    });
    return { result: 'failed', detail: err.message, newWorks: 0, rescanned: 0, pages };
  }

  // 7. 记日志
  writeLog(database, account.id, {
    now,
    trigger,
    pages,
    newWorks: stats.newWorks,
    rescanned: stats.rescanned,
    result: read.status === 'partial' ? 'partial' : 'ok',
    detail: read.note || ''
  });

  return {
    result: read.status === 'partial' ? 'partial' : 'ok',
    newWorks: stats.newWorks,
    rescanned: stats.rescanned,
    pages,
    note: read.note || ''
  };
}

module.exports = {
  LIMITS,
  ACCOUNT_FIELDS,
  WORK_FIELDS,
  syncAccount,
  writeRead,
  writeLog,
  checkGate,
  isEmptyRead,
  pickRescanTargets,
  rescanEvery,
  workId
};
