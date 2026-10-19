# 分析页的 Ask AI / AI Report 换成 app 的 AI 流程与提示词（只取「分析」和「报告」两项）

状态：方案稿 v2，2026-10-19，未实施。v1 曾提议把录像绑成 lab project 复用 Discuss，用户否决：**录像不要讨论区，只保留 Ask AI 和生成报告两个功能；从 app 端提取这两项，更新并合并进网页现有功能。** 对应 app 仓库 `docs/proposals/ai-experiment-projects.md`（设计原则）、`ai-projects-web.md`（浏览器端工具）。

## 0. 一句话结论

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
| 报告 | deepReport 工具调查 2–6 轮 → 一次写稿 → 服务端校正 `[figure]`、数字核验、虚拟探针 AI1… | 同一线程里的 `{kind:'report'}` 请求 → 模型自行调查 → `write_report` 落盘；图是模型用 `look sheet` / `run_code picture()` 画的，`![caption](image:ID)` |
| 提示词 | 规则式（必须 / 禁止） | 信息式（相机、数据、工具各返回什么；读者期望作为「建议而非要求」） |
| 读帧 | 服务端读 Storage | 浏览器读（`cloudTake`），服务端不碰帧 |
| 持久化 | `qaTurns`（文字）、`labReports.text` + `probes` + `verified` | 线程 turns（含 toolCalls / 结果 / imageIds）、`labReports.text` + `images[]` |

两个事实：app 自己的录像级 AI Report 调的就是网站 `generateLabReport`，且 app 自 2026-10-16 起已隐藏它（`AI_REPORT_ENABLED = false`）；app 没有录像级 Ask AI。所以 app 端可提取的「分析」= Experiments 的对话与工具，「报告」= `write_report` 及其读者期望文本。

## 3. 方案

### 3.1 服务端：新 callable `recordingAiTurn`（本仓库 `functions/src/`）

- 请求：`{expId, input, browserTools: ['look','run_code'], model}`，流式（`onCall` stream，540 s，1 GiB，同 `labProjectTurn`）。`input` 取 app `TurnInput` 的子集：
  - `{kind:'message', text, moments?: [{recordingIndex, tSeconds, overlay, overlayView}], overview?: {text, images}}`——moments 即今天的 3 个芯片，服务端转成 app 形状的 `images[]`（`InImage{mime,b64,caption:"The player at t = 48 s, with the user's measurements drawn on", takeId}`）；`overview` 只在线程首条消息带（浏览器判断线程为空）。
  - `{kind:'toolResults', results:[{callId, ok, text, images?}]}`。
  - `{kind:'report', notes?, overview?}`——Generate Report；`notes` 即 owner 的 instructions，作为该用户轮的文字（app 里报告请求无文字，这里按 app 的 `attachments` 风格写成 "[App] The owner's notes for the report: …"）。
  - `{kind:'resume'}`。
- 返回块：`text` / `turn` / `image` / `status` / `preview`（同 app，网页 `labProjects/api.ts streamTurn` 已会处理）；最终 `{status:'done'|'awaitingBrowser'|'busy'|'limit', pending:[{id,name,args}], report?: {id, title, markdown, images}}`。
- 门控顺序照 `labProjectTurn`：`assertNotSuspended` → 同意书（非员工）→ `aiAccess` 计费（`message` / `report` 计一次，`toolResults` / `resume` 免费，零次模型调用退款）→ 线程锁（`lock`，9 分钟过期）。
- 权限：Ask AI 任何已登录用户（录像按可见性可读即可）；`report` 仅 owner。
- 模型：沿用网站 `QA_MODELS` 表与 secrets；调用层换成同步来的 `llm.ts callChat`（Responses API、reasoning high、web_search、图片、工具、重试）。`model` 每轮可换（没有 project 可钉，线程每轮记 `model`）。
- 服务端工具执行（`functions/src/recordingAi/tools.ts`）：`view` 从线程图库取字节；`write_report` 写 `labReports/{id}`（`text`、`title`、`model`、`at`、`instructions`、`ownerId`、`expId`、`images:[{id,url,caption,w,h}]`）并把 `experiments.labReportId` 指过去，返回保存后的 Markdown 与嵌图（app 的回显规则）；旧字段 `probes` / `verified` / `inputs` 不再写。
- 上下文（`functions/src/recordingAi/context.ts`，照 app `context.ts` 重写、去掉 plan / diagrams）：系统提示词 = `base(analyzer 变体)` + 状态段（录像标题、线程里的图清单、报告是否已写）+ `SAFETY_RULE`；历史上限按 app：`CONTEXT_BUDGET_TOKENS` 超了就把老轮次折成 `summary`（`summarize` 同步自 `llm.ts`），保留最近 40 轮。
- 一次请求最多 10 次模型调用（`limit` 后前端提示可续）。

