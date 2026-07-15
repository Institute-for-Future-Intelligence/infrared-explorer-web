# 分析页布局重构实施计划：YouTube 式滚动页 + 工作区模式

> 状态：已评审、已通过引用核对与完整性审计、待实施。基于 commit `6325c6f`（2026-07-13），文中所有 file:line 行号已逐条与代码核对，实施前如有代码变动请先复核。
>
> 本文档自包含：不依赖任何对话上下文，可在新会话中直接作为实施依据。评审过程：两轮多智能体代码调研 + 交互设计/前端架构双视角评审，结论一致。

## 0. 一句话目标

把 Experiment Analyzer 桌面端从"信息栏 | 播放器 | 图表栏"三栏固定视口布局，改为 YouTube 式可滚动页面：**首屏 = 播放器（左）+ 模式切换工作区（右），播放器下方是标题/评分/分享行；折叠线以下 = 描述、评论、相关实验**。工作区宽度约翻倍，为未来的 AI 报告、数字孪生模拟面板预留半屏级空间。

## 1. 目标布局

### 现状（桌面 ≥769px）

```
┌──────────┬─────────────┬──────────┐
│ 信息栏    │  播放器      │ 图表栏    │   .experiment-analyzer 高度锁定 100%，
│ flex:1   │  宽度=纵横比  │ flex:1   │   页面不滚动；各栏内部滚动。
│ 标题/学科 │  推导，固定   │ T(t)     │
│ Tabs:    │             │ T(x)     │   信息栏 Tabs: Description（含评分/分享/
│  描述+评论│             │ T(y)     │   评论）| Ask AI | AI Report | Related
│  AskAI   │             │          │
│  AI报告  │             │          │
│  Related │             │          │
└──────────┴─────────────┴──────────┘
```

### 目标

```
┌─────────────┬──────────────────────────┐
│  播放器      │  WorkspacePanel (flex:1) │  ← 首屏区域：min-height ≈ 视口高
│  宽度=纵横比  │  模式切换：               │    − header − 露出量；
│  推导 + 新增  │  图表(默认) | Ask AI |    │    工作区获得原来两栏的全部余量
│  横屏宽度上限 │  AI 报告 | (未来:模拟/3D) │    （约 2× 现有图表宽度）
├─────────────┴─┐                        │
│ 标题+收藏+学科  │                        │
│ 评分·浏览·分享  │                        │  ← 播放器下方标题行（YouTube 式）
├───────────────┴────────────────────────┤
│  描述正文 + 作者/发布/时长元信息           │  ← 折叠线以下，随页面滚动，
│  评论区 Comments (N)                    │    max-width ~1000px 保证可读性
│  相关实验 Related                        │
└────────────────────────────────────────┘
```

移动端（≤768px）保持现有堆叠不变——它本来就是这个架构（播放器→图表→信息区、整页滚动），本次改造是把桌面端向移动端已验证的滚动模型收敛，媒体查询分歧变小。

### 硬性约束（评审结论，不可妥协）

1. **Ask AI 绝不放到折叠线以下**。它与播放器双向耦合（见 §2.3），必须与播放器同屏，作为工作区的一个模式。
2. **图表默认模式、与播放器同屏**。播放游标、拖探针实时更新曲线、点图跳帧是产品核心交互（见 §2.2）。
3. **AI Report 进工作区**（虽零播放器耦合）：宽面板读长报告远好于 410px 窄栏，且它是未来"报告模式"的种子；staff 门控随组件走。

## 2. 已核实的代码事实（实施前请复核）

### 2.1 当前布局实现

