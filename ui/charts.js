'use strict';
/**
 * 图表 · 手写 SVG，零依赖
 *
 * 为什么不引图表库：这个项目的前提是「一个号一个环境、数据全在本机」，
 * 为了三张图引一个几百 KB 的库，还要为它配打包流程，不划算。
 * 这里画的都是很简单的图形，手写反而更好控制。
 *
 * 三条必须守住的规矩：
 *   1. **按容器真实像素画**。不用 viewBox 缩放 —— 一缩放，文字会被横向压扁，
 *      12px 的字看起来像 9px，而且越窄越糊。所以 width/height 与 viewBox 用同一组数。
 *   2. **颜色从 CSS 变量读**。深浅色主题切换时，图必须跟着变，
 *      写死 #fff 的图在浅色主题下就是一片隐形。
 *   3. **数据不够就不画**。一条折线至少要两个点；只有一个数据点时画出来是
 *      一条误导人的短线段。宁可写一句「明天开始有曲线」。
 */

/**
 * 作品的发布时间 → 分桶用的「天」（`YYYY-MM-DD`）。
 *
 * 库里现在统一是 `YYYY-MM-DD`，但历史数据里可能有完整 ISO 串（YouTube 早期写法）。
 * 直接拿原串当 Map 的键，同一天发的两条会被算成两天；而在它后面硬拼
 * `'T00:00:00'` 会得到 `…Z` + `T00:00:00` 这种非法串，`Date.parse` 返回 NaN，
 * 整条作品就被图表静默丢掉了。
 */
function chPubKey(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : '';
}

/** 发布日 → 当天零点的时间戳；认不出返回 NaN（调用方要跳过，不要当成 0） */
function chPubDay(v) {
  const k = chPubKey(v);
  return k ? Date.parse(k + 'T00:00:00') : NaN;
}

/**
 * 图表配色。
 *
 * 原来这几个色是写死的常量，浅色主题下 #3ddc97 / #f5a524 在白底上对比度只有
 * 1.5~2:1，柱子和环几乎看不见。改成从 CSS 变量读，主题切换时跟着变。
 * 变量名在 app.css 的 :root / body.light 两处分别定义。
 */
function chPalette() {
  const cs = getComputedStyle(document.body);
  const g = (n, d) => cs.getPropertyValue(n).trim() || d;
  return [
    g('--ch-1', '#5b8cff'),
    g('--ch-2', '#3ddc97'),
    g('--ch-3', '#f5a524'),
    g('--ch-4', '#a06bff'),
    g('--ch-5', '#ff7a9c')
  ];
}

/** 互动项的固定配色：按名字取，不按出现顺序 —— 否则少一项就会整体错位 */
function chMixColor(name) {
  const cs = getComputedStyle(document.body);
  const map = { 赞: '--ch-1', 藏: '--ch-2', 评: '--ch-3', 享: '--ch-4' };
  const varName = map[name];
  return (varName && cs.getPropertyValue(varName).trim()) || '#5b8cff';
}

function chVars() {
  const cs = getComputedStyle(document.body);
  const g = (n, d) => cs.getPropertyValue(n).trim() || d;
  return {
    ink: g('--ink', '#f4f5f7'),
    ink2: g('--ink-2', 'rgba(244,245,247,.6)'),
    ink3: g('--ink-3', 'rgba(244,245,247,.36)'),
    line: g('--line', 'rgba(255,255,255,.075)'),
    accent: g('--accent', '#5b8cff')
  };
}

/** 粗估一段文字占多宽（中文按 1em，西文按 0.55em） */
function chTextW(s, px) {
  let n = 0;
  for (const ch of String(s)) n += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.55;
  return n * px;
}

function chClip(s, px, font) {
  const t = String(s || '');
  if (chTextW(t, font) <= px) return t;
  let out = '';
  for (const ch of t) {
    if (chTextW(out + ch + '…', font) > px) break;
    out += ch;
  }
  return out + '…';
}

const chEsc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** 空状态：一句话，不画假图 */
function chEmpty(el, text) {
  el.innerHTML = `<div class="chempty">${chEsc(text)}</div>`;
}

// ---------------------------------------------------------------- 横向条形
/**
 * 作品表现。横向比纵向好读：标题可以正常写，不用斜排 45 度。
 * @param {Array<{label:string, value:number, sub?:string}>} rows
 */
function chBars(el, rows, opts = {}) {
  const w = Math.max(180, el.clientWidth || 260);
  const v = chVars();
  const data = rows.slice(0, opts.limit || 8);
  const rowH = 28;
  const padT = 6;
  const h = padT + data.length * rowH + 2;
  const labelW = Math.min(Math.round(w * 0.42), 150);
  const valW = 52;
  const barMax = Math.max(24, w - labelW - valW - 10);
  const max = Math.max(...data.map((d) => d.value || 0), 1);

  let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">`;
  data.forEach((d, i) => {
    const y = padT + i * rowH;
    const bw = Math.max(2, Math.round(((d.value || 0) / max) * barMax));
    // 底轨：值很小时也能看出「这一行有数据」
    s += `<rect x="${labelW}" y="${y + 9}" width="${barMax}" height="8" rx="4" fill="${v.line}"/>`;
    s += `<rect x="${labelW}" y="${y + 9}" width="${bw}" height="8" rx="4" fill="${
      d.dim ? v.ink3 : v.accent
    }"/>`;
    s += `<text x="0" y="${y + 15.5}" font-size="11.5" fill="${v.ink2}">${chEsc(
      chClip(d.label, labelW - 10, 11.5)
    )}</text>`;
    s += `<text x="${w}" y="${y + 15.5}" font-size="11.5" fill="${
      d.dim ? v.ink3 : v.ink
    }" text-anchor="end">${chEsc(opts.fmt ? opts.fmt(d.value) : d.value)}</text>`;
  });
  s += '</svg>';
  el.innerHTML = s;
}

