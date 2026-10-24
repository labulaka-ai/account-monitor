#!/usr/bin/env node
'use strict';
/**
 * 账号监控 · MCP 服务（stdio）
 *
 * 作用：让 Claude Desktop / Cursor / 其他支持 MCP 的 AI 直接读到这台电脑上的
 * 账号数据，不用复制粘贴。
 *
 * 为什么用 stdio 而不是 HTTP：
 *   MCP 客户端挂本地服务的主流方式就是「它自己起一个子进程，用标准输入输出通信」。
 *   stdio 没有端口、没有监听、别人扫不到，天然比开个 HTTP 端口安全。
 *   真正的数据读取还是走本机的 HTTP 接口（带密钥），这一层只做协议转换。
 *
 * 零依赖：JSON-RPC 手写，不用任何 SDK。项目的前提就是「不引第三方库」。
 *
 * 用法（在 AI 客户端的 MCP 配置里）：
 *   {
 *     "mcpServers": {
 *       "account-monitor": {
 *         "command": "node",
 *         "args": ["/Users/你/Desktop/AccountMonitor/mcp/server.js"]
 *       }
 *     }
 *   }
 * 密钥从 data/ai-token.txt 自动读，不用写在配置里。
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.AM_DATA_DIR || path.join(ROOT, 'data');

/** MCP 协议版本。客户端报别的版本时照它说的回，兼容性最好 */
const FALLBACK_PROTOCOL = '2024-11-05';

// ---------------------------------------------------------------- 读配置

function readJson(p, dflt) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return dflt;
  }
}

function aiConfig() {
  const st = readJson(path.join(DATA_DIR, 'ai.json'), {});
  let token = '';
  try {
    token = fs.readFileSync(path.join(DATA_DIR, 'ai-token.txt'), 'utf8').trim();
  } catch {
    token = '';
  }
  return {
    enabled: !!st.enabled,
    port: Number(st.port) || 47821,
    token
  };
}

/**
 * 调本机接口。
 *
 * 只在接口开着的时候能用 —— 这是有意的：用户关掉 AI 接入之后，
 * MCP 服务也应该立刻失去读数据的能力，而不是继续从数据库里偷偷读。
 */
function api(method, p, body) {
  const cfg = aiConfig();
  return new Promise((resolve, reject) => {
    if (!cfg.token) {
      reject(new Error('还没有生成密钥。在「账号监控」的设置里打开一次 AI 接入。'));
      return;
    }
    const payload = body == null ? '' : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: cfg.port,
        path: p,
        method,
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          // 端口只绑回环，但有些环境会带代理变量把 localhost 也走代理，这里显式声明
          Host: `127.0.0.1:${cfg.port}`
        },
        timeout: 120000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 下面按纯文本报错 */
          }
          if (res.statusCode >= 400) {
            const msg = json && json.error ? json.error : text.slice(0, 300);
            reject(new Error(`接口返回 ${res.statusCode}：${msg}`));
            return;
          }
          resolve(json);
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('本机接口超时。读数比较慢，可以先用只读工具。'));
    });
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        reject(
          new Error(
            '连不上本机接口：应用可能没开，或者「AI 接入」是关着的。' +
              '打开账号监控 → 设置 → 打开「允许 AI 读取数据」。'
          )
        );
        return;
      }
      reject(err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------- 工具定义

/**
 * 工具说明要让 AI 知道「什么时候该用哪个」。
 * 只写参数不写用途，模型会乱挑 —— 所以每个 description 都带上「用来回答什么问题」。
 */
const TOOLS = [
  {
    name: 'list_accounts',
    description:
      '列出所有平台的账号概览：粉丝数、作品数、最近读数时间、平台自己给的说明。' +
      '用来回答「我一共有哪些号、各自什么规模」这类问题。数据是最近一次读数的结果。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'account_detail',
    description:
      '读一个账号的完整数据：每日快照、全部作品及每条指标的当前值、帖子类型（原创/回复/转发）。' +
      '用来做单账号的深度分析。需要先有 accountId（从 list_accounts 拿）。',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: '账号 id，形如 acc_<平台>-<序号>_<随机串>' },
        limit: { type: 'number', description: '最多返回多少条作品，默认 500' }
      },
      required: ['accountId'],
      additionalProperties: false
    }
  },
  {
    name: 'query_works',
    description:
      '按条件查作品，可以跨账号。用来回答「最近 30 天哪几条阅读最高」「X 上我的转发有没有人看」' +
      '「某个月发的内容表现如何」。支持按平台过滤、按日期过滤、按指标排序。',
    inputSchema: {
      type: 'object',
      properties: {
        plat: { type: 'string', description: '平台名，比如 公众号 / 小红书 / X，不填就是全部' },
        from: { type: 'string', description: '发布日期起，YYYY-MM-DD' },
        to: { type: 'string', description: '发布日期止，YYYY-MM-DD' },
        sort: {
          type: 'string',
          enum: ['published_at', 'reads', 'likes', 'comments', 'shares', 'saves'],
          description: '排序字段，默认按发布时间倒序'
        },
        limit: { type: 'number', description: '最多几条，默认 300，上限 2000' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'overview',
    description:
      '跨平台分析素材包：每个平台的合计、互动率、口径说明（哪些是近 7 天、哪些是累计）、' +
      '最近 30 天发布量、以及「样本够不够做结论」的判断。' +
      '要做横向对比或写分析报告时先调这个，比一个个查账号快且口径一致。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'trend',
    description:
      '单个账号某个指标的时间序列。metrics: followers（粉丝）、works（作品数）、' +
      'reads（阅读/播放/查看）、likes、comments、shares、saves。' +
      '用来回答「粉丝在涨还是跌」「最近阅读趋势如何」。少于两个点时说明还没有趋势。',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: '账号 id' },
        metric: {
          type: 'string',
          enum: ['followers', 'works', 'reads', 'likes', 'comments', 'shares', 'saves'],
          description: '要哪个指标，默认 followers'
        }
      },
      required: ['accountId'],
      additionalProperties: false
    }
  },
  {
    name: 'refresh',
    description:
      '让应用现在去平台上读一次最新数据。会真的打开平台后台页面，所以有节流限制：' +
      '同一个号读太勤会被拒（返回 throttled 和还要等多久），这是防封号的设计，不要绕过。' +
      '只在用户明确要求「刷新一下」时调用，不要为了拿数据而主动刷。',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: '只刷这一个号' },
        plat: { type: 'string', description: '刷这个平台下的所有号（accountId 优先）' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_settings',
    description: '看每个号的自动刷新设置（开没开、几小时一次）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'set_auto_sync',
    description:
      '改自动刷新设置。间隔下限 6 小时、上限 168 小时 —— 读太勤会被平台当成机器人，' +
      '这是硬限制，传更小的值会被抬到 6。改之前最好先跟用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: '账号 id' },
        on: { type: 'boolean', description: '开还是关' },
        intervalH: { type: 'number', description: '几小时读一次，6~168' }
      },
      required: ['accountId', 'on'],
      additionalProperties: false
    }
  }
];

