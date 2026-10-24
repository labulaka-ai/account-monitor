'use strict';
/**
 * 从本机 Chrome 读取登录态。
 *
 * 为什么需要这个：YouTube（Google）和 Meta 系（Instagram / Threads）
 * 对嵌入式浏览器和机房 IP 的登录动作限制很死。在我们自己的面板里登录，
 * 要么被 Google 判「不安全」，要么被 Meta 回「请稍后重试」。
 * 而用户自己的 Chrome 里通常是登着的——把那边的登录态搬过来，绕开整个授权流程。
 *
 * 做法（macOS）：
 *   Keychain "Chrome Safe Storage" → PBKDF2(saltysalt, 1003, 16) → AES-128-CBC
 *   IV 固定 16 个空格；v10 前缀；明文前 32 字节是 SHA256(host_key)，要跳过。
 *   Node 的 createDecipheriv 默认自动去 PKCS7 填充，不要再手动去一次。
 *
 * 只读不写，只碰指定域名，别的站点一概不导。
 */
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const run = promisify(execFile);

/**
 * 这台机器上 Chrome 的资料目录。
 *
 * 三个系统的位置完全不同，写死一个就会在另外两个上直接失效：
 *   macOS   ~/Library/Application Support/Google/Chrome
 *   Windows %LOCALAPPDATA%\Google\Chrome\User Data
 *   Linux   ~/.config/google-chrome
 * 顺带认一下 Edge / Chromium —— 它们的数据格式一样，用户装哪个都能导。
 */
function chromeRoots() {
  const home = os.homedir();
  const list = [];
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    list.push(path.join(base, 'Google', 'Chrome'));
    list.push(path.join(base, 'Microsoft Edge'));
    list.push(path.join(base, 'Chromium'));
  } else if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    list.push(path.join(base, 'Google', 'Chrome', 'User Data'));
    list.push(path.join(base, 'Microsoft', 'Edge', 'User Data'));
    list.push(path.join(base, 'Chromium', 'User Data'));
  } else {
    const base = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    list.push(path.join(base, 'google-chrome'));
    list.push(path.join(base, 'chromium'));
    list.push(path.join(base, 'microsoft-edge'));
  }
  return list.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/** 兼容老调用：返回第一个找到的根目录（找不到就是空字符串） */
const CHROME_DIR = () => chromeRoots()[0] || '';

/** 这台机器上有 Cookie 库的 Chrome 资料（Default、Profile 1 …） */
function listProfiles() {
  const out = [];
  const seen = new Set();
  for (const root of chromeRoots()) {
    const browser = path.basename(root).replace(/ User Data$/, '');
    try {
      for (const name of fs.readdirSync(root)) {
        // 「Default」和「Profile 1/2/3…」才是有资料的目录，其余是缓存
        if (name !== 'Default' && !/^Profile \d+$/.test(name)) continue;
        // Windows 把 Cookies 放在 <profile>\Network\Cookies，老版本在 <profile>\Cookies
        const candidates = [
          path.join(root, name, 'Network', 'Cookies'),
          path.join(root, name, 'Cookies')
        ];
        const db = candidates.find((f) => fs.existsSync(f));
        if (!db) continue;
        // 同一台机器可能装了 Chrome 和 Edge，用「浏览器/资料名」区分开
        const label = seen.has(name) ? `${browser}/${name}` : name;
        seen.add(name);
        out.push({ name: label, db });
      }
    } catch {
      /* 这个浏览器没装或没权限 */
    }
  }
  return out;
}

/**
 * Chrome 主密钥。第一次读 Keychain 时系统会弹一次授权框，属于正常现象。
 * 用异步 exec：这行命令会等用户点「允许」，同步执行会把整个窗口冻住。
 */
/**
 * Chrome 的主密钥。三个系统取法完全不同：
 *   macOS   Keychain（security 命令）
 *   Windows DPAPI 加密的 Local State，密钥派生用 PBKDF2(空密码, salt, 1, 32)
 *   Linux   gnome-keyring / kwallet，或者明文（取决于桌面环境）
 *
 * 这里只实现 macOS 的完整路径 —— 另外两个要引原生模块（DPAPI / D-Bus），
 * 和「零依赖」冲突。所以其他平台**明确说不支持**，让用户改用手动登录，
 * 而不是抛一个看不懂的错。
 */
