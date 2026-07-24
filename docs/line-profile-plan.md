# 线剖面 T(l) 实施方案

状态：**方案草案（2026-07-23），待审定。**
背景：色标锁定(P4)已砍；线剖面升为新图表头号项。收尾空悬的 `spaceR=4` 枚举。
机制引用均已对照当前源码核实（chartManager 2 列网格、useAnalysisPersistence saveSig、`getDecodedFrame` 解码缓存、imagePlayer 四闸门）。

## 0. 默认决策（可推翻）

1. **v1 单条线**。多条线要选中态/命名/子集合持久化一整套（thermometers 模式），教学场景一条剖面已够用；扩展路径见 §9。
2. **最近邻采样**，不做双线性——与 spotmeter/探针读数语义一致（报"某个像素的真实值"，不报插值）。
3. **X 轴 = 沿线位置分数 0(A)→1(B)**。像素域没有物理标定（无距离元数据），做不了厘米轴。

## 1. 行为定义

- 枚举：`ExperimentGraphOption.spaceR = 4` **改名** `lineProfile = 4`（值 4 从未实现过、Firestore 无存量文档携带它，改名安全；`graphR` 按钮枚举早已删除）。
- Charts tab 的 chip 行（chartToggles.tsx）加第四个 chip：**T(l) / along a line**。开启后：
  - 图像上出现**剖面线 overlay**：A、B 两端点手柄可拖，拖线身整体平移；默认线 `(0.2, 0.5) → (0.8, 0.5)`（水平过中心）。
  - Charts 面板出现 **T(l) 图**：当前帧沿线温度 vs 位置（0=A，1=B），播放时逐帧刷新。
- 关 chip：线与图都隐藏，几何保留（同其它图开关语义）。
- overlay 是普通 SVG（同 isotherms 的 0..1 viewBox），`exportElementToPNG` 截图自动包含，无需特判。

## 2. 采样（新 `src/utils/lineProfile.ts`）

- `sampleLineProfile(temps: Float32Array, w: number, h: number, line: ProfileLine): { pos: number; tempC: number }[]`
- 样本数 `N = clamp(ceil(线长像素), 16, 240)`；t∈[0,1] 均匀参数化；最近邻 `temps[floor(fy*h)*w + floor(fx*w)]`（端点含边界 clamp）。
- 输入取 `getDecodedFrame(buffer).temps`——解码缓存已有，**零额外 inflate**；240 点/帧 @5fps 开销可忽略，拖拽中不需专门节流。
- 截断帧（`complete=false`）沿线可能出现 −273.15 哨兵：与 isotherms/3D 同现状，v1 不特判。

## 3. 状态与持久化

- 类型：`ProfileLine = { x1, y1, x2, y2 }` 全 [0,1] 分数。`Experiment` / `ExperimentDoc` 加 `profileLine?: ProfileLine`（hydration 靠既有 `...data` spread 免费）。
- store（stores/common.ts）：新 action `updateProfileLine(expId, line)` 直接改 `experimentMap`（同 `toggleGraphOption` 模式）。overlay 读 `experiment.profileLine ?? DEFAULT_PROFILE_LINE`，首次拖拽物化。
- 开关走 graphsOptions 全套免费机制：`toggleGraphOption(expId, lineProfile)`；owner 800ms 防抖保存；viewer 内存沙箱；clone 携带；firestore.rules owner-update 为 deny-list，**新字段免改规则**（P4 审查已核实过的机制）。
- 持久化接线三处：
  1. useAnalysisPersistence.ts:70-76 — snapshot 加 `profileLine: exp?.profileLine ?? null`，saveSig 加 `p:` 键；
  2. services/experiments.ts `saveAnalysis`（~:180）— `expFields` 条件加入 `profileLine`（**undefined 勿写进 Firestore**，条件展开）；
  3. 两个 clone 构建器（~:360 / ~:457）— 携带 `profileLine`（空间量，与剪辑无关，trim 安全；同样注意 undefined）。
- 沙箱语义：**拖线 = 真实编辑 → sandboxDirty**（同 thermometer）；chip 开关不触发（既有约定）。

## 4. 图表（新 `charts/profilePlot.tsx`）

