# 域名迁移:ie.intofuture.org + 旧 Telelab 域名 301 跳转

> 目标:把本项目的对外主域名切成 `ie.intofuture.org`,并让已停用的旧 Telelab
> 域名(`telelab.intofuture.org`、`telelab2.intofuture.org`)上的所有链接——
> 包括每一条旧实验链接——自动 301 跳转到新站的对应页面。
>
> 执行时间:2026-07-14。代码改动见 commit `2c9d3c7`
> (`feat(hosting): serve app at ie.intofuture.org, 301 legacy telelab domains`)。

## 0. 背景与关键事实

| 项 | 事实 |
|---|------|
| 旧 Telelab 托管 | **不在 Firebase 上**。`telelab2.intofuture.org` 指向自建 GKE nginx ingress(A 记录 `34.72.75.153`,GCP 项目 `rising-field-305700`);`telelab.intofuture.org` 指向 Vercel(`cname.vercel-dns.com`)。DNS 在 Squarespace(`intofuture.org`)管理。 |
| 旧实验 URL 形态 | 路径路由:`/experiment/:id`(showcase,32 位 MD5)、`/clip/:id`(用户实验,24 位 Mongo ObjectId)。**不是** `/exp...`。 |
| 新实验 URL 形态 | 哈希路由:`/#/experiments/:id`(`createHashRouter`)。 |
| **实验 ID 是否保留** | **保留**。数据迁移时 `experiments/{id}` 的文档 ID 直接沿用旧的 MD5 / ObjectId(已用线上 Firestore REST API 实测确认)。因此旧 ID → 新 ID 无需任何对照表。 |

因为旧站从不在 Firebase 上,不存在"继承旧 Hosting 站点"这回事——迁移 = 把旧域名的
DNS 改指到 Firebase Hosting,由 Firebase 发 301 + 新站前端补一层路径→哈希路由转换。

## 1. 架构:两个 Hosting 站点(同一 Firebase 项目 `infrared-explorer`)

| 站点 (target) | Site ID | 作用 | 绑定域名 |
|---|---|---|---|
| `app` | `infrared-explorer` | 正式 SPA | `ie.intofuture.org`(以及既有的 `infrared-explorer.intofuture.org`、默认 `*.web.app`) |
| `telelab-redirect` | `telelab-redirect` | 纯跳转站 | `telelab.intofuture.org`、`telelab2.intofuture.org` |

跳转站 `firebase.json` 里只有一条 301 规则,保留路径转发到新站;真正把
`/experiment/:id`、`/clip/:id` 转成 `/#/experiments/:id` 的逻辑在新站
`index.html` 的启动前内联脚本里完成(两步式,避免依赖 301 目标里写 `#` 锚点这种未验证行为)。

### 跳转链路(用户点旧 https 链接时)

```
https://telelab2.intofuture.org/experiment/<id>
  └─(telelab-redirect 站点 301,保留路径)→ https://ie.intofuture.org/experiment/<id>
        └─(新站 index.html 启动脚本)→ https://ie.intofuture.org/#/experiments/<id>
              └─ ExperimentAnalyzer 加载对应实验(ID 已保留,直接命中)
```

## 2. 代码改动(commit `2c9d3c7`)

- **`firebase.json`** — `hosting` 由单对象改为数组,拆成 `app` + `telelab-redirect`
  两个 target;跳转站 `redirects`:`/` 与 `/:path*` 全部 301 到 `https://ie.intofuture.org`。
- **`.firebaserc`** — 增加 `targets.infrared-explorer.hosting` 映射(`app`→`infrared-explorer`,
  `telelab-redirect`→`telelab-redirect`)。
- **`redirect/index.html`** — 跳转站的兜底页(正常情况下 301 规则先命中,用户看不到);
  内含同款 JS 兜底,防止规则未覆盖时也能转走。
