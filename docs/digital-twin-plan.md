# 3D 数字孪生（Digital Twin）实施方案

状态：**M0 + M1 已实现（2026-09-08，本地未提交、未部署、未上机验证）：契约 + 对比赛脚本 + 云函数 analyzeTwinScene/clearTwinScene + 3D Twin 标签页 + 稳定性门槛 + 求解器 + 器具库 + 热图投影。模型暂钉 gpt56（TWIN_MODEL_KEY），待语料录好跑对比赛后改。部署顺序 rules → functions → hosting。**
背景：把 app 采集的实验录像（可见光 + 红外）交给 AI 识别器具与布局，在分析器里渲染一个带热图、可交互的示意性 3D 场景。第一阶段单帧建空间模型，第二阶段逐帧动画。
机制引用均已对照当前源码与采集 app 仓库（D:/IFI/infrared-explorer-app）核实。

## 0. 已定决策（复工时不要重新讨论）

用户 2026-09-08 拍板：

1. **只做 app 采集的 recording**（有 vis_N.jpg 的包）。legacy .vir 视频没有可见光，不做。
2. **示意性教学孪生**，可交互，不追求照片级。器具用参数化几何，不引入外部模型资产。
3. **放在分析器单独标签页**（WorkspaceMode 新增 `twin`）。
4. **采集 app 可以同步改**（俯仰角、视差距离、设置照片）。
5. **不用 Claude**。场景分析模型在已接入的 OpenAI 兼容通道里选：GPT-5.6 与 Gemini 2.5 Pro 对比赛后钉死一个，不跟随问答面板的用户选择。
6. 技术路线：**语义重建**（AI 认物 + 确定性几何求解 + 参数化器具 + 温度投影），不是像素重建（摄影测量 / NeRF / 高斯泼溅对透明玻璃与细杆结构不可行）。
7. **单视角是基线**；多角度「设置照片」是可选升级（§12），不是前提。

## 1. 目标与非目标

目标：
- 给定一段 app 录像，自动判断能否渲染；能则在 3D 标签页里给出桌面 + 器具 + 热图的场景，视角可绕，热图跟随播放头（第二阶段）。
- 结果可手改（种类 / 尺寸 / 位置），改动持久化，viewer 直接读结果不再付 AI 成本。
- 明确标出热图里哪些面是**实测**（相机看得到）、哪些是**推断**（回转体绕轴补全）。

非目标（v1）：
- 物体移动、倒水、手进出画面的动态几何。v1 布局静止，只让温度动。
- 液体、火焰、气流的物理仿真。火焰只做示意几何。
- 照片级材质与光照。

## 2. 数据事实（已核实）

| 文件 | 来源 | 尺寸 | 备注 |
|---|---|---|---|
| data_N.dat | 辐射数据重采样 | 120×160，BE uint16 centi-K，pako deflate | 温度唯一来源 |
| data_N.png | Fusion MSX(0) 渲染 | Android 480×640 / iOS 1080×1440 | 伪彩，4×或9×上采样 |
| vis_N.jpg | 同一 Fusion 对象 VISUAL_ONLY | 同上 | 仅 app 录像有 |
| mix_N.jpg | 同一 Fusion 对象 MSX(1) | 同上 | 可见光边缘叠热像 |

- **对齐**：三张渲染出自同一个 FLIR SDK Fusion 对象、同一变换，名义上像素对齐；可见光上的归一化坐标可直接映射到 120×160 温度网格。但两镜头有物理视差，出厂配准只对某个标称距离准确，近距离（半米级）有几十像素残差（app 仓库 docs/blend-alignment.md 实测，1080×1440 帧偏 (-126,-15) px）。**对策见 §6.1。** SDK 的 `FusionController.distance()` 视差校正两代 app 都没用，采集端可接（§12）。
- **视场角**：`src/utils/streetViewPano.ts` 已有 FLIR 常量 hfov 43°、vfov 55°（竖屏 120 宽 × 160 高）。
- **相机姿态**：app 已有陀螺融合姿态源（`src/lib/useDeviceSensors.ts`，街景采集在用），录像 meta.json 目前不写。
- **语料现状（2026-09-08 扫描）**：线上有 vis 帧的 app 录像约 13 段，绝大多数是笔记本屏幕 / 房间的测试录像，唯一有实物的是 e78902fa（热水壶向瓶子倒水）。**对比赛前必须用 app 录一批真实实验布置**（§13.3）。

## 3. 管线总览

```
录像 ──► ① 稳定性门槛（确定性，客户端/函数皆可）
            │ 不稳定 → 不渲染，给出原因
            ▼
        ② 场景分析（Cloud Function analyzeTwinScene → 视觉模型 → TwinScene JSON）
            │ renderable=false → 不渲染，给出原因
            ▼
        ③ 几何求解（确定性，客户端 utils/twinSolver.ts）
            ▼
        ④ 器具实例化（参数化几何，twin/props/*）
            ▼
        ⑤ 热图投影（utils/twinThermal.ts）→ R3F 渲染（twin/twinScene.tsx）
```

②的输出持久化到 experiment doc 的 `twinScene` 字段（函数写，客户端只读，规则同 aiReport*）；③④⑤在客户端每次打开标签页时重算，成本可忽略。

## 4. 稳定性门槛（① 不走 AI）

- 顺序：先探测 `vis_1.jpg` 是否存在（没有可见光帧的旧录像直接禁用按钮并说明），再做运动门槛，最后才调模型。
- 输入：录像的温度帧序列（120×160，已有解码缓存 `getDecodedFrame`）。抽样：短片（≤120 帧）逐帧，长片均匀取 120 帧；抽样之间的帧在绘制时逐帧对齐（见下）。
- 算法：高通后的 2-D NCC（街景 v2 方案里已验证过同一套，见 app 仓库 docs/street-capture-v2-plan.md §1）+ 抛物线亚像素。两趟：① 相邻抽样帧位移（±6 px 窗）只用来选参考帧（进出运动最小、居中优先）；② 每个抽样帧对参考帧做宽窗对齐（`alignFrame`：stride-4 粗搜 ±16 px → ±3 px 细搜），得到相对参考帧的漂移。
- 判定：**不要求一动不动**。绘制时每一帧都先对齐到参考帧（测得的整帧平移叠加到可见光→红外配准偏移上再取温），所以手持微晃、支架被碰一下都无所谓；只有漂移超出平移模型能描述的范围才拒绝：`max drift ≤ 12 px`（120 宽的 10%，约 4° 平移；再大就有视差/滚转，且模型看到的照片已不覆盖同一场景）。p95 只记录不参与判定。NCC 峰值 < 0.25 的帧视为不可跟踪（挡镜头、场景重排），不计入漂移、绘制时偏移取 0，由相似度提示兜底。
- 输出：`{ stable, maxShiftPx, p95ShiftPx, sampled, referenceIndex }`，其中 max/p95 是各抽样帧**相对参考帧**的漂移。
- 位置：`src/utils/twinStability.ts`（纯函数 + 单测，合成平移帧验证）；逐帧对齐在 `twin/twinPanel.tsx` 的 `toPaintFrame`。

## 5. 场景分析（② Cloud Function `analyzeTwinScene`）