// ---------------------------------------------------------------- 环形
/** 互动构成。四五个部分用环看比例，比堆叠条直观。 */
function chDonut(el, parts, opts = {}) {
  const w = Math.max(180, el.clientWidth || 260);
  const v = chVars();
  const total = parts.reduce((a, p) => a + (p.value || 0), 0);
  if (!total) {
    chEmpty(el, opts.empty || '还没有互动数据');
    return;
  }

  const size = Math.min(w, 150);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 9;
  const inner = r * 0.62;

  let a0 = -Math.PI / 2;
  let s = `<svg width="${w}" height="${Math.max(size, parts.length * 22)}" viewBox="0 0 ${w} ${Math.max(
    size,
    parts.length * 22
  )}" role="img">`;
  parts.forEach((p, i) => {
    if (!p.value) return;
    const a1 = a0 + (p.value / total) * Math.PI * 2;
    s += `<path d="${chArc(cx, cy, r, inner, a0, a1)}" fill="${
      p.color || chPalette()[i % chPalette().length]
    }"/>`;
    a0 = a1;
  });
  s += `<text x="${cx}" y="${cy - 2}" font-size="17" font-weight="600" fill="${v.ink}" text-anchor="middle">${chEsc(
    opts.center || String(total)
  )}</text>`;
  s += `<text x="${cx}" y="${cy + 15}" font-size="10.5" fill="${v.ink3}" text-anchor="middle">${chEsc(
    opts.centerSub || '合计'
  )}</text>`;

  // 图例放右侧，一行一个，圆点 + 名称 + 数值
  const lx = size + 14;
  parts.forEach((p, i) => {
    const y = 14 + i * 22;
    s += `<circle cx="${lx + 3}" cy="${y - 3.5}" r="3.5" fill="${
      p.color || chPalette()[i % chPalette().length]
    }"/>`;
    s += `<text x="${lx + 13}" y="${y}" font-size="11.5" fill="${v.ink2}">${chEsc(chClip(p.label, 52, 11.5))}</text>`;
    s += `<text x="${w}" y="${y}" font-size="11.5" fill="${v.ink}" text-anchor="end">${chEsc(
      opts.fmt ? opts.fmt(p.value) : p.value
    )}</text>`;
  });
  s += '</svg>';
  el.innerHTML = s;
}

function chArc(cx, cy, r, ir, a0, a1) {
  const p = (rad, ang) => [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x1, y1] = p(r, a0);
  const [x2, y2] = p(r, a1);
  const [x3, y3] = p(ir, a1);
  const [x4, y4] = p(ir, a0);
  return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(
    2
  )} L${x3.toFixed(2)},${y3.toFixed(2)} A${ir},${ir} 0 ${large} 0 ${x4.toFixed(2)},${y4.toFixed(
    2
  )} Z`;
}

// ---------------------------------------------------------------- 折线
/**
 * 趋势。至少两个点才画 —— 一个点连不出线，画出来是一段假趋势。
 * @param {Array<{x:string, y:number}>} pts
 */
function chLine(el, pts, opts = {}) {
  const w = Math.max(180, el.clientWidth || 260);
  const v = chVars();
  if (!pts || pts.length < 2) {
    chEmpty(el, opts.empty || '只记录到一次读数，明天开始有曲线');
    return;
  }

  const h = opts.height || 140;
  const padL = 34;
  const padR = 10;
  const padT = 12;
  const padB = 22;
  const ys = pts.map((p) => p.y);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  // 全平时把上下界各撑开一点，否则线会贴着顶部
  const span = max - min || Math.max(1, max * 0.1);
  const lo = min === max ? Math.max(0, min - span) : min - span * 0.12;
  const hi = min === max ? max + span : max + span * 0.12;

  const X = (i) => padL + (i / (pts.length - 1)) * (w - padL - padR);
  const Y = (y) => padT + (1 - (y - lo) / (hi - lo)) * (h - padT - padB);

  let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">`;
  // 三条横网格 + 上下界标签
  for (const t of [0, 0.5, 1]) {
    const y = padT + t * (h - padT - padB);
    s += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="${v.line}" stroke-width="1"/>`;
    const val = hi - t * (hi - lo);
    s += `<text x="${padL - 6}" y="${y + 3.5}" font-size="10" fill="${v.ink3}" text-anchor="end">${chEsc(
      opts.fmtY ? opts.fmtY(Math.round(val)) : Math.round(val)
    )}</text>`;
  }

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  const area = `${line} L${X(pts.length - 1).toFixed(1)},${(h - padB).toFixed(1)} L${padL},${(
    h - padB
  ).toFixed(1)} Z`;
  s += `<defs><linearGradient id="chg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${v.accent}" stop-opacity="0.28"/>
    <stop offset="100%" stop-color="${v.accent}" stop-opacity="0"/>
  </linearGradient></defs>`;
  s += `<path d="${area}" fill="url(#chg)"/>`;
  s += `<path d="${line}" fill="none" stroke="${v.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

  pts.forEach((p, i) => {
    // 点多的时候只标端点，不然挤成一团
    if (pts.length > 8 && i !== 0 && i !== pts.length - 1) return;
    s += `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="2.6" fill="${v.accent}"/>`;
  });

  const x0 = pts[0].x.slice(5);
  const xn = pts[pts.length - 1].x.slice(5);
  s += `<text x="${padL}" y="${h - 6}" font-size="10" fill="${v.ink3}">${chEsc(x0)}</text>`;
  s += `<text x="${w - padR}" y="${h - 6}" font-size="10" fill="${v.ink3}" text-anchor="end">${chEsc(
    xn
  )}</text>`;
  s += '</svg>';
  el.innerHTML = s;
}

