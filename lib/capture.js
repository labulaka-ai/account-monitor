'use strict';
/**
 * 页面采集器
 *
 * 任务：给一个「分区 + 地址」，把这一页能提供的原料全拿回来 ——
 *   1. 所有 JSON 接口响应（CDP 抓 body，webRequest 拿不到 body 只能用调试协议）
 *   2. 页面可见文本（innerText）
 *   3. 页面全局状态（__INITIAL_STATE__ / ytInitialData / __NEXT_DATA__ 等）
 *   4. 页面上的链接文本（X 的粉丝数只出现在 a[href="/xxx/followers"] 里）
 *
 * 为什么不用 DOM selector 取数：
 *   后台页面两三个月一改版。而接口字段和页面文本是给 App、小程序、SEO 共用的，
 *   平台自己不敢乱改。所以这里只负责「取原料」，怎么认字段交给 extract.js。
 *
 * 一条硬规矩：窗口永远不显示。这是读数，不是浏览 ——
 * 弹窗出来抢焦点，人正在干别的事就会被抢走。
 */

const { BrowserWindow } = require('electron');
const path = require('node:path');

const MAX_BODY = 2 * 1024 * 1024; // 单个响应最多 2MB
const MAX_TOTAL_BODY = 16 * 1024 * 1024; // 一次采集总共最多 16MB
const MAX_GLOBAL = 3 * 1024 * 1024; // 单个全局状态最多 3MB

/** 在页面里跑的抽取脚本。只取原料，不做判断。 */
const EXTRACT_JS = `(() => {
  const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) : s);
  const out = { url: location.href, title: document.title, text: '', globals: {}, links: [] };
  try { out.text = clip((document.body && document.body.innerText) || '', 80000); } catch (e) {}

  const cand = {
    __INITIAL_STATE__: window.__INITIAL_STATE__,
    __INITIAL_SSR_STATE__: window.__INITIAL_SSR_STATE__,
    __NEXT_DATA__: window.__NEXT_DATA__,
    __NUXT__: window.__NUXT__,
    __APOLLO_STATE__: window.__APOLLO_STATE__,
    __PRELOADED_STATE__: window.__PRELOADED_STATE__,
    __INITIAL_STORE__: window.__INITIAL_STORE__,
    ytInitialData: window.ytInitialData,
    _sharedData: window._sharedData
  };
  for (const k of Object.keys(cand)) {
    const v = cand[k];
    if (v == null || typeof v !== 'object') continue;
    try {
      const s = JSON.stringify(v);
      if (s && s.length <= ${MAX_GLOBAL}) out.globals[k] = JSON.parse(s);
    } catch (e) {}
  }

  // 链接文本：X / IG 的粉丝数只在这里，接口里是别人的
  try {
    const as = document.querySelectorAll('a[href]');
    for (let i = 0; i < as.length && out.links.length < 260; i++) {
      const t = (as[i].innerText || '').trim().replace(/\\s+/g, ' ');
      if (!t || t.length > 80) continue;
      out.links.push({ href: as[i].getAttribute('href') || '', text: t });
    }
  } catch (e) {}

  // net_hook 存下来的接口响应。只带有限条数、单条截断 ——
  // 一次读数可能有上百个接口，全量传回主进程会把序列化拖到几秒。
  try {
    const cap = window.__cap || [];
    out.cap = cap.slice(-80).map((x) => ({
      url: String(x.url || ''),
      body: String(x.body || '').slice(0, 220000)
    }));
    out.capTotal = cap.length;
  } catch (e) {}

  return out;
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 给任何一步加个上限。
 *
 * 不能只靠 loadURL 自己的超时：Electron 的 webContents 在某些情况下
 * （网络服务重启、页面卡在解析、js 死循环）会让 promise 永远不 settle，
 * 读数就会静默地挂在那里，界面上一直转圈。宁可到点判失败，也不要无限等。
 */
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`)), ms))
  ]);
}

// 排查用：AM_DEBUG=1 时才打印。默认安静，免得日志里全是噪音。
const DBG = process.env.AM_DEBUG === '1';
const log = (...a) => {
  if (DBG) console.log('[capture]', ...a);
};