### 3.2 app 仓库要改的（只加不改义，改完 `sync` 过来）

1. `prompt.ts`：`base()` 加 `analyzer` 变体（新参数，不动 `Client`）。改动只在措辞：
   - 开场：「用户在 Infrared Explorer 网站的分析页打开了一条已录好的录像 / 照片组，正在看它的播放器；你和用户一起分析它，用户需要时写报告。」去掉「designing it, then — after the user records it」。
   - "Your tools"：`view and write_report run on the server. Tools that look at the take's pictures or data run in the user's browser.`
   - "What the user sees" 整段换成：分析页 = 播放器（可放传感器 / 温度线、看曲线与剖面）+ Ask AI（这段对话）+ AI Report（报告页，owner 的 Generate Report 按钮）；没有 Plan、没有 Captures、不能加新拍摄件；右键某帧 "Ask about this moment" 会把当前画面（带用户测量叠加，①②③ 标号）随消息送来；访客也能提问但只有 owner 能写报告。去掉「new captures → short first look」句和 `+` 按钮句。
   - 其余逐字复用；`stateSection` 不同步（web 自写）。
2. `tools.ts` 拆成纯 schema 文件 `toolSchemas.ts`（`SERVER_SCHEMAS`、`PHONE_SCHEMAS`、`lookSchema`、`REPORT_*`、`PLAN_EXPECTED`、`declaredPhoneTools`、`toolSchemas(phoneTools, {serverTools?: string[]})`、`normalizeToolArgs`）和执行文件；网页只同步前者，并以 `serverTools: ['view','write_report']` 取子集。
3. `llm.ts`、`partialJson.ts` 本来就纯，直接同步（`llm.ts` 读 secrets 的那两行改成注入 `apiKey` 的参数，app 侧也用它）。
4. `config.ts` 里网页要的常量（`SAFETY_RULE`、`MAX_MODEL_CALLS_PER_INVOCATION`、`MAX_OUTPUT_TOKENS`、`OPENAI_REASONING_EFFORT`、`OPENAI_WEB_SEARCH`、`CONTEXT_BUDGET_TOKENS`、`KEEP_RECENT_TURNS`、`TEMPERATURES_BY_CODE_ONLY`）抽到 `aiConstants.ts` 同步；模型表不同步（两边各自的）。
5. `prompt.test.ts` 钉住 analyzer 变体文字。

本仓库 `scripts/sync-lab-core.mjs` 加第二组：app `functions/src/{prompt,toolSchemas,llm,partialJson,aiConstants}.ts` → `functions/src/labCore/`，`SOURCE.md` 记 commit；两边各自 `tsc`。

### 3.3 网页端（本仓库 `src/`）

