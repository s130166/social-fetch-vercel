/**
 * subtitle.js — 字幕直取桥接（借鉴本地「AI视频字幕提取器」思路升级版）
 *
 * 路由（由 index.js 调用）：
 *   POST /subtitle/redfox/submit  { url, redfoxKey? }  -> { ok, taskId }
 *   POST /subtitle/redfox/result  { taskId, redfoxKey? } -> { ok, done, status, text, sents[] }
 *   POST /subtitle/bilibili       { url }  -> { ok, text, sents[], cached? }
 *
 * 抖音：红狐 API（redfox.hk）云端转写 —— 只需视频 URL，提交后轮询，
 *       无需 ffmpeg / OSS / 浏览器签名，直接返回带时间戳分句字幕。
 * B站： 公开 API 直取官方 CC 字幕（view 拿 cid -> player 拿 subtitle_url -> JSON 分句），
 *       比原工具的 opencli CLI 方案更轻（零本地依赖，服务端直连秒级返回）。
 */
const { httpGet, request } = require('./httpHelper');

const REDFOX_HOST = 'https://redfox.hk';
const REDFOX_SUBMIT = '/story/api/parseWork/audioTextExtract/submit/douyin';
const REDFOX_RESULT = '/story/api/parseWork/audioTextExtract/result/douyin';
const CACHE_TTL = 15 * 60 * 1000; // 15 分钟内同 URL 复用任务/结果

/* ---------- 内存缓存（防同一视频重复提交） ---------- */
const redfoxTaskCache = new Map(); // url -> { taskId, ts }
const biliSubCache = new Map();    // bv -> { result, ts }
const redfoxResultCache = new Map(); // taskId -> { result, ts }

function cacheGet(map, key) {
  const ent = map.get(key);
  if (!ent) return null;
  if (Date.now() - ent.ts > CACHE_TTL) { map.delete(key); return null; }
  return ent;
}

function getRedfoxKey(bodyKey) {
  return (bodyKey || process.env.REDFOX_API_KEY || '').trim();
}

function extractUrl(text) {
  if (!text) return '';
  const m = String(text).match(/https?:\/\/[^\s，,】\]]+/);
  return m ? m[0] : String(text).trim();
}

/* ---------- 红狐 API ---------- */
async function redfoxPost(pathName, payload, key) {
  const r = await request(REDFOX_HOST + pathName, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': key,
      'REDFOX_API_KEY': key,
    },
    body: JSON.stringify(payload),
    timeout: 30000,
  });
  try { return JSON.parse(r.text); }
  catch (e) { return { code: -1, msg: '响应解析失败: ' + String(r.text || '').slice(0, 200) }; }
}

async function redfoxSubmit(body) {
  const key = getRedfoxKey(body && body.redfoxKey);
  if (!key) return { ok: false, error: '未配置红狐 API Key：请在工作台「设置 → 红狐 API Key」填写，或在 social-fetch 环境变量设 REDFOX_API_KEY' };
  const url = extractUrl(body && body.url);
  if (!url) return { ok: false, error: '未识别到抖音视频链接' };

  const cached = cacheGet(redfoxTaskCache, url);
  if (cached) return { ok: true, taskId: cached.taskId, cached: true };

  const r = await redfoxPost(REDFOX_SUBMIT, { url: url }, key);
  if (r.code !== 2000) {
    return { ok: false, error: '红狐提交失败: ' + JSON.stringify(r).slice(0, 300) };
  }
  const d = r.data || {};
  let taskId = d.id || d.taskId || '';
  if (!taskId) {
    for (const k of Object.keys(d)) {
      if (/id/i.test(k) && typeof d[k] === 'string') { taskId = d[k]; break; }
    }
  }
  if (!taskId) return { ok: false, error: '红狐未返回 taskId' };
  redfoxTaskCache.set(url, { taskId, ts: Date.now() });
  return { ok: true, taskId, cached: false };
}

async function redfoxResult(body) {
  const key = getRedfoxKey(body && body.redfoxKey);
  if (!key) return { ok: false, error: '未配置红狐 API Key' };
  const taskId = String((body && body.taskId) || '').trim();
  if (!taskId) return { ok: false, error: '缺少 taskId' };

  const cached = cacheGet(redfoxResultCache, taskId);
  if (cached) return Object.assign({ cached: true }, cached.result);

  const r = await redfoxPost(REDFOX_RESULT, { taskId }, key);
  const code = r.code;
  const d = r.data || {};
  const status = String(d.status || code || '');

  // 任务已终结（成功 / 失败）
  const hasText = !!(d.text || (d.stampSents && d.stampSents.length));
  if (code === 2000 && (status.toLowerCase() === 'fail' || status.toLowerCase() === 'failed')) {
    const res = { ok: true, done: true, status: 'fail', error: d.failReason || '红狐转写任务失败' };
    redfoxResultCache.set(taskId, { result: res, ts: Date.now() });
    return res;
  }
  if (code === 2000 && (status === 'success' || hasText)) {
    const sents = [];
    (d.stampSents || []).forEach(function (s) {
      if (s && typeof s === 'object') {
        const t = s.textSeg || s.text || s.content || '';
        if (t) sents.push({ text: t, start: Number(s.start) || 0, end: Number(s.end) || 0 });
      }
    });
    const res = { ok: true, done: true, status: 'success', text: d.text || sents.map(function (s) { return s.text; }).join(''), sents };
    redfoxResultCache.set(taskId, { result: res, ts: Date.now() });
    return res;
  }
  // 仍在处理中
  return { ok: true, done: false, status: status || 'processing' };
}