- 页面 DOM（[experimentAnalyzer.tsx:187-197](../src/pages/experimentAnalyzer/experimentAnalyzer.tsx)）：`.experiment-analyzer > (.left-column > .left-content) + .right-content`；播放器组件内部渲染两个兄弟节点 `.chart-manager-wrapper` + `.video-player-wrapper`（videoPlayer.tsx:355-369）或 `.image-player-wrapper`（imagePlayer.tsx:904, 914）。
- 桌面三栏靠 `.right-content { display: contents }` 实现（App.css:863，整段桌面覆盖在 App.css:855-901）：`.left-column` 与 `.chart-manager-wrapper` 各 `flex:1`，播放器 `flex: 0 0 auto` 居中，宽度由视频纵横比推导（按高度撑满、宽度随比例；`.video-player-wrapper { max-height: calc(100vh - 90px) }`，App.css:567-574）。**本次改造要删除 display:contents 这个 hack，而不是扩展它。**
- 滚动容器是 `.content`（`overflow-y:auto; height:100%`，App.css:294-302）；桌面端 `.experiment-analyzer` `height:100%`（App.css:497-501）导致页面不滚。信息栏内部是全高 flex 链：`.left-content` 内滚（App.css:514-525），`.info-tabs` 每个 tabpane `height:100%; overflow-y:auto`（App.css:531-547）。
- 移动端块（App.css:1129-1300；末尾 1294-1299 是 `#thermometers-wrapper`/`.thermometer-component` 的 user-select 抑制规则，清理时勿漏）：`.experiment-analyzer` 变 column、`height:auto`，页面滚动；堆叠顺序 播放器(order:1) → 图表(order:2，每个固定 260px 高) → 信息区；`.left-content` `height:auto; overflow:visible`（App.css:1150-1162）；编辑态描述解除钳制（App.css:1163-1171）。**这个块就是折叠线以下"auto 高度模式"的现成模板。**
- 桌面工具栏是绝对定位 58px 条，覆盖在播放器 wrapper 顶部（App.css:885-900）。
- 左栏 Tabs 上方只有两样东西（experimentAnalyzer.tsx:189-194）：`ExperimentTitle`（含所有者编辑铅笔 + 右侧 `SaveToMyExperiments` 收藏按钮，experimentTitle.tsx:67-77）和 `ExperimentSubject` 学科标签。**作者/发布时间/时长/浏览数/评分/分享都不在这里——它们在 Description 标签页内部**：MetaList（description.tsx:102-119）、ActionBar = RatingStars + "N views · N ratings" + ShareLinks 七个分享网络（description.tsx:121-135，其中 :134 是 ShareLinks；shareLinks.tsx:41-61）。评论也在 Description 标签页内，"Comments (N)" Divider 之下（infoSection.tsx:39-54）。
- Tabs 实现（infoSection.tsx:31-98）：antd Tabs，`activeKey` 本地 useState，items 数组命令式构建：'1' Description（+评论）、'5' Ask AI（门控 `isStaff(user) && (Recording || Video)`）、'4' AI Report（门控 `staff && (owner || experiment.aiReport)`）、'3' Related。`effectiveKey` 在门控标签消失时回落到 '1'（:88）。子组件带 `key={experiment.id}` 以便切换实验时重挂载。
- 无任何可拖拽分隔条/自定义折叠（全库 grep 零命中）；antd 版本 ^5.19.4（antd Splitter 需 5.21+，本计划不引入）。
- 侧边导航栏在分析页桌面端自动折叠（experimentAnalyzer.tsx:142-144，`sidebarCollapsed`，stores/common.ts:36-38）。

### 2.2 图表 ↔ 播放器实时联动（必须保持同屏可见的原因）

- 播放器→折线图：橙色游标每帧移动，`ReferenceLine x={refX}` 由 `currFrameIndex` 推导（linePlot.tsx:82-92, 160；memo 比较器显式响应帧变化 :195）；父组件每帧经 `setCurrFrameImg` 重渲染（imagePlayer.tsx:428-434）。
- 折线图→播放器：`onMouseDown` 调 `updateFrame` 跳帧（linePlot.tsx:143-147）。散点图无跳帧交互。
- 探针→图表：每次换帧把 `thermometer.value` 写进 zustand `thermometerMap`（imagePlayer.tsx:294-304, 444-447）；`ScatterPlot` 订阅并每次渲染重建点（scatterPlot.tsx:133, 178-193）；`LinePlot` 在探针 x/y 变化时重建整条时间序列（linePlot.tsx:66-80）。图像上悬停探针会淡化图表其他序列（单向，linePlot.tsx:170-183）。
- 图表可单独开关：工具栏 T(t)/T(x)/T(y) 按钮切换 `experiment.graphsOptions`（toolBar.tsx:152-212）；`ChartManager` 只渲染已启用项，空则返回 null（chartManager.tsx:14-40）。
- 每图表汉堡菜单的显示设置（线宽/符号/误差棒/网格）是组件本地 useState（linePlot.tsx:60-64, scatterPlot.tsx:140-143）——**卸载即丢**。工作区切模式会卸载图表，Phase 2 必须先把这些设置提升到 store 或 localStorage。
- Recharts 隐患（仓库自己的 CSS 注释记录在 App.css:1189-1196）：`ResponsiveContainer height:100%` 在父容器高度不确定/为零时不渲染。**结论：模式切换用卸载/重挂载（数据安全：LinePlot 挂载时从 `thermalData` 重建、ScatterPlot 渲染期从 store 派生），不要用 display:none 隐藏。**

