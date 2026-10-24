'use strict';
/**
 * 平台符号
 *
 * 都是手绘的简化标记，不是官方素材：官方 logo 各有版权，直接打包进开源仓库不合适。
 * 画法的取舍是「一眼能认出是谁」——
 *   有公认几何形状的（YouTube 播放键、IG 相机框、B站电视）就照着画；
 *   官方本身就是字标的（小红书、知乎）就用字；
 *   其余用最能代表它的那一个图形。
 *
 * 关键约束：路径一律在 24×24 里画，线宽 2，视觉重量靠 .tile 的尺寸统一。
 * currentColor 取品牌色；需要「挖空」的地方用 var(--bg)。
 */
const PLAT_ICONS = {
  // 微信生态：两个对话气泡
  gzh: `<path d="M9.3 3.2c-4.1 0-7.4 2.8-7.4 6.2 0 2 1.1 3.7 2.9 4.9l-.8 2.5 2.8-1.4c.8.2 1.7.4 2.5.4h.5a5.6 5.6 0 0 1-.2-1.5c0-3.1 3-5.6 6.7-5.6h.6C16.2 5.4 13.1 3.2 9.3 3.2Zm-2.7 3.4a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm5.4 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/>
     <path d="M22 14.3c0-2.7-2.7-4.9-6-4.9s-6 2.2-6 4.9 2.7 4.9 6 4.9c.8 0 1.6-.1 2.3-.4l2.3 1.1-.6-2c1.2-.9 2-2.2 2-3.6Zm-8-1.4a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Zm4 0a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Z"/>`,

  // 小红书：官方就是红底字标
  xhs: `<rect x="2" y="2" width="20" height="20" rx="6"/>
        <text x="12" y="16.9" text-anchor="middle" font-size="12.5" fill="var(--bg)">红</text>`,

  // 抖音：音符
  douyin: `<path d="M14.7 2.4h2.6c.3 2 1.6 3.6 3.6 3.9v2.7c-1.4 0-2.7-.4-3.8-1.2v6.4c0 3.4-2.8 6.1-6.2 6.1S4.7 17.6 4.7 14.2s2.8-6.1 6.2-6.1c.3 0 .6 0 .9.1v2.8c-.3-.1-.6-.2-.9-.2-1.9 0-3.5 1.5-3.5 3.4s1.6 3.4 3.5 3.4 3.5-1.5 3.5-3.4V2.4Z"/>`,

  // 视频号：方框里一个播放键（和公众号的两个气泡区分开）
  channels: `<rect x="2" y="3.5" width="20" height="17" rx="5.5"/>
             <path d="M10.2 8.6v6.8l5.6-3.4z" fill="var(--bg)"/>`,

  // 微博：眼睛
  weibo: `<path d="M12 4.6c5.2 0 9.4 3.5 10 7.4-.6 3.9-4.8 7.4-10 7.4S2.6 15.9 2 12c.6-3.9 4.8-7.4 10-7.4Z"
                fill="none" stroke="currentColor" stroke-width="2"/>
          <circle cx="12" cy="12" r="3.2"/>`,

  // 知乎：官方就是字标
  zhihu: `<rect x="2" y="2" width="20" height="20" rx="6"/>
          <text x="12" y="16.9" text-anchor="middle" font-size="12.5" fill="var(--bg)">知</text>`,

  // B站：电视 + 天线
  bili: `<rect x="1.6" y="5.4" width="20.8" height="15" rx="4.4"/>
         <path d="M6.6 1.9 9.4 4.7M17.4 1.9 14.6 4.7" stroke="currentColor" stroke-width="2"
               fill="none" stroke-linecap="round"/>`,

  x: `<path d="M17.6 3h3.1l-6.8 7.8L21.9 21h-6.2l-4.9-6.4L5.2 21H2.1l7.2-8.2L1.9 3h6.4l4.5 5.9L17.6 3Zm-1.1 16.1h1.7L7.3 4.8H5.5l11 14.3Z"/>`,

  yt: `<path d="M21.6 7.2a2.6 2.6 0 0 0-1.8-1.9C18.2 4.9 12 4.9 12 4.9s-6.2 0-7.8.4A2.6 2.6 0 0 0 2.4 7.2 26.8 26.8 0 0 0 2 12c0 1.6.1 3.2.4 4.8a2.6 2.6 0 0 0 1.8 1.9c1.6.4 7.8.4 7.8.4s6.2 0 7.8-.4a2.6 2.6 0 0 0 1.8-1.9c.3-1.6.4-3.2.4-4.8s-.1-3.2-.4-4.8Z"/>
       <path d="M10 15.4V8.6L15.6 12 10 15.4Z" fill="var(--bg)"/>`,

  ig: `<rect x="2.2" y="2.2" width="19.6" height="19.6" rx="5.8" fill="none" stroke="currentColor" stroke-width="2"/>
       <circle cx="12" cy="12" r="4.3" fill="none" stroke="currentColor" stroke-width="2"/>
       <circle cx="17.4" cy="6.6" r="1.4"/>`,

  threads: `<path d="M12.2 21.4c-4.7 0-8.1-3.4-8.1-9.4S7.5 2.6 12.2 2.6c3.9 0 6.9 2.1 7.7 5.9"
                 fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>
            <path d="M15.9 9.1c2 .5 3.6 1.9 3.6 4.3 0 3.3-2.7 5.2-6.1 5.2-3 0-5.2-1.5-5.2-3.8 0-2.1 1.9-3.5 4.5-3.5 3.2 0 5.5 1.7 5.5 4.4"
                 fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>`,

  /**
   * TikTok：官方 logo 有版权，不进开源仓库（跟其他平台同一个原则）。
   * 这里画的是「音符」通用符号 —— 一眼能认出是短视频/音乐类平台，
   * 又不会被当成官方素材。
   */
  tiktok: `<circle cx="8.6" cy="17.2" r="3.3" fill="none" stroke="currentColor" stroke-width="2"/>
           <path d="M11.9 17.2V5.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
           <path d="M11.9 5.6c.2 2.1 1.6 3.4 3.8 3.6" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
           <path d="M11.9 9.7l5.5 1.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,

  // 认不出的平台不能变成空白格子
  unknown: `<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="2"/>
            <path d="M9.4 9.4a2.7 2.7 0 1 1 3.6 2.5c-.7.3-1 .8-1 1.5v.5" fill="none"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <circle cx="12" cy="17" r="1.1"/>`
};

/** 取一个平台的图形；key 不存在时退回 unknown，界面不会出现空洞 */
function iconOf(key) {
  return PLAT_ICONS[key] || PLAT_ICONS.unknown;
}

/** 包成可直接插进 innerHTML 的 svg */
function svgOf(key) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${iconOf(key)}</svg>`;
}
