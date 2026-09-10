/**
 * signers-playwright.js — 基于 Playwright 真实 Chromium 的抖音「签名 + 同源抓取」器（cookie 感知版）
 *
 * 验证结论（2026-09-01）：
 *   1. 直接 headless 导航真实 douyin.com → 多半触发「验证码中间页」或 acrawler 晚加载，签名不稳。
 *   2. 代理渲染页（服务端 httpGet 抓 HTML 喂浏览器）byted_acrawler 稳定可用、可签 47 字符 a_bogus。
 *   3. 但代理渲染页是代理源（localhost），其 fetch 到 douyin.com 跨域被 CORS 拦。
 *   4. 因此最优组合：
 *        - 用【代理渲染页】做签名（acrawler 稳定）→ 拿到 a_bogus 字符串
 *        - 用【真实 douyin.com 页 + 用户 cookie】做同源 fetch（真实 Chrome TLS + 登录态）
 *      两步在不同页面，但 a_bogus 只是字符串可跨页传递。
 *   5. 无 cookie 时真实页为验证码态 → 同源 fetch 静默返回 200+空 body。 cookie 是必需输入。
 *
 * 用法：
 *   const { getDouyinBrowserRequest } = require('./signers-playwright');
 *   const req = await getDouyinBrowserRequest();
 *   const out = await req({ base: 'aid=6383&sec_user_id=...&count=20&max_cursor=0', cookie: '...' });
 *   // out = { status, text, error }
 */
const { chromium } = require('playwright-core');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const EXEC = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROXY_PORT = process.env.PORT || 3000;

let _browser = null;
let _ctx = null;
let _page = null;           // 真实 douyin.com 页（同源 fetch 用）
let _cookieKey = '__NO_COOKIE__';

function cookieToPairs(cookie) {
  if (!cookie || !cookie.length) return [];
  return cookie.split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf('=');
    return { name: s.slice(0, i), value: s.slice(i + 1), url: 'https://www.douyin.com/', domain: '.douyin.com' };
  }).filter(p => p.name);
}

async function ensureBrowser(cookie) {
  const key = cookie || _cookieKey;
  if (_browser && _browser.isConnected() && _page && key === _cookieKey) return;
  if (_browser && _browser.isConnected() && key !== _cookieKey) {
    await _browser.close(); _browser = null; _ctx = null; _page = null;
  }
  _browser = await chromium.launch({
    executablePath: EXEC, headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  _ctx = await _browser.newContext({ userAgent: UA, locale: 'zh-CN' });
  if (cookie && cookie.length) {
    try { await _ctx.addCookies(cookieToPairs(cookie)); } catch (e) { /* ignore */ }
  }
  _cookieKey = key;
  _page = await _ctx.newPage();
  await _page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' });
  // 导航真实 douyin.com（带 cookie → 正常页而非验证码页），取得 douyin.com 同源上下文
  try {
    await _page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch (e) { /* 抖动兜底 */ }
  await _page.waitForFunction(
    () => typeof window.byted_acrawler !== 'undefined' && typeof window.byted_acrawler.sign === 'function',
    { timeout: 12000 }
  ).catch(() => null);
}

/** 在指定页面尝试签名，返回 a_bogus 或 '' */
async function signOnPage(page, base) {
  return await page.evaluate((qs) => {
    try {
      if (typeof window.byted_acrawler === 'undefined' || typeof window.byted_acrawler.sign !== 'function') return '';
      const r = window.byted_acrawler.sign(qs, '/aweme/v1/web/aweme/post/');
      return (typeof r === 'string') ? r : (r && (r.a_bogus || r.XBogus)) || '';
    } catch (e) { return ''; }
  }, base);
}

/** 兜底：用代理渲染页（acrawler 稳定）签名，返回 a_bogus 或 '' */
async function signViaProxyPage(base) {
  try {
    const p = await _ctx.newPage();
    await p.goto('http://127.0.0.1:' + PROXY_PORT + '/sign-page?url=' + encodeURIComponent('https://www.douyin.com/'), { waitUntil: 'domcontentloaded', timeout: 20000 });
    await p.waitForFunction(
      () => typeof window.byted_acrawler !== 'undefined' && typeof window.byted_acrawler.sign === 'function',
      { timeout: 30000 }
    ).catch(() => null);
    const bogus = await signOnPage(p, base);
    await p.close();
    return bogus;
  } catch (e) { return ''; }
}

async function getDouyinBrowserRequest() {
  return async function douyinRequest({ base, cookie, aBogus } = {}) {
    await ensureBrowser(cookie);
    let bogus = aBogus || '';
    if (!bogus) {
      // 1) 真实页签名
      bogus = await signOnPage(_page, base);
      // 2) 真实页 acrawler 未就绪：刷新真实页拿到干净会话再试
      if (!bogus) {
        try { await _page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 25000 }); } catch (e) {}
        await _page.waitForFunction(
          () => typeof window.byted_acrawler !== 'undefined' && typeof window.byted_acrawler.sign === 'function',
          { timeout: 12000 }
        ).catch(() => null);
        bogus = await signOnPage(_page, base);
      }
      // 3) 兜底：代理渲染页签名（acrawler 稳定）
      if (!bogus) bogus = await signViaProxyPage(base);
    }
    if (!bogus) return { status: 0, text: '', error: 'sign_null（真实页与代理渲染页两次签名均失败，可能需要登录 cookie）', acrawler: false };

    // 确保同源 fetch 发生在干净的真实 douyin.com 会话上（避免验证码态/跨会话 a_bogus 不一致）
    const ready = await _page.evaluate(() => typeof window.byted_acrawler !== 'undefined' && typeof window.byted_acrawler.sign === 'function');
    if (!ready) {
      try { await _page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 25000 }); } catch (e) {}
    }

    // 在真实 douyin.com 页同源 fetch（携带登录态 + 真实 Chrome TLS）
    const out = await _page.evaluate(async ({ qs, bogus }) => {
      try {
        const url = 'https://www.douyin.com/aweme/v1/web/aweme/post/?' + qs + '&a_bogus=' + encodeURIComponent(bogus);
        const resp = await fetch(url, {
          headers: { 'User-Agent': navigator.userAgent, 'Referer': 'https://www.douyin.com/', 'Accept': 'application/json, text/plain, */*' },
        });
        const text = await resp.text();
        return { status: resp.status, text };
      } catch (e) { return { error: e.message }; }
    }, { qs: base, bogus });
    out.acrawler = true;
    return out;
  };
}

async function closeSigner() {
  if (_browser && _browser.isConnected()) { await _browser.close(); _browser = null; _ctx = null; _page = null; _cookieKey = '__NO_COOKIE__'; }
}

module.exports = { getDouyinBrowserRequest, closeSigner, UA, getDouyinSigner: getDouyinBrowserRequest };