### 2.3 Ask AI ↔ 播放器耦合（不能下移的原因）

- "+ Add moment"：`requestSnapshotMoment()`（qaPanel.tsx:555, 562-573）→ store nonce（common.ts:98-102, 291-296）→ **播放器**构建快照（帧号、当前屏幕缩略图、探针实时读数；imagePlayer.tsx:883-895 / videoPlayer.tsx:338-350）。播放器必须挂载且可见。
- 点击时刻胶囊跳转：`requestKeyframeSeek`（qaPanel.tsx:394-395, 487-533 → common.ts:86-87, 265-270）→ 播放器跳帧。唯一可见反馈就是播放器动。
- 右键 "Ask about this moment"（playerContextMenu.tsx:139-155）→ `onAskMoment` 快照后 `requestOpenAnalysisTab()`（imagePlayer.tsx:379-383 → common.ts:112-113, 308-313）→ InfoSection 把 activeKey 切到 '5'（infoSection.tsx:91-94）。**Phase 2 要把这个消费端改为切工作区模式。**
- `attachedMoments` 特意放在 store 而非面板内，以便 tab 切换/面板卸载后存活（common.ts:89-96, 272-290）→ 模式切换零成本。所有分析页 AI 状态由 `clearAnalysisCaches` 清理（common.ts:329-336）。
- AI Report（aiReport.tsx）：**零播放器交互**（全文件无 seek/moment/registry 代码），只有生成按钮、模型选择、markdown 渲染（`ReportBody` 自带内滚，aiReport.tsx:20-66）。
- 另有独立的 Lab Assistant 悬浮窗（components/aiChat/，staff-only，经 `playerRegistry.controller` / `annotationRegistry.controller` 驱动播放器与标注）——**与本次改造无关，不要动它**；但注意 `playerRegistry` 由播放器挂载时发布（playerRegistry.ts:6-18），布局重构不得改变播放器的挂载生命周期语义。

### 2.4 页面可滚动后的坐标安全性（已逐一核实）

| 交互 | 现状 | 结论 |
|---|---|---|
| 新建探针落点 | `getBoundingClientRect()` + `clientX/Y` 即时计算（thermometers.tsx:61-63） | 滚动安全 |
| 探针拖动 | react-draggable `bounds="parent"`，位置为 wrapper 相对 [0,1] 比例（thermometer.tsx:86-129） | 滚动安全 |
| **探针圈半径 resize 拖拽** | `startResize` 在拖拽开始时**缓存一次** rect（thermometer.tsx:151-154），之后拿实时 `clientX/Y` 对比缓存（:156-173）；触摸滚动已被非 passive `touchmove` preventDefault 抑制（:178, :197），**桌面滚轮没有** | **要修**（见 §4-A2） |
| 标注拖动 | `toFrac` 每次 pointermove 重读 rect（annotations.tsx:321-327, 331, 357） | 滚动安全（这是修复 resize 的参照模式） |
| **播放器右键菜单** | `lastContextPos` 在右键时记录 `clientX/Y`（imagePlayer.tsx:361），菜单项点击时才消费（:344-356）；菜单打开期间滚动会使坐标过期 | **要修**（见 §4-A3） |
| 标注右键菜单 | `position:fixed` + 视口坐标 body portal（annotations.tsx:376, 440-449） | 滚动时菜单钉在视口上不跟随内容——与播放器菜单一并处理 |
| 等温线 | 纯百分比/viewBox SVG，`pointer-events:none`（isotherms.tsx:37, 51） | 无坐标计算 |

移动端已经在滚动页面下跑**同一套坐标代码**（桌面/移动只差手柄尺寸，不差数学），所以整体风险已被实战验证，仅上述两处缓存需要加固。

### 2.5 其他已核实事项

