> **实施进展(2026-06-23,P0–P5 已落地,tsc + build 绿)**
>
> 本报告的高/中优先级缺口已实现:
> - **P0 核心交互**:温度计 新增/拖放/删除/全部删除/选中态;ToolBar "Add a thermometer";播放器右键菜单(`stores/common.ts`、`thermometers/*`、`toolBar.tsx`、`imagePlayer.tsx`、`videoPlayer.tsx`)。
> - **P1 导出**:`html2canvas` 合成截图(图像+温度计+标注+等温线);图表 hamburger 菜单(Save as image / Export CSV);折线图 Legend + tooltip formatter;散点图 per-thermometer 颜色/形状;时间戳文件名(`utils/exporters.ts`、`charts/*`)。
> - **P2 数据完整性**:`onExperimentDeleted` 递归删除子集合 Function;评论删除确认弹窗;评论 tab 计数实时刷新。
> - **P3 画廊**:学科标签、卡片 hover 元信息(评分/views/作者/描述)、首页 AutoComplete 搜索、卡片菜单(改标题/新标签打开/移入回收站)(`components/card/*`、`homePage.tsx`)。
> - **P4 静态页/chrome**:`/about`、`/contact`(写 `contactMessages`,含规则)、Cookie 横幅、全局 Spinner、Footer(版本+版权+Contact)、实验找不到的 `<Empty>`、ErrorPage;mainMenu 加 About/Contact。
> - **P5 收尾**:温度计/折线序列 1-based(T1…);移入回收站确认+toast;窗口 resize 温度计重投影。
>
> **仍未做(明确边界)**:登录页/账户两栏重设计、列表分页 Load More、滚动位置恢复、PWA/manifest/GA/per-route title/remoteLogger 埋点、localDB 离线缓存、标注引线(dx/dy)+时间窗、角色/Users 管理(决策延后)、以及若干 low 视觉差异。
> **需你执行**:`cd functions && npm i` 后 `npm run deploy:functions`(含 onExperimentDeleted)→ `npm run deploy:rules`(含 contactMessages 规则)→ `npm run deploy`;然后运行时冒烟。
>
> ---

# Telelab → Infrared Explorer Web 移植终审缺口分析报告

> 日期 2026-06-23 · 方法:13 个区域多智能体对比 telelab(`D:\IFI\telelab\client\src`)与本项目(`src`),
> 对每条"缺失/部分/不同"声明做**对抗式核验**(假设声明为假、在新代码里穷尽搜索),仅保留 `isRealGap=true` 的真实缺口。
> 对照基准:`docs/telelab-migration.md §12`(同日声明"可编码范围已全部完成")。
> 直播相关(Agora/机器人/聊天/在线/等候室/blurredImg)按既定决策剔除,**不计入缺口**。

---

## 1. 结论速览

移植结果是 **"核心数据通路对齐、外围 UI 与交互大面积缩水"**,而非 telelab 的"全部功能 + UI 复刻完成"。
共确认 **167 条真实缺口/差异**,其中 **high ≈11、medium ≈33,其余为 low / 实现-视觉差异**。

- **已落地(与 telelab 对齐)**:Firestore 合并集合、克隆(只存引用)、多段裁剪、回收站软删/恢复/彻删、Recent/Raw/Related、评论增删改+回复、评分写入+聚合读、通知中心、标注(增/拖/改/删)、测量区域(点/矩形/椭圆 + ＋/－)、等温线(自带 marching-squares + 图例)、°C/°F 切换、CSV(T(t))+ 帧 PNG 导出、分析持久化、分享链接、账户设置基础表单。
- **最严重的未披露缺口**:**新增 / 删除 / 选中温度计这一最基础的分析交互不存在**。`stores/common.ts` 只有 `setThermometer/updateThermometer`,没有 create/remove/select;`ControlBarButtons.addThermometer`(`types.ts:141`)、`takeScreenshot`(`types.ts:150`)是**死枚举**。结果:分析页只能查看预置温度计、无法自由布点/删点。
- §12 的"明确未做"清单 **真实但不完整**:它诚实披露了 html2canvas/缩略图/拖拽手柄/App Check 四类,却**遗漏了温度计增删选、播放器右键菜单、图表选项菜单与导出、删除级联清理、画廊搜索/卡片菜单、静态页(About/Contact/Cookie/Footer)** 等同样可编码、与直播无关的缺口。

---

## 2. 真实缺口(按严重度 高 → 低)

