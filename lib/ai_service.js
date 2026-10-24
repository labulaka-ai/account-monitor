'use strict';
/**
 * 本机 AI 接口（给 Claude / Cursor 这类客户端读数据用）
 *
 * 为什么单独成模块：它是一整块「对外能力」，不是主进程的杂活。
 * 这个项目后面要长成 IP 运营系统，AI 侧只会越接越多（不只是一个 MCP），
 * 所以它的生命周期、状态、依赖都该自己管，而不是散在 main.js 里。
 *
 * 权限上刻意把「读」和「写」分开：
 *   - 读（账号、作品、趋势、素材包）随时可用，不消耗平台配额
 *   - 写只有「触发一次读数」和「改自动刷新间隔」两类，
 *     而且读数照常走 syncQueued，节流、指纹校验、上限全都还在
 * 换句话说，外部 AI 拿不到任何能绕过防封号规则的能力。
 *
 * 默认关闭：用户不开就没有监听端口。
 */

const localApi = require('./local_api');
const aiView = require('./ai_view');
const exporter = require('./export');

/**
 * @param {object} opts
 * @param {string} opts.dataDir        状态与密钥落在哪
 * @param {string} opts.exportDir      导出 CSV 的落点
 * @param {object} opts.database       已打开的库
 * @param {() => string} opts.version  应用版本
 * @param {(plat:string) => Array} opts.accountsOf
 * @param {(id:string, o:object) => Promise} opts.syncQueued
 * @param {(res:object) => string} opts.describeResult
 * @param {(ch:string, p:any) => void} opts.emit
 * @param {() => Array} opts.platSnapshot
 */
function createAiService(opts) {
  const {
    dataDir,
    exportDir,
    database,
    version,
    accountsOf,
    syncQueued,
    describeResult,
    emit,
    platSnapshot
  } = opts;

  let server = null;
  let info = { enabled: false, port: 0, token: '' };

  function deps() {
    const view = aiView.makeView(database);
    return {
      version,
      accounts: () => view.accounts(),
      accountDetail: (id, o) => view.accountDetail(id, o),
      works: (o) => view.works(o),
      summary: () => view.summary(),
      trends: (id, m) => view.trends(id, m),
      getSettings: () => view.getSettings(),
      setSettings: (o) => {
        const r = view.setSettings(o);
        emit('plats:update', platSnapshot());
        return r;
      },
      async sync(input) {
        // 指定账号：只读那一个
        if (input && input.accountId) {
          const res = await syncQueued(String(input.accountId), { trigger: 'manual' });
          return { accountId: input.accountId, result: res.result, message: describeResult(res) };
        }
        // 指定平台：把这个平台下的号依次读完（不并行，避免同时开太多页面）
        if (input && input.plat) {
          const list = accountsOf(String(input.plat));
          if (!list.length) throw new Error(`没有「${input.plat}」的账号`);
          const out = [];
          for (const a of list) {
            const res = await syncQueued(a.id, { trigger: 'manual' });
            out.push({ accountId: a.id, result: res.result, message: describeResult(res) });
          }
          return { plat: input.plat, results: out };
        }
        throw new Error('要指定 accountId 或 plat');
      },
      exportCsv(accountId) {
        if (!accountId) throw new Error('要指定 accountId');
        const file = exporter.exportAccount(database, accountId, 'csv', exportDir);
        return { file };
      }
    };
  }

  async function start() {
    const st = localApi.readState(dataDir);
    if (!st.enabled) {
      info = { enabled: false, port: 0, token: '', tokenFile: localApi.tokenPath(dataDir) };
      return info;
    }
    try {
      const r = await localApi.start({ dataDir, port: st.port, deps: deps() });
      server = r.server;
      info = {
        enabled: true,
        port: r.port,
        token: r.token,
        tokenFile: localApi.tokenPath(dataDir),
        url: `http://127.0.0.1:${r.port}`
      };
      console.log(`AI 接口已启动：${info.url}（只监听本机）`);
    } catch (err) {
      info = { enabled: false, port: 0, token: '', error: err.message };
      console.warn('AI 接口启动失败：', err.message);
    }
    return info;
  }

  async function stop() {
    if (server) {
      await new Promise((r) => server.close(() => r()));
      server = null;
    }
    info = { enabled: false, port: 0, token: '' };
    return info;
  }

  return {
    start,
    stop,
    state: () => info,
    running: () => !!server
  };
}

module.exports = { createAiService };