/* ---------- B站官方 CC 字幕直取 ---------- */
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function biliExtractRef(text) {
  const s = String(text || '');
  let m = s.match(/(?:BV|bv)[0-9A-Za-z]{10}/);
  if (m) return m[0];
  m = s.match(/https?:\/\/(?:www\.)?(?:bilibili\.com|b23\.tv)\/[^\s，,】\]]+/);
  return m ? m[0] : '';
}

function secToMs(v) {
  if (typeof v === 'number') return Math.round(v * 1000);
  const m = /[\d.]+/.exec(String(v || ''));
  return m ? Math.round(parseFloat(m[0]) * 1000) : 0;
}

async function biliSubtitle(body) {
  const ref = biliExtractRef(body && body.url);
  if (!ref) return { ok: false, error: '未识别到 BV 号或 B站链接' };
  // 可选 B站 Cookie（SESSDATA）：B站字幕接口需登录态才返回字幕列表
  const biliCookie = String((body && body.biliCookie) || '').trim();
  const authHeaders = { 'User-Agent': BILI_UA, 'Referer': 'https://www.bilibili.com/' };
  if (biliCookie) authHeaders['Cookie'] = biliCookie;

  const cached = cacheGet(biliSubCache, ref);
  if (cached) return Object.assign({ cached: true }, cached.result);

  // 1) view API 拿 cid
  const bv = ref.match(/(?:BV|bv)[0-9A-Za-z]{10}/) ? ref.match(/(?:BV|bv)[0-9A-Za-z]{10}/)[0] : '';
  const viewApi = bv
    ? 'https://api.bilibili.com/x/web-interface/view?bvid=' + bv
    : ref; // b23.tv 短链：直接 GET 会 302，httpHelper 不跟跳转 -> 仍尝试 view 失败后报错
  if (!bv) {
    return { ok: false, error: '暂只支持 BV 号或 www.bilibili.com/video/BV... 链接（b23.tv 短链请先在浏览器打开后复制长链）' };
  }
  const viewRes = await httpGet(viewApi, authHeaders);
  const viewJson = viewRes.json();
  if (!viewJson || viewJson.code !== 0 || !viewJson.data) {
    return { ok: false, error: '获取视频信息失败: ' + ((viewJson && (viewJson.message || viewJson.msg)) || 'HTTP ' + viewRes.status) };
  }
  const cid = viewJson.data.cid;
  const title = viewJson.data.title || '';

  // 2) player API 拿字幕列表（CC 字幕，公开可取；AI 大字幕需登录态通常取不到）
  const playerRes = await httpGet(
    'https://api.bilibili.com/x/player/v2?bvid=' + bv + '&cid=' + cid,
    { 'User-Agent': BILI_UA, 'Referer': 'https://www.bilibili.com/' }
  );
  const playerJson = playerRes.json();
  const subs = (playerJson && playerJson.data && playerJson.data.subtitle && playerJson.data.subtitle.subtitles) || [];
  if (!subs.length) {
    return { ok: false, error: '该视频无 CC 字幕（UP 主未上传或未开启字幕）' };
  }
  // 优先中文字幕
  const pick = subs.find(function (s) { return /zh/i.test(s.lan || ''); }) || subs[0];
  if (!pick.subtitle_url) return { ok: false, error: '字幕地址为空' };
  const subUrl = pick.subtitle_url.replace(/^\/\//, 'https://');

  // 3) 下载字幕 JSON（BIRET 格式：body[].from/to/content）
  const subRes = await httpGet(subUrl, authHeaders);
  const subJson = subRes.json();
  const rows = (subJson && subJson.body) || [];
  if (!rows.length) return { ok: false, error: '字幕内容为空' };

  const sents = [];
  const parts = [];
  rows.forEach(function (row) {
    const t = row.content || row.text || '';
    if (!t) return;
    sents.push({ text: t, start: secToMs(row.from), end: secToMs(row.to) });
    parts.push(t);
  });
  const result = { ok: true, text: parts.join(''), sents, title, lan: pick.lan || '' };
  biliSubCache.set(ref, { result, ts: Date.now() });
  return result;
}

module.exports = { redfoxSubmit, redfoxResult, biliSubtitle };
