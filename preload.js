'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  listPlats: () => ipcRenderer.invoke('plats:list'),
  openPanel: (plat, opts) => ipcRenderer.invoke('panel:open', plat, opts || {}),
  /** 给同一个平台再开一个全新的隔离环境（第二个号） */
  openNewAccount: (plat) => ipcRenderer.invoke('panel:open', plat, { newAccount: true }),
  closePanel: () => ipcRenderer.invoke('panel:close'),
  goPanel: (url) => ipcRenderer.invoke('panel:go', url),
  donePanel: () => ipcRenderer.invoke('panel:done'),
  reloadPanel: () => ipcRenderer.invoke('panel:reload'),
  /** 把本机 Chrome 里这个平台的登录态搬进当前分区 */
  importChrome: (profileName) => ipcRenderer.invoke('panel:importChrome', profileName),
  /** 列出本机 Chrome / Edge 的资料（可指定导入哪一份） */
  chromeProfiles: () => ipcRenderer.invoke('chrome:profiles'),
  openData: () => ipcRenderer.invoke('shell:openData'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // ------------------------------------------------------------ 数据
  platDetail: (plat) => ipcRenderer.invoke('plat:detail', plat),
  accountDetail: (id, opts) => ipcRenderer.invoke('account:detail', id, opts || {}),
  syncAccount: (id) => ipcRenderer.invoke('account:sync', id),
  syncPlat: (plat) => ipcRenderer.invoke('plat:syncAll', plat),
  exportAccount: (id, format) => ipcRenderer.invoke('account:export', id, format),
  diagOpen: () => ipcRenderer.invoke('diag:open'),
  /**
   * 退出登录：清掉这个号专属分区的登录态。
   * 不依赖平台页面上的退出按钮 —— 那些经常点不动或被弹窗卡死。
   */
  logout: (id) => ipcRenderer.invoke('account:logout', id),
  whoami: (id) => ipcRenderer.invoke('account:whoami', id),

  // ------------------------------------------------------------ 给别的 AI 用
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiToggle: (on) => ipcRenderer.invoke('ai:toggle', on),
  aiRotate: () => ipcRenderer.invoke('ai:rotate'),
  aiMcpConfig: () => ipcRenderer.invoke('ai:mcpConfig'),

  // ------------------------------------------------------------ 每日自动更新
  dailyStatus: () => ipcRenderer.invoke('daily:status'),
  dailySave: (p) => ipcRenderer.invoke('daily:save', p || {}),
  dailyRunNow: () => ipcRenderer.invoke('daily:runNow'),
  onDailyEvent: (cb) => {
    ipcRenderer.on('daily:event', (_e, ev) => cb(ev));
  },

  // ------------------------------------------------------------ 导出与报告
  /** 导数据：format = xlsx | json | csv；range = week | month | year | all | '' */
  exportData: (opts) => ipcRenderer.invoke('data:export', opts || {}),
  /** 生成报告：format = md | docx | pdf */
  genReport: (opts) => ipcRenderer.invoke('report:generate', opts || {}),
  /** 报告预览（拿 markdown 文本） */
  previewReport: (opts) => ipcRenderer.invoke('report:preview', opts || {}),

  onPanelState: (cb) => {
    ipcRenderer.on('panel:state', (_e, s) => cb(s));
  },
  onPanelUrl: (cb) => {
    ipcRenderer.on('panel:url', (_e, s) => cb(s));
  },
  /** 面板占多宽 —— 左栏要按这个留出右边距，否则内容会被原生视图盖住 */
  onPanelWidth: (cb) => {
    ipcRenderer.on('panel:width', (_e, w) => cb(w));
  },
  onPlatsUpdate: (cb) => {
    ipcRenderer.on('plats:update', (_e, list) => cb(list));
  },
  /** 读数进度：phase = start / reading / done */
  onSyncProgress: (cb) => {
    ipcRenderer.on('sync:progress', (_e, p) => cb(p));
  }
});