- **`index.html`** — 启动前内联脚本:把旧路径路由改写到哈希路由。映射:
  `/experiment/:id`、`/clip/:id` → `/#/experiments/:id`;`/clipList`→`/#/myExperimentsList`、
  `/recentExperiments`→`/#/recent`、`/raw`、`/trash`、`/about`、`/contact`、`/account`→`/#/settings`。
- **`package.json`** — `homepage` → `https://ie.intofuture.org`。

## 3. Firebase 侧一次性操作(已执行,非代码)

1. `firebase hosting:sites:create telelab-redirect`。
2. 部署:`firebase deploy --only hosting:telelab-redirect`,再 `npm run deploy:all`
   (functions + firestore/storage 规则 + 两个 hosting 站点)。
3. 通过 Hosting v1beta1 `customDomains` API 注册 3 个自定义域名:
   `ie`→`app` 站点,`telelab`/`telelab2`→`telelab-redirect` 站点(均走 CNAME 流程)。
4. Authentication → Authorized domains 增加 `ie.intofuture.org`(否则新域名上 Google 登录失败)。

### 部署中踩到的两个坑(已解决)

- **缺 `ANTHROPIC_API_KEY` secret**:代码 `defineSecret('ANTHROPIC_API_KEY')` 但 Secret
  Manager 里没有,导致 functions 部署中断。UI 实际不提供 Claude 模型,故设**占位值**解锁部署;
  以后要启用 Claude,`firebase functions:secrets:set ANTHROPIC_API_KEY` 换真 key 再重部署 functions。
- **运行时服务账号无该 secret 读权限**:手动给
  `482530289615-compute@developer.gserviceaccount.com` 授
  `roles/secretmanager.secretAccessor`,重部署 `generateLabReport` / `answerExperimentQuestion` / `agentChat` 通过。

## 4. DNS(Squarespace,intofuture.org)最终记录

| 主机名 | 类型 | 值 | 说明 |
|---|---|---|---|
| `ie` | CNAME | `infrared-explorer.web.app` | 新主站 |
| `telelab` | CNAME | `telelab-redirect.web.app` | 原 `cname.vercel-dns.com`,已改;并从 Vercel 项目移除该域名 |
| `telelab2` | CNAME | `telelab-redirect.web.app` | 原 A `34.72.75.153`,已删;两条旧 `google-site-verification` TXT 一并删除(CNAME 不能与其它记录共存) |

> 提示:`infrared-explorer.intofuture.org` 早已绑定在 `app` 站点(HOST_ACTIVE),与 `ie` 并存,可保留或日后在 Console 移除。

## 5. 验证状态(截至 2026-07-14 执行当日)

- `ie.intofuture.org` — HTTPS 200,证书已签发,完全上线。
- `telelab2.intofuture.org` — HOST_ACTIVE + 所有权确认,证书签发中;签发完成后 https 旧链接即完整跳转。
- `telelab.intofuture.org` — DNS 已切,Firebase 轮询/签证书跟进中。
- 跳转逻辑本身:在 `telelab-redirect.web.app` 上已用 `/experiment/<id>`、`/clip/<id>`、
  `/clipList`、`/` 实测 301 正确;新站 `index.html` shim 也已实测在线。

> 证书签发期间直接访问旧 https 域名会短暂出现 `ERR_CERT_COMMON_NAME_INVALID`(叠加旧服务器遗留的 HSTS),属正常现象,证书装好后自动消失,无需操作。

## 6. 收尾清单(待办)

- [ ] 确认三个域名证书全部 `ACTIVE`、旧 https 实验链接能完整跳转。
- [ ] **下线旧设施前**先跑 `node scripts/gapCheckFrames.mjs` 确认帧数据 backfill 无缺口
      —— `backfillFrames.mjs` 依赖旧服务器 `https://telelab2.intofuture.org/public/episodes/...`,
      GKE 集群一关就拉不到(showcase 视频在 `intofuture.org` 主站 videostore,不受影响)。
- [ ] 删 GKE `cluster-1`(项目 `rising-field-305700`)停止计费。
- [ ] 暂停 / 导出后注销 MongoDB Atlas(`cluster-telelab`)。