// ---------------------------------------------------------------- 柱状
/** 发布节奏。按周聚合，看「多久发一次」比看单篇日期有用。 */
function chColumns(el, buckets, opts = {}) {
  const w = Math.max(180, el.clientWidth || 260);
  const v = chVars();
  if (!buckets || !buckets.length) {
    chEmpty(el, opts.empty || '还没有带日期的作品');
    return;
  }
  const h = opts.height || 132;
  const padT = 12;
  const padB = 22;
  const n = buckets.length;
  // 每一格按槽位算，柱子限宽。只有一周数据时如果按容器宽铺满，
  // 画出来是一个盖住整张图的色块 —— 看着像坏了，不像「这周发了 1 条」。
  const slot = w / n;
  const bw = Math.min(46, Math.max(6, slot * 0.52));
  const max = Math.max(...buckets.map((b) => b.value), 1);
  // 日期标签挤不下就隔一个画一个：宁可少标，也不要糊成一片看不懂的字
  const every = slot >= 34 ? 1 : 2;

  let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">`;
  s += `<line x1="0" y1="${h - padB}" x2="${w}" y2="${h - padB}" stroke="${v.line}" stroke-width="1"/>`;
  buckets.forEach((b, i) => {
    const bh = Math.max(b.value ? 3 : 0, Math.round((b.value / max) * (h - padT - padB - 6)));
    const x = i * slot + (slot - bw) / 2;
    if (bh) {
      s += `<rect x="${x.toFixed(1)}" y="${(h - padB - bh).toFixed(1)}" width="${bw.toFixed(
        1
      )}" height="${bh}" rx="3" fill="${v.accent}" fill-opacity="0.85"/>`;
      s += `<text x="${(x + bw / 2).toFixed(1)}" y="${(h - padB - bh - 5).toFixed(
        1
      )}" font-size="10" fill="${v.ink3}" text-anchor="middle">${b.value}</text>`;
    }
    if (i % every === 0) {
      s += `<text x="${(x + bw / 2).toFixed(1)}" y="${h - 7}" font-size="9.5" fill="${
        v.ink3
      }" text-anchor="middle">${chEsc(b.label)}</text>`;
    }
  });
  s += '</svg>';
  el.innerHTML = s;
}

// ---------------------------------------------------------------- 多指标趋势
/**
 * 一个方块，几条指标随便切。
 *
 * 为什么要做切换而不是并排画六张：详情页左栏窄，六张折线只会让每张都变成
 * 一条看不清的细线。同一块地方换一条线，横轴刻度还不跳，比较起来更准。
 *
 * 两条纪律：
 *   - **选中的指标必须跨重画保留**。窗口缩放会重画，如果每次都回到第一个指标，
 *     人刚切到「点赞」拉一下窗口就被弹回「粉丝」，会以为点错了。
 *   - **没有数据的指标不列出来**。列一个点了没反应的按钮，比不列更让人困惑。
 */
const CH_METRICS = {
  followers: { label: '粉丝', from: 'snap' },
  works: { label: '作品数', from: 'snap' },
  reads: { label: '阅读', from: 'work' },
  likes: { label: '点赞', from: 'work' },
  comments: { label: '评论', from: 'work' },
  shares: { label: '分享', from: 'work' },
  saves: { label: '收藏', from: 'work' },
  quotes: { label: '引用', from: 'work' },
  bookmarks: { label: '书签', from: 'work' },
  publish: { label: '发布量', from: 'pub' },
  // 派生指标：这些不是平台给的，是我们算的，标签上要能看出来
  interRate: { label: '互动率', from: 'calc' },
  perWork: { label: '篇均阅读', from: 'calc' }
};

/**
 * 把一个号能画的趋势全部算出来，交给界面去挑。
 * 只返回「至少有两个点」的 —— 一个点连不成趋势，画出来是一段假线。
 */
function chSeriesOf(acc) {
  const snaps = (acc.series || []).filter((s) => s && s.date);
  const daily = (acc.daily || []).filter((d) => d && d.d);
  const works = (acc.works || []).filter((w) => !w.gone);
  const out = {};

  const push = (key, pts) => {
    const clean = pts.filter((p) => p.y != null && Number.isFinite(Number(p.y))).map((p) => ({ x: p.x, y: Number(p.y) }));
    if (clean.length >= 2) out[key] = clean;
  };

  // 粉丝、作品数：账号级快照（平台只在这一层给这两个数）
  push('followers', snaps.map((s) => ({ x: s.date, y: s.followers })));
  push('works', snaps.map((s) => ({ x: s.date, y: s.works_total })));

  // 阅读/赞/评/享：优先作品级按天合计（点更密），没有才退回账号级快照
  const workKeys = ['reads', 'likes', 'comments', 'shares', 'saves'];
  for (const k of workKeys) {
    const fromDaily = daily.map((d) => ({ x: d.d, y: d[k] }));
    const usable = fromDaily.filter((p) => p.y != null);
    if (usable.length >= 2) {
      push(k, usable);
      continue;
    }
    // 账号级兜底：快照里的 total_reads / total_likes
    const mapKey = k === 'reads' ? 'total_reads' : k === 'likes' ? 'total_likes' : '';
    if (mapKey) push(k, snaps.map((s) => ({ x: s.date, y: s[mapKey] })));
  }

  // X 的引用数、收藏数：extra 里的，不在标准列
  for (const [k, src] of [
    ['quotes', 'quotes'],
    ['bookmarks', 'bookmarks']
  ]) {
    const byDay = new Map();
    for (const w of works) {
      const v = w.extra && w.extra[src];
      const k = chPubKey(w.published_at);
      if (v == null || !k) continue;
      byDay.set(k, (byDay.get(k) || 0) + Number(v));
    }
    if (byDay.size >= 2) {
      push(k, [...byDay.entries()].sort().map(([x, y]) => ({ x, y })));
    }
  }

  /**
   * 派生指标：按发布日聚合后的「互动率」和「篇均阅读」。
   * 这两个不是平台给的，是我们用当天的合计算出来的 —— 所以只在同一天至少
   * 有 1 条带阅读的作品时才出点，避免分母为 0 造出假的 0%。
   */
  {
    const byDay = new Map();
    for (const w of works) {
      const day = chPubKey(w.published_at);
      if (!day) continue;
      const r = w.reads == null ? null : Number(w.reads);
      if (r == null || r <= 0) continue;
      const cur = byDay.get(day) || { reads: 0, inter: 0, n: 0 };
      cur.reads += r;
      cur.inter +=
        (Number(w.likes) || 0) + (Number(w.comments) || 0) + (Number(w.shares) || 0) + (Number(w.saves) || 0);
      cur.n++;
      byDay.set(day, cur);
    }
    const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (days.length >= 2) {
      push(
        'interRate',
        days.map(([x, v]) => ({ x, y: +((v.inter / v.reads) * 100).toFixed(2) }))
      );
      push('perWork', days.map(([x, v]) => ({ x, y: Math.round(v.reads / v.n) })));
    }
  }

  // 发布量：按天统计有发布的日子（同一天发多条算多条）
  const byDay = new Map();
  for (const w of works) {
    const day = chPubKey(w.published_at);
    if (!day) continue;
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }
  const pubPts = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([x, y]) => ({ x, y }));
  push('publish', pubPts);

  return out;
}