- 触发：owner 在 3D 标签页点 Generate。v1 沿用 generateLabReport 的 staff 门（内部账号），稳定后再放开。**门只管生成不管查看**：twinScene 随实验文档持久化在云端，凡能读到文档的人（分享出去的 public / unlisted 链接的访客，含未登录）都看到「3D Twin」标签页和 owner 留下的孪生（含 twinEdits 修正），只是没有 Build / Regenerate / Clear 按钮（2026-09-09 定）。
- 输入：`{ experimentId, recordingIndex }`。函数自行从 Storage 取 `vis_N.jpg`、`data_N.png`、`data_N.dat`（复用 `loadStorageImageBase64` / `decodeFrame`）。
- 送给模型：可见光 + 红外两张图，附帧统计（min / max / mean °C）、调色板名、可选的实验标题与描述。
- 输出契约：**`functions/src/twinScene.ts`**（已写）——`TWIN_SCENE_JSON_SCHEMA`、`buildTwinScenePrompt`、`parseTwinScene`。对比赛脚本与函数共用，提示词 / schema / 解析只有一份。
- 结构化输出：OpenAI 兼容 `response_format: { type: 'json_schema', json_schema: { strict: true, schema } }`；端点拒绝时降级到 `json_object`，再降级到裸文本 + 解析（脚本已实现三级降级）。
- 模型：`TWIN_MODEL` 常量单独钉死（对比赛胜者），不走 `QA_MODELS` 的用户选择；密钥仍用 Secret Manager。
- 持久化：`experiments/{id}.twinScene = { version, model, analyzedAt, recordingIndex, stability, scene: TwinScene, registration: {dx, dy} }`。用户手改写 `twinEdits`（客户端可写，覆盖式 patch），不动 `twinScene`。
- 规则：`twinScene` 加进 firestore.rules 的 aiReport* 同款 deny-list（create 与 update 两处）。
- 遥测：`logModelUsage('twin-scene', model, usage)`。

### 5.1 TwinScene JSON（v1）

```
{
  renderable: boolean, reason: string, confidence: 0..1,
  camera:  { pitch: 'level'|'slightly_above'|'high_angle'|'top_down', distanceHint: 'close'|'medium'|'far' },
  support: { kind: 'table'|'bench'|'floor'|'unknown', farEdgeY: 0..1 | -1 },
  objects: [{
    id, kind: <TWIN_OBJECT_KINDS>, label, confidence,
    bbox: { x, y, w, h },            // 可见光图归一化坐标，左上原点
    footprintY: 0..1,                // 与承托面接触的高度（通常是 bbox 底边）
    sizeCm: { height, width },       // 模型估计的真实尺寸；求解器用名义尺寸表覆盖
    material, fill: { level: 0..1, content }, restingOn: <id>|'support',
    thermal: { role: 'heat_source'|'heated'|'cooled'|'ambient', note }
  }]
}
```

Firestore 禁嵌套数组：`objects` 是 map 数组、`bbox` 是 map，合规。`undefined` 一律序列化为 `null`（同 ProfileLine.name 的坑）。

### 5.2 不渲染的条件

任一命中即不渲染并显示原因：①不稳定；②`renderable=false`；③没有任何 `confidence ≥ 0.6` 的实物；④某个 bbox 面积 > 90% 画面（拍的是屏幕 / 墙）；⑤`support.kind = unknown` 且无 `restingOn: 'support'` 的物体。

## 6. 几何求解（③ `src/utils/twinSolver.ts`）

### 6.1 可见光 ↔ 温度网格配准

- 服务端在②里对参考帧算一次：`mix − ir` 得 MSX 边缘层，对可见光的边缘图做相位相关，得 (dx, dy)（可见光像素）。写进 `twinScene.registration`。
- 客户端把 bbox 平移 (dx, dy) 后再映射到 120×160。残差从几十像素降到个位数。
- 单测：合成平移图验证相位相关。

### 6.2 相机模型

- 竖屏，`fx = (W/2) / tan(hfov/2)`，`fy = (H/2) / tan(vfov/2)`，hfov / vfov 取 streetViewPano 常量；W, H 用可见光像素。
- 俯仰：优先 owner 的滑杆覆盖（twinEdits.pitchDeg），其次实验文档的 `capturePose.pitchDeg`（采集 app 录制开始时的传感器读数，仰角为正，故下倾 = 其相反数，夹到 0–85°），最后按 `camera.pitch` 档位取 0° / 15° / 40° / 80°。面板标注来源（set by you / from the phone sensor / estimated from the photo）。
- 滚转：`capturePose.rollDeg` 已上传但 v1 求解器未用，缺省 0。

### 6.3 距离与位置

- 每个物体：名义高度 `H_real`（§7 尺寸表；模型给的 `sizeCm.height` 只在 kind 为 other / bottle 等无表项时使用）；`d = fy · H_real / h_px`。
- bbox 底边中心射线按 d 截得接触点 P_i（相机坐标系）。
- 承托面：`restingOn = 'support'` 的接触点做最小二乘平面（≥3 点）；2 点则平面含两点且法线取俯仰给出的重力方向；1 点则平面过该点、法线由俯仰决定。相机高度由平面反推，不需要先验。
- 堆叠：`restingOn = <id>` 的物体，接触点投到父物体顶面（三脚架 / 石棉网 / 热板的顶面高度来自其参数）。
- **悬空（契约 v2，2026-09-08）**：`restingOn = 'held'` 的物体（手持、倾倒、探入）不落桌面。有 `heldOver` 目标时**挂在目标上**：接触点（`holdAnchor`：水壶=壶嘴尖 `KETTLE_SHAPE`、温度计=底端、其余=朝目标一侧的杯口）放在目标口沿上方 gapM 处，身体在 bbox 中心相对目标口的那一侧，+x（壶嘴）指回目标（yaw=π 或 0），顶部朝目标倾斜 |tiltDeg|，绕相机视轴旋转；**bbox 的尺寸完全不用**（倾倒的壶通常被画幅切掉一半，bbox 不可信）。无目标时：bbox 中心射线 × 尺寸推算深度定中心（深度夹进距离档），底部往下推半个身高，倾斜正负号用模型的。底部（含倾斜后的底缘最低点）夹到桌面以上，抬升超过 8 cm 才提示。**倾角拟合（`fitLean`）**：模型给的 tiltDeg 系统性偏浅（倒水实测 28° vs 约 50°），而壶嘴钉在目标口沿后，倾角是唯一决定壶身高低的量，bbox 的**下边**（只要不贴画幅边缘）就是壶身最低点的证据：在 5–85° 里逐度搜索，让底缘在画幅内的最低投影点落到 bbox 下边（残差 < 6 px 才采用，同分偏向模型值，底缘穿桌的角度不作候选）；轴上锚点（温度计）不拟合、保留模型正负号。宽口目标时壶身沿侧向退到壶嘴悬在近侧口沿上方。restingOn/heldOver 成环时按路径集合截断并警告。起因：倒水实测，模型把悬空倾倒的水壶标成 support，求解器按 bbox 底边把它放到桌子深处；改成按 bbox 中心定位后又因 bbox 被切而把壶放得太大太低，才改为锚定。
- 输出：`{ camera: {pose}, viewDir, placed: [{ id, kind, params, position, yawRad, tiltRad, heldOver }] }`。

## 7. 器具库（④ `src/pages/experimentAnalyzer/twin/props/`）

v1 清单与参数（回转体用 LatheGeometry，其余用 Cylinder / Box / Torus 组合）：

