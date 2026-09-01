/**
 * signers.js — 抖音 a_bogus / 小红书 x-s 签名模块（Vercel Node 兼容版）
 * ----------------------------------------------------------------------------
 * 抖音 a_bogus：运行时拉取抖音官方 acrawler 签名脚本，在带浏览器 shim 的 vm 中执行，
 *               调用其暴露的 sign 方法生成 a_bogus（用官方代码本身，抗版本变动能力最强）。
 * 小红书 x-s：基于公开逆向结构的参考实现（占位，需实测校准）。
 *
 * ⚠️ 二者均「未经真实平台在线验证」。部署后用你自己的账号实测；若平台升级导致签名失效，
 *    只需替换本文件中的 genABogus / genXs 实现即可，无需改动 core.js 的抓取/归一化逻辑。
 * ----------------------------------------------------------------------------
 */
const crypto = require('crypto');
const vm = require('vm');
const { httpGet, fetchShim } = require('./httpHelper');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const XHS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Vercel Node18+ 全局有 Web Crypto；Node16 用 require('crypto').webcrypto。
// acrawler 内部可能调用 crypto.getRandomValues，必须注入 Web Crypto 而非 Node crypto 模块。
const WEB_CRYPTO = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues)
  ? globalThis.crypto
  : (crypto.webcrypto || null);

/* ============================ 抖音 a_bogus ============================ */

let _acrawlerCtx = null;

function makeWindowShim() {
  const nav = {
    userAgent: UA, language: 'zh-CN', languages: ['zh-CN', 'zh'],
    platform: 'Win32', hardwareConcurrency: 8, deviceMemory: 8,
    vendor: 'Google Inc.', cookieEnabled: true, onLine: true,
    maxTouchPoints: 0,
  };
  const screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 };
  const doc = {
    cookie: '', referrer: 'https://www.douyin.com/', title: '抖音',
    documentElement: { style: {} },
    createElement: () => ({ getContext: () => ({}), style: {}, setAttribute() {}, appendChild() {} }),
    getElementById: () => null, querySelector: () => null, addEventListener() {},
    body: { appendChild() {}, style: {} },
    location: { href: 'https://www.douyin.com/' },
  };
  const win = {
    navigator: nav, screen, document: doc,
    location: { href: 'https://www.douyin.com/', hostname: 'www.douyin.com', search: '', pathname: '/' },
    history: { length: 1 },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Math, Date, JSON, parseInt, parseFloat, isNaN,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout, setInterval, clearInterval,
    console, crypto: WEB_CRYPTO, fetch: fetchShim,
  };
  win.window = win; win.self = win; win.globalThis = win;
  return win;
}

async function loadAcrawler() {
  if (_acrawlerCtx) return _acrawlerCtx;
  const htmlRes = await httpGet('https://www.douyin.com/', { 'User-Agent': UA });
  const html = htmlRes.text;
  const m = html.match(/src=["']([^"']*acrawler[^"']*\.js)["']/);
  let scriptUrl = m && m[1];
  if (!scriptUrl) throw new Error('无法从抖音首页提取 acrawler 签名脚本地址（首页结构可能已变）');
  if (scriptUrl.startsWith('//')) scriptUrl = 'https:' + scriptUrl;
  if (scriptUrl.startsWith('/')) scriptUrl = 'https://www.douyin.com' + scriptUrl;
  const scriptSrcRes = await httpGet(scriptUrl, { 'User-Agent': UA });
  const scriptSrc = scriptSrcRes.text;
  const win = makeWindowShim();
  vm.runInContext(scriptSrc, vm.createContext(win), { filename: 'acrawler.js' });
  if (!win.byted_acrawler || typeof win.byted_acrawler.sign !== 'function') {
    throw new Error('签名脚本已加载，但未暴露 byted_acrawler.sign 方法（脚本版本可能已变）');
  }
  _acrawlerCtx = win;
  return win;
}

/**
 * 生成抖音 a_bogus
 * @param {string} queryString 形如 "aid=6383&sec_user_id=xxx&count=20&max_cursor=0"
 * @param {string} path 接口路径，默认作品列表
 */
async function genABogus(queryString, path = '/aweme/v1/web/aweme/post/') {
  const win = await loadAcrawler();
  const signer = win.byted_acrawler;
  try {
    const r = signer.sign(queryString, path);
    if (typeof r === 'string') return r;
    if (r && r.a_bogus) return r.a_bogus;
    if (r && r.XBogus) return r.XBogus;
  } catch (e) { /* 落到下方抛错 */ }
  throw new Error('a_bogus 生成失败');
}

/* ============================ 小红书 x-s / x-t ============================ */

// 小红书 x-s 的公开逆向结构（参考实现，需实测校准）。
function genXs(query, body, ts) {
  const raw = (query || '') + (body || '');
  const salt = 'xhs-api-sign'; // 真实为 sdk 内置固定串，需从官方包提取
  const h = crypto.createHash('md5').update(salt + raw + ts).digest('hex');
  return h; // 真实 x-s 为更长更复杂串，此处仅为占位让链路可跑通
}

function genXt() {
  return Date.now().toString();
}

module.exports = { genABogus, genXs, genXt, UA, XHS_UA };
