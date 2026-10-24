'use strict';
/**
 * 网络钩子 · 作为 preload 在页面脚本之前运行
 *
 * 为什么需要它：
 *   读数最准的来源是平台自己发的接口 JSON。但 Electron 的 webRequest
 *   拿不到响应体，而 webContents.debugger（CDP）在部分构建上
 *   attach 成功却发不出命令。所以剩下唯一可靠的路子是在页面里挂一层钩子。
 *
 * 为什么能用 preload 做到：
 *   这个窗口 contextIsolation 关掉了（页面拿不到 Node，nodeIntegration 仍是 false），
 *   preload 和页面在同一个 JS 世界里，所以改 window.fetch 页面能看见。
 *   时机也刚好 —— preload 一定早于页面自己的脚本。
 *
 * 刻意只存字符串，不解析：解析放主进程做，钩子里越少逻辑越不容易出错。
 */

(() => {
  const LIMIT_COUNT = 400; // 单页最多存 400 个响应
  const LIMIT_LEN = 2 * 1024 * 1024; // 单个响应最多 2MB

  if (window.__capHooked) return;
  window.__capHooked = true;
  window.__cap = [];

  const looksJson = (t) => {
    if (!t || typeof t !== 'string') return false;
    if (t.length > LIMIT_LEN) return false;
    const c = t.charCodeAt(0);
    // 直接用第一个非空白字符判断，比正则快得多（大 JSON 上差别明显）
    let i = 0;
    while (i < t.length) {
      const ch = t.charCodeAt(i);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
        i++;
        continue;
      }
      return ch === 123 || ch === 91; // { 或 [
    }
    return c === 123 || c === 91;
  };

  const push = (url, text) => {
    try {
      if (window.__cap.length >= LIMIT_COUNT) return;
      if (!looksJson(text)) return;
      window.__cap.push({ url: String(url || '').slice(0, 500), body: text });
    } catch {
      /* 存不进去就算了，不影响页面 */
    }
  };

  // ------------------------------------------------------------ fetch
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    const patched = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        p.then((res) => {
          try {
            const u = (res && res.url) || (args[0] && args[0].url) || String(args[0] || '');
            // clone 之后读，不消耗页面自己要读的那份
            res
              .clone()
              .text()
              .then((t) => push(u, t))
              .catch(() => {});
          } catch {
            /* 有些响应不能 clone */
          }
        }).catch(() => {});
      } catch {
        /* 忽略 */
      }
      return p;
    };
    // 让 fetch.toString() 看起来还是原生的 —— 不少站点会查这一条
    try {
      Object.defineProperty(patched, 'toString', {
        value: () => 'function fetch() { [native code] }',
        configurable: true
      });
    } catch {
      /* 定义不了就随它 */
    }
    window.fetch = patched;
  }

  // ------------------------------------------------------------ XHR
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      this.__capUrl = url;
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      try {
        this.addEventListener('load', function () {
          try {
            const rt = this.responseType;
            if (rt === '' || rt === 'text') push(this.__capUrl, this.responseText);
            else if (rt === 'json' && this.response) push(this.__capUrl, JSON.stringify(this.response));
          } catch {
            /* 跨域等读不到，跳过 */
          }
        });
      } catch {
        /* 忽略 */
      }
      return origSend.apply(this, arguments);
    };
  }
})();