| kind | 几何 | 名义尺寸（高 × 直径 cm） |
|---|---|---|
| beaker | 直壁 Lathe + 唇口 | 50 mL 6×4.2；100 mL 7×5；250 mL 9.5×7；400 mL 11×8；600 mL 12.5×9；1000 mL 14.5×10.5 |
| erlenmeyer_flask | 锥形 Lathe + 颈 | 125 mL 11×7；250 mL 14×8.5；500 mL 18×10.5 |
| test_tube | 圆底 Lathe | 15×1.6 |
| graduated_cylinder | 细高 Lathe + 底座 | 100 mL 25×3 |
| bottle / cup / kettle / pot | 通用容器 Lathe | 取模型 sizeCm |
| alcohol_lamp | 扁球 Lathe + 灯芯 + 火焰（示意） | 9×8 |
| bunsen_burner | 底座 + 立管 | 14×7 |
| tripod | 三腿 + 环 | 20×15 |
| wire_gauze | 薄方板 | 0.3×15 |
| ring_stand | 底板 + 立杆 + 环 | 60×15 |
| hot_plate | 方盒 + 圆盘 | 8×18 |
| thermometer | 细杆 | 30×0.8 |
| metal_block / ice | Box | 取模型 sizeCm |
| other | Box | 取模型 sizeCm |

- 规格判定：按 bbox 求出的 d 与各规格高度回代，取使 `d` 落在 `distanceHint` 区间的规格；不唯一时取模型 `sizeCm` 最近者。
- 液体：容器内一个高度 = `fill.level × 内高` 的柱体，材质半透明。
- 材质：玻璃 `MeshPhysicalMaterial` transmission；金属 metalness 高；写实 / 热图 / 混合三种显示模式（对应 ir / visible / blended）。

## 8. 热图投影（⑤ `src/utils/twinThermal.ts`）

- 对每个顶点：投到可见光像素 → 平移配准 (dx, dy) → 缩放到 120×160 → 最近邻取温度。
- 可见性：`normal · viewDir > 0` 且未被前方物体遮挡（v1 只做法线测试；遮挡留给 v2 用深度图）→ **measured**。
- 背面 / 侧面：回转体在同一高度取轮廓左右两列温度的均值，绕轴扫描 → **inferred**。非回转体取该物体 measured 区域的均值。
- 颜色：与二维视图同一调色板（`utils/colormap` / `utils/palette`）。**色标位置不是当帧 min→max 线性**（那样一壶 90 °C 的水会把 30 °C 的瓶子压成和墙一样的深紫），而是 `plateauEqualization`：当帧 256 桶直方图、每桶封顶 plateau·N、累积和作调色板位置、再与线性混合 linearWeight——即 FLIR SDK 给播放器那张 PNG 用的直方图 AGC 的近似；参数用 data_N.png 反推的 SDK 曲线标定（PNG 像素→iron 最近色→调色板位置，按温度对比；2026-09-08 用倒水录像 3 帧网格搜索：plateau 0.008、linearWeight 0.4、且 SDK 只用调色板的 0.15–0.80 段，逐像素 RMS 从线性的 0.175 降到 0.021）。范围压缩是 AGC 留的余量，与调色板无关，各调色板通用。面板取当帧范围时只看有效像素并从 float32 数组回读（截断帧的 −273.15 哨兵、解码器 double 极值都会让色标错位）。
- 顶点密度：热图按顶点上色、三角形内插值，所以旋转体剖面在 `lathe()` 里先按 3 mm 环距加密（`PAINT_STEP_M`，原剖面折点保留）；否则瓶子只有 7 圈顶点，底部 2 cm 高的热水带要么落在两圈之间被漏掉，要么被插值抹到整个瓶身（2026-09-08 用户反馈「heatmap 位置不对」的根因）。验证用 scratch 脚本 render.ts：从拍照机位把上色后的顶点点绘成图，与 SDK 渲染并排比。
- **看不见部分的推断（2026-09-09，用户问「能否推测背面/其他位置的热图」；同日对抗审查 8 项 finding 后重写）**：不用 AI，用物理先验。①环境温度：面板用所有物体 bbox（加 6% 边距）之外的像素取中位数（`ambientOutsideBoxes`）；外部像素不足 25%（特写）则为 null，此时不丢任何采样。②物体/带的"水平"（`level`）：若距环境 >3 °C 的采样占 ≥35%（且 ≥3 个）取它们的中位数（细物体被自身光晕淹没、热壶身后几个墙像素都能自救），否则取全部中位数。③旋转体高度剖面：只用**旋转壳**的顶点（`PropParts.revolvedUntil`，壶嘴/把手/温度计球排除，否则它们被看到时会压倒本带、看不到时继承壶温），40 个高度带，每带需 ≥max(3, 顶点数 10%) 个正面采样才算数，缺带线性插值、两端延伸。④判墙（`isWall`）：**只有距环境 ±1.2 °C 以内的采样才可能是墙**（远离环境的一律真实——烧杯上的冰块、冲到一侧的水流）；参照水平（本带值或物体水平）明显偏离环境时，环境附近的采样即墙；参照接近环境时，只有比参照更"越过环境" 0.8 °C 以上的才是墙（常温瓶子后面更冷的墙）。丢弃的与未采到的旋转壳顶点取带值；非旋转体只做②④和镜像；其余取均值。推断顶点仍标 inferred，灰混 25%，「measured only」只看实测。圆柱/杆件也按 3 mm 加环（温度计杆原来没有中间顶点）。
- 背面推断：镜像面过物体底部中心、**含物体（可能倾斜的）轴**、朝向相机（直立物体即原来的竖直面）；bbox ±6% 门槛在可见光坐标系判定，配准与逐帧漂移只移动读取像素。（2026-09-08 对抗审查发现并修复。）
- 顶点属性 `measured: 0|1`，着色器对 inferred 区域降饱和或加细纹；UI 有开关「只看实测」。
- 第二阶段动画：几何不变，每帧只重算顶点颜色（Float32Array 就地更新），复用 thermalSurface3D 的 `loadFrame` 预取。

## 9. 渲染与 UI（`src/pages/experimentAnalyzer/twin/`）

- `WorkspaceMode` 加 `'twin'`；workspacePanel.tsx `options` 加 `{ label: '3D Twin', value: 'twin' }`。门控：`twinScene` 已存在 → 任何读者（含未登录）都看到标签页；否则只有 owner + staff 看到（去生成）。生成按钮在面板里另按 owner + staff 判，函数端再查一遍。
- `twinPanel.tsx`：状态机 `idle → checking(①) → analyzing(②流式进度) → ready | blocked(reason)`。顶部状态条：稳定性结果、模型、参考帧、生成时间；Generate / Regenerate / Clear 按钮（owner）。
- `twinScene.tsx`：three.js 走 lazy chunk（同 surface3dScene）。初始相机放在求解出的真实机位，提供「回到拍摄视角」按钮；OrbitControls 绕视；显示模式三选；「只看实测」开关；桌面网格。
- 对象列表（右侧或底部）：每项 kind 下拉、规格下拉、位置微调；改动写 `twinEdits`，viewer 走沙箱语义（同 thermometer：改动即 sandboxDirty）。
- 与播放器：第二阶段热图跟随 `currentIndex`；第一阶段固定在参考帧并在面板上标明。
- 红线沿用分析器约定：任何 tab 不许横向滚动；窄面板按钮只留图标。

