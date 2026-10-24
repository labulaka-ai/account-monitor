#!/usr/bin/env node
'use strict';
/**
 * 打包前把个人数据从工作目录里剔出去。
 *
 * 为什么要单独一个脚本，而不是只靠 electron-builder 的 files 白名单：
 *   白名单写错一个通配符，你的数据库就跟着装进 .app 了。
 *   而 .app 是要发给别人的 —— 里面有 13 个账号的作品、粉丝数、
 *   分区路径、AI 密钥，甚至诊断文件里的页面原文。
 *   所以这里做**两件事**：先挪走，再校验。校验不过就不许打包。
 *
 * 用法：
 *   node scripts/clean-personal.cjs            # 检查（不动文件）
 *   node scripts/clean-personal.cjs --move     # 挪到 ../_personal-backup-<时间>
 *   node scripts/clean-personal.cjs --restore  # 挪回来
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BACKUP = path.join(path.dirname(ROOT), `_personal-backup-${Date.now()}`);
const MARK = path.join(path.dirname(ROOT), '_personal-backup-latest.txt');

/**
 * 这些路径**绝不能**进安装包。
 * 判断依据不是「文件名看起来像」，而是「里面有没有别人的东西」：
 *   data/       账号、作品、指标、密钥、诊断（页面原文）、导出
 *   screenshots/ 你自己的界面截图，上面有你的昵称和数字
 *   test/       测试用例里可能有真实示例数据
 *   .workbuddy/ 开发笔记（记录了这个项目的演进和各种判断依据）
 */
const PERSONAL = ['data', 'screenshots', 'test', '.workbuddy', '.git'];

/** 打包必须存在的文件 */
const REQUIRED = ['main.js', 'preload.js', 'package.json', 'ui/index.html', 'ui/app.css', 'mcp/server.js'];

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function check() {
  const problems = [];
  for (const f of REQUIRED) {
    if (!exists(path.join(ROOT, f))) problems.push(`缺少必需文件：${f}`);
  }
  return problems;
}

function move() {
  fs.mkdirSync(BACKUP, { recursive: true });
  const moved = [];
  for (const name of PERSONAL) {
    const src = path.join(ROOT, name);
    if (!exists(src)) continue;
    const dst = path.join(BACKUP, name);
    fs.renameSync(src, dst);
    moved.push(name);
  }
  fs.writeFileSync(MARK, BACKUP);
  return moved;
}

function restore() {
  let dir = '';
  try {
    dir = fs.readFileSync(MARK, 'utf8').trim();
  } catch {
    console.error('找不到备份记录，没法自动恢复。手动看一下：', path.dirname(ROOT));
    process.exit(1);
  }
  if (!exists(dir)) {
    console.error('备份目录不在了：', dir);
    process.exit(1);
  }
  const back = [];
  for (const name of PERSONAL) {
    const src = path.join(dir, name);
    if (!exists(src)) continue;
    const dst = path.join(ROOT, name);
    if (exists(dst)) {
      // 目标已存在就别覆盖 —— 可能是打包后又产生的数据，覆盖会丢
      console.warn(`跳过 ${name}：工作目录里已经有同名路径，没有覆盖`);
      continue;
    }
    fs.renameSync(src, dst);
    back.push(name);
  }
  return { dir, back };
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--restore')) {
    const r = restore();
    console.log(`已恢复 ${r.back.length} 项，来自 ${r.dir}`);
    for (const n of r.back) console.log('  ←', n);
    return;
  }

  if (args.includes('--move')) {
    const moved = move();
    console.log(`已挪走 ${moved.length} 项到 ${BACKUP}`);
    for (const n of moved) console.log('  →', n);
    const problems = check();
    if (problems.length) {
      console.error('\n仍不合格，先别打包：');
      for (const p of problems) console.error('  ✗', p);
      process.exit(1);
    }
    console.log('\n现在可以打包了。打完记得 node scripts/clean-personal.cjs --restore');
    return;
  }

  // 默认：只检查
  const problems = check();
  const present = PERSONAL.filter((n) => exists(path.join(ROOT, n)));
  console.log('打包环境检查\n');
  console.log('必需文件：', problems.length ? '有缺失' : '齐全');
  if (present.length) {
    console.log('\n发现个人数据（这些不该进安装包）：');
    for (const n of present) console.log('  !', n);
    console.log('\n要打包请先执行：node scripts/clean-personal.cjs --move');
    process.exit(1);
  }
  console.log('\n工作目录干净，可以打包。');
}

main();
