# 个人主页第二期实施计划：身份一致性、真实统计、社交预览

> 状态：已规划、待实施。基于第一期实现（个人主页 `/#/users/:userId` + 三档可见性 Private/Link only/Public + `featured` 首页解耦；截至撰写时在工作区待提交，基于 commit `68a4678`）。
>
> 产品决定：**批量修改可见性不做**（单卡 ⋮ 菜单已够用）；关注/粉丝等社交图谱不在范围内。
>
> 本文档自包含，可在新会话中直接作为实施依据。文中引用的函数/文件已与代码核对；精确行号以实施时为准（第一期改动尚未提交，行号会漂移）。

## 0. 范围一览（按建议顺序）

| 里程碑 | 内容 | 工作量估计 | 依赖 |
|---|---|---|---|
| M0 | 手机端上传弹窗文案 Unlisted → Link only（app 仓库） | 几分钟 | 无 |
| M1 | 身份一致性治理（昵称 / 头像 / author 字符串） | ~1 天 | 无 |
| M2 | 真实统计（浏览计数复活 + 主页评论数 callable） | ~1 天 | 无 |
| M3 | 社交分享预览（BrowserRouter 迁移 + OG meta 注入） | ~2–3 天 + 观察期 | 独立，**决策点** |

M1 与 M2 互不依赖，可并行或任选先后；M3 改动面最大，放最后，且做不做本身是一个产品决策（见 §3.4）。

---

## 1. M1 — 身份一致性治理

### 1.1 现状问题（已核实）

同一个用户的名字目前存在三处、可能三个值：

1. **`onUserSignIn` 首登覆盖迁移昵称**（functions/src/index.ts `onUserSignIn`）：迁移用户第一次 Google 登录时（claim 尚未铸造），函数走 email 复用分支后**无条件**执行 `usersPublic.set({ displayName, avatar }, { merge: true })`，其中值来自 **Google token**（`auth.token.name/picture`）——把 Atlas 迁移来的昵称覆盖掉；而私有 `users/{id}.displayName` 保留 Atlas 值，两处从此分叉。
2. **头像永不刷新**：`onUserSignIn` 在 claim 已存在时 early-return，`usersPublic.avatar` 只在首登写一次；Google 头像 URL 会轮换失效，头像会永久变死链。
3. **`experiments.author` 是冻结的显示字符串**：创建/克隆时快照一次，改名不跟随；手机端上传甚至可能写入设备本地用户名（app 仓库 `VideosScreen.tsx`：`currentCloudUser()?.displayName ?? username`）。卡片、相关列表上显示的就是这个陈旧值。
4. **评论 `senderName` 冻结且客户端无法修**：规则限定评论 update 只能动 `content`（firestore.rules 的 comments 块），改名后旧评论名字永远是旧的。注意头像已经是活的——`CommentAvatar`（commentList.tsx）忽略冻结的 `senderAvatar`，实时读 `usersPublic`。
5. **History 快照缺 `ownerId`**（services/experiments.ts `recordHistory`）：History 页的卡片作者名无法变成主页链接（第一期只给首页/回收站等有 ownerId 的网格加了链接）。

### 1.2 方案

- **B1 `onUserSignIn` 修复**（functions）：
  - email 复用分支（已有 `users` 文档）：镜像 `usersPublic` 时 displayName 取 `users/{id}.displayName ?? Google name`，且**仅当 `usersPublic` 文档不存在或缺 displayName 时才写**——已有的自定义昵称永不覆盖。
  - 把 avatar 刷新移出 early-return：每次调用（即每个新会话首次 `onUserSignIn`）读 `usersPublic.avatar`，与 token 的 `picture` 不同才写。注意 web 端只在 claim 缺失时才调这个 callable（services/auth.ts `resolveMongoId` 的快路径直接返回），所以**还需要**客户端兜底：auth 监听器里 `getPublicProfile` 后发现 `avatar !== fbUser.photoURL` 时 `setDoc(usersPublic, { avatar }, { merge: true })`（规则第一期已允许 owner 写 avatar，≤2048 字符）。
