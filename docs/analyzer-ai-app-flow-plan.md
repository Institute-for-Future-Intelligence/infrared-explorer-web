# 分析页的 Ask AI / AI Report 换成 app 的 AI 流程与提示词（只取「分析」和「报告」两项）

状态：方案稿 v2，2026-10-19；**P0–P2 代码已实现，web 端 2026-10-19 已部署（functions → firestore rules/indexes → hosting），未提交、未真机 QA，见 §5**。v1 曾提议把录像绑成 lab project 复用 Discuss，用户否决：**录像不要讨论区，只保留 Ask AI 和生成报告两个功能；从 app 端提取这两项，更新并合并进网页现有功能。** 对应 app 仓库 `docs/proposals/ai-experiment-projects.md`（设计原则）、`ai-projects-web.md`（浏览器端工具）。

## 0. 一句话结论

**基本原则（用户 2026-10-19 两次重申）：Ask AI 和 AI Report 是「当前这条录像」的两个功能，对象是 `experiments/{expId}` 本身；不创建、不绑定、不关联任何 lab project（`labProjects` 集合与 `labProject*` 函数一概不碰），也没有讨论区。** 从 app 拿的只是提示词、工具和轮次流程这些「做法」，不是它的数据模型。

分析页的两个 tab、它们的数据归属与可见性规则**不变**（Ask AI = 每个用户自己在这条录像上的问答线程；AI Report = owner 生成、跟录像走、访客可看、可举报、可附课堂作业）。换掉的是**引擎**：网站 functions 里规则式的 `QA_SYSTEM_PROMPT` / `REPORT_SYSTEM_PROMPT` + 服务端预算 summary / deepReport 七个工具 + `[figure]` 图标记 / 数字核验 / 虚拟探针，整体替换为 app Experiments 那套——信息式提示词（`prompt.ts base()`）、模型自己用浏览器端 `look` / `run_code` 读全量数据、用 `write_report` 写报告、图以 `![caption](image:ID)` 引用对话里模型自己画的图。服务端新建一个 callable `recordingAiTurn`（app `labProjectTurn` 的单录像版），其中可以逐字复用的 app 模块（`llm.ts`、`partialJson.ts`、提示词文本、工具 schema）用现有 `sync:lab-core` 的同一套机制从 app 仓库同步进 `functions/src/labCore/`，不手抄。

## 1. 从 app 端提取什么、网页端保留什么

**取自 app（app 仓库 `functions/src/`）**
- `prompt.ts base()` 的全部「信息」段：相机与精度、只看表面、可见光视差、录像/延时/照片三种格式、快门校正与漂移、区域数字的行为、「拿工具多看几帧而不是猜」、相机常识不写进报告、坐标约定、图片 id 与 `![caption](image:ID)`、语言规则。新增一个单录像变体（§3.2）。
- 工具：浏览器端 `look`、`run_code`（`TEMPERATURES_BY_CODE_ONLY = true`，不下发 `measure` / `chart` / `place_sensors`），服务端 `view`、`write_report`（含 `REPORT_FIGURES` + `reportExpected(false)` 那段「读者期望」）。不取 `write_plan` / `draw` / `set_title`。
- 轮次引擎：一次请求内最多 10 次模型调用、服务端工具当场跑、设备工具交回浏览器执行后以 `toolResults` 续、`preview` 流出 `write_report` 的 markdown 参数、`status` 状态行、`limit` / `resume`、按请求计费并在零次模型调用时退款、OpenAI Responses API + `reasoning.effort high` + hosted `web_search`、模型调用失败重试一次。
- 上下文构造：系统提示词 + 本轮之前的全部轮次；当前 run 里产出的图以像素送入，更早的图只报 id 让模型 `view`；报告请求那一轮附上 take 的概况总表。
- 概况 `takeOverview`（网页已有 `src/labProjects/overview.ts`）：首条消息 / 首次生成报告前在浏览器算一次，随消息送达。

**保留自网页（本仓库）**
- 两个 tab 的位置、显示条件雏形（`workspacePanel.tsx`）、「Ask about this moment」右键 → 带测量叠加的播放器截图（上限 3 个 moment）、模型下拉（四个 key：`gpt6luna` / `gemini` / `grok47` / `deepseek`，与 app `CHAT_CHOICES` 相同）、Stop 按钮、清除线程 / 清除报告、Regenerate、owner 的 notes。
- 数据归属：`labReports/{id}` + `experiments.labReportId`（访客按录像可见性读；`flagAiReport` 举报、`attachLabReport` 课堂附件照旧）；线程归提问者本人（今天的 `qaTurns` 换成能装工具调用与图的新子集合，§3.4）。
- 门控：`aiAccess.ts`（员工 / 限流 / 同意书 `users/{mongoId}/consents/aiThirdParty`）。
- 浏览器端工具运行时：`src/labProjects/` 下的 `browserTools.ts`、`cloudTake.ts`、`render.ts`、`sandboxHost.ts`、`core/sandboxPage.ts`、`codeState.ts`、`overview.ts`——已是 app `phoneTools` 的网页版，直接给分析页用。

