/**
 * httpHelper — 纯 Node 内置模块实现的 HTTP 请求（兼容 Node16 / Node18+ / Vercel）
 * 用内置 https/http 模块实现 GET，返回 { status, text, json() }
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

function request(url, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const headers = options.headers || {};
    const method = (options.method || 'GET').toUpperCase();
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: method,
      headers: headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, text: data });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.setTimeout(options.timeout || 30000, () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

async function httpGet(url, headers) {
  const r = await request(url, { method: 'GET', headers: headers });
  return {
    status: r.status,
    text: r.text,
    json: () => { try { return JSON.parse(r.text); } catch (e) { return null; } },
  };
}

/**
 * 给 vm 沙箱用的 fetch 垫片（acrawler 脚本内部会调用 fetch）
 */
async function fetchShim(url, opts) {
  const headers = (opts && opts.headers) || {};
  const r = await httpGet(url, headers);
  return {
    status: r.status,
    text: async () => r.text,
    json: async () => r.json(),
  };
}

module.exports = { request, httpGet, fetchShim };