/** 工具名 → 具体怎么调 */
async function callTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'list_accounts': {
      const r = await api('GET', '/accounts');
      return r.accounts || [];
    }
    case 'account_detail': {
      if (!a.accountId) throw new Error('要指定 accountId');
      return api('GET', `/accounts/${encodeURIComponent(a.accountId)}?limit=${Number(a.limit) || 500}`);
    }
    case 'query_works': {
      const qs = new URLSearchParams();
      for (const k of ['plat', 'from', 'to', 'sort', 'limit']) if (a[k] != null) qs.set(k, String(a[k]));
      return api('GET', `/works?${qs.toString()}`);
    }
    case 'overview':
      return api('GET', '/summary');
    case 'trend': {
      if (!a.accountId) throw new Error('要指定 accountId');
      const qs = new URLSearchParams({ accountId: a.accountId, metric: a.metric || 'followers' });
      return api('GET', `/trends?${qs.toString()}`);
    }
    case 'refresh': {
      if (!a.accountId && !a.plat) throw new Error('要指定 accountId 或 plat');
      return api('POST', '/sync', { accountId: a.accountId, plat: a.plat });
    }
    case 'get_settings':
      return api('GET', '/settings');
    case 'set_auto_sync': {
      if (!a.accountId) throw new Error('要指定 accountId');
      return api('POST', '/settings', {
        autoSync: [{ id: a.accountId, on: !!a.on, intervalH: a.intervalH }]
      });
    }
    default:
      throw new Error(`没有这个工具：${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC

function send(msg) {
  // MCP 的 stdio 走「一行一个 JSON」，不是 LSP 的 Content-Length 头
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyErr(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg || {};

  // 通知类消息不需要回
  if (id === undefined || id === null) return;

  if (method === 'initialize') {
    const want = params && params.protocolVersion;
    reply(id, {
      // 客户端报什么版本就回什么版本，它自己的请求它最清楚
      protocolVersion: want || FALLBACK_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'account-monitor', version: '1.0.0' },
      instructions:
        '这台电脑上有一个多平台账号数据工具。先用 list_accounts 看有哪些号，' +
        '要做横向对比用 overview（它已经把口径对齐了）。' +
        'null 表示「平台没给这个数」，不是 0。' +
        '不要为了拿数据而主动调 refresh —— 读太勤会让账号有被封的风险。'
    });
    return;
  }

  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const out = await callTool(name, args);
      reply(id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        isError: false
      });
    } catch (err) {
      // 工具出错要作为「结果」返回，不是协议错误 —— 这样 AI 能看到原因并调整
      reply(id, {
        content: [{ type: 'text', text: `调用失败：${err.message}` }],
        isError: true
      });
    }
    return;
  }

  if (method === 'ping') {
    reply(id, {});
    return;
  }

  replyErr(id, -32601, `不支持的方法：${method}`);
}

/**
 * 在飞的请求数。
 *
 * 输入流一结束就 exit 会把还没回来的请求连根掐掉 ——
 * 客户端一次性把几条请求写进来然后关管道（用管道喂命令时很常见），
 * 表现就是「initialize 有回，tools/call 没回」，像服务卡死了。
 * 所以退出要等这里归零。
 */
let inflight = 0;
let stdinDone = false;

function maybeExit() {
  if (stdinDone && inflight === 0) process.exit(0);
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '不是合法 JSON' } });
        continue;
      }
      // 不 await：一条慢查询不该堵住后面的 ping
      inflight++;
      handle(msg)
        .catch((err) => {
          if (msg && msg.id != null) replyErr(msg.id, -32603, String(err.message || err));
        })
        .finally(() => {
          inflight--;
          maybeExit();
        });
    }
  });
  process.stdin.on('end', () => {
    stdinDone = true;
    maybeExit();
  });
}

main();
