'use strict';
/**
 * 极简 zip 写入器（零依赖）
 *
 * 为什么不用 archiver / jszip 这类库：
 *   这个项目的前提是「不引第三方运行时依赖」，而 xlsx 和 docx 本质上都是
 *   zip 包着几个 XML。只为了打包几个字符串就引入几百 KB 依赖，还得为它
 *   处理打包时的路径问题，不划算。
 *
 * 只实现「写」（不实现读），够用就行：
 *   · store（不压缩）和 deflate（压缩）两种方式都支持
 *   · 用 node 自带的 zlib 做 deflate，不用自己写压缩
 *   · CRC32 自己算（zip 规范必需）
 *
 * 产出的包符合 PKZIP 2.0，Excel / Word / 系统解压工具都能正常打开。
 */

const zlib = require('node:zlib');

/**
 * CRC32 查找表。一次算好复用 —— 每次重新算会慢一个数量级。
 * 用的是标准多项式 0xEDB88320（zip / png / gzip 都用这个）。
 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** 现在的本地时间转 DOS 时间（zip 头里用的老格式） */
function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * 打一个 zip 包。
 * @param {Array<{name:string, data:Buffer|string}>} files
 * @param {{compress?:boolean}} [opts]
 * @returns {Buffer}
 */
function makeZip(files, opts = {}) {
  const compress = opts.compress !== false;
  const now = new Date();
  const { time, date } = dosTime(now);

  const entries = [];
  const chunks = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(String(f.name), 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(raw);

    /**
     * 短内容不压缩：deflate 一个 200 字节的 XML 可能反而变大，
     * 还会让 zip 里的数据看起来「有压缩」但实际没省。
     */
    let body = raw;
    let method = 0;
    if (compress && raw.length > 512) {
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      if (deflated.length < raw.length) {
        body = deflated;
        method = 8;
      }
    }

    // 本地文件头
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 签名
    local.writeUInt16LE(20, 4); // 需要的版本 2.0
    local.writeUInt16LE(0x0800, 6); // 标志位：文件名用 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); // 压缩后
    local.writeUInt32LE(raw.length, 22); // 原始
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra 长度

    chunks.push(local, nameBuf, body);

    entries.push({
      nameBuf,
      crc,
      method,
      compSize: body.length,
      rawSize: raw.length,
      offset
    });

    offset += local.length + nameBuf.length + body.length;
  }

  // 中央目录
  const cdStart = offset;
  const cdParts = [];
  for (const e of entries) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // 生成程序版本
    cd.writeUInt16LE(20, 6); // 需要版本
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.compSize, 20);
    cd.writeUInt32LE(e.rawSize, 24);
    cd.writeUInt16LE(e.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // 磁盘号
    cd.writeUInt16LE(0, 36); // 内部属性
    cd.writeUInt32LE(0, 38); // 外部属性
    cd.writeUInt32LE(e.offset, 42);
    cdParts.push(cd, e.nameBuf);
    offset += cd.length + e.nameBuf.length;
  }
  const cdSize = offset - cdStart;

  // 中央目录结束记录
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...cdParts, eocd]);
}

module.exports = { makeZip, crc32 };
