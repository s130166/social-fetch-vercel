/**
 * transcribe.js — 视频链接 → 音频提取 → 云端 STT 转写
 * 部署：与 social-fetch 同进程（本地 serveo 隧道 / Vercel 均可）
 *
 * 端点：POST /transcribe
 * Body: { platform: 'douyin'|'xiaohongshu'|'bilibili', url: '视频链接', cookie?: '...',
 *         sttKey?: 'STT Key', sttProvider?: 'aliyun'|'openai' }
 * Resp: { ok, text?, title?, durationSec?, platform?, error? }
 *
 * STT provider（环境变量 STT_PROVIDER，默认 aliyun）：
 *   - aliyun : 阿里云百炼 DashScope Paraformer 录音文件识别（中文效果好、按量计费便宜）
 *              Key 取 DASHSCOPE_API_KEY，模型取 DASHSCOPE_MODEL（默认 paraformer-v2）
 *   - openai : OpenAI Whisper（whisper-1），Key 取 OPENAI_API_KEY
 *
 * 流程：
 *   1) resolveVideoUrl  —— 按平台拿到视频直链（B站走公开API；抖音/小红书走签名）
 *   2) downloadBinary   —— 流式下载到 /tmp，跟随 301/302
 *   3) ffmpegExtract    —— 抽 16kHz 单声道 mp3
 *   4) 转写：
 *      - openai : whisperTranscribe —— 直传本地音频到 OpenAI Whisper API
 *      - aliyun : Paraformer 需要「可公网访问的音频 URL」：
 *                ① 配置阿里云 OSS（ALIYUN_OSS_*）→ 上传后给签名 URL（最稳，三平台通用）
 *                ② 否则走本机自托管：文件经 /audio/<id> 暴露，PUBLIC_BASE 或 serveo 隧道地址拼接
 *                ③ 都没有 → 明确报错引导配置
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const FormData = require('form-data');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { httpGet, request } = require('./httpHelper');
const { getDouyinBrowserRequest, UA } = require('./signers-playwright');
const { genXs, genXt, XHS_UA } = require('./signers');

/* ---------------- ffmpeg 路径：优先打包二进制，否则系统 PATH ---------------- */
function ffmpegPath() {
  try {
    const p = ffmpegInstaller.path;
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* ignore */ }
  return 'ffmpeg'; // 依赖系统 PATH（本机 Windows 已装）
}

/* ---------------- 流式下载二进制（跟随重定向，写入临时文件） ---------------- */
function downloadBinary(url, dest, timeoutMs = 180000, referer = '') {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const doGet = (u) => {
      const parsed = new URL(u);
      const lib = parsed.protocol === 'http:' ? http : https;
      const req = lib.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          // 站点 CDN 通常校验 Referer 必须是主站域名，不能用 CDN 自身 origin
          'Referer': referer || (parsed.origin + '/'),
        },
      }, (res) => {
        const status = res.statusCode;
        if (status >= 300 && status < 400 && res.headers.location) {
          if (++redirects > 6) return reject(new Error('下载重定向次数过多'));
          res.resume(); // 丢弃响应体
          const next = new URL(res.headers.location, u).href;
          return doGet(next);
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error('下载失败 HTTP ' + status));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('下载超时')); });
    };
    doGet(url);
  });
}

/* ---------------- ffmpeg 抽取音频为 Whisper 友好格式 ---------------- */
function ffmpegExtract(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    const ff = ffmpegPath();
    const args = [
      '-y', '-i', videoPath,
      '-vn', '-ac', '1', '-ar', '16000',
      '-b:a', '64k',
      audioPath,
    ];
    const proc = spawn(ff, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('exit', (code) => {
      if (code === 0 && fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0) resolve(audioPath);
      else reject(new Error('ffmpeg 提取音频失败(code=' + code + ')：' + err.slice(-400)));
    });
    proc.on('error', reject);
  });
}