- **B2 改名扇出**（web）：`updateUserProfile`（services/account.ts）保存 displayName 时，查 `ownerId == me && trash == false` 的实验（复用 My Experiments 的查询），批量 `update({ author })`。规则允许：`author` 不在冻结键列表里。批量用 `writeBatch`（≤500/批，用户实验数远小于此）。回收站里的实验故意不管（恢复时也不影响正确性，只是显示旧名——可接受）。
- **B3 评论名字活读**（web）：把 `CommentAvatar` 的 usersPublic 读取扩展为同时取 `displayName`，评论行名字显示 `live ?? senderName`。每个不同评论者的 getDoc 本来就在发（为头像），零新增读取。`senderName` 降级为 fallback，不改写规则。
- **B4 History 链接**（web）：`recordHistory` 快照加 `ownerId` 字段；Recent 页把 `ownerId` 传进 `GridItem`，作者名自动获得链接（第一期已把链接逻辑做进 `ExperimentGrid`/`Card`）。旧快照没有 ownerId → 不显示链接，随再次观看自然更新，无需回填。
- **B5 一次性回填脚本**（scripts/backfillAuthors.mjs，Admin SDK）：对每个非 system 实验，`author` 归一化为 owner 当前的 `usersPublic.displayName`（usersPublic 缺失则跳过并列出）。幂等，可重跑。**先跑 B1 修复再跑回填**，否则会把 Google 覆盖过的名字扇出去。

### 1.3 验证

- 模拟器：改名 → My Experiments / 首页卡片 hover 的 `by <name>` 即时更新（B2）；旧评论显示新名字（B3）；History 卡片作者可点击（B4，需先看一次实验刷新快照）。
- 迁移用户首登不再覆盖昵称：模拟器里先 seed 一个带自定义昵称的 users+usersPublic，再走登录流程核对（B1）。

---

## 2. M2 — 真实统计

### 2.1 现状（已核实）

- `viewCount` 到处显示（卡片、分析器 "N views"），被规则冻结在保护键列表里，但**全代码库没有任何写入者**——现值全是 Atlas 迁移遗留，新实验永远 0。
- 访客无法统计别人的评论数：collection-group comments 规则只授权 `senderId == 我` 或 staff。公开聚合的既有先例是 `getSiteStats` callable（无需登录，Admin SDK `count()`，实例内缓存 5 分钟）。
- 第一期主页统计（公开实验数、平均评分）由客户端从已取的 public 文档求和，无需服务端。

### 2.2 方案

- **A1 `recordView` callable（浏览计数复活）**：
  - 无需登录（匿名访客的浏览也要计数）。入参 `expId`。
  - 服务端校验：实验存在、`visibility in ['public','unlisted']`（私有实验不计数，owner 自看也跳过——带 auth 且 `mongoId == ownerId` 时 no-op）。
  - 限流：per-(ipHash, expId) 1 次/小时，复用 `submitContactMessage` 的 sha256(ip) 滚动窗口模式，集合 `viewRateLimits`。给限流文档写 `expireAt` 并配置 Firestore TTL policy，避免无限积累（contactRateLimits 目前就有积累问题，顺手不重蹈）。
  - 通过 Admin SDK `FieldValue.increment(1)` 写 `viewCount`（规则冻结对 Admin SDK 无效）。
  - 客户端：analyzer 实验加载成功后 fire-and-forget 调用（与 `recordHistory` 同时机）；`VITE_FUNCTIONS_ENABLED` 为 false 时静默跳过（沿用 services/auth.ts 的 `functionsEnabled` 门控模式）。
- **A2 `getPublicProfileStats` callable**：入参 `userId`，返回 `{ commentsAuthored }`（`collectionGroup('comments').where('senderId','==',uid).count()`，已有 COLLECTION_GROUP 字段覆盖索引）。实例内缓存 5 分钟、按 userId 键控（getSiteStats 模式）。**只做评论数**——总浏览量和评分主页客户端从已取文档求和即可（A1 上线后浏览量自动变真实）。
- **主页统计行扩展**（userProfile.tsx）：`N public experiments · X total views · Y ★ avg rating · Z comments`，comments 来自 A2（加载失败静默省略，页面不因统计挂掉）。

### 2.3 验证