- **`services/recordingAi.ts`**（替换 `services/ai.ts` 的 Q&A / 报告部分）：`streamTurn` 照 `labProjects/api.ts` 的块处理；`loadThread` / `clearThread`；`clearReport`。
- **`pages/experimentAnalyzer/ai/useRecordingAi.ts`**（照 `labProjects/runner.ts` 的 `startTurn` 改成按 `expId` 键）：准备概况（首条）→ 发 → `awaitingBrowser` 时按 `pending[]` 顺序调 `browserTools.runBrowserTool(call, [take], \`exp:${expId}\`)`（`codeState` 的 save/load 按录像隔离）→ `toolResults` 续 → `done` / `limit` / `busy`；Stop = abort；离开页面不中断（状态放 store，和今天「两个 AI 运行都活过面板切换」一致）；回到页面续跑 pending（`resumePending` 同款）。`take` 由 `experiments/{expId}` 直接构造（`Take{takeId: expId, source, timelapse, name, cloud:{expId}}`），`cloudTake` 不用改。分析页改探针 / 剖面线后 `forgetCloudTake(expId)`。
- **Ask AI tab（`qaPanel.tsx` 重写）**：线程视图 = 用户消息（带 moment 芯片）+ 模型回答 + 工具活动行（`look` / `run_code` 的 purpose、图卡片，照 `Discuss.tsx` 的 `Activity` 收缩样式，但不含 plan / captures / 拍摄件托盘）+ 状态行 + 输入框 + 模型下拉 + Stop + Clear。图点开用 `labProjects/components/Lightbox`。Markdown 用 `labProjects/MarkdownView`（解析 `image:ID`）。
- **AI Report tab（`aiReport.tsx` 重写）**：`labReports` 文档的 `text` 用 `MarkdownView` 渲染，`images[]` 喂给它；生成中显示 `preview` 实时稿与状态行；按钮 Generate / Regenerate / Clear / notes / Flag / Export 保留；删掉 `[figure]` 灯箱、虚拟探针图层、「数字已核验」标签、digest 卡。
- **moment**：芯片逻辑保留，发送时带 `overlay` 截图（今天已有）；服务端转成 `images[]`。
- **显示条件**：`sourceType ∈ {recording, photos}`（`cloudTake` 支持的两种）；`video`（老 showcase .vir）见 §6-F。Ask AI 对任何已登录用户开放与否沿用今天 `aiAccess` 的档位（员工 / 一般账户限流）——是否放开非员工见 §6-E。
- **CLAUDE.md**：「AI Project 区不得 import 站点 AI」保留；反向新增一条：分析页的 AI 可以（且只能）通过 `src/labProjects/{browserTools,cloudTake,overview,render,sandboxHost,codeState,MarkdownView,components/Lightbox}` 用那套运行时，不得 import `labProjects/api.ts`、`runner.ts`、`store.ts`（那是项目的）。

### 3.4 数据

- 线程：`experiments/{expId}/aiThreads/{uid}`（`lock`、`seq`、`summary`、`usage`、`lastModel`）+ `.../turns/{t0000001}`（app `TurnDoc` 形状：`role user|assistant|tool|note`、`text`、`toolCalls[{id,name,args,side}]`、`callId`、`result{text,imageIds}`、`request:'report'`、`model`、`webSearches`）+ `.../images/{id}`（`kind look|overview|code`、`caption`、`url`、`w`、`h`）；图字节在 Storage `aiThreads/{expId}/{uid}/{id}.jpg`。规则：本人可读，服务端写（和 `qaTurns` 一样「rules are not filters」，查询带 uid）。
- 报告：`labReports/{id}` 增 `title`、`images[]`；`experiments.labReportId` 照旧；`clearLabReport` 改为删文档 + 清指针（不再有探针要清）。`attachLabReport`、`flagAiReport`、`aiReportFlags` 不动。
- 旧 `qaTurns`：不迁移、不显示；集合与规则留着给老 app 之外的清理期（§6-D）。
- 录像删除：`onExperimentDeleted` 级联删 `aiThreads/**` 与其 Storage 前缀（本仓库自己的集合，可以删）。

## 4. 删除清单（网页端停用后、旧安装包不再调用时）

- `functions/src/`：`deepReport.ts`、`reportImages.ts`、`qaHistory.ts`、`reportTiming.ts`、`aiInbox.ts`、`frameSelection.ts`（仅报告用），`index.ts` 里 `answerExperimentQuestion`、`generateLabReport`、`QA_SYSTEM_PROMPT`、`REPORT_SYSTEM_PROMPT` / `REPORT_PHOTO_SYSTEM_PROMPT`、`buildFrameImageBlocks`、`runDeepReport`、虚拟探针与 `zz-ai-` 文档前缀相关、`aiReportAudit`。**留** `analysis.ts` 与 `loadThermalAnalysis` / `buildThermalSummary`（Lab Assistant 的 `read_experiment_data` / `getExperimentData` 还在用）。
- `src/`：`qaPanel.tsx`、`aiReport.tsx` 的旧实现、`services/ai.ts` 的 Q&A / 报告函数与 `VirtualProbe`、`types.ts` 的 `ReportVerification` / `ReportInputsDescriptor` / `ReportSampling`、播放器里 AI 探针图层、`[figure]` 渲染。
- 不动：`agentChat` / `components/aiChat/*`（Lab Assistant）、Digital Twin 全部、`getExperimentData`。