/* ---------------- OpenAI Whisper 转写 ---------------- */
async function whisperTranscribe(audioPath, apiKey) {
  if (!apiKey) throw new Error('缺少 STT Key（OpenAI Whisper）。请在 social-fetch 环境设置 OPENAI_API_KEY，或请求体传入 sttKey');
  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath));
  form.append('model', 'whisper-1');
  form.append('response_format', 'json');
  form.append('language', 'zh');

  const body = form.getBuffer();
  const headers = form.getHeaders();
  headers['Authorization'] = 'Bearer ' + apiKey;

  return new Promise((resolve, reject) => {
    const req = https.request('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Whisper API HTTP ' + res.statusCode + '：' + data.slice(0, 300)));
        try {
          const j = JSON.parse(data);
          resolve(j.text || '');
        } catch (e) { reject(new Error('Whisper 响应解析失败：' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('Whisper 请求超时')));
    req.write(body);
    req.end();
  });
}

/* ---------------- 阿里云百炼 DashScope Paraformer 转写 ----------------
 * Paraformer 文件识别接口接收「音频文件 URL」（公网可达），不支持直接传字节。
 * 所以我们把本地抽好的 mp3 暴露成一个可访问 URL（OSS 或本机 /audio 自托管）再交给它。
 */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dashscopeRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(url, { method, headers: headers || {}, rejectUnauthorized: true }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('DashScope 请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

/* 把本地音频暴露成公网 URL：优先 OSS，否则本机自托管（host 由 index.js 注入），否则报错 */
async function getAudioPublicUrl(audioPath, host) {
  const hasOss = process.env.ALIYUN_OSS_BUCKET && process.env.ALIYUN_OSS_ENDPOINT &&
    process.env.ALIYUN_ACCESS_KEY_ID && process.env.ALIYUN_ACCESS_KEY_SECRET;
  if (hasOss) {
    let OSS;
    try { OSS = require('ali-oss'); } catch (e) { throw new Error('未安装 ali-oss，请先 `npm i ali-oss`'); }
    const client = new OSS({
      endpoint: process.env.ALIYUN_OSS_ENDPOINT,
      accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
      accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
      bucket: process.env.ALIYUN_OSS_BUCKET,
    });
    const key = 'transcribe/' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8) + '.mp3';
    await client.put(key, audioPath, { mime: 'audio/mpeg' });
    const url = client.signatureUrl(key, { expires: 600, method: 'GET' });
    return { url, cleanup: null };
  }
  if (typeof host === 'function') {
    const r = host(audioPath);
    // host 返回 { url, cleanup } 或字符串 URL
    if (typeof r === 'string') return { url: r, cleanup: null };
    return r && r.url ? r : { url: '', cleanup: null };
  }
  throw new Error('Paraformer 需要可公网访问的音频 URL：请配置阿里云 OSS（推荐，设置 ALIYUN_OSS_BUCKET/ENDPOINT/ACCESS_KEY_ID/SECRET）或设置 PUBLIC_BASE 指向你的公网地址（如 https://xiaoyuange.serveo.net）');
}

async function dashscopeTranscription(fileUrl, apiKey, model) {
  if (!apiKey) throw new Error('缺少 STT Key（阿里云百炼）。请在 social-fetch 环境设置 DASHSCOPE_API_KEY，或请求体传入 sttKey');
  // 注意：录音文件识别的正确路径含 /asr/，写成 audio/transcription 会报 "task can not be null"
  const base = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
  const createBody = JSON.stringify({
    model: model || 'paraformer-v2',
    input: { file_urls: [fileUrl] },
    parameters: { language_hints: ['zh'] },
  });
  // 1) 创建异步任务
  const createResp = await dashscopeRequest(base, 'POST', {
    'Authorization': 'Bearer ' + apiKey,
    'Content-Type': 'application/json',
    'X-DashScope-Async': 'enable',
  }, createBody);
  let taskId = null;
  try {
    const j = JSON.parse(createResp);
    taskId = j.output && j.output.task_id;
  } catch (e) { /* ignore */ }
  if (!taskId) throw new Error('Paraformer 创建任务失败：' + createResp.slice(0, 300));

  // 2) 轮询任务状态
  const start = Date.now();
  while (Date.now() - start < 150000) {
    await sleep(3000);
    const poll = await dashscopeRequest('https://dashscope.aliyuncs.com/api/v1/tasks/' + taskId, 'GET', {
      'Authorization': 'Bearer ' + apiKey,
    });
    let pj; try { pj = JSON.parse(poll); } catch (e) { continue; }
    const status = pj.output && pj.output.task_status;
    if (status === 'SUCCEEDED') {
      const results = (pj.output && pj.output.results) || [];
      const transUrl = results[0] && results[0].transcription_url;
      if (!transUrl) throw new Error('Paraformer 成功但无转录结果 URL');
      const txtResp = await dashscopeRequest(transUrl, 'GET', {});
      let tj; try { tj = JSON.parse(txtResp); } catch (e) { return txtResp; }
      const transcripts = tj.transcripts || [];
      const text = transcripts.map(t => (typeof t === 'string' ? t : (t.text || ''))).join('').trim();
      return text;
    }
    if (status === 'FAILED') {
      throw new Error('Paraformer 任务失败：' + ((pj.output && (pj.output.message || pj.output.code)) || '未知错误'));
    }
  }
  throw new Error('Paraformer 转写超时（>150s）');
}

/* ---------------- 阿里云 Paraformer 实时语音（WebSocket 直推音频流）----------------
 * 用途：当未配置 OSS 时，用实时语音接口把音频流直接推给阿里云，
 *       完全不经过 serveo 等公网隧道（隧道转发二进制给阿里云不稳），
 *       因此无需任何额外账号即可稳定转写。
 * 协议（官方真实可用）：wss://dashscope.aliyuncs.com/api-ws/v1/inference/
 *   - 握手阶段在请求头带 Authorization: Bearer <API Key>
 *   - run-task / finish-task 用「文本帧」发 JSON（header.action + payload）
 *   - 音频用「二进制帧」发裸 PCM（16kHz/16bit/单声道，无额外头字节）
 *   - 收到 task-started 后才能发音频；result-generated 累积文本；task-finished 结束
 */
const WebSocket = require('ws');
const crypto = require('crypto');

async function dashscopeRealtimeTranscription(audioPath, apiKey, model) {
  if (!apiKey) throw new Error('缺少 STT Key（阿里云百炼）。请设置 DASHSCOPE_API_KEY');
  const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
  const { execFileSync } = require('child_process');
  const pcmPath = path.join(os.tmpdir(), `sf_rt_${Date.now().toString(36)}.pcm`);
  try {
    execFileSync(ffmpeg, ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-f', 's16le', '-c:a', 'pcm_s16le', pcmPath], { stdio: 'ignore' });
    const pcm = fs.readFileSync(pcmPath);
    if (!pcm.length) throw new Error('音频转 PCM 为空（可能原音频无音轨）');
    const wsUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/';
    const text = await streamTranscribe(wsUrl, apiKey, pcm, model || 'paraformer-realtime-v2');
    return text;
  } finally {
    try { fs.unlinkSync(pcmPath); } catch (e) {}
  }
}

function streamTranscribe(wsUrl, apiKey, pcm, model) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { 'Authorization': 'Bearer ' + apiKey } });
    let settled = false;
    const completed = [];
    let currentText = '';
    let audioStarted = false;
    const taskId = crypto.randomUUID();
    const finish = (ok, val) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) {}
      if (ok) resolve(val); else reject(new Error(val));
    };
    ws.on('error', (e) => finish(false, 'WebSocket 错误: ' + (e && e.message)));
    ws.on('open', () => {
      // run-task 用文本帧发送（模型写在 payload，不写在 URL）
      ws.send(JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio', task: 'asr', function: 'recognition',
          model: model,
          parameters: { format: 'pcm', sample_rate: 16000 },
          input: {},
        },
      }));
    });
    const CHUNK = 3200; // 16k*16bit*单声道 → 每 100ms 3200 字节
    let off = 0;
    const sendAudio = () => {
      if (settled) return;
      if (off >= pcm.length) {
        // 音频发完 → finish-task（文本帧）
        ws.send(JSON.stringify({
          header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
          payload: { task_group: 'audio', task: 'asr', function: 'recognition', model: model, input: {} },
        }));
        return;
      }
      const slice = pcm.slice(off, off + CHUNK);
      off += CHUNK;
      try { ws.send(slice); } // 音频帧：裸 PCM 二进制，无额外头
      catch (e) { return finish(false, '音频发送失败: ' + (e && e.message)); }
      setTimeout(sendAudio, 100);
    };
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      const h = msg.header || {};
      const ev = h.event;
      const payload = msg.payload || {};
      if (ev === 'task-started') {
        if (!audioStarted) { audioStarted = true; sendAudio(); }
      } else if (ev === 'result-generated') {
        // 实时接口每段返回「截至当前的累计文本」(transcription.text)，段间会重置为空/变短
        const out = payload.output || {};
        const tr = out.transcription || out.sentence;
        if (tr) {
          const txt = tr.text || '';
          if (txt === '') {
            if (currentText) { completed.push(currentText); currentText = ''; }
          } else if (currentText && txt.length < currentText.length) {
            // 累计文本回退（新段开始）→ 定稿上一段，开启新段
            completed.push(currentText);
            currentText = txt;
          } else {
            currentText = txt;
          }
        }
      } else if (ev === 'task-finished') {
        let finalText = completed.join('');
        if (currentText) finalText += currentText;
        finish(true, finalText.trim());
      } else if (ev === 'task-failed') {
        const em = (payload && (payload.output && (payload.output.text || payload.output.error_message))) ||
          h.error_message || '未知错误';
        finish(false, 'Paraformer 实时任务失败: ' + em);
      }
    });
    // 超时：音频时长 + 余量，避免长视频被提前中断
    const estMs = Math.max(150000, Math.ceil(pcm.length / 32000 * 1000) + 60000);
    setTimeout(() => finish(false, 'Paraformer 实时转写超时（>' + Math.round(estMs / 1000) + 's）'), estMs);
  });
}

