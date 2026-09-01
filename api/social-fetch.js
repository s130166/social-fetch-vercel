/**
 * Vercel Node Serverless Function — social-fetch 代理入口
 * 部署后访问： https://<your-project>.vercel.app/api/social-fetch
 *
 * 接收前端 POST： { platform: 'douyin' | 'xiaohongshu', url: '博主主页', cookie?: '可选登录cookie' }
 * 返回： { ok:true, platform, account:{...}, works:[...] } 或 { ok:false, error, hint }
 *
 * 与网页工作台 SocialWorkItem 对齐的归一化作品结构：
 *   { workId, title, publishTime, tags:[], isHot, interactRate, play, like, comment, collect, repost }
 */
const { handleFetch } = require('../core');

module.exports = async (req, res) => {
  // CORS（前端 workbench 是独立静态站，需跨域）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: '仅支持 POST' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
  } else if (!body) {
    body = {};
  }

  try {
    const result = await handleFetch(body);
    res.status(200).json(result);
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
};
