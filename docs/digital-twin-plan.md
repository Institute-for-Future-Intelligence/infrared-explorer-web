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

- 触发：owner 在 3D 标签页点 Generate。v1 沿用 generateLabReport 的 staff 门（内部账号），稳定后再放开。
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

- `WorkspaceMode` 加 `'twin'`；workspacePanel.tsx `options` 加 `{ label: '3D Twin', value: 'twin' }`，门控同 showReport（v1 staff）。
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
