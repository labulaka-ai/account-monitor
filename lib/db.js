'use strict';
/**
 * 数据访问层 · SQLite（Electron 内置 node:sqlite，零依赖）
 *
 * 职责：打开库、设 PRAGMA、跑迁移（迁移前自动备份）、备份/恢复、时间与日期工具。
 * 不含业务逻辑 —— 增量同步在 sync.js，报表在 report.js。
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const migrations = require('./migrations');

const LATEST = migrations.reduce((m, x) => Math.max(m, x.version), 0);

// ---------------------------------------------------------------- 时间工具
// 一律用本地时间。客户看的是自己日历上的日期，用 UTC 会跟平台后台差一天。

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地日期 YYYY-MM-DD */
function todayLocal(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** ISO 时间戳（带毫秒，够区分同一秒内的两次采集） */
function nowIso(d = new Date()) {
  return d.toISOString();
}

/** 相对今天偏移 n 天的本地日期（n 为负数是往前） */
function dateOffset(n, base = new Date()) {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + n);
  return todayLocal(d);
}

/** 两个日期字符串相差几天（YYYY-MM-DD） */
function daysBetween(a, b) {
  const pa = Date.parse(`${a}T00:00:00`);
  const pb = Date.parse(`${b}T00:00:00`);
  if (Number.isNaN(pa) || Number.isNaN(pb)) return NaN;
  return Math.round((pb - pa) / 86400000);
}

// ------------------------------------------------------------------ 打开
/**
 * 打开数据库。父目录不存在会自动创建。
 * @param {string} dbPath 文件路径，或 ':memory:'
 */
function open(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);

  // WAL：读写不互相阻塞，崩溃后恢复快。内存库会退回 memory 模式，不报错。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  // 报表要排序、分组、窗口函数，给足临时空间和缓存（这两条直接影响曲线页的响应）
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA cache_size = -20000');

  return db;
}

// ---------------------------------------------------------------- 迁移
function schemaVersion(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  return row ? Number(row.value) : 0;
}

/**
 * 跑到最新版本。已经是最新就什么都不做（幂等）。
 * @returns {{from:number, to:number, applied:Array, backupPath:string}}
 */
function migrate(db, { dbPath = null, backupDir = null } = {}) {
  const from = schemaVersion(db);
  if (from >= LATEST) return { from, to: from, applied: [], backupPath: '' };

  // 老库升级前先备份一份 —— 升级失败能原样退回去
  let backupPath = '';
  if (from > 0 && dbPath && dbPath !== ':memory:' && backupDir) {
    backupPath = makeBackup(db, dbPath, backupDir, `before-v${from}`);
  }

  const applied = [];
  for (const m of migrations) {
    if (m.version <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.exec('COMMIT');
      applied.push({ version: m.version, name: m.name });
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`迁移到 v${m.version}（${m.name}）失败，已回滚：${err.message}`);
    }
  }

  return { from, to: schemaVersion(db), applied, backupPath };
}

// ------------------------------------------------------------ 备份与恢复
/** 备份文件名里的时间戳，冒号点号在文件名里不安全 */
function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/**
 * 把当前库备份成一个文件。先 checkpoint 把 WAL 落盘，再复制。
 * @returns {string} 备份文件路径
 */
function makeBackup(db, dbPath, backupDir, tag = 'backup') {
  if (!dbPath || dbPath === ':memory:') throw new Error('内存库不能备份到文件');
  fs.mkdirSync(backupDir, { recursive: true });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const dest = path.join(backupDir, `${tag}-${stamp()}.db`);
  fs.copyFileSync(dbPath, dest);
  return dest;
}

/** SQLite 文件头，用来挡住用户选错文件 */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');

function looksLikeSqlite(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    return buf.equals(SQLITE_MAGIC);
  } catch {
    return false;
  }
}

/**
 * 从备份恢复。调用方必须先关闭数据库连接，否则 WAL 文件会被写坏。
 * 恢复前会把现有库改名留底（.before-restore），不直接覆盖。
 */
function restore(dbPath, backupPath) {
  if (!fs.existsSync(backupPath)) throw new Error('备份文件不存在');
  if (!looksLikeSqlite(backupPath)) throw new Error('这个文件不是有效的数据库备份');

  if (fs.existsSync(dbPath)) {
    const keep = `${dbPath}.before-restore-${stamp()}`;
    fs.renameSync(dbPath, keep);
  }
  fs.copyFileSync(backupPath, dbPath);

  // 旧的 WAL/SHM 属于上一个库，留着会让新库读到脏页
  for (const ext of ['-wal', '-shm']) {
    const p = dbPath + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return true;
}

/** 完整性检查，恢复后跑一次 */
function integrityCheck(db) {
  const row = db.prepare('PRAGMA integrity_check').get();
  return row ? Object.values(row)[0] : 'unknown';
}

// ------------------------------------------------------------- schema 自检
function listTables(db) {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => r.name);
}

module.exports = {
  LATEST,
  open,
  migrate,
  schemaVersion,
  makeBackup,
  restore,
  integrityCheck,
  looksLikeSqlite,
  listTables,
  todayLocal,
  nowIso,
  dateOffset,
  daysBetween
};