- 评论区无深链接/锚点/scrollIntoView（commentList.tsx 全文件核实）；唯一对外通道是实时数量回调（commentList.tsx:257-260，供 "Comments (N)" 标题用）。下移安全，但注意：**评论通知**（notifications.tsx:55-59）会把 "X commented on your experiment" 的点击导航到 `/experiments/{id}`（无锚点）——现在评论在默认可见的 Description 标签内，改版后落在折叠线下。Phase 3 做 Comments 锚点时应顺带让 `type==='comment'` 通知到达时自动滚到评论区（复用同一滚动逻辑）。
- 路由是 HashRouter，标签页没有任何 URL 深链接（无 `?tab=` 之类参数）；删除 InfoSection Tabs 不影响路由。
- 仓库没有任何自动化测试（package.json 仅 lint 脚本）——§6 清单为纯手动验证，实施时没有测试兜底。
- `BackToTop` 组件已支持 `.content` 滚动容器（backToTop.tsx:17），但目前只在列表页渲染，分析页未渲染。
- 编辑态描述在桌面有 20vh–40vh 钳制（content.tsx:35-40），移动端已解除（App.css:1163-1171）。
- 数字孪生/模拟：仓库零相关代码，可全新设计；未来作为工作区新模式接入，向 `thermometerMap` 写模拟探针序列即可让现有图表呈现"实测 vs 模拟"对比。

## 3. 实施阶段

> **发布顺序约束：Phase 1 和 Phase 2 必须同 PR 或 Phase 2 先行**。只上 Phase 1 会让右键 "Ask about this moment" 打开一个折叠线以下看不见的面板——这是评审标记的 blocker。Phase 3 可独立跟进。

### Phase 1：页面结构与 CSS（约 1–1.5 天）

1. **重构 [experimentAnalyzer.tsx:187-197](../src/pages/experimentAnalyzer/experimentAnalyzer.tsx)** 为纵向文档流：
   ```
   .experiment-analyzer            （column，height:auto，页面随 .content 滚动）
   ├── .analyzer-top               （flex row：播放器 + 工作区；min-height 见下）
   │     └── <VideoPlayer|ImagePlayer>   （内部仍渲染 播放器wrapper + chart-manager-wrapper/工作区）
   ├── .analyzer-title-row         （标题+收藏+学科；Phase 3 再并入评分/分享）
   └── .analyzer-below-fold        （Phase 1 暂时整体放 InfoSection，Phase 2/3 拆解）
   ```
   注意：图表/工作区由播放器组件内部渲染（数据流所需，见 §5-D），所以 `.analyzer-top` 的两列实际是播放器组件的两个兄弟节点——保留现状，只是外层不再需要 `display:contents`。
2. **App.css 改造**：
   - 删除 `.right-content { display: contents }` 及相关桌面覆盖（App.css:856-864 一带），`.right-content` 直接作为首屏 flex row 容器。
   - `.experiment-analyzer` 桌面端解除 `height:100%`，改 `min-height` 由内容驱动；首屏区域 `min-height: calc(100dvh - 72px头部 - ~56px露出量)`——刻意留出让下方 "Comments (N)" 标题露头，作为可滚动的视觉线索（老用户从未见过分析页滚动）。
   - `.video-player-wrapper { max-height: calc(100vh - 90px) }`（App.css:567-574）保留——它是尺寸上限而非定位，页面滚动不影响其正确性。
   - **补齐 ImagePlayer 的高度上限**：图像播放器今天的高度天花板完全来自 `.experiment-analyzer { height:100% }` 提供的确定行高（链条：`.image-player-wrapper` 无 max-height，App.css:590-594 → `.image-wrapper { height: calc(100% - 56px) }`，:596-599 → `.current-frame-image { height:100% }`，:601-603）。行高改为 min-height 后，百分比高度在内在尺寸计算时回退为 auto，首屏高度会变成 max(min-height, 帧自然高 + 56px 控制条 + 58px 工具栏)——高分辨率竖帧录制或 1366×768 笔记本上首屏被撑破，露出量设计全部失效。必须给图像链一个与视频 wrapper 等价的视口高度上限（如 `max-height: calc(100dvh - 头部 - 露出量)`，图像按高度缩放、`width:auto`）。
   - **新增横屏视频宽度上限**（本次改造引入的唯一新尺寸数学，⚠️ 有坐标系陷阱）：播放器 wrapper 加 `max-width: calc(100% - 400px - 12px gap)` 级别的约束（400px = 工作区可用下限），否则 16:9 视频在 1920px 屏上会要走 ~1600px 宽，把工作区挤到 `.chart-manager-wrapper` 的 200px min-width（App.css:726）以下。**陷阱：黑边绝不能出现在播放器盒子内部。** 所有覆盖层把 [0,1] 分数坐标映射到覆盖层盒子而非视频帧（`.video-player-thermometers` 绝对定位 `width:100%`，App.css:580-586；探针像素位置由 wrapper 的 clientWidth/Height 推导，thermometer.tsx:86, 122-133）；今天盒子恰好贴帧，是因为宽度本身就由纵横比推导。若只 cap 宽度而高度仍由视口驱动，`<video>`（ReactPlayer width/height 100%，videoPlayer.tsx:388-392）会在盒子**内部** letterbox——探针落进黑边、[0,1] 坐标与显示帧错位、`getThermometerValue` 按错位坐标读取 IR 数组。正确做法：cap 宽度的同时让高度随宽度推导（wrapper 用 `aspect-ratio`，或 max-width/max-height 成对约束），使盒子始终紧贴视频帧；多余空间留在 `.analyzer-top` 行内（对齐方式消化），绝不进盒子。ImagePlayer 同理（`<img>` 是 `height:100%; width:auto`，直接 cap `.image-player-wrapper` 会溢出裁剪，App.css:590-603）。竖屏/4:3 热像（主流场景）不触发 cap，不受影响。
   - 工作区卡片保持**确定高度**：首屏行 `align-items: stretch`，工作区高度随播放器高度——这保住 Recharts `ResponsiveContainer` 与 qa-thread/ReportBody 的 `height:100%` 链（§2.2 隐患）。
   - 折叠线以下区域套用移动端块的 auto 高度配方（App.css:1150-1171 提升为共享默认），内容 `max-width: ~1000px` 居中保证读文可读性。
   - 移动端块（App.css:1129-1300）逐条比对：与新默认重复的规则删除，只保留真正的差异（列堆叠、固定图表高、手柄尺寸）。**目标是媒体查询净减少。**
