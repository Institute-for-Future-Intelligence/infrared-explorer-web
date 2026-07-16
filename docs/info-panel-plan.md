# Info 面板改造实施计划：钉底骨架 + 溯源事实 + 关键时刻

> 状态：已评审、待实施。评审过程：4 视角（科学教育/内容平台/科学仪器/信息架构）独立设计 + 3 评委（用户价值/产品一致性/工程务实）交叉打分，结论高度收敛；文中所有 file:line 已逐条与代码核对。
>
> 基线：工作树 = commit `7d5c2f0`（scrollable workspace 布局）+ 未提交的分享收敛改动（shareMenu.tsx / urls.ts / analyzerActions.tsx / experimentTitle.tsx / shareLinks.tsx 删除等），核对日期 2026-07-16。**前置条件：先把在途分享收敛改动作为独立提交落地**——Phase A 会再次修改 analyzerActions.tsx 与 workspacePanel.tsx，不能与其混在一个提交里（CLAUDE.md 会话级提交规则）。
>
> 本文档自包含，可在新会话中直接作为实施依据。实施前如有代码变动请先复核行号。

## 0. 一句话目标

解决分析页 Info 标签下半截大面积空白：**Phase A（本周，全 S 级）用"钉底排版 + 被动统计上移 + 溯源事实行"止血；Phase B（中期旗舰）上关键时刻章节条；Phase C（跟随）上结构化报告字段。不为任何未来功能留占位——留结构，不留面积。**

## 1. 设计结论

### 1.1 用户三问的定稿答案

- **(a) 挪现有功能？** 只挪两样：被动统计（views · 平均分 · 评论数，改用文档聚合字段，见 §2.2）钉到 Info 卡片底边；五个全站零露出的档案字段（sourceType/isRaw/segments/clonedFrom，thermalUnit 除外见 §6）进事实区。评分星、评论、Related、分享一律不动（折叠线下 = 纯社交；分享已单点化到 header ShareMenu）。
- **(b) 留白等未来？** 不留。数字孪生/模拟已定位为工作区新模式（tab 条席位），不占 Info 面积；占位符是负价值。钉底骨架落地后，"描述与底锚之间的中段"就是未来 Info 级内容的天然插槽。
- **(c) 什么新功能配这个位置？** 准入门槛与 Charts/Ask AI 同标准：与播放器有真实联动，或属于实验身份的事实。只批一个旗舰：**关键时刻章节条**（双向播放器耦合：快照当前帧 ← 播放器；点胶囊 → 跳帧）。第二梯队：结构化报告字段（教育价值最高，但依赖 owner 写作意愿，缩水启动）。

### 1.2 Info 面板终态骨架

```
┌─ .chart-manager-wrapper（白底圆角卡，App.css:1203-1214）──┐
│ .workspace-header  标题 + Share + 收藏（不动）             │
│ .workspace-switch  Info | Charts | Ask AI | AI Report     │
│ .workspace-body > .workspace-info（Info 模式，内滚）        │
│   ├ MetaColumns 事实区（现有 + A3 溯源行）                  │
│   ├ 描述正文（现有）                                        │
│   ├ [Phase C] What we found 结构化小节                     │
│   ├ [Phase B] Key moments 章节胶囊条                        │
│   │      （中段剩余留白 = 结构性呼吸 + 未来插槽）             │
│   └ [A1/A2] 底锚统计薄条: 👁 N · ⭐ 4.5 (12) · 💬 N          │ ← margin-top:auto
└──────────────────────────────────────────────────────────┘
```

### 1.3 一致性红线（后续所有 Info 提案的准入门槛）

- 逐帧数据分析类内容一律归 Charts（实时探针读数表/统计表若复活，做进 Charts 模式，不进 Info）。
- 分享族动作（含"复制引用"）一律归 header ShareMenu。
- 发现类内容（兄弟剪辑、作者其它实验）一律归折叠线下 Related。
- 与播放器真实双向耦合、或属实验身份事实的内容，才有资格申请 Info 席位。

## 2. 已核实的代码事实（实施前请复核）

### 2.1 布局与空白成因

