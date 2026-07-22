# 路由迁移:HashRouter → BrowserRouter(去掉 URL 里的 `#`)

> 目标:把对外 URL 从哈希路由 `/#/experiments/:id` 切换成干净的路径路由
> `/experiments/:id`,同时让所有历史链接(旧 hash 链接、旧 Telelab 路径链接)
> 永久无感兼容。这是 `docs/profile-phase2-plan.md` 里 **M3 → C1** 一步。
>
> 执行时间:2026-07-22。已上线 `https://ie.intofuture.org`。
> 代码改动在分支 `dev` 工作树(撰写时未提交,commit 待补)。

## 0. 为什么迁移

哈希路由的 `#` 后半段不随 HTTP 请求发送,爬虫抓 `/#/experiments/x` 时服务器只看到 `/`,
所以任何服务端 meta 注入(社交分享预览卡片)都无从谈起——这是 C2(OG meta 注入)的**硬前置**。
迁移后 URL 变干净、可被索引,C2 的前置条件全部就绪。

代价只有「必须有服务器 fallback」,而 hosting 的 `** → /index.html` rewrite 和 vite dev server 的
history fallback 本就满足,所以迁移的实际成本几乎为零。

## 1. URL 形态:前 → 后

| 页面 | 迁移前(hash) | 迁移后(path) |
|---|---|---|
| 实验分析页 | `/#/experiments/:id` | `/experiments/:id` |
| 用户主页 | `/#/users/:id` | `/users/:id` |
| 实验分享链接 | `/experiment/:id`(旧 Telelab 路径别名) | `/experiments/:id` |
| 其他页面 | `/#/community`、`/#/me` … | `/community`、`/me` … |

## 2. 改了哪些文件

| 文件 | 改动 |
|---|---|
| `src/App.tsx` | `createHashRouter` → `createBrowserRouter`。**路由表本身零改动**——全站 `navigate()` 本来就用路径形式。 |
| `index.html` | 启动 shim **方向反转**(见 §3),现在把旧 hash 链接和旧 Telelab 路径归一化成真实路径。 |
| `src/utils/urls.ts` | 三个 share helper 去掉 `#`:`experimentShareUrl` 从 `/experiment/:id` 改成 `/experiments/:id`;`profileShareUrl`、`routeShareUrl` 去掉 `/#`。 |
| `src/components/aiChat/agentTools.ts` | 读当前路由从解析 `location.hash` 改为直接读 `location.pathname`(`currentPath()`)。 |
| `src/components/card/ownedExperimentGrid.tsx`、`src/pages/userProfile.tsx` | 「Open in new tab」的 `window.open` URL 去掉 `/#`。 |
| `functions/src/index.ts` | Lab Assistant 系统提示词的实验链接格式从 `#/experiments/<id>` 改成 `/experiments/<id>`。 |
| `src/components/aiChat/AiChatWidget.tsx` | 仅注释更新;点击拦截的正则本就同时匹配新旧两种 href。 |
| `docs/domain-migration.md` | 现状表「新实验 URL 形态」一行更新。 |

## 3. 关键机制:index.html 里的**永久**归一化 shim

一段 classic inline `<script>`,在 deferred 的模块脚本(即 React/路由)加载**之前**运行,
用 `history.replaceState` **无刷新**地把旧链接改写成真实路径,再让路由在正确的 URL 上启动:

- **旧 hash 链接** `/#/...`:`#` 后半段本就是路由路径(含 query),直接 `replaceState(location.hash.slice(1))`。
  这类改写**只能在客户端做**(服务器根本收不到 `#` 后的内容)。
- **旧 Telelab 路径** `/experiment/:id`、`/clip/:id`:实验 doc ID 在数据迁移时沿用,直接映射到 `/experiments/:id`。
- **旧路径别名** `/clipList`→`/myExperimentsList`、`/recentExperiments`→`/recent`、`/account`→`/settings`。
  (原 shim 里 `/raw` `/about` `/trash` `/contact` 等映射已删除——它们与新路由**同名**,天然直达。)

**这段 shim 必须永久保留**:历史分享出去的链接(邮件、群聊、收藏夹)无法批量改写,shim 是它们唯一的兼容层。

## 4. 旧链接兼容矩阵(上线后实测)

| 旧链接形态 | 结果 |
|---|---|
| `/#/experiments/x`、`/#/users/x`(旧 hash 分享链接) | shim 改写为 `/experiments/x` / `/users/x`,无刷新直达 |
| `/experiment/:id`、`/clip/:id`(旧 Telelab 链接) | SPA 接管(HTTP 200)→ shim 改写为 `/experiments/:id` |
| `telelab.intofuture.org/*`(旧域名) | `telelab-redirect` 站点仍 301 到 `ie.intofuture.org`,未受影响 |
| 老 AI 会话里的 `#/experiments/x` markdown 链接 | 点击拦截正则兼容,照常在 app 内打开 |

**唯一救不回来的**:旧 hash 链接对爬虫仍不可解析,所以将来 C2 的社交预览只对**新形态** URL 生效。

## 5. 部署顺序(重要)

`npm run deploy:all` 是**先 functions 后 hosting**,会开一个窗口让旧客户端收到新格式的 AI 链接
(中键/新标签打开会落到首页)。**必须反过来部署**:

```bash
npm run deploy            # 1. 先 hosting(新客户端 + shim 上线)
npm run deploy:functions  # 2. 再 functions(新 AI 提示词)
```

> 已知坑:`deploy:functions` 首次常在源码发现阶段 10 秒超时。加环境变量重跑:
> `FUNCTIONS_DISCOVERY_TIMEOUT=60 firebase deploy --only functions`。
> (详见 memory `firebase-emulator-startup-windows`。)

本次(2026-07-22)即按此顺序部署,两端全绿。

## 6. 上线验证(7 项全过)

深链接 `/experiments/:id`、`/users/:id`、`/community` 均 HTTP 200 由 SPA 提供;
线上 index.html 含归一化 shim;`/assets/*.js` 为绝对路径且可达;COOP header
(`same-origin-allow-popups`,Google 登录弹窗依赖)仍覆盖深路径;旧 Telelab 路径 200;
`telelab-redirect` 仍 301。

11-agent 对抗性审查(5 视角 + 每条发现 3 人投票)未发现代码缺陷,唯一确认项即 §5 的部署顺序。

## 7. 遗留

- **C2(OG meta 注入)** 未做:`hosting.rewrites` 加 `/experiments/**`、`/users/**` → 函数 `renderMeta`
  (放在 `**` 兜底之前),函数读 Firestore 注入 `og:*` / `twitter:*` 后返回 index.html,响应记得补 COOP header。
  详见 `docs/profile-phase2-plan.md` §3.3。
- 若哪天想加真正的服务端预渲染/SSR,路径已对服务器可见,不必再迁一次。
