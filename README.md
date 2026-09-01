# social-fetch-vercel — 社交平台作品代理（部署到 Vercel）

抖音 / 小红书作品数据代理。部署到 Vercel 后获得公网 URL，网页工作台「社交平台」模块调用它，
由服务端生成 `a_bogus` / `x-s` 签名并拉取作品，绕过平台反爬（浏览器端无法直接算签名）。

> 为什么不用 CloudBase 云函数？—— 微信云开发个人版环境**不支持云函数公网 HTTP 触发**
> （控制台仅 timer、公网访问开关灰色、SCF API 创建 http 触发报 InvalidParameter）。
> Vercel 的 Node 运行时原生支持 fetch + vm，能跑抖音 acrawler 签名。

---

## 前置条件
- **GitHub 账号**：新建一个仓库放代码
- **Vercel 账号**：用 GitHub 登录 https://vercel.com （免费 Hobby 版够用）

## 部署步骤（傻瓜版）
1. GitHub 新建空仓库，名 `social-fetch-vercel`
2. 把本目录 7 个文件推上去（或网页拖拽上传）：
   - `api/social-fetch.js`
   - `core.js`
   - `signers.js`
   - `httpHelper.js`
   - `package.json`
   - `vercel.json`
   - `README.md`（本文件）
3. 打开 https://vercel.com/new → Import 刚才的 GitHub 仓库
4. Framework Preset 选 **Other**，Root Directory 留空（默认），点 **Deploy**
5. 几十秒后部署完成，得到项目域名，例如 `https://social-fetch-vercel.vercel.app`
   - 代理入口完整地址：`https://social-fetch-vercel.vercel.app/api/social-fetch`

## 网页工作台配置
1. 打开网页工作台 → 右上角「设置」→ **社交平台云函数地址**
2. 填入：`https://<你的项目>.vercel.app/api/social-fetch`
3. 保存
4. 社交平台 → 抖音 / 小红书详情页 → 粘贴博主主页链接 →（可选）填**测试账号** Cookie → 点「自动获取」

> 前端改动（新增 Cookie 输入框 + 发送 cookie）已写入 `workbench/js/modules/media.js`，
> 需**重新发布网页工作台**后线上才会生效（本地直接打开 index.html 即可测）。

## 请求 / 响应格式
```
POST https://<project>.vercel.app/api/social-fetch
Content-Type: application/json

{ "platform": "douyin" | "xiaohongshu", "url": "博主主页链接", "cookie": "可选登录cookie" }
```
响应：
```json
{ "ok": true, "platform": "douyin", "account": {...}, "works": [ {workId,title,publishTime,play,like,...} ] }
{ "ok": false, "error": "...", "hint": "..." }
```

## 签名与实测说明
- **抖音 a_bogus**：运行时拉取抖音官方 `acrawler` 脚本，在带浏览器 shim 的 vm 中执行其 `sign`
  方法生成（用官方代码本身，抗版本变动能力最强）。首次调用会拉抖音首页+脚本，耗时几秒属正常。
- **小红书 x-s**：参考实现（固定盐 md5 占位）。若返回 401，说明需替换为维护中的 xhs signer
  （只改 `signers.js` 的 `genXs` 即可，`core.js` 抓取/归一化逻辑不动）。
- 提供**测试账号**的 Cookie 能显著提高拉取成功率（匿名请求常被风控拦截）。
- Cookie 仅本次请求发送，前端不持久化保存。

## 本地调试
```bash
npm i -g vercel
vercel dev
# 本地入口： http://localhost:3000/api/social-fetch
```