- 空白容器是 `.workspace-info`（App.css:1013-1018，`flex:1; min-height:0; overflow-y:auto`）；白底圆角卡的皮是外层 `.chart-manager-wrapper`（App.css:1203-1214，背景 `var(--ifi-panel)` + radius 12px + 阴影 + `overflow:hidden` + padding 12/16px），`.workspace-panel` 本身无背景（App.css:943-948，注释 940-942 明说）。
- 桌面首屏定高：`.analyzer-top` 在 App.css:1354-1362（`@media (min-width:769px)` 块起于 1348）`height: calc(100vh - 90px)` + `align-items:stretch`——这给钉底提供了确定高度容器。⚠️ 1349-1353 有一段过时注释（说 title "peeks"，与行内注释 "no peek" 矛盾），A4 顺手修。
- 模式切换互相卸载（workspacePanel.tsx:26-28 注释、89-107 条件渲染）：**任何只作用于 `.workspace-info` 的布局手段对 Charts 的 recharts 确定高度零影响**。Info 分支在 workspacePanel.tsx:89-93。
- 移动端（≤768px，块起于 App.css:1516）对 `.analyzer-top` 与所有 `.workspace-*` 类零覆盖，`.chart-manager-wrapper` 在 1723-1730 改为 `flex:none` 内容定高——**margin-top:auto 钉底在移动端因无剩余空间自动退化，无害，无需显式禁用**（若改用 sticky/absolute 则必须显式关掉，不要用）。
- `.analyzer-info` 类名（infoSection.tsx:22）在 App.css **没有任何规则**，纯无样式包装 div——不要引用。折叠线下有样式的是 `.analyzer-info-cols`（App.css:916-931 基础 + 1380-1388 桌面双列）。

### 2.2 统计与评分（A2 的关键依据）

- **useRatings 无共享缓存**（rating.tsx:16-40）：每次挂载各自 `getDocs` 整个 ratings 子集合，`rate()` 只 refetch 本实例（:46-58）。若 Info 和折叠线下各挂载一次 = 2×N 次文档读且互不同步。**结论：Info 底锚统计条不用 useRatings**，改读文档聚合字段 `experiment.ratingSum / ratingCount`（types.ts:131-132，Functions `aggregateRatings` 维护，克隆置 0，卡片 CardMeta 就是这个数据源）——零额外读取。折叠线下评分星保持唯一的 useRatings 挂载点，不动。
- 底锚条与折叠线下均值在打分后短暂不一致（聚合函数延迟），与"卡片 vs 分析页"的现状一致，可接受。
- 视觉词汇对齐卡片：card.tsx:361-372——`EyeOutlined + 数字`、`MessageOutlined + 数字`、`StarFilled(#fadb14) + avg.toFixed(1) + 淡色 (count)`，无评分显示 `–`；弱化样式可复用 `.rating-meta`（App.css:933-938）。
- 评论数：Info 侧用 `experiment.commentsId.length` 快照（experimentAnalyzer.tsx:107 加载时写入，L188 Spinner 守卫保证就绪）；折叠线下 liveCount（infoSection.tsx:18-19）不上提。
- viewCount 是加载时快照，本次访问的 recordView(+1) 在加载后才发生（experimentAnalyzer.tsx:149-155）——数字口径如被追问可加 tooltip，不算 bug。
- analyzerActions.tsx（未提交版）现状：useRatings :36，views/ratings 文案 :38-46，评分星 :56，均分 :57-61。A2 之后它只剩评分星 + 均分。

### 2.3 评论锚跳（必须用 JS，不能用锚点链接）

- 路由是 `createHashRouter`（App.tsx:2,27）：`<a href="#comments">` 会被解析成路由路径 `/comments` → errorElement。**必须用 JS 滚动**。
- 页面滚动发生在 `.content` 容器（App.css:294-302）而非 window；`id="comments"` 已埋好（infoSection.tsx:26）但全库无消费者（infoSection.tsx:15 的注释"anchors the jump here"描述的跳转尚不存在——A2 实现它）。实现：`document.getElementById('comments')?.scrollIntoView({ behavior:'smooth', block:'start' })`，天然相对 `.content` 滚动，无需算 offset。

