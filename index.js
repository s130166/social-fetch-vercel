/**
 * social-fetch — HTTP 服务入口（Zeabur / Railway / 任何 Node 托管）
 * 监听 PORT 环境变量（Zeabur/Railway 自动设置）
 *
 * POST /
 * Body: { platform: 'douyin'|'xiaohongshu', url: '...', cookie?: '...' }
 * Response: { ok, platform?, account?, works?[], error?, hint? }
 */
const http = require('http');
const { handleFetch } = require('./core');

const PORT = process.env.PORT || 3000;

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

const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') { return json(res, 204, ''); }
  if (req.method !== 'POST') { return json(res, 405, { ok: false, error: '仅支持 POST' }); }

  let raw = '';
  await new Promise(resolve => req.on('data', c => raw += c).on('end', resolve));

  let body;
  try { body = JSON.parse(raw || '{}'); }
  catch (e) { body = {}; }

  try {
    const result = await handleFetch(body);
    json(res, 200, result);
  } catch (e) {
    json(res, 200, { ok: false, error: String((e && e.message) || e) });
  }
});

server.listen(PORT, () => console.log(`social-fetch running on :${PORT}`));
