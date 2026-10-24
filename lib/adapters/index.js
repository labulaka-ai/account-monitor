'use strict';
/**
 * 适配器注册表
 *
 * 三层：内置默认值 → 外部 JSON 覆盖 → 运行时校验
 *
 * 为什么要外部覆盖：平台改版是必然事件。改版时用户（或维护者）只需替换一个 JSON，
 * 不用等新版本、不用改代码。开源项目里这决定了这套东西能活多久。
 */

const fs = require('node:fs');
const path = require('node:path');

const { PLATFORMS, DISPLAY } = require('./platforms');

const MODES = new Set(['web', 'cookie', 'api']);

// ------------------------------------------------------------ 合并与校验
function mergeDeep(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergeDeep(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isHttpUrl(s) {
  return typeof s === 'string' && /^https?:\/\//.test(s);
}

/** 返回错误信息数组，空数组表示通过 */
function validate(a) {
  const errs = [];
  if (!a || typeof a !== 'object') return ['适配器不是对象'];
  if (!a.key) errs.push('缺少 key');
  if (!a.name) errs.push('缺少 name');
  if (!MODES.has(a.mode)) errs.push(`mode 必须是 web/cookie/api，实际 ${a.mode}`);
  if (!a.pages || !isHttpUrl(a.pages.account)) errs.push('pages.account 必须是 http(s) 地址');
  if (a.pages && a.pages.works != null && !isHttpUrl(a.pages.works)) errs.push('pages.works 不是合法地址');
  for (const k of ['account', 'work']) {
    if (!Array.isArray(a.caps && a.caps[k])) errs.push(`caps.${k} 必须是数组`);
  }
  if (a.caps && a.caps.extra != null && !Array.isArray(a.caps.extra)) errs.push('caps.extra 必须是数组');
  if (!(typeof a.paceMin === 'number' && a.paceMin > 0)) errs.push('paceMin 必须是正数');
  if (!(typeof a.listPageSize === 'number' && a.listPageSize > 0)) errs.push('listPageSize 必须是正数');
  return errs;
}

// ------------------------------------------------------------ 加载
/**
 * @param {string} [externalDir] 外部覆盖目录，里面放 <key>.json
 * @returns {{adapters:Object, list:Function, warnings:string[]}}
 */
function load(externalDir) {
  const warnings = [];
  const adapters = new Map();

  for (const base of PLATFORMS) {
    let a = Object.assign({}, base);

    if (externalDir) {
      const file = path.join(externalDir, `${base.key}.json`);
      if (fs.existsSync(file)) {
        try {
          const patch = JSON.parse(fs.readFileSync(file, 'utf8'));
          a = mergeDeep(base, patch);
          if (patch.adapterVersion) a.adapterVersion = patch.adapterVersion;
        } catch (err) {
          warnings.push(`${base.key}.json 解析失败，已用内置默认值：${err.message}`);
        }
      }
    }

    const errs = validate(a);
    if (errs.length) {
      warnings.push(`${base.key} 适配器不合法（${errs.join('；')}），已用内置默认值`);
      a = Object.assign({}, base);
    }
    adapters.set(a.key, a);
  }

  return { adapters, warnings };
}

// ------------------------------------------------------------ 查询
function makeRegistry(externalDir) {
  const { adapters, warnings } = load(externalDir);

  /** 按显示名取适配器，如 '小红书' → xhs 适配器 */
  function get(platName) {
    for (const a of adapters.values()) if (a.name === platName) return a;
    return null;
  }

  function byKey(key) {
    return adapters.get(key) || null;
  }

  /** 所有平台，顺序即界面顺序（国内在前、海外在后，见 platforms.js） */
  function list() {
    return [...adapters.values()]
      .filter((a) => a.region !== 'hidden')
      .map((a) => ({
        plat: a.name,
        key: a.key,
        slug: a.key,
        icon: a.icon || a.key,
        brand: a.brand || '#8A8F98',
        // 浅色主题用的品牌色；没写就沿用 brand（只有近白色的平台需要单独给）
        brandLight: a.brandLight || a.brand || '#8A8F98',
        region: a.region || 'cn',
        adapter: a
      }));
  }

  /** 这个平台能不能读某个作品指标 —— 界面按它决定显示哪些列 */
  function can(platName, field) {
    const a = get(platName);
    if (!a) return false;
    return a.caps.work.includes(field) || a.caps.extra.includes(field);
  }

  /**
   * 适配器是否可能已失效。
   * verifiedAt 形如 '2026-10'（只到月），超过 60 天就提示用户。
   */
  function staleness(platName, now = new Date()) {
    const a = get(platName);
    if (!a || !a.verifiedAt) return { known: false, days: null, warn: true };
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(a.verifiedAt);
    if (!m) return { known: false, days: null, warn: true };
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3] || 1));
    const days = Math.floor((now - d) / 86400000);
    return { known: true, days, warn: days > 60 };
  }

  return { get, byKey, list, can, staleness, warnings, adapters };
}

module.exports = { makeRegistry, validate, mergeDeep, DISPLAY };