## 2. 两边今天的差别（替换的就是左列）

| | 网页今天 | 换成（app 的做法） |
|---|---|---|
| 模型看到的数据 | 服务端 `loadThermalAnalysis` 算好的 summary + derived digest（JSON），最多 3 个 moment 图 | take 概况（抽样曲线 + 总表）+ 模型自己 `look` / `run_code` 读全量 `.dat` |
| Ask AI | 一问一答，回放最近 6 轮文字，无工具 | 持续线程，每问可多步调用工具；图进线程 |
| 报告 | deepReport 工具调查 2–6 轮 → 一次写稿 → 服务端校正 `[figure]`、数字核验、虚拟探针 AI1… | 独立的报告 run（`{kind:'report'}`）：概况 → 模型自行调查 → `write_report` 落盘；图是模型用 `look sheet` / `run_code picture()` 画的，`![caption](image:ID)` |
| 提示词 | 规则式（必须 / 禁止） | 信息式（相机、数据、工具各返回什么；读者期望作为「建议而非要求」） |
| 读帧 | 服务端读 Storage | 浏览器读（`cloudTake`），服务端不碰帧 |
| 持久化 | `qaTurns`（文字）、`labReports.text` + `probes` + `verified` | 线程 turns（含 toolCalls / 结果 / imageIds）、`labReports.text` + `images[]` |

两个事实：app 自己的录像级 AI Report 调的就是网站 `generateLabReport`，且 app 自 2026-10-16 起已隐藏它（`AI_REPORT_ENABLED = false`）；app 没有录像级 Ask AI。所以 app 端可提取的「分析」= Experiments 的对话与工具，「报告」= `write_report` 及其读者期望文本。

## 3. 方案

### 3.1 服务端：新 callable `recordingAiTurn`（本仓库 `functions/src/`）

- 请求：`{expId, input, browserTools: ['look','run_code'], model}`，流式（`onCall` stream，540 s，1 GiB，同 `labProjectTurn`）。`input` 取 app `TurnInput` 的子集：
  - `{kind:'message', text, moments?: [{recordingIndex, tSeconds, overlay, overlayView}], overview?: {text, images}}`——moments 即今天的 3 个芯片，服务端转成 app 形状的 `images[]`（`InImage{mime,b64,caption:"The player at t = 48 s, with the user's measurements drawn on", takeId}`）；`overview` 只在线程首条消息带（浏览器判断线程为空）；`thread: 'ask'`。
  - `{kind:'toolResults', results:[{callId, ok, text, images?}]}`。
  - `{kind:'report', mode:'revise'|'rewrite', notes?, overview?, model}`——Generate / Revise / Rewrite，开一个独立 run；`revise` 时服务端把当前 `labReports` 正文与嵌图清单放进上下文（决策 G）（`runId` 由服务端发，后续 `toolResults` / `resume` 带 `runId`）；`notes` 即 owner 的 instructions，作为该用户轮的文字（app 里报告请求无文字，这里按 app 的 `attachments` 风格写成 "[App] The owner's notes for the report: …"）。
  - `{kind:'resume'}`。