### 2.4 溯源字段与帧↔秒换算（A3 的关键依据）

- 字段：sourceType（types.ts:43）、duration（:56）、thermalUnit（:61）、trash（:65）、isRaw（:66，注释：mirrors segments == null）、segments（:67，`Segment = { start; end }` 帧号见 :23）、clonedFrom（:71-74，注释：isRaw 单独不能区分原始录制与未剪辑副本）。
- **duration 是源实验时长，剪辑克隆不重算**（cloneExperiment :400、cloneExperimentById :313 都原样复制）——clip 文档的 Duration 行（description.tsx:118-119）当前显示的是**原始时长**而非剪辑后时长。剪辑后时长 = Σ(end−start+1)/FPS（实施时对照 hooks.ts:6-23 createMapAndArray 的折叠逻辑核对 ±1）。
- 帧→秒：全局常量 `FPS = 5`（constants.ts:14；hooks.ts:67 还有个硬编码字面量 5，两处重复可顺带指出）。recording 帧 1 起始（hooks.ts:44-46 注释），原始录制时间 t = (frame−1)/FPS。**仅凭文档字段换算成立的前提是 sourceType=Recording**；Video 的每帧秒数 = duration/totalFrameCount，帧总数在 .vir 里不在文档中——但 videoPlayer 对 segments 零引用（grep 证实），所以 A3 的剪辑范围行按 Recording-only 设计即可。
- clonedFrom 反查：`getDoc` 一次，read 规则（firestore.rules:34-36）= public/unlisted/owner/staff，**完全不看 trash**。删除有两级：setTrash 标志位（experiments.ts:30-32）与 trash 页硬删（deleteExperiment :198-200）。⚠️ 非 staff 读已硬删文档得到的是 **permission-denied 而非 exists()==false**（规则对不存在文档求值出错），与"源是私有"不可区分——降级分支必须合并：getDoc 失败/不存在 → **整行静默消失**；读到且 trash:true → 正常链接（tooltip 注明 in trash 亦可）。

### 2.5 moment 机制（Phase B 的全部依赖）

- 桥（stores/common.ts）：`keyframeSeek {playerIndex, nonce}`（:111-112 声明、:310-315 实现）；`snapshotMomentRequest {nonce}`（:123-127、:336-341）——**裸 nonce，无用途字段，这就是加 purpose 的位置**。注释明言只有播放器能构建快照（独占帧号/屏上图像/实时读数），Phase B 必须沿用同一桥。
- `attachedMoments`（:114-121、:317-335）：去重键 recordingIndex（同帧重挂替换）、cap-3 静默忽略、按 tSeconds 排序、发送时被 qaPanel.tsx:413 清空——**语义与章节条冲突，keyMoments 必须另起数组**。`clearAnalysisCaches`（:392-403）清 moment 全家并重置 workspaceMode='info'——keyMoments 必须加进去，否则串实验。
- QaMoment（types.ts:211-222）：`{recordingIndex, tSeconds, thumbnail, readings[]}`；recordingIndex 用录制帧空间（注释：durable across re-trim）。⚠️ **thumbnail 是全尺寸帧 data URL**（imagePlayer.tsx:248 直接用 currFrameImg，即 FileReader.readAsDataURL 产物，无降采样；chip 仅 CSS 缩到 44px）——内存态无妨，**持久化绝不能存**。
- imagePlayer：快照函数 :219-253（staff 门 :224 `canAskMoment`，其定义 :70-73 = isStaff；text-only 门 :227；cap-3 前置检查 :235-238 带提示；路由写死 addAttachedMoment :245；tSeconds = playerIndex/FPS :247）；桥消费端 :887-903（latest-ref 订阅，purpose 透传只改 :900）；右键菜单接线 :378-384（onAskMoment = 快照 + requestOpenAnalysisTab）。
- videoPlayer：快照 :295-332（staff 门内联 :301；recordingIndex 直接用 .vir 帧号；**thumbnail 恒 ''**——跨域 video 无法安全取帧，章节条必须支持无图 pill 形态；路由 :322）；桥消费端 :336-352（purpose 透传只改 :349）；右键菜单**未接** moment 参数（:201-211，buildPlayerContextMenu 本身已支持，playerContextMenu.tsx:86-92, 139-156）。
- qaPanel：chip 是内联 JSX 非独立组件（已发送 :479-506，`.qa-qm` 44×34 / `.qa-qm-pill` 无图药丸；托盘 :527-548 `.qa-chip` 52×40）——章节条要么抽共享组件要么复制样式；跳帧映射规则 :392-395 `requestKeyframeSeek(isVideo ? ri : getPlayerIndex(ri))`（useMappingIndex 挂载 :331）；"+ Add moment" :561-573 只发裸 nonce。
- 持久化先例（services/ai.ts:123-156）：StoredQaTurn 的 moments **只存 {recordingIndex, tSeconds}**。⚠️ 读取时缩略图**不重建**——渲染成 qa-qm-pill 文本药丸，没有按 recordingIndex 重取帧的代码路径（imagePlayer fetchImage :387-391 是现成取帧函数但无人这样用）。Phase B 二期照抄"只存索引"形状，历史缩略图重建是可选新增。
- 服务端（ai.ts:22-44）：answerExperimentQuestion 自带 staff 门 + cap-3 复验。**keyMoment 用途不经过任何 AI callable，准入完全独立，不会放开 Ask AI**。