/** 一张卡里带一排小切换按钮；点哪个画哪个 */
function chSwitchable(el, all, opts = {}) {
  const keys = Object.keys(all);
  if (!keys.length) {
    chEmpty(el, opts.empty || '还是只有一个点，从明天起这里会有曲线');
    return;
  }
  // 记住上次选的：换账号或重画时尽量接着看同一个指标
  const storeKey = opts.storeKey || 'am.ch.metric';
  let cur = '';
  try {
    cur = localStorage.getItem(storeKey) || '';
  } catch {
    cur = '';
  }
  if (!all[cur]) cur = keys[0];

  const draw = () => {
    const pts = all[cur] || [];
    const last = pts.length ? pts[pts.length - 1].y : null;
    const first = pts.length ? pts[0].y : null;
    const diff = last != null && first != null ? last - first : null;
    const deltaHtml =
      diff == null
        ? ''
        : `<span class="chdelta ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}">${
            diff > 0 ? '+' : ''
          }${fmt(diff)}</span>`;

    el.innerHTML = `
      <div class="chtabs">${keys
        .map(
          (k) =>
            `<button type="button" class="chtab${k === cur ? ' on' : ''}" data-m="${k}">${
              (CH_METRICS[k] || {}).label || k
            }</button>`
        )
        .join('')}</div>
      <div class="chsum"><b>${last == null ? '—' : fmt(last)}</b>${deltaHtml}</div>
      <div class="chplot"></div>`;
    chLine(el.querySelector('.chplot'), pts, { fmtY: fmt, height: 118, empty: opts.empty });

    for (const b of el.querySelectorAll('.chtab')) {
      b.addEventListener('click', () => {
        cur = b.dataset.m;
        try {
          localStorage.setItem(storeKey, cur);
        } catch {
          /* 存不了就只在这次生效 */
        }
        draw();
      });
    }
  };
  draw();
}

/**
 * 一句话结论。
 *
 * 图要人自己看、自己对；但「哪条最好、好多少」这种判断，
 * 一个数字说不清，一句白话反而最快。所以这里只写**能从数据直接算出来**的事，
 * 不做推测：算不出就整块不显示，不写「表现不错」这种没信息量的话。
 */
function chInsight(host, acc, platCaps, prof) {
  /**
   * 同一个数在不同平台叫法不同：公众号是「阅读」、抖音「播放」、X「查看」。
   * 结论句里跟着平台改口 —— 在 X 的页面上说「49 阅读」，人会以为读的是别的平台。
   */
  const unitWord = (() => {
    const plat = (acc.account && acc.account.plat) || '';
    if (plat === 'X') return '查看';
    if (plat === '抖音' || plat === 'B站' || plat === '视频号' || plat === 'YouTube') return '播放';
    if (plat === '小红书') return '观看';
    return '阅读';
  })();
  if (!host) return;
  const m = chBuildModel(acc, platCaps);
  const works = m.works.filter((w) => w.reads != null && Number(w.reads) > 0);
  const lines = [];

  /**
   * 第一行先给「这个平台该看什么」。
   *
   * 十二个平台的「作品」不是同一种东西：公众号一篇是长文，看分享率；
   * 小红书看收藏；B站看投币；视频号看完播。用同一套指标横着比，
   * 数字都有，但比出来的结论是错的。
   * 所以先把判断标准讲清楚，再给这一批数据的结论 —— 顺序反了就成了先射箭再画靶。
   */
  if (prof && prof.focusWhy) {
    lines.push(`<span class="chwhy">${chEsc(prof.focusWhy)}</span>`);
  }

  if (works.length >= 3 && m.mainKey === 'reads') {
    const vals = works.map((w) => Number(w.reads));
    const total = vals.reduce((a, b) => a + b, 0);
    const avg = total / vals.length;
    const top = works.reduce((a, b) => (Number(a.reads) >= Number(b.reads) ? a : b));
    const times = avg > 0 ? Number(top.reads) / avg : 0;
    // 只有明显高于平均才说「倍数」，否则这句话没有价值
    if (times >= 1.5) {
      // chClip 的第二个参数是像素宽度，不是字数 —— 传小了会把标题截成「说…」
      lines.push(
        `<b>${chEsc(chClip(top.title || '无标题', 320, 13))}</b> 是最强的一条，` +
          `<b>${fmt(top.reads)}</b> ${unitWord}，是平均值的 <b>${times.toFixed(1)} 倍</b>`
      );
    } else {
      lines.push(`目前 <b>${vals.length}</b> 条内容阅读比较平均，没有单条明显跑出来`);
    }
  }

  /**
   * 按平台自己的「主指标」说一句。
   * 公众号说分享、B站说投币、视频号说完播 —— 每个平台用自己最该看的那个数。
   */
  if (prof && prof.angle && prof.angle.primary) {
    const key = prof.angle.primary;
    const valOf = (w) =>
      key === 'completion'
        ? w.completion == null ? null : Number(w.completion)
        : key === 'coins' || key === 'danmaku' || key === 'quotes' || key === 'bookmarks'
          ? w.extra && w.extra[key] != null ? Number(w.extra[key]) : null
          : w[key] == null ? null : Number(w[key]);
    const rows = m.works.map((w) => ({ w, v: valOf(w) })).filter((x) => x.v != null && x.v > 0);
    if (rows.length >= 2) {
      const top = rows.reduce((a, b) => (a.v >= b.v ? a : b));
      const label =
        { shares: '分享最多', coins: '投币最多', completion: '完播率最高', saves: '收藏最多',
          likes: '赞最多', comments: '评论最多', quotes: '被引用最多' }[key] || '最高';
      if (top.w !== undefined) {
        lines.push(
          `${label}的是 <b>${chEsc(chClip(top.w.title || '无标题', 280, 13))}</b>，` +
            `<b>${key === 'completion' ? top.v + '%' : fmt(top.v)}</b>`
        );
      }
    }
    if (prof.angle.note) lines.push(`<span class="chwhy">${chEsc(prof.angle.note)}</span>`);
  }

  if (m.rates.length) {
    const best = m.rates[0];
    lines.push(
      `互动率最高的是 <b>${chEsc(chClip(best.label, 280, 13))}</b>，` +
        `互动率 <b>${best.value.toFixed(1)}%</b>（互动 ÷ 阅读）`
    );
  }

  // 粉丝变化：只在两次以上读数、且确实有变化时才说
  const fans = (acc.series || []).filter((s) => s && s.followers != null);
  if (fans.length >= 2) {
    const d = Number(fans[fans.length - 1].followers) - Number(fans[0].followers);
    if (d !== 0) {
      lines.push(
        `从第一次读数到现在，粉丝 <b>${d > 0 ? '增加' : '减少'} ${Math.abs(d)}</b>` +
          `（${fmt(fans[0].followers)} → ${fmt(fans[fans.length - 1].followers)}）`
      );
    }
  }

  if (!lines.length) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  host.hidden = false;
  host.innerHTML = lines.map((t) => `<p>${t}</p>`).join('');
}

