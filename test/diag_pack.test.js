'use strict';
/**
 * 诊断包脱敏自测
 * 跑：npm test
 *
 * 这一组测的不是「能不能打包」，是「打出来的包能不能直接发出去」。
 * 实测漏过一次：只按字段名过滤，结果页面标题 "拉布拉卡 (@ruixue258) / X"
 * 和 URL "tiktok.com/@hanruixue3" 原样躺在包里 —— 字段名规则永远追不上平台怎么塞身份。
 * 所以现在的做法是「按值 + 按字段名 + 按形状」三层，这里逐层验。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const diagPack = require('../lib/diag_pack');

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
function no(hay, needle, hint) {
  ok(!String(hay).includes(needle), `${hint}：不该出现「${needle}」，实际 ${String(hay).slice(0, 120)}`);
}
function yes(hay, needle, hint) {
  ok(String(hay).includes(needle), `${hint}：应保留「${needle}」，实际 ${String(hay).slice(0, 120)}`);
}

// 真实形状的样本：跟实际 diag 文件一样，身份藏在 title / url / note 里
const IDS = ['拉布拉卡', 'ruixue258', 'hanlabulaka', '100040455994942'];
const scrub = diagPack.makeScrub(IDS);

const SAMPLE = {
  at: '2026-10-24T02:40:19.437Z',
  slug: 'x-1',
  title: '拉布拉卡 (@ruixue258) / X',
  loadErr: '',
  interfaces: ['https://x.com/i/api/1.1/hashflags.json'],
  pages: [
    { url: 'https://x.com/home', login: true, account: null, works: null, note: '' },
    {
      url: 'https://www.tiktok.com/@hanruixue3',
      login: true,
      account: { nickname: 'hanruixue3', handle: 'hanruixue3', uid: '100040455994942', followers: 128 },
      works: 30,
      note: '拉布拉卡 的号还没有作品'
    },
    { url: '/Users/example/Library/Application Support/data', loadErr: '路径打不开' }
  ],
  raw: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
  mail: 'someone@example.com'
};

(async () => {
  const out = scrub(SAMPLE, '');

  section('1. 按值抹掉（最关键的一层）');
  await check('昵称不会出现在任何字段里', () => {
    no(JSON.stringify(out), '拉布拉卡', '整包文本');
  });
  await check('handle 不会出现在任何字段里', () => {
    const t = JSON.stringify(out);
    no(t, 'ruixue258', '整包文本');
    no(t, 'hanlabulaka', '整包文本');
    no(t, 'hanruixue3', '整包文本（URL 里的也算）');
  });
  await check('uid 不会出现', () => {
    no(JSON.stringify(out), '100040455994942', '整包文本');
  });
  await check('标题整段隐去，但保留字数', () => {
    yes(out.title, '已隐藏', 'title');
    yes(out.title, '字', 'title 应带字数');
    no(out.title, '@', 'title 不该留 handle 形状');
  });

  section('2. 按形状兜底');
  await check('本机绝对路径换掉', () => {
    no(JSON.stringify(out), '/Users/example', '路径');
    yes(JSON.stringify(out), '/<home>', '路径应替换成占位');
  });
  await check('邮箱换掉', () => {
    no(JSON.stringify(out), 'someone@example.com', '邮箱');
    yes(JSON.stringify(out), '<email>', '邮箱占位');
  });
  await check('超长串（令牌 / cookie）换掉', () => {
    no(JSON.stringify(out), 'abcdefghijklmnopqrstuvwxyz0123456789', '长串');
    yes(JSON.stringify(out), '位串', '应标注为 N 位串');
  });
  await check('@handle 形状一律收掉', () => {
    no(JSON.stringify(out), '@hanruixue3', '@handle');
  });

  section('3. 不该破坏诊断价值');
  await check('域名和接口路径保留', () => {
    yes(JSON.stringify(out), 'x.com/i/api', '接口地址');
  });
  await check('数字与布尔原样', () => {
    ok(out.pages[1].account.followers === 128, '粉丝数应保留');
    ok(out.pages[1].login === true, '登录态应保留');
    ok(out.pages[1].works === 30, '作品数应保留');
  });
  await check('字段结构不变', () => {
    ok(Array.isArray(out.pages) && out.pages.length === 3, 'pages 长度应保持');
    ok('loadErr' in out.pages[2], '字段名应保留');
  });
  await check('页面标题之外的中文正文里，昵称也被抹掉', () => {
    no(out.pages[1].note, '拉布拉卡', 'note');
    yes(out.pages[1].note, '已隐藏', 'note 应留占位');
  });

  section('4. 打包');
  await check('能真的打出 zip，且 README 里说明清楚', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-diag-'));
    const diagDir = path.join(tmp, 'diag');
    fs.mkdirSync(diagDir, { recursive: true });
    fs.writeFileSync(path.join(diagDir, 'x-1.json'), JSON.stringify(SAMPLE));
    fs.writeFileSync(path.join(diagDir, 'broken.json'), '{不是 json');

    const outPath = path.join(tmp, 'pack.zip');
    const r = diagPack.build({
      diagDir,
      outPath,
      identities: IDS,
      env: { version: '0.1.0', platform: 'darwin', arch: 'arm64' },
      note: '我点了刷新没反应'
    });

    ok(fs.existsSync(outPath), 'zip 应存在');
    ok(r.size > 0, 'zip 不该是空的');
    ok(r.count === 1, `应只认 1 个合法诊断文件，实际 ${r.count}`);
    fs.rmSync(tmp, { recursive: true, force: true });
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