### 2.1 HIGH —— 阻断性 / 基础能力缺失

| 功能 | telelab 现状 | 新 app 现状 | 文件参考 | 建议补法 |
|---|---|---|---|---|
| **新增温度计(工具栏按钮)** | controlBar `ThermometerSVG` "Add a thermometer" → onAddThermometer | `toolBar.tsx:45-67/110-163` 只有 T(t)/T(x)/T(y)+单位+等温线+裁剪;`addThermometer` 死枚举 | `toolBar.tsx`、`stores/common.ts:70-81`、`types.ts:141` | ToolBar 加 Add 按钮 → `common.ts` 增 `createThermometer`(默认 0.5,0.5),接通枚举 |
| **拖放添加温度计** | imagePlayer `useDrop` + `getLimitedThermoXYRatioInTarget` | 无 useDrop/react-dnd;无 `utils/thermometer.ts` | `imagePlayer.tsx`、`videoPlayer.tsx` | 引入 react-dnd 或原生 drop,落点转 [0,1] 后 create |
| **删除温度计 / 全部删除** | 拖到 TrashSVG、Delete 键(确认框)、右键 Delete All | `common.ts` 仅 set/update,无 remove | `stores/common.ts`、`thermometer.tsx:120-176` | 增 `removeThermometer/removeAllThermometers`;UI 给删除入口 + `Modal.confirm` |
| **温度计选中态 + 选中色** | per-thermometer selected 驱动菜单/手柄/键盘 | `thermometer.tsx:67` 硬编码 `selected=false`,选中分支死代码 | `thermometer.tsx:67/88-96`、`stores/common.ts` | store 加选中态,背景点击取消选中 |
| **图像/视频右键上下文菜单** | antd Dropdown trigger=contextMenu(测量区 Radio + Delete + 截图 + Delete All) | 无 onContextMenu;播放器是裸 div | `imagePlayer.tsx:341-385`、`videoPlayer.tsx:146-176` | 用 antd `Dropdown` 包裹播放器聚合各项 |
| **合成截图(player→PNG 含叠加层)** | exportElementToPNG('image-player-container') | `imagePlayer.tsx:377-384` 仅 `downloadDataURL('frame.png')`(裸帧);`takeScreenshot` 死枚举 | `imagePlayer.tsx`、`exporters.ts:31-34` | 装 html2canvas 合成,纳入温度计/标注/等温线 |
| **图表选项菜单 + PNG 导出**(line/scatter) | lineplotMenu/scatterplotMenu(PNG/宽度/符号/网格) | line 仅裸 CSV;scatter 连导出都没有 | `charts/linePlot.tsx:84-104`、`charts/scatterPlot.tsx` | 移植 hamburger 菜单 + html2canvas PNG |
| **首页搜索(AutoComplete)** | 居中搜索框,按 name/subject/author/description 过滤 | `homePage.tsx:12-58` 仅渲染策展 id 列表,无搜索 | `homePage.tsx` | 加 antd `AutoComplete` 过滤 |

> HIGH 项高度集中在**温度计生命周期(增/删/选)与播放器右键/截图**——telelab 交互的中枢。

### 2.2 MEDIUM —— 明显功能/UI 缺口(择要)

**画廊与首页**
- 学科标签 `SubjectTag` / 学科过滤 / 卡片 hover 元信息(实验者/描述/评分/views/comments)全缺:`card.tsx:41-71` 只有 img+name+删除键;subject 仅数据字段从不展示。
- 首页数据源:`homePage.tsx:20-39` 仅 chunked `in` 查策展子集,无 `getAllShowcases` → 失去"浏览全部"视图。
- 卡片菜单 / 重命名(Change Title):`card.tsx:45-69` 只有圆形 ×;Change Title/Withdraw/Open in New Tab 全缺;`experiments.ts` 无 displayName 的 `updateDoc`。
- Footer(版本+版权+Contact Us 链接)全缺。

**播放器**
- 设为缩略图(setThumbnail);Show Info(帧号/尺寸/时长/段数弹窗);视频播放器拖放添加 + onMouseDown 取消选中。

**温度计与测量区**
- 拖到回收区删除 / Delete 键删除(确认)/ 全部删除(确认):`thermometer.tsx` 无 DeleteArea、无键盘、无 Modal.confirm。
- 窗口 resize 重投影(partial):`thermometer.tsx:76-86` 仅挂载后 500ms 算一次,resize 后漂移。
- 位置/区域编辑持久化(different):新 app 仅显式 "Save analysis" 才写;telelab 每次移动/缩放自动保存。