// ---------------------------------------------------------------- 四象限
/**
 * 「阅读 × 互动率」散点。
 *
 * 为什么值得单独一张图：排行榜只回答「谁最多」，回答不了「哪条值得再写一篇」。
 * 把这两个维度交叉之后，内容自然分成四类，判断标准完全不同：
 *
 *        互动率高
 *            │
 *   小众但抓人│值得放大（少数派好内容）
 *   ─────────┼─────────
 *   平庸      │广泛传播但没留住人
 *            │
 *        互动率低        阅读高 →
 *
 * 右上角那几条是「既有人看又愿意互动」的，是最值得复用的选题。
 * 右下角阅读高但互动率低：平台给了曝光，内容没接住 —— 这类最容易被误判成成功。
 */
function chScatter(el, pts, opts = {}) {
  const w = Math.max(200, el.clientWidth || 260);
  const v = chVars();
  if (!pts || pts.length < 3) {
    chEmpty(el, opts.empty || '至少要三条带阅读数的作品才能分象限');
    return;
  }
  const h = opts.height || 190;
  const padL = 36;
  const padR = 12;
  const padT = 14;
  const padB = 26;

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const xMax = Math.max(...xs) || 1;
  const yMax = Math.max(...ys) || 1;
  // 用「中位数」当分界线，不用平均值 —— 一条爆款会把平均值拉高，
  // 结果其余全被归到「低」那一半，象限就没意义了
  const med = (arr) => {
    const a = arr.slice().sort((p, q) => p - q);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const xMid = med(xs);
  const yMid = med(ys);

  const X = (x) => padL + (x / xMax) * (w - padL - padR);
  const Y = (y) => h - padB - (y / yMax) * (h - padT - padB);

  let s2 = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">`;
  // 象限底色：右上角淡一点，视觉上告诉人「这块是好地方」
  s2 += `<rect x="${X(xMid)}" y="${padT}" width="${Math.max(0, w - padR - X(xMid))}" height="${Math.max(
    0,
    Y(yMid) - padT
  )}" fill="${v.accent}" fill-opacity="0.07"/>`;
  // 分界虚线
  s2 += `<line x1="${X(xMid)}" y1="${padT}" x2="${X(xMid)}" y2="${h - padB}" stroke="${v.line}" stroke-dasharray="3 4"/>`;
  s2 += `<line x1="${padL}" y1="${Y(yMid)}" x2="${w - padR}" y2="${Y(yMid)}" stroke="${v.line}" stroke-dasharray="3 4"/>`;

  // 轴标签
  s2 += `<text x="${padL - 5}" y="${padT + 8}" font-size="9.5" fill="${v.ink3}" text-anchor="end">${chEsc(
    opts.fmtY ? opts.fmtY(yMax) : yMax
  )}</text>`;
  s2 += `<text x="${padL - 5}" y="${h - padB}" font-size="9.5" fill="${v.ink3}" text-anchor="end">0</text>`;
  s2 += `<text x="${padL}" y="${h - 8}" font-size="9.5" fill="${v.ink3}">0</text>`;
  s2 += `<text x="${w - padR}" y="${h - 8}" font-size="9.5" fill="${v.ink3}" text-anchor="end">${chEsc(
    opts.fmtX ? opts.fmtX(xMax) : xMax
  )}</text>`;

  // 点：右上角的用强调色，其余用灰，一眼看出重点
  pts.forEach((p) => {
    const good = p.x >= xMid && p.y >= yMid;
    s2 += `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${
      good ? 4.2 : 3
    }" fill="${good ? v.accent : v.ink3}" fill-opacity="${good ? 0.95 : 0.55}"/>`;
  });
  s2 += '</svg>';
  el.innerHTML = s2;
}

// ---------------------------------------------------------------- 发布后 24h
/**
 * 「发布后 24 小时」的表现。
 *
 * 为什么单列一张：所有内容混在一起比是错的 ——
 * 一条发了 7 天读到 500，和一条发了 2 小时读到 500，完全不是一回事。
 * 只有把时间刻度对齐（都取发布后 24 小时左右的那次读数），数才有可比性。
 *
 * 做法：每条作品取「最接近 24 小时的x那次读数」。
 *   · 只取 18~36 小时之间的（太早还没起量，太晚已经算老内容）
 *   · 一条都没有就不画，不硬凑
 */
function chEarlyView(works) {
  const rows = [];
  /**
   * 取 12~48 小时之间的读数，挑最接近 24 的那个。
   *
   * 为什么不是严格的 24：我们不是每小时都在读，实际采样点会偏。
   * 卡死在 24±2 小时的话，绝大多数作品都进不来，这张图永远是空的。
   * 12~48 覆盖「发布当天读完到第二天」，这个区间里的量级已经稳定，
   * 拿来做横比是公平的。
   */
  const KEY_MIN = 12;
  const KEY_MAX = 48;
  for (const w of works) {
    const samples = w.samples || [];
    if (!samples.length) continue;
    // 样本里挑离 24 小时最近的那个
    let best = null;
    for (const s of samples) {
      if (s.ageHours == null) continue;
      if (s.ageHours < KEY_MIN || s.ageHours > KEY_MAX) continue;
      if (s.reads == null) continue;
      const dist = Math.abs(s.ageHours - 24);
      if (!best || dist < best.dist) best = { dist, reads: s.reads, age: s.ageHours };
    }
    if (best) {
      rows.push({
        label: w.title || '无标题',
        value: best.reads,
        age: best.age,
        publishedAt: w.published_at || ''
      });
    }
  }
  rows.sort((a, b) => b.value - a.value);
  return rows;
}

// ---------------------------------------------------------------- 同类比较
/**
 * 同题材对比。
 *
 * 问题：现在「最强的一条」是跟所有内容比 ——
 * 一篇讲气象的和一篇讲融资的本来就不可比，比出来第一也没意义。
 *
 * 做法：按标题里的关键词把内容分组，只在同组内比。
 *   · 关键词从标题里抽（中文不分词也能做：取 2~4 字的重复片段）
 *   · 一组至少 3 条才算「同类」，否则样本太小，结论会骗人
 *   · 只输出最大的那一组 —— 报告里列五组就没人看了
 */
function chSimilar(works, opts = {}) {
  const usable = works.filter((w) => w.reads != null && Number(w.reads) > 0 && w.title);
  if (usable.length < 6) return { enough: false, rows: [], label: '' };

  // 中文按 2 字滑窗取片段，统计出现频次。噪声词（的、了、是）先剔掉
  const STOP = new Set([
    '的', '了', '是', '在', '和', '与', '就', '都', '也', '这', '那', '一个', '我们',
    '可以', '什么', '怎么', '为什么', '如何', '不是', '没有', '这个', '那个', '一下'
  ]);
  const freq = new Map();
  for (const w of usable) {
    const t = String(w.title).replace(/[\s\p{P}]/gu, '');
    const seen = new Set();
    for (let i = 0; i + 2 <= t.length; i++) {
      const g = t.slice(i, i + 2);
      if (STOP.has(g) || seen.has(g)) continue;
      seen.add(g);
      freq.set(g, (freq.get(g) || 0) + 1);
    }
  }

  // 找出能让 ≥3 条内容成组的最高频词
  let bestKey = '';
  let bestGroup = [];
  for (const [k, n] of freq) {
    if (n < 3) continue;
    const group = usable.filter((w) => String(w.title).includes(k));
    // 同一组要么更大、要么同样大但关键词更长（更有区分度）
    if (
      group.length > bestGroup.length ||
      (group.length === bestGroup.length && k.length > bestKey.length)
    ) {
      bestKey = k;
      bestGroup = group;
    }
  }

  if (bestGroup.length < 3) return { enough: false, rows: [], label: '' };

  const sorted = bestGroup.slice().sort((a, b) => Number(b.reads) - Number(a.reads));
  return {
    enough: true,
    label: bestKey,
    count: bestGroup.length,
    rows: sorted.slice(0, 8).map((w) => ({ label: w.title || '无标题', value: Number(w.reads) }))
  };
}

// ---------------------------------------------------------------- 组装
/** 把「有没有数据」的判断集中在一处，免得每个调用点各写一遍 */
function chBuildModel(acc, platCaps) {
  const works = (acc.works || []).filter((w) => !w.gone);
  const caps = (platCaps && platCaps.work) || [];

  const num = (v) => (v == null ? null : Number(v));
  const sum = (k) => works.reduce((a, w) => a + (num(w[k]) || 0), 0);
  const has = (k) => works.some((w) => num(w[k]) != null);

  const totals = {
    赞: sum('likes'),
    藏: sum('saves'),
    评: sum('comments'),
    享: sum('shares')
  };
  const mix = Object.keys(totals)
    .map((k) => ({ label: k, value: totals[k], color: chMixColor(k) }))
    .filter((p) => p.value > 0);

  // 主指标：能读阅读就按阅读，否则按点赞 —— 平台之间不一样是正常的
  const mainKey = has('reads') ? 'reads' : has('likes') ? 'likes' : has('comments') ? 'comments' : '';
  const ranked = mainKey
    ? works
        .filter((w) => num(w[mainKey]) != null)
        .slice()
        .sort((a, b) => (num(b[mainKey]) || 0) - (num(a[mainKey]) || 0))
        .slice(0, 8)
        .map((w) => ({ label: w.title || '无标题', value: num(w[mainKey]) || 0 }))
    : [];

  // 发布节奏：最近 8 周，按周一归桶
  const buckets = [];
  const byWeek = new Map();
  for (const w of works) {
    if (!w.published_at) continue;
    const t = chPubDay(w.published_at);
    if (Number.isNaN(t)) continue;
    const d = new Date(t);
    const dow = (d.getDay() + 6) % 7; // 周一 = 0
    d.setDate(d.getDate() - dow);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`;
    byWeek.set(key, (byWeek.get(key) || 0) + 1);
  }
  const keys = [...byWeek.keys()].sort().slice(-8);
  for (const k of keys) buckets.push({ label: k.slice(5), value: byWeek.get(k) });

  /**
   * 互动率：每千次阅读拿到多少互动。
   *
   * 为什么不直接排阅读数：阅读高经常只是平台给了曝光，跟内容好不好关系不大。
   * 互动率才是「看完的人愿不愿意动手」，这是能横着比的指标。
   * 阅读门槛定在 100：低于这个数，3 个赞就能算出 100‰，是纯噪音 ——
   * 之前门槛 30，结果榜首是一条刚发的小文，「每千次阅读 209 次互动」，
   * 数字是真的，但拿来比较毫无意义。
   */
  const rates = works
    .map((w) => {
      const r = num(w.reads);
      if (r == null || r < 100) return null;
      const inter = (num(w.likes) || 0) + (num(w.comments) || 0) + (num(w.shares) || 0) + (num(w.saves) || 0);
      // 用百分比而不是千分比：17.5% 谁都看得懂，175‰ 得先换算一下
      return { label: w.title || '无标题', value: (inter / r) * 100, sub: `${fmt(r)} 阅读` };
    })
    .filter(Boolean)
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);

  /**
   * 发布效果：按星期几分组看平均表现。
   * 样本少于 8 条就不出结论 —— 用两条数据说「周五发最好」是骗人。
   */
  const WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const byWd = new Map();
  for (const w of works) {
    if (!w.published_at) continue;
    const t = chPubDay(w.published_at);
    if (Number.isNaN(t)) continue;
    const v = num(w[mainKey]);
    if (v == null) continue;
    const d = new Date(t);
    const k = (d.getDay() + 6) % 7;
    const cur = byWd.get(k) || { sum: 0, n: 0 };
    cur.sum += v;
    cur.n++;
    byWd.set(k, cur);
  }
  const wdRows = [...byWd.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => ({ label: WD[k], value: Math.round(v.sum / v.n) }));
  const weekday = {
    n: works.filter((w) => Number.isFinite(chPubDay(w.published_at))).length,
    enough: wdRows.length >= 3 && weekdayCount(byWd) >= 8,
    rows: wdRows
  };

  /**
   * 四象限的点：x = 阅读，y = 互动率(%)。
   * 阅读门槛同样是 100 —— 几个阅读的作品算出来的互动率是噪音，
   * 放进去会把整个坐标系压扁。
   */
  const quadrant = works
    .map((w) => {
      const r = num(w.reads);
      if (r == null || r < 100) return null;
      const inter = (num(w.likes) || 0) + (num(w.comments) || 0) + (num(w.shares) || 0) + (num(w.saves) || 0);
      return { x: r, y: +((inter / r) * 100).toFixed(2), label: w.title || '' };
    })
    .filter(Boolean);

  return { works, caps, mix, ranked, mainKey, buckets, totals, rates, weekday, quadrant };
}

/** 参与统计的作品总条数（不是「有几个星期几分组」） */
function weekdayCount(byWd) {
  let n = 0;
  for (const v of byWd.values()) n += v.n;
  return n;
}

/**
 * 画整个图表区。
 * @param {HTMLElement} host  <div id="dCharts">
 * @param {object} acc        account:detail 的返回
 * @param {object} platCaps   平台的 caps
 */
function renderCharts(host, acc, platCaps, win, opts = {}) {
  if (!host) return;
  const m = chBuildModel(acc, platCaps);
  const all = chSeriesOf(acc);
  const keys = Object.keys(all);

  // 结论块跟图一起刷新：它是从同一批数据算的，分开刷会出现「图和话对不上」
  chInsight(document.getElementById('dInsight'), acc, platCaps, opts.profile);

  const cards = [];

  /**
   * 第一张就是「趋势 + 切换」。原来这里是两张卡（趋势、发布节奏），
   * 而趋势那张只会画粉丝 —— 想看点别的没有入口。
   * 现在合成一张：粉丝、阅读、点赞、评论、分享、收藏、作品数、发布量都在里面，
   * 点一下就换线。默认落在「粉丝」，因为那是「这个号在往哪走」的最短答案。
   */
  cards.push({
    t: '趋势',
    sub: keys.length ? `${keys.length} 个指标可切换` : '每天记一个点',
    wide: true,
    draw: (el) =>
      chSwitchable(el, all, {
        storeKey: `am.ch.metric.${(acc.account && acc.account.plat) || ''}`,
        empty: '从今天开始记录。明天再刷新一次，这里就会出现曲线。'
      })
  });

  if (m.ranked.length) {
    cards.push({
      t: m.mainKey === 'reads' ? '作品阅读' : m.mainKey === 'likes' ? '作品点赞' : '作品评论',
      sub: `前 ${m.ranked.length} 条`,
      draw: (el) => chBars(el, m.ranked, { fmt: fmt })
    });
  } else {
    // 平台不给单篇指标 —— 这不是「坏了」，要说明白，别让人以为在转圈
    cards.push({
      t: '作品表现',
      sub: '按单篇指标排序',
      draw: (el) =>
        chEmpty(
          el,
          m.works.length
            ? '这个平台的后台列表不给单篇指标，所以没有可画的数。'
            : '这个号还没有内容。'
        )
    });
  }

  if (m.mix.length) {
    cards.push({
      t: '互动构成',
      sub: '赞 / 藏 / 评 / 享',
      draw: (el) => chDonut(el, m.mix, { center: fmt(m.mix.reduce((a, p) => a + p.value, 0)), centerSub: '互动' })
    });
  } else {
    cards.push({
      t: '互动构成',
      sub: '赞 / 藏 / 评 / 享',
      draw: (el) => chEmpty(el, m.works.length ? '这些作品还没有互动数据' : '这个号还没有内容。')
    });
  }

  // 互动率：单篇「留人效率」。绝对阅读高的可能是平台推的，互动率高才是内容真的抓人
  const rates = m.rates;
  cards.push({
    t: '互动率',
    sub: rates.length ? '互动占比（阅读 100 以上）' : m.works.length ? '需要阅读数' : '还没有内容',
    draw: (el) =>
      rates.length
        ? chBars(el, rates, { fmt: (v) => `${v.toFixed(1)}%`, limit: 6 })
        : chEmpty(
            el,
            !m.works.length
              ? '这个号还没有内容。'
              : m.works.some((w) => w.reads != null)
                ? '至少要有两条阅读过百的作品才比得出来'
                : '这个平台不给单篇阅读数'
          )
  });

  // 四象限：阅读 × 互动率。回答「哪条值得再写一篇」，排行榜回答不了这个
  const quad = m.quadrant;
  cards.push({
    t: '选题四象限',
    sub: quad.length ? `阅读 × 互动率 · ${quad.length} 条` : '需要阅读数',
    wide: true,
    draw: (el) =>
      quad.length
        ? chScatter(el, quad, { fmtX: fmt, fmtY: (v) => `${v}%` })
        : chEmpty(
            el,
            !m.works.length
              ? '这个号还没有内容。'
              : m.works.some((w) => w.reads != null && Number(w.reads) > 0)
                ? '至少要有三条带阅读数的作品'
                : '这个平台不给单篇阅读数'
          )
  });

  /**
   * 发布后 24 小时：时间刻度对齐之后才能横向比。
   * 一条都没有数据时这一块整块不出现 —— 不留空壳占地方。
   */
  const early = chEarlyView(m.works);
  if (early.length >= 2) {
    cards.push({
      t: '发布后 24 小时',
      sub: `${early.length} 条 · 同一时间刻度`,
      draw: (el) => chBars(el, early, { fmt: fmt, limit: 6 })
    });
  }

  // 同题材对比：只在同组内比，避免「气象 vs 融资」这种没意义的比较
  const sim = chSimilar(m.works);
  cards.push({
    t: sim.enough ? `同类对比 · ${sim.label}` : '同类对比',
    sub: sim.enough ? `${sim.count} 条同题材` : '按标题自动归组',
    draw: (el) =>
      sim.enough
        ? chBars(el, sim.rows, { fmt: fmt, limit: 6 })
        : chEmpty(
            el,
            !m.works.length
              ? '这个号还没有内容。'
              : m.works.filter((w) => w.reads).length < 6
                ? '至少 6 条带阅读的作品才能归组'
                : '这些内容的标题没有明显共同主题，不适合分组比较'
          )
  });

  // 发布效果：周几发的东西更好。数据不足就不画，别用两三条编一个结论
  const weekday = m.weekday;
  cards.push({
    t: '发布效果',
    sub: weekday.enough ? '按星期的平均表现' : m.works.length ? '至少 8 条才看得准' : '还没有内容',
    draw: (el) =>
      weekday.enough
        ? chBars(el, weekday.rows, { fmt: fmt })
        : chEmpty(
            el,
            !m.works.length
              ? '这个号还没有内容。'
              : `现在只有 ${weekday.n} 条带日期的作品，样本太少，结论会骗人`
          )
  });

  /**
   * 先把卡片分成「行」，再渲染。
   *
   * 为什么要在 JS 里分行，而不是交给 CSS 的 auto-fit：
   * 卡片数量是随数据变的 —— 没数据的平台会少几张图。
   * grid 的 auto-fit 先按容器宽度定死列数（这里 1100px 就是 4 列），
   * 一行只有 3 张时右边就空出一格，只有 2 张时空两格，看起来像没渲染完。
   *
   * 分行之后每行是独立 flex 容器，几张卡就平分几份，永远铺满。
   */
  const GAP = 12;
  const MIN_CARD = 230;
  const avail = Math.max(280, host.clientWidth || 900);
  // 一行最多放几张小卡：按最小可读宽度算，但不超过 4
  const maxCols = Math.max(1, Math.min(4, Math.floor((avail + GAP) / (MIN_CARD + GAP))));

  const rows = [];
  let buf = [];
  for (const c of cards) {
    if (c.wide) {
      // 通栏卡自己占一行，先把攒着的普通卡收尾
      if (buf.length) {
        rows.push(buf);
        buf = [];
      }
      rows.push([c]);
    } else {
      buf.push(c);
      if (buf.length >= maxCols) {
        rows.push(buf);
        buf = [];
      }
    }
  }
  if (buf.length) rows.push(buf);

  // 渲染时给每张卡一个全局序号，画图时按序号找容器
  let idx = -1;
  host.innerHTML = rows
    .map(
      (row) =>
        `<div class="chrow">${row
          .map((c) => {
            idx++;
            return `<div class="chcard${c.wide ? ' wide' : ''}${
              row.length === 1 && !c.wide ? ' solo' : ''
            }">
              <div class="chhead"><b>${chEsc(c.t)}</b><i>${chEsc(c.sub || '')}</i></div>
              <div class="chbox" data-ch="${idx}"></div>
            </div>`;
          })
          .join('')}</div>`
    )
    .join('');

  const boxes = host.querySelectorAll('.chbox');
  cards.forEach((c, i) => {
    try {
      c.draw(boxes[i]);
    } catch (err) {
      console.error('[chart]', c.t, err);
      boxes[i].innerHTML = '<div class="chempty">图没画出来</div>';
    }
  });
  host.dataset.n = String(cards.length);
  host.dataset.rows = String(rows.length);
}

/** 窗口尺寸变了要重画：SVG 是按像素画的，不重画就会停在旧宽度上 */
let chResizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(chResizeTimer);
  chResizeTimer = setTimeout(() => {
    if (typeof window.__chRefresh === 'function') window.__chRefresh();
  }, 180);
});