/* ---------------- 平台视频直链解析 ---------------- */
async function resolveBilibili(url) {
  const m = url.match(/BV[0-9A-Za-z]+/) || url.match(/av(\d+)/i);
  if (!m) throw new Error('无法从链接解析 B站 BV/av 号');
  const id = m[0];
  const isBv = id.toUpperCase().startsWith('BV');
  const BILI_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
  };

  // 第 1 步：view 接口拿 cid + 标题（此接口不含播放地址）
  const viewApi = isBv
    ? `https://api.bilibili.com/x/web-interface/view?bvid=${id}`
    : `https://api.bilibili.com/x/web-interface/view?aid=${id.slice(2)}`;
  const viewRes = await httpGet(viewApi, BILI_HEADERS);
  const view = viewRes.json();
  if (!view || view.code !== 0) throw new Error('B站 view 接口返回 ' + (view && view.message));
  const cid = view.data && view.data.cid;
  const title = ((view.data && view.data.title) || '').slice(0, 200);
  if (!cid) throw new Error('B站未返回 cid（视频可能已下架或为付费内容）');

  // 第 2 步：playurl 接口拿真正的播放地址。fnval=16 才会返回 dash（含独立音频流）
  const pu = isBv
    ? `https://api.bilibili.com/x/player/playurl?bvid=${id}&cid=${cid}&fnval=16&fnver=0&fourk=1`
    : `https://api.bilibili.com/x/player/playurl?avid=${id.slice(2)}&cid=${cid}&fnval=16&fnver=0&fourk=1`;
  const puRes = await httpGet(pu, BILI_HEADERS);
  const pj = puRes.json();
  if (!pj || pj.code !== 0) throw new Error('B站 playurl 接口返回 ' + (pj && pj.message));
  const d = pj.data || {};
  const pick = (o) => o && (o.baseUrl || o.base_url || o.url); // 兼容驼峰/下划线

  let playUrl = null;
  const audios = (d.dash && d.dash.audio) || [];
  if (audios.length) {
    // 转写只要人声，挑码率最低的音频流即可，省下载时间与带宽
    const sorted = audios.slice().sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
    playUrl = pick(sorted[0]);
  }
  if (!playUrl && d.dash && d.dash.video && d.dash.video[0]) playUrl = pick(d.dash.video[0]);
  if (!playUrl && d.durl && d.durl[0]) playUrl = pick(d.durl[0]);
  if (!playUrl) throw new Error('B站未返回可播放地址');

  // B站 CDN 必须带 bilibili.com 作为 Referer，否则 403
  return { playUrl, title, referer: 'https://www.bilibili.com/' };
}