3. **滚动体验加固**（§4-A1）：`overscroll-behavior: contain` 加到首屏内所有内滚容器——qa-thread（qaPanel.tsx:77-89 styled 定义）、ReportBody（aiReport.tsx:20-26）、图表列（`.chart-manager-wrapper`）。
4. **坐标缓存加固**（§4-A2、A3）：thermometer.tsx resize 改为每次 pointermove 重读 rect；`.content` 滚动时关闭打开中的右键菜单（播放器 Dropdown + 标注 fixed 菜单）。
5. 分析页渲染 `BackToTop`（对照 homePage.tsx:148 的用法）。

### Phase 2：WorkspacePanel 工作区模式（约 1–1.5 天，与 Phase 1 同 PR 发布）

1. **前置：图表菜单设置提升**。把 linePlot.tsx:60-64、scatterPlot.tsx:140-143 的显示设置（线宽/符号数/符号大小/误差棒/网格）从组件本地 useState 提升到 zustand store（或 localStorage，按 `chart type` 键控）。否则切模式卸载图表时设置全部重置。
2. **新建 `WorkspacePanel` 组件**（建议 `src/pages/experimentAnalyzer/workspace/workspacePanel.tsx`）：
   - 顶部模式切换（antd Segmented 或 Tabs）：`charts`（默认）| `askAI` | `aiReport`。门控沿用现有逻辑：askAI = `isStaff(user) && (Recording || Video)`（原 infoSection.tsx:64-70）；aiReport = `staff && (owner || experiment.aiReport)`（原 :71-77）。门控模式消失时回落到 `charts`（对照原 `effectiveKey` 钳制，infoSection.tsx:88）。
   - `charts` 模式渲染现有 `ChartManager`（props 原样透传）；`askAI` 渲染 `QaPanel`；`aiReport` 渲染 `AiReport`。后两者保持 `key={experiment.id}` 重挂载约定。
   - 模式切换 = 卸载/重挂载（不要 display:none，§2.2 Recharts 隐患）。QaPanel 的时刻附件在 store 中存活（§2.3），无额外工作。
   - `graphsOptions` 为空时 `ChartManager` 返回 null——工作区面板本身仍渲染（模式切换条在），`charts` 模式下显示空态提示（"从工具栏开启 T(t)/T(x)/T(y) 图表"）。注意这改变了现状"三图全关 → 页面变两栏"的行为：工作区列常驻。
   - 两个播放器（videoPlayer.tsx:355、imagePlayer.tsx:904）都把现在渲染 `ChartManager` 的位置改为渲染 `WorkspacePanel`。**接受两处渲染的重复，不要现在把图表数据流提升出播放器**（原因见 §5-D）。
   - ⚠️ **ImagePlayer 的整体早退**：`if (!currFrameImg || viewModesAvailable === null) return null`（imagePlayer.tsx:901）。工作区若只在播放器内部渲染，它的存在与否会跟随首帧下载：帧加载失败（loadImage 抛错，imagePlayer.tsx:392-405）则 Ask AI / AI 报告永远不出现；模式条晚弹还会把下方内容往下推（滚动流里的布局跳动）。处理：让早退只作用于播放器媒体区域，工作区列在等待期渲染骨架占位；或首屏区域预留高度。同时定义 charts 模式加载态——VideoPlayer 现在 lineplotData 为 null 时渲染 "loading plot..." 兜底（videoPlayer.tsx:355-366），WorkspacePanel 取代它后需要等价占位。