## 10. 持久化与规则

- `ExperimentDoc.twinScene?: TwinSceneRecord`、`twinEdits?: TwinEdits`（types.ts）。
- 保存路径：`twinEdits` 由 `services/experiments.ts saveTwinEdits` 直接 updateDoc（owner 可写字段，800 ms 防抖，undefined 不写）。**clone 不携带**两者：`twinScene` 是函数写字段，create 规则禁止携带；`twinEdits` 按旧场景的对象 id 键控，没有场景就没有意义。
- firestore.rules：`twinScene` 进 aiReport* 的 deny-list（create + update 两处）；`twinEdits` 不进。
- 清除：`clearTwinScene` callable（FieldValue.delete）；重新生成时函数同时删掉 `twinEdits`。

## 11. 第二阶段：动画

- 温度动画：§8 末段。
- 布局变化检测：每秒抽样帧对参考帧做差分，`restingOn='support'` 物体 bbox 内的边缘相关性跌破阈值 → 标记「布置已改变」，热图停在该时刻并提示可在新时刻重新生成。
- 关键时刻联动：Info 面板的关键时刻可作为重新生成的候选帧。

## 12. 采集 app 改动（按收益 / 成本排序）

1. **meta.json 写姿态** ✅（2026-09-08，app 仓库本地未提交、未真机验证）：MainScreen 录制开始前 `readVerticalOrientationOnce(500)` 取一次融合姿态 → `FlirThermal.startRecording(dir, tracks, pose)` → Kotlin/Swift 会话冻结 `CapturePose` → 写入 meta.json `pose:{pitchDeg,rollDeg,azimuthDeg}` → files.ts 读成 VideoItem.pose → 上传请求 `capturePose` → experimentDoc 写 `experiments.capturePose`。web 端 §6.2 已消费。
2. **视差距离**：录制前让用户选「近 / 中 / 远」或用 `FusionController.distance()` 设标称距离，减小 §2 残差。
3. **设置照片流程**：录像前引导拍 1–3 张（正面 / 侧面 / 俯视），每张存 `setup/{k}/vis.jpg + ir.png + data.dat + pose.json`，随录像上传到 `recordings/{id}/setup/`。Web 端：多视角语义重建——同一物体两视角对应、三角化接触点、背面热图改为实测、两视角都认出才算数。
4. **ARCore / ARKit 位姿与桌面平面**：第二阶段以后，集成成本中等。

## 13. 对比赛（模型选型）

### 13.1 脚本

`scripts/evalTwinScene.ts`（已写）：

```
npx tsx scripts/evalTwinScene.ts [--ids=exp1,exp2] [--rec=recId,...] [--frame=N|mid] \
  [--models=gpt56,gemini,gpt52,grok|all] [--limit=10] [--trash] [--context] [--dry] [--out=eval-twin]
```

- 自动发现有 vis 帧的 app 录像（或指定 id），取中间帧（或指定帧），下载 vis / ir / dat，算帧统计，按 §5 契约调用每个模型。
- 输出到 `eval-twin/<时间戳>/`：每次调用的原始响应与解析结果、`summary.md` 表、`report.html`（可见光图上叠各模型的框，颜色区分，旁边是 JSON）。
- 密钥读 `functions/.secret.local`（本地已有 OPENAI / GOOGLE / XAI），环境变量可覆盖。

### 13.2 评分

| 指标 | 计法 |
|---|---|
| 识别正确率 | 人工对照：kind 对 / 错 / 漏 / 多 |
| 关系正确率 | restingOn 与实际一致 |
| 框重合度 | 与手标框 IoU（report.html 里目测打分，或后续加标注文件） |
| JSON 合法率 | schema 校验一次通过 / 降级次数 |
| 可渲染判断 | 与人工判断一致（屏幕 / 房间 / 模糊应为 false） |
| 延迟、token | 脚本自动记录 |

### 13.3 语料

需要用 app 新录约 10 段真实布置，每段 10 秒即可，覆盖：烧杯在三脚架 + 酒精灯上；锥形瓶在热板上；试管架 + 试管；量筒 + 烧杯并排；冰块在金属块上；铁架台夹烧杯；两个不同规格烧杯；杯子加热水；手持物体（应判不可渲染或忽略手）；对着屏幕拍（应判不可渲染）。

## 14. 里程碑

1. **M0 契约与对比赛**：twinScene.ts + 脚本 ✅；语料录制 + 选型 ⏳（需用 app 录 §13.3 的布置）。
2. **M1 单帧孪生** ✅ 代码就绪（2026-09-08）：
   - 门槛 `src/utils/twinStability.ts`（高通 + NCC + 抛物线亚像素；相对参考帧漂移 ≤ 12 px 即过，绘制逐帧对齐补偿，见 §4）；
   - 函数 `analyzeTwinScene` / `clearTwinScene`（functions/src/index.ts，紧邻 clearLabReport；staff + owner；json_schema→json_object→text 三级降级；`update()` 整体替换 twinScene）；
   - 规则：`twinScene` 已进 create/update 两处 deny-list；
   - 求解 `src/utils/twinSolver.ts`、投影 `src/utils/twinThermal.ts`、器具 `twin/props.ts`、场景 `twin/twinScene3d.tsx`（lazy chunk）、面板 `twin/twinPanel.tsx`（生成跑在模块级 run，切 tab 不掐断）；
   - 类型镜像在 src/types.ts（TwinScene… / TwinSceneRecord）；服务 `services/ai.ts` analyzeTwinScene/clearTwinScene；
   - 44 条单测全过（stability 9 / solver 9 / thermal 5 / contract 9 + 既有），vite build 绿，新文件 lint 零告警。
   - 未做：上机验证（需 staff 账号 + 一段稳定的 app 录像）。
3. **M2 可编辑与配准** ✅ 代码就绪（2026-09-08）：
   - 对象手改 `twinEdits`（种类 / 规格 / 承托 / 隐藏 + 俯仰滑杆），`applyTwinEdits` 纯函数（含测试），owner 防抖持久化、viewer 本地沙箱、重新生成即清空；
   - 配准 `functions/src/twinRegistration.ts`（vis 边缘 ↔ mix 边缘求 T，再 ↔ 温度梯度求残差 e，分数门控，测试 6 条），在 analyzeTwinScene 里与模型调用并行，结果 `twinScene.registration{dx,dy,score,method}`，客户端投影已应用；
   - app 写姿态 → `experiments.capturePose`（§12.1），web 求解器优先采用。
4. **M3 动画** ✅ 代码就绪（2026-09-08）：播放器每帧把 recording 帧号发到 store（`playerRecordingIndex`），twin 面板「follow playhead」按帧取温度（共享 LRU 缓存 + 预取 3 帧 + 拖动去抖），顶点颜色就地更新；与参考帧的相似度低于 0.45 时提示布置已改变；标签页忙碌小圆点已接。
5. **M4 多视角设置照片**（§12.3）⏳ 未开始：需要 app 端新增引导式采集流程、上传清单与 storage.rules 扩展 `setup/`，以及 web 端多视角对应 + 三角化求解；按 §0.7 属可选升级，待 M1–M3 上机验证后再做。

## 15. 陷阱与约定

