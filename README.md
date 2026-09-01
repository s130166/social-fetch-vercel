# social-fetch — 社交平台作品数据代理

抖音 / 小红书博主作品自动抓取（含 a_bogus / x-s 签名），部署到 **Zeabur**（国内可达）供网页工作台调用。

## 部署到 Zeabel（3 步）

### 1. GitHub 仓库
代码已推送到 `https://github.com/s130166/social-fetch-vercel`

### 2. Zeabur 导入
1. 打开 https://zeabur.com 登录（GitHub 账号）
2. 点 **Create Project** → **Deploy Service** → **Git**
3. 选 `s130166/social-fetch-vercel` 仓库 → **Deploy**

### 3. 拿到地址
部署成功后，Zeabur 会给你一个公网域名，类似：
```
https://social-fetch.zeabur.app
```

## 使用

### 网页工作台设置
打开网页版小源哥工作台 → **设置** → 「社交平台云函数地址」填：
```
https://social-fetch.zeabur.app
```
保存即可。

### API 接口
```
POST /
Content-Type: application/json

Body:
{
  "platform": "douyin" | "xiaohongshu",
  "url": "博主主页链接",
  "cookie": "可选的已登录 Cookie"
}

Response (成功):
{
  "ok": true,
  "platform": "douyin",
  "account": { "follower": 242000, "totalPlay": ... },
  "works": [
    { "workId": "...", "title": "...", "play": 160000, "like": 38000, ... }
  ]
}

Response (失败):
{ "ok": false, "error": "错误原因", "hint": "建议" }
```

## 文件结构
```
├── index.js       # HTTP 服务入口（监听 PORT 环境变量）
├── core.js        # 抖音/小红书抓取 + 归一化逻辑
├── signers.js     # a_bogus（acrawler+vm）/ x-s（占位）签名
├── httpHelper.js  # Node 内置 https 模块封装
└── package.json   # {"start": "node index.js"}
```