- 返回块：`text` / `turn` / `image` / `status` / `preview`（同 app，网页 `labProjects/api.ts streamTurn` 已会处理）；最终 `{status:'done'|'awaitingBrowser'|'busy'|'limit', pending:[{id,name,args}], report?: {id, title, markdown, images}}`。
- 门控顺序照 `labProjectTurn`：`assertNotSuspended` → 同意书（非员工）→ `aiAccess` 计费（`message` / `report` 计一次，`toolResults` / `resume` 免费，零次模型调用退款）→ 线程锁（`lock`，9 分钟过期）。
- 权限：Ask AI 任何已登录用户（录像按可见性可读即可）；`report` 仅 owner。
- 模型：沿用网站 `QA_MODELS` 表与 secrets；调用层换成同步来的 `llm.ts callChat`（Responses API、reasoning high、web_search、图片、工具、重试）。`model` 每轮可换（没有 project 可钉，线程每轮记 `model`）。
- 服务端工具执行（`functions/src/recordingAi/tools.ts`）：`view` 从本线程 / 本 run 的图库取字节，revise 时还能取当前报告 `images[]` 里的图（状态段列出它们的 id 与说明）；`write_report` 写 `labReports/{id}`（`text`、`title`、`model`、`at`、`instructions`、`ownerId`、`expId`、`images:[{id,url,caption,w,h}]`）并照今天 `generateLabReport` 的双写把 `aiReport`（正文）、`aiReportModel`、`aiReportAt`、`aiReportInstructions`、`labReportId` 写到 `experiments/{expId}`——分析页与 `workspacePanel.tsx` 的 `showReport` 读的是 `experiment.aiReport`，访客的可见性也靠它；不再写 `aiReportInputsHash` / `aiReportInputs` / `aiReportVerified` / `aiReportVision` / `aiReportSampling`（`src/utils/reportFreshness.ts isReportStale` 的「报告过时」横幅随之退役，见 §9），返回保存后的 Markdown 与嵌图（app 的回显规则）；旧字段 `probes` / `verified` / `inputs` 不再写。
- 图片 URL：和 app `store.ts` 一样用 Admin SDK `getDownloadURL`（带 token 的下载链接），Storage 前缀 `aiThreads/{expId}/{uid}/`、`aiReportRuns/{expId}/{runId}/`、`labReports/{id}/`，规则默认拒绝即可，**不改 `storage.rules`**；谁拿到 Firestore 文档里的 URL 谁能看图，和 Firestore 读规则同口径。
- 上下文（`functions/src/recordingAi/context.ts`，照 app `context.ts` 重写、去掉 plan / diagrams）：系统提示词 = `base(analyzer 变体)` + 状态段（录像标题、线程里的图清单、报告是否已写）+ `SAFETY_RULE`；历史上限按 app：`CONTEXT_BUDGET_TOKENS` 超了就把老轮次折成 `summary`（`summarize` 同步自 `llm.ts`），保留最近 40 轮。
- 第二个 callable `editLabReport({expId, title, markdown})`（owner 手改，决策 G）：`firestore.rules` 把 `aiReport*` 和 `labReports` 对客户端全锁死（第 97–160、713–721 行），所以手改走服务端：校验 owner、非空、≤100k 字符，写 `labReports.text/title/editedBy:'user'/editedAt/lastUserEdit(diff)`，同步双写 `experiments.aiReport`；app 的 `labProjectEdit{reportMarkdown}` 同款。
- 一次请求最多 10 次模型调用（`limit` 后前端提示可续）。

### 3.2 app 仓库要改的（只加不改义，改完 `sync` 过来）

1. `prompt.ts`：`base()` 加 `analyzer` 变体（新参数，不动 `Client`）。改动只在措辞：
   - 开场：「用户在 Infrared Explorer 网站的分析页打开了一条已录好的录像 / 照片组，正在看它的播放器；你和用户一起分析它，用户需要时写报告。」去掉「designing it, then — after the user records it」。
   - "Your tools"：`view and write_report run on the server. Tools that look at the take's pictures or data run in the user's browser.`
   - "What the user sees" 整段换成：分析页 = 播放器（可放传感器 / 温度线、看曲线与剖面）+ Ask AI（这段对话）+ AI Report（报告页，owner 的 Generate Report 按钮）；没有 Plan、没有 Captures、不能加新拍摄件；右键某帧 "Ask about this moment" 会把当前画面（带用户测量叠加，①②③ 标号）随消息送来；访客也能提问但只有 owner 能写报告。去掉「new captures → short first look」句和 `+` 按钮句；保留 d4fd839 加的那句「The user can edit the report… A report the user has edited is theirs: when they ask for changes to it, work from their wording, not from what you wrote before」（去掉其中的 plan 与 remove captures）。
   - 其余逐字复用；`stateSection` 不同步（web 自写）。
2. **可选**：`write_report` 增加 `edits: [{find, replace}]`（与 `write_plan` 同形）。app 今天（d4fd839）的做法是：用户手改后 `report.by = 'user'`，系统提示词的状态段把**改后的全文**放进 `<report>…</report>`，并有一条 `reportEdited` 的 diff 便条，所以模型重写时看得见用户的改动，手改**不会被盲目冲掉**；只是 `write_report` 仍要整篇重出，用户的措辞能否逐字保留取决于模型照抄得准不准，也多花 token。`edits` 让局部修订精确、便宜，是改进不是修 bug；两边一起加或先都不加均可，网页按同一规则。老 app 不传 `edits` 时行为不变。
3. `tools.ts` 拆成纯 schema 文件 `toolSchemas.ts`（`SERVER_SCHEMAS`、`PHONE_SCHEMAS`、`lookSchema`、`REPORT_*`、`PLAN_EXPECTED`、`declaredPhoneTools`、`toolSchemas(phoneTools, {serverTools?: string[]})`、`normalizeToolArgs`）和执行文件；网页只同步前者，并以 `serverTools: ['view','write_report']` 取子集。
4. `llm.ts`、`partialJson.ts`、`textDiff.ts` 不用改：`partialJson.ts` / `textDiff.ts` 零 import；`llm.ts` 只 import `./secrets` 的 `apiKeyFor`，网页侧在 `functions/src/labCore/` 旁放一个同名 shim（`secrets.ts` 导出 `apiKeyFor`，接网站自己的 secrets），同步脚本照 `core/math.ts` 的做法把 shim 排除在覆盖之外。
5. `config.ts`、`store.ts` 也不同步：`prompt.ts` import 的 `SAFETY_RULE` / `TEMPERATURES_BY_CODE_ONLY` 和 `ImageDoc` / `ProjectDoc` 类型由网页 shim `labCore/config.ts`、`labCore/store.ts` 提供（常量手工镜像，十来行；`SAFETY_RULE` 与网站 `aiAccess.ts AI_SAFETY_RULE` 本就是同一句）。`MAX_MODEL_CALLS_PER_INVOCATION` 等轮次常量网页在 `recordingAi/config.ts` 自定，取 app 的值。
6. `prompt.test.ts` 钉住 analyzer 变体文字；若加了 `edits`，`tools.test.ts` 钉住它。

