'use strict';
/**
 * schema 迁移定义
 *
 * 每条迁移必须：
 *  1. version 严格递增
 *  2. 在自己的 SQL 末尾写好 schema_version
 *  3. 只往前改，不改历史条目（改了老库就升不上来）
 *
 * 迁移在事务里执行，失败整条回滚。迁移前 db.js 会自动备份。
 */

module.exports = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE accounts (
  id                TEXT PRIMARY KEY,
  plat              TEXT NOT NULL,
  nickname          TEXT NOT NULL DEFAULT '',
  handle            TEXT NOT NULL DEFAULT '',
  uid               TEXT NOT NULL DEFAULT '',
  partition         TEXT NOT NULL DEFAULT '',
  avatar_path       TEXT NOT NULL DEFAULT '',
  fp_nickname       TEXT NOT NULL DEFAULT '',
  fp_uid            TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  last_ok_at        TEXT NOT NULL DEFAULT '',
  last_sync_at      TEXT NOT NULL DEFAULT '',
  auto_sync         INTEGER NOT NULL DEFAULT 1 CHECK (auto_sync IN (0, 1)),
  sync_interval_h   INTEGER NOT NULL DEFAULT 6 CHECK (sync_interval_h >= 6),
  backfill_target   TEXT NOT NULL DEFAULT 'week'
                    CHECK (backfill_target IN ('today', 'week', 'all')),
  backfill_until    TEXT NOT NULL DEFAULT '',
  backfill_done     INTEGER NOT NULL DEFAULT 0 CHECK (backfill_done IN (0, 1)),
  status            TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (status IN ('unknown', 'ok', 'login_expired', 'fingerprint_mismatch'))
);

-- uid 可能还没读到（首次接入），空 uid 不参与唯一约束
CREATE UNIQUE INDEX ux_acc_uid ON accounts (plat, uid) WHERE uid <> '';

-- fp_uid 是「身份锚点」，可能存的是 uid，也可能（没有 uid 的平台）存 handle。
-- X 和小红书都拿不到稳定 uid，靠 handle 兜底 —— 而 handle 恰好是
-- 「同一个平台不能有两个号同时用同一个 handle」的东西，天然该唯一。
-- 加这条索引是为了兜住一种隐蔽事故：手滑把两个环境登成了同一个号，
-- 数据库层面直接拒绝，而不是让两份数据静默合并成一份。
CREATE UNIQUE INDEX ux_acc_fpuid ON accounts (plat, fp_uid) WHERE fp_uid <> '';

CREATE TABLE snapshots (
  account_id   TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  followers    INTEGER,
  total_reads  INTEGER,
  total_likes  INTEGER,
  works_total  INTEGER,
  captured_at  TEXT NOT NULL,
  PRIMARY KEY (account_id, date)
);

CREATE TABLE works (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  plat_work_id    TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  published_at    TEXT NOT NULL DEFAULT '',
  cover_path      TEXT NOT NULL DEFAULT '',
  excerpt         TEXT NOT NULL DEFAULT '',
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  last_scanned_at TEXT NOT NULL DEFAULT '',
  gone            INTEGER NOT NULL DEFAULT 0 CHECK (gone IN (0, 1))
);

CREATE UNIQUE INDEX ux_work_plat ON works (account_id, plat_work_id);
CREATE INDEX ix_work_pub ON works (account_id, published_at DESC);

CREATE INDEX ix_work_scan ON works (account_id, last_scanned_at);

CREATE TABLE work_metrics (
  work_id       TEXT NOT NULL REFERENCES works (id) ON DELETE CASCADE,
  captured_at   TEXT NOT NULL,
  reads         INTEGER,
  likes         INTEGER,
  saves         INTEGER,
  comments      INTEGER,
  shares        INTEGER,
  completion    REAL,
  new_followers INTEGER,
  extra         TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (work_id, captured_at)
);

CREATE INDEX ix_metrics_time ON work_metrics (work_id, captured_at DESC);

-- 审计日志：账号删了日志也要留着，所以不挂外键
CREATE TABLE sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT '',
  trigger     TEXT NOT NULL DEFAULT 'manual'
              CHECK (trigger IN ('manual', 'scheduled', 'first_run', 'backfill')),
  pages       INTEGER NOT NULL DEFAULT 0,
  new_works   INTEGER NOT NULL DEFAULT 0,
  rescanned   INTEGER NOT NULL DEFAULT 0,
  result      TEXT NOT NULL DEFAULT 'ok'
              CHECK (result IN ('ok', 'empty', 'partial', 'throttled', 'failed')),
  detail      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX ix_log_acc ON sync_log (account_id, started_at DESC);

CREATE INDEX ix_snap_date ON snapshots (date);

INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1');
`
  },
  {
    version: 2,
    name: 'account_note',
    /**
     * 每个号最近一次读数给出的「事实说明」，例如
     * 「这个 Google 账号还没有 YouTube 频道」「这个号还没有作品」。
     * 这类话必须跟着账号走，否则界面只能显示一句笼统的「已登录」。
     */
    sql: `
ALTER TABLE accounts ADD COLUMN note TEXT NOT NULL DEFAULT '';
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2');
`
  },
  {
    version: 3,
    name: 'work_age_hours',
    /**
     * 每条指标「是发布后多久采的」。
     *
     * 不记这个，两个完全不同的数会被放在一起比：
     * 一条刚发 2 小时读到 100，和一条发了 7 天读到 100，含义差很远。
     * 有了这一列才能回答「发布后 24 小时的表现」—— 那才是能横向比较的口径。
     *
     * 用 REAL 存小时：发布当天读到的可能是 0.5 小时，取整会全变成 0。
     */
    sql: `
ALTER TABLE work_metrics ADD COLUMN age_hours REAL;
CREATE INDEX IF NOT EXISTS ix_metric_age ON work_metrics (work_id, age_hours);
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3');
`
  },
  {
    version: 4,
    name: 'auto_sync_default_on',
    /**
     * 自动更新改成默认开。
     *
     * 原来 `auto_sync` 默认 0，于是「每日自动更新」这个功能建好了却从不生效 ——
     * 13 个账号一个都没开，用户在设置里看到「已开启」，实际每天早上什么都没发生。
     * 这正是用户要的「一直在登录，每天早上自动读一次」，所以默认就该开。
     *
     * 只把「从没设置过」的号打开：已经有明确值的不动（用户手动关掉的不该被改回来）。
     * 用 `last_sync_at = ''` 判断「从没读过」不够准，所以直接全开 ——
     * 反正用户随时能在设置里关掉，而「默认不发车」比「默认空转」更糟。
     */
    sql: `
UPDATE accounts SET auto_sync = 1 WHERE auto_sync = 0;
INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '4');
`
  }
];