async function resolveDouyin(url, cookie) {
  // 1) 短链重定向 → 真实视频页（v.douyin.com/xxx → douyin.com/video/<aweme_id>）
  let realUrl = url;
  if (/v\.douyin\.com/i.test(url)) {
    realUrl = await followRedirect(url);
  }
  const idm = realUrl.match(/video\/(\d+)/) || url.match(/aweme_id=(\d+)/);
  if (!idm) throw new Error('无法从链接解析抖音视频 aweme_id');
  const awemeId = idm[1];
  // 2) 浏览器内签名 + 调 aweme/detail
  const base = `aid=6383&aweme_id=${awemeId}&device_platform=web&version_name=999&cookie_enabled=true`;
  const requestFn = await getDouyinBrowserRequest();
  const out = await requestFn({ base, cookie: cookie || '', aBogus: '' });
  if (out.error) throw new Error('抖音签名/请求失败：' + out.error);
  if (out.status !== 200) throw new Error('抖音接口返回 ' + out.status);
  const data = typeof out.text === 'string' ? JSON.parse(out.text) : out.text;
  const aweme = data && (data.aweme_detail || (data.aweme_list && data.aweme_list[0]));
  if (!aweme) throw new Error('抖音未返回视频详情');
  const play = aweme.video && (aweme.video.play_addr || aweme.video.download_addr);
  const playUrl = play && (play.url_list && play.url_list[0]);
  if (!playUrl) throw new Error('抖音未返回视频播放地址（可能需登录 cookie）');
  return { playUrl, title: (aweme.desc || '').slice(0, 200), referer: 'https://www.douyin.com/' };
}