- 模拟器匿名访问 public 实验 → `viewCount` +1；一小时内重复访问不再加；owner 自看不加。
- 主页统计行四项齐全；断开 functions 模拟器后页面仍正常渲染（统计降级）。

---

## 3. M3 — 社交分享预览（决策点）

### 3.1 前提事实（已核实）

- **hash 路由是根本障碍**：URL fragment 不随 HTTP 请求发送，爬虫抓 `https://…/#/users/x` 时服务器只看到 `/`——不迁移路由，任何服务端 meta 方案都无从谈起。
- hosting 是纯 SPA rewrite（firebase.json：`** → /index.html`）+ COOP `same-origin-allow-popups` header（**Google 登录弹窗依赖，不能动**）。
- hash URL 的组装/读取点共 4 处：[shareLinks.tsx:37](../src/pages/experimentAnalyzer/infoSection/shareLinks.tsx)（`HOME_URL + '#' + pathname`）、[ownedExperimentGrid.tsx:75](../src/components/card/ownedExperimentGrid.tsx)（Open in new tab）、[userProfile.tsx:252](../src/pages/userProfile.tsx)（Copy link）、[agentTools.ts:56](../src/components/aiChat/agentTools.ts)（读 `location.hash` 报告当前路由给 AI）。

### 3.2 C1 — BrowserRouter 迁移

- `createHashRouter` → `createBrowserRouter`（App.tsx）；上述 4 处改为 pathname 直拼 / `location.pathname`。
- **旧链接永久兼容 shim**：App 启动时若 `location.hash` 以 `#/` 开头，`navigate(hash.slice(1), { replace: true })`。历史分享链接全是 hash 形式，shim 必须永久保留。
- hosting 的 `**` rewrite 已满足 BrowserRouter 刷新需求，无需改；vite dev server 默认支持 history fallback。

### 3.3 C2 — meta 注入函数

- hosting rewrites 加两条：`/experiments/**` 和 `/users/**` → 函数 `renderMeta`（放在 `**` 兜底 rewrite 之前）。
- 函数：读 Firestore 对应文档（不存在/私有 → 返回原始 index.html），把 `og:title / og:description / og:image / twitter:card` 注入构建产物 index.html 的 `<head>` 后返回。人和爬虫拿到同一份 HTML，SPA 照常启动，无需 UA 判断。
- `og:image`：缩略图用 firebasestorage 公共下载 URL（`…/o/<urlencoded path>?alt=media`，storage 规则本就 public read）。
- index.html 模板获取：函数内 fetch `https://<site>/index.html`（静态文件命中优先于 rewrite，不会递归），实例内缓存。
- 响应头带 `Cache-Control: public, max-age=300, s-maxage=600` 缓解函数冷启动；**同时补上 COOP header**（函数响应不走 hosting headers 配置）。

### 3.4 决策点：做不做？

代价：一次全站路由形态切换（回归面：所有导航、分享、AI 导航工具）+ `/experiments/**` 首字节经函数（冷启动秒级，CDN 缓存缓解）+ shim 永久维护。收益：分享到社交平台/群聊时出标题+缩略图卡片。

**建议**：如果平台的分享场景以课堂内发链接为主，此项可无限期搁置；如果对外传播（教师社群、社交平台）是增长渠道，则值得做。做的话 C1 先独立发布、稳定一两周后再上 C2。

---

## 4. 部署与顺序备忘

- M1：先部署 functions（B1）→ 部署 web（B2/B3/B4）→ 跑 `backfillAuthors.mjs`（B5）。
- M2：functions（A1/A2 + TTL policy）→ web。规则无需改动。
- M3：C1（web only，观察期）→ C2（functions + firebase.json rewrites/headers）。
- 每期照例：`npm run build` + 两端 tsc + 模拟器规则加载冒烟（`npx firebase emulators:exec --only firestore "echo ok"`，本机需先 `export PATH="/c/Program Files/Microsoft/jdk-21.0.11.10-hotspot/bin:$PATH"`）。

## 5. 明确不做

- 批量修改可见性（产品决定，第一期已砍）。
- 关注/粉丝、动态流等社交图谱。
- 评论内容对非当事人的枚举开放（规则维持 un-enumerable，统计只出计数）。