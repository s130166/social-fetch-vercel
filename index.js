/**
 * social-fetch — HTTP 服务入口（Zeabur / Railway / 任何 Node 托管）
 * 监听 PORT 环境变量（Zeabur/Railway 自动设置）
 *
 * POST /fetch
 * Body: { platform: 'douyin'|'xiaohongshu', url: '...', cookie?: '...', a_bogus?: '...' }
 * Response: { ok, platform?, account?, works?[], error?, hint? }
 *
 * POST /html
 * Body: { url: 'https://www.douyin.com/' }
 * Response: { ok, html: '...' }
 */
const http = require('http');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { handleFetch } = require('./core');
const { transcribePipeline, startTranscribeTask, getTranscribeTask } = require('./transcribe');
const { redfoxSubmit, redfoxResult, biliSubtitle } = require('./subtitle');
const { httpGet } = require('./httpHelper');

const PORT = process.env.PORT || 3000;

/* 固定子域名（密钥已注册 → 地址永久不变；改这里换别名） */
const TUNNEL_SUBDOMAIN = 'xiaoyuange';

/* ---------- serveo 隧道自管理（断了自动重连，暴露 /tunnel 取当前公网地址）---------- */
let _tunnelUrl = '';
let _tunnelProc = null;
let _tunnelStarting = false;

/* 探测 ~/.ssh/id_ed25519 的实际可用路径（兼容 Git Bash /c/ 与 Windows C:\ 两种写法） */
function findSshKeyPath() {
  const candidates = [];
  // 优先：项目目录里的本地副本（沙箱里也能读）
  candidates.push(path.join(__dirname, 'id_ed25519'));
  // 硬编码兜底
  candidates.push('C:/Users/Administrator/.ssh/id_ed25519');
  if (process.env.HOME) candidates.push(process.env.HOME.replace(/\\/g, '/') + '/.ssh/id_ed25519');
  try {
    const oh = os.homedir();
    const m = oh.match(/^([A-Za-z]):[\\/](.*)$/);
    if (m) candidates.push('/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/') + '/.ssh/id_ed25519');
    candidates.push(path.join(oh, '.ssh', 'id_ed25519'));
  } catch (e) {}
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return candidates[0];
}

function spawnTunnel() {
  if (process.env.NO_TUNNEL) { console.log('[tunnel] 已禁用（NO_TUNNEL）'); return; }
  if (_tunnelStarting || _tunnelProc) return;
  _tunnelStarting = true;
  const keyPath = findSshKeyPath();
  const remoteSpec = TUNNEL_SUBDOMAIN + ':80:localhost:' + PORT;
  console.log('[tunnel] 启动 serveo 固定隧道 (' + remoteSpec + ') key=' + keyPath + ' exists=' + fs.existsSync(keyPath));
  // 强制把 -i keyPath 传给 ssh（不依赖 existsSync 探测结果）让已注册密钥完成认证
  const sshArgs = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=60',
    '-o', 'ServerAliveCountMax=3',
    '-i', keyPath,
    '-R', remoteSpec,
    'serveo.net',
  ];
  const child = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const grab = d => { buf += d.toString(); const m = buf.match(/https:\/\/[a-z0-9-]+\.serveousercontent\.com/); if (m && m[0] !== _tunnelUrl) { _tunnelUrl = m[0]; console.log('[tunnel] 公网地址:', _tunnelUrl); } };
  child.stdout.on('data', grab);
  child.stderr.on('data', grab);
  child.on('exit', code => { console.log('[tunnel] 隧道断开(code=' + code + ')，3s 后重连'); _tunnelProc = null; _tunnelStarting = false; setTimeout(spawnTunnel, 3000); });
  _tunnelProc = child;
  _tunnelStarting = false;
}

function tunnelState() {
  return { ok: true, url: _tunnelUrl, alive: !!_tunnelProc && _tunnelProc.exitCode === null };
}

/* ---------- 音频自托管（供阿里云 Paraformer 拉取本地抽好的 mp3）---------- */
/* Paraformer 文件识别只接受「公网可达的音频 URL」，不接受字节直传。
   本机 serveo 隧道场景下，把抽好的音频挂到 /audio/<id>，用隧道公网地址拼出 URL。 */
const audioFiles = new Map(); // id -> 本地文件路径

