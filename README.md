# Infrared Explorer Web

红外热成像实验的探索与分析平台。前端为 React + Vite,后端为 Firebase
(Firestore / Storage / Auth / Cloud Functions),托管在 `infrared-explorer` 项目。

本文档说明**克隆项目后如何在本地跑起来**。绝大多数情况你只需要看
[1. 快速开始](#1-快速开始只跑前端) 这一节。只有当你要改 `functions/` 里的
后端代码时,才需要往下看 [3. 开发云函数](#3-开发云函数functions-模拟器)。

---

## 环境要求

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | **22.x** | 云函数运行时锁定 Node 22,前端也用它以保持一致 |
| npm | 随 Node 附带 | 也可用 yarn(仓库同时有 `yarn.lock`) |
| Firebase CLI | 最新 | `npm i -g firebase-tools`,用于模拟器与部署 |
| Google Cloud CLI | 最新 | **仅**在跑 Functions 模拟器时需要([见第 3 节](#3-开发云函数functions-模拟器)) |

首次使用 Firebase CLI 需登录一次:`firebase login`。

---

## 1. 快速开始(只跑前端)

这是最常见的场景:改页面、改前端逻辑。此时**直接连线上生产环境**的
Firebase(Auth / Firestore / Storage / 已部署的云函数),你只需要一份前端配置文件。

```bash
git clone <repo-url>
cd infrared-explorer-web
npm install

# 复制前端环境变量模板(里面的 Firebase 配置是公开值,可直接用)
cp .env.example .env          # macOS / Linux / Git Bash
# Copy-Item .env.example .env # Windows PowerShell

npm start                     # 起 Vite 开发服务器(自动打开 http://localhost:3002)
```

打开后在浏览器里用 Google 账号正常登录即可。**这一步不需要 gcloud、不需要任何
密钥**——`.env` 里的 `VITE_FIREBASE_*` 是随打包公开发布的 Web 配置,不是机密。

> ⚠️ 注意:此模式下你操作的是**线上真实数据库**。开发时请勿对生产数据做破坏性操作。

---

## 2. 环境文件一览

仓库出于安全考虑把所有本地配置文件都 gitignore 了,所以**克隆后仓库里不会自带**
这些文件,需要你按下表自行创建。带 `.example` 后缀的是可安全提交的模板。

| 文件 | 是否机密 | 何时需要 | 怎么获取 |
|---|---|---|---|
| `.env` | 否(公开配置) | 跑前端(必需) | `cp .env.example .env` |
| `.env.local` | 否 | 想让前端调**本地**函数模拟器时 | 见 [第 3 节](#3-开发云函数functions-模拟器) |
| `functions/.secret.local` | **是** | 跑 Functions 模拟器时 | 复制 `.secret.local.example`,向管理员索取真实值 |
| `functions/.env` | 否 | 跑 Functions 模拟器时 | 已在仓库中(非机密参数);如缺失见管理员 |
| `serviceAccount.json` | **是(私钥)** | 跑 `scripts/` 里的管理脚本时 | 向管理员索取,**绝不可提交** |

---

## 3. 开发云函数(Functions 模拟器)

### 这是干什么的
`functions/` 目录里是跑在 Google 服务器上的**后端代码**(约 20 个函数),例如:

- `generateLabReport` / `answerExperimentQuestion` / `agentChat` —— 调用 Claude / DeepSeek 生成报告、Q&A、Lab Assistant(API Key 藏在后端,不能进前端)
- `submitContactMessage` / `onContactMessageCreated` —— 收「联系我们」表单并发邮件
- `onExperimentDeleted` / `aggregateRatings` / `notifyOnComment` —— 特权写入 / 数据库触发器

**Functions 模拟器**就是把这些函数在你自己电脑上跑一份(`localhost:5001`),
这样改后端代码时能**秒级生效、能看日志和断点、且不影响线上用户**,而不必每改
一行就 `firebase deploy` 等上几分钟。

本项目特意让模拟器里的函数去读**线上真实的** Firestore / Storage(方便直接拿真实
实验数据调 AI),代价是函数里的 Admin SDK 需要以你的身份访问项目 —— 这就是下面
第 2 步 gcloud 登录的原因。

### 设置步骤

**1) 准备函数密钥**
```bash
cd functions
cp .secret.local.example .secret.local
# 编辑 .secret.local,填入 ANTHROPIC_API_KEY 等真实值(向管理员索取)
```

**2) 用你自己的账号做一次应用默认凭据(ADC)登录** —— 这一步**每人、每台机器都要各自做一次**,别人的授权不能共用:
```bash
gcloud auth application-default login
```
登录时选一个对 `infrared-explorer` 项目有权限的 Google 账号。完成后本机会存一个
刷新令牌,模拟器里的函数就用它访问线上数据。
（撤销:`gcloud auth application-default revoke`）

**3) 启动函数模拟器**
```bash
cd functions
npm run serve      # = tsc build + firebase emulators:start --only functions
```

**4) 让前端指向本地函数**（另开一个终端）
```bash
# 在项目根目录创建 .env.local,写入这一行:
echo "VITE_USE_FUNCTIONS_EMULATOR=true" > .env.local
npm start
```
现在前端里点「Analyze」、问 AI 等操作会打到你本地的函数;Auth/Firestore/Storage
仍然是线上。删掉 `.env.local` 即可恢复调用**已部署**的线上函数。

> 若想让 Auth/Firestore/Storage 也全部走本地模拟器(完全离线),改用
> `VITE_USE_EMULATORS=true` 并 `firebase emulators:start`(不带 `--only functions`)。
> 端口配置见 `firebase.json`。

---

## 4. 管理脚本

`scripts/` 下有一次性的数据迁移 / 修复脚本(如 `migrateUserExperiments.mjs`)。
它们用 Admin SDK 直连线上,需要根目录放一个 `serviceAccount.json`(服务账号私钥,
向管理员索取)。**这是真正的机密,已被 gitignore,严禁提交到仓库。**

```bash
node scripts/<script>.mjs
# 部分脚本用环境变量指定凭据:
# GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json npx tsx scripts/removeStaffpicks.ts
```

---

## 5. 常用命令

| 命令 | 作用 |
|---|---|
| `npm start` | 起前端开发服务器(连生产) |
| `npm run build` | 打包前端到 `dist/` |
| `npm run lint` | ESLint 检查 |
| `npm run deploy` | 构建并部署前端(hosting) |
| `npm run deploy:functions` | 部署云函数 |
| `npm run deploy:rules` | 部署 Firestore / Storage 安全规则 |
| `npm run deploy:all` | 部署函数 + 规则 + 前端(全量) |
| `cd functions && npm run serve` | 本地跑函数模拟器 |
| `cd functions && npm run logs` | 查看线上函数日志 |

> 类型检查:根 `tsconfig.json` 是空壳(不校验),请用
> `npx tsc -p tsconfig.app.json --noEmit`;`vite build` 本身不做类型检查。

---

## 6. 安全须知

- **绝不提交**:`functions/.secret.local`、`serviceAccount.json`、任何含真实密钥的
  文件。它们都已在 `.gitignore` 里,新建同类文件时请确认仍被忽略。
- `.env` 里的 `VITE_FIREBASE_*` 是公开配置,可以提交模板(`.env.example`),但真实
  访问控制依赖 Firestore/Storage 安全规则,请勿放松规则。
- 机密值请通过密码管理器等安全渠道分发,不要走聊天工具明文发送。