### 2.6 规则与克隆白名单（Phase B/C 的关键依据）

- **update 规则是黑名单不是白名单**（firestore.rules:59-70）：只禁 ownerId + 4 个聚合字段（featured 另有 staff 条款）。owner 客户端 updateDoc 写新字段（findings/keyMoments）**直接放行，Phase B/C 不需要改 rules**。代价是新字段无类型/大小校验（对比 comments 的 size 限制）——keyMoments 客户端自设上限即可。
- updateDescription 是纯客户端 updateDoc（experiments.ts:40-42，写 {description, updatedAt}），setTrash/renameExperiment/updateSubject 同构——Phase B/C 的保存函数照抄。
- 克隆字段清单是**两处手写对象字面量**：cloneExperimentById :305-333（clonedFrom :323；调用点 saveToMyExperiments.tsx:66 与 classroomApi.ts:447）、cloneExperiment :389-419（clonedFrom :410；调用点 imagePlayer doSaveClip :782-817）。新 doc 字段若需随克隆携带，**两处都要加**。参照：aiReport 不随克隆；description 随克隆。

## 3. Phase A：止血包（S 级，一个 PR，前置 = 在途分享改动先落地）

### A1 钉底排版

1. workspacePanel.tsx Info 分支（:89-93）改为：
   ```tsx
   {effective === 'info' && (
     <div className="workspace-info">
       <Description experiment={experiment} />
       <InfoFooter experiment={experiment} />
     </div>
   )}
   ```
2. App.css `.workspace-info`（:1013-1018）加 `display:flex; flex-direction:column`；新增 `.workspace-info-footer { margin-top:auto; padding-top:12px; }`。内容短 → footer 贴卡片底边；内容长 → footer 在滚动流末尾；移动端自动退化（§2.1）。
3. 明确不做：垂直居中（内容溢出裁顶 + 观感割裂）、按模式取消卡片拉伸（切 tab 高度跳变 + 底边与播放器参差）、sticky/absolute 钉底（移动端要额外关）。

### A2 底锚统计薄条 + AnalyzerActions 减重 + 评论锚跳

1. 新建 `src/pages/experimentAnalyzer/infoSection/infoFooter.tsx`：一行弱化统计，数据全部来自文档（§2.2，**不挂 useRatings**）：
   - `EyeOutlined {experiment.viewCount ?? 0}`
   - `StarFilled {ratingCount ? (ratingSum/ratingCount).toFixed(1) : '–'} ({ratingCount ?? 0})`
   - `MessageOutlined {experiment.commentsId?.length ?? 0}`，onClick = `document.getElementById('comments')?.scrollIntoView({behavior:'smooth', block:'start'})`（§2.3，不能用 href 锚点）
   - 图标+文案格式对齐 card.tsx:361-372；字号/颜色复用 `.rating-meta`（App.css:933-938）；保持一行低对比密度，不放头像/大部件。