本仓库 `scripts/sync-lab-core.mjs` 加第二组（脚本今天是单一 `srcDir`/`outDir` + `FILES` 列表 + `FORBIDDEN_IMPORT`，改成两组）：app `functions/src/{prompt,toolSchemas,llm,partialJson,textDiff}.ts` → `functions/src/labCore/`，shim 文件 `secrets.ts` / `config.ts` / `store.ts` 不覆盖，`SOURCE.md` 记 commit；两边各自 `tsc`。于是 app 仓库真正要改的只剩两件：prompt 变体、`tools.ts` 拆文件；`write_report.edits` 可选。

### 3.3 网页端（本仓库 `src/`）

- **`services/recordingAi.ts`**（替换 `services/ai.ts` 的 Q&A / 报告部分）：`streamTurn` 照 `labProjects/api.ts` 的块处理；`loadThread` / `clearThread`；`clearReport`。
- **`pages/experimentAnalyzer/ai/useRecordingAi.ts`**（照 `labProjects/runner.ts` 的 `startTurn` 改成按 `expId` 键）：准备概况（首条）→ 发 → `awaitingBrowser` 时按 `pending[]` 顺序调 `browserTools.runBrowserTool(call, [take], \`exp:${expId}\`)`（`codeState.ts` 的键是 `uid:projectId`，这里第二段传 `exp:${expId}`，按录像隔离）→ `toolResults` 续 → `done` / `limit` / `busy`；Stop = abort；离开页面不中断（状态放 store，和今天「两个 AI 运行都活过面板切换」一致）；回到页面续跑 pending（`resumePending` 同款）。`take` 由 `experiments/{expId}` 直接构造（`Take{takeId: expId, source, timelapse, name, cloud:{expId}}`），`cloudTake` 不用改。分析页改探针 / 剖面线后 `forgetCloudTake(expId)`。
- **Ask AI tab（`qaPanel.tsx` 重写）**：线程视图 = 用户消息（带 moment 芯片）+ 模型回答 + 工具活动行（`look` / `run_code` 的 purpose、图卡片，照 `Discuss.tsx` 的 `Activity` 收缩样式，但不含 plan / captures / 拍摄件托盘）+ 状态行 + 输入框 + 模型下拉 + Stop + Clear。图点开用 `labProjects/components/Lightbox`。Markdown 用 `labProjects/MarkdownView`（解析 `image:ID`）。
- **AI Report tab（`aiReport.tsx` 重写）**：正文仍读 `experiment.aiReport`（今天的读法），`images[]` 从 `labReports/{labReportId}` 取（今天取 `probes` 的同一条路 `fetchLabReportProbes` 改成取图）；用 `MarkdownView` 渲染；Edit 复用 Projects 页的 `DocEditorModal`（它今天就同时编辑 plan 和 report）；生成中显示 `preview` 实时稿与状态行；按钮 Generate / Revise with AI / Rewrite from scratch / Edit / Clear / notes / Flag / Export（决策 G）；删掉 `[figure]` 灯箱、虚拟探针图层、「数字已核验」标签、digest 卡。
- **moment**：芯片逻辑保留，发送时带 `overlay` 截图（今天已有）；服务端转成 `images[]`。
- **显示条件**：`sourceType ∈ {recording, photos}`（`cloudTake` 支持的两种）；`video`（老 showcase .vir）见 §6-F。Ask AI 对任何已登录用户开放与否沿用今天 `aiAccess` 的档位（员工 / 一般账户限流）——是否放开非员工见 §6-E。
- **CLAUDE.md**：「AI Project 区不得 import 站点 AI」保留；反向新增一条：分析页的 AI 可以（且只能）通过 `src/labProjects/{browserTools,cloudTake,overview,render,sandboxHost,codeState,MarkdownView,components/Lightbox}` 用那套运行时，不得 import `labProjects/api.ts`、`runner.ts`、`store.ts`（那是项目的）。