/**
 * 调试协议一旦证明不可用，就不再试。
 * 每次重试都要白等几秒，而读数本来就只有几十秒的预算。
 */
let cdpBroken = false;

/**
 * 打开一个页面把原料取回来。窗口自始至终不显示，用完即销毁。
 *
 * @param {object} o
 * @param {Electron.Session} o.ses       这个账号的分区（决定用哪份登录态）
 * @param {string} o.url                 要读的页面
 * @param {number} [o.timeoutMs]         总超时
 * @param {number} [o.quietMs]           多久没有新响应就算加载完
 * @param {number} [o.minWaitMs]         SPA 首屏渲染完之前不结束
 * @param {Function} [o.onStep]          进度回调（写给人看的中文短语）
 * @param {Function} [o.onInject]        加载时给页面注入的脚本（指纹补齐）
 * @returns {Promise<object>}
 */
async function capture(o) {
  const {
    ses,
    url,
    timeoutMs = 30000,
    quietMs = 1600,
    minWaitMs = 3000,
    onStep,
    onInject,
    evalAfter,
    evalTimeoutMs = 15000
  } = o;

  const started = Date.now();
  const step = (s) => {
    try {
      if (onStep) onStep(s);
    } catch {
      /* 进度只是展示，出错不影响读取 */
    }
  };

  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 940,
    backgroundColor: '#000000',
    skipTaskbar: true,
    webPreferences: {
      session: ses,
      /**
       * 关掉 contextIsolation 是为了让 net_hook 能挂到页面自己的 fetch 上
       * （隔离世界里改 window.fetch 页面看不见）。
       * 页面依然拿不到 Node —— nodeIntegration 是 false，preload 里的模块不会漏出去。
       * 这个窗口只用来读数据，不承载任何用户输入的敏感操作。
       */
      preload: path.join(__dirname, 'net_hook.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      // 后台窗口默认会被降频，页面里的定时器/动画全部拖慢，
      // 结果是「接口还没发出来就判定读完」。这条必须关。
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  const wc = win.webContents;
  const json = [];
  const pending = new Map();
  let totalBytes = 0;
  let lastActivity = Date.now();
  let bodyErrors = 0;
  let loadErr = '';
  let attached = false;

  const dbg = wc.debugger;

  const onMessage = (_e, method, params) => {
    if (!params) return;

    if (method === 'Network.responseReceived') {
      const r = params.response || {};
      const mime = String(r.mimeType || '');
      const type = String(params.type || '');
      const u = String(r.url || '');
      // 只关心「可能是数据的响应」：XHR/Fetch，或任何 JSON 类型
      const interesting = type === 'XHR' || type === 'Fetch' || /json/i.test(mime);
      if (!interesting || !u || u.startsWith('data:') || u.startsWith('blob:')) return;
      pending.set(params.requestId, { url: u });
      return;
    }

    if (method === 'Network.loadingFinished') {
      const p = pending.get(params.requestId);
      if (!p) return;
      pending.delete(params.requestId);
      totalBytes += params.encodedDataLength || 0;
      if (totalBytes > MAX_TOTAL_BODY) return;

      Promise.resolve()
        .then(() => dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }))
        .then((r) => {
          let body = r && r.body ? r.body : '';
          if (r && r.base64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
          if (!body || body.length > MAX_BODY) return;
          // 不是 JSON 的（HTML 片段、JS 源码）直接丢
          if (!/^\s*[[{]/.test(body)) return;
          json.push({ url: p.url, body });
          lastActivity = Date.now();
        })
        .catch(() => {
          bodyErrors++;
        });
    }
  };

  try {
    if (cdpBroken) throw new Error('之前已确认不可用，跳过');
    dbg.attach('1.3');
    attached = true;
    // 注意：attach 成功不代表能通。有的构建里 sendCommand 永远不回，
    // 所以这里必须带超时，否则整次读数就静默挂死。
    await withTimeout(dbg.sendCommand('Network.enable'), 2500, '调试协议');
    dbg.on('message', onMessage);
    log('调试协议已挂上');
  } catch (err) {
    // 拿不到调试协议也能退回页面钩子，不该整次读取都失败
    attached = false;
    if (!cdpBroken) log('调试协议不可用，改用页面钩子：', err.message);
    cdpBroken = true;
    try {
      dbg.detach();
    } catch {
      /* 本来就没挂上 */
    }
  }

  if (onInject) {
    wc.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) wc.executeJavaScript(onInject).catch(() => {});
    });
  }

  step('打开页面');
  log('打开', url);
  try {
    await withTimeout(wc.loadURL(url), 18000, '载入页面');
    log('页面已载入', wc.getURL());
  } catch (err) {
    // 站内重定向会让 loadURL 报 ERR_ABORTED，这不是失败
    if (!/ERR_ABORTED/i.test(err.message)) loadErr = err.message;
    log('载入报错（继续）', err.message);
  }

  // 等「安静」：既不能一加载完就取（SPA 接口还没发），
  // 也不能无限等（有的页面一直有心跳请求，永远不安静）。所以设了总超时。
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(260);
    const idle = Date.now() - lastActivity;
    if (Date.now() - t0 >= minWaitMs && idle >= quietMs) break;
  }
  // 把最后一批 body 收干净
  await sleep(400);
  log('安静了，用时', Date.now() - t0, 'ms，JSON 响应', json.length, '个');

  /**
   * 有些页面必须「先操作一下才出数」：切日期、点标签页、展开明细。
   * 默认日期窗口经常是空的（比如公众号内容分析默认只看昨天），
   * 不操作就只能读到一张空表，看起来像「平台没给数据」。
   *
   * 操作会触发新一批请求，所以要再等一轮安静 —— 但不能等太久，
   * 有些后台一直在发心跳，永远不安静。
   */
  let evalResult = null;
  if (evalAfter) {
    step('页面上操作');
    // 采集脚本可能要在页面里翻页、滚动补全，几秒到几十秒都正常。
    // 默认给 15 秒，需要更久的路线由调用方传 evalTimeoutMs。
    evalResult = await withTimeout(wc.executeJavaScript(evalAfter, true), evalTimeoutMs, '页面操作').catch((err) => ({
      __err: err.message
    }));
    const t1 = Date.now();
    while (Date.now() - t1 < 14000) {
      await sleep(260);
      if (Date.now() - t1 >= 2600 && Date.now() - lastActivity >= quietMs) break;
    }
    await sleep(500);
    log('操作后接口', json.length, '个');
  }

  step('解析页面');
  const dom = await withTimeout(wc.executeJavaScript(EXTRACT_JS, true), 12000, '页面解析').catch(() => null);
  log('页面抽取', dom ? '成功' : '失败', dom ? `文本 ${(dom.text || '').length} 字` : '');

  if (attached) {
    try {
      dbg.removeListener('message', onMessage);
      dbg.detach();
    } catch {
      /* 已经断开 */
    }
  }

  // 两个通道的接口数据合并：CDP 抓的 + 页面钩子抓的。
  // 同一条响应只留一份（同 url 同长度视为同一条，够用了）。
  const raw = json.slice();
  const seen = new Set(raw.map((x) => `${x.url}|${x.body.length}`));
  for (const c of (dom && dom.cap) || []) {
    const k = `${c.url}|${String(c.body).length}`;
    if (seen.has(k)) continue;
    seen.add(k);
    raw.push({ url: c.url, body: c.body });
  }
  log('接口合计', raw.length, '个（CDP', json.length, '· 页面钩子', ((dom && dom.cap) || []).length, '）');

  const result = {
    ok: !!dom,
    url,
    finalUrl: (dom && dom.url) || url,
    title: (dom && dom.title) || '',
    text: (dom && dom.text) || '',
    globals: (dom && dom.globals) || {},
    links: (dom && dom.links) || [],
    json: raw
      .map((x) => {
        try {
          return JSON.parse(x.body);
        } catch {
          return null;
        }
      })
      .filter(Boolean),
    jsonUrls: raw.map((x) => x.url),
    evalResult,
    loadErr,
    bodyErrors,
    elapsedMs: Date.now() - started
  };

  try {
    if (!win.isDestroyed()) win.destroy();
  } catch {
    /* 已经关了 */
  }

  return result;
}

module.exports = { capture, EXTRACT_JS, MAX_BODY };
