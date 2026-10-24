'use strict';
/**
 * 每日自动更新
 *
 * 用户要的行为，一句话说清：
 *   **每天早上自动读一次；其他时候我不点它就不动。**
 *
 * 为什么不做「每隔 N 小时轮询」：
 *   轮询看起来更"实时"，但对这些平台是纯负担 —— 每次读数都要打开真页面、
 *   走一遍接口，一天读十几次和一天读一次拿到的信息差不多，
 *   而被风控盯上的概率差十几倍。省下来的次数留给用户真想看的时候。
 *
 * 几条必须守的规矩：
 *   1. **一天只跑一次**（按本地日期判断）。用 last_sync_at 会出问题：
 *      用户手动读过一次，自动那次就被跳过了；用单独的日期戳才准。
 *   2. **开机晚了也要补跑**。电脑 9 点才开机，设定是 8 点，
 *      不能因为"错过了"就等到明天 —— 用户等的就是这个数。
 *   3. **错峰**。13 个号不能同一秒全开，否则瞬间十几个页面，
 *      既慢又像爬虫。每个号之间留 6~15 秒。
 *   4. **失败不重试当天**。已经试过了就等明天，别在失败上循环。
 *   5. **托盘常驻时也要跑**（窗口关了但应用还在）。
 */

const DAY_MS = 86400000;

/** 本地日期字符串，用于「今天跑过没有」 */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 算下一次该跑的时间点。
 * @param {number} hour 几点（0-23）
 * @param {number} minute 几分（0-59）
 * @param {Date} now
 */
function nextRunAt(hour, minute, now = new Date()) {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  // 今天这个点已经过了 → 明天
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t;
}

/**
 * 读取 / 保存「今天跑过了吗」。
 * 存在 meta 表里，跟着库走 —— 换机器、重装都不影响判断。
 */
function readState(db) {
  try {
    const a = db.prepare("SELECT value FROM meta WHERE key = 'auto_daily_date'").get();
    const b = db.prepare("SELECT value FROM meta WHERE key = 'auto_daily_result'").get();
    return { date: a ? a.value : '', result: b ? b.value : '' };
  } catch {
    return { date: '', result: '' };
  }
}

function writeState(db, date, result) {
  try {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('auto_daily_date', ?)").run(date);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('auto_daily_result', ?)").run(
      String(result || '').slice(0, 300)
    );
  } catch {
    /* meta 写不进去不该拦住读数 */
  }
}

/**
 * 建调度器。
 * @param {object} o
 * @param {object} o.db
 * @param {() => Array<object>} o.listAccounts 返回所有账号（要带 id / plat / auto_sync）
 * @param {(id: string) => Promise<object>} o.syncOne 读一个号
 * @param {(ev: object) => void} [o.onEvent] 进度回调（界面提示用）
 * @param {() => {hour:number, minute:number}} o.getTime 读用户设的时间
 */