2. analyzerActions.tsx 减重：删除 viewsPart/ratingsPart 拼装与 `.rating-meta` span（:38-46, :52-55），只留评分星 + 均分（:56-61）。折叠线下 = 纯社交动作，完成收敛。
3. 顺手把 infoSection.tsx:15 的过时注释改为如实描述（跳转由 InfoFooter 触发）。

### A3 溯源事实行（description.tsx）

1. 插入点：左组 MetaList 的 Author 块之后、`</MetaList>` 之前（:129/:130 之间），照抄现有布尔开关 + `{flag && (<><dt/><dd/></>)}` 模式（:77-99）。
2. 新行（全部自动缺席，不留空行）：
   - **Origin**：`clonedFrom` 不存在且 `segments == null` → "Original capture"；`segments != null` 且 sourceType=Recording → "Clip · 0:05–0:33"（单段；多段 → "3 segments · 0:28 total"）。秒数 = (frame−1)/FPS，FPS 从 constants.ts:14 导入（§2.4）；Video 的 segments 恒 null 不触发。
   - **Cloned from**：`clonedFrom` 存在 → getDoc 反查源实验（新建小 hook `useClonedFrom(expId)` 或 service 函数），成功 → `<Link to={/experiment/…}>{源 displayName}</Link>`（trash:true 时 tooltip 注明）；permission-denied / 不存在 / 失败 → **整行静默消失**（§2.4 的合并降级分支）。
3. **Duration 行口径修正**（可选但推荐）：segments 存在的 Recording 剪辑显示剪辑后时长 Σ(end−start+1)/FPS，`title` 注明 "clip of a {formatDuration(duration)} recording"；实施时与 hooks.ts:6-23 的折叠逻辑核对 ±1。
4. 不做：Type 独立行（Origin 已隐含，控密度）、thermalUnit 行（与全局显示单位 store.temperatureUnit 无联动，语义易混，见 §6）、"谁克隆了我"反向查询（需新增复合索引）。

### A4 注释修正（顺手，零行为变化）

- common.ts:140-144："Charts is the default … resets to 'charts'" → 实际默认 'info'（:360）且 clearAnalysisCaches 重置 'info'（:401），改对。
- App.css:1349-1353：删掉与行内注释矛盾的过时 "peeks" 段。
- rating.tsx:11-14 与 analyzerActions.tsx:9-12 的头注释按 A2 后的实际分工重写（passive counts 在 Info 底锚、stars 在折叠线下、数据源分别是 doc 聚合与 useRatings）。

## 4. Phase B：关键时刻章节条（M 级，两期，排 Phase A 之后）

### B1 一期：内存版（owner 标记、当次会话可见）

1. **store**（common.ts）：新增 `keyMoments: KeyMoment[]`（`KeyMoment = QaMoment & { label?: string }`）+ add/remove/relabel/clear；去重键 recordingIndex（同帧替换）、按 tSeconds 排序（照抄 :317-335 的模式）、客户端上限 12（带提示）；**加入 clearAnalysisCaches（:392-403）**。
2. **purpose 分流**（§2.5 最小路径）：
   - common.ts :123-127/:336-341：请求体改 `{ nonce, purpose: 'qa' | 'keyMoment' }`，`requestSnapshotMoment(purpose = 'qa')`——qaPanel 两处现有调用（:555, :564）不用改。
   - imagePlayer 三处：:900 透传 `prevSnapshot.purpose`；snapshotCurrentMoment(purpose) 内部把 staff 门（:224）、text-only 门（:227）、cap-3（:235-238）限定在 `purpose==='qa'` 分支，`keyMoment` 分支门 = isOwner；:245 按 purpose 路由到 addAttachedMoment / addKeyMoment（:231-250 快照主体两用途共享）。
   - videoPlayer 三处同构：:349 透传；:301/:304/:311 三道门按 purpose 分支；:322 路由。video 产物 thumbnail:'' → 章节 chip 必须有无图 pill 形态（复用 qa-qm-pill 的样式思路）。
   - **'qa' 分支的 isStaff 检查原样保留**（服务端 answerExperimentQuestion 另有兜底门）；keyMoment 用途不经过 AI callable，准入独立。