3. **store 改造**（stores/common.ts）：
   - 新增 `workspaceMode: 'charts' | 'askAI' | 'aiReport'` 与 setter（不持久化，进入实验默认 `charts`；`clearAnalysisCaches` 一并重置）。
   - `openAnalysisTabRequest`（common.ts:112-113, 308-313）机制不变，消费端从 infoSection.tsx:91-94 挪到 WorkspacePanel：nonce 变化时切到 `askAI` 模式。可顺手更名 `openWorkspaceModeRequest`，注意同步所有触发点（imagePlayer.tsx:379-383 等）。
   - 工具栏 T(t)/T(x)/T(y) 按钮开启图表时（toolBar.tsx:152-212），若当前模式不是 `charts` 则自动切回，保证按钮有可见反馈。
4. **从 InfoSection 移除 Ask AI 与 AI Report（必须与本阶段同步，不能留给 Phase 3）**：删除 infoSection.tsx 的 '5' Ask AI 与 '4' AI Report 两个 items（infoSection.tsx:64-77）、openAnalysisTabRequest effect（:91-94）及相应门控 import，过渡期的下方 InfoSection 只剩 Description('1') + Related('3')。否则会同时挂载**两个 QaPanel**（工作区一个 + 下方标签页一个）：两者挂载时读同一个 localStorage 线程键、各自独立写回（qaPanel.tsx:60-66, 348），交错使用会静默覆盖对话轮次；且折叠线以下存在一个活的 Ask AI 面板，直接违反 §1 硬性约束 1。AiReport 同理去重。
5. **QaPanel/AiReport 宽面板适配**（轻量）：两者按窄栏设计（qaPanel.tsx:143, 166 自述 "the narrow column"），在宽工作区给对话流/报告体加 `max-width`（~760px）居中即可，遗留的窄栏权宜（GFM 表格横滚等）可顺手放宽。

### Phase 3：标题行与折叠线以下（约 0.5–1 天，可独立 PR）

1. **播放器下方标题行**：`ExperimentTitle`（含编辑铅笔 + SaveToMyExperiments）、`ExperimentSubject` 从左栏头部平移过来（experimentAnalyzer.tsx:189-194 原位置删除）。
2. **ActionBar 上提**：把 RatingStars + "N views · N ratings" + ShareLinks 从 description.tsx:121-135 提出，放入标题行第二行（或同行右侧）。⚠️ shareLinks.tsx 有分析页之外的消费者：`components/siteShareStats.tsx:2` 导入它并在首页渲染（homePage.tsx:122）——要么留在原目录，要么移到 `src/components/` 并同步两处导入，保留其默认 title prop 行为。加一个 "💬 Comments (N)" 计数入口，点击平滑滚动到评论区（数量来自 commentList 现有回调，原 infoSection 的 liveCount state 迁到新容器）。
3. **拆解 InfoSection** → 新 `BelowFold`（或直接在 experimentAnalyzer.tsx 排布）：
   - 描述正文 + MetaList（作者/发布/更新/时长，description.tsx:102-119 保留在下方）；
   - 评论区（CommentList + "Comments (N)" 标题）；
   - Related 最后（纯导航跳走型内容，排最末正确）。
   - Description/Comments/Related 组件本身自包含，搬迁只需重接 liveCount 回调。
   - infoSection.tsx 及 `.left-column`/`.left-content`/`.info-tabs` 相关 CSS（App.css:504-547）随之删除。