### 3.4 数据

- Ask AI 线程：`experiments/{expId}/aiThreads/{uid}`（`lock`、`seq`、`summary`、`usage`、`model`）+ `.../turns/{t0000001}`（app `TurnDoc` 形状：`role user|assistant|tool|note`、`text`、`toolCalls[{id,name,args,side}]`、`callId`、`result{text,imageIds}`、`request:'report'`、`model`、`webSearches`）+ `.../images/{id}`（`kind look|overview|code`、`caption`、`url`、`w`、`h`）；图字节在 Storage `aiThreads/{expId}/{uid}/{id}.jpg`。规则：本人可读，服务端写（和 `qaTurns` 一样「rules are not filters」，查询带 uid）。
- 报告 run：`experiments/{expId}/aiReportRuns/{runId}`（`ownerId`、`model`、`lock`、`seq`、`status`、`expireAt` 7 天 TTL）+ `turns` + `images`，与线程同形状、互不相见。
- 报告：`labReports/{id}` 增 `title`、`images[]`（嵌图复制到 Storage `labReports/{id}/` 前缀，token URL）、`editedBy`、`editedAt`、`lastUserEdit`（diff）；`experiments/{expId}` 继续双写 `aiReport` / `aiReportModel` / `aiReportAt` / `aiReportInstructions` / `labReportId`，其余五个 `aiReport*` 字段不再写。规则不开客户端写（手改走 `editLabReport`）。
- 旧 `qaTurns`：不迁移、不显示；集合与规则留着给老 app 之外的清理期（§6-D）。
- TTL：`aiReportRuns.expireAt` 的 7 天策略要用 `gcloud firestore fields ttls update expireAt --collection-group=aiReportRuns --enable-ttl` 开，并记进 `firestore.indexes.json`（该文件里 streetviewReports 等已有同款记录；服务账号权限不够，要用用户账号跑——见 crash-error-logging 的教训）。
- 删除级联：`onExperimentDeleted` 已 `recursiveDelete` 整个录像文档，子集合 `aiThreads` / `aiReportRuns` 随之消失，只需补删三个 Storage 前缀；`deleteAccount` 今天只删本人录像下的 `qaTurns`（Ask AI 曾只持久化 owner 的轮），新流程非 owner 的线程挂在别人的录像下，要加一条 `collectionGroup('aiThreads').where('uid','==',…)` 清理 + Storage 前缀。

## 4. 删除清单（网页端停用后、旧安装包不再调用时）

- `functions/src/`：`deepReport.ts`、`reportImages.ts`、`qaHistory.ts`、`reportTiming.ts`、`aiInbox.ts`，`index.ts` 里 `answerExperimentQuestion`、`generateLabReport`、`QA_SYSTEM_PROMPT`、`REPORT_SYSTEM_PROMPT` / `REPORT_PHOTO_SYSTEM_PROMPT`、`buildFrameImageBlocks`、`runDeepReport`、虚拟探针与 `zz-ai-` 文档前缀相关、`aiReportAudit`。**留** `frameSelection.ts`（`buildThermalSummary` 第 4768 行用 `selectFrames` 抽样）、`analysis.ts` 与 `loadThermalAnalysis` / `buildThermalSummary`（Lab Assistant 的 `read_experiment_data` / `getExperimentData` 还在用）。
- `src/`：`qaPanel.tsx`、`aiReport.tsx` 的旧实现、`services/ai.ts` 的 Q&A / 报告函数与 `VirtualProbe`、`types.ts` 的 `ReportVerification` / `ReportInputsDescriptor` / `ReportSampling`、播放器里 AI 探针图层、`[figure]` 渲染。
- 不动：`agentChat` / `components/aiChat/*`（Lab Assistant）、Digital Twin 全部、`getExperimentData`。

## 5. 分期

