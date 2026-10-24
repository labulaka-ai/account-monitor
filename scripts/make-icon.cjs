#!/usr/bin/env node
/**
 * 从一张 1024 见方的源图生成全平台应用图标
 *
 *   npm run icon                    # 用 build/icon-source.jpg
 *   npm run icon -- --crop 1.06     # 调整主体占比（>1 裁掉四周，让图形更饱满）
 *
 * 为什么不用图形工具：图标要出 icns 的 10 个尺寸和 ico 的 7 个尺寸，
 * 手工导出迟早会漏；而且圆角必须按 macOS 的超椭圆（squircle）算，
 * 直接裁圆角矩形在大尺寸下能看出「方肩」。
 *
 * 依赖只有 Electron 自带的 nativeImage —— 不引第三方图形库，也不开窗口：
 * 在内存里缩放、拼到 1024 画布、按超椭圆算 alpha、写 PNG。
 *
 * 产出的 icon.png / icon.icns / icon.ico 直接对应 package.json 的 build 配置。
 */
'use strict';

const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');

// macOS 图标规范：1024 画布，主体 824 见方，四周各留 100
const CANVAS = 1024;
const BODY = 824;
const PAD = (CANVAS - BODY) / 2;

// 超椭圆的指数。Apple 的实际取值略高于 4，5 是最接近的常用近似
const SQUIRCLE_N = 5;
// 边缘抗锯齿：每像素 4×4 子采样
const SS = 4;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

/**
 * 把平台图缩放并裁切到 BODY 见方，返回 BGRA buffer
 * crop > 1 表示先放大再取中心，等价于裁掉四周，图形显得更满
 */
function bodyBitmap(src, crop) {
  const img = nativeImage.createFromPath(src);
  if (img.isEmpty()) throw new Error(`读不出源图：${src}`);

  const sized = Math.round(BODY * crop);
  let work = img.resize({ width: sized, height: sized, quality: 'best' });
  if (sized > BODY) {
    const off = Math.round((sized - BODY) / 2);
    work = work.crop({ x: off, y: off, width: BODY, height: BODY });
  }
  const { width, height } = work.getSize();
  if (width !== BODY || height !== BODY) {
    work = work.resize({ width: BODY, height: BODY, quality: 'best' });
  }
  return work.toBitmap(); // BGRA，premultiplied
}

/**
 * 超椭圆遮罩：对每个像素做 SS×SS 子采样，得到覆盖面比例作为 alpha
 * 归一化坐标 u,v ∈ [-1,1]，内部满足 |u|^n + |v|^n <= 1
 */
function squircleAlpha(px, py) {
  const half = BODY / 2;
  let inside = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const x = (px + (sx + 0.5) / SS - half) / half;
      const y = (py + (sy + 0.5) / SS - half) / half;
      if (Math.pow(Math.abs(x), SQUIRCLE_N) + Math.pow(Math.abs(y), SQUIRCLE_N) <= 1) {
        inside++;
      }
    }
  }
  return inside / (SS * SS);
}

function compose(src, crop) {
  const bodyPx = bodyBitmap(src, crop);
  // 整张画布的 BGRA，初始全透明
  const canvas = Buffer.alloc(CANVAS * CANVAS * 4, 0);

  for (let y = 0; y < BODY; y++) {
    for (let x = 0; x < BODY; x++) {
      const a = squircleAlpha(x, y);
      if (a === 0) continue;
      const si = (y * BODY + x) * 4;
      const di = ((y + PAD) * CANVAS + (x + PAD)) * 4;
      // nativeImage 的 bitmap 是 premultiplied，乘 alpha 只需改 A 通道
      canvas[di] = bodyPx[si];
      canvas[di + 1] = bodyPx[si + 1];
      canvas[di + 2] = bodyPx[si + 2];
      canvas[di + 3] = Math.round(bodyPx[si + 3] * a);
    }
  }
  return nativeImage.createFromBitmap(canvas, { width: CANVAS, height: CANVAS });
}

/** ICO：PNG 内嵌格式，目录项 16 字节，large 尺寸的宽高写 0 */
function writeIco(png, sizes, out) {
  const entries = sizes.map((s) => {
    const buf = png.resize({ width: s, height: s, quality: 'best' }).toPNG();
    return { size: s, buf };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const b = i * 16;
    dir[b] = e.size >= 256 ? 0 : e.size;
    dir[b + 1] = e.size >= 256 ? 0 : e.size;
    dir[b + 2] = 0;
    dir[b + 3] = 0;
    dir.writeUInt16LE(1, b + 4); // color planes
    dir.writeUInt16LE(32, b + 6); // bits per pixel
    dir.writeUInt32LE(e.buf.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += e.buf.length;
  });

  fs.writeFileSync(out, Buffer.concat([header, dir, ...entries.map((e) => e.buf)]));
  return entries.length;
}

/** icns：交给系统工具，iconset 需要精确的命名 */
function writeIcns(pngPath, out) {
  const iconset = path.join(ROOT, '.tmp-icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });

  for (const base of [16, 32, 128, 256, 512]) {
    for (const suffix of ['', '@2x']) {
      const px = suffix ? base * 2 : base;
      const name = `icon_${base}x${base}${suffix}.png`;
      execFileSync('sips', ['-z', String(px), String(px), pngPath, '--out', path.join(iconset, name)], {
        stdio: 'ignore',
      });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', out]);
  fs.rmSync(iconset, { recursive: true, force: true });
}

app.whenReady().then(() => {
  try {
    const src = path.resolve(ROOT, arg('src', 'build/icon-source.jpg'));
    const crop = Number(arg('crop', '1.06'));

    if (!fs.existsSync(src)) throw new Error(`源图不存在：${src}`);
    console.log(`源图 ${path.relative(ROOT, src)}  crop ${crop}`);

    const icon = compose(src, crop);
    const pngPath = path.join(BUILD, 'icon.png');
    fs.writeFileSync(pngPath, icon.toPNG());
    const kb = Math.round(fs.statSync(pngPath).size / 1024);
    console.log(`icon.png   1024x1024  ${kb}KB  透明角`);

    const isMac = process.platform === 'darwin';
    if (isMac) {
      writeIcns(pngPath, path.join(BUILD, 'icon.icns'));
      console.log(`icon.icns  10 个尺寸`);
    } else {
      console.log('跳过 icns：需要 macOS 的 iconutil');
    }

    const n = writeIco(icon, [16, 24, 32, 48, 64, 128, 256], path.join(BUILD, 'icon.ico'));
    console.log(`icon.ico   ${n} 个尺寸`);
  } catch (err) {
    console.error('失败：' + err.message);
    process.exitCode = 1;
  }
  app.quit();
});