- Firestore 禁嵌套数组；`undefined` → `null`；根目录 `tsc --noEmit` 是空操作，须 `tsc -b`；vite build 才能抓到重名符号。
- 部署顺序 rules → functions → hosting；functions 部署需 `FUNCTIONS_DISCOVERY_TIMEOUT=120`。
- three.js 只允许出现在 lazy chunk 里；SVG 色内联（html2canvas）。
- 模型返回的框只用底边中心与高度，边缘精修走确定性算法；模型返回的 sizeCm 只在无名义尺寸表项时使用。
- 语言模型的框精度不够时，方案是加专用视觉层（Grounding DINO / OWLv2 检测、SAM 2 掩膜、Depth Anything 相对深度，跑在 GPU Cloud Run 或托管推理），不是换一家语言模型。

## 16. 图片集的建筑孪生（2026-09-09，本地已实现、函数未部署）

用户拍板：**图片格式的实验（sourceType `photos`，docs/photo-set-experiments.md）也要有 3D Twin**。现有图片集全是建筑：同一栋楼从不同角度拍的几张照片，要据此建 3D 模型。与录像孪生同一条路线——语义重建，不做摄影测量——但"认物"换成"认体量"：

```
图片集 ──► ② analyzeTwinBuilding（一次把整套照片送视觉模型 → TwinBuildingScene JSON）
              │ renderable=false / 无块 / 无照片显示建筑 → 不渲染，给出原因
              ▼
          ③ 求解（客户端 utils/twinBuilding.ts）：块 → 面；每张照片拟合一个针孔相机
              ▼
          ④ 贴图：每个面选"看得最正、最全、最大"的那张照片，把它（可见光 / 温度 / 混合）投影到面上
              ▼
          ⑤ R3F 渲染（twin/twinBuilding3d.tsx，lazy chunk）；面板 twin/twinBuildingPanel.tsx
```

### 16.1 契约（`functions/src/twinBuilding.ts`，`TWIN_BUILDING_VERSION = 1`）

- **建筑坐标系**：主体块的地面足迹中心为原点，+y 向上；面对正立面站着，+x 是你的右手，+z 朝你（块的正面在 z + depth/2）。模型自己选"正面"（主入口，否则照片 1 看得最全的那面）并在 `front` 里说明。
- **块**（1–6 个，轴对齐直方体）：`x, z, width, depth, height, baseY, roof(flat|gable|hip|shed), roofHeight, stories, facade{material,color,glazing}, thermalNote, confidence`。尺寸靠层高（办公/学校 ≈3.5 m）、门、车、人推算。
- **每张照片**：`shows`、`azimuthDeg`（相机**站位**绕建筑的方位：0 在正前方 +z 侧、90 在右侧 +x、180 在背后、270 在左侧，从上看顺时针）、`pitchDeg`（正=仰）、`distanceM`、`bbox`（整栋楼）、`corners[]`（能指认的块角点：`bottom|top-front|back-left|right` + 图像分数坐标；只报可见且在画幅内的，4–8 个）。
- 提示词强调**所有照片共用一个坐标系**；热像只用来写 thermalNote，几何来自可见光。
- 解析：无正尺寸的块丢、角点引用不存在的块丢、未发送的照片编号丢、0..1000 坐标缩放、方位取模。`twinBuildingBlocker`：不可渲染 / 没有 confidence ≥ 0.4 的块 / 没有照片显示建筑。
- `pickTwinPhotos`：一套最多送 8 张（多了均匀抽样，首尾必取）。`imageSize` 从 JPEG SOF / PNG IHDR 读像素尺寸（相机模型需要长宽比）。

### 16.2 函数 `analyzeTwinBuilding`（index.ts，紧邻 clearTwinScene）

- staff + owner；`sourceType === 'photos'` 且 `photoCount ≥ 1`。每张照片：有温度（`photoThermal[k-1] !== false`）→ `vis_k.jpg` 当图片、`data_k.png` 当热像渲染附在其后、`mix_k.jpg` + `data_k.dat` 做配准与统计；纯图片 → `data_k.png` 就是图片本身。缺 vis 的热像照片用渲染图顶替图片、不重复附。
- 模型仍钉 `TWIN_MODEL_KEY`；`callModelForTwinScene` 加了 `format` 参数（schema 名 / schema / maxTokens），同一条 json_schema→json_object→text 降级梯子。超时 240 s、内存 1 GiB、9000 tokens。
- 每张热像照片并行跑 `registerVisibleToThermal`（从原 analyzeTwinScene 内联代码抽出的公共函数）。
- 持久化到**同一个 `twinScene` 字段**（`kind: 'building'`），所以 firestore.rules 的 deny-list 原样覆盖，**不需要改规则**；`clearTwinScene` 通用。记录：`{ kind, version, model, photosSent[], photos[{photo, thermal, width, height, registration}], scene, blocker, analyzedAt }`，`update()` 整体替换并删 `twinEdits`。

### 16.3 求解器（`src/utils/twinBuilding.ts`，16 条单测）

- 相机：local→world `R = Ry(yaw)·Rx(pitch)·Rz(roll)`，视线 −z；FLIR 照片用 43°×55°，其他图片长边按 `DEFAULT_PICTURE_HFOV = 66°`（有 ≥6 个角点且镜头未知时焦距一起拟合，限 35–115°）。
- 块 → 面：四面墙到檐口 + 屋顶面（平顶 1 面；gable/hip/shed 各 4 面，脊沿长边；每个面是双线性四边形，三角形重复末点），法线全部朝外（单测逐面验证）。
- 每张照片三段拟合：①模型站位（方位/距离/俯仰，眼高 1.6 m）→ ②对整栋楼 bbox 做 (距离, yaw, pitch) 三参数 LM → ③≥4 个角点时做 6 自由度（+焦距）LM，Huber 加权三轮 IRLS，弱先验防退化；**只有角点重投影 RMS ≤ 对角线 8% 且位置合理才采纳**，否则退回 bbox 解并在面板警告"角点与块不一致"。合成测试：站位错 10°/距离错 1.4 倍也能恢复到 1.5 m 内、RMS < 2 px；80° 镜头拟合到 ±3°；左右互换的角点被拒。
- 面 ↔ 照片分配 `assignFacePhotos`：分数 = cos(法线, 指向相机) × 覆盖率（4×4 采样点在画幅内且不被其他块遮挡——线段-AABB slab 测试，块缩 3 cm 防自遮）× 画面大小因子；cos < 0.15 或覆盖 < 0.3 不要。热像模式只在带温度的照片里选。
- `faceGrid`：面按 `cellM` 细分（≤48×48），每个顶点投影到所选相机得 UV（v 向上），`inside` 标记在画幅内的顶点；渲染时"四角都在画幅内"的格子贴图、其余用素色（同一几何两个 material group）。

### 16.4 前端