- **P0（app 仓库）** ✅ 2026-10-19 已完成并提交 app dev `5072756`，`labprojects` 15 个函数 2026-10-19 已部署（日志 app `tmp/deploy-labprojects-p0.log`，无删除；未 push；`functions` 的 `npm test` 82/82、`tsc` 绿）：`prompt.ts` 加 `Setting = 'experiment' | 'recording'` 第三参数（recording 变体改 7 行、去 2 行），`tools.ts` 拆出纯声明文件 `toolSchemas.ts`（`toolSchemas(phoneTools, {serverTools})`、`reportImageIds` 随之搬过去，`tools.ts` 整体 re-export），`write_report` 加 `edits`（`applyEdits` 与 `write_plan` 共用），三份测试钉住。原计划：`prompt.ts` analyzer 变体、`tools.ts` 拆出 `toolSchemas.ts`、测试；可选 `write_report.edits`（schema + `writeReport` 支持，复用 `writePlan` 的 edits 应用逻辑）。前两项 app 行为不变、不必部署；加了 `edits` 则部署 `labprojects` 才对 app 生效。
- **P1（本仓库 functions）** ✅ 2026-10-19 已实现并部署（47 个函数，新建 `recordingAiTurn` / `editLabReport` / `clearRecordingAiThread`，无删除；rules + indexes 同日发布；未提交；`functions` `tsc` 绿，根目录 `npm test` 850/850）：`sync-lab-core.mjs` 第二组 → `functions/src/labCore/`（prompt/toolSchemas/llm/partialJson/textDiff + shim config/secrets/store）；`aiModels.ts`、`aiSecrets.ts` 从 index.ts 抽出；`recordingAi/{config,store,context,tools,turn,index}.ts`（callable `recordingAiTurn` / `editLabReport` / `clearRecordingAiThread`，工厂注入 db + 限流）；`clearLabReport` 顺带删报告图前缀；`onExperimentDeleted` 删三个 Storage 前缀；`deleteAccount` 加 `purgeAiThreads`（collectionGroup）；rules 加 `aiThreads` / `aiReportRuns`；indexes 加 `aiThreads.uid` 集合组索引 + `aiReportRuns.expireAt` TTL（随 `firebase deploy --only firestore` 已启用，同时启用了早先只声明的 `aiReportAudit` TTL）；functions tsconfig 升 es2022。原计划：扩 `sync-lab-core.mjs` 同步 `functions/src/labCore/`；`recordingAiTurn` + `recordingAi/{context,tools,store}.ts`；`editLabReport`；`labReports` 新字段与 `clearLabReport` 改写（仍删 `aiReport*` 五个旧字段以清掉旧报告的残留）；`onExperimentDeleted` 级联；`firestore.rules` 加 `aiThreads`；`storage.rules` 加 `aiThreads/` 前缀（服务端写、本人读）。旧 callable 保留。部署 functions → rules。
- **P2（本仓库 src）** ✅ 2026-10-19 已实现并部署 hosting（线上 bundle `index-6cpV0FF7.js` = 本地；部署前补上了 AI Report 漏挂的 Export 按钮；未提交、未在浏览器里跑过；`tsc -b` 仅基线 7 条、lint 仅基线 4 错、`vite build` 绿）：`services/recordingAi.ts`、`pages/experimentAnalyzer/ai/{recordingAiRunner.ts,RecordingReplies.tsx,RecordingThread.tsx,RecordingReport.tsx}`，`workspacePanel` 两 tab 对所有登录用户开放（video 显说明），`imagePlayer` 的 moment 入口对所有登录用户开放、`videoPlayer` 不再给 moment；删 `qaPanel.tsx` / `aiReport.tsx`，`services/ai.ts` 只剩 twin + Lab Assistant；`core/` 同步到 app `5072756`（新 shim `labProjects/visibility.ts`）；CLAUDE.md 加一条。原计划：先 `npm run sync:lab-core`（`core/` 同步自 app `eb798af`，app 已到 `4ca9ef9`（3.1.1）：至少 `types.ts` 的 `device` 字段、`runStatus.ts` 的 `tool:web_search` 文案，d4fd839 之后还有报告编辑相关改动，同步时按脚本输出核对）；`services/recordingAi.ts`、`useRecordingAi.ts`、两个 tab 重写、CLAUDE.md。`tsc -b` + `vite build` + lint 基线不涨。部署 hosting。
- **P3**：真机 QA（长录像首读、Stop、刷新续跑、非 owner 线程、照片组）；观察一轮后按 §4 退役旧服务端。

## 6. 决策（用户 2026-10-19 定）

- **A. 报告请求不共用 Ask AI 线程。** 每次 Generate / Regenerate 是一次独立的 run：自己的概况 → 模型调查 → `write_report`。run 的轮次存 `experiments/{expId}/aiReportRuns/{runId}/turns`（和线程同一 TurnDoc 形状，服务端写，owner 读），用于生成中的进度展示与断线续跑；报告落盘后 run 文档保留 7 天（TTL）供排错，之后删。Ask AI 线程不知道报告，报告也不知道线程。
- **B. 报告图归报告。** `write_report` 落盘时把它嵌的 `image:ID` 图复制到 Storage `labReports/{id}/{imageId}.jpg`，`labReports.images[]` 记新 URL；访客按录像可见性读报告即可读图，不放开 run / 线程图的读规则。（用户未另定，取推荐项。）
- **C. 模型不可轮换。** Ask AI：线程为空时可选模型，发出第一条后固定，记在 `aiThreads/{uid}.model`；Clear thread 后可重选。报告：Generate 时选，整个 run 固定并记入 `labReports.model`；下一次 Regenerate 可另选。和 app「首条后固定」同一规则。
- **D. 旧数据不迁移。** 旧 `qaTurns` 不显示（集合与规则留到清理期再删）。旧 `labReports`（有 `[figure]` 标记、无 `images`）继续按 Markdown 显示，`[figure: t = N s | caption]` 行退化为一行斜体文字 "Figure: t = N s — caption"，不再渲染帧图；owner 看到一行提示「This report was written by the previous AI; regenerate for pictures」。
- **E. 入口对非员工开放并限流。** 两个 tab 的 `staff &&` 条件去掉；`aiAccess.ts` 的一般档（`config/aiLimits`，今天 10/小时、30/天、全局 200/天，按请求计：`message` / `report` 各一次，`toolResults` / `resume` 免费）+ 同意书 `users/{mongoId}/consents/aiThirdParty`。员工不限。配额不足时的提示沿用今天的文案。
- **F. 老视频类型（showcase `.vir`）不给 AI，并对用户说明原因。** 两个 tab 对 `video` 仍显示，但内容是一段说明而非功能：「AI analysis isn't available for this clip. It is an older showcase video stored as one .vir file, and the AI's tools read a recording frame by frame in your browser, which that format doesn't support. Recordings captured with the app and photo sets are supported.」不做 `.vir` 帧源。