4. **解除桌面编辑态描述钳制**（content.tsx:35-40 的 20vh–40vh），让它像移动端一样随页面滚动。
5. 全局搜一遍被删类名（`.left-column`、`.info-tabs` 等）与 InfoSection 的引用，清干净。

## 4. 专项加固清单（Phase 1 内完成）

| # | 问题 | 修复 |
|---|---|---|
| A1 | 内滚容器滚轮到底后页面突然跟滚，播放器滑出视野 | `overscroll-behavior: contain` 于 qa-thread、ReportBody、图表列（每处一行 CSS） |
| A2 | 探针 resize 拖拽缓存 rect（thermometer.tsx:151-173），桌面滚轮中途滚动会错位 | 改为每次 pointermove 重读 rect（照抄 annotations.tsx:321-327 的 toFrac 模式），或 resize 期间 preventDefault wheel |
| A3 | 弹层与滚动脱节：右键菜单期间滚动使 `lastContextPos` 过期（imagePlayer.tsx:361, 344-356）、标注 fixed 菜单不跟随内容（annotations.tsx:440-449）；此外首屏所有 portal 到 body 的 antd 弹层滚动时都会悬空——图表汉堡菜单（chartMenu.tsx:105，调滑杆时常保持打开）、Q&A 模型 Select、学科 Select | `.content` 滚动监听：关闭任意打开的分析页弹层（一个监听器足够），或给常开弹层 `getPopupContainer` 指向滚动内容内部；lastContextPos 也可在捕获时即转为播放器分数坐标 |
| A4 | 折叠线以下不可发现（老用户没有滚动预期） | 首屏 min-height 留 ~56px 露出量 + 标题行 Comments 计数锚点（Phase 3） |
| A5 | 全高 flex 链断裂风险：工作区需要确定高度，下方需要 auto 高度，两种模式混用处易藏 bug | 工作区高度 = 首屏行 stretch（随播放器）；下方套用移动端配方；验证 qaPanel 自动滚底（qaPanel.tsx:343-346）在新容器中仍工作 |
| A6 | 宽度上限（Phase 1.2）使播放器尺寸首次依赖**容器宽度**：侧栏折叠/展开（experimentAnalyzer.tsx:142-144 的自动折叠还与探针 500ms 挂载定时器竞态）在没有 window resize 事件的情况下改变播放器大小，而探针像素位置只在 window resize 时重投影（thermometer.tsx:81-102），探针会漂离图像特征直到下一次真实窗口缩放 | `#thermometers-wrapper` 改用 ResizeObserver 触发重投影（复用 thermometer.tsx:93-99 的 onResize 逻辑） |

## 5. 设计决策记录（实施时不要"顺手优化"掉）

- **A. Ask AI 在顶部工作区而非下方**：三个播放器耦合流（§2.3）全部要求同屏。这是评审唯一的 blocker 级结论。
- **B. AI Report 在工作区而非下方**：虽无播放器耦合，但教师"对照视频审报告"是核心用法；且保持 staff 内容全部在工作区、折叠线以下纯公开/社交内容的清晰分界。
- **C. 模式切换用卸载而非隐藏**：Recharts ResponsiveContainer 零高度不渲染（仓库已知问题，App.css:1189-1196）；卸载数据安全，代价只是图表菜单设置——已由 Phase 2 第 1 步化解。
- **D. WorkspacePanel 在两个播放器内各渲染一次（接受重复）**：ChartManager 的 props（lineplotData、currFrameIndex、updateFrame…）是播放器本地状态。把工作区提升出播放器意味着重构整条图表数据流——等数字孪生面板真正需要跨播放器状态时再做，现在不做。
- **E. 不引入 antd Splitter/可拖拽分隔**：需要 antd 5.21+（现 ^5.19.4）或新依赖；工作区翻倍后需求已弱化，观察使用情况再议。
- **F. sticky 迷你播放器延后**：评论提到某时刻（"看 t=3.2s"）时用户需滚回顶部——先靠 BackToTop 顶回，若真实反馈显示痛点再做 sticky 缩小播放器或评论时间戳芯片（复用 `requestKeyframeSeek` 即可实现后者）。
- **G. 不动 Lab Assistant 悬浮窗**与 `playerRegistry`/`annotationRegistry` 机制；布局重构不得改变播放器挂载生命周期。

## 6. 验证清单（实施完成后逐项过）