function makeAudioHost() {
  // 优先用显式 PUBLIC_BASE，其次用 serveo 隧道实际地址
  const base = (process.env.PUBLIC_BASE || '').replace(/\/$/, '') || (_tunnelUrl || '').replace(/\/$/, '');
  return (localPath) => {
    if (!base) {
      throw new Error('Paraformer 自托管需要公网地址：请设置 PUBLIC_BASE（如 https://xiaoyuange.serveo.net），或在 social-fetch 环境配置阿里云 OSS（ALIYUN_OSS_*）');
    }
    const id = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    audioFiles.set(id, localPath);
    return { url: base + '/audio/' + id, cleanup: () => audioFiles.delete(id) };
  };
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 压缩 JSON 响应（gzip），解决 serveo 免费版截断大响应的问题 */
function jsonGzip(res, code, data) {
  const body = JSON.stringify(data);
  // 只对大于 1KB 的响应压缩
  if (Buffer.byteLength(body) < 1024) { return json(res, code, data); }
  zlib.gzip(Buffer.from(body), (err, compressed) => {
    if (err) { return json(res, code, data); }
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Length': compressed.length,
    });
    res.end(compressed);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') { return json(res, 204, ''); }

  // 路由：/fetch = 数据抓取，/html = 代理获取页面 HTML，/sign-page = 签名页(支持GET/POST)
  const path = (req.url || '').split('?')[0];
  const urlObj = new URL(req.url || '/', 'http://localhost:' + PORT);

  if (path === '/sign-page') {
    // 签名页：返回完整抖音页面（同源），用于在浏览器中执行 byted_acrawler.sign()
    // 支持 GET（浏览器直接打开）和 POST（fetch 调用）
    let targetUrl = 'https://www.douyin.com/';
    if (req.method === 'POST') {
      let raw = '';
      await new Promise(resolve => req.on('data', c => raw += c).on('end', resolve));
      try { const b = JSON.parse(raw || '{}'); if (b.url) targetUrl = b.url; }
      catch (e) { /* use default */ }
    } else {
      // GET: 从 query 参数取 url
      targetUrl = urlObj.searchParams.get('url') || targetUrl;
    }
    try {
      const res2 = await httpGet(targetUrl, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
      let html = res2.text;

      // 关键：移除 window.location.reload() 防止无限循环重载
      // acrawler 脚本末尾会调用 reload() 做反爬检测，在代理页面中会导致死循环
      html = html.replace(/window\.location\.reload\(\)/g, '/* reload blocked by proxy */');
      html = html.replace(/location\.reload\(\)/g, '/* reload blocked by proxy */');

      // 注入桥接脚本：监听 postMessage → 浏览器内签名 → 通过代理转发API请求 → 回传结果
      // 签名在用户浏览器中完成(用用户IP)，API请求由代理转发但携带浏览器cookie
      const bridgeScript = `
<script>
(function(){
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'douyin-sign-request') return;
    var qs = e.data.queryString || '';
    // 优先用调用方传入的登录 cookie（跨域页面 document.cookie 读不到 douyin.com 的 cookie）
    var callerCookie = e.data.cookie || '';
    var bogus = null;
    var err = null;
    try {
      if (typeof window.byted_acrawler !== 'undefined' && typeof window.byted_acrawler.sign === 'function') {
        var r = window.byted_acrawler.sign(qs, '/aweme/v1/web/aweme/post/');
        bogus = (typeof r === 'string') ? r : (r && (r.a_bogus || r.XBogus)) || null;
        if (!bogus) { err = 'sign returned null'; }
        else {
          // 签名成功：通过代理转发API请求（同源，无CORS问题）
          // 同时把当前页面的cookie也传过去，帮助绕过部分限制
          var apiUrl = location.origin + '/fetch';
          fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                platform: 'douyin',
                url: 'https://www.douyin.com/user/' + qs.match(/sec_user_id=([^&]+)/)[1],
                a_bogus: bogus,
                cookie: callerCookie || document.cookie
              }),
          })
          .then(function(resp) { return resp.json(); })
          .then(function(data) {
            window.opener.postMessage({ type: 'douyin-sign-result', bogus: bogus, error: null, data: data }, '*');
          })
          .catch(function(fe) {
            window.opener.postMessage({ type: 'douyin-sign-result', bogus: bogus, error: 'proxy_err:' + fe.message }, '*');
          });
          return;
        }
      } else {
        err = 'byted_acrawler not found';
      }
    } catch(ex) { err = ex.message; }
    window.opener.postMessage({ type: 'douyin-sign-result', bogus: null, error: err }, '*');
  });
})();
</script>`;
      // 在 </body> 前注入桥接脚本
      html = html.replace(/<\/body>/i, bridgeScript + '\n</body>');
      // 如果没有 </body>，追加到末尾
      if (!html.includes(bridgeScript)) html += bridgeScript;

      // 不压缩——浏览器直接渲染 HTML
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body>Error: ' + (e && e.message || e) + '</body></html>');
    }
    return;
  }

  // GET / —— 本地状态页：始终可达（无需隧道），显示当前公网地址 + 复制按钮，免去手动记地址
  // 仅 GET：POST / 应当作为 /fetch 的别名（兜底，避免客户端把请求发到根路径）
  if ((path === '/' || path === '/status') && req.method === 'GET') {
    const st = tunnelState();
    const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>社交抓取代理 · 状态</title>
<style>body{font-family:-apple-system,'PingFang SC',sans-serif;background:#0f1419;color:#e6e6e6;padding:32px;max-width:640px;margin:auto}
h1{font-size:18px;color:#2fd6bd}.card{background:#16202b;border:1px solid #243240;border-radius:12px;padding:18px;margin-top:16px}
.url{font-family:monospace;font-size:15px;color:#ffd479;word-break:break-all;background:#0d161e;padding:10px;border-radius:8px;margin:8px 0}
button{background:#2fd6bd;color:#062;border:none;padding:10px 16px;border-radius:8px;font-size:14px;cursor:pointer}
.hint{color:#7d8a96;font-size:13px;line-height:1.7;margin-top:10px}
code{background:#0d161e;padding:2px 6px;border-radius:4px;color:#ffd479}</style></head>
<body>
<h1>社交抓取代理 · 运行状态</h1>
<div class="card">
<div>当前公网地址（每次重连可能变化）：</div>
<div class="url" id="u">${st.url || '隧道启动中…'}</div>
<button onclick="copy()">复制地址</button>
<div class="hint">把上面地址填到工作台「设置 → 社交云函数地址」。<br>
若显示「隧道启动中…」，稍等几秒刷新本页。<br>
本地访问本页永远可达，无需经过隧道。</div>
</div>
<div class="card">
<div class="hint">① 打开 <code>cookie-helper.html</code> 把书签拖入书签栏<br>
② 登录 douyin.com → 点书签复制 cookie → 粘贴到工作台「抖音登录 Cookie」<br>
③ 工作台社交模块录入抖音 → 贴链接 → 自动获取</div>
</div>
<script>
function copy(){var t=document.getElementById('u').textContent;navigator.clipboard.writeText(t).then(()=>alert('已复制：'+t));}
setTimeout(()=>{location.reload()},8000);
</script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(html);
    return;
  }

  // GET /tunnel —— 返回当前 serveo 公网地址（前端可据此自动同步，免去手动改地址）
  if (path === '/tunnel') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(tunnelState()));
    return;
  }

  // GET /audio/<id> —— 供阿里云 Paraformer 服务端拉取本地抽好的音频（自托管模式）
  if (path.startsWith('/audio/') && req.method === 'GET') {
    const id = path.slice('/audio/'.length).split('?')[0];
    const fp = audioFiles.get(id);
    if (!fp || !fs.existsSync(fp)) {
      return json(res, 404, { ok: false, error: '音频不存在或已过期' });
    }
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': fs.statSync(fp).size,
    });
    fs.createReadStream(fp).pipe(res);
    return;
  }

  // GET /transcribe/result/:id —— 异步任务轮询（短请求，避免 serveo 长连接超时）
  if (path.startsWith('/transcribe/result/') && req.method === 'GET') {
    const id = path.slice('/transcribe/result/'.length).split('?')[0];
    const t = getTranscribeTask(id);
    if (!t) return json(res, 404, { ok: false, error: '任务不存在或已过期' });
    return json(res, 200, {
      ok: true,
      status: t.status,
      text: t.text,
      title: t.title,
      platform: t.platform,
      error: t.error,
    });
  }

  // 以下路由仅支持 POST
  if (req.method !== 'POST') { return json(res, 405, { ok: false, error: '仅支持 POST' }); }

  let raw = '';
  await new Promise(resolve => req.on('data', c => raw += c).on('end', resolve));
  let body;
  try { body = JSON.parse(raw || '{}'); }
  catch (e) { body = {}; }

  if (path === '/html') {
    // 代理获取页面并提取 acrawler 内联脚本（避免返回 73KB 完整页面被 serveo 截断）
    try {
      const targetUrl = body.url || '';
      if (!targetUrl) return json(res, 400, { ok: false, error: '缺少 url 参数' });
      const res2 = await httpGet(targetUrl, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
      const html = res2.text;

      // 提取包含 byted_acrawler 的内联 <script>...</script> 内容
      const scriptRegex = /<script[^>]*>([\s\S]*?byted_acrawler[\s\S]*?)<\/script>/gi;
      let best = '', bestLen = 0;
      let m;
      while ((m = scriptRegex.exec(html)) !== null) {
        if (m[1].length > bestLen) { best = m[1]; bestLen = m[1].length; }
      }

      // 备选：找外链 acrawler JS 地址
      const srcMatch = html.match(/src="(https:\/\/[^"]*acrawler[^"]*\.js)"/);

      if (best || srcMatch) {
        jsonGzip(res, 200, { ok: true, script: best || '', src: srcMatch ? srcMatch[1] : '' });
      } else {
        // 都没找到，返回精简版 HTML（去掉无用部分，控制在 10KB 以内）
        // 保留 <head> 中的脚本和 RENDER_DATA
        const headMatch = html.match(/<head>([\s\S]*?)<\/head>/i);
        const renderMatch = html.match(/<script id="RENDER_DATA"[^>]*>([\s\S]*?)<\/script>/i);
        jsonGzip(res, 200, {
          ok: true,
          script: '',
          src: '',
          head: headMatch ? headMatch[1].slice(0, 10000) : '',
          renderData: renderMatch ? renderMatch[1] : '',
          htmlLen: html.length
        });
      }
    } catch (e) {
      json(res, 200, { ok: false, error: '获取页面失败：' + (e && e.message || e) });
    }
    return;
  }

  if (path === '/transcribe') {
    try {
      const taskId = startTranscribeTask(body, makeAudioHost());
      console.log('[transcribe] 已派发任务 taskId=' + taskId + ' platform=' + body.platform + ' url=' + (body.url || '').slice(0, 50));
      json(res, 200, { ok: true, taskId });
    } catch (e) {
      console.log('[transcribe] 派发失败: ' + String((e && e.message) || e));
      json(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
    return;
  }

  /* ---------- 字幕直取（红狐抖音 + B站官方 CC，详见 subtitle.js）---------- */
  if (path === '/subtitle/redfox/submit') {
    try {
      const r = await redfoxSubmit(body);
      console.log('[subtitle] redfox/submit url=' + (body.url || '').slice(0, 60) + ' -> ok=' + r.ok + (r.error ? ' err=' + r.error.slice(0, 120) : ' taskId=' + r.taskId));
      json(res, 200, r);
    } catch (e) {
      json(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
    return;
  }
  if (path === '/subtitle/redfox/result') {
    try {
      json(res, 200, await redfoxResult(body));
    } catch (e) {
      json(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
    return;
  }
  if (path === '/subtitle/bilibili') {
    try {
      const r = await biliSubtitle(body);
      console.log('[subtitle] bilibili url=' + (body.url || '').slice(0, 60) + ' -> ok=' + r.ok + (r.error ? ' err=' + r.error.slice(0, 120) : ' sents=' + (r.sents || []).length));
      json(res, 200, r);
    } catch (e) {
      json(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
    return;
  }

  try {
    const result = await handleFetch(body);
    console.log('[fetch] platform=' + body.platform + ' url=' + (body.url || '').slice(0, 60) + ' cookie_len=' + (body.cookie || '').length + ' a_bogus=' + (body.a_bogus ? 'yes(' + body.a_bogus.length + ')' : 'no') + ' -> ok=' + result.ok + (result.error ? ' err=' + result.error.slice(0, 200) : ''));
    json(res, 200, result);
  } catch (e) {
    console.log('[fetch] CRASH: ' + String((e && e.message) || e));
    json(res, 200, { ok: false, error: String((e && e.message) || e) });
  }
  return;
});

server.listen(PORT, () => {
  console.log(`social-fetch running on :${PORT}`);
  spawnTunnel();
});
