/**
 * core.js — social-fetch 核心抓取/归一化逻辑（与部署平台无关）
 * 被 Vercel handler (api/social-fetch.js) 复用。
 *
 * 归一化作品结构（与网页工作台 SocialWorkItem 对齐）：
 *   { workId, title, publishTime, tags:[], isHot, interactRate, play, like, comment, collect, repost }
 */
const { genABogus, genXs, genXt, UA, XHS_UA } = require('./signers');
const { httpGet } = require('./httpHelper');

/* ----------------------------- 工具 ----------------------------- */
function toInt(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}
function fmtTime(unixSec) {
  if (!unixSec) return '';
  const d = new Date(unixSec * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ----------------------------- 抖音 ----------------------------- */
function extractDouyinSecUid(html) {
  let m = html.match(/"sec_uid"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  m = html.match(/sec_uid=([^&\s"']+)/);
  if (m) return decodeURIComponent(m[1]);
  return null;
}
function extractDouyinUidFromUrl(url) {
  let m = url.match(/douyin\.com\/user\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  m = url.match(/douyin\.com\/@([A-Za-z0-9_.-]+)/);
  if (m) return '@' + m[1];
  return url.trim();
}

async function fetchDouyin(input) {
  const id = extractDouyinUidFromUrl(input.url || '');
  let secUid = (id.startsWith('MS4w') || id.startsWith('MS')) ? id : null;
  if (!secUid) {
    const pageUrl = id.startsWith('@')
      ? `https://www.douyin.com/${id}`
      : `https://www.douyin.com/user/${id}`;
    const htmlRes = await httpGet(pageUrl, { 'User-Agent': UA, cookie: input.cookie || '' });
    secUid = extractDouyinSecUid(htmlRes.text);
  }
  if (!secUid) throw new Error('无法解析抖音博主 sec_uid（主页结构可能变化，或链接无效）');

  const base = `aid=6383&sec_user_id=${encodeURIComponent(secUid)}&count=20&max_cursor=0`;
  const aBogus = await genABogus(base);
  const api = `https://www.douyin.com/aweme/v1/web/aweme/post/?${base}&a_bogus=${encodeURIComponent(aBogus)}`;
  const res = await httpGet(api, {
    'User-Agent': UA, Referer: 'https://www.douyin.com/', cookie: input.cookie || '',
  });
  if (res.status !== 200) throw new Error(`抖音接口返回 ${res.status}（可能需登录 cookie 或签名失效）`);
  const data = res.json();
  const list = (data && data.aweme_list) || [];
  if (!list.length) throw new Error('抖音返回作品列表为空（账号可能无公开作品，或需登录态）');

  const works = list.map((a, i) => {
    const s = a.statistics || {};
    const play = toInt(s.play_count);
    const like = toInt(s.digg_count);
    const comment = toInt(s.comment_count);
    const collect = toInt(s.collect_count);
    const repost = toInt(s.share_count);
    const total = play + like + comment + collect + repost || 1;
    return {
      workId: a.aweme_id || String(i),
      title: (a.desc || '').slice(0, 200),
      publishTime: a.create_time ? fmtTime(toInt(a.create_time)) : '',
      tags: (a.text_extra || []).map(t => t.hashtag_name).filter(Boolean),
      isHot: toInt(s.play_count) > 1000000,
      interactRate: +((like / total) * 100).toFixed(2),
      play, like, comment, collect, repost,
    };
  });

  const author = list[0] && list[0].author ? list[0].author : {};
  const account = {
    follower: toInt(author.follower_count),
    totalPlay: works.reduce((s, w) => s + w.play, 0),
    totalLike: toInt(author.total_favorited),
    totalCollect: works.reduce((s, w) => s + w.collect, 0),
    totalComment: works.reduce((s, w) => s + w.comment, 0),
    totalRepost: works.reduce((s, w) => s + w.repost, 0),
    accountName: author.nickname || '',
    secUid,
  };
  return { account, works };
}

/* ----------------------------- 小红书 ----------------------------- */
function extractXhsUserId(url) {
  let m = url.match(/xiaohongshu\.com\/user\/profile\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  m = url.match(/xhslink\.com\/[A-Za-z0-9]+\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  return url.trim();
}

async function fetchXhs(input) {
  const userId = extractXhsUserId(input.url || '');
  if (!userId || userId.length < 6) throw new Error('无法解析小红书博主 user_id（链接格式应为 xiaohongshu.com/user/profile/xxx）');

  const query = `num=20&cursor=&user_id=${encodeURIComponent(userId)}`;
  const ts = genXt();
  const xs = genXs(query, '', ts);
  const api = `https://edith.xiaohongshu.com/api/sns/web/v1/user_posted?${query}`;
  const res = await httpGet(api, {
    'User-Agent': XHS_UA,
    'Referer': 'https://www.xiaohongshu.com/',
    'x-s': xs,
    'x-t': ts,
    cookie: input.cookie || '',
  });
  if (res.status !== 200) throw new Error(`小红书接口返回 ${res.status}（x-s 签名可能失效，或需登录 cookie）`);
  const data = res.json();
  const notes = (data && data.data && data.data.notes) || (data && data.data && data.data.items) || [];
  if (!notes.length) throw new Error('小红书返回笔记列表为空（需登录态或签名失效）');

  const works = notes.map((n, i) => {
    const info = n.interact_info || (n.note_card && n.note_card.interact_info) || {};
    const play = toInt(info.play_count);
    const like = toInt(info.liked_count);
    const comment = toInt(info.comment_count);
    const collect = toInt(info.collected_count);
    const repost = toInt(info.share_count);
    const total = play + like + comment + collect + repost || 1;
    const card = n.note_card || n;
    return {
      workId: n.id || card.id || String(i),
      title: (card.title || card.display_title || '').slice(0, 200),
      publishTime: n.time ? fmtTime(toInt(n.time) / 1000) : (card.time ? fmtTime(toInt(card.time) / 1000) : ''),
      tags: (card.tag_list || []).map(t => t.name).filter(Boolean),
      isHot: toInt(info.liked_count) > 10000,
      interactRate: +((like / total) * 100).toFixed(2),
      play, like, comment, collect, repost,
    };
  });

  const account = {
    follower: 0,
    totalPlay: works.reduce((s, w) => s + w.play, 0),
    totalLike: works.reduce((s, w) => s + w.like, 0),
    totalCollect: works.reduce((s, w) => s + w.collect, 0),
    totalComment: works.reduce((s, w) => s + w.comment, 0),
    totalRepost: works.reduce((s, w) => s + w.repost, 0),
    accountName: '',
    userId,
  };
  return { account, works };
}

/* ----------------------------- 入口 ----------------------------- */
async function handleFetch(body) {
  const platform = body && body.platform;
  if (platform !== 'douyin' && platform !== 'xiaohongshu') {
    return { ok: false, error: 'platform 必须是 douyin 或 xiaohongshu' };
  }
  if (!body.url) return { ok: false, error: '缺少博主主页链接 url' };
  try {
    const result = platform === 'douyin' ? await fetchDouyin(body) : await fetchXhs(body);
    return { ok: true, platform, ...result };
  } catch (e) {
    return {
      ok: false,
      error: e.message || String(e),
      hint: '请确认链接有效、平台未改版；必要时在请求中附上已登录的 cookie（测试账号）。',
    };
  }
}

module.exports = { handleFetch, fetchDouyin, fetchXhs };