- **G. 报告 owner 可直接修改；AI 修订时带上当前版本。**（用户 2026-10-19 定）报告页有三个动作：
  - **Edit**：owner 在 Markdown 编辑器里直接改——app（d4fd839 起）和网页 Projects 页的报告今天就能这样改（app `ReportTab` 的 Edit → `labProjectEdit{reportMarkdown, reportTitle}`，报告记 `by: 'user'`，并给模型留一条 `reportEdited` diff 便条），分析页复用网页 Projects 页的那个编辑器；保存写 `labReports.text`，记 `editedBy: 'user'`、`editedAt`，并把 diff 存成 `lastUserEdit`，下一次 Revise run 作为 `reportEdited` 便条送入（app `noteText` 同款文字）；`![caption](image:ID)` 引用原样保留，`images[]` 不动；页面标注「Edited by the owner」。访客看到的就是改后的版本。举报 / 课堂附件照旧。
  - **Revise with AI**（有当前报告时 Regenerate 按钮的默认含义）：照 app d4fd839 的做法——新 run 的状态段带上**当前报告正文**（`<report>…</report>`，含用户的修改，注明 "last edited by the user" 或 "written by the AI"）和它嵌图的 id / 说明清单，用户手改的 diff 作为 `reportEdited` 便条送入；owner 的 notes 说要改什么。模型整篇重出（app 今天的方式），若两边加了 `edits` 则可局部修改；用户没要求改的段落靠模型照抄保留。新嵌的图照 B 复制进 `labReports/{id}/`，不再被引用的图从 `images[]` 去掉。
  - **Rewrite from scratch**：菜单里的第二项，不带旧报告，干净重写（原 §9 第一条的「推荐项」降为这个显式动作）。
  - 用户的手改与 AI 的改动在 `labReports` 上只留当前版本，不留历史（和 app 的 plan / report 一致，决策 ⑲）；`lastUserEdit` 的 diff 便条让模型知道用户改了哪里（app 的 `reportEdited` 同款，`textDiff.ts` 一并同步）。

## 9. 剩余的开放问题（不阻塞开工，开工前顺手定）

- **「报告过时」横幅**：今天 `isReportStale` 比较 `aiReportInputs`（探针 / 剖面线 / 标题等的哈希）提示 owner 重生成。新流程没有 inputs 哈希（模型自己读数据）；推荐去掉横幅，owner 改了探针想更新就 Revise。备选：按 `thermometers` 子集合的最后修改时间 > `aiReportAt` 显示一行弱提示。
- **生成中展示什么**：推荐 AI Report tab 在 run 期间显示 app Discuss 式的活动条（状态行、`look` 图、`run_code` 的 purpose 与图、`write_report` 的实时预览稿），完成后只留报告与嵌图，活动记录不再显示（存在 run 文档里 7 天）。
- **限额数字**：每次请求现在是多步模型调用（最多 10 次），单价高于今天。先沿用 10/30/200，看一周用量后在 `config/aiLimits` 调；app 是 15/50/600。
- **回答语言**：app 提示词是「用用户写的语言回答」，今天网页固定英文。沿用 app（中文提问得中文回答）；报告在只按了按钮没有文字时写英文，notes 用中文则跟中文。
- **web_search**：app 服务端 `OPENAI_WEB_SEARCH = true`（试用中），同步过来 OpenAI 模型在分析里也可能联网查资料。沿用 app 的开关；要关就在 `aiConstants.ts` 关，两边一起。
- **run_code 的持久 `save` / `load`**：按录像隔离（`codeState` 键 `exp:${expId}`），线程与报告 run 共用同一个存储（模型两边都能 `load` 到）还是也分开——推荐共用，是「这条录像的数据」。
- **分析页探针变动的时效**：owner 在播放器移动探针后，模型下一次 `look marks` / `take.sensors` 要读到新位置，靠 `forgetCloudTake(expId)`；运行中的 run 不感知，下一轮才生效。