3. **UI**：新建 `src/pages/experimentAnalyzer/infoSection/keyMoments.tsx`，挂在 Info 面板描述与 InfoFooter 之间：
   - 横向胶囊条：缩略图（有则 img，无则 pill）+ `fmtTime(tSeconds)` + label；chip 样式从 qaPanel 抽共享组件或复制（§2.5，qaPanel 无现成可 import 的组件）。
   - 点击跳帧：照抄 qaPanel.tsx:392-395 的映射（`requestKeyframeSeek(isVideo ? ri : getPlayerIndex(ri))`，useMappingIndex(segments, duration)）。
   - owner 专属："+ Mark this moment" 按钮 → `requestSnapshotMoment('keyMoment')`；chip 上重命名（inline input）与删除。
   - 空态：owner 见邀请文案（"在播放器停在关键画面时标记它"），访客整条隐藏。
4. 可选：imagePlayer 右键菜单加 "Mark this moment"（:378-385 参数处，门 = isOwner）；video 右键首次接线（:201-211）可延后。

### B2 二期：持久化（验证一期交互有人用之后）

1. doc 字段 `keyMoments: { recordingIndex: number; tSeconds: number; label?: string }[]`——**照抄 StoredQaTurn 的精简形状（§2.5），缩略图/readings 一律不存**（thumbnail 是全尺寸 dataURL，进 Firestore 是文档体积炸弹）。
2. 保存：照抄 updateDescription 模式的客户端 updateDoc（rules 黑名单直接放行，§2.6）；owner 增删改后防抖写回。
3. 读取：从 experiment.keyMoments 水合章节条，渲染为 pill（无缩略图；当次会话新标记的仍带图）。历史缩略图重建（fetchImage :387-391 按 recordingIndex 取帧）是可选增强，默认不做。
4. 克隆：两处白名单（:305-333、:389-419）都携带 keyMoments——recordingIndex 用录制帧空间，re-trim 后仍有效（types.ts:211-222 注释）；**显示端过滤**：moment 的 recordingIndex 不落在当前 segments 任何区段内 → chip 隐藏（防剪辑把关键帧剪掉后死 chip）。
5. types.ts 补 ExperimentDoc/Experiment 字段声明。

## 5. Phase C：结构化报告字段（缩水启动，可与 B 并行但建议串行）

1. **v1 只做一节**："What we found"（结论）。doc 字段 `findings?: string`；观察真实填写率再决定扩到 研究问题/假设 三段（届时再抽通用 EditableSection，v1 不预先抽象）。
2. UI：Info 面板描述正文之下、章节条之上；标题 + 正文。**访客在字段为空时完全不可见；owner 见 "Add your findings" 邀请**——照抄 content.tsx 的空态与编辑模板（owner 判定 :99、EditTrigger :225-232、聚焦 :125-136、flush 幂等保存 :141-154、卸载兜底 :163-165、Cancel :173-176）。
3. 保存函数照抄 updateDescription（experiments.ts:40-42），写 {findings, updatedAt}；rules 零改动（§2.6）。
4. **克隆白名单两处同步加 findings**（:305-333、:389-419，参照 description 随克隆的先例）——漏加即静默丢数据，这是本阶段最大的雷。
5. 分工叙事写进代码注释：Info 的结构化小节 = 作者人写的论证；AI Report = AI 产出；这些字段后续可作为 Ask AI / 报告生成的上下文输入。

## 6. 设计决策记录（实施时不要"顺手优化"掉）