- `types.ts`：`TwinBuildingScene/Block/Photo/PhotoMeta/Record`，`TwinRecord = TwinSceneRecord | TwinBuildingRecord`，`isTwinBuildingRecord`；`TwinEdits` 加 `blocks{hidden}` / `photos{excluded}`（`saveTwinEdits` 已清洗）。`twinPanel.tsx` 读记录时用 `isTwinBuildingRecord` 排除建筑记录。
- `workspacePanel.tsx`：`showTwin` 对 recording 和 photos 都开（同一门：记录存在或 staff+owner）；photos 走 `TwinBuildingPanel`。
- `twinBuildingPanel.tsx`：生成跑在 `twinRun.ts`（模块级 run 注册，切 tab 不掐断，标签页忙碌点复用 `twinRunningExpId`）。加载每张已放置照片的图片（`vis_k.jpg`→`data_k.png` 兜底，长边 ≤1024 画到 canvas）与温度（`fetchRecordingFrameBufferCached`）；**整套照片一个温标**：所有有效像素合并取 p1–p99，`plateauEqualization` 做显示映射，调色板取 set 的 `palette`，否则第一张热像照片的 `photoPalettes`，否则通用色带；热像 canvas 120×160 按配准偏移画（这样同一 UV 同时对上图片和温度），混合 = 图片 + 55% 热像。右栏：VIEW（Real/Thermal/Blend，无温度照片时后两项禁用；Labels / Camera spots(默认关，用户不爱相机圆锥) / Follow shown photo；温标图例）、建筑名+描述+front+求解警告、PHOTOS（每张：thermal/picture only · 方位° · 距离 m · 拟合方式；"Look from here" 快照到该相机；Used 开关=excluded）、BLOCKS（尺寸·层数·屋顶·材质·置信度；Shown 开关）。**跟随播放器**：`playerRecordingIndex` = 照片号，翻页即切到该照片的相机视角。
- `twinBuilding3d.tsx`：`Canvas flat`（关色调映射，热像颜色不能被 ACES 改）；贴图面用 `meshBasicMaterial`（不打光）、素色面 `meshStandardMaterial`；块描边 `edgesGeometry`；地面色按 `ground`；相机点=青色小球+标签；PerspectiveCamera 用照片的竖向 FOV、`Euler(pitch, yaw, roll, 'YXZ')`；无照片时从前右上方总览。
- CSS 只加了 `.twin-scale/.twin-scale-bar`（其余复用 `.twin-*`）。

### 16.5 第二轮（2026-09-09 晚，用户反馈「模型和贴图都不对，和图片不符；而且要支持模拟的热图贴图」）

用线上两套建筑记录（3 张 / 5 张街景截图）做了诊断脚本（scratchpad diag.ts：admin SDK 拉记录 + 图片，画 bbox/角点/重投影线框，Read 看图）。**根因**：模型的 2D 标注（bbox、角点）大致落在真实特征上，但它给的**米制块尺寸差 2 倍上下**、角点语义不严（把悬空块的底角标在柱脚、把凹进玻璃厅的角当块角），所以逐张相机拟合全部退回 bbox 解，贴图整体错位、跨面涂抹。三项改动：

1. **联合拟合 `refineJointly`**（bundle adjustment）：所有块的 (x, z, log w, log d, log h, baseY) + 所有相机 (位置, yaw, pitch, roll) + 纯图片**共用一个**焦距尺度，一起最小化全部照片角点的重投影（按对角线归一化，Huber 3% IRLS 三轮，`seen=false` 的角点权重减半），弱先验：块尺寸 σ=0.35(log)、平面位置 σ=0.25×范围、baseY σ=1.5 m；相机眼高 σ=1 m、俯仰 σ=0.2 rad、滚转 σ=0.05 rad（不钉紧的话拟合会把相机抬到空中来解释错标的角点）。只有整体 RMS 降到原来的 85% 以下且尺寸/机位合理才采纳（`layout.joint`），否则保留逐张解。合成测试能从错 1.4 倍的块恢复比例（RMS < 12 px）；**线上两套记录都没被采纳**（RMS 只能压到 50–60 px ≈ 对角线 3–4%）——GPT-5.6 的角点精度约 5–10%，这是当前瓶颈。
2. **角点单应贴图 `faceHomography`**：某张照片里某面墙的四个角都被模型指出时，用四点单应把这张照片钉到这面墙上（`faceGrid` 走 H 而非相机投影），不再受相机拟合误差影响；分配时优先（分数 ×1.3）。配合契约 v2（`seen` 标志 + 提示词要求"看得到的每面墙给全四角，被柱/树/车挡住的也给并标 seen=false；悬空块底角是底面角不是柱脚；不要把窗/凹口/幕墙分格当块角"），5 张那套 7 个可见面里 5 个拿到了单应。
3. **模拟热图 §16.6**。

另：`twinBuilding3d` 给 baseY ≥ 1.2 m 的块画周边柱子（6 m 一根）；面板块列表显示拟合后的尺寸、`raised x m`、联合拟合的误差变化。

### 16.5.1 第三轮（用户：「3D 模型还是不太对」「深度关系有问题」「UI 改参数特别卡」「先把 3D 模型准确性搞好」）

- **契约 v3：`relations`**——深度用文字说（`under / on_top_of / left_of / right_of / in_front_of / behind / flush_front / set_back_from` + distanceM），模型对定性空间关系远比对米数可靠。求解器 `applyRelations` 按顺序只动关系里的 a 块：under = 拉进 b 的足迹（模型自己的位置与 b 重叠 ≥10% 就不动，因为"under 两个翼"指跨在交界处）、顶不超过 b 的底、baseY=0；set_back_from = 正面退到 b 正面后 distance m；left_of/right_of 顶到 b 的端头。GPT-5.6 对 5 张那套给的关系全对（左翼 left_of+flush_front 主楼；门厅 under 主楼 set_back 2 m）。提示词另加：玻璃/凹进/暗的底层**不是**架空，只有从柱间能看穿才 baseY > 0（v1–v3 都把左翼标成架空 2.5 m）。
- **联合拟合改为绝对门槛**（RMS ≤ 对角线 3% 才采纳；之前"比初值好 15%"太松——bbox 初值本来就差几百像素，任何解都"更好"，第二轮的 ground 变体就这样把主楼缩成 18 m 还被采纳了）。另加"架空块的底角按地面读"的第二种解法，两种取 RMS 小的。
- **做过的实验（都没让联合拟合过门槛，记下来别再走）**：①块尺寸先验放宽到 σ0.8/1.5 → 整栋楼缩成 2 m（退化）；②默认视场角 66/80/95/110 → 无差别；③Gemini 2.5 Pro 同一提示词 → 角点更一致（RMS 28–30 px ≈ 1.4%）但每张只给 8 个角、bbox 给整幅、主楼层数/高度更离谱，机位被拉到 60 m 外；④**单视角测量学**（每个四边形的两个消失点求焦距、再用单应求墙面长宽比）→ 焦距估计 33°–125° 乱飞、同一面墙五张照片长宽比 1.3–2.8；⑤**边缘吸附**（Sobel 梯度沿边法向 ±4% 搜最强直线，80 个角点全部移动、屋檐线吸得很准）→ 联合 RMS 65 → 65 不变。结论：瓶颈不是角点局部精度，而是模型在不同照片里标的"同一面墙"不是同一块矩形、块拆分本身不是真实体量，任何数值拟合都救不了。
- **性能**：模拟热图拆成 `prepareFace`（与场景无关：纹素网格、玻璃掩膜、楼板线、噪声）+ `simulatePrepared`（每纹素三个数的一趟）；面 canvas 与 ImageData 常驻复用，只 `putImageData` + `faceTexturesVersion` 让贴图 `needsUpdate`；`FaceMesh` 几何只依赖映射方式不依赖贴图对象；温标改直方图分位数（不排序）；烘焙用 `makeProjector`；场景走 `useDeferredValue`。

### 16.6 模拟热图（`src/utils/twinSimulate.ts`，7 条单测）

