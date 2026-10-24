'use strict';
/**
 * 平台读数器
 *
 * 现在的分工：
 *   collectors.js  每个平台一条固定路线（平台自己的接口 + 带标签的 DOM），
 *                  在里面就把数字读成统一结构
 *   reader.js      负责开页面、把几页结果拼起来、判断登录态与空态
 *   extract.js     只剩兜底：没有采集脚本的平台（微博/IG/Threads/FB）沿用旧的模糊抽取
 *
 * 为什么不再让 extract.js 当主力：
 *   「在几百个接口里按同义词找 follower_count」这种事，读对是运气，读错是常态 ——
 *   而且读错时数字看起来完全正常。平台后台自己的字段名是确定的，写死才不会错。
 */

const extract = require('./extract');
const { getCollector, scriptOf } = require('./collectors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面之间的间隔。固定间隔是机器特征，抖动才是人的节奏。 */
function pause(min = 1200, spread = 1400) {
  return sleep(min + Math.round(Math.random() * spread));
}

const ID_FIELDS = ['nickname', 'handle', 'uid', 'avatar'];

function mergeIdentity(into, from) {
  if (!from) return;
  for (const k of ID_FIELDS) {
    if (!into[k] && from[k]) into[k] = from[k];
  }
}

const ACC_FIELDS = ['followers', 'totalReads', 'totalLikes', 'follows'];

function mergeAccount(into, from) {
  if (!from) return;
  for (const k of ACC_FIELDS) {
    if (from[k] != null && Number.isFinite(Number(from[k]))) into[k] = Number(from[k]);
  }
}

/** 诊断用：抓了哪些接口、这次各页返回了什么 */
function debugOf(bag) {
  return {
    interfaces: (bag.jsonUrls || []).slice(0, 40),
    interfaceCount: (bag.jsonUrls || []).length,
    title: bag.title || '',
    loadErr: bag.loadErr || '',
    pages: bag.pages || []
  };
}

/**
 * @param {object} ctx
 * @param {Function} ctx.capture    (opts) → page，见 capture.js
 * @param {Function} ctx.getAdapter (platName) → adapter
 */
function makeReader({ capture, getAdapter }) {
  async function openOnce(ses, url, opts, tag) {
    if (opts.onProgress) opts.onProgress(`正在打开${tag}…`);
    return capture({
      ses,
      url,
      timeoutMs: opts.firstRun ? 38000 : 30000,
      minWaitMs: opts.firstRun ? 4200 : 3000,
      quietMs: 1500,
      onStep: opts.onProgress,
      onInject: opts.onInject
    });
  }

  /**
   * 走采集脚本的路线。
   * @returns {Promise<object>} read 结构
   */
  async function readByCollector(account, adapter, col, opts) {
    const ctx = {};
    const acc = {};
    const identity = { nickname: '', handle: '', uid: '', avatar: '' };
    const works = [];
    const seen = new Set();
    const pagesInfo = [];
    let worksTotal = null;
    let note = '';
    let pagesRead = 0;
    let allLoginFalse = true;
    let lastErr = null;
    let noChannel = false;
    let overview = null;
    /** 有几个「作品页」这次是空的（不是没登录，就是一条没读到） */
    let emptyWorkPages = 0;
    /** 每一页的「读到 / 自报」，用来逐页对账 */
    const pageStats = [];
    /** 有几页是「报错」的（页面没打开、脚本抛错），这种绝对不能判删除 */
    let failedPages = 0;
    /**
     * 采集器自己说「这次没翻完」（接口半路出错、或者翻到次数上限还没到总数）。
     * 这时候列表是残缺的 —— 不能拿它去判「谁已经不存在了」，
     * 否则漏掉的那几条会被当成已删除，从表里消失。
     */
    let truncated = false;
    let bag = { jsonUrls: [], title: '', loadErr: '' };

    for (const step of col.pages) {
      if (step.when && !step.when(ctx)) continue;
      const url = typeof step.url === 'function' ? step.url(ctx) : step.url;
      let page;
      try {
        page = await capture({
          ses: opts.ses,
          url,
          timeoutMs: opts.firstRun ? 38000 : 30000,
          minWaitMs: opts.firstRun ? 4200 : 3000,
          quietMs: 1500,
          onStep: opts.onProgress,
          onInject: opts.onInject,
          evalAfter: scriptOf(step.fn),
          // 采集脚本会在页面里翻页 / 滚动补全，比一次静态读取慢得多
          evalTimeoutMs: 60000
        });
      } catch (err) {
        lastErr = err;
        // 页面根本没打开 —— 这一页的作品状态未知，后面不能判删除
        failedPages++;
        pagesInfo.push({ url, error: err.message });
        continue;
      }
      pagesRead++;
      bag = { jsonUrls: page.jsonUrls || [], title: page.title, loadErr: page.loadErr };
      const r = page.evalResult;
      if (!r || typeof r !== 'object' || r.__err) {
        // 脚本没跑完 = 这一页的东西我们没看到，同样不能据此判删除
        failedPages++;
        pagesInfo.push({ url, error: r && r.__err ? r.__err : '页面内脚本没有返回结果' });
        continue;
      }
      pagesInfo.push({
        url,
        login: r.login !== false,
        account: r.account || null,
        works: Array.isArray(r.works) ? r.works.length : null,
        note: r.note || ''
      });

      if (r.login === false) {
        // 有一页明确说没登录 → 整体按未登录处理，别再读下一面
        return {
          status: 'login_expired',
          account: {},
          works: [],
          pages: pagesRead,
          note: '这个环境里没有登录态，需要本人重新登录',
          identity,
          debug: debugOf(bag)
        };
      }
      allLoginFalse = false;

      if (r.ctx) Object.assign(ctx, r.ctx);
      mergeIdentity(identity, r.identity);
      mergeAccount(acc, r.account);
      if (r.overview) overview = r.overview;
      if (r.worksTotal != null) {
        // 多页的路线（比如 X 的两个标签）各自报一个总数，取大的：
        // 取最后一个会把前一个标签的条数冲掉
        const n = Number(r.worksTotal);
        worksTotal = worksTotal == null ? n : Math.max(worksTotal, n);
      }
      /**
       * 记下「这一页说有多少条、实际读到多少条」。
       *
       * 为什么必须逐页记：以前只把各页的自报总数合成一个最大值，
       * 再拿它跟**跨页并集**比较 —— 这在多页路线上是错的。
       * X 的实测：/handle 报 3 条、/with_replies 报 6 条，并集 9 条；
       * 而 max(3,6)=6，`9 >= 6` 于是判定「读全了」。
       * 可某一页只渲染出一半时（6 条只读到 3 条），并集仍然 >= 6，
       * 于是另一页那 3 条被当成「已删除」从表里抹掉 —— 库里的 11 条假删除就是这么来的。
       *
       * 正确做法：逐页对账，每页都要「读到的 >= 这一页自报的」。
       */
      if (Array.isArray(r.works)) {
        pageStats.push({
          url,
          got: r.works.length,
          total: r.worksTotal == null ? null : Number(r.worksTotal),
          truncated: !!r.truncated
        });
      }
      if (r.note) note = r.note;
      if (r.truncated) truncated = true;
      if (r.noChannel) noChannel = true;

      for (const w of r.works || []) {
        if (!w || !w.platWorkId) continue;
        if (seen.has(w.platWorkId)) continue;
        seen.add(w.platWorkId);
        works.push(w);
      }

      // 有些平台要读好几页（X 的两个标签）。某一页一条都没读到，
      // 多半是那一页没渲染完，而不是这个号真的没有作品 —— 记下来，别据此判「全读完了」。
      if (Array.isArray(r.works) && r.works.length === 0) emptyWorkPages++;

      if (pagesRead < col.pages.length) await pause(900, 900);
    }

    if (pagesRead === 0) {
      throw new Error(lastErr ? `页面打不开：${lastErr.message}` : '页面打不开');
    }

    // 概览是「近 7 天」窗口值：只在账号总数缺的时候补，绝不覆盖累计口径
    if (overview) {
      if (acc.totalReads == null && overview.reads != null) acc.totalReads = overview.reads;
      if (acc.totalLikes == null && overview.likes != null) acc.totalLikes = overview.likes;
    }

    /**
     * 采集器到底有没有给出「作品总数」这个事实。
     *
     * 必须在这一行之前记下来：下面那句兜底会把 null 变成 0，
     * 之后就再也分不清「平台说 0 篇」和「这次没读到总数」了 ——
     * 前者该写 0，后者必须留空。
     */
    const worksTotalKnown = worksTotal != null;
    /**
     * 这里必须先把「平台报的总数」和「我们实际读到的条数」分开记。
     *
     * 坑在于：`worksTotal = Math.max(worksTotal, works.length)` 用来保证
     * 界面上的数字不小于表里的行数，但它同时把 `complete` 判据一起毁掉了 ——
     * `complete` 里那句 `works.length >= worksTotal` 永远成立，等于没有。
     * 实测后果很严重：X 读到 9 条、平台报 8 条时，判定「读全了」，
     * 库里另外几条（另一个标签里的）被标成已删除；IG 读到 0 条也被判「读全了」。
     *
     * 所以判「全不全」要用 platTotal 这个原始值，展示用的数字才取 max。
     */
    const platTotal = worksTotal;
    if (worksTotal == null) worksTotal = works.length;
    // 「作品」是给人对账的数字，绝不能比表里列出来的条数还少 ——
    // 那会让人以为漏了几条，却又找不到漏在哪
    if (works.length > worksTotal) worksTotal = works.length;

    // 平台明确说「一条都没有」：这时「空」是结论，不是「没读到」
    const platformSaysEmpty =
      worksTotalKnown && platTotal === 0 && works.length === 0 && failedPages === 0 && !truncated;

    let status = 'ok';
    const hasAcc = Object.keys(acc).length > 0;
    const hasWorks = works.length > 0 || worksTotal > 0;

    if (noChannel || (!hasAcc && !hasWorks && note)) {
      // 平台给了明确的事实（没频道 / 没作品），不是故障
      status = 'empty';
    } else if (!hasAcc && !hasWorks) {
      status = 'partial';
      note = note || `打开了${adapter.name}后台，但页面没有给出任何数字`;
    } else if (!hasWorks && worksTotal === 0) {
      note = note || '这个号还没有作品';
    }

    return {
      status,
      account: acc,
      works,
      worksTotal,
      // 这个总数是平台说的，还是我们兜出来的？写库时靠它决定写 0 还是留空
      worksTotalKnown,
      // 这次是不是把平台上的作品全拿回来了：只有拿全了才能判定「哪些已经不存在」，
      // 否则会把第二页之后的作品误标成已删除。
      // 有一个作品页是空的，就说明这次八成没读全（页面没渲染完），
      // 宁可这一轮不判删除，也不要把还在的帖子标成消失。
      //
      // 例外：平台明说总数是 0 时，「空」本身就是结论（这个号确实一篇都没有）。
      // 不加这个例外，一个被清空过的号会因为「读到 0 条」永远不敢判删除，旧行一直留着。
      /**
       * 能不能判「哪些作品已经不存在」—— 这是全项目最危险的一个判断：
       * 判错了，用户会看到自己好好的帖子「消失了」，而且是静默消失。
       *
       * 所以门槛设得高：**每一页都要读到它自己说有的那么多**，一页不达标就不判。
       *   1. 没有任何一页报错（页面没打开 / 脚本抛错都算）
       *   2. 每一页都自报了总数（没报就是不知道，不知道就不判）
       *   3. 每一页读到的条数都不少于它自报的数
       *   4. 采集器没说过 truncated
       * 唯一例外：平台明说 0 条（空号），「空」本身就是结论。
       */
      complete:
        platformSaysEmpty ||
        (failedPages === 0 &&
          !truncated &&
          pageStats.length > 0 &&
          pageStats.every((p) => p.total != null && p.got >= p.total)),
      // 把逐页对账的结果交出去，诊断和界面都用得上
      pageStats,
      pages: pagesRead,
      note,
      identity,
      debug: Object.assign(debugOf(bag), { pages: pagesInfo })
    };
  }

  /**
   * 旧路线：没有采集脚本的平台（微博 / IG / Threads / FB）。
   * 仍然可用，但清楚它的局限 —— 这些平台目前也没开。
   */
  async function readLegacy(account, adapter, opts) {
    const pages = adapter.pages || {};
    const targets = [];
    if (pages.account) targets.push({ url: pages.account, tag: '概览页' });
    if (pages.works && pages.works !== pages.account) targets.push({ url: pages.works, tag: '内容列表' });
    if (!targets.length) throw new Error('适配器没有配置任何页面');

    const budget = Math.min(opts.maxPages || 2, targets.length);
    const bag = { json: [], jsonUrls: [], links: [], text: '', globals: {}, title: '', finalUrl: '', loadErr: '' };
    let pagesRead = 0;
    let lastErr = null;

    for (const t of targets) {
      if (pagesRead >= budget) break;
      let page = null;
      try {
        page = await openOnce(opts.ses, t.url, opts, t.tag);
      } catch (err) {
        lastErr = err;
        continue;
      }
      pagesRead++;
      bag.json.push(...(page.json || []));
      bag.jsonUrls.push(...(page.jsonUrls || []));
      bag.links.push(...(page.links || []));
      if (page.text && page.text.length > bag.text.length) bag.text = page.text;
      for (const [k, v] of Object.entries(page.globals || {})) if (!(k in bag.globals)) bag.globals[k] = v;
      if (page.title) bag.title = page.title;
      bag.finalUrl = page.finalUrl || bag.finalUrl;
      bag.loadErr = bag.loadErr || page.loadErr || '';
      if (pagesRead < budget) await pause();
    }

    if (pagesRead === 0) throw new Error(lastErr ? `页面打不开：${lastErr.message}` : '页面打不开');

    const input = { jsonBlobs: bag.json, pageText: bag.text, globals: bag.globals };
    const acc = extract.extractAccount(input);
    const identity = extract.extractIdentity(Object.assign({}, input, { plat: account.plat }));
    const worksFound = extract.extractWorks(Object.assign({}, input, { ownerUid: identity.uid }));

    if (extract.looksLoginWall(bag.text, acc.values)) {
      return {
        status: 'login_expired',
        account: {},
        works: [],
        pages: pagesRead,
        note: '页面要求登录',
        identity,
        debug: debugOf(bag)
      };
    }

    return {
      status: Object.keys(acc.values).length ? 'ok' : 'partial',
      account: acc.values,
      works: worksFound.works,
      worksTotal: worksFound.works.length,
      pages: pagesRead,
      note: worksFound.works.length ? '' : '',
      identity,
      debug: debugOf(bag)
    };
  }

  /**
   * 读一个账号。
   * @param {object} account accounts 表里的行
   * @param {object} opts    { ses, onProgress, onInject, firstRun, maxPages }
   */
  async function readAccount(account, opts = {}) {
    const adapter = getAdapter(account.plat);
    if (!adapter) throw new Error(`没有「${account.plat}」的适配器`);

    if (adapter.disabled) {
      throw new Error(adapter.disabledReason || `${account.plat} 还没配好，先不读`);
    }

    const col = getCollector(adapter.key);
    if (col) return readByCollector(account, adapter, col, opts);
    return readLegacy(account, adapter, opts);
  }

  return { readAccount };
}

module.exports = { makeReader, pause };
