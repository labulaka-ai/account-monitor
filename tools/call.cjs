#!/usr/bin/env node
'use strict';
/**
 * 自测通道的客户端。
 *
 * 用法：node tools/call.cjs '{"op":"read","slug":"gzh-2"}'
 *      node tools/call.cjs plats
 *
 * 只用于开发：往 data/dev/cmd.json 写一条命令，等主进程把结果写进 out.json。
 */

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'data', 'dev');
const CMD = path.join(DIR, 'cmd.json');
const OUT = path.join(DIR, 'out.json');

const raw = process.argv.slice(2).join(' ').trim();
if (!raw) {
  console.error('用法：node tools/call.cjs \'{"op":"plats"}\'');
  process.exit(1);
}
let cmd;
try {
  cmd = JSON.parse(raw);
} catch {
  cmd = { op: raw };
}

fs.mkdirSync(DIR, { recursive: true });
try {
  fs.unlinkSync(OUT);
} catch {
  /* 没有上次结果 */
}
fs.writeFileSync(CMD, JSON.stringify(cmd), 'utf8');

const limit = Number(process.env.WAIT_MS || 90000);
const t0 = Date.now();
while (Date.now() - t0 < limit) {
  if (fs.existsSync(OUT)) {
    const out = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const d = out.out || {};
    if (!d.ok) {
      console.error('失败：', d.error);
      process.exit(1);
    }
    console.log(JSON.stringify(d.data, null, 2));
    process.exit(0);
  }
  // 同步等待，避免引入 async 之后还要处理未捕获异常
  try {
    require('node:child_process').execSync('sleep 0.4');
  } catch {
    /* 忽略 */
  }
}
console.error('超时：主进程没在 ' + limit + 'ms 内返回结果');
process.exit(2);