> 仓库没有自动化测试（package.json 仅 lint），以下全部为手动验证，没有测试兜底。

核心联动（桌面新布局下）：
- [ ] 播放时橙色游标扫过 T(t) 曲线；拖进度条同步
- [ ] 拖动 T1/T2/T3 探针，T(x)/T(y) 散点与 T(t) 曲线实时更新；悬停探针淡化图表其他序列
- [ ] 在 T(t) 曲线上按下鼠标，播放器跳帧
- [ ] 工具栏 T(t)/T(x)/T(y) 开关图表；非 charts 模式下点击按钮自动切回 charts 模式
- [ ] 三图全关时 charts 模式显示空态提示
- [ ] 图表菜单设置（线宽/符号/误差棒/网格）在"切走再切回"后保留；CSV/PNG 导出正常

Ask AI / AI Report：
- [ ] 工作区切到 Ask AI：提问、流式回答、"+ Add moment" 快照当前帧、点击时刻胶囊播放器跳转
- [ ] 播放器右键 "Ask about this moment" → 工作区切到 Ask AI 且时刻已附加（仅 ImagePlayer/录制源——VideoPlayer 未接此菜单项，videoPlayer.tsx:200-210 未传 canAskMoment/onAskMoment）
- [ ] 切换模式后 attachedMoments 与对话线程仍在；切换实验后被 `clearAnalysisCaches` 清空
- [ ] AI Report 生成、模型选择、markdown 渲染在宽面板正常；非 staff/非 owner 门控正确（模式不出现且回落 charts）

布局与滚动：
- [ ] 竖屏热像：播放器高度贴满首屏，工作区占余量；1920×1080 与 1366×768 各验一次
- [ ] 横屏 16:9 视频：播放器被宽度上限约束、工作区 ≥400px；**在帧四角各放一个探针，位置与读数全部正确**（覆盖层盒子必须贴帧、黑边在盒子外，见 Phase 1.2 陷阱）
- [ ] 高分辨率竖帧录制在 1366×768 视口下首屏不超出视口（ImagePlayer 高度上限生效）
- [ ] 宽度上限生效时折叠/展开侧边导航，探针仍贴住图像特征（A6 ResizeObserver 生效）
- [ ] 首屏下缘露出下方内容标题；滚动顺畅；内滚容器到底不引发页面跟滚（A1）
- [ ] 页面滚动一半时：拖探针、resize 探针圈、拖标注、右键菜单全部位置正确（A2/A3）
- [ ] 折叠线以下：描述（含编辑态，无 20vh 钳制）、评分/分享（已上提则验证标题行）、评论增删、Related 跳转
- [ ] 标题/学科的所有者编辑铅笔在新位置正常；SaveToMyExperiments 弹窗正常
- [ ] BackToTop 出现并回顶

回归面：
- [ ] 移动端 ≤768px 堆叠布局与改造前一致（播放器→图表→信息内容顺序、260px 图高、工具栏在媒体上方）
- [ ] 等温线、标注、3D 表面（Modal 与浮窗）、剪辑页、IR/Visible/Blended 切换不受影响
- [ ] Lab Assistant 悬浮窗的 add_thermometer / seek_to_time / set_playback 仍工作（playerRegistry 生命周期未变）
- [ ] 视频源（VideoPlayer）与录制源（ImagePlayer）两条路径都过一遍上述核心项
- [ ] 侧边导航自动折叠行为不变；浏览器窗口拖拽缩放无布局跳裂
- [ ] 首页 siteShareStats 分享图标正常渲染（shareLinks 导入未断，见 Phase 3.2）
- [ ] 主菜单 Screenshot（html2canvas 截 `.app`，mainMenu.tsx:21-29）在分析页滚动一半时截图不空白、不偏移
- [ ] ImagePlayer 首帧加载中/加载失败时，工作区有骨架或占位，页面无大幅布局跳动
- [ ] 点击评论通知进入分析页后能看到/滚到评论区（§2.5）

## 7. 延后项（本次不做）

- sticky 迷你播放器 / 评论时间戳芯片（§5-F）
- 图表数据流提升出播放器、WorkspacePanel 去重（§5-D，等数字孪生落地时一并）
- 可拖拽分隔条（§5-E）
- 数字孪生/模拟模式本体（全新功能，另行设计；接入点：工作区新模式 + 向 `thermometerMap` 写模拟序列）