- recharts LineChart：X domain [0,1]，label "Position along line (A→B)"；Y = `displayTemp` 单位联动。
- **Y 轴防跳动**：若 `lineplotThermoData`（≤25 采样帧）可用，用采样帧沿线 min/max 定固定轴（同 T(x)/T(y) 的全片域思路）；不可用时退化为当前帧 nice ticks。
- 单序列；tooltip：位置 3dp + T 2dp（单位符号）。
- 菜单（复用 chartMenu.tsx）：Save CSV（rows `{position, T (unit)}`）/ Save PNG / Line Width / 网格开关。
- 设置存 chartSettings 新 **`profile` 平面**，并**顺手修三键陷阱**：stores/common.ts:574-587 的 `setLineChartSetting`/`setScatterChartSetting` 目前重建 `{line, scatter}` 会丢第三键——三个 setter 统一改为 spread `...exp.chartSettings` 保留未知键（此陷阱已两次出现在方案审查里，这次根治）。
- chartManager.tsx：第四 slot 进 `chart-grid`（2 列网格天然支持 4 图 2×2，奇数首图通栏逻辑不变）；`maximizedChart` 加 lineProfile 分支；新 props `getBuffer: () => ArrayBuffer | undefined`（配合已有 `currFrameIndex` 驱动逐帧重算）。
- 空态：buffer 未到 → loading placeholder（同 timeSlot 模式）。

## 5. Overlay（新 `profileLine/profileLine.tsx`）

- SVG：线 + 两端点圆手柄（旁标 A / B）+ 透明加宽命中区（线身 hit 宽 ~16px）。
- 拖拽：pointer events（annotations.tsx 的 touch-safe 模式）；端点拖改单端、线身拖平移，全程 clamp [0,1]；拖完 `updateProfileLine`。
- 最短长度 clamp ~0.05 防退化；手柄触target ≥24px。
- 图↔线联动（**v1.5 可选**）：hover 图表 → 线上出位置圆点（`hoveredThermometerId` 同款瞬态 store 字段）。

## 6. 播放器接线

- imagePlayer.tsx 四处（行号为当前源码）：
  1. `showProfile = graphsOptions?.includes(lineProfile)`；`needCurrFrameThermoData`（:232）加 `|| showProfile`（图表要读当前帧 .dat）；
  2. .dat 到帧 bump（:387）：`showProfileRef` 并入条件（驱动图表重渲，同 isotherm/scaleHotspots）；
  3. 开关生效 effect（:629）加 `showProfile`；
  4. overlay 挂在 Isotherms 同级（:1053），ChartManager（:1029）传 `getBuffer={() => cacheThermoArrayBufferRef.current[imgFrameIdxRef.current]}`。
- videoPlayer.tsx：同款推导；buffer = `thermalData[currFrameIndex]`（驻留内存，无 ensure/bump 需求）；overlay 同挂。

## 7. 文件清单与实施顺序

1. `types.ts`：改名 `lineProfile = 4` + `ProfileLine` + `profileLine?` 字段。
2. `utils/lineProfile.ts`（新）：采样器（无测试基建，以 tsc + 手验为准）。
3. `stores/common.ts`：`updateProfileLine` + chartSettings `profile` 平面 + 修三 setter 的三键陷阱。
4. `profileLine/profileLine.tsx`（新 overlay）。
5. `charts/profilePlot.tsx`（新图，复用 chartMenu）。
6. `chartToggles.tsx`（第四 chip；新 svg 资产，可先做简单斜线图标）+ `chartManager.tsx`（slot + maximize + getBuffer）。
7. `imagePlayer.tsx` / `videoPlayer.tsx` 接线。
8. `useAnalysisPersistence.ts` + `services/experiments.ts`（saveAnalysis + 两个 clone 构建器）。
9. 验证：tsc + build（CLAUDE.md：不起 dev server）；QA 清单见 §8。
10. 按 CLAUDE.md 不主动提交。

## 8. QA 清单

- owner：拖线 → 800ms 一次防抖保存（doc 得 `profileLine`，`graphsOptions` 含 4）；刷新回读几何。
- viewer：拖线 → sandboxDirty 横幅、零写库；Save as 克隆携带线与开关。
- chip 开/关只影响显示、几何保留；maximize 进出正常。
- 播放中逐帧刷新；recording 的 .dat 未到时 loading、到帧后图表出现；video 即时。
- °C/°F 切换全联动；CSV/PNG 导出；播放器截图含线 overlay。
- 触屏拖拽可用；边缘 clamp；最短长度；A/B 方向与图表 X 轴一致。
- 系统 showcase 视频（无 owner）纯沙箱不写库。

## 9. 已知限制与扩展路径

- X 轴只有位置分数，无物理长度（像素域无标定）。
- 最近邻采样在陡梯度处呈台阶——与 spotmeter 语义一致，接受。
- 多条线扩展路径：`profileLine` 字段升级为 `profileLines[]` 或子集合 + 选中/命名/逐条色，chip 变「+ 添加剖面线」；v1 字段设计不阻碍迁移（读到旧单条即包装为数组首元素）。