纯图片集没有温度，用户要"模拟的热图贴图"。教学用的稳态围护结构模型，公式写在文件头：`T_surface = T_out + (α·I·max(0,n·s) + U·(T_in − T_out))/h_out − 天空辐射降温(朝上面)`，玻璃另混入反射的表观温度（竖直玻璃 20% 天空 + 80% 周围，晴天天空比气温低 25 K）。材质表 `WALL_PROPS`（U/α）、`GLASS_PROPS`（U 2.8、反射 0.15）、`ROOF_PROPS`；楼板边热桥 U×1.8、带宽 0.35 m。四个预设 `SIM_PRESETS`（冬夜/冬日/夏午/夏夜）+ 面板滑杆（室外、室内、太阳方位 0=正前 90=右）。**窗户布局**：面上有照片时，把照片烘焙到该面自己的纹素网格（`bakeFace`，单应或相机投影采样，`faceTexelGrid` 保证与模拟同网格），比该面亮度中位数暗 0.04–0.16 的纹素判为玻璃（`glassMaskFromBake`，覆盖率 < 40% 不用）；没有照片用 `proceduralGlass`（每层一条窗带，按 glazing 定高度/开间）。每面一张 canvas（行 0 = 面底边 ↔ 纹理 v=0），整栋一个 p1–p99 温标 + plateauEqualization；"Over the picture" 开关把模拟热图 55% 叠在烘焙的照片上。新视图模式 `simulated`（Segmented 第四项 "Sim"）：没有温度照片时自动落到它；图例标 "simulated"。3D 侧 `faceTextures` 按面贴、UV 用面自身 (s,t)。

### 16.7 未做 / 待验证

- **第一版函数已被用户部署并跑过两套街景截图**（线上记录 s9KX…/yUrf… 是契约 v1，没有 `seen`，角点少）；第二轮改动（契约 v2 提示词、联合拟合、单应贴图、模拟热图）**本地未提交、函数与前端均未重新部署**。部署顺序 functions → hosting（规则不动），部署后要 **Regenerate** 才能拿到 v2 的四角标注（单应贴图靠它）。
- **精度瓶颈是模型的角点定位（≈5–10% 画幅）**。再往前走的选项：①在客户端把模型给的四边形边缘吸附到图像强边（Sobel 边图沿边法向 ±4% 搜最强直线）——试过，联合拟合没变（16.5.1）；②第二次模型调用——**已做成 §16.8 的逐面放大描点（契约 v4）**；③专用检测层（plan §15 末条）。
- 对比赛脚本 `scripts/evalTwinScene.ts` 还没有建筑模式；本轮用的是 scratchpad 里的 callModel.ts / diag.ts / joint.ts（admin SDK + functions/.secret.local 的 key，NODE_PATH 指向仓库 node_modules 才能在 scratchpad 里跑）。
- 没做：屋顶与檐口的角点（只有 8 个箱角）、非轴对齐块、纹理接缝融合（相邻面来自不同照片时颜色/曝光不一致）、按块手改尺寸；模拟热图没有阴影/遮挡（相邻块互相挡太阳）、没有地面温度。

### 16.8 第四轮：墙面轮廓的放大二次描点（契约 v4，用户：「贴图和模型还是不太匹配，应该找准顶点，拉伸到模型的顶点上，而不是直接沿用照片铺在模型上」）

贴图的机制本来就是"四点单应把照片钉到面的四个角"（16.5 第 2 项），问题出在**顶点找不准**：第一遍模型整幅看图，角点差 5–10% 画幅，钉上去的照片整体偏一截；而没拿到四角的面又走 bbox 相机投影，糊成一片。两个实验（scratchpad `refine.ts` / `refine2.ts`，直调 GPT-5.6）：

- **逐角放大裁片**（以第一遍角点为中心裁 28% 画幅的方块，问"这个角在哪"）：屋檐角、悬空块底面角能到像素级（照片 2 主楼四角 129/166/123 px 的修正全部落在真实顶点上），但**语义会漂**：两个块相接处两个不同名字的角会答成同一个顶点、玻璃底层下面的底角答到地面、门厅块的角乱跑。
- **逐面放大裁片**（按第一遍四角的包围盒外扩 25% 裁，问"这面墙的轮廓四边形"）：语义稳得多（一次给整面墙，四点自洽），精度 5–15 px；失败模式是把窗框当墙顶、把柱脚当墙底（提示词已针对性加规则）。**采用这个。** 两个坑：①提示词里给了第一遍的数值坐标模型就照抄（照片 2 四面墙 0 px 移动）——只说"裁片围着这面墙"不给数；②说了裁片像素尺寸后模型用像素答而不是千分比——干脆就要像素坐标。

实现：

- `functions/src/twinBuilding.ts`：`TWIN_BUILDING_VERSION = 4`；`TwinBuildingPhoto.walls?: TwinBuildingWall[]`（每面 `{blockId, wall: front|back|left|right, quad: 4×{x,y,seen}}`，顺序 = 求解器面的 p00,p10,p11,p01 = 从外面看的左下、右下、右上、左上，`TWIN_WALL_CORNERS` 给每面墙对应的四个角名）；`planWallCrops`（≥3 个角的墙才裁，包围盒外扩 25%/缺角 45%、最少 48 px，每张最多 8 面按画面大小取）；`TWIN_WALLS_JSON_SCHEMA` + `buildTwinWallsPrompt`（整幅照片低清做上下文 + 每面一张裁片高清；规则：只认最外轮廓/架空块底边是底面、柱子全在底角之下/看不到这面墙就 visible=false/超出裁片允许外推并 seen=false）；`parseTwinWalls`（像素→画幅分数，丢掉上下颠倒、左右颠倒、非凸、太小、竖边斜过 40°、跑出画幅一半以上的答案；`visible=false` 不算错）；`refreshCornersFromWalls`（描出的角回写 `corners`，两面共用的角取均值，画幅外 2% 以上的不回写，第一遍没给的角补上）。`twinCrop.ts`：pngjs/jpeg-js 解码 + 裁片 JPEG（functions 新增依赖 `pngjs`）。
- `index.ts`：第一遍之后每张照片各一次调用并行跑（`Promise.all`），失败只丢这张的 walls；`FrameImage.detail`。总时长约 40 s + 35 s。
- 客户端 `faceHomography` 先找 `walls` 里这面墙的四边形，没有再退回四角名；`assignFacePhotos` 单应候选加"在画幅内的覆盖率"（描出的墙可以出画）；**bbox/模型站位的相机不再投影贴图**（`projectsReliably`：只有 corners/joint 拟合的相机能投影），没有单应也没有可信相机的面留素色——糊一片不如空着。面板：version < 4 提示 Regenerate；照片行显示"n walls traced"。

## 17. 图片集孪生改为「模型写场景代码」（2026-09-10，契约 v5，本地已实现、未提交、未部署）

用户 2026-09-10 重新定目标：**只是 demo，把建筑模型完整展示出来就好；热图只要模拟贴图，不需要保真；重点是模型要还原照片里的几何关系。** 起因是网页版 GPT-5.6 用同样的照片直接写了一段 three.js，效果比 §16 的六个盒子好看得多（柱子、玻璃底层、屋顶设备房、雨篷、马路人行道路灯棕榈树，带光照阴影）。§16 的照片贴图/联合拟合/墙面描点整套**已删除**（求解器、模拟热图、R3F 渲染、twinCrop、pngjs 依赖、twinEdits 的 blocks/photos），文档留作记录。

