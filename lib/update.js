'use strict';
/**
 * 版本更新检查
 *
 * 一条设计约束：**只有用户自己点的时候才联网**。
 * 这个工具对外承诺「不上传任何数据、断网也能用」，如果开机就去敲一次 GitHub，
 * 那句话就不成立了 —— 哪怕只是读一个公开的版本号。
 *
 * 所以这里不挂定时器，也不在启动时悄悄跑；界面上的「检查更新」点了才发请求。
 * 结果缓存 6 小时，连着点几次不会连着打接口。
 *
 * 零依赖：node:https 就够，不为这一个请求引 axios。
 */

const https = require('node:https');

const REPO = 'labulaka-ai/account-monitor';
const CACHE_MS = 6 * 3600 * 1000;
const TIMEOUT_MS = 6000;

/** v1.2.3 → [1,2,3]，预发布后缀（-beta.1）不参与比较 */
function parse(ver) {
  return String(ver || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((n) => parseInt(n, 10) || 0);
}

/** a 是否比 b 新 */
function newer(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          // GitHub 要求带 UA，否则直接 403
          'User-Agent': 'account-monitor',
          Accept: 'application/vnd.github+json'
        },
        timeout: TIMEOUT_MS
      },
      (res) => {
        // 还没发过 release 就是 404，这不是故障
        if (res.statusCode === 404) {
          res.resume();
          resolve(null);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 256 * 1024) req.destroy(new Error('响应过大'));
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error('返回的不是 JSON'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
  });
}

let cache = null;

async function check({ current, force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_MS) return cache.result;

  let result;
  try {
    const rel = await getJSON(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!rel) {
      // 仓库还没有 release：告诉界面「没有可比的版本」，而不是「已是最新」
      result = { ok: true, current, latest: '', hasUpdate: false, noRelease: true, url: `https://github.com/${REPO}/releases` };
    } else {
      const latest = String(rel.tag_name || '').replace(/^v/i, '');
      result = {
        ok: true,
        current,
        latest,
        hasUpdate: newer(latest, current),
        url: rel.html_url || `https://github.com/${REPO}/releases`,
        notes: String(rel.body || '').slice(0, 800)
      };
    }
  } catch (err) {
    // 网络不通不是错误，界面上不报红 —— 更新检查失败不该妨碍用工具
    return { ok: false, current, error: err.message, hasUpdate: false };
  }

  cache = { at: now, result };
  return result;
}

module.exports = { check, newer, parse, REPO };
