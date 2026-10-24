'use strict';
/**
 * 给外部 AI 用的本地接口（HTTP · 只监听回环地址）
 *
 * 为什么做成 HTTP 而不是直接让 AI 读数据库：
 *   读数据库只能「看」，改不了任何东西；而且 Electron 跑着的时候库是 WAL 模式，
 *   第三方进程读到一半可能拿到不一致的快照。
 *   走一个本地接口，读和写都经过同一套校验，行为和界面里点按钮完全一致。
 *
 * 安全边界（这几条都不能松）：
 *   1. **只绑 127.0.0.1** —— 不做局域网服务，别的机器连不上。
 *   2. **必须有 token** —— 每次请求带 `Authorization: Bearer <token>`，
 *      用 crypto.timingSafeEqual 比较，防时序侧信道。
 *   3. **默认关闭** —— 用户不开就没有监听端口，不是「开了只是没鉴权」。
 *   4. **只暴露数据和读数，不暴露登录** —— 没有登录、没有 cookie、没有密码相关接口。
 *      别的 AI 永远不会拿到你的登录态。
 *   5. **不返回分区路径和 cookie 值** —— 那是能拿去干坏事的东西。
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT_DEFAULT = 47821;

/** 密钥文件：和数据库放一起，不出这台机器 */
function tokenPath(dataDir) {
  return path.join(dataDir, 'ai-token.txt');
}
function statePath(dataDir) {
  return path.join(dataDir, 'ai.json');
}

function readState(dataDir) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8'));
    if (s && typeof s === 'object') return s;
  } catch {
    /* 没有就是没开过 */
  }
  return { enabled: false, port: PORT_DEFAULT, createdAt: '' };
}

function writeState(dataDir, st) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(statePath(dataDir), JSON.stringify(st, null, 2));
}

/**
 * 取密钥；没有就生成一个。
 * 用 16 字节随机数转 hex —— 够长，也不会在日志里被误认为别的什么东西。
 */
function ensureToken(dataDir) {
  const p = tokenPath(dataDir);
  try {
    const t = fs.readFileSync(p, 'utf8').trim();
    if (t.length >= 32) {
      // 文件权限收紧：同机器上的其他用户不该读到它
      try {
        fs.chmodSync(p, 0o600);
      } catch {
        /* 改不了就算了 */
      }
      return t;
    }
  } catch {
    /* 下面生成 */
  }
  const t = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(p, t + '\n', { mode: 0o600 });
  return t;
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  if (A.length !== B.length) return false;
  try {
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

/**
 * 启动接口服务。
 * @param {object} o
 * @param {string} o.dataDir
 * @param {number} [o.port]
 * @param {object} o.deps  主进程提供的能力（查库、读数、改设置）
 * @returns {Promise<{server:http.Server, port:number, token:string}>}
 */
async function start(o) {
  const dataDir = o.dataDir;
  const token = ensureToken(dataDir);
  const port = Number(o.port) || readState(dataDir).port || PORT_DEFAULT;
  const deps = o.deps;

  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj, null, 2);
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        // 本地接口不需要被任何浏览器缓存
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(body);
    };

    // 只认回环来源：即使有人把端口转发进来，这条也挡得住 Host 伪造的常见形态
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      send(403, { ok: false, error: '只接受本机请求' });
      return;
    }

    const auth = String(req.headers.authorization || '');
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!safeEqual(given, token)) {
      send(401, { ok: false, error: '密钥不对。在应用「设置」里可以看到正确的密钥。' });
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const p = url.pathname.replace(/\/+$/, '') || '/';

    const body = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // 本地接口不该收大包，超过 256KB 直接断，避免被当成上传口
      if (size > 256 * 1024) req.destroy();
      else body.push(c);
    });
    req.on('end', async () => {
      let input = {};
      if (body.length) {
        try {
          input = JSON.parse(Buffer.concat(body).toString('utf8') || '{}');
        } catch {
          send(400, { ok: false, error: '请求体不是合法 JSON' });
          return;
        }
      }
      try {
        const out = await route(p, req.method, input, url, deps);
        if (out === undefined) send(404, { ok: false, error: `没有这个接口：${p}` });
        else send(200, out);
      } catch (err) {
        // 出错要说人话，不要把堆栈丢给对面（堆栈里可能有本机路径）
        send(500, { ok: false, error: String(err && err.message ? err.message : err) });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return { server, port, token };
}

async function route(p, method, input, url, deps) {
  const q = (k, d) => {
    const v = url.searchParams.get(k);
    return v == null ? d : v;
  };

  if (p === '/' || p === '/health') {
    return {
      ok: true,
      name: '账号监控 · 本地数据接口',
      version: deps.version(),
      // 让对面知道能做什么，比自己猜强
      endpoints: [
        'GET  /accounts',
        'GET  /accounts/:id',
        'GET  /works?plat=&from=&to=&sort=&limit=',
        'GET  /summary',
        'GET  /trends?accountId=&metric=',
        'GET  /settings',
        'POST /settings',
        'POST /sync            { accountId?, plat? }',
        'POST /export          { accountId }'
      ]
    };
  }

  if (p === '/accounts') return { ok: true, accounts: deps.accounts() };

  const mAcc = /^\/accounts\/([A-Za-z0-9_-]+)$/.exec(p);
  if (mAcc) {
    const d = deps.accountDetail(mAcc[1], { limit: Number(q('limit', 500)) });
    if (!d) throw new Error('没有这个号');
    return { ok: true, ...d };
  }

  if (p === '/works') {
    const rows = deps.works({
      plat: q('plat', ''),
      from: q('from', ''),
      to: q('to', ''),
      sort: q('sort', 'published_at'),
      limit: Math.min(2000, Number(q('limit', 300)))
    });
    return { ok: true, count: rows.length, works: rows };
  }

  if (p === '/summary') {
    return { ok: true, ...deps.summary() };
  }

  if (p === '/trends') {
    return {
      ok: true,
      accountId: q('accountId', ''),
      metric: q('metric', 'followers'),
      points: deps.trends(q('accountId', ''), q('metric', 'followers'))
    };
  }

  if (p === '/settings' && method === 'GET') return { ok: true, settings: deps.getSettings() };

  if (p === '/settings' && method === 'POST') {
    const r = deps.setSettings(input || {});
    return { ok: true, settings: r };
  }

  if (p === '/sync' && method === 'POST') {
    const r = await deps.sync(input || {});
    return { ok: true, ...r };
  }

  if (p === '/export' && method === 'POST') {
    const r = deps.exportCsv(String((input && input.accountId) || ''));
    return { ok: true, ...r };
  }

  return undefined;
}

module.exports = { start, ensureToken, readState, writeState, tokenPath, statePath, PORT_DEFAULT };