### 17.1 契约（`functions/src/twinBuilding.ts`，`TWIN_BUILDING_VERSION = 5`）

- 模型返回 JSON：`renderable / reason / confidence / name / description / code / views[]`。`code` 是 `function build(THREE, scene, api)` 的**函数体**（ES2020，不许 import/网络/DOM/定时器）；`views` 是每张照片的相机位置与目标点（场景坐标系，米），前端"Look from here"用。
- 提示词定义了框架 API：`api.material(kind, color)`（kind ∈ wall/glass/roof/column/canopy/frame/pavement/road/vegetation/other，热图按它上色）、`api.box(w,h,d,x,y,z,kind,color)`（底面在 y）、`api.cylinder(r,h,x,y,z,kind,color)`；也可直接用 THREE 几何。坐标系同 §16（正面朝 +z，+x 向右，原点主块足迹中心）。强调层数、翼的相对位置、架空净高、玻璃底层、柱列节奏、女儿墙，"看过照片的人从任何角度都能认出来"，≤300 个 mesh。
- `parseTwinBuildingCode`：剥 ``` 围栏和 function 头；`checkSceneCode` 在**去掉注释和字符串**的代码上按完整标识符查 import/require/fetch/window/document/parent/location/storage/eval/Function/定时器等（`windowBand`、注释里的 "window"、`mesh.parent` 都放行；`window.parent` 不放），死循环、`<script>` 也拒；被拒的程序变成 renderable=false + 原因，记录仍写入。`extractJsonObject` 只把包住整个答案的围栏当包装（程序里自己的围栏不算）。踩过的坑：第一版按 `\bwindow\b` 直接查，模型注释里写了 "window" 就被拒。
- 函数 `analyzeTwinBuilding`：只发图片（热像照片发 vis），一次调用（max_completion_tokens 30000），约 35 s；记录 `{kind:'building', version:5, model, photosSent, renderable, reason, confidence, name, description, code, views, blocker}`。

### 17.2 前端

- `twinFrame.ts`：一整页 HTML 字符串，放进 `<iframe sandbox="allow-scripts" srcDoc>`（无 same-origin：不透明源，拿不到父页的 storage/auth，只能 postMessage）。three r169 走 jsdelivr importmap（不透明源不能加载自家 bundle，CDN 带 CORS 可以）。框架自带渲染器、天空色背景、半球光 + 带阴影的方向光、地面、OrbitControls；`api` 同契约；程序加到 scene 的东西统一收进 `building` 组（清场用）。消息：`build / mode / view / overview` 进，`ready / built / error` 出。
- **模拟热图**：每种 kind 一个不打光 ShaderMaterial，共享场景 uniform（太阳方向、室外/室内温、辐照），片元里算 `T = tOut + (α·I·max(0,n·s) + U·(tIn−tOut))/h_out − 3.5·max(0,n_y) + bias`，铁红调色板；图例范围在 JS 用同一公式对场景里出现的 kind 取极值。四个预设（冬夜/冬日/夏午/夏夜）+ 室外/室内/太阳方位滑杆，改动只更新 uniform。
- `twinBuildingPanel.tsx`：Build/Regenerate/Clear（owner+staff）、Realistic / Thermal (simulated) 切换、About（名称/描述/置信度/mesh 数）；程序跑失败显示框架回传的错误并提示 Regenerate；version < 5 的旧记录显示"earlier analysis, Regenerate"。
- 类型：`TwinBuildingRecord` 改为 code/views 形态（旧字段可选），`TwinEdits` 去掉 blocks/photos。

### 17.3 验证与待办

- functions 10 条单测、tsc、build 绿；vite build、eslint 绿；模拟器端到端：5 张那套 35 s 拿到 v5 记录；scratchpad `runCode.ts` 用 Node 的 three 跑模型程序（同一套 api）验证能执行、数 mesh、看包围盒。
- **浏览器里的实际效果我没法看**（没有浏览器自动化），要用户开 dev 看：CDN importmap 在 sandbox iframe 里是否正常加载、阴影/材质观感、热图色。
- 部署：functions → hosting，规则不动；线上旧记录（v1–v4）会显示 stale 提示，点 Regenerate。
- 没做：模型自校正回路（把渲染截图连同照片再喂一次让它修）、owner 手改、三级降级对代码答案的意义不大（json_object 也行）。

### 17.4 模型换成 DeepSeek V4.1 Flash（2026-09-10，用户要求）

- DeepSeek API 的模型列表只有 `deepseek-flash`（文档：= DeepSeek-V4.1-Flash，支持图片输入，最大输出 384K，支持 json_object；`response_format: json_schema` 返回 400 "unavailable now"，三级降级自动落到 json_object）和 `deepseek-v4-pro`（不支持图片）。`QA_MODELS` 里原有的 `deepseek-v4-flash` 实际被服务端映射到 `deepseek-flash`。
- `index.ts`：`QA_MODELS` 加 `deepseekFlash41: deepseek-flash`（不向问答面板开放）；新增 `TWIN_BUILDING_MODEL_KEY = 'deepseekFlash41'` 只给 `analyzeTwinBuilding` 用，录像孪生 `analyzeTwinScene` 仍钉 `TWIN_MODEL_KEY = gpt56`；建筑函数的 secrets 加 `DEEPSEEK_API_KEY`（线上 Secret Manager 已有，问答在用）。
- `resolveOpenAiProvider` 的 deepseek 条目仍是 `vision: false`——那只影响问答/报告路径是否附图，孪生调用不看这个标志、总是发图；没动它。
- **思考预算是关键**：`deepseek-flash` 默认 reasoning_effort=high，让它写整段场景程序时把 30000 token 全花在 reasoning 上、content 为空（138 s，finish=length）；`reasoning_effort: 'low'` 约 82 s、reasoning 16.6k token、程序 4.4k 字符；`thinking: {type:'disabled'}` 13 s、程序 4.7k 字符。钉 **low**（`resolveOpenAiProvider` 新字段 `twinExtras`，只进孪生的一次性调用），建筑函数对 deepseek 用 max_tokens 60000（`TWIN_BUILDING_MAX_TOKENS_THINKING`，reasoning 计入 max_tokens）。
- 没有 json_schema 约束时 DeepSeek 把 views 写成 `position:[..]/target:[..]` 或 `camera/look`，`parseTwinBuildingCode` 已兼容三元组/{x,y,z} 和几个常见字段名。
- 验证：scratchpad `callDeepseek.ts <expId> [model] [maxTokens] [extraJson]` 直调计时；两版程序都能在 Node 里跑（110–114 mesh）。
- **z-fighting（用户 2026-09-10 截图：路面/地面闪烁）**：根因是相机 near 0.1 / far 3000 的线性深度缓冲在 100–150 m 外分不清相差 2 cm 的面（地面平面 y=−0.02 与模型铺的路面板顶 y=0），加上大平面上的阴影 acne。修法：`logarithmicDepthBuffer: true`、near 0.5 / far 2500、地面平面降到 y=−0.25、`shadow.normalBias 0.04`、玻璃 `depthWrite:false`（半透明重叠不再跳变）；热图 ShaderMaterial 加 `logdepthbuf_*` chunk 与标准材质写同一种深度；提示词加"同一平面不许有两个面：地面层逐层抬高、玻璃/框架凸出墙面 0.05–0.3 m"（要 Regenerate 才生效）。
