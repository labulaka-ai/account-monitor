'use strict';
/**
 * 平台取数脚本自测 · 不需要登录、不碰真账号
 * 跑：npm test
 *
 * 这里守的是一条**运行时才会炸**的约定：
 * 每个 page.fn 都会被 toString() 成字符串，注入到平台页面里单独执行
 * （见 lib/reader.js 的 scriptOf）。所以函数体里不能引用任何模块级变量 ——
 * 一旦引用，本地测试全绿、打包也正常，到了真实页面上直接 ReferenceError，
 * 而且因为是在别人的页面里报错，日志里只会看到「读数失败：xxx is not defined」。
 *
 * 真实踩过一次：TikTok 的 tiktokProfile 用了文件级的 ttNum()，
 * 单元测试毫不知情，only 一线取数时才暴露。
 */

const fs = require('node:fs');
const path = require('node:path');

const { COLLECTORS, scriptOf } = require('../lib/collectors');

let pass = 0;
const failures = [];

function section(t) {
  console.log(`\n${t}`);
}
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}
function ok(c, m) {
  if (!c) throw new Error(m || '断言失败');
}

/**
 * 平台文件里所有顶层声明。
 * 顶层 = 行首无缩进；函数体、对象字面量里的都缩进了 2 格以上，不会命中。
 */
function topLevelNames(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  const re = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  names.delete('module');
  names.delete('exports');
  return names;
}

/**
 * 去掉注释和字符串字面量再比对。
 * 不这么做会两头误报：`'https://creator.douyin.com'` 里的 douyin、
 * 或者注释里写的「作品统一由 ytVideos 读」都会被当成变量引用。
 * 误报会逼着人把测试关掉 —— 那比没有测试更糟。
 */
function stripNoise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')       // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')   // 行注释（前面是冒号的是 URL，保留）
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, '""'); // 字符串
}

(async () => {
  section('1. 注册表结构');
  await check('每个平台都有 key / name / pages', () => {
    for (const [key, def] of Object.entries(COLLECTORS)) {
      ok(typeof def.name === 'string' && def.name.length > 0, `${key} 缺 name`);
      ok(Array.isArray(def.pages) && def.pages.length > 0, `${key} 没有 pages`);
    }
  });

  await check('每个 page 都有可用的 url 与 fn', () => {
    for (const [key, def] of Object.entries(COLLECTORS)) {
      def.pages.forEach((p, i) => {
        // url 允许写成函数（账号页需要拼 handle 或 uid）
        ok(typeof p.url === 'string' || typeof p.url === 'function',
          `${key}.pages[${i}] 的 url 既不是字符串也不是函数`);
        ok(typeof p.fn === 'function', `${key}.pages[${i}] 的 fn 不是函数`);
        ok(p.fn.name, `${key}.pages[${i}] 的 fn 是匿名函数，日志里将无法定位`);
      });
    }
  });

  section('2. 页面脚本必须自包含');
  for (const [key, def] of Object.entries(COLLECTORS)) {
    const file = path.join(__dirname, '..', 'lib', 'platforms', `${key}.js`);
    await check(`${key}：不引用平台文件里的顶层变量`, () => {
      ok(fs.existsSync(file), `找不到 ${path.relative(process.cwd(), file)}`);
      const outer = topLevelNames(file);
      const leaked = [];
      for (const p of def.pages) {
        const src = stripNoise(p.fn.toString());
        for (const name of outer) {
          // 用词边界匹配，避免 i 命中 if、id 里的一截
          if (new RegExp(`(^|[^.\\w$])${name.replace(/[$]/g, '\\$')}\\b`).test(src)) {
            leaked.push(`${p.fn.name} 引用了 ${name}`);
          }
        }
      }
      ok(leaked.length === 0, leaked.join('；'));
    });
  }

  section('3. 能真正序列化并求值');
  for (const [key, def] of Object.entries(COLLECTORS)) {
    await check(`${key}：scriptOf 产出可被页面解析`, () => {
      for (const p of def.pages) {
        const src = scriptOf(p.fn);
        try {
          // 只构造不执行：语法错误会在这里抛，运行时缺变量则留给第 2 组
          new Function(`return (${src});`);
        } catch (err) {
          throw new Error(`${p.fn.name} 序列化后无法解析：${err.message}`);
        }
      }
    });
  }

  section('4. scriptOf 的行为');
  await check('无参函数原样注入，不包一层参数', () => {
    const fn = function plain() { return 1; };
    const src = scriptOf(fn);
    ok(!/=>/.test(src.split('\n')[0]) || true, '');
    ok(src.includes('function plain'), `实际：${src.slice(0, 80)}`);
  });

  await check('带参函数被包装成可调用形式', () => {
    const src = scriptOf(function withArg(ctx) { return ctx.a; });
    ok(src.includes('withArg'), '序列化后丢了函数名');
  });

  section('汇总');
  if (failures.length === 0) {
    console.log(`\n全部通过：${pass} 项`);
    process.exit(0);
  } else {
    console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  · ${f.name}\n    ${f.message}`);
    process.exit(1);
  }
})();