## 5. 分期

- **P0（app 仓库）**：`prompt.ts` analyzer 变体、`tools.ts` 拆 schema、`llm.ts` 注入 key、`aiConstants.ts`、测试。app 行为不变，无需出包；部署 `labprojects` 也不必。
- **P1（本仓库 functions）**：扩 `sync-lab-core.mjs` 同步 `functions/src/labCore/`；`recordingAiTurn` + `recordingAi/{context,tools,store}.ts`；`labReports` 新字段与 `clearLabReport` 改写；`onExperimentDeleted` 级联；`firestore.rules` 加 `aiThreads`；`storage.rules` 加 `aiThreads/` 前缀（服务端写、本人读）。旧 callable 保留。部署 functions → rules。
- **P2（本仓库 src）**：先 `npm run sync:lab-core`（`core/` 落后 app HEAD：`types.ts` 的 `device` 字段、`runStatus.ts` 的 `tool:web_search` 文案）；`services/recordingAi.ts`、`useRecordingAi.ts`、两个 tab 重写、CLAUDE.md。`tsc -b` + `vite build` + lint 基线不涨。部署 hosting。
- **P3**：真机 QA（长录像首读、Stop、刷新续跑、非 owner 线程、照片组）；观察一轮后按 §4 退役旧服务端。

## 6. 待用户定的决策

- **A. 报告请求是否共用 Ask AI 线程**（推荐共用，和 app 一致：模型写报告时知道刚才聊了什么；Generate 就是线程里的一轮）；备选每次报告独立线程。
- **B. 报告图的归属**：`write_report` 嵌的 `image:ID` 指向 owner 线程里的图，访客读报告要能读到这些图 → 落盘时把被嵌的图复制到 `labReports/{id}` 名下（Storage `labReports/{id}/{imageId}.jpg`，推荐），还是放开线程图的读规则。
- **C. 模型每轮可换 vs 线程首条后固定**（推荐每轮可换，保留网页今天的习惯；app 固定是因为有 project）。
- **D. 旧 `qaTurns` / 旧 `labReports` 字段**：不迁移、不显示（推荐）；旧报告（有 `[figure]` 标记、无 `images`）用一个最小兼容渲染（标记原样显示为文字）还是提示 Regenerate。
- **E. Ask AI 是否对非员工开放**：今天两个 tab 都 staff-only（`workspacePanel.tsx`）；app 的 Experiments 对所有账户开放并限流。推荐随 app 放开，走 `aiAccess` 的一般档限流 + 同意书。
- **F. `video` 类型（老 showcase .vir）**：`cloudTake` 不读 `.vir`；一期不给 AI tab（推荐），或给 `cloudTake` 补 `.vir` 帧源（网页已有 `virImport` 同类解码）。

## 7. 风险

- **首条消息 / 首次报告变慢**：浏览器先做 `takeOverview`（最多抽 1,200 帧）再发；模型随后 `run_code` 读全量帧也在浏览器下载（长录像首读分钟级，`run_code` 描述里已如实写明）。状态行要如实显示。
- **生成报告必须开着页面**：工具在浏览器跑，关掉 tab 则 pending 停在那；回来续跑。今天的报告是纯服务端、关页面也能写完。
- **报告形态变化**：没有自动帧图、数字核验、AI 探针；质量取决于模型是否主动 `look sheet` / 画图——这是 app 那边已接受并多轮调过的取舍（决策 ㊽ / 56 / 63）。
- **两份服务端代码**：`labCore/` 靠同步脚本；忘同步会出现「同一句提示词两边不同」。`SOURCE.md` 记 commit；app 仓库 PR 描述加一句「网页 functions 要同步」。
- **成本结构变化**：每问多步模型调用（最多 10 次）而非一次；`aiAccess` 的 10/30/200 限额按「请求」计，与 app 的 15/50/600 对齐与否可在 `config/aiLimits` 调。

## 8. 否决记录

- v1（2026-10-19 上午）：录像绑 lab project、tab 嵌 Discuss / ReportTab、服务端全在 app 仓库。用户否决：网页录像不要讨论区，只要 Ask AI 与生成报告两项，合并进现有功能。
- 只换提示词、保留服务端 summary / deepReport 工具：模型能力与 app 不同（预算摘要 vs 自己读全量），同一提示词两边表现不一致，否。