async function resolveXhs(url, cookie) {
  // xhslink.com 短链 → 真实笔记页
  let realUrl = url;
  if (/xhslink\.com/i.test(url)) realUrl = await followRedirect(url);
  const idm = realUrl.match(/explore\/([0-9A-Za-z]+)/) || realUrl.match(/discovery\/item\/([0-9A-Za-z]+)/);
  if (!idm) throw new Error('无法从链接解析小红书 note_id');
  const noteId = idm[1];
  const query = `source=detail&note_id=${noteId}&image_formats=jpg&extra=`;
  const ts = genXt();
  const xs = genXs(query, '', ts);
  const api = `https://edith.xiaohongshu.com/api/sns/web/v1/feed`;
  const res = await request(api, {
    method: 'POST',
    headers: {
      'User-Agent': XHS_UA,
      'Referer': 'https://www.xiaohongshu.com/',
      'Content-Type': 'application/json',
      'x-s': xs, 'x-t': ts,
      cookie: cookie || '',
    },
    body: JSON.stringify({ source: 'detail', note_id: noteId, image_formats: ['jpg'] }),
  });
  const data = res.json();
  const items = (data && data.data && data.data.items) || (data && data.data && data.data.notes) || [];
  if (!items.length) throw new Error('小红书未返回笔记详情（需登录 cookie 或签名失效）');
  const card = items[0].note_card || items[0];
  const video = card.video || {};
  const playUrl = (video.media && video.media.stream && video.media.stream[0] && video.media.stream[0].master_url) || null;
  if (!playUrl) throw new Error('小红书该笔记不是视频或为图片笔记');
  return { playUrl, title: (card.title || card.display_title || '').slice(0, 200), referer: 'https://www.xiaohongshu.com/' };
}

/* 跟随单次重定向，返回最终 URL（httpHelper 不自动跟随） */
async function followRedirect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'HEAD',
      headers: { 'User-Agent': UA },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(new URL(res.headers.location, url).href);
      } else {
        resolve(url);
      }
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('重定向跟随超时')));
    req.end();
  });
}

/* ---------------- 编排：视频链接 → 转写文本 ----------------
 * @param {object} body 请求体
 * @param {function} [host] 自托管音频 URL 注入函数（index.js 提供），返回 {url, cleanup} 或字符串
 */