function createScheduler(o) {
  const db = o.db;
  let timer = null;
  let running = false;
  /** 手动「现在就跑一次」时用的标记，跳过时间判断 */
  let forceNext = false;

  const emit = (ev) => {
    try {
      if (o.onEvent) o.onEvent(ev);
    } catch {
      /* 界面出错不影响调度 */
    }
  };

  /** 今天要不要跑 */
  function shouldRunToday() {
    const st = readState(db);
    return st.date !== localDate();
  }

  /**
   * 跑一轮：把所有「开着自动更新」的号读一次。
   *
   * 串行 + 抖动。不并行不是为了省事，是因为并行读同一批平台
   * 会同时开十几个页面，机器卡、也更容易被认出来。
   */
  async function runOnce(reason) {
    if (running) return { skipped: 'already-running' };
    running = true;
    const today = localDate();
    const out = { at: new Date().toISOString(), reason, total: 0, ok: 0, failed: 0, throttled: 0, details: [] };

    try {
      const list = (o.listAccounts() || []).filter((a) => a.auto_sync);
      out.total = list.length;

      if (!list.length) {
        // 一个都没开自动更新：记下今天跑过了，免得每分钟重算
        writeState(db, today, '没有开启自动更新的账号');
        emit({ phase: 'daily-skip', step: '没有开启自动更新的账号' });
        return out;
      }

      emit({ phase: 'daily-start', step: `每日更新开始（${list.length} 个号）` });

      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        emit({
          phase: 'daily-progress',
          accountId: a.id,
          plat: a.plat,
          step: `${a.plat}（${i + 1}/${list.length}）`
        });
        try {
          const r = await o.syncOne(a.id);
          if (r && r.result === 'ok') out.ok++;
          else if (r && r.result === 'throttled') out.throttled++;
          else out.failed++;
          out.details.push({ plat: a.plat, nickname: a.nickname || '', result: (r && r.result) || 'unknown' });
        } catch (err) {
          out.failed++;
          out.details.push({ plat: a.plat, nickname: a.nickname || '', result: 'failed', error: err.message });
        }
        // 号与号之间错峰：6~15 秒。固定间隔是机器特征
        if (i < list.length - 1) {
          await new Promise((r) => setTimeout(r, 6000 + Math.round(Math.random() * 9000)));
        }
      }

      const summary = `成功 ${out.ok}，受限 ${out.throttled}，失败 ${out.failed}`;
      writeState(db, today, summary);
      emit({ phase: 'daily-done', step: `每日更新完成：${summary}`, summary: out });
      return out;
    } finally {
      running = false;
      // 跑完就排下一次
      schedule();
    }
  }

  /** 排下一次 */
  function schedule() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const { hour, minute } = o.getTime ? o.getTime() : { hour: 8, minute: 30 };
    const at = nextRunAt(hour, minute);
    const ms = Math.max(1000, at.getTime() - Date.now());
    // setTimeout 的上限是 2^31-1 毫秒（约 24.8 天），这里最多一天，安全
    timer = setTimeout(() => {
      timer = null;
      // 到点再确认一次「今天是不是真的没跑过」，防止改过系统时间
      if (forceNext || shouldRunToday()) {
        forceNext = false;
        runOnce('scheduled').catch(() => {});
      } else {
        schedule();
      }
    }, ms);

    emit({ phase: 'daily-armed', step: `下次自动更新：${at.toLocaleString('zh-CN')}`, at: at.toISOString() });
    return at;
  }

  /**
   * 启动时调一次：
   *   · 今天已经跑过 → 只排明天
   *   · 今天还没跑、且已过设定时间 → **立刻补跑**（开机晚了也要补）
   *   · 今天还没跑、还没到设定时间 → 排到今天那个点
   */
  function start() {
    const { hour, minute } = o.getTime ? o.getTime() : { hour: 8, minute: 30 };
    const now = new Date();
    const todayPoint = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);

    if (!shouldRunToday()) {
      // 今天跑过了，排明天
      schedule();
      return { mode: 'already-today' };
    }

    if (now.getTime() >= todayPoint.getTime()) {
      // 已经过了今天的点但没跑过 → 补跑（延迟 20 秒，等界面和数据库都就绪）
      timer = setTimeout(() => {
        timer = null;
        runOnce('catchup').catch(() => {});
      }, 20000);
      emit({ phase: 'daily-armed', step: '今天的自动更新还没跑，稍后补上（20 秒后）' });
      return { mode: 'catchup' };
    }

    schedule();
    return { mode: 'scheduled' };
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** 手动立刻跑一轮（用户在设置里点「现在更新」时用） */
  async function runNow() {
    forceNext = false;
    return runOnce('manual-all');
  }

  return { start, stop, schedule, runNow, runOnce, state: () => readState(db), isRunning: () => running };
}

module.exports = { createScheduler, nextRunAt, localDate, readState, writeState };