**图表**
- per-chart hamburger 菜单(line & scatter)/PNG / 自定义符号 / 每温度计不同散点形状 / 多系列图例 hover 高亮 / 选中温度计跨图高亮 / 异常温度过滤 —— 均缺;scatter 所有点同一紫色十字(`scatterPlot.tsx:54`)。

**等温线**
- 等温线合成进保存帧/截图(different):`imagePlayer.tsx:377-384` 仅导裸帧,叠加层丢失(随 html2canvas 一并解决)。

**标注**
- 引线/连接线(dx,dy):`types.ts:129-134` 只有 id/x/y/note,无 AnnotationCallout。
- 时间窗可见性(start/end):type 无 time;notes 始终渲染。
- 标注工具栏(Add/Reword)+ annotator 模式:`addAnnotation/rewordAnnotation` 死枚举(`types.ts:157-158`),ToolBar 不接(注:标注仍可经内联 "+ Note" 按钮新增,与温度计不同)。

**Clip 管理**
- 分段指示 canvas(segments-view)/ 在新标签打开 / 撤回 raw / 清空回收站 / 分页 Load More 全缺;各列表页 `getDocs()` 无分页。
- 删除级联清理(partial):`experiments.ts:98-100` 仅删实验文档,thermometers/comments/ratings **被孤立**(JSDoc 自述 "tracked for a later phase")。
- "List All Experiments" 全局最新页缺:telelab 有 recentExperiments(全局)+ history(自看)两页;新 app 只有 per-user history。

**评论 / 评分 / 通知**
- 删除评论确认弹窗:`commentList.tsx:154-162` 直接 await `deleteComment`,无 `Modal.confirm`(全 src 无)。
- 显示名解析(Anonymous/Admin 全名/昵称/首字母缩写):User type(`types.ts:1-6`)无 role/nickname/first/lastName,**隐私缩写结构上不可能**。
- 会话内 tab 计数实时刷新:`infoSection.tsx:12` 取加载快照,增删/回复后不变。
- ~~卡片上的评分/评分数/评论数:`card.tsx` 无(仅详情页 `rating.tsx` 有)。~~ **已补**:hover 浮层显示浏览量/评论数/评分(均值+条数);新增 Function `aggregateCommentCount`(count() 聚合维护 `experiment.commentCount`,client 只读,规则白名单同其它聚合)。

### 2.3 LOW / DIFFERENT —— 视觉保真与实现差异(择要)

- T 索引 0-based vs telelab 1-based(`thermometer.tsx:143`、`linePlot.tsx:134`):建议统一 `index+1`。
- line-plot tooltip 无 formatter(`linePlot.tsx:129`);scatter 有 toFixed(2)+unit。
- CSV 用手写 escapeCSV(LF)而非 Papa.unparse;固定文件名无时间戳 → 重复导出覆盖。
- 分享 URL 用 HashRouter `#`+pathname;Facebook 用 title 非 quote;无 onShareWindowClose。
- 等温线 6 档 HSL 渐变 + 图例 vs telelab 5 阈值纯白无标签 —— 实为**增强**,非回退。
- 滚动位置持久化、全局 Loading Spinner、Cookie 横幅、背景图、用户/实验计数、°C/°F 用文字 glyph 非 SVG。

---

## 3. 跨切面缺口(完整性评审补充,不在 13 区域内)

- **路由/深链**:`App.tsx` 用 `createHashRouter`,无 `/about` `/contact` `/account` `/users` 路由;telelab 的 `/experiment/:id`(只读 showcase chrome)与 `/clip/:id`(编辑器)合并为单一 `experiments/:expId`,showcase 专属 chrome 丢失;外部流传的旧 `/experiment/{id}` 链接无法解析。
- **实验找不到的空态**:`experimentAnalyzer.tsx` 文档不存在时永久 `<div>loading...</div>`,坏分享链接会一直转圈(telelab 用 `<Empty>"I cannot find the experiment"`)。
- **SEO / Meta / 分析**:无 per-route `document.title`(全站一个静态 title);无 Google Analytics(gtag);无 `remoteLogger` 行为埋点(telelab 几乎每个动作都打点);favicon 仍是 Vite 默认;无初始加载 splash。
- **PWA**:无 `manifest.json` + service worker(telelab Workbox 可安装/离线);不可安装。
- **响应式**:全 `src` 无任何 `@media` 断点;三栏分析器与卡片网格无移动端适配。
- **登出态导航**:`accountSection.tsx:14-21` 仅登录后渲染 MainMenu;登出访客只有 `/` 和直链,无浏览菜单。
- **离线热数据缓存**:无 `localDB`/IndexedDB/`withPersistence`;每次进分析页都重新下载完整热数据 blob。
- **工具/原语**:`transforms/`(capitalize/constructClipURL/parseExperiments)与 `dragndrop/`(CustomDragPreview/DndButtonWrapper)整组未移植。