async function masterKey() {
  if (process.platform !== 'darwin') {
    throw new Error(
      '「从 Chrome 导入登录态」目前只支持 macOS。' +
        '这个平台上请直接在右侧面板里登录一次 —— 效果一样，只是要自己输一次密码。'
    );
  }
  const { stdout } = await run('security', [
    'find-generic-password',
    '-s',
    'Chrome Safe Storage',
    '-w'
  ]);
  const pw = String(stdout || '').trim();
  if (!pw) throw new Error('Keychain 里没有 Chrome Safe Storage（Chrome 可能从未保存过密码）');
  return crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
}

function decryptValue(enc, hostKey, key) {
  const buf = Buffer.from(enc);
  if (!buf.length) return '';
  const prefix = buf.subarray(0, 3).toString();
  // v20 是 Chrome 的应用绑定加密，解不开；遇到就跳过，不假装成功
  if (prefix !== 'v10') return '';
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const out = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
  // 新版 Chrome 在明文前面塞了 SHA256(host_key)，对上了才切
  const h = crypto.createHash('sha256').update(hostKey).digest();
  const plain = out.length > 32 && out.subarray(0, 32).equals(h) ? out.subarray(32) : out;
  return plain.toString('utf8');
}

/** Chrome 的时间和 Unix 时间差 11644473600 秒（1601 → 1970） */
function chromeToUnix(utc) {
  // 微秒时间戳有 17 位，超过 JS 安全整数；从 SQLite 取时已转成字符串
  const n = Number(utc);
  if (!n || n <= 0) return undefined; // 会话 Cookie
  return Math.round(n / 1e6 - 11644473600);
}

function sameSiteOf(v) {
  // Chrome: -1 未指定 / 0 None / 1 Lax / 2 Strict
  if (v === 0) return 'no_restriction';
  if (v === 1) return 'lax';
  if (v === 2) return 'strict';
  return 'unspecified';
}

/**
 * 读某个 Chrome 资料里属于这些域名的 Cookie。
 * domains 是「后缀」形式，如 'youtube.com'，会匹配 .youtube.com / studio.youtube.com 等。
 */
async function readCookiesFor(domains, profileName) {
  const profiles = listProfiles();
  if (!profiles.length) throw new Error('这台电脑上没找到 Chrome 的资料目录');
  const target = profileName
    ? profiles.find((p) => p.name === profileName)
    : profiles[0];
  if (!target) throw new Error(`没找到 Chrome 资料：${profileName}`);

  // Chrome 开着的时候库是锁着的，复制一份再读
  const tmp = path.join(os.tmpdir(), `ck-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const copy = path.join(tmp, 'Cookies');
  fs.copyFileSync(target.db, copy);
  for (const ext of ['-wal', '-shm']) {
    try {
      fs.copyFileSync(target.db + ext, copy + ext);
    } catch {
      /* 没有就算了 */
    }
  }

  const db = new DatabaseSync(copy, { readOnly: true });
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT host_key, name, path,
                CAST(expires_utc AS TEXT) AS expires_utc,
                is_secure, is_httponly, samesite, value, encrypted_value
         FROM cookies`
      )
      .all();
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const wanted = domains.map((d) => d.toLowerCase().replace(/^\./, ''));
  const hit = rows.filter((r) => {
    const h = String(r.host_key || '').toLowerCase().replace(/^\./, '');
    return wanted.some((d) => h === d || h.endsWith('.' + d));
  });
  if (!hit.length) return { profile: target.name, cookies: [], encrypted: 0 };

  const key = await masterKey();
  const cookies = [];
  let encrypted = 0;
  for (const r of hit) {
    let value = r.value || '';
    if (!value && r.encrypted_value && r.encrypted_value.length) {
      try {
        value = decryptValue(r.encrypted_value, r.host_key, key);
      } catch {
        value = '';
      }
      if (!value) {
        encrypted++;
        continue;
      }
    }
    if (!value) continue;
    const secure = !!r.is_secure;
    const host = r.host_key || '';
    cookies.push({
      url: `${secure ? 'https' : 'http'}://${host.replace(/^\./, '')}${r.path || '/'}`,
      name: r.name,
      value,
      domain: host.startsWith('.') ? host : host,
      path: r.path || '/',
      secure,
      httpOnly: !!r.is_httponly,
      expirationDate: chromeToUnix(r.expires_utc),
      sameSite: sameSiteOf(r.samesite)
    });
  }
  return { profile: target.name, cookies, encrypted };
}

module.exports = { listProfiles, readCookiesFor };