## 7. 风险

- **首条消息 / 首次报告变慢**：浏览器先做 `takeOverview`（最多抽 1,200 帧）再发；模型随后 `run_code` 读全量帧也在浏览器下载（长录像首读分钟级，`run_code` 描述里已如实写明）。状态行要如实显示。
- **生成报告必须开着页面**：工具在浏览器跑，关掉 tab 则 pending 停在那；回来续跑。今天的报告是纯服务端、关页面也能写完。
- **报告形态变化**：没有自动帧图、数字核验、AI 探针；质量取决于模型是否主动 `look sheet` / 画图——这是 app 那边已接受并多轮调过的取舍（决策 ㊽ / 56 / 63）。
- **两份服务端代码**：`labCore/` 靠同步脚本；忘同步会出现「同一句提示词两边不同」。`SOURCE.md` 记 commit；app 仓库 PR 描述加一句「网页 functions 要同步」。
- **成本结构变化**：每问多步模型调用（最多 10 次）而非一次；`aiAccess` 的 10/30/200 限额按「请求」计，与 app 的 15/50/600 对齐与否可在 `config/aiLimits` 调。

## 8. 否决记录

- v1（2026-10-19 上午）：录像绑 lab project、tab 嵌 Discuss / ReportTab、服务端全在 app 仓库。用户否决：网页录像不要讨论区，只要 Ask AI 与生成报告两项，合并进现有功能。
- 只换提示词、保留服务端 summary / deepReport 工具：模型能力与 app 不同（预算摘要 vs 自己读全量），同一提示词两边表现不一致，否。


## 10. 对照两端最新代码的校对记录（2026-10-19）

- app `functions/src`（HEAD `4ca9ef9`，比上午调研时的 `75bad04` 多 15 个提交）：`tools.ts` 的 `write_plan` 已有 `edits` 实现（`writePlan`，第 521 行起）与 `reportImageIds()`，`write_report` 只收整篇；d4fd839「the report can be edited like the plan, and the AI reads the edit」：`labProjectEdit` 支持 `reportMarkdown` / `reportTitle`（`report.by='user'` + `reportEdited` diff 便条），`stateSection` 在 `by==='user'` 时把改后全文放进 `<report>…</report>` 并注明 last edited by the user，`base()` 加了「A report the user has edited is theirs… work from their wording」——所以 app **没有**「手改被盲目冲掉」的问题（上午的说法过头了），只是整篇重出的逐字保真靠模型；`llm.ts` 唯一外部依赖是 `./secrets apiKeyFor`，`partialJson.ts` / `textDiff.ts` 零 import，`prompt.ts` 只依赖 `./config` 两个常量和 `./store` 两个类型；app 用 `getDownloadURL` token 链接存图。
- web `src`：`workspacePanel.tsx` 两个 tab 都 `staff &&`，Ask AI 今天支持 `video`；`aiReport.tsx` 正文读 `experiment.aiReport`，`labReports` 只取 `probes`；`cloudTake.ts` 读 `recordings/{recordingId}/data_N.dat` / `vis_N.jpg` / `frame-stats.bin`，只接 Recording / Photos，不读 `.vir`；`codeState.ts` 键 `uid:projectId`；Projects 页的 `DocEditorModal` 同时编辑 plan 与 report；`api.ts streamTurn` 已设 `TURN_TIMEOUT_MS`；`sync-lab-core.mjs` 单组 `FILES` + `FORBIDDEN_IMPORT`，需改两组。
- web `functions`：`firestore.rules` 对 `aiReport*` 字段（create/update 两处）和 `labReports`（`allow write: if false`）全锁客户端写，读规则按录像可见性；`aiAccess.ts` 档位只有 staff / private，默认 10/30/200，同意书 `users/{mongoId}/consents/aiThirdParty` v1；`frameSelection.selectFrames` 被 `buildThermalSummary`（Lab Assistant 仍用）调用，不能删；`onExperimentDeleted` 已 `recursiveDelete` + 删 `labReports`；`deleteAccount` 只删本人录像下的 `qaTurns`；`clearLabReport` 删十个 `aiReport*`/`labReportId` 字段 + `labReports` 文档；TTL 需 gcloud 开并记 `firestore.indexes.json`。
- 由此修正的方案点：报告正文必须继续双写到 `experiments.aiReport`；owner 手改走新 callable 而非放开规则；`frameSelection.ts` 移出删除清单；`llm.ts` / `config.ts` 用 shim 不改 app；图用 token URL 不改 `storage.rules`；`deleteAccount` 要加 collectionGroup 清理；「报告过时」横幅退役（§9）。