---

## 4. 与方案 §12 的对照(重点)

**§12 已诚实披露(一致,符合预期)**:整页截图需 html2canvas(未装,只给逐帧 PNG)、缩略图用指针 URL、测量区改 ＋/－、App Check/限频/旧数据迁移延后。

**§12 未披露(过度声明,应重点关注)**:
1. 新增/拖放/删除/全部删除/选中温度计(HIGH)—— 死枚举,最核心交互缺失。
2. 播放器右键上下文菜单(HIGH)。
3. 图表选项菜单 + 图表 PNG/scatter CSV + 图例 + 选中高亮 + 自定义符号(MEDIUM)。
4. 删除实验的级联清理(MEDIUM,JSDoc 自承孤儿文档)。
5. 首页搜索/学科标签/卡片 hover 元信息/卡片菜单/重命名/全局浏览页(MEDIUM 群)。
6. 登录页(/auth)、账户两栏布局 + Profile 计数、Contact/About/Cookie/Footer/版本/Spinner(MEDIUM/LOW 群);§8 曾标 Team/About "静态保留"、Cookie "保留 acceptCookie",但实际未移植。
7. 评论删除确认、显示名隐私缩写、tab 计数实时刷新、Admin 审核越权(MEDIUM)。

---

## 5. 有意舍弃(直播等)—— 确认正确缺席

直播/等候室/媒体流(Agora)/机器人/实时聊天/在线状态/blurredImg、MongoDB/Redis/Socket/Express/Docker/k8s —— 真实缺口集中无相关条目,处理正确。
角色权限 / Users 管理表 / 用户-实验计数 —— §8/§10 明确随 classroom 阶段延后,属**正确延后**而非遗漏。

---

## 6. 建议的下一步(按优先级)

**P0 — 恢复核心分析交互(HIGH,体感阻断)**
1. `stores/common.ts` 补 `createThermometer / removeThermometer / removeAllThermometers / selectThermometer`;接通 `ControlBarButtons.addThermometer`。
2. ToolBar 加 "Add a thermometer";`imagePlayer.tsx`/`videoPlayer.tsx` 加拖放落点添加。
3. `thermometer.tsx` 去掉硬编码 `selected=false`,接 store 选中态 + 背景点击取消选中。
4. antd `Dropdown(trigger=contextMenu)` 包裹播放器,聚合 删除/全删/截图/测量区 Radio/Show Info。

**P1 — 导出与截图(装依赖即可批量解锁)**
5. `npm i html2canvas` → `exportElementToPNG`;接 player 合成截图(含温度计/标注/等温线)、line/scatter PNG、整页截图;文件名加 dayjs 时间戳。
6. 图表移植 lineplotMenu/scatterplotMenu;scatter 补 CSV + per-thermometer 颜色/形状;line 补 Legend + tooltip formatter。

**P2 — 数据完整性**
7. 上线 recursive-delete Function 或在 `deleteExperiment` 后清子集合,消除孤儿文档。
8. 评论删除加 `Modal.confirm`;mutation 后回调刷新 tab 计数;扩 User type 支持显示名隐私缩写。

**P3 — 画廊与浏览体验**
9. 首页加 AutoComplete + SubjectTag + 卡片 hover 元信息 + cardMenu(含重命名/新标签/撤回);补"浏览全部"或全局最新页;列表页加 Load More。

**P4 — 静态页与全局 chrome(补齐 §8 承诺)**
10. 补 /about、/contact、acceptCookie、全局 Spinner、Footer(版权+版本+Contact)、登录页 chrome、账户两栏布局;`mainMenu` 加 About/Contact 入口;实验找不到的 `<Empty>` 空态。

**P5 — 视觉保真收尾**
11. 统一 T 索引为 1-based;CSV 改 Papa.unparse;补滚动位置持久化、空/加载态、移入回收站确认 + 成功 toast、窗口 resize 温度计重投影。