async function transcribePipeline(body, host) {
  const platform = body.platform;
  const url = (body.url || '').trim();
  if (!url) throw new Error('缺少视频链接 url');
  if (!['douyin', 'xiaohongshu', 'bilibili'].includes(platform)) {
    throw new Error('platform 必须是 douyin / xiaohongshu / bilibili');
  }

  const provider = (body.sttProvider || process.env.STT_PROVIDER || 'aliyun').toLowerCase();
  const sttKey = body.sttKey ||
    (provider === 'aliyun' ? process.env.DASHSCOPE_API_KEY : process.env.OPENAI_API_KEY) || '';
  const model = process.env.DASHSCOPE_MODEL || 'paraformer-v2';

  const tmpDir = os.tmpdir();
  const safeId = Date.now().toString(36);
  const videoPath = path.join(tmpDir, `sf_v_${safeId}.mp4`);
  const audioPath = path.join(tmpDir, `sf_a_${safeId}.mp3`);
  let au = null;

  let resolved;
  if (platform === 'bilibili') resolved = await resolveBilibili(url);
  else if (platform === 'douyin') resolved = await resolveDouyin(url, body.cookie);
  else resolved = await resolveXhs(url, body.cookie);

  try {
    await downloadBinary(resolved.playUrl, videoPath, 180000, resolved.referer || '');
    await ffmpegExtract(videoPath, audioPath);
    let text;
    if (provider === 'aliyun') {
      const hasOss = process.env.ALIYUN_OSS_BUCKET && process.env.ALIYUN_OSS_ENDPOINT &&
        process.env.ALIYUN_ACCESS_KEY_ID && process.env.ALIYUN_ACCESS_KEY_SECRET;
      if (hasOss) {
        // 配了 OSS：文件识别 API（URL 模式），最稳，三平台通用
        au = await getAudioPublicUrl(audioPath, host);
        text = await dashscopeTranscription(au.url, sttKey, model);
      } else {
        // 未配 OSS：实时语音 WebSocket 直推音频流，不经过 serveo 隧道，默认即可稳定转写
        text = await dashscopeRealtimeTranscription(audioPath, sttKey, process.env.DASHSCOPE_REALTIME_MODEL || 'paraformer-realtime-v2');
      }
    } else {
      text = await whisperTranscribe(audioPath, sttKey);
    }
    return { ok: true, text: text || '', title: resolved.title, platform, durationSec: null };
  } finally {
    [videoPath, audioPath].forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
    if (au && au.cleanup) { try { au.cleanup(); } catch (e) {} }
  }
}

/* ---------------- 异步任务：POST 秒回 taskId，前端轮询 /transcribe/result/:id ---------------- */
const transcribeTasks = new Map();
const TRANSCRIBE_TASK_TTL = 10 * 60 * 1000; // 任务结果保留 10 分钟

/**
 * 派发一个转写任务，立即返回 taskId（不阻塞 HTTP 响应）。
 * 后台跑完整管线（解析→下载→ffmpeg→暴露音频→STT），结果存入 transcribeTasks。
 * 同步校验参数，便于前端立即发现错误（缺 url / 非法 platform）。
 */
function startTranscribeTask(body, host) {
  const platform = body.platform;
  const url = (body.url || '').trim();
  if (!url) throw new Error('缺少视频链接 url');
  if (!['douyin', 'xiaohongshu', 'bilibili'].includes(platform)) {
    throw new Error('platform 必须是 douyin / xiaohongshu / bilibili');
  }
  const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const task = {
    id: taskId, status: 'running', createdAt: Date.now(),
    text: '', title: '', platform, error: '',
  };
  transcribeTasks.set(taskId, task);
  // 后台执行，不阻塞响应
  transcribePipeline(body, host)
    .then(r => {
      task.status = 'done';
      task.text = r.text || '';
      task.title = r.title || '';
      task.platform = r.platform || platform;
    })
    .catch(e => {
      task.status = 'failed';
      task.error = String((e && e.message) || e);
    })
    .finally(() => {
      setTimeout(() => transcribeTasks.delete(taskId), TRANSCRIBE_TASK_TTL);
    });
  return taskId;
}

function getTranscribeTask(id) {
  return transcribeTasks.get(id) || null;
}

module.exports = { transcribePipeline, startTranscribeTask, getTranscribeTask, dashscopeRealtimeTranscription, resolveBilibili, downloadBinary, ffmpegExtract };