- **A. 底锚统计不用 useRatings**：它无共享缓存、双挂载 = 双倍读且互不同步（§2.2）；doc 聚合字段是卡片同款数据源。不要为此给 useRatings 加 store 化改造——单挂载点现状下没有收益。
- **B. 评分星留在折叠线下**：打分是社交动作，与评论同区；上移会稀释刚收敛纯粹的"折叠线下 = 社交"边界。
- **C. keyMoments 与 attachedMoments 严格分离**：后者 cap-3、发送清空、是 Ask AI 的提问附件；共用必炸。视觉/文案也要区分（章节 = 导览，moment = 提问附件）。
- **D. 持久化只存索引**：thumbnail 是全尺寸帧 dataURL（§2.5），严禁进 Firestore。
- **E. 否决清单**（评审一致结论）：Coming soon 占位；按模式取消卡片拉伸；垂直居中；实时探针读数表（画面 + Charts 之外的第三份重复，若复活归 Charts）；同录像剪辑合集条上移（Related 已履职）；"谁克隆了我"反向查询；重型作者卡（现场聚合查询）；thermalUnit 事实行（与全局显示单位无联动易误导）；CSV/引用卡进 Info（引用 → ShareMenu 菜单项、CSV 可发现性 → Charts 侧，均延后）。
- **F. hooks.ts:67 的硬编码 5 与 constants.ts FPS 重复**：A3 只指出不修改；若将来支持变帧率需统一。

## 7. 验证清单（手动，仓库无自动化测试）

Phase A：
- [ ] 桌面短描述实验：统计条贴卡片底边，中段留白呈"上内容/下收边"节奏；长描述：`.workspace-info` 内滚、统计条在滚动流末尾
- [ ] 移动端（≤768px）：卡片内容定高，footer 自然跟在内容后，无空洞、无异常拉伸
- [ ] 统计条数字与卡片（列表页）一致；无评分显示 `–`；点评论数平滑滚到折叠线下评论区（HashRouter 路由不跳错页）
- [ ] 折叠线下只剩评分星+均分；打分后星区均值即时刷新（统计条允许滞后）
- [ ] Origin/Cloned from 行：原始录制、剪辑（单段/多段）、克隆副本三种实验各验一次；私有/已硬删/回收站源的克隆副本 → Cloned from 行静默消失或正确降级
- [ ] Duration 口径（若做 A3.3）：剪辑显示剪辑后时长、tooltip 显源时长；原始实验不变
- [ ] Charts / Ask AI / AI Report 三个模式外观与行为零变化（钉底只在 Info 分支）
- [ ] 非 staff 访客视角（只有 Info|Charts 两个 tab）过一遍上述各项

Phase B（每期都过）：
- [ ] {recording, video} × {owner, staff 非 owner, 访客} 矩阵：标记按钮/右键项只对 owner 出现；Ask AI 的 "+ Add moment" 行为与 staff 门完全不变（cap-3、text-only 提示原样）
- [ ] recording：标记 → chip 带缩略图；点击 chip 跳帧正确（有 segments 的剪辑重点验证 getPlayerIndex 映射）；video：pill 形态、直传帧号跳帧正确
- [ ] 重命名/删除/上限提示；切 tab 后 keyMoments 仍在；切换实验/离开分析页被 clearAnalysisCaches 清空
- [ ] B2：刷新后水合为 pill；克隆副本携带 keyMoments；剪辑后不在 segments 内的 moment 不显示；Firestore 文档体积无缩略图
- [ ] Lab Assistant 悬浮窗与 playerRegistry 不受影响（快照桥只加了 purpose）

Phase C：
- [ ] owner：空态邀请 → 编辑 → 保存/取消/卸载兜底；访客：字段空时完全不可见、有值时只读
- [ ] Save to My Experiments 与 Save clip 两条克隆路径都携带 findings
- [ ] 编辑后 updatedAt 刷新；未改动关闭不产生空写（幂等 flush）

## 8. 延后项（本次不做）

- 探针全程 Min/Max/Δ 统计（若做，归 Charts 模式，可与 CSV 导出一次接线摊销）
- "复制引用" ShareMenu 菜单项；CSV 导出入口的可发现性（Charts 侧）
- 历史 keyMoments 的缩略图重建（fetchImage 路径）
- Q&A 章节打通（"章节 → 附到提问"）；AI Report 引用章节
- 报告字段扩到 研究问题/假设 三段 + 通用 EditableSection 抽象（等 findings 填写率数据）
- 评论通知落地后自动滚到评论区（复用 A2 的 scrollIntoView，等通知点击路径改造时一并）
