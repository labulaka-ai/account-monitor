'use strict';
/**
 * 浏览器指纹一致性
 *
 * 核心问题：Electron 内核是 Chromium，但 UA 我们可以随便声称 Chrome。
 * 一旦声称了 Chrome，页面上有三个地方会自相矛盾：
 *   1. navigator.userAgentData.brands 里只有 Chromium，没有 Google Chrome
 *   2. window.chrome 缺字段（真 Chrome 一定有）
 *   3. 请求头 sec-ch-ua 只报 Chromium（页面里的 JS 改不了它）
 * 任何一处对不上，Google 登录页就直接回「此浏览器或应用可能不安全」。
 * Meta 系的检测更严，所以这里三处都要补，不能只改 UA。
 *
 * 补法上有个原则：说的是真的。UA 里的 Chrome 版本号就是内核自己的版本，
 * 不编一个不存在的版本 —— 声称 140 实际 138 反而更可疑。
 */

/** UA 声称的 Chrome 版本就用内核自己的版本，这是最不容易露馅的方式 */
const UA = `Mozilla/5.0 (${
  process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64'
}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

/** 在页面脚本之前注入。晚一步对方的检测代码已经把旧值读走了。 */
const FP_FIX = `(() => {
  try {
    const m = /Chrome\\/(\\d+)/.exec(navigator.userAgent || '');
    const v = m ? m[1] : '152';
    const brands = [
      { brand: 'Google Chrome', version: v },
      { brand: 'Chromium', version: v },
      { brand: 'Not?A_Brand', version: '24' },
    ];
    if (navigator.userAgentData) {
      Object.defineProperty(Navigator.prototype, 'userAgentData', {
        configurable: true,
        get: () => ({
          brands, mobile: false, platform: 'macOS',
          getHighEntropyValues: () => Promise.resolve({
            brands, mobile: false, platform: 'macOS', platformVersion: '15.0.0',
            architecture: 'arm', bitness: '64', model: '', uaFullVersion: v + '.0.0.0',
          }),
          toJSON: () => ({ brands, mobile: false, platform: 'macOS' }),
        }),
      });
    }
    // 老一些的检测会读这几个字段，缺了同样被当成无头环境
    const c = (window.chrome = window.chrome || {});
    if (!c.app) {
      c.app = {
        isInstalled: false,
        InstallState: { INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { RUNNING: 'running', CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run' },
      };
    }
    if (!c.runtime) c.runtime = {};
    if (!c.csi) c.csi = () => ({ onloadT: Date.now(), pageT: performance.now(), startE: Date.now(), tran: 15 });
    try {
      Object.defineProperty(Navigator.prototype, 'webdriver', { configurable: true, get: () => false });
    } catch (e) {}
  } catch (e) {}
})()`;

/**
 * 给一个分区做一次性设置：UA、指纹请求头、权限。
 * session.fromPartition 每次返回同一个对象，用标记避免重复挂监听（重复挂会报警告）。
 */
function setupSession(ses) {
  if (ses.__ready) return ses;
  ses.__ready = true;

  ses.setUserAgent(UA);

  // sec-ch-ua 是发到服务器那一侧的，页面里的 JS 改不了它。
  // Electron 只报 Chromium，而 UA 声称 Chrome —— 服务器两边一对就是自相矛盾。
  try {
    ses.webRequest.onBeforeSendHeaders((d, cb) => {
      const h = d.requestHeaders || {};
      const fix = (val) => {
        if (!val || /Google Chrome/i.test(val)) return val;
        const mm = /"Chromium";v="(\d+)/.exec(val);
        if (!mm) return val;
        return `"Google Chrome";v="${mm[1]}", ` + val;
      };
      for (const k of Object.keys(h)) {
        const lk = k.toLowerCase();
        if (lk === 'sec-ch-ua' || lk === 'sec-ch-ua-full-version-list') h[k] = fix(h[k]);
      }
      cb({ requestHeaders: h });
    });
  } catch {
    /* 老版本没有这个 API，用默认头 */
  }

  // 扫码、OAuth 需要摄像头和剪贴板；其余一律拒
  ses.setPermissionRequestHandler((wc, perm, cb) =>
    cb(['clipboard-read', 'clipboard-sanitized-write', 'media', 'fullscreen'].includes(perm))
  );

  return ses;
}

module.exports = { UA, FP_FIX, setupSession };
