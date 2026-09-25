# 3D 数字孪生（Digital Twin）实施方案

状态：**M0 + M1 已实现（2026-09-08，本地未提交、未部署、未上机验证）：契约 + 对比赛脚本 + 云函数 analyzeTwinScene/clearTwinScene + Digital Twin 标签页 + 稳定性门槛 + 求解器 + 器具库 + 热图投影。模型暂钉 gpt56（TWIN_MODEL_KEY），待语料录好跑对比赛后改。部署顺序 rules → functions → hosting。**
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

- 触发：owner 在 3D 标签页点 Generate。v1 沿用 generateLabReport 的 staff 门（内部账号），稳定后再放开。**门只管生成不管查看**：twinScene 随实验文档持久化在云端，凡能读到文档的人（分享出去的 public / unlisted 链接的访客，含未登录）都看到「Digital Twin」标签页——有孪生就显示 owner 留下的孪生（含 twinEdits 修正），没有就显示「owner 尚未生成」——只是没有 Build / Regenerate / Clear 按钮（2026-09-09 定，2026-09-10 改为标签页不再以孪生存在为条件）。
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

- `WorkspaceMode` 加 `'twin'`；workspacePanel.tsx `options` 加 `{ label: 'Digital Twin', value: 'twin' }`。门控：`twinScene` 已存在 → 任何读者（含未登录）都看到标签页；否则只有 owner + staff 看到（去生成）。生成按钮在面板里另按 owner + staff 判，函数端再查一遍。
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

用户拍板：**图片格式的实验（sourceType `photos`，docs/photo-set-experiments.md）也要有 Digital Twin**。现有图片集全是建筑：同一栋楼从不同角度拍的几张照片，要据此建 3D 模型。与录像孪生同一条路线——语义重建，不做摄影测量——但"认物"换成"认体量"：

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
- `workspacePanel.tsx`：`showTwin` 对 recording 和 photos 都开（只看来源类型，对所有读者可见；生成按钮仍由面板按 owner+staff 门控）；photos 走 `TwinBuildingPanel`。
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
- **2026-09-11 DeepSeek 合并（用户要求）**：问答/报告/Lab Assistant 选择器里的 V4-Pro、V4-Flash 两项合并成一项 `deepseek` → `deepseek-flash`（标签 "DeepSeek V4.1 Flash"），`deepseekFlash41` 同时并入这个键（`TWIN_BUILDING_MODEL_KEY`、`TWIN_PROGRAM_MODEL_KEYS`、twinModels.ts 都改成 `'deepseek'`；旧孪生记录按 vendor id `deepseek-flash` 仍能对上）。`resolveOpenAiProvider` 的 deepseek 改成 `vision: true`（V4.1 Flash 读图已实测）。新字段 `chatExtras`：deepseek 在报告/问答/助手调用里关思考（`thinking: {type:'disabled'}`）——真实报告提示词下默认 high 思考把 6000 token 全花在 reasoning、正文为空。`twinExtras`（low）不变。旧键 `deepseekPro`/`deepseekFlash` 服务端 `RETIRED_MODEL_KEYS`、客户端 `RETIRED_MODELS` 映射到 `deepseek`，存量问答轮次仍显示原模型名。关思考后 DeepSeek 会把工具轮之间的旁白写进正文，在带工具的轮次里直接写报告时标题前会多一句"I have what I need. Writing the report."（实测 10 份里 3 份），`stripReportPreamble`（analysis.ts）在存盘前去掉标题前的短旁白。**部署顺序：先 functions（至少 generateLabReport / answerExperimentQuestion / agentChat）后 hosting**——新前端发 `'deepseek'`，旧函数不认，会静默改用 GPT-5.6，问答气泡却标 DeepSeek。
- **z-fighting（用户 2026-09-10 截图：路面/地面闪烁）**：根因是相机 near 0.1 / far 3000 的线性深度缓冲在 100–150 m 外分不清相差 2 cm 的面（地面平面 y=−0.02 与模型铺的路面板顶 y=0），加上大平面上的阴影 acne。修法：`logarithmicDepthBuffer: true`、near 0.5 / far 2500、地面平面降到 y=−0.25、`shadow.normalBias 0.04`、玻璃 `depthWrite:false`（半透明重叠不再跳变）；热图 ShaderMaterial 加 `logdepthbuf_*` chunk 与标准材质写同一种深度；提示词加"同一平面不许有两个面：地面层逐层抬高、玻璃/框架凸出墙面 0.05–0.3 m"（要 Regenerate 才生效）。

### 17.5 模拟热图复核 + 固定色标 + 探针（2026-09-10，用户要求，本地已实现、未提交、未部署）

- **复核结论**：`T = tOut + (α·I·max(0,n·s) + U·(tIn−tOut))/h_out − 3.5·max(0,n_y) + bias`（h_out 15）是稳态表面能量平衡，墙/玻璃/屋面/沥青的量级对（冬夜玻璃比空气高约 5 K、墙高 1 K、屋面低 3 K；夏午向阳墙 ≈ 50 °C、屋面 ≈ 66、沥青 ≈ 70）。改了三处不合理系数：`column` U 1.2→0.3、`canopy` U 1.0→0.15（架空层的柱子和雨篷背后没有采暖空间，原来冬夜比外墙还暖）；`vegetation` α 0.3→0.12（叶片把吸收的太阳能大多用于蒸腾，原来夏午树冠 40 °C，现 ≈ 33 ≈ 空气）。视角阴影因子 0.82+0.18 → 0.92+0.08，免得同一温度的两面颜色差到读错图例。**仍是演示**：无热惰性（夏夜路面不会比空气暖）、无相邻部件的日照遮挡（架空层下的玻璃厅照样"被晒"）、玻璃无长波反射。
- **固定色标**：原来图例范围按场景里出现的 kind 对 cosSun∈{0,1}×up∈{0,1} 取极值——上界取到"正对太阳又朝天"这种不存在的面，范围比实际宽；且随滑杆一起滑动，拖"Outside"时颜色几乎不变。现在色标固定：`PRESETS[k].range`（冬夜 [−12,2]、冬日 [−5,25]、夏午 [25,75]、夏夜 [15,30]，都能容下该预设的全部面并留余量），面板加 "Scale" 双柄滑杆（−30…90 °C，最少 2 K 宽）可手调，切换预设时重置；消息 `build`/`mode` 多带 `range`，帧收到无效 range 才退回自动拉伸。超出色标的面在调色板两端饱和。
- **探针**：Simulation 分区加 "Probe" 开关（仅热图模式生效）。开着时鼠标悬停显示指针下表面的模拟温度（一位小数 + kind），点击（位移 ≤4 px、按住 ≤600 ms，与轨道拖动区分）钉一个读数，点钉住的读数删除，最多 12 个；标题行出现 "Clear N readings"。读数用 JS 里同一条公式 `surfaceTemp(kind, n)` 算，法线取命中三角形的**插值顶点法线**（`THREE.Triangle.getInterpolation`，圆柱无棱；退化时退回面法线），与着色器一致；钉住的读数记世界坐标点/法线/kind，场景改了重算，相机动了重投影，被模型挡住时变淡（相机→点射线的首个命中更近即为遮挡，只在相机变化时算）。消息：`probe {on, clear}` 进、`probes {count}` 出；`build` 清空所有钉。
- **单位**：面板 Outside/Inside/Scale 行与滑杆 tooltip 跟随用户的 °C/°F 设置（滑杆内部仍是 °C），与帧内图例一致。
- 验证：帧内脚本抽出后 `node --check` 通过；prettier/eslint 绿；`tsc -p tsconfig.app.json` 无 twin 相关错误（仓库固有 8 个旧错不变）；`vite build` 绿。**浏览器里没亲眼看过**：要用户开 dev 验证探针命中、钉标随相机移动、色标观感。
- **探针标线修正（同日，用户反馈"没有对准、圈太大"）**：原来圆环是 14 px 内容盒 + 2 px 边框（content-box 共 18 px）却只回移 7 px，圆心比指针偏右下 2 px，而十字线碰巧居中，二者互相错位；位置又只在渲染循环里更新，移动时慢一帧。改为内联 SVG 标线（26 px 画布、圆 r=4.5 加四根 7–12 px 刻度，黑晕托底，钉住的为黄色），`left/top: -13px` 精确居中；`pointermove` 里立刻 `placeEl`。**用 headless Chrome + CDP 实测**（scratchpad `makeHarness.mts` 生成 frame.html/harness.html，`cdpProbe.mjs <dsf>` 用 Node 22 内建 WebSocket 驱动 `chrome --headless=new --remote-debugging-port`，`--use-angle=swiftshader` 跑 WebGL）：dsf 1 / 1.25 / 2 下悬停与钉住的标线中心与指针差 0.0 px，读数按表面类型正确（屋面 66.5、地面 55.7、铺地 60.6），拖动轨道不误钉、钉随模型移动，指天空无读数；截图 probe-shot-dsf1.png 已目检。
- **探针延迟（同日，用户反馈"prob和鼠标有延迟"）**：两个根源。①帧内每个动画帧都全量 `renderer.render`（含 2048² PCFSoft 阴影贴图的深度通道），主线程被渲染占满，指针事件只能按帧率排队送达。改为**按需渲染**：`dirty` 标志 + `controls.update()` 的返回值（相机动了才 true），只有相机/模型/材质/uniform 变了才 render；`renderer.shadowMap.autoUpdate = false`，仅在 build/换模式时 `needsUpdate = true` 烤一次（模型与太阳都不动，截图确认阴影仍在）。悬停拾取（CPU 射线）不需要渲染，rAF 里只做 pick + 写标签；标线的 transform 在 `pointermove` 事件里同步写；画布矩形缓存到 resize 才重新量。②DOM 跟随物天生比系统光标晚一帧，只要原生光标还在就看得出来 → 探针模式 `canvas.probing { cursor: none }`，标线本身当光标：指针在画布内就一直显示，没命中（天空）只隐藏标签（`.probe.nohit .lab`）。CDP 实测：街景视角指天空 nohit=true/标签隐藏/标线仍在，指地面读 55.7 °C ground；空闲与拖动轨道时 rAF 都 ≈16.5 ms（软件 GL 小场景）；钉住的读数拖动后仍随模型。

## 18. 场景孪生 v6：真实测温 + 推断、任意主体、录像的环绕模式（2026-09-10 用户要求，规格）

用户三条要求：①图片里有温度数据时，3D 模型应显示**真实温度**并**推断**其余面（不再只是模拟贴图）；②录像实验生成 3D 前让用户选**稳定模式**（固定机位 → 现有 props 孪生 §1–§14）还是**环绕模式**（绕主体拍 → 场景代码孪生 §17）；③环绕模式**不限于建筑或器材**，AI 自己判断建什么。§17 的"模型写场景代码"路线保留并泛化；§16 的教训（模型给的米数/角点做不了数值重建、逐面四边形 5–15 px 且语义稍漂、提示词里给数值会被照抄）继续有效。

### 18.1 契约 v6（`functions/src/twinBuilding.ts`，文件名不改，`TWIN_BUILDING_VERSION = 6`）

- **主体不限**：提示词从 "ONE building" 改为 "ONE subject —— a building, a room, a lab bench with apparatus, a machine, a vehicle, a tree, a statue …"，由模型判断主体是什么并照实建模。答案新增 `subject`（一句话，主体是什么）和 `subjectKind ∈ 'building' | 'interior' | 'apparatus' | 'vehicle' | 'nature' | 'other'`（只有 `building` 提供"模拟围护结构热图"；其他主体只有 Realistic + Measured——**§21 起改为所有场景孪生都提供 Simulated**）。
- **部件命名（parts）**：每个 mesh 必须属于一个有名字的部件。`api.box(w,h,d,x,y,z,kind,color,part)` / `api.cylinder(r,h,x,y,z,kind,color,part)` 末尾加可选 `part`（短 camelCase，如 `mainBlock`、`northWing`、`kettle`）；直接用 THREE 造的 mesh/group 设 `.name = part`。答案带 `parts: [{name, kind, description}]`，代码里只能用这些名字。帧里 mesh 的部件 = 自己的 name（在 parts 里）→ 最近的有名祖先 → `'unnamed'`。服务端解析：`parts` 缺失时用正则从代码抽 `api.box/cylinder` 末参数字符串与 `.name = '…'` 兜底。
- **kind** 扩为主体无关：保留 10 个建筑 kind，加 `metal, plastic, wood, stone, liquid, fabric`（只影响 Realistic 的默认颜色；模拟热图仍只认建筑 kind，其余按 `other`）。
- **尺度自适应**：帧在 build 后按包围盒调 fixtures——地面 y = bbox.min.y − 0.002·size、地面边长 20·size（≥ 2 m）、阴影相机视锥包住 bbox、camera near = size/500、far = size·50——桌面器材（0.5 m）和建筑（100 m）都能看。
- **第二阶段：逐张热像照片描表面**（新函数 `buildTwinSurfacePrompt(ctx)` + `parseTwinSurfaces(text, parts, photo)`）。第一阶段拿到程序与 parts 后，对每张**带温度**的照片并行各一次调用：输入 = 该照片可见光（detail high）+ 热像渲染 data_N.png（detail low，"只为看清热学分界，不要从颜色读温度"）+ 文本：parts 清单（name/kind/description）、模型自己给的该照片 `view`（相机位置/目标点，用文字说"你判断这张是从 … 拍的"）。输出 JSON：`{ surfaces: [{ part, face, quad: [x0,y0,x1,y1,x2,y2,x3,y3], visible }] }`，`face ∈ front|back|left|right|top|bottom|all`（主体坐标系：front = +z、right = +x、top = +y；圆柱、树等没有分立面的用 `all`），`quad` 为该表面在**图片中**的四边形四角（宽高的分数 0..1，从左上顺时针），紧贴表面、不含天空/地面/前景遮挡物；只报 ≥ 图片 2% 且至少一半可见的表面；每张 ≤ 24 个。解析宽容（数组/对象、0..1000 缩放、夹取），part 名大小写不敏感匹配，匹配不到的丢。
- **统计**（纯函数 `surfaceStats(quad, temps, w=120, h=160, registration, aspect?)`）：四边形按分数映射到热像网格（x·120, y·160）再加配准 (dx, dy)（可见光特征 (u,v) 在热像里落在 (u+dx, v+dy)，`registerVisibleToThermal` 已有），扫描线判点在多边形内取像素，得 `{n, median, p10, p90, min, max}`；n < 6 丢弃。可见光与热像同一 Fusion 视场，分数直接对应。
- **记录**（Firestore `twinScene`，`kind` 仍为 `'building'` 以兼容读取代码，`version: 6`；**禁嵌套数组**：quad 是 map 内的平数组，合法）：
  ```
  { kind:'building', version:6, model, source:'photos'|'orbit', photosSent:number[],
    renderable, reason, confidence, name, description, subject, subjectKind,
    parts:[{name,kind,description}], code, views,
    thermal: null | {
      photos:[{photo, registration:{dx,dy,score}|null, min, max}],   // 实际用上的热像照片
      surfaces:[{part, face, photo, quad:[8 个数], n, median, p10, p90}],
      range:[lo,hi]   // 全部 surface median 的 p2..p98 向外取整 ±1：Measured 视图默认色标
    },
    blocker, analyzedAt }
  ```
- 每套照片最多送 8 张（同 §17）；其中热像照片各一次第二阶段调用（≤ 8 并行，单张失败只丢这张）。`TWIN_BUILDING_TIMEOUT_SECONDS` 240 → 360。

### 18.2 录像的环绕模式（服务端）

- `analyzeTwinBuilding` 请求加 `source?: 'photos' | 'orbit'`。`sourceType === 'recording'` 且 `source === 'orbit'` 时接受录像：frameCount = round(duration × 5)（RECORDING_FPS，与报告采样器一致），photos = `pickTwinPhotos(frameCount)` 的帧号，每帧都是热像（data_k.dat/vis_k.jpg/mix_k.jpg 同录像布局）；记录 `source:'orbit'`、`photosSent` = 帧号。录像的 `twinScene` 字段于是可能装着场景记录，客户端按 `kind` 分派。
- 客户端 `services/ai.ts` 的 `analyzeTwinBuilding(expId, source)`。

### 18.3 客户端

- `types.ts` 镜像：`TwinBuildingRecord` 加 `source?`、`subject?`、`subjectKind?`、`parts?`、`thermal?`。
- **新纯函数模块 `src/utils/twinSceneThermal.ts`（带单测）**：
  - `FACES = ['front','back','left','right','top','bottom']`，`faceOfNormal(nx,ny,nz)` 取主轴。
  - `buildSurfaceTable(thermal, sceneParts: [{name, kind, faces}])` → `{ entries: [{part, face, tempC, measured, photo?, from}], range }`：
    - 实测：某 (part, face) 有 surfaces → 按 n 加权的 median 均值；`face:'all'` 的实测覆盖该部件所有未单独实测的面。
    - 推断（按序取第一条命中，`from` 写明依据）：(a) 同部件其他实测面的均值 "from this part's measured faces"；(b) 同 kind 同 face 的其他部件 "from other <kind> faces facing the same way"；(c) 同 kind 任意面；(d) 全部实测面均值。没有任何实测 → 表为空、Measured 视图不可用。
- **帧 `twinFrame.ts`**：
  - build 后 `built` 消息带 `parts: [{name, kind, faces}]`（faces = 该部件顶点世界法线分类后出现过的面）。
  - 新消息 `{ type:'paint', entries:[{part, face, tempC, measured}], range:[lo,hi], palette: string[]|null, measuredOnly }`：为每个 mesh 建 `aTemp`/`aMeasured` 顶点属性（顶点世界法线 → face → 查 (part, face) → 退 (part,'all') → 退该部件均值 → NaN 灰），切到**实测着色器**：颜色 = LUT(clamp((T−lo)/(hi−lo)))，LUT 来自 `palette`（256×1 DataTexture）否则内建 iron；推断顶点向灰混 25%，`measuredOnly` 时全灰。
  - 模式值 `'realistic' | 'simulated' | 'measured'`（`'thermal'` 作 `'simulated'` 别名）。探针在 measured 模式读同一张表：`34.2 °C · glass · measured (photo 3)` / `… · inferred`；simulated 模式照旧。
  - fixtures 随包围盒自适应（18.1）。
- **面板 `twinBuildingPanel.tsx`**（图片集与环绕录像共用）：Segmented = Realistic | Measured（`thermal.surfaces` 非空时）| Simulated（`subjectKind === 'building'` 或无 thermal 时；**§21 起恒提供**）；Measured 分区：Measured only 开关、Scale（默认 `thermal.range`）、Probe、一行 "N surfaces measured in M photos · K faces inferred"；`built` 后用 util 算表再发 `paint`；调色板取 `experiment.palette`（`PALETTE_COLORS[key]`，没有则 iron）。
- **录像面板 `twinPanel.tsx`**：生成前（无记录）加模式选择：`Fixed camera`（现有流程：稳定性门 → analyzeTwinScene）/ `Walk-around`（新：`analyzeTwinBuilding(expId,'orbit')`，无稳定性门），各配一行说明；Regenerate 旁也能切模式。记录存在且 `isTwinBuildingRecord` → 渲染 `TwinBuildingPanel`（recording 也能进）；固定模式因抖动失败的报错里提示改用 Walk-around。
- `workspacePanel.tsx`：Photos → TwinBuildingPanel；Recording → TwinPanel（内部按记录 kind 再分派）。

### 18.4 诚实呈现

推断面 25% 灰混、Measured only 全灰；探针读数标 measured/inferred 与来源；图例说明 "measured surface temperature · inferred faces greyed"。

### 18.5 验证

functions 单测（parseTwinSurfaces、surfaceStats 合成网格、提示词、parts 抽取、记录无嵌套数组）；util 单测（faceOfNormal、表的实测/推断规则）；帧脚本 `node --check` + CDP harness（命名部件的测试模型 + 假 paint 表 → 截图 + 探针读 measured/inferred）；tsc(app) 无 twin 错、eslint、vite build、functions build+test；有条件时模拟器端到端跑一套真实热像图片集。

### 18.6 评审决议与接口契约（2026-09-10，四镜头评审后定稿；**以本节为准，与 18.1–18.5 冲突处按本节**）

评审（服务端/客户端/模型提示词/热成像四个独立 agent，34 条意见）接受的改动：

**A. 模型与调用**
- A1 第二阶段（描表面）**单独钉模型** `TWIN_SURFACE_MODEL_KEY = 'gpt56'`（2D 定位只在 GPT-5.6/Gemini 上量过；OpenAI 支持严格 json_schema 与 image `detail`）；第一阶段仍 `TWIN_BUILDING_MODEL_KEY`（deepseekFlash41）。不用 Claude。
- A2 `resolveOpenAiProvider` 加 `supportsImageDetail: boolean`（openai true，其余 false）；`callModelForTwinScene` 只在支持时带 `detail`；新增可选参数 `extras?: Record<string, unknown>` 覆盖 provider 的 `twinExtras`（第二阶段不需要 reasoning；maxTokens 6000）。
- A3 `TWIN_BUILDING_TIMEOUT_SECONDS = 360`；客户端 `analyzeTwinBuilding` timeout 370_000；第二阶段用 4 并发的小池（不是裸 Promise.all 8 个），每个调用都传 `response.signal`；一次 `enforceAiRateLimit` 名额覆盖整次生成（与 generateLabReport 一致，写注释说明）。
- A4 第二阶段**坐标用像素**（§16.8 结论：告知像素尺寸后模型就按像素答）：提示词写 "coordinates are pixels in the W×H picture; x right, y down"；解析：八个数全 ≤ 1 视为分数，否则除以 (W, H)；四边形包围盒超出图片 5% 以上**丢弃**（不夹取）。
- A5 第二阶段输入：该照片可见光（detail high）+ 热像渲染 data_N.png（detail low，"只为看清一块表面到哪里结束，绝不从颜色读温度"）+ 文本：主体名、parts 清单（name — kind — description）、**由第一阶段 view 推导的文字视角**（服务端把相机−目标向量转成 "from its front-right; faces you can see: FRONT on the left half, RIGHT receding on the right; you cannot see BACK or LEFT"，**不给米数**）、第一阶段的程序代码（≤ 12k 字符，让模型知道每个部件的形状）。输出每个表面 `{part, face, facing, quad:[8 个像素坐标 TL,TR,BR,BL], note}`，`facing ∈ toward|camLeft|camRight|up|down`（相机相对，用于客户端镜像纠错）。要求**内接四边形**："the largest four-sided region lying SAFELY INSIDE that one surface — a hand's width inside its edges; leave out sky, ground, other faces, anything in front (trees, cars, people, cables); if an obstruction sits in the middle give the larger clear side only; skip a surface narrower than 1/20 of the picture; skip reflections in glass"。每张 ≤ 24 个；答案里必须出现 JSON 一词。
- A6 第一阶段提示词**两层**：主体中立的核心 + 按 `subjectKind` 的尺寸锚（building：层高 3.5 m/门 2.1 m；interior：门 2.1/吊顶 2.7/桌 0.75/椅面 0.45；apparatus：台面 0.9 m 高、250 mL 烧杯 7×9.5 cm、电热板 0.25 m、A4 0.21×0.30、手 0.18；vehicle：轮 0.65 m、车 4.5×1.8×1.5；nature：人 1.7 m）。核心规则："y = 0 is the surface the subject stands on (ground, floor or bench top); FRONT (+z): a building — its entrance facade; a vehicle — its nose; apparatus/objects — the side facing the camera in photo 1; an interior — the wall opposite the camera in photo 1; model an interior's walls as separate slabs seen from inside, never one hollow box"；views："the camera stood 1.5–4 subject sizes away, at the height the photos suggest"；场景配景 "only what the photos show around the subject, scaled to it"；**部件按温度可能不同处拆分**（壶身与壶把、电热板与其上的烧杯是不同部件）。schema 的 `renderable` 描述改成主体中立："true when the photos show ONE identifiable subject well enough to model it; false for several unrelated subjects, a screen or chart, or nothing recognisable"；schema 加 `subject/subjectKind/parts`；`name` 兜底 `'subject'`；blocker 文案中立。提示词加一句 "Never use the identifiers top, parent, self, window, document, location, frames as variable names"；`checkSceneCode` 对 `top|parent|self` 只在作为成员访问根（`top.`/`top[`）时拒绝，其余不变；加单测 `const top = api.box(...)` 通过。

**B. 部件与代码（取代 18.1 的末位参数方案）**
- B1 `api.part(name, kind, description)` 返回**作用域构建器** `{ box(w,h,d,x,y,z,kind?,color?), cylinder(r,h,x,y,z,kind?,color?), add(object3d), group }`：经它建的东西全进一个 `THREE.Group`（`name = 部件名`，`userData.part = 部件名`），`box/cylinder` 的 kind 缺省为部件 kind；原生 THREE mesh 用 `p.add(mesh)`。裸 `api.box/cylinder` 仍可用于无名配景（part = `'unnamed'`）。
- B2 **代码是 parts 的真相来源**：服务端在**原始代码**（不是 bareCode）上正则抽取 `api.part('name', 'kind', 'desc')` 调用（单双引号、可无 desc），与 JSON `parts` 合并（描述取 JSON 的；JSON 里有而代码里没有的丢并记 repair）；kind 不在扩展 kind 表里 → `'other'`；`description` 缺省 `''`（不能 undefined）。第二阶段只收到这份清单。
- B3 帧里部件解析：mesh.userData.part（api.part 造的）→ 沿祖先找 `userData.part` 或与 parts 名规范化匹配（小写、去非字母数字）的 `name` → `'unnamed'`；在 adopt() 时缓存到 `userData.part`。`built` 消息回报实际存在的部件（见 D1）。

**C. 服务端统计与记录**
- C1 `surfaceStats(quad8Fractions, temps, registration|null, erodePx) → {n, median, p10, p90, min, max, excluded} | null`：四点按质心极角排序（防蝴蝶结）；向质心**内缩** e px（配准 score ≥ 0.3 → 2；0.18–0.3 或 method 'vis-mix' → 3；无配准 → 5，并在表面上记 `registered:false`）；映射 `px = fx·120 + dx, py = fy·160 + dy`（无配准 dx=dy=0）；像素中心 (i+0.5, j+0.5) 点在多边形内；剔除 `c ≤ −100`（哨兵）与 `c < −20`（FLIR One 量程之下 = 天空/无效）；剔除超过多边形 30% → 整个表面丢弃（多为天空）；`n ≥ 64` 正常，`24 ≤ n < 64` 记 `smallSample:true`，`n < 24` 丢。
- C2 `decoded.complete === false` 的照片整张跳过（status `incomplete-frame`）；每张热像照片记 `picture: 'vis' | 'render'`，配准**只对 vis** 应用（render 顶替时 registration 显式 null）；`|width/height − 0.75| > 0.02` 的热像照片跳过（status `aspect`）。
- C3 `mixed = (p90 − p10) > max(3, 0.25 × sceneSpan)`（sceneSpan = 全部 median 的极差，收齐后算）；`apparent = kind ∈ {glass, metal, liquid}`（低发射率/反射，"表观温度"）。
- C4 记录（version 6，kind 仍 'building'）：
  ```
  thermal: null（没有任何热像照片被送）| {
    photos: [{ photo, picture:'vis'|'render', status:'ok'|'model-failed'|'unreadable'|'no-frame'|'aspect'|'incomplete-frame',
               error?: string, registration:{dx,dy,score,method}|null, p02?, p98? }],
    surfaces: [{ part, kind, face, facing?, photo, quad:[8 个分数,3 位小数], n, median, p10, p90, min, max,
                 smallSample?, mixed?, apparent?, registered:boolean, note? }],   // 温度 1 位小数
    range: [lo, hi]   // lo = floor(min median) − 1，hi = ceil(max median) + 1，跨度 < 4 时对称加宽
  }
  ```
  所有热像照片都因同一原因 `model-failed` → 函数**抛错**（系统性故障，不写记录）。旧 `min/max` 不存（单像素极值无意义），存 p02/p98。文档大小估算：8 张 × 24 面 ≈ 33 KB，远低于 1 MiB，勿拆子集合。
- C5 环绕模式抽帧（新纯模块 `functions/src/twinOrbit.ts`，带单测）：帧集 = `recordingSampling(exp.segments ?? null, duration, 32)`（尊重裁剪）；去掉首尾 0.6 s 内的帧；每帧评分 = 可见光清晰度（下采样灰度的拉普拉斯方差）与新颖度（对已选帧的热像边缘 `nccShift` 位移/相关，位移小且相关高 = 重复）；贪心选 6–8 帧；整段最大位移 < `STABLE_MAX_SHIFT_PX` 等价量 → `failed-precondition` "This looks like a fixed-camera recording — use Fixed camera"；没有 vis 的帧丢弃，多数帧无 vis → `failed-precondition`（提示需 app 录制）。`duration ≤ 0` → failed-precondition。记录 `source:'orbit'`、`photosSent` = 录像帧号。环绕写入会**替换**固定机位的 TwinSceneRecord 并删 `twinEdits`（面板 Regenerate 文案说明）。

**D. 帧（twinFrame.ts）接口**
- D1 `built` 消息：`{ type:'built', meshes, parts:[{ name, kinds:string[]（按 mesh 数降序）, faces:Face[], center:[x,y,z], min:[x,y,z], max:[x,y,z], meshCount, round:boolean }], unnamedMeshes, size }`；`round` = 顶点法线散布在 ≥ 3 个侧面（圆柱/球）。
- D2 `paint` 消息（面板 → 帧）：`{ type:'paint', entries:[{ part, face, tempC, status:'measured'|'inferred'|'none', photo?, confidence?:'strong'|'weak', apparent?, label }], lo, hi, palette:string[256] | null, measuredOnly, caption:string }`；`face` 含 `upper|middle|lower` 三带（圆体部件按部件 bbox 归一化高度分带；帧对 `round` 部件的顶点用带，其余按世界法线主轴分六面，平局按 front>right>back>left>top>bottom）。帧缓存最近一张表，`mode:'measured'` 切换不必再发；`build` 消息可顺带 `paint`。
- D3 实测着色器：**一个**共享 ShaderMaterial；顶点属性 `aTemp`（无数据时填 lo，**绝不放 NaN**）、`aState`（0 无数据 / 0.5 推断 / 1 实测）；颜色 = LUT(clamp((aTemp − mLo)/(mHi − mLo)))，LUT 为 256×1 DataTexture（面板已重采样到 256，colorwheel6 由面板换成 iron）；**推断面用屏幕空间斜条纹**（`fract((gl_FragCoord.x + gl_FragCoord.y) * 0.125)` 半幅混 50% 灰 #737373）而不是 25% 灰混；无数据 = 平灰 #6e6e6e 无条纹；`measuredOnly` → 推断面 = 平灰 + 条纹；**无视角阴影因子**。`mLo/mHi` 独立于模拟视图的 `tMin/tMax`。地面 fixture 在 measured 模式用无数据平灰。表未到达前 measured 模式显示 realistic 材质。
- D4 paint 步骤：`scene.updateMatrixWorld(true)`；被 > 1 个 mesh 共用的 geometry 先 `clone()`（WeakSet 记住，clearBuilding 释放）；缺 normal 的 `computeVertexNormals()`；属性长度 = `position.count`；世界法线用 `new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)`；`isInstancedMesh` 整体取 (part,'all')。
- D5 `fitFixtures(box)`：`size = max(bbox 最大边, 0.2)`；地面 y = min.y − 0.002·size、边长 20·size；太阳位置 = 中心 + size·(0.7, 1.1, 0.5)，阴影相机 ±0.8·size、near/far 按太阳距离，`shadow.normalBias = 0.0004·size`、`shadow.bias = −0.000002·size`；camera near = size/500、far = 50·size；overview 半径下限 0.1·size（删掉 10）；`controls.minDistance = 0.05·size`、`maxDistance = 20·size`；遮挡容差 `max(0.001·size, d·0.004)`；`view` 消息缺省点取 bbox 中心。`subjectKind === 'interior'`：不画地面、背景中性灰。
- D6 图例：measured 模式 caption 两行 "Apparent surface temperature — camera reading, no emissivity or reflection correction" / "one value per surface (median of the traced area)"，三个样例：调色条 = measured、斜纹 = inferred、平灰 = no data；色条 CSS 渐变由 palette 数组（24 档）生成。simulated 模式维持现状。
- D7 探针：统一 `readSurface(hit) → { tempC|null, kind, part, face, status, label }`；钉记 `part/kind/face`，模式或表变化时重打标签；`probeActive = probeOn && mode !== 'realistic'`；标签格式：实测 `21.3 °C · wall · measured · photo 3 · n=412 · p10–p90 19.8–23.9`，推断 `21.3 °C · wall · inferred from 2 wall faces facing the same way (weak)`，表观 `14.2 °C · glass · apparent (reflects sky) · photo 2`，无数据 `— · roof · no measurement`。`label` 由面板算好随 entries 下发；**帧上的药丸只显示前两项（温度 + 面的种类，如 `31.5 °C · roof`）——后面的出处/来源照片/面值太长，会跑出视图，完整措辞仍留在元素的 `data-label` 上**。
- D8 模式值 `'realistic' | 'simulated' | 'measured'`（`'thermal'` 作 `'simulated'` 别名）。

**E. 客户端 util `src/utils/twinSceneThermal.ts`（纯函数，单测）**
- E1 `normalizePartName(s)`；`faceOfNormal(nx,ny,nz)`。
- E2 `aggregateSurfaces(surfaces, parts, views)`：①**朝向核对**：对有 `view` 的照片，面外法线 · (相机 − 部件中心) > 0.15·|…| 才接受；不通过则试镜像面（left↔right、front↔back），镜像面朝向相机且本照片未描过 → 接受并记 `flipped:true`；否则丢，计入 `rejected`；`face:'top'` 且相机 y ≤ 部件 max.y → 丢（地面看不到屋顶，那是天空）。无 view 的照片不核对。②跨照片合并：同 (part, face) 多张照片的 median 在 `max(2, 0.15×span)` 内 → n 加权均值，否则取 n 最大的一张并记 `disagree:true` 与 spread。
- E3 `inferFaces(...)` 热学类别：envelope = {wall, roof, column, canopy, frame, stone, wood, plastic, other}、glazing = {glass}、metal = {metal}、site = {pavement, road, ground}、vegetation、liquid、fabric。推断源排除 `apparent/mixed/smallSample`；`top/bottom` 只从同类别的 `top/bottom` 推；**不跨类别**（→ 无数据）；**没有"全场均值"规则**。building/nature 顺序：(1) 同 kind 同面的其他部件 → (2) 同部件其他竖直面（且它们互差 ≤ 2 K，否则跳过）→ (3) 同类别同面 → (4) 同类别任一竖直面（weak）。apparatus/vehicle/interior/other 顺序：(1) 同部件其他面（含 all/三带）→ (2) 同 kind 同面 → (3) 同 kind 任一面 → (4) 同类别任一面（weak）。glass/metal 无自测 → 无数据。
- E4 `buildSurfaceTable(thermal, builtParts, views, subjectKind) → { entries（含 label 文案）, stats:{measured, inferred, none, rejected, flipped}, range:[lo,hi], sliderBounds:[floor(min p10)−10, ceil(max p90)+10] 夹在 [−40, 400] }`。
- E5 `paletteLut256(key)`：`PALETTE_COLORS[key]` 重采样 256（colorwheel6 → iron）；`paletteKeyFor(experiment)` = `palette ?? 首个非空 photoPalettes ?? 'iron'`。

**F. 面板**
- F1 从 `twinBuildingPanel.tsx` 抽出 `twinBuildingViewer.tsx`：`TwinBuildingViewer({ record, experiment, controls, source })` = iframe + Segmented + Measured/Simulated 分区 + About；`TwinBuildingPanel`（图片集）与 `TwinPanel`（录像）各自提供工具栏。
- F2 `twinPanel.tsx`：删掉自己的 Run/runs/startRun/useRun，固定机位流程移植到 `twinRun.ts` 的 `startTwinRun`（**唯一**注册表、唯一 twinRunningExpId 写者）；工具栏 = 模式选择（`Fixed camera` / `Walk-around`，各一行说明；缺省 = 记录 `source==='orbit'` ? orbit : fixed）+ Build/Regenerate/Clear；fixed → 稳定性门 → analyzeTwinScene；orbit → `analyzeTwinBuilding(expId,'orbit')`；`hasVisible` 门两种模式都用；记录是 `isTwinBuildingRecord` → 渲染 `TwinBuildingViewer`；稳定性门失败文案提示 Walk-around；Regenerate 到另一模式的提示 "replaces the current twin and its corrections"。
- F3 Viewer 状态：`simRange`（预设）与 `measuredRange`（缺省 `table.range`，滑杆界 `table.sliderBounds`）分开；Segmented 只在 `table.entries.some(measured)` 时提供 Measured、只在 `subjectKind==='building'`（或无 thermal）时提供 Simulated（**§21 起恒提供**）；模式夹取 effect（记录/表变化时收回不可用的模式）；**有实测时缺省进 Measured**；状态行 "N surfaces measured in M photos · K faces inferred · J faces without data"（有 rejected/flipped 时加 "· R traced surfaces did not match the model"）；v5 记录且该集有热像照片（或 source orbit）→ 信息条 "Regenerate for measured temperatures"；`photoCapturedAt` 跨度 > 30 min → 提示 "captured over X min"；文案按 `subject/subjectKind/source` 措辞（frames vs photos）。

**G. 已知取舍（写进文档不再争论）**：每面一个中值而非投影纹理（未来可把内缩四边形的像素投到面上）；`face:'all'` 只对朝向该照片相机的顶点算实测、背面推断（沿用 twinThermal 规则，客户端 E2 用 view 判定；无 view 时整体算实测并记 weak）；相邻部件不遮挡太阳（模拟视图）；FLIR One 可见光与热像视场按同一取景对应，边缘可能有百分之几误差。

### 18.7 实现记录（2026-09-10，四个并行 agent 实现 + 集成；与 18.6 的偏差以本节为准）

- **文件**：服务端 `functions/src/twinBuilding.ts`（契约 v6：两层提示词、schema、`extractPartsFromCode`/`mergeParts`、`describeViewpoint`、`buildTwinSurfacePrompt`/`TWIN_SURFACE_JSON_SCHEMA`/`parseTwinSurfaces`、`surfaceStats`/`erosionFor`/`framePercentiles`/`isMixedSurface`/`surfaceRange`）、`functions/src/twinOrbit.ts`（环绕抽帧：`thermalEdgeMap`/`laplacianVariance`/`standpointDistance`/`totalMotion`/`selectOrbitFrames`）、`functions/src/index.ts`（`analyzeTwinBuilding` 收 `source`，`loadOrbitFrames`、`traceTwinSurfaces`、`runPool`；`resolveOpenAiProvider.supportsImageDetail`；`callModelForTwinScene(…, extras)`；`TWIN_SURFACE_MODEL_KEY='gpt56'`）；客户端 `src/utils/twinSceneThermal.ts`（+38 单测）、`src/pages/experimentAnalyzer/twin/twinBuildingViewer.tsx`（新：iframe + Segmented + Simulated/Measured 分区 + About，图片集与环绕录像共用）、`twinBuildingPanel.tsx`（只剩工具栏与空态）、`twinPanel.tsx`（Fixed camera / Walk-around 选择；记录是 building → 渲染 viewer）、`twinRun.ts`（唯一 run 注册表）、`twinFrame.ts`（api.part、fitFixtures、paint/测温着色器/斜纹/图例、探针 readSurface）、`types.ts`、`services/ai.ts`。
- **服务端偏差**：`thermal` 为 null 的情形除"没送热像照片"外还包括第一阶段不可渲染或程序未声明任何 part（记 `twin_surfaces_skipped` 日志）；在热像渲染上描的表面（无 vis 的照片）写 `registered:true`、内缩 2 px（渲染本身就是热像网格），该照片行 registration 显式 null；`thermal.range` 无存活表面时退到照片 p02/p98，再退 [0,40]（客户端 util 自己按表面重算，不信任 range）；`surfaceStats` 的 erodePx 由配准质量内部推导，第 4 参数可覆盖；第一阶段提示词把六种 subjectKind 的尺寸锚全列出（答之前不知道主体是什么）；`checkSceneCode` 对绑定了 `parent/top/self` 再作成员根使用的程序仍拒（提示词禁用这些名字）。orbit：候选 32 帧、去首尾 0.6 s、没有可读 .dat 的候选丢弃、`totalMotion ≤ 12` 视为固定机位拒绝；请求 `source` 非 photos/orbit → invalid-argument。
- **帧偏差**：`round` 判据改为"侧向顶点法线落在 12 个 30° 方位扇区中的 ≥ 6 个"（原"≥ 3 个侧面"会把每个盒子都判成圆体）；`api.cylinder` 用 6 段高度分段（否则三带无顶点可承载）；圆体部件表里无带条目时 (part, face) → (part,'all')；探针标签元素用 data-label 存整句、首项加粗；调色板数组长度 ≠ 256 时重采样；地面的 realistic 材质改为常量（修了重建时把着色器记成地面原材质的潜在 bug）。
- **util 偏差**：聚合容差用全场 median 极差的 15%；推断的朝向屏障对称（侧面也不从顶/底借）；圆体部件上描到的六面折进 'all'，盒体上描到的高度带折进 'all'；类别级推断标签点名来源 kind（"inferred from 3 wall/column faces facing the same way"）；分歧标签给 ±半跨度；`buildSurfaceTable` 第 6 个可选参数 `source`（'orbit' 时标签写 frame N）。
- **面板偏差**：阻断/过期提示由 viewer 渲染（eslint 的 react-refresh/only-export-components 不允许从 .tsx 导出辅助函数）；模式夹取是派生值而非 effect；"part names did not match" 与 v<6 提示放在 Segmented 下方；"captured over X min" 只对图片集显示；Measured 的 Scale 覆盖按记录对象键控（换单位不重置、重生成才重置）。
- **验证**：functions build 绿、functions 215/215 单测绿（含 twinBuilding 40 条、twinOrbit）；util 38/38；vite build 绿；eslint/prettier 绿；帧脚本 node --check 通过，CDP harness（scratchpad makeHarnessV6.mts / cdpPaint.mjs，50 项断言）验证 built/paint/探针/fitFixtures/图例/斜纹/三带/interior；模拟器端到端见下一节记录。
- **端到端（2026-09-10，本地模拟器 → 线上 Firestore，scratchpad e2eV6.mts）**：`ZyzXCNoDJix6tn7WDqWM` "3d house"（3 张热像）154 s：DeepSeek 第一阶段 20 个 api.part 部件、7.2k 字符程序、subjectKind building；GPT-5.6 第二阶段 3 张全 ok（配准 dx≈1、dy≈5–6 px），36 个表面（墙 median 31–33 °C、门廊玻璃 32 表观、屋面 30.9 mixed、路面 34.8 mixed、灌木 mixed），range [29,36]；面板自动进 Measured："17 surfaces measured in 3 photos · 53 faces inferred · 48 faces without data"。`t130ltxoFTzh41PlTNfh`（笔记本桌面，2 张）97 s：判为 interior、15 部件（floor/walls/ceiling/deskTop/laptopBody/laptopKeyboard/laptopDisplay/monitor…）、7 个表面（照片 2 无配准 → registered:false）、"captured over 31 min" 提示生效。两条 v6 记录已在线上；**线上旧前端（v5 帧没有 api.part）打开这两个实验会报 "The program failed while building"，部署 hosting 即好（新帧兼容旧程序）**。
- **室内取景（同日）**：interior 主体的 overview 只框"内容物"（最大边 < 0.6·场景尺寸的部件，排除地板/墙/天花板壳），相机站在内容物朝房间中心一侧、高度压在天花板以下 15%、位置夹在墙内 5% 边距内；此前相机会跑到天花板之上只看见一块灰板。用 vite preview（4174）+ scratchpad cdpApp.mjs 截图核对过 realistic / measured / simulated 三种视图。
- **环绕模式端到端（2026-09-10 深夜，`NvrC0nYvz0ND7LaADFZq` 19 s 手持绕拍一辆轿车）**：149 s；32 个候选帧中选出 8 帧 [25,37,43,53,65,83,89,92]；DeepSeek 判为 vehicle "A silver four-door sedan parked beside a shingled house"，9 个部件（bodyShell/metal、roofPanel、glazing、tyres、wheels、lamps、trim、house、road）；8 帧全部配准成功（dx −0.7…3.9、dy 3.2…6 px），73 个表面（车身 45–48 °C 表观金属、玻璃 41–48 表观、轮胎 39、路面 47、房墙 33–36），range [32,50]。**缺陷暴露：views 0**——模型把 8 张图编号 1..8 而解析器只认录像帧号，视角全被丢掉（朝向核对随之失效）；这正是审查发现的"环绕提示词按帧号编号"问题，修复为两阶段都给模型看 Photo 1..N (recording frame K) 再映射回帧号（§18.6 J6）。第一次跑到 121 s 时返回 500 未能复现（第二次成功），疑为模拟器在 functions 重编译时重载。
- **审查修复（2026-09-10 深夜，34 条确认问题全部处理）**：环绕门与去重同时看热像边缘位移和可见光亮度位移（MAX，二者都对齐才判固定机位/重复；对称居中主体不再被拒）；第二阶段每次调用有截止时间（剩余预算 ÷ 波数，超时记 model-failed，不拖死函数）；`api.part` 只要求名字是字面量，代码里有动态 part 调用时 JSON 的 parts 追加而不丢；提示词声明有无热像渲染图；mixed 阈值只用非表观 median 的极差；**两阶段都把图片呈现为 "Photo k (recording frame K)"，views 按序号映射回帧号**；取消在第一阶段前退还名额；正上/正下视角的文字描述；分数四边形容差 ≤ 1.05；低置信度直接跳过第二阶段；`checkSceneCode` 拒 `this` 作成员根、`.constructor`/`__proto__`；丢弃的表面记 `twin_surfaces_unread`。客户端：`canSee` 统一可见性（top 需相机高于部件顶、bottom 需低于底；相机在底之下时 top↔bottom 镜像 → 室内天花板）；圆体部件只把四个侧面折进 'all'、top/bottom 自留键；`all`/带条目带 `cameras` + `farLabel`，帧把不朝向任何相机的顶点画成推断、探针显示 farLabel；stats 拆 rejectedNoPart/rejectedOrientation/unplaced/unknownParts；'unnamed' 配景 = 无数据且不计数；单照片分歧标签 "across N traced areas"。帧：圆判据按 mesh（≥ 6/12 扇区）、部件 round 按包围盒表面积加权，带只用于圆 mesh，top/bottom 先于带；InstancedMesh 走逐顶点路径（hitNormal 乘实例矩阵）；无 position 的 mesh 跳过，applyPaint 包 try/catch 另发 error；斜纹按片元亮度选黑/白、无数据色 #5a6674（各调色板都不会经过）；measuredOnly = 无数据底 + 对比斜纹；隐藏地面不参与拾取；圆柱 (24,3).toNonIndexed() 按三角形上色（带边界不再渐变）；着色器 DoubleSide；模拟着色器支持 instanceMatrix；`p.add()` 不覆盖已命名子部件；程序 `scene.clear()` 后 fixtures 自动补回；`build`/`built`/`error` 带 `buildId`；帧头加 CSP（default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' cdn.jsdelivr.net; connect-src 'none'）。面板：built 消息逐字段校验 + buildSurfaceTable try/catch + 错误边界；failTwinRun 不覆盖进行中的 run，清除中禁用 Build；"names did not match" 只在 rejectedNoPart 覆盖全部表面时说，否则 "N traced surfaces could not be placed"；`SUPPORTED_TWIN_BUILDING_VERSION = 6`（高于它的记录提示刷新，须与服务端版本同步改）；thermal.photos 非 ok 的原因汇总成一行。
- **程序中途抛错（同日，用户重生成汽车录像时遇到 "shape.extractPoints is not a function"）**：模型把 `THREE.Path` 传给 `ExtrudeGeometry`。三处修复：帧给 `THREE.Path.prototype` 补 `extractPoints`（Path 当无洞 Shape）；程序中途抛错不再整体报废——已建部分照常取景/上色/探针，`built` 带 `warning`（面板显示琥珀提示 "The program stopped early (…); showing what it had built by then."），只有零 mesh 才算失败；提示词加 Shape/Path 用法一句。
- **部署顺序**：hosting 先于或同批 functions（新帧能跑 v5 程序，旧帧跑不了 v6）；线上已有的 v6 记录在 hosting 上线后即可看，勿用旧客户端 Regenerate。
- **验证（同日收尾）**：functions build 绿、functions 229/229、util 48/48、tsc(app) 无 twin 错、eslint/prettier 绿、vite build 绿；帧 harness（scratchpad cdpPaint.mjs 全部断言 + cdpPartial.mjs：Path 传给 ExtrudeGeometry 的部件建成、程序中途 throw 得到 built{meshes:3, warning}、零 mesh 才 error，buildId 原样回传）。
- **修复后环绕复测（同日）**：同一段汽车录像 169 s；亮度+热像联合选帧改选 [19,25,34,37,40,43,89,92]；**views 8**（编号映射生效）；13 部件、96 个表面，程序在 Node 中完整建成 51 个 mesh。
- **全部推断填充（2026-09-11，用户要求"热图加一个全部推断模式，让整个模型都包含温度数据，从真实数据推断；不用条纹"）**：Measured 分区的 "Measured only" 开关改为 **Infer** 三档 Segmented：`Nothing`（= 原 measured only，推断面灰）/ `Comparable`（缺省，= 原行为，E3 规则 + 斜纹）/ `Everything`（全部推断）。`buildSurfaceTable` 第 7 个可选参数 `fill: TwinFill = 'comparable'`；`'all'` 时 E3 找不到来源的面走 `inferFill` 阶梯（首中即止、一律 weak、值取来源均值）：①本部件任何朝向的实测面 →②同 kind / ③同类别其他部件任何朝向（干净来源）→④⑤同类别、准入 apparent/mixed/small 来源（同朝向优先；来源全 apparent 则该面也标 apparent，标签带 "· mixed-surface/small-area readings"）→⑥⑦全场干净来源（同朝向优先，标签 "inferred from every measured face of the scene (2 wall/vegetation faces) · nothing of the same material measured"）→⑧全场任何来源。**不发明数值**：无任何实测时仍全部 none。'unnamed' 配景在 'all' 下同样上色（标签带 "· scenery ·"，仍不计数）；地面 fixture 由 util 以 kind ground/site 类 推出 `table.ground: {tempC,label}`，随 `paint.ground` 下发，帧用 `groundPaintMaterial`（LUT 色）画地面、探针对 fixture 命中直接答 ground 标签（原先误读 ('unnamed','top') 条目）。`stats.filled` = 仅靠阶梯得值的主体面数，状态行 "K faces inferred · F faces filled from the rest of the measurements"，'all' 下 0 无数据不显示。帧：`paint.stripes`（缺省 true）→ 着色器 uniform `stripes`，关闭时推断面与实测同画法；图例隐藏三色 keys 行、caption 换 `ALL_INFERRED_CAPTION`。util 单测 +7（55/55）。
- **实测面贴图（2026-09-11，用户问"每个面上应该也会出现不同的温度吧"，选定服务端烘焙；同日已被 §18.8 的投影贴图取代并删除，本条留作记录）**：第二阶段读统计时顺手把每个**六面**表面（'all'/三带不做）的四边形按 **Heckbert 单位方 → 四边形透视映射**（`squareToQuad`）重采样成 w×h 网格（每条长边一个热像像素、2 ≤ w,h ≤ `SURFACE_TEXTURE_MAX`=32；四边形按给定 TL/TR/BR/BL 顺序做映射，非凸顺序不出贴图；天空/哨兵/出框像素由相邻有效值逐环填满；配准偏移同 `readSurfaceStats`），量化为 1 字节 [lo,hi]，base64 存 `surfaces[].tex {w,h,lo,hi,data}`（每面 ≤ 1 KB，房子 36 面约 40 KB，落在 experiment 文档的 `twinScene` 里）。**版本仍 6**（字段可选，旧前端忽略）。客户端 util：`decodeSurfaceTexture`；实测的六面条目（盒体部件、主导照片有 tex）带 `tile {w,h,temps,uAxis,uSign,vAxis,vSign,pointLabel}`，轴向由 `tileAxes` 定：四个侧面竖直（v = −y），横向按从外面看的左右（front +x / back −x / right −z / left +z）；top/bottom 按该照片相机站位：横向 = 相机右手 = f×ŷ，top 的图像下方朝相机（−f），bottom 朝远离相机（+f），f 吸附到坐标轴，无 view 视为相机在正前。`stats.textured`、`PIXEL_CAPTION`。帧：`buildAtlas` 校验 tile 后按最大 tile 的方格打包进 2 的幂 RGBA8 图集（全局 texLo/texHi 量化）、顶点属性 `aUV`(部件包围盒内位置) + `aTile`(图集 rect)，片元在 vS==1 且有 tile 时从图集取温（首末纹素中心之间采样不串色）；InstancedMesh/圆体/远侧不贴；探针对贴图面读指针下采样值，标签 "31.4 °C · wall · measured at this point · photo 3 · face median 32.1 °C"。面板：状态行 "N painted with the photo's own pixels"，旧记录（surfaces 无 tex）提示 Regenerate。验证：functions tsc 绿 + twinBuilding 52/52（+6：透视映射角点/中心/平行四边形、逐像素采样方向、配准偏移、天空填充、尺寸上下限、蝴蝶结拒绝）；util 60/60（+5：解码与轴向/六面朝向/无 view 与斜向相机吸附/圆体·all·坏贴图不给 tile/表观点读数 °F）；eslint/prettier 绿；vite build 绿；headless Chrome harness（scratchpad harness.mjs + scenario2.js）：前面 4 顶点带 tile、图集 2×2 字节 [0,85,170,255]、四角探针 10/20/30/40、背面平涂、无 tile 的 paint 回到 1×1 图集。**部署无顺序要求**（新前端遇旧记录只提示重生成；旧前端忽略 tex）；线上记录须 Regenerate 才有贴图。
- **模拟视图参数全部可调（2026-09-11，用户要求"把各种参数都变成用户可修改和设置的"）**：此前预设只暴露 室外/室内/太阳方位/色标，**日照强度与太阳高度藏在预设里**，风（h_out 15）、天空辐射降温（3.5 K）、各 kind 的 U/α/bias 是帧里的常量。现在：新模块 `src/utils/twinSimulation.ts` 持有默认值（`SIM_MATERIALS`、`SIM_DEFAULT_WIND_H`、`SIM_DEFAULT_SKY_K`）、四个预设（每个都填 7 个条件 + 色标，风/天空取默认，数值与改前一致）、各控件上下限 `SIM_LIMITS`（室外 −30…50、室内 0…40、日照 0…1200 W/m²、高度 −10…90°、方位 0…359°、风 4…40 W/m²K、天空 0…8 K、U 0…6、α 0…1、bias ±10 K、色标 −40…130 °C）与 `matchingPreset`/`sunSide`/`simKindsInScene`/`changedKinds`；**帧不再抄一份常量**：`TWIN_FRAME_HTML` 在模板末尾把 `__SIM_DEFAULTS__` 替换成上述 JSON，着色器的 `H_OUT`/`SKY_K` 字面量改为 uniform `hOut`/`skyK`（`max(1, hOut)` 防除零），`scenario` 多了 `windH`/`skyK`，`build`/`mode` 消息可带 `materials {kind:{U,alpha,bias}}`（`setMaterials` 逐项回退默认、U≥0、α∈[0,1]，同步更新已缓存着色器的 uniform；不带 materials 的旧消息不改动）。面板新组件 `twinSimControls.tsx`：Scenario 下拉（值偏离任何预设时显示 Custom + "Back to {预设}"）、Air 组（Outside/Inside/Wind/Sky cooling）、Sun 组（Strength/Height/From，From 旁显示 front/back-left 等方位词，无日照时禁用）、Scale（两端数字框 + 双柄滑杆，Measured 视图也换用同一个 `ScaleField`）、Materials 表（只列本模型用到的 kind + 地面；U、Sun %、± 偏移三列数字框；改过的 kind 加粗 teal，"Reset materials"）。每个数值 = 带虚线提示的标签 + 数字框（温度按用户单位，差值 °F×1.8，α 显示为 %）+ 滑杆；数字框**不设 precision**（否则失焦时重新取整会被当成一次修改）。状态不持久化（组件 state），切预设只重置条件和色标、不动材料。验证：util 单测 +11（twinSimulation.test.ts，含"帧里注入的默认值与模块一致"），全套 405/405；eslint/prettier、tsc(app) 无 twin 错、functions tsc、vite build 绿；headless Chrome（scratchpad harness.mjs + scenario4.js）逐项核对探针读数与手算一致（冬夜前墙 −3.96、改 U=3/h=5/sky 0 后 10.6、正面 30° 600 W/m² 前墙 29.45/背墙 10.4/屋顶 23.7、非法值回退/夹取），无 shader 报错；SSR 静态渲染（scratchpad ssr/render.tsx，需同时用 antd 两份 cssinjs 的 StyleProvider——cssinjs-utils 下嵌套 1.21 才是组件注册样式的那份）截图核对了 °C/°F 两种布局。
- **探针改为默认行为（2026-09-11，用户："探针改成默认行为，不需要选项了"）**：删掉 Measured/Simulation 分区里的 Probe 开关，面板在两个热图视图里始终发 `probe {on:true}`（Realistic 发 false）；"Clear N readings" 仍在分区标题。帧的 `probeActive` 改为 `probeOn && (simulated || (measured && paint))`——measured 模式在表到达前（或上色失败）穿的是 realistic 材质，此时不显示读数（原先会把模拟温度标在照片样的模型上）；探针开启时画布左下提示变为 "hover to read · click to pin · drag to orbit …"，图例显示时提示最大宽度让出图例（`body.legend-on #hint`）。验证：headless harness（scenario5.js）measured 无表 → 不探测、有表 → 探测 + 新提示、simulated → 探测、realistic → 关；tsc/eslint/prettier/vite build 绿。
- **模拟热图改成真正的表面能量平衡（2026-09-11，用户问"夏天中午地面会有 69.8 °C 这么热吗"→ 6 个 agent 调研+对抗复核后确认偏高 8–13 K，用户要求"把代码一起改了"）**：原式 `T = tOut + (αIcosθ + UΔT)/h − skyK·up + bias` 缺三项——①随温度增长的辐射散热（65 °C 时约 230 W/m²，等效 hr≈7），②白天往铺装/土壤下层的导热（午后约 100–150 W/m²，占净辐射 20–30%），③漫射天光（水平面少算约 150 W/m²）。②③互相抵消，所以 h=15 实际是"对流+辐射"合计系数、相当于近乎无风；且没有辐射项时 h 越小温度无上限（windH=4 → 178 °C，这是上一轮把 Wind 放开后的真实 bug）。**新模型**（`simSurfaceTemp`，牛顿迭代 4 步）：
  ```
  gain = α·(beam·cosSun + skyLight·skyView) + U·(tIn − tOut)
  loss = (windH + store)·(T − tOut) + ε·σ·(T⁴ − tOut⁴) + skyView·skyLoss
  skyView = clamp(0.5 + 0.5·n.y, 0, 1)   // 朝上 1、竖直 0.5、朝下 0
  ```
  ε=0.95 固定（`SIM_EMISSIVITY`，未开放为参数）。**契约变化**：`scenario.skyK`(K) → `skyLoss`(W/m²，默认 60)、新增 `diffuse`(W/m²，默认晴天 ≈ beam/6)、`windH` 改为**纯对流**（默认 15 → 12，下限 2）；`SimMaterial` 新增 `store`(W/m²K：road/pavement/ground 5、vegetation 3、其余 0)；road/pavement 的 bias +1/+0.5 归零（储热白天方向本来就反）；roof α 0.85 → 0.93（EPA 黑屋顶 74–85 °C，原模型把"屋顶比路面热"算反了）。UI 加 Sky light 滑杆、Sky cooling 单位改 W/m²、材料表加 Store 列（4 列 58px）。**三份实现**（util 参考实现 / 帧着色器 GLSL / 帧 JS 探针镜像）必须同步；着色器里温度按 (K/100) 参与四次方，量级 <1000 便于 mediump。
  夏日午后预设新值：road 59.9、pavement 53.5、ground 50.3、vegetation 32.6、roof 67.6、向阳墙 46.6、玻璃 33.4（实测锚点：SHRP 峰值气温+25.5 K≈58.5、大阪 59.7@36 °C、京津高速 ~55@35 °C、裸土 50–60、黑屋顶 70–80）；冬夜 glass −2.4 / wall −5.9 / roof −8.2（与旧值接近）；windH=2 静风 road 77 °C（旧式 178 °C）。验证：util 单测 21 条（含把解代回能量方程验零、风速单调性、skyView 三档、夜间无天光、静风不失控）、全套 490/490、eslint/prettier/tsc/vite build 绿；headless Chrome 两支脚本——`harness.mjs + scenario6.js`（探针读数与 util 逐位一致，材料/风/云/夜间消息生效）与 **`shadercheck.mjs`（六种材质平板俯视截图→按 iron 色标反查温度，与探针差 ≤0.1 K，证明 GLSL 牛顿与 JS 镜像一致）**；SSR 截图核对新控件布局。


### 18.8 投影贴图：每张热像照片配准到模型，把照片自己的像素投到模型上（2026-09-11，用户："3D 模型的热图贴图还是不太准确"，本地已实现、未提交、未部署）

- **病根**：§18.7 的面贴图把第二阶段描的四边形重采样后**拉伸到整个面的包围盒**上，而描点提示词要的是"面内安全区、离边一掌宽、避开窗户"的小块——一块 13×16 px 的窗间墙被拉成两层楼加山墙的整个立面：阁楼窗的热斑、橙色山墙、门廊檐口的热带全丢；跨到天空的四边形（p10 12 / p90 34 °C）画出冷热污迹；同一面的其余小块被丢弃。LLM 第一阶段给的 views 离真实相机很远（house 照片 1 关键点重投影 RMS 180–500 px），不能直接拿来投影。
- **做法**：第二阶段每张热像照片**并行多一次 GPT-5.6 调用**（`twin_landmarks`，同图、同截止时间），让模型给 10–16 个**2D–3D 地标**：模型上的尖锐点（盒角、山墙尖、窗角），3D 坐标按程序数字精确算出、同时给出它在照片上的像素位置。服务端 `functions/src/twinCamera.ts` 用这些点**拟合每张照片的针孔相机**（位置 + yaw/pitch/roll（three 'YXZ'）+ 焦距；先验：焦距 ±8 %（vfov 50°）、roll ±6°、有 view 时高度 ±max(1.5 m, 0.25×地标跨度)、方位偏离 view 40° 内免费；LM 解析雅可比、17 个 look-at 起点、4 点 RANSAC（前 120 组、容差 3 % 画高）、两轮重收内点；门槛：≥6 且 ≥45 % 内点、内点 RMS ≤ 2.5 % 画高、内点在画面上横竖都跨 ≥ 10 % 画高、落在相机背后（或离镜头 < 1 % 地标跨度）的地标 ≤ max(1, 25 %)，否则 `camera:null` + `cameraNote`；照片没有第一阶段 view 时**不拟合**（无先验时 house 3 会接受一台浮在 15 m 高的错相机），view 俯仰 > 60° 时去掉方位先验（看天花板的 view 其水平方向是噪声）；解析器按多数票判定像素/分数）。每张 100–170 ms。实测（缓存的真实回答）：house 3 张 14/15、10/16、13/17 内点，RMS 23/19/29 px（1440 画高），模型线框落在照片上；笔记本桌面 6/12、12/12；环绕汽车 4 帧全部拒绝（程序几何与车差太远）——拒绝即该照片不投影、面仍是一值一面。**LLM 的 3D 坐标本身是准的（吸附到真实顶点距离 0.00 m），误差来自像素 ~20 px 与几何比例。**
- **记录**：`thermal.photos[k]` 可选加 `landmarks[{part,what,x,y,z,u,v,inlier}]`（u/v 为照片分数、v 向下）、`camera{position,yaw,pitch,roll,fovV,aspect,rms,inliers}|null`、`cameraNote`；`surfaces[].tex` 与服务端烘焙（`squareToQuad`/`surfaceTexture`）**删除**。版本仍 6。照片点 (u,v) 读热像像素 (u·120+dx, v·160+dy)，dx/dy 只在 picture='vis' 时取 registration。
- **帧**：新消息 `photos`（≤8 张：相机 + 120×160 温度，NaN = 不可用）。温度图集（**半浮点 RGBA16F**，R = °C、A = 有效，NaN 由邻居逐环填充防线性过滤串色；起初是 8 位全局量化，一张照片里 101.8 °C 的烟囱让所有照片的台阶变成 0.4 K，审查后改）+ **深度图集**（每张照片从其相机渲染一次模型到 512×683 格子，打包距离 `packDepthToRGBA`，log 深度与实例化兼容，懒渲染；地面 fixture 不进深度图——相机若在它下方会把整栋楼挡掉）。测温着色器对每个片元：投影到每张照片、在画面内、朝向相机、深度图说它可见（偏置 0.01·距离 + 0.002·尺寸 + 斜率项）、像素有效 → 按 facing³ × 画面边缘 4 % 渐隐 × **热像网格自身边缘渐隐**（配准平移 dy≈6 px 会把画面底边一带推出网格，否则会把最后一行像素抹下去）× **掠射斜坡**加权混合；被照片看到的点算"实测"（无斜纹、不灰），否则仍走表的一面一值/推断/无数据。**掠射斜坡**（同日 E2E 后加）：cos(法线, 到相机) < 0.2 不取该照片、> 0.4 全取、之间与表值按 `sure` 混合（sure < 0.5 保留表的状态）——否则街道视角下的草坪顶面会被没建模的汽车/灌木像素抹成长条。探针 `projectedReading` 用同样的算式（遮挡用从照片相机出发的射线 + 与着色器相同的偏置；射线与拾取都跳过 visible=false 的网格；`hitNormal` 改用法线矩阵，与着色器的逆转置一致），标签 "33.1 °C · wall · measured at this point · photo 1 · face 32.2 °C (measured)"，部分取像素时按原因写 "at a slant" / "near the picture's edge"，占比取整为 0 时回落表的标签。旧 tile 图集、aUV/aTile 全删；`view` 可带 fov，`overview` 复位 45° 与俯仰下限。
- **面板/util**：`src/utils/twinProjection.ts`（`validCamera`/`projectPoint`/`cameraForward`/`skyCut`/`maskTemps`/`projectionPhotos`/`registeredPhotos`/`registrationSummary`/`predatesProjection`/`viewFromCamera`，27 单测）；`twin/useTwinProjection.ts` 取帧（`fetchRecordingFrameBufferCached` + `getDecodedFrame`），**天空遮罩**：从顶行出发、比最冷的**干净**表面 median（非表观、非 mixed、非小样本——跨天空的 mixed 四边形会把阈值拖到 15 °C，house 现为 22.7 °C）低 8 K 的像素 4 连通洪泛 + 膨胀 1 px 记 NaN（防拟合偏几像素把天空投到屋檐）；**interior 不做天空遮罩**（没有天空，会把较冷的未描部件误遮）；描面失败（model-failed）但相机拟合成功的照片**照样投影**，"N of M" 的分母是到达模型的照片；**朝向核对仍用第一阶段 views**（起初改用拟合相机，审查发现 house 照片 3 的拟合相机正对立面、看不见侧翼左面——模型侧翼几何本身不对——把描对了的 sideBay.left 两块全拒；描面模型是按第一阶段 view 的文字描述命名朝向的，核对应与之一致）；Measured 分区显示 "N of M photos registered…"（投到它们"正面"看到的面上，陡斜面淡入该面的一值）、失败原因、加载中，旧记录提示 Regenerate；新 "Look from" 行（Photo N 按拟合相机与 fov 看过去，Overview 复位）。**地面**（Everything 填充）改为 `groundCover`：干净的 site + vegetation 读数、每部件一值（取顶面、不取底面）、按像素数加权——草坪才是房子周围的主要地面，原先只按 site 类取街道/人行道均值（house 37.6 °C）把 20 倍模型大小的地面刷成橙黄；现为 33.9 °C。
- **审查（五镜头 25 条 → 独立复核 21 条确认）全部处理**，上面各条已按修后写。**有意没做**：审查建议"内点共面时方位不定 → 拟合方位偏离 view > 15° 就按 view 方位重拟、两者都过门槛则拒绝/取 view 那个"——house 照片 3 实测按 view 方位（−38°）重拟的线框整体剪切错位，自由拟合（−8.7°，13/17）立面/窗/门廊全对得上；错的是模型的侧面几何，不是相机，故保留方位 40° 免费。
- **验证**：全套单测 475/475（twinCamera 28：手算投影、合成相机含噪声/30 % 粗差/共面/背后地标/聚在一点/陡 view、真实夹具 house 1–3 通过与汽车 19 拒绝、分数答案混一个像素值；util 85）；functions tsc 与根 tsc -b 只剩与本改动无关的旧错（index.ts ~783 街景审核 `tx.update(svRef, patch)` 在 HEAD 就有——**它让 `npm run build --prefix functions` 以 2 退出，`yarn start` 的 `&&` 链会因此不起模拟器**，tsc 仍会产出 lib）；eslint/prettier/vite build 绿；帧合成 harness 33 项 + 修复专项 34 项（台阶两侧 10/30、NaN 天空带回落表值、柱子遮挡、背面回落、网格边缘、相机在地面下、隐藏网格、斜向法线、半浮点精度、GPU 读像素与探针一致、无 GL 错误）；**真实数据 E2E**（scratchpad `e2eProj.mts` + `compose.mts`：真实程序 + 真实 .dat + 拟合相机，从每张照片的相机看过去截图，与同色标下的热像并排）：阁楼窗热斑、山墙边、门廊檐口热带、二楼暗窗、路面全部落在照片的位置，旧版同视角为一片均匀紫色；俯视总览草坪不再有长条、地面为 33.9 °C 的品红而非橙黄。室内笔记本桌面（t130…，interior：无天空遮罩、无地面）：键盘热区与屏幕渐变落到模型上（模型的机身比实物短，键盘下半截投到桌面上——几何问题）。汽车环绕：各帧相机均被拒，保持一值一面。
- **图例去文字（2026-09-11，用户："scale 下面不需要文字解释"）**：模型上的图例只留色条 + 两端温度（测温视图另留 measured/inferred/no data 三个小色块作图例键）。删掉两个视图 `.cap` 那行说明、`paint` 消息的 `caption` 字段、`MEASURED_CAPTION`/`ALL_INFERRED_CAPTION`/`PROJECTED_CAPTION`/`ALL_INFERRED_PROJECTED_CAPTION` 四个常量与面板里选 caption 的分支。"apparent temperature、无发射率/反射修正"这句诚实声明仍在面板 Measured 段落首句，Simulated 段落也仍写明"不是测量"。
- **部署**：functions 与 hosting 无顺序要求（字段可选；旧前端忽略 landmarks/camera，新前端遇旧记录一值一面并提示重生成）；**线上记录须 Regenerate 才有地标与相机**。每张热像照片多一次 GPT-5.6 调用（~2.5k 输出 token、~20 s，与描面并行）；池宽 4 → 同时最多 8 个请求，注意限流。

## 19. 修改对话：用户指出模型的问题，AI 改写程序；生成可停止（2026-09-11 用户要求，本地已实现、未提交、未部署）

用户两条要求：①场景孪生的 About 下面应有一个对话框，让用户把模型的问题（"屋顶是平的""柱子是 8 根不是 6 根"）返回给 AI 修改；②生成模型的过程中要有停止按钮。

### 19.1 服务端（`analyzeTwinBuilding` 多一个可选 `feedback`，不新建函数）

- **请求**：`{ expId, source, feedback? }`。有 `feedback` 即**修改**：`readRevisionNote` 规范化（CRLF→LF、去行尾空格、三个以上空行折成一个），空/非字符串/超 `TWIN_REVISION_NOTE_MAX`=1000 字 → invalid-argument（**拒绝而不截断**，截断的意见可能意思相反）。`readRevisableTwin(exp.twinScene, source)` 在占用限流名额之前检查：必须是 kind building、`version === TWIN_BUILDING_VERSION`（v5 没有 part 名可保留）、有 code 且无 blocker、`source` 与本次一致（照片集/环绕）、`photosSent` 非空（去重、≤ 8）；否则 failed-precondition 并提示 Regenerate。parts/views 逐字段清洗，`revisions` 经 `readRevisions` 清洗（≤ `TWIN_REVISION_HISTORY_MAX`=8 轮）。
- **同一批图片**：修改时直接按 `photosSent` 顺序加载（环绕模式不再重新抽帧），所以旧 views 的照片编号仍然有效。
- **提示词**：`buildTwinBuildingPrompt(ctx)` 加可选 `ctx.revision {code, parts, views, note, history}`；系统提示词完全沿用首次生成的规则，在 "Answer with JSON only" 之前插入 REVISING 段（改意见指出的、连带必须动的；**其余一律不动**——同样的 part 名、尺寸、位置、views；主体是什么/部件关系以 owner 的话为准，未提及的比例仍以照片为准；已应用的旧意见保持；做不到的做最接近的并说明；**必须输出完整程序**，不许 diff/省略号），schema 行末尾加 `changes`。用户文本在照片清单后附：原程序（```javascript 围栏）、parts 清单、views（**按本次发送顺序重编号**为 photo N，未发送的照片的 view 省略，米数保留两位小数）、"Notes already applied, oldest first"（含上轮模型的回答）、本次意见（三引号），结尾 "Revise the model…"。`TWIN_BUILDING_REVISION_JSON_SCHEMA` = 原 schema + 必填 `changes`（严格模式形状）；`parseTwinBuildingCode` 多返回 `changes`（≤ 600 字，缺省 ''）。
- **第二阶段照常重跑**（改写后 part 名、views 都可能变，描表面必须对上新程序）。修改的答案若整个漏掉 `views`，沿用上一版中本次发送了的照片的 views（描表面的视角文字与客户端朝向核对都靠它）。
- **改坏了不覆盖**：修改结果被 `twinBuildingBlocker` 挡住（不可渲染、程序被安检拒、置信度 < 0.4）→ failed-precondition "The revised model could not be used, so the current one is kept: …"，记录不动（花费不退）。
- **写入有条件**：修改用事务写，事务里比较当前 `twinScene.code` 是否仍是被修改的那份；期间被别处 Regenerate/修改/清除 → aborted "The digital twin changed while this revision was being made…"，不写。记录多一个 `revisions: [{feedback, changes, at(ms)}]`（最近 8 轮）；**不带 feedback 的 Regenerate 生成全新模型，没有 revisions**。
- 日志：`logModelUsage('twin-building-revision', …)`；限流仍是一次一个名额。

### 19.2 停止（两个孪生函数都支持）

- **客户端**：`services/ai.ts` 新 `callTwinFunction`——孪生 callable 改走 **`fn.stream(payload, {signal})`**（服务端不发 chunk；只有流式调用能被中止）。中止 = 断开连接，服务端 `response.signal` 触发（firebase-functions v6 在 `res.on('close')` 时 abort，流式/非流式都一样）。流式调用没有客户端超时，另设定时器（analyzeTwinScene 190 s、analyzeTwinBuilding 370 s，比函数预算多 10 s），超时报 "did not finish within N s… reload to check"，不当作停止。`analyzeTwinScene(…, signal?)`、`analyzeTwinBuilding(expId, source, note?, signal?)`。
- **服务端**：`analyzeTwinBuilding` 在第一阶段解析后、写入前各查一次 `abort.aborted` → cancelled，**停止后什么都不写**；`analyzeTwinScene` 写入前同样检查。模型调用本来就带 signal，断开即中止 fetch。
- **twinRun.ts 重写**：每个 run 带 `AbortController`（WeakMap 存，不暴露在 run 对象上）；`startTwinRun(expId, task(set, signal), revision?)`；`stopTwinRun(expId)` 把进度改为 "Stopping…" 并 abort，task 抛出后记为 `stopped`（不是 error）；**订阅改为按实验 id**（新 run 出现也通知），修掉了"修改面板开的 run，工具栏不知道、Regenerate 仍可点"的问题，各面板不再需要 `runStarted` 强制重渲染；`storeTwinRecord` 从 twinPanel 挪来共用；`useTwinBuildRun` 给工具栏用（running / building / 上次构建的 error 或 stopped，按 run 对象 dismiss）。
- **固定机位**的运动门循环每帧前查 `signal`，结束后 `throwIfAborted()`。
- **UI**：工具栏在构建进行时于 Regenerate 旁显示红色 **Stop**（Clear 本来就隐藏），停止后 info 条 "Stopped — the twin was left as it was." / "nothing was built."；修改进行时 Stop 在对话里。Regenerate 按钮只在**构建**时转圈，修改时只是禁用。

### 19.3 客户端对话（`twin/twinRevise.tsx`，About 段落内、出处行之下）

- 对话：owner 的意见是右侧 teal 气泡（`--ifi-teal-film`），下方 "You · 时间"（其他读者看到 "Owner"），气泡下是模型的 `changes`（空则 "The model did not say what it changed."）；进行中的意见显示为气泡 + 转圈进度 + Stop；失败/停止的意见留在对话里（灰气泡 "Not applied" + 红字原因或 "Stopped — the model was left as it was."）+ "Edit and send again"（把原文放回输入框）/ "Dismiss"。
- 输入框：仅 owner + staff 且记录 version 6 可见；placeholder 按 subjectKind 给例句；**回车发送、Shift+回车换行**（用户 2026-09-11 改定；最初是 Ctrl+Enter）；输入法组字时的回车不发送（`isComposing`，以及 Safari 上报的 keyCode 229）；1000 字上限，接近上限时显示计数；有构建进行时提示 "Wait for the build to finish"。
- **About 整段只在 Realistic 视图显示**（用户 2026-09-11 先说"对话只需要放在 realistic 标签中"，随后对 About 描述与 Regenerate/Clear 说"这部分也一样"）：模型名称/描述/出处、修改对话、构建工具栏（19.5）都属于 Realistic；Measured/Simulated 的设置栏只留测温/模拟控件（这两段因此总是栏里最后一段，改用 `twin-section-last` 去掉末尾细线）。About 在热图视图里是 `hidden` 而**不卸载**（`.twin-section[hidden] { display: none }`，否则 `.twin-section` 的 flex 会盖过 hidden），半写的意见、已 Dismiss 的结果、打开的确认框切视图都不丢。热图视图里若有构建或修改在跑，视图切换下方显示一行 "Regenerating the model / Revising the model from your note — switch to Realistic to follow it or stop it."（进度和 Stop 都在看不见的 About 里）。热图视图里提到 Regenerate 的提示（程序报错/提前停止、旧记录无实测、表面放不上、旧记录无像素贴图）改说 "In the Realistic view, regenerate …"。
- 查看器报告的程序问题（帧的 error 或 "stopped early" 警告；**不含** "Painting the measured temperatures failed"，那不是程序的错）→ 输入框上方 "The viewer reported a problem with the program. Quote it in the note"，一键把原文（≤ 300 字）引进意见；顶部错误提示也改说 "…or quote the error to it in a note under About."。
- 出处行："…proportions are the model's estimate, revised twice from the owner's notes."；Regenerate 在已有修改时先弹确认 "Build a fresh model? This replaces the model and the N revisions made to it."（录像的环绕模式同样）。
- 顺手修正：`.twin-note-muted` 单独使用时不设字号，继承了栏里的 14px（用户截图里 "Written as a scene by…" 那行明显偏大），现与 `.twin-note` 同为 12px/1.4。

### 19.4 验证与部署

- functions tsc 绿；twinBuilding 单测 60/60（+8：修改 schema 严格形状且首版不含 changes、修改提示词在首版之上追加且 views 按序号重编号并省略未发送的、无旧轮次时不出该段、`changes` 截断与缺省、意见规范化与拒绝、线程清洗与保留最近 8 轮、可修改记录的各种拒绝理由与清洗）；全套 413/413；tsc(app) 仍只有仓库固有 8 个错、无 twin 错；eslint/prettier 绿；vite build 绿。
- **headless Chrome 实测**（本会话 scratchpad `harness/`：vite 用别名把 `stores/common`、`services/ai` 换成桩，真实 TwinRevise + twinRun + App.css + antd 主题；`drive.mjs` 33 项断言全过）：两轮线程与 You/Owner 标注、输入→发送（调用带 note 与 signal）→ 进行中气泡 + Stop → 停止后 Not applied → Edit and send again 回填 → Ctrl+Enter 发送被拒的修改显示服务端原因 → Dismiss → 成功一轮并入线程且出处行变 "3 times"、读者无输入框、引用查看器问题、250 px 窄栏无横向溢出、无异常；截图 revise-*.png 已目检。
- **未做真实模型端到端**（会写线上 Firestore 并计费）；要用户在 dev 里对一个 v6 记录发一条意见看效果。
- **19.3/19.5 的后续改动的验证**（同日）：scratchpad `harness/` 新增真实面板入口（`panel.html`/`panelMain.tsx`/`vite.panel.config.ts` → `dist-panel`，桩扩展 `?revised/?blocked/?newer/?fail`）与 `drivePanel.mjs`（workflow agent 写，158 项）、`drivePanelFixes.mjs`（22 项：网格视图切换铺满、叠放焦点环有位且内容对齐、栏溢出时构建中/停止/失败都滚进栏视野且页面不动、热图视图中构建与修改的进行行/失败行/看过即消失、真实面板回车发送）；`drive.mjs` 改为回车发送、Shift+回车换行、keyCode 229 不发送、About 隐藏不卸载（37 项）；三个驱动全过，截图目检；全套 413/413、tsc/eslint/prettier/vite build 绿。
- **部署**：functions（`analyzeTwinBuilding`、`analyzeTwinScene`）与 hosting；**先 functions 后 hosting**（新前端发 `feedback` 给旧函数会被当成普通 Regenerate 覆盖模型；旧前端对新函数没有影响）。规则不动。

### 19.5 构建工具栏下移（2026-09-11，用户："最上方两个按钮放到下面"）

- 场景孪生（图片集、录像的环绕模式）的构建工具栏——Regenerate / Stop / Clear、构建进度行、Stopped/失败提示，以及录像的 Fixed camera / Walk-around 选择——从设置栏**顶部**挪到**底部**：`SceneView` 把宿主传来的 `controls` 放进 About 段落末尾的 `<div className="twin-actions">`（修改对话框之后，细线分隔：先"告诉模型改哪里"，再"重新生成/清除"）。读者没有工具栏，包装 div 为空，`.twin-actions:empty { display: none }` 不占位也不留细线。
- 无场景可看的状态（blocker、旧记录、新版本记录、SceneBoundary 出错）同样改为**先提示、后工具栏**。
- 随后 About（含工具栏）改为只在 Realistic 视图显示，见 19.3。
- **审查（workflow：三个代码镜头 + 真实面板 headless Chrome 渲染 + 每条两个反驳者，158 项渲染断言全过）后的修正**：①构建的进度/Stopped/失败提示在按钮**下方**、长栏里会落在折线下（600 px 叠放时失败提示被截一半）→ 构建开始、停止、失败时（Realistic 视图）只滚动**设置栏**（直接改 `scrollTop`，不用 scrollIntoView 以免连带滚动整页）刚好露出 `.twin-actions` 底部；修改不需要（气泡就出现在输入框正上方）。②在热图视图里构建失败/停止后，进行中的那行消失、结果却在隐藏的 About 里 → 结果未在 Realistic 看过前，视图切换下方显示红字 "The regeneration did not finish — switch to Realistic to see why." / "Your note was not applied — …"（停止为灰字），回 Realistic 看过一次即消失（`seenRun`）。③叠放布局里 `.twin-side-scroll` 的 `overflow-x: hidden` 裁掉栏左缘控件（Regenerate、输入框）的 antd 焦点环（外扩 4 px）→ 叠放时 `padding-left: 4px; margin-left: -4px`（内容不动），网格里复位为 0 与原 14 px。④旧 bug：`.twin-view-mode { max-width: none }` 在容器查询里、却被后面同优先级的 320 px 基础规则压住，网格栏里视图切换从未铺满 → 覆盖规则限定为 `.twin-side-top/.twin-side-scroll .twin-view-mode`。⑤录像的 Fixed camera / Walk-around 切换加 `block`（两项平分轨道，不再左挤留一段空轨）。⑥注释（twinPanel 工具栏位置、App.css 头注释）更新。未采纳：固定机位孪生的工具栏仍在顶部（录像面板在两种孪生间重建时工具栏会上下跳，属已知取舍）；网格里工具栏紧跟内容而非钉在栏底。
- 不变：固定机位孪生（它自己的设置栏，工具栏仍在顶部，下面是很长的物体列表）与尚无记录的空状态（Build 按钮在说明文字上方；§20 起空状态换成构建表单）。

## 20. 构建前的要求输入 + AI 模型选择（2026-09-11 用户要求，本地已实现、未提交、未部署）

用户："没有 3d 模型的时候应该有用户输入框，让用户可以添加一些细节，告诉 ai 用户想要什么样的模型，有什么要求之类的。以及可以让用户选择使用不同的 ai 大模型。"

### 20.1 服务端

- **两个孪生函数都多两个可选字段** `model`（模型 key）与 `instructions`（owner 的要求）。`readTwinModelKey(raw, offered, fallback)`：缺省 → 默认；不在该类孪生的列表里 → invalid-argument "That model is not offered for this kind of digital twin."（**拒绝而不是悄悄换成默认**；在占限流名额之前检查）。
  - 场景程序（图片集 / 录像环绕，`analyzeTwinBuilding`）：`TWIN_PROGRAM_MODEL_KEYS` = deepseek（V4.1 Flash，默认，即原来的钉）、gpt56、gpt52、gemini、grok——应用接入的都能看图（另一会话同日把 DeepSeek 两个 key 合并成 `deepseek` → `deepseek-flash` 并标为 vision）；不提供 Claude（§0）。
  - 固定机位（`analyzeTwinScene`）：`TWIN_FIXED_MODEL_KEYS` = gpt56（默认）、gpt52、gemini、grok。~~**不含 DeepSeek**：它拒绝 json_schema，而固定机位提示词把字段完全交给 schema，降到 json_object 时模型不知道要哪些字段。~~ **2026-09-15 用户要求加上 DeepSeek**（列表与场景程序相同、顺序相同，默认仍 gpt56）：`buildTwinScenePrompt` 多可选 `shapeInPrompt`，为真时系统段末尾附上 `describeJsonSchema(TWIN_SCENE_JSON_SCHEMA)`——把 JSON schema 逐字段渲染成文字（名字、类型或枚举值、schema 自带的 description，按嵌套缩进），并把第一条规则改成 "of exactly the shape given after these rules"；其他模型的提示词一字不变。`resolveOpenAiProvider` 新字段 `jsonSchema`（deepseek=false），`analyzeTwinScene` 按 `!provider.jsonSchema` 传 `shapeInPrompt`，`callModelForTwinScene` 的梯子对这种端点直接从 json_object 起步（省掉必然的 400，建筑孪生同样受益）；函数 secrets 加 `DEEPSEEK_API_KEY`；`TWIN_SCENE_MAX_TOKENS.deepseek` 16000→60000（low 推理也计入上限）。`scripts/evalTwinScene.ts` 加 deepseek 候选（按端点选两份提示词之一）。
  - ~~第二阶段描表面/地标仍钉 GPT-5.6（`TWIN_SURFACE_MODEL_KEY`），与第一阶段选谁无关——表单上写明。~~ **2026-09-21 解绑（§27）**：描面/地标就用写场景的那个模型，修改也一样；没有第二个下拉、没有后台默认。
- **要求**：`readBuildInstructions`（与修改意见共用 `normalizeOwnerText`）：缺省/空白 → null（不是错误，这是常态）；非字符串/超 `TWIN_INSTRUCTIONS_MAX`=1000 → invalid-argument（拒绝不截断）。场景程序提示词：系统段在 "Answer with JSON only" 前加 **THE OWNER'S REQUEST** 段（照片允许处照做；主体是什么、部件关系以 owner 为准，未提及的比例仍以照片为准；不能改帧的 API、单位、parts 规则与答案格式；做不到的做最接近的），用户文本在标题/描述之后、修改块之前以三引号引用，结尾改为 "Write the model, following the owner's request."。固定机位提示词在用户文本里三引号引用并限定"用它命名物体、判断热角色、决定略去什么；不因要求里提到就报告照片里没有的物体"。
- **修改（§19）也可以选模型**（用户同日看到修改框后要求"这里也应该可以选择不同模型"）：随意见发来的 `model` 同样按 `TWIN_PROGRAM_MODEL_KEYS` 校验；不发则用写出当前程序的模型（`twinModelOfRecord`：记录的 `modelKey` 仍在列表中则用它，否则按厂商 id 反查，再否则默认）。**要求不能随意见更改**（随意见发来的 instructions 忽略），沿用孪生当初的要求（`RevisableTwin.instructions`，REVISING 段加 "The request the model was first built to still stands."）并带进新记录。每轮修改记下 `modelKey`（`TwinBuildingRevision.modelKey`，`readRevisions` 保留），线程里显示 "You · 时间 · to GPT-5.2"；记录的 `model/modelKey` 是写出**当前**程序的模型（修改后即最后一轮的模型），出处行有修改时改为 "Written as a scene from 5 photos and revised twice from the owner's notes, most recently by X"。修改提示词改为不假定"你写的"（"has already been written — its program is in the message, perhaps by another modeller"、"Where each camera was judged to stand"、"— answered:"），换模型修改时说法仍对。
- **记录**多 `modelKey` 与 `instructions`（有才写，Firestore 拒 undefined）；`model` 仍是厂商 id。`logModelUsage` 多 `instructions: bool`。
- **token 上限按厂商**（后台调研，官方文档）：场景程序 `TWIN_BUILDING_MAX_TOKENS` openai 40000（OpenAI 建议给推理+输出至少留 25k）、deepseek 60000、google 60000（Gemini 2.5 Pro 思考计入上限、默认最多想 32k、上限 65,536）、xai 60000（xAI 没说 `max_tokens` 是否含推理；上限 128k）；固定机位 `TWIN_SCENE_MAX_TOKENS` 一律 16000（原 6000 对 Gemini 可能想完就没答案；上限不用不花钱）。`callModelForTwinScene` 的 `format` 改为必填（原默认值只剩死代码）。
- **未实测**：Gemini 2.5 Pro、Grok 4.5、GPT-5.2 写场景程序，以及它们做固定机位分析，都没用真实数据跑过（会写线上 Firestore 并计费）；GPT-5.6 写场景程序在 §17 用过、DeepSeek 是现行默认。Gemini 默认动态思考、Grok 默认 high 推理，可能慢；若超时再考虑给它们各自的 `twinExtras`。

### 20.2 客户端

- **`twin/twinModels.ts`（新）**：两类孪生的模型列表（`program` / `fixed`）、标签（复用 `MODEL_LABELS`）、默认、`twinModelOf(record, kind)`（记录的 key，或旧记录按厂商 id `deepseek-flash`/`gpt-5.6-luna` 反查）、`twinModelLabel`；每类孪生记住上次选的模型（localStorage `twin-model:<kind>`，作为下一个实验的起点）；**每个实验一份表单草稿** `twin-draft:<expId>` = `{ text?, models?: {program?, fixed?}, mode? }`（`text` 缺省=没动过、`''`=有意清空；`mode` 是录像的构建方式）：切标签、刷新、构建失败后表单原样回来；构建成功或 Cancel 清除（成功时按开始时的快照比对，别的标签页新写的草稿不误删）；存储访问全部 try/catch、逐字段校验。
- **`twin/twinBuildCompose.tsx`（新）构建表单**：标签 "Tell the AI what you want · optional"、**输入框里不放 placeholder 例句、框下也不写按键提示**（用户 2026-09-11：先"输入框内不需要提示词"删掉例句，再"不需要 enter to send 这部分文字"删掉按键提示；两个框都只在接近 1000 字上限时显示计数，修改框另在有构建占用时显示 "Wait for the build to finish"；回车发送/构建、Shift+回车换行、有警告时回车只换行的行为不变，只是不再写出来）、1000 字上限与接近上限的计数、"AI model" 下拉、Build / Stop / Cancel、第二阶段由 GPT-5.6 描表面的一行说明（场景程序且有热像时）、替换什么的警告行。**回车构建（仅当已写了内容）、Shift+回车换行、输入法组字不触发**（同修改框）；要求可空，按钮照样构建。两种布局：`card`（空状态，居中 ≤ 560 px 卡片，标题 "Build a digital twin" + 说明）与 `inline`（Regenerate 打开，替换工具栏，打开时聚焦并只滚动所在设置栏）。另导出 `TwinRequestNote`：给所有读者的折叠 `<details>` "Built to your / the owner's request"。
- **图片集面板**：无记录时 owner 看到的就是表单卡片（下方是进度/停止/失败提示），读者仍是一句灰字；有记录时 About 底部工具栏 **"Regenerate…"** 打开同一表单（预填该孪生的要求、预选它的模型）；原来"已有修改时的 Popconfirm"改成表单里（按钮行**上方**、带图标）的警告行 "This replaces the twin and the N revisions made to it."，**有警告时回车只换行**、只能点按钮；Cancel 关闭并丢弃草稿；构建成功后清除草稿（记录里已有要求）。进度行写明模型名。
- **录像面板**：同上，Fixed camera / Walk-around 切换放进表单头部（卡片里配各自的说明文字，inline 里配一行提示），切换即换模型列表；以另一种方式重建时表单从默认开始、按钮为 "Rebuild"，警告写明替换的是哪种孪生（固定机位有修正时 "…and your corrections to it"，环绕有修改时列出轮数）；hasVisible 未知时 Build 禁用并说明原因，没有可见光照片时只显示"无法重建"提示、不显示表单。固定机位孪生的 Objects 段加一行 "Named and placed by <模型> from frame N." 与要求折叠框。
- **查看器 About**：出处行用模型标签（"Written as a scene by DeepSeek V4.1 Flash from 5 photos…"；有修改轮次时改为 "Written as a scene from 5 photos and revised twice from the owner's notes, most recently by X"），其下是要求折叠框。**修改框**（twinRevise）在输入框下加与构建表单同样的 "AI model" 下拉（默认写出当前程序的模型；Edit and send again 连模型一起恢复），进度与 Revise 按钮提示写明发给哪个模型；引导语改为 "Something wrong with the twin? Tell the AI what to fix."。按键提示与 "AI model" 标签 `user-select: none`（用户截图里 "Enter to send ·" 被选中高亮——修改框为空时 Revise 按钮禁用，禁用按钮上的双击会穿透去选中旁边的文字）。
- `services/ai.ts`：`TwinBuildOptions {model?, instructions?}`、`buildPayload`（空白要求不发）、`analyzeTwinScene(expId, recordingIndex, stability, options, signal)`、`analyzeTwinBuilding(expId, source, {model, instructions} | {note}, signal)`。`types.ts` 两种记录加 `modelKey?`、`instructions?`。`App.css`：`.twin-start`、`.twin-compose*`、`.twin-request*`。

### 20.3 验证

- tsc(app/functions)、eslint、prettier、全套 481 测试、vite build 全绿。
- **headless Chrome 真实面板实测（本会话 scratchpad `harness/`，两个 workflow 共 8 + 3 个 agent）**：图片集面板 `driveCompose.mjs` 430 + `drivePanel.mjs` 170 + `drivePanelFixes.mjs` 22 + 修改框 `drive.mjs` 48；录像面板 `driveRec.mjs` 344 + `driveRec2.mjs` 93 + `probeTrunc.mjs` 21 + `probeCross.mjs` 4 —— **合计 1132 项、0 失败、无控制台报错**，截图目检。覆盖：空状态卡片（标题/说明/模型列表与默认/热像时的描面说明/宽度 1100·600·380·360 不横向溢出）、回车与输入法、草稿与模型/方式的记忆（重挂载、刷新、失败后重开）、构建中禁用与进度/停止/失败、Regenerate… 打开 inline 表单（预填、警告在按钮上方、回车只换行、滚动刚好露出且不越过表头、Cancel 清草稿）、要求折叠框（owner/读者）、固定机位 Objects 段的出处、跨类型重建的警告与按钮文案、手机布局。
- **未做真实模型端到端**：Gemini / Grok / GPT-5.2 写场景程序、以及固定机位分析，都没用真实数据跑过（会写线上 Firestore 并计费）。

### 20.4 部署

- functions（`analyzeTwinBuilding`、`analyzeTwinScene`）与 hosting；**先 functions 后 hosting**（旧函数会忽略 model/instructions 用默认模型照建，表单看似生效实则没有；与 §19 的顺序要求一致）。规则不动。

### 20.5 审查后的修正（workflow：photo-set / recording 两个真实面板 headless Chrome 驱动 + 服务端/客户端/UX 三个审查镜头 + 各自反驳者；13 条确认、13 条驳回）

- **慢模型吃光预算**：第一阶段改由 `withTwinDeadline` 给到函数预算尽头（场景程序 345 s、固定机位 170 s），超时报 deadline-exceeded 并点名模型，而不是撞上平台强杀（客户端只看到"没有回应"）。第二阶段按剩余时间分波，**每次调用不足 30 s（`TWIN_SURFACE_MIN_CALL_MS`）就不描表面**：程序照存，每张热像照片记一行 `model-failed` + "not traced: writing the scene took N s…"；描完若全部失败而**全是超时**，也保留程序（原来会抛 internal 把已付费的程序丢掉），只有真有模型报错才抛。查看器把这类照片说成 "the build ran out of time for N"。
- **表单草稿合成一个键** `twin-draft:<expId>` = `{ text?, models?: {program?, fixed?}, mode? }`：重开 Regenerate… 表单（失败/停止后、切标签后）恢复**文字和所选模型**（原来模型会退回孪生原来的）；录像的 Fixed camera / Walk-around 也进草稿（原来构建中切标签回来会显示错的方式，重试建错类型）；构建开始时取草稿快照，成功后**只在草稿没被别的标签页改过时**才清除。
- **输入框跟随 `request`**（存储的孪生的要求，不分类型）直到用户动手改；**要求跨类型保留**（写的是主体本身），模型预选按类型重置——原来框只在挂载时填一次，切换方式后内容取决于点击顺序。
- **Enter 不再触发会丢东西的构建**：有警告（会替换修改线程 / 另一种孪生 / 修正）时 Enter 只换行，只能点按钮；警告移到按钮行**上方**并加图标；按键提示随状态变（空框 "Leave it empty and the AI decides"、有警告 "Enter for a new line · Regenerate builds"）。
- inline 表单滚入设置栏改为**两帧之后**（等 antd autoSize 撑开输入框再量），且**不越过表单顶部**（原来长要求时按钮与警告仍在折线下，短栏时又把标签和输入框滚出去）。
- `.twin-start` 可纵向滚动（矮工作区里失败提示不再被 `.chart-manager-wrapper` 裁掉）；模型行标签不换行、下拉最少 168 px，窄宽时按钮先换行（原来 380 px 时 "AI / model" 折成两行、模型名被截成 "DeepSeek V4.1…"）；提示字号 12 px。
- 文案：本轮新增处 "model" 指 3D 的一律改 "twin"，AI 一律 "AI model"；表单注明 "Any language · readers see it with the twin"；空状态卡片里的 Stop 提示 "nothing is saved"；非 staff 的 owner 不再看到第三人称的 "The owner has not built…"，改为 "Building digital twins is open to staff accounts only for now."。
- **第二轮（复核 16 条全部确认修好，另有 6 条新低危）**：①第二阶段"整批失败"只在**没有任何一张是超时**时才抛 internal（原来混合失败仍会丢掉已付费的程序），抛错引用第一条非超时的原因；②分波按**真正会调用模型的照片**算（无帧/比例不对的照片瞬时返回），跳过时也给它们各自真实状态（`traceTwinSurfaces` 新增 `skip` 参数）；③长要求打开 inline 表单时把输入框自身滚到末尾（光标在的地方）；④手机上（栏本身不滚动）改滚页面，桌面仍只滚栏；⑤无场景可看的三种状态（拒绝/旧记录/新记录/查看器出错）与固定机位的 "Not rendered" 包进可滚的 `.twin-notice-stack`（矮工作区不再裁掉表单按钮）；⑥空状态里构建开始/失败/停止时把 `.twin-start` 滚到底露出进度与提示；⑦"全是超时"的提示改说 "Regenerate with a faster AI model to leave time to trace them."；⑧按键提示 "Enter for a new line · click Regenerate to build"；⑨热图视图的 away 行改说 twin。
- **驳回/不改**：用户要求可让固定机位略去支撑物（有意，隐藏开关同样效果）；原要求在修改中"仍然有效"与新意见冲突（提示词已要求以意见为准并保持已应用的）；三引号未转义（owner 只能影响自己的孪生，同标题/描述）；Cancel 丢弃草稿（有意）；被挡住的孪生不显示出处（无模型可误读）；两个输入框并存（有标签与分隔线）；About 只在 Realistic（用户定的）；固定机位窄屏时 inline 表单压缩 3D 视图（只在打开表单的片刻，暂不改）。

## 21. 有温度数据的场景孪生也提供 Simulated（2026-09-11 用户要求，本地已实现、未提交、未部署）

用户："在 3d house 中也添加模拟模式。也就是说对于有温度数据的实验，也添加模拟模式。"（截图：无热像的图片集是 Realistic | Simulated，"3d house" 只有 Realistic | Measured。）

- **原因**：视图切换按 §18.3 / §18.6 F3 的规则——Simulated 仅当 `subjectKind === 'building'` 或记录没有 thermal——有温度数据时只看模型答的 `subjectKind`。"3d house"（`ZyzXCNoDJix6tn7WDqWM`）首次生成时 DeepSeek 答的是 building（§18.7 端到端记录），**经两轮修改后被重答成 `other`**（修改会重新解析整份答案，`subjectKind` 跟着漂），Simulated 随之消失。线上其余带热像的场景孪生（环绕汽车 vehicle、笔记本桌面 interior）同样没有 Simulated，而无热像的记录不论主体都有。
- **改动**（只动 `twinBuildingViewer.tsx`）：视图切换恒含 Simulated——Realistic | Measured（有实测时）| Simulated，任何主体、有无温度数据都一样；默认视图不变（有实测进 Measured，否则 Realistic）。模拟是"所选条件下相机会读到什么"的演示，与实测并列、不替代它；Simulation 分区的说明加 "every part treated as a building's outside surface"（无条件：公式本来就是建筑外表面的平衡，而 `subjectKind` 不可靠），有实测时再加 "(what the camera read is in the Measured view)"。帧不改：simulated 下 `applyMode` 换成每 kind 的模拟着色器、地面用 `thermalMaterial('ground')`，投影深度图只在 measured 渲染，探针 `readSurface` 只在 measured 查表；实测表、投影照片、钉住的读数在切换间都保留，切回 Measured 原样恢复。两个热图视图的色标仍各自独立（模拟用帧内 iron 与预设色标，实测用实验调色板与表的范围）。
- **已知取舍**：模拟公式是建筑外表面的围护结构平衡（室内/室外、日照、天空），对器材、车辆、室内只是示意（室内看到的是墙的内表面，公式算的是外表面）；无热像的这类记录本来就如此，且所有数值用户都能改。
- **未做（建议）**：修改时服务端沿用上一版的 `subjectKind`（一条修改意见不会改变主体是什么）。它除了曾经决定 Simulated，还决定 Measured 的推断顺序（`twinSceneThermal.infer`：building/nature 先"同 kind 同朝向"，其余先"本部件其他面"）与天空遮罩（interior 不遮）——"3d house" 现在按 other 推断。线上这条记录要回到 building 须再修改/重生成或手工改数据。**实测影响不大**（本会话 scratchpad `kindDiff.ts` + 从帧抓到的真实 `built.parts`，17 部件 102 个面）：两种 kind 下 measured/inferred/none 的计数、色标 [29,41]、地面值完全一样，只有 **11 个推断面**取值不同（最大 1.34 °C，在 `sideBay · front`，其余 0.09–0.76 °C），没有一个面改变状态（实测/推断/无数据）；变的主要是探针那句"从哪里推来的"与 strong/weak（8 个 weak→strong）。fill `all` 的 42 个填充面与 kind 无关（`inferFill` 不读 kind）。这条记录的墙面本来就都在 31–32 °C，差异被压小了；向阳/背阴温差大的主体上两套顺序会拉开。
- **注释**：`types.ts` 的 `TwinSubjectKind` 与 `functions/src/twinBuilding.ts` 的 `TWIN_SUBJECT_KINDS` 头注释原写"只有 building 有模拟热图"，改为它现在决定什么（Measured 推断顺序、interior 无地面无天空遮罩）、Simulated 对所有 kind 开放。服务端只改注释，无需部署函数。
- **验证**：prettier/eslint 绿；`tsc -b` 只剩仓库固有 8 个错、无 twin 错；vite build 绿；twin util 单测 96/96。**真实记录 headless Chrome**（workflow：本会话 scratchpad `harness-sim/`，线上 4 条记录只读拷贝 `fixtures/`：house=3d house(other)、vehicle=汽车环绕（经真实 TwinPanel）、interior=笔记本桌面、civic=无热像 building 对照；1100 px 网格与 380 px 叠放两种宽度，两轮 187 项全过、页面与帧零报错）：三条带热像的都是 Realistic | Measured | Simulated、默认 Measured，civic 仍 Realistic | Simulated、默认 Realistic；Simulated 下出 Simulation 分区、帧图例 legSim、悬停读 "-4.0 °C · wall"，夏午色标 25/75；在 Simulated 钉的读数切到 Measured 变成实测标签（"32.0 °C · wall · measured · photo 1 …"），切回又是模拟值；三项视图切换无横向滚动、标签不截断（宽 116 px、窄 105 px）。另有代码/文案两个审查镜头 + 每条两个反驳者：确认 4 条（本节的两处注释、F3 指针、原因句自相矛盾、说明加"建筑外表面"），驳回 2 条。
- **旧问题（与本改动无关，未改）**：模拟着色器对背面翻转法线而探针 `surfaceTemp` 用未翻转的命中法线，开放平面从背后看读数与颜色可差一个日照/天空项；Measured 里 "Look from" 设的照片视场与压低的俯仰下限会带进 Simulated（那里没有 Overview 按钮）；380 px 叠放时设置栏越长 3D 视图越矮、帧提示在图例旁被挤成一词一行。
- **部署**：只 hosting（函数只改注释、规则不动）。

## 22. Simulated 控件重排：一行一个数、滑杆当基线、材料表折叠（2026-09-11 用户："这里UI太挤了"，本地已实现、未提交、未部署）

用户截图：Simulated 设置栏里 Sky light / Height / From / Scale 挤成一团，MATERIALS 的 **Kind 列完全看不见**（表头 "Kind" 和 "U" 叠在一起）、最右 `± °C` 列被切掉。

- **病根（headless Chrome 量的，不是估的）**：设置栏是 `clamp(260px, 34%, 380px)`，减去 1px 边框 + 14px + 4px 内边距 + 滚动条，内容盒只有 **226–241px**；而 `.twin-mat-grid` 的固定部分是 `4×58 + 4×6 = 256px`，于是 `minmax(0,1fr)` 的 Kind 轨道被算成 **0px**，整个网格再溢出 11px 被 `overflow-x:hidden` 切掉（红线：任何 tab 不许横向滚动）。面板 **760–960px 宽时必坏**（1536px 屏 + 3:4 播放器正好落在 ~900px），≥1000px 才侥幸不坏——而既有的 1100/380 测试矩阵刚好跳过这一段。同时每行浪费 ~130px：标签框 233px 全是空的，值却只能挤在 36–44px 里（antd 的 `suffix` 是**在流内**布局的，"W/m²K" 吃掉 42px），`.twin-param-pair` 的 `width: 84px` 是**死规则**（前一条 `.twin-row .twin-param-input { flex: 0 0 104px }` 同特异度且设了 flex-basis，赢了），所以 "Scale" 标签只剩 6px 放 27px 的词、被输入框盖住。整段高 1047px。
- **方案（4 个并行设计 agent + 3 个评委，评委一致选 "Readout rows"，并各自砍掉/嫁接了若干条）**：
  - **一行一个数**（`.twin-param` / `.twin-param-line`）：标签（虚下划线+tooltip）· 单位（11px，`--ifi-text-tertiary`）· 可选状态词 · `margin-left:auto` · 62px 右对齐加粗 tabular 值框（`controls={false}`，去掉 antd 的 suffix，单位改挂在标签旁——材料表早就是这么把单位提到表头的）。**滑杆绝对定位成这一行的基线**（`inset-inline: 6px; bottom: 0`，只作用于 `.twin-param >`，twinPanel 的相机俯仰滑杆不受影响），于是一个数 34px 而不是 44px，且每条轨道的填充长度一眼看出哪些条件顶到了上下限。
  - **太阳的状态只说一次**：原来 Strength / Sky light 的 "no effect at night" 和 Height 的 "night" 是同一件事说三遍、又是行里最宽的东西（83.6px），改成 SUN 小标题后面一句 `.twin-subhead-note`（"· below the horizon, warming nothing" / "· no direct beam, only the sky light"），顺便解释了 From 为什么是灰的。From 自己的 "front-right" 留着（那是本行信息）。
  - **材料表折叠**（`<details class="twin-mats">`，沿用 `.twin-request` 的 disclosure 惯例，不用 antd Collapse）：summary 写 "Materials · 8 kinds"，改过就再加 teal 的 "· 2 changed"——**折叠可以收起数字，不能收起"有人改过"这件事**；Reset 放在 body 里（按钮放 summary 里会和 disclosure 自己的点击目标打架）。`open` 提到 twinBuildingViewer 的 state：整个 Simulation 分区在切到 Measured 时会卸载，放组件自己的 useState 会每次回来都重新折叠。
  - **材料网格按内在尺寸排**：`minmax(0, 1.5fr) repeat(4, minmax(40px, 1fr))`、gap `2px 3px`、`max-width: 344px`（和 `.twin-view-mode` 的 320px 封顶同理，免得叠放时名字列拉到 500px）。40px 的下限是算出来的：格子里最宽的值是 °F 下的 ±10 K 偏移 "-18.0"（31px），加 6px 内边距 + 2px 边框 = 39px；剩下的给名字，231px 时名字 59px，"vegetation" 要 56px。**注意**：不能用 `minmax(38px, 58px)` 这种"能长回 58"的写法——网格的 maximize-tracks 一步里 fr 轨道按定义不参与增长，自由空间会先被这四条吃光，Kind 又归零，等于换个方式复现原 bug。
  - 材料格子保持**有边框**（`--ifi-stroke-1`，比条件行弱）：设计稿原本是 hover 才显边框，三个评委一致反对——§21 的诚实论证就是"所有数值用户都能改"，32 个不像输入框的输入框把这条卖掉了。
  - `.twin-side-scroll` 加 `scrollbar-width: thin`：这一栏必然纵向溢出，滚动条一直占宽，细的能还回 4px（仓库里 App.css:276 / 2677 已有先例）。
  - 说明文字**留在明处**只做精简（设计稿想折进 `<details>`，评委否决：§21 那句"演示不是测量 / 每个部件当作建筑外表面 / 相机实测在 Measured 视图"是这个面板唯一不能折的东西）。
- **评委砍掉的（记下来免得再提）**：可拖的"太阳方位圆盘"（手写 SVG + pointer capture + ARIA 说不清，且省下的高度已经省到了）、把 wind/sky cooling/sky light 折起来（一行 34px 之后这四个才 140px，为 140px 藏物理参数不划算）、`.twin-mat-nil`（把 0 调淡：新造一个"哪些数字重要"的状态类）、写死滑杆颜色（线上是 teal，harness 里发蓝是 ConfigProvider 没覆盖到的假象）、`@media (pointer: coarse)` 的滑杆围裙、`:has()` 当布局选择器、把 Strength/U/Store 改名。
- **结果**：整段 1047px → **703px**（260px 栏）、1014px → 669px（380px 栏）；材料展开也只有 915–939px。§21 里"380px 叠放时设置栏越长 3D 视图越矮"那条旧抱怨顺带缓解。
- **验证**：prettier / eslint（两个改动文件 0 条，仓库另有 16 条旧 warning）/ `tsc -b`（只剩固有 8 个错）/ `vite build` 全绿；twinSimulation 单测 21/21。**真实记录 headless Chrome**（本会话 scratchpad `harness-sim/`，脚本 `check.mjs` / `interact.mjs` / `shot.mjs` / `tryCss.mjs`，线上记录只读拷贝 `fixtures/`）：house/civic/vehicle × °C/°F × 320–1400px 八档 × 材料强制展开 × 有无滚动条，**48 项全过**（不横向滚动、没有被压没的文字、没有被控件盖住的标签、没有塌成 0 的轨道、每个值框和格子都装得下它能产生的最宽字符串 "-266.0" / "-18.0"、零 console 报错）；`interact.mjs` 走一遍真实操作，**19/19**（默认折叠 → 点 summary 展开 → 输入 1.4 → summary 出 "· 1 changed" + 该 kind 变 teal + Reset 出现 → 切 Measured 再回来仍是展开且值还在 → Reset 复位 → 拖基线滑杆改数且 Scenario 变 Custom）。截图 `before-*` / `after-*` / `afterOpen-*` / `interact-w900.png` 已目检。
- **未做 / 待验证**：真机没看过（只有 headless），要用户在 dev 里看一眼滑杆当基线的观感、以及 125% 缩放下手柄与文字的间距；固定机位孪生（TwinPanel 的 props 版）没有 fixture，只做了代码层面的回归检查。
- **部署**：只 hosting（不动函数、不动规则）。

## 23. 场景孪生默认停在 Realistic 视图（2026-09-11 用户："3d twin 模型默认用真实标签"，本地已实现、未提交、未部署）

原先 `twinBuildingViewer.tsx` 的默认视图是"有实测就进 Measured，否则 Realistic"（§21 沿用的老规则），于是带热像照片的孪生一打开就是一身热图色，先看到的是"读数"而不是"这是什么东西"。

- **改动**（只动 `twinBuildingViewer.tsx`，一处）：`mode` 的兜底从 `measuredOffered ? 'measured' : 'realistic'` 改为恒 `'realistic'`；仍然是**推导**出来的（不是 effect 里钳位），所以任何一帧都不会把帧不能显示的模式发过去。用户选过的视图照旧保留（`chosenMode` 在它仍被提供时优先）。Segmented 的三项、Measured/Simulation 分区、探针、投影贴图全不变——Measured 只是不再自动打开。
- **顺带的好处**：About（模型描述、修改对话、构建工具栏）属于 Realistic 视图，默认进 Realistic 后，构建/修改跑完的结果和错误一打开就看得到，不再需要"switch to Realistic to see why"那条提示引导（提示本身留着，从热图视图切回时仍有用）。
- **不改固定机位孪生**（`twinPanel.tsx` 的 Real | Thermal | Blend，默认仍是 Thermal）：那是单帧热像投到一个盒子上，Real 视图几乎是空几何，热图才是它的正文。
- **部署**：只 hosting。

### 22.1 对抗审查后的修正 + Measured 的 Infer 行（2026-09-11 晚，用户第二张截图："还有这里"）

**审查**（5 个镜头 × 每条 2 个反驳者，29 条findings，6 条经反驳仍成立；另有 15 个反驳 agent 因会话额度中断，那几条我自己判了）：

- **blocker：材料格子没有 hover/focus 外观。** `.twin-mat-grid .twin-mat-input.ant-input-number{border-color:…}` 是三个类（0,3,0），压过 antd 自己的 `:hover` / `:focus-within`（两个类），于是 32 个输入框指上去、Tab 进去都毫无反应。补回 `:hover, :focus-within { border-color: var(--ifi-teal) }`。**教训同 §22 的死规则：覆盖 antd 的静态色，必须把它的状态色一起还回来。**
- **滑杆手柄的 hover/focus 光环被自己那行的值框吃掉**：光环在 10px 手柄外约 9px，会伸进它当基线的那一行，而 `.twin-param-line` 有 `z-index:1`。改成 `:hover/:focus-within` 时 `z-index:2`——光环显示时滑杆在上层。
- **SUN 那句状态少一种情况**：只判了 night 和 `irradiance===0`，漏了 `diffuse` 也是 0 时仍说"only the sky light"。三支：below the horizon / no direct beam, only the sky light / **up, but no light at all on the model**。
- **第一次改材料时 Reset 行插在表格上方，整表往下跳一行**（还在那个格子里打字）。Reset 行移到表格**下面**。
- **注释里同一栏宽写了三个数**（226/230/231）：统一成"细滚动条 231、浏览器不认 `scrollbar-width` 时 226"。
- **harness 的 "no label under a control" 断言从改版起就没跑过**（还在找 `.twin-row` / `.twin-param-head`）。改查 `.twin-param-line, .twin-row, .twin-field`，并加一条"手柄不许压在标签上"；现在 Simulated 每次配对 10 行、Measured 2 行（原来 0 行），仍 0 失败。
- 自己判的（反驳者没跑完）：帧还没回报 `built` 时 `simKinds` 是 `[]`，折叠的 summary 会写 "Materials · 0 kinds"——**kinds 为空直接不渲染这一折**；滑杆 tooltip 对 `°` 会写成 "45 °"，改成角度不加空格；"Sun %" 的 tooltip 写"85 a dark roof"而 §17.5 早把 roof α 调到 0.93（表里显示 93），改成"about 90 for asphalt or a dark roof"；色标那行紧贴 SUN 组，`.twin-params + .twin-params { margin-top: 6px }` 把它分开。
- 驳回未改的（留档）：滑杆 tooltip 盖住值框（拖动时的瞬时遮挡，antd 默认位置）、`vegetation` 只靠细滚动条多出的 2.7px 才不省略（省略了也有 tooltip）、偏移格子只剩 0.7px 余量（已量过最宽值装得下）、Scale 独占整行、材料格 22px+2px 行距刚好 24px 命中区、`.twin-muted` 对比度、把标签的 tooltip 做成可聚焦（全站 `.twin-param-label` 都这样，不在本次范围）。

**Measured 的 Infer 行**（用户截图：`Infer` 字号偏大、三档被截成 "Comp…" / "Everyt…"）：`.twin-field` 原来没写字号，继承 14px，比这一栏其余 12px 的东西都大；`.twin-field > span:first-child` 又固定占 48px，三档只剩 175px。改：`.twin-field{font-size:12px}`（Scenario / Look from / 固定机位面板的字段一起归位）；新 `.twin-field-stack` 让标签独占一行、控件占满宽（**声明在 `.twin-field` 之后**，同特异度靠顺序取胜）；antd 的 Segmented 自己定字号，`.twin-field .ant-segmented .ant-segmented-item-label{padding:0 6px;font-size:12px}` 才真的收窄——三档 210px 落进 249px。**加了断言**"a choice is cut off"（`scrollWidth > clientWidth` 的 segmented/select 选项）：把字号改回 14px 时它报 `["Comparable","Everything"]`，改完报 `[]`。

**复验**：Simulated 48 项、Measured 20 项、Realistic 2 项全过（3 条真实记录 × °C/°F × 320–1400px × 有滚动条），`interact.mjs` 19/19 仍全过；prettier / twin 目录 eslint 0 条 / `tsc -b` 固有 8 个 / vite build / 单测 21/21 全绿。**仍未在真机目检。**

### 22.2 色标那一行（2026-09-11 晚，用户："没有变化" → 指的是 Scale 行别扭）

两个 62px 的框里数字**右对齐**（跟上面单值那一列对齐），于是两位数的 "29" 左边空了 40px：一行读下来是 `Scale °C ……… [　　29] … [　　41]`，两个半空的框夹着一个悬空的省略号，不像一个区间。改成**一组区间**：框收到 56px、数字居中、中间换成 en dash（装饰性，`aria-hidden`，两个框自己带 "Scale from" / "Scale to" 的 aria-label），读作 `29 – 41`。两条新规则与单值那两条同为三个类，**必须声明在其后**靠顺序取胜（本节第三次踩同一个坑）。窄栏算术：`Scale` 27 + 6 + `°C` 11 + 6 + (56+6+5+6+56) = 179px，落进 226–231px。Measured 与 Simulated 共用同一个 ScaleField，两处一起变。复验：Simulated 48 项 + Measured 20 项 + interact 19/19 全过（值框断言用最宽的 "-266.0"：56px 框有 46px 字宽、需 38px）。

### 22.3 滑杆手柄压在值框上（2026-09-11 晚，用户："还是重叠在一起的"）

滑杆当基线之后，**值把手柄推到它自己的值框正下方时会撞上**：antd 的手柄是 12px 滑杆盒里的 10px 圆点、外面再描 2px 环，圆的顶边到 `.twin-param` 底边是 13px，而 `padding-bottom` 只有 10px + 24px 的行 → 圆**啃进框里 3px**。Simulated 里没看出来是因为冬夜预设的色标是 −12…2 落在 −40…130 上，两个手柄都在左边；**Measured 的色标 29–41 落在表自己的 sliderBounds 上，两个手柄永远就在两个框底下**——用户截的正是这一处。量出来 `daylight = −3`。改 `padding-bottom: 16px` / `min-height: 40px` → `daylight = +3`（悬停时环变 4px，仍有 1px，且悬停态已经在上层）。一个数的节距从 34+4 变 40+4 = 44px（原布局是 44+6 = 50px），Simulated 分区折叠态 703 → **763px**（原 1047），展开 915 → 992px。**加了断言**"a slider handle touches the value box above it"（手柄与值框水平相交时，`handle.top − 2 − box.bottom ≥ 2`），Measured 24 项 + Simulated 48 项全过。**教训**：这一栏里"把控件叠进另一个控件的行"的写法，必须按**值能到达的位置**去量，不能只看默认值——两个视图的色标默认值刚好一个躲开、一个撞上。

## 24. 固定机位孪生的修改对话（2026-09-15 用户要求，本地已实现、未提交、未部署）

用户截图（录像的固定机位孪生 "3D twin - bottle"，右栏 VIEW / Camera tilt / OBJECTS）："右侧也应该提供聊天窗口，让用户可以提供反馈给 ai，修改模型。参考图片实验的部分是如何实现的。" —— 即把 §19 场景孪生的修改对话搬到固定机位孪生。

### 24.1 服务端（`analyzeTwinScene` 多一个可选 `feedback`，不新建函数；照 §19 的做法）

- **请求** `{ expId, feedback, model? }`。`readRevisionNote` 与 §19 共用（≤ 1000 字，拒绝不截断）。修改时 recordingIndex / stability / instructions 一律取自记录，请求里的忽略；`model` 按 `TWIN_FIXED_MODEL_KEYS` 校验，缺省用写出当前分析的模型（`twinModelOfRecord`）。
- **可修改的记录**（`readRevisableTwinScene(exp.twinScene, exp.twinEdits)`，twinScene.ts，占限流名额之前检查）：不是 kind building、recordingIndex 为正整数、scene 能被 `parseTwinScene` 读出。**被渲染门挡住（blocker）的也允许修改**——意见正是 owner 告诉模型它漏认了什么的途径。stability / registration 原样沿用（同一帧，不再读 mix 图、不再配准）；线程经 §19 的 `readRevisions` 清洗；`storedKey` = 原始 scene 的 JSON（事务比对用）。
- **owner 的手工修正折进给模型看的分析**：`readTwinCorrections` 逐字段清洗 twinEdits（客户端可写：kind 必须在列表内、spec / restingOn ≤ 60 字、hidden 只认 true、pitchDeg 夹到 0–85）；`applyTwinCorrections`（镜像客户端 `applyTwinEdits`）替换 kind / restingOn、删掉 hidden 的物体（站在它上面的落到桌面，悬于它之上的 heldOver 清空；非 held 的 heldOver 清空），每条修正写成一句话（"obj1 ("…"): the owner made it a petri_dish (the analysis said bottle)."），尺寸与俯仰也写明但不改分析。没有 owner 俯仰而手机传感器有读数时，`describeSensorTilt` 加一句"3D 用的是传感器俯仰，camera.pitch 改了也没用"。
- **提示词**：`buildTwinScenePrompt` 可选 `revision`。系统段在规则之后、DeepSeek 的 shape 段之前加 REVISING 段（先找出造成意见所述现象的字段、对照照片改掉并连带改该改的；其余同 id、同 kind/box/尺寸/关系不动；物体是什么/站在哪/略去什么以 owner 为准；**已折入的修正保留，除非意见说的正是某条修正造成的后果（大小、形状、位置）或它在意见所指处与照片明显矛盾——那就按意见改并说明**；已应用的旧意见保持；做不到就做最接近的或不改并说明；输出**完整** JSON + `changes`，只说 3D 里看得见的变化，"Never claim a change the 3D scene will not show"）与 "How the 3D scene is built from the analysis"：按 kind 画形状、不画的 kind（`TWIN_UNDRAWN_KINDS`，twinRenderBlocker 也改用它）、**有目录尺寸的 kind 及尺寸 `TWIN_CATALOGUE_SIZES`（镜像 NOMINAL_SIZES，单测直接读 `src/utils/twinSolver.ts` 源码核对 kind 集合）——这些 kind 的 sizeCm 除了选烧杯/锥形瓶/量筒的容量外不改 3D 大小，所以 3D 里大小不对通常是 kind 错**；离相机远近由尺寸与 bbox 高度（扁平物体用宽度）决定、左右看 bbox 中心、footprintY 是接触点；restingOn / held / heldOver / tiltDeg 的含义。用户文本在要求之后附：修正已折入的分析 JSON（数字留 3 位小数）、修正清单、传感器俯仰句、已应用的意见（含回答）、本次意见（三引号），结尾 "Revise the analysis: fix what the note says, keep the rest, and answer with the whole JSON again, changes included."。`TWIN_SCENE_REVISION_JSON_SCHEMA` = 原 schema + 必填 `changes`；`parseTwinScene` 多返回 `changes`（≤ 600，缺省 ''）；shapeInPrompt 时渲染修改版 schema。
- **改坏不覆盖**：修改结果被 `twinRenderBlocker` 挡住 → failed-precondition "The revised analysis could not be used, so the current twin is kept: …"（花费不退）。
- **写入用事务**，两个条件：`twinScene.scene` 的 JSON 仍是被修改的那份（期间被 Regenerate / 修改 / 清除 → aborted）；**折进去的修正**没被别处改过（`foldedCorrectionsKey`：kind / restingOn / hidden，不含 spec 与俯仰 → aborted "…corrections were changed elsewhere…send the note again"）。记录加 `revisions`（≤ 8 轮，含 modelKey）。`twinEdits` 只留**分析表达不了的**（`carryTwinCorrections`，按事务里读到的当前 twinEdits 算）：pitchDeg，以及修改后仍以同 id、且仍是当初选尺寸时那个 kind 的物体的 spec；其余删除。返回 `{ twinScene, twinEdits }`。日志 `twin-scene-revision`。

### 24.2 客户端

- **`twinRevise.tsx` 改为两种孪生共用**：props `experiment / revisions / kind / madeBy / canRevise / problem? / reviseTitle / revise(note, model, set, signal)`，真正发送与存储由宿主给。场景孪生（twinBuildingViewer）的 analyzeTwinBuilding 调用、进度文案、按钮提示原样搬到宿主的 `reviseProgram`，行为不变。
- `services/ai.ts` 新 `reviseTwinScene(expId, { note, model? }, signal)` → `{ twinScene, twinEdits }`（走 callTwinFunction，可停止，190 s 超时）；`twinRun.storeTwinRecord(expId, record, edits?)` 带 edits 时把保留下来的修正一起存回；`useTwinBuildRun` 多 `revising`；`types.ts` 的 `TwinBuildingRevision` 改名 `TwinRevision`，`TwinSceneRecord.revisions?`。
- **`twinPanel.tsx`（固定机位）设置栏最前面新增 About 段**（在 Camera tilt、Objects 之上；VIEW 仍在栏顶固定区）：出处行与要求折叠框从 Objects 段挪来（有修改轮次时 "Named and placed from frame N and revised twice from the owner's notes, most recently by X."），下面是修改对话；owner + staff 有输入框，读者只看线程。**被挡住（Not rendered）的记录**：对话出现在提示下方。之所以放最前而不是像场景孪生那样放栏尾：固定机位的物体列表很长，放尾部要滚过所有物体才找得到。
- **发送前先把待保存或正在保存的修正存完**（`saveEditsNow`：有防抖定时器就立即保存并等待，已在途的保存也等待；保存失败则不发、线程里显示原因）——服务端读的是文档上的修正。**修改进行中所有修正控件禁用**（俯仰滑杆、Kind / Size / Placed、Shown、Reset），Camera tilt 段首行显示 "Your corrections are paused while the AI revises the twin."：修改只对发出时的修正负责，期间再改会被落地的记录盖掉。
- Regenerate… 表单的警告：固定机位有修改轮次也写明，两样都有时 "This replaces the twin, the 2 revisions made to it and your corrections to it."。

### 24.3 验证

- functions：twinScene 单测 12 → 21（修正的读取 / 折叠 / 携带 / 键，传感器俯仰句，可修改记录的各种拒绝与沿用，修改提示词在首版之上追加且 shapeInPrompt 用修改版 schema，changes 的解析，目录尺寸与 NON_RENDERED_KINDS 对客户端源码的核对）；functions tsc 绿；全套 537/537；`tsc -b` 仍只有固有 8 个错；eslint / prettier 绿；vite build 绿。
- **headless Chrome 真实 TwinPanel**（本会话 scratchpad `harness/`，复用 09-11 的 rec harness：stubAiRec 加 `reviseTwinScene`、stubExperiments 记保存与调用的先后 `__seq`、stubStoreRec 加 `?frevised`；驱动 `driveRevise.mjs` A–J）**58 项全过、零页面报错**：About 在最前、Objects 不再有出处；模型列表 5 个、默认写出孪生的模型；回车发送 → reviseTwinScene 带 note / model / signal；进行中气泡 + Stop、所有修正禁用并提示、Regenerate 禁用；落地后线程、"revised once" 出处、对象变 Bottle、俯仰 30° set by you；Stop → Not applied，Edit and send again 恢复原文与模型；服务端拒绝原因 + Dismiss；待保存与在途的保存都先完成再调用（`save:start, save:done, revise`）；保存失败不调用；读者只看线程；blocked 时对话在提示下、落地后显示孪生；Regenerate 警告三种组合；walk-around 场景孪生回归（analyzeTwinBuilding 调用与文案不变）；1100 / 900 / 760 / 600 / 380 px 无横向滚动、模型名不截断、"AI model" 不折行。截图已目检。
- **真实模型干跑（只读，不写 Firestore；scratchpad `harness/reviseDry.mts`）**：线上 "3D twin - bottle"（`W3leWeMNuK2anFMjCSma`，帧 15，GPT-5.6 分析）。**线上记录显示 AI 原本就认成了 bottle，截图里的 "Petri dish" 是 twinEdits 里的手工修正**（obj1 → petri_dish；水流 obj3 → tripod + hidden）。①明确的意见（"petri dish 其实是正被倒水的绿瓶子，旁边的 other 不是物体"）：GPT-5.6（4.8 s，6.5k / 0.4k tokens）与 DeepSeek 都改回 bottle、水流保持删除；按客户端求解器重算，壶倾 61° 正对瓶口，"sits 13 cm higher" 警告消失。②含糊的意见（"3D 里壶巨大、碟子很小、离水落下的地方很远"）：**第一版提示词下 GPT-5.6 保留了 petri_dish 修正、去改 sizeCm（壶 22 → 16 cm）并声称"缩小了壶"——kettle / petri_dish 用目录尺寸，3D 毫无变化**；于是按 24.1 改了提示词（修正在意见针对其后果时可改、目录尺寸 kind 列表、不许声称看不见的改动），复测 GPT-5.6 与 DeepSeek 都认出"碟子小"是 petri_dish 修正造成的，改回 bottle 并如实描述 3D 效果。
- **未做**：经函数真实写入的端到端（会写线上）；Gemini / Grok / GPT-5.2 做修改；真机目检。

### 24.4 部署

- functions（`analyzeTwinScene`）与 hosting，**先 functions 后 hosting**（旧函数收到 feedback 会因缺 recordingIndex 报 invalid-argument——不会覆盖，但功能不可用）。规则不动（函数用 admin 写 twinEdits）。
- 工作区里 twinScene.ts / twinScene.test.ts / index.ts / twinModels.ts / scripts/evalTwinScene.ts 同时含有另一会话 "固定机位也开放 DeepSeek（shapeInPrompt）" 的未提交改动；本节的修改版 shape 渲染建立在它之上，提交时要一起或按 hunk 拆开。

### 24.5 About 挪到右栏最上方并折叠（2026-09-15，用户截图 About 段："把这部分挪到最上方，并用一个可以收起和展开的区域隐藏"）

- **位置**：About 从设置栏（Camera tilt 之上）挪到 `.twin-side-top` 的**第一个**：About（折叠）→ Regenerate… / Clear 工具栏 → VIEW。取字面的"最上方"（也与图片集 §19.5 "先对话、后工具栏"的顺序一致）；Regenerate… 打开的表单仍出现在工具栏原位，即 About 之下。设置栏现在从 Camera tilt 开始。
- **折叠**：原生 `<details className="twin-about">`（沿用 `.twin-request` / `.twin-mats` 的 disclosure 惯例，不用 antd Collapse），**默认收起**；`<summary>` 就是段标题行（`.twin-section-title` 样式 + 左侧 `RightOutlined` 小箭头，展开转 90°；section 的上下 padding 挪给 summary，整行可点，折叠态一行 37px），文字 "ABOUT · <模型> · N revisions"（读者也能看到修改轮数）。收起时内容仍挂载（`<details>` 只是不渲染），半写的意见不丢；展开状态按实验记在模块级 Map 里，切标签（面板重挂载）后保持，刷新页面回到收起。
- **收起时标题行右侧的状态**：修改进行中 → 转圈 "Revising…"（teal）；修改失败且 About 自那以后没展开过 → 红字 "Note not applied"，展开一次即消失（`seenFailure`）。停止只能在展开的线程里按，故不另设状态。
- **发送意见时自动展开**（`reviseAnalysis` 开头 `setAboutOpen(true)`）：尤其是从 "Not rendered" 提示下的对话发出时（那里不折叠），落地后画出孪生、About 展开在线程上；发出后再手动收起则尊重收起。
- **高度上限**：右栏顶部区不滚动（滚动的是下面的 tilt/物体列表），展开的 About 线程可能很长 → `.twin-about-body` 在桌面（≥769px）限高并自己滚动，展开时和新一轮到来时滚到底（最新一轮 + 输入框可见）。上限按分析器布局算（工作区高 `--analyzer-media-h` = 100vh − 109px）：左右并排 `clamp(160px, media-h − 450px, 520px)`（900 高屏 341、768 屏 209、1080 屏 520）；窄面板叠放时 3D 视图也要分这段高度，`clamp(120px, media-h − 620px, 320px)`（@container twin min-width 720 切换）。手机不限高（整页滚动）。焦点环同 `.twin-side-scroll` 的 4px padding + 负 margin。`.twin-about-section` 加 `margin-bottom: 6px`，让工具栏离 About 的细线与 VIEW 标题离工具栏一样远。
- **验证**：tsc -b 固有 8、eslint / prettier、vite build 绿。headless Chrome 真实面板（本会话 scratchpad `harness/driveRevise.mjs`，A–L）**98 项全过、零页面报错**：新增 K（默认收起且位于右栏第一个、在工具栏与 VIEW 之上；点开/再收起；收起时 "Revising…" 转圈、落地后无状态且标题行计 "1 revision"；切标签保持展开/收起；失败后收起时红字 "Note not applied"，展开后消失且线程里有原因）、L（按分析器真实几何：1440×900 / 1366×768 / 1920×1080，8 轮长线程，并排时上限 341/209/520px 并滚到底、输入框可见、面板不溢出、物体列表仍有 ≥188px；叠放时上限 171/120/320px、3D 视图 ≥156px 不被遮挡）；原 A–J 全部改为先展开 About 再操作。坑：`<details>` 收起时里面元素的 `getClientRects()` 仍非空，判可见要用 `checkVisibility()`；相邻 flex span 的 textContent 没有空格。截图（收起的右栏、收起时的两种状态、768/900 展开、380px 叠放）已目检。

## 25. 测温视图：每个面都是一片温度场，默认不再有灰与斜纹（2026-09-18 用户："现在只有很少的面有[照片投影]，可不可以把这种变色的热图扩展到和模拟到所有面上，不用灰色和条纹代替"，本地已实现、未提交、未部署）

- **默认填充改为 Everything**（`twinBuildingViewer.tsx` 的 `fill` 初值 `'all'`）：每个面（场景布景与地面在内）都从测量按 §18.6 的阶梯取到一个值，斜纹关闭、没有 no-data 灰；探针仍逐点说明该值来自实测还是推断。Nothing / Comparable 仍可手选。
- **面内变化**：一面一值的表值不再平涂。`TwinPaintEntry.vary`（K）= 该面主导读数 **p10–p90 跨度的一半**，上限 4 K（mixed 四边形不许把整面涂成彩虹）；`TwinPaintMessage.variation` = 各实测面 `vary` 的中位数，推断/填充的面用它，没有任何实测时为 0（平涂）。帧里 `aVar` 顶点属性 → 着色器 `tableT = vT + vVar · variationField(worldPos)`；`variationField` 是世界坐标整数格点上的三倍频值噪声（最粗格子 = 模型最大尺寸的 1/5，2.07×、4.19× 两个细倍频，增益 1.6 后夹到 ±1），相邻面连续。照片投影像素与表值的混合（`mix(tableT, projT, sure)`）和掠射淡入都以变化后的表值为底。
- **哈希不用 sin 技巧**：`latticeHash` 用整数乘异或（GLSL ES 3.00 的 uint；three r169 的 ShaderMaterial 一律 `#version 300 es`、`precision highp int`），JS 侧 `Math.imul` 复刻同一算式，探针读数与像素颜色一致到浮点精度。探针标签：无投影处首项换成该点温度，末尾加 " · face value 32.2 °C, varied here"；投影混合处的 face 项照旧。
- **诚实声明不变**：变化的幅度来自相机在该面读到的分布，而不是凭空纹理；但空间位置是合成的，探针仍标 measured/inferred，面板 Everything 的提示句写明 "each face is varied about its value by as much as the camera saw its reading vary"。
- **验证**：twinSceneThermal 58 单测（新增 vary/variation 一条：1.5 / 封顶 4 / 0.5、推断面无 vary、中位数 1.5、空表 0）、twinSimulation 21 测、`tsc -b` 仍只 8 条固有、eslint/prettier 绿、vite build 绿；帧内 module 脚本抽出后 `node --check` 通过、无反引号/`${`。**GLSL 未在真机编译、未可视化 QA**（本会话无 headless Chrome）。
- **没做**：天空仍是黑底；地面 fixture 仍是单色（MeshBasicMaterial）；面内变化不含物理梯度（屋顶朝天冷、檐下暖带），那是 §18 讨论里的"模拟残差"方案，待用户看过效果再定。

## 26. 测温视图：天空上色、照片经模型反投影取代描面、逐平面单应贴图（2026-09-18 用户："天空也应该加颜色。按照你推荐的 ID 图反投影和逐平面单应贴图执行"，本地已实现、未提交、未部署）

- **天空**：`useTwinProjection` 对每张已配准照片的原始帧算 `skyTemperature`（`twinProjection.ts`：与 `maskTemps` 同一条从顶行出发的洪泛 `skyMask`，取被判为天空且可读像素的中位数，少于 50 像素为 null；室内无 cut 为 null），跨照片取中位数作 `skyTempC`；paint 消息多一个 `sky`，帧在测温视图把 `scene.background` 设成该温度的调色板颜色（`paletteColorAt`），没有就仍是深底。
- **ID 图反投影取代 LLM 描面（客户端，服务端不动）**：帧新增 `projIdMaterial`（每像素 R+G=部件序号(16 位，`partMeta.id`)、B=法线的六面类别(0–5 同 `faceOf` 顺序；圆形网格的侧面记 6='all')、A=|cos(法线,视线)|；每个网格 `onBeforeRender=idBeforeRender` 设 partId/roundPart 并置 `uniformsNeedUpdate`，因为 overrideMaterial 是同一材质三只上传一次 uniform）。`sampleProjection()` 在每次 build 与 photos 消息后从每张照片的拟合相机把模型画到 120×160 目标、`readRenderTargetPixels`，再按 `collectSamples` 把每个热像像素映射到画面点 ((gx+0.5−dx)/120,(gy+0.5−dy)/160)（着色器查找的逆），取 ID：跳过天空/不可读、facing<GRAZE_HI、8 邻域 ID 不同（一像素腐蚀）、'unnamed' 布景；每个 (部件,面) ≥24 像素出 n/median/p10/p90/min/max，<64 标 smallSample，p90−p10>max(3,0.25×场景跨度) 标 mixed（同服务端规则）。结果 `{type:'sampled', buildId, surfaces}` 发回面板；面板 `validSampledSurface` 逐字段校验后存 `sampledState`（随 code），`thermalForTable` 用采样面**替换被采样照片的描面**（未采样的照片保留描面），再喂 `buildSurfaceTable`；`TwinThermalSurface.sampled`（仅客户端、不入库）让 `checkOrientation` 直接接受（面是几何事实），标签多一项 "read through the model"，状态行多 "N surfaces read through the model"。
- **逐平面单应**：新 util `src/utils/twinHomography.ts`（`faceHomographies(photo, camera, parts)`）：对每个非圆形部件的每个面，取该照片 inlier 地标里落在该面平面上的（|法向坐标−面偏移| ≤ max(2 cm, 2% 部件尺寸)），两侧去重，≥4 个且在面内和画面上都有展布（≥15% 面尺寸、≥2% 画高），Hartley 归一化 DLT（h33=1，8×8 正规方程高斯消元），地标重投影 RMS ≤1.5% 画高，且与针孔在面的四角相差 ≤20% 画高（否则地标不是这个面的/针孔不对）。面板在 `photosToSend` 里给每张照片附 `homographies[{part,face,axis,h[9]}]`（axis 0:(x,y) 前后、1:(z,y) 左右、2:(x,z) 顶底）。帧：`describeParts` 给非圆形部件每个面分配 `slotOf`（≤256 槽），`applyPaint` 写顶点属性 `aSlot`；`setHomographies` 烤 RGBA32F 的 hom 图集（宽 4×PROJ_MAX、高 256：每 (照片,槽) 三个纹素放 3×3、第四个 (has, axis, 0, 0)），占位纹理同尺寸全零（texelFetch 不越界）。测温着色器：像素查找点 `suv` 在有单应时 = H·(a,b,1)（v 向下→翻转），画面内测试和边缘渐隐用 suv，**深度测试仍用针孔 puv**（遮挡是模型自己的事）；探针 `projectedReading(point, normal, slot)` 用 `homographyPoint` 复刻。
- **验证**：新单测 `twinHomography.test.ts` 8 条（已知单应四点/六点精确恢复、<4 与共线拒绝、平面坐标、六地标拟合与针孔一致、模型宽 10 m 实为 12 m 时把模型角点落到真实角点像素、outlier/重复/共边/离面各拒、整体漂移 0.2 拒、错名/圆形跳过、共享棱的角点给两个面）、`skyTemperature` 1 条、表 sampled 1 条；twin 全套 161 测全过；`tsc -b` 只剩固有错（types.ts 522/724 的 ReportInputsDescriptor 是 HEAD 就有的）；eslint/prettier 绿；vite build 绿；帧 module 脚本 `node --check` 通过。**GLSL（texelFetch/uint 哈希/ID 材质）与 ID 读回未在真机跑、未可视化 QA。**
- **已知取舍/没做**：单应只对轴对齐盒子面（部件 min/max 定义的六个面），转过角度的盒子或斜屋顶面仍走针孔；采样统计仍用针孔渲染 ID（不用单应），只影响每面一值与 vary；天空颜色只在测温视图；照片外/被挡的面仍是表值+§25 的噪声变化。

### 26.1 用户真机反馈「天空还是没有颜色，房屋颜色也不准」（2026-09-18 晚，本地已实现、未提交、未部署）

- **天空为什么没上色**：`skyTemperature` 沿用了投影的「可读」定义（≥ −20 °C 才算表面），而晴天天空在 FLIR One 上读 −30 °C 以下，被整片当成不可读，天空像素凑不够 50 个 → null。现在天空取所有有值的像素（只排除 −100 哨兵与 NaN），单测加了 −35 °C 的一格。
- **房屋颜色为什么不像照片**：播放器显示的是 SDK 渲染的 data_N.png，颜色来自 FLIR 直方图均衡 AGC（每帧 min…max，plateau 0.008、线性 0.4、调色板 0.15–0.80）；孪生此前是把调色板**线性**拉到「实测面 min−1…max+1」（29–41 °C），同一温度两边颜色完全不同。现在：`useTwinProjection` 对每张已加载照片算 `agc {min,max,map}`（`plateauEqualization`，min/max 含天空、同 twinPanel 的取法）；`twinSceneThermal.photoMatchedPalette(base, map)` 把均衡曲线折进 256 色 LUT；面板新加「Colours」一行（Segmented：Photo 1 / Photo 2 / … / Scale），默认取第一张已配准且已加载的照片，选中照片时色标 = 该照片 min…max、调色板 = 折过的 LUT，帧的线性映射就重现了 SDK 的曲线（图例色条也随之变成照片的曲线）；拖 Scale 手柄自动切到 Scale（线性）。ScaleField 的 bounds 扩到包含照片范围。
- **验证**：twin 全套单测（含 `photoMatchedPalette` 1 条、天空 −35 °C）全过；tsc -b 仍 8 条固有；eslint/prettier/vite build 绿。仍未真机 QA。

### 26.2 用户第二轮真机反馈（2026-09-18 晚）：「左侧天空 −7.6 °C 跟结论对不上；右侧天空颜色和左侧有差别」

- **−7.6 °C 的解释**：那一点在电线/树冠附近，热像模糊把地物温度混进去；天空中央（画面右上近黑）远冷于此。天空的**中位数**才是原先背景取的值。但色标显示 −2…42 °C 说明当时「Colours」跟的不是照片 1（`matchable[0]` 是记录里第一张已配准照片，不一定是播放器正显示的那张），背景色是在另一张照片的曲线下算的。
- **改法**：① 颜色默认**跟随播放器正在显示的那张**（store `playerRecordingIndex`，图片集 = 照片号）、用户手选后固定；② 天空改成**渐变背景**：`skyReading` 返回 {median, cold=p10, warm=p90}，paint 消息 `sky: {tempC, coldC, warmC}`（帧兼容裸数字），帧用 1×64 的 DataTexture（SRGB）当 `scene.background`（three 把普通纹理铺满视口），顶部 = 天空最冷十分位的调色板色，向下 2/3 处过渡到最暖十分位，以下持平——对应照片里天顶近黑、地平线附近品红的渐变；天空取跟随照片自己的读数，没有时取各照片中位数。`scene.background` 从 `.set()` 改为赋值 `backdrop` Color 或天空纹理。
- **验证**：twin 全套 162 测过（skyReading 的 p10/p90 一条）、tsc 固有 8、eslint/prettier、vite build、帧 node --check 绿。未真机 QA。

### 26.3 用户第三轮（2026-09-18 晚）：「房屋颜色变化再明显些、天空更深、窗户更深或特殊处理」

- **面内变化更明显**：`FIELD_GAIN` 1.6→2.8、夹取 ±1.25（`FIELD_CLAMP`），使画出来的面的 p10–p90 ≈ 相机读到的 p10–p90（原先只有一半）；GLSL 与 JS 探针同步。
- **天空更深**：`skyBackground` 顶部向黑色压 65%（`SKY_ZENITH_DARKEN`），到 2/3 处渐回原色——对应 SDK 渲染里天顶近黑（低于色标底端调色板没有更冷的颜色可给）。
- **窗户**：表新增 `glassOffset`（玻璃读数中位数 − 干净侧向 envelope 读数中位数，K；无玻璃或无墙为 null）；帧 `kindAdjust`：kind=glass 的网格若其 (部件,面) 条目不是玻璃自己的读数（窗户嵌在墙部件里），温度加 glassOffset（null 时假定 −3 K，`GLASS_ASSUMED_K`）、噪声幅度乘 0.3（一片反射不是纹理）；探针标签加 " · glass: −3.0 K off the face, assumed (no glass was read) / as the photos read glass against walls"。条目本身是 apparent（玻璃自己描过/采过）的不动。
- **验证**：twin 全套 163 测（glassOffset 一条）、tsc 固有 8、eslint/prettier、vite build、帧 node --check 绿。未真机 QA。
- **26.3 补（用户："展示相机看到的画面，窗户应该更深"）**：玻璃兜底不再是固定 −3 K：照片读到玻璃 → 用实测偏移；否则有天空读数 → 按 ε=0.9 的辐射混合 `apparentGlassC`（T⁴ 加权：0.9×面温 + 0.1×天空表观温）反算表观温度再减面温（墙 32 °C、天空 −25 °C 约 −4.6 K）；两者都没有才 −3 K。探针标签分别写 "as the photos read glass against walls" / "reflecting the sky the photos read (emissivity 0.9)" / "assumed"。
- **26.3 再补（用户截图：窗户仍无区分）**：玻璃处理只对 kind=glass 的网格生效，而截图里的程序多半把窗户画成了墙色盒子/框/纯颜色。①服务端提示词（`functions/src/twinBuilding.ts` Glazing 一条）改为强制：每扇窗/玻璃门/窗带必须是自己的薄 glass 盒（0.05–0.1 m，凸出墙面几厘米），并说明原因——**需部署 functions 并 Regenerate 才生效**；②面板 Measured 段：建筑/室内且 built.parts 没有任何 glass kind 时提示 "No window is modelled as glass… tell the AI: model every window as its own thin glass box"。functions tsc 0、twinBuilding 58 测过、前端 tsc 固有 8、lint/build 绿。
- **26.3 三补（用户探针截图：窗户是 glass，标签 "apparent at this point · photo 1 + photo 2 + photo 3"）**：窗户没区分是因为三张照片按 facing³ 均匀加权混合，各自几像素的错位把小而暗的窗户均进了墙里。改为**最佳照片主导**：权重 = (boost·facing³·edge·graze)^4（`BLEND_SHARPNESS`），走单应投影的照片先乘 3（`HOM_BOOST`）；着色器与探针同步。`sure`（表值淡入）不变。未真机 QA。
- **26.3 四补（用户实测：照片里窗 28 °C，模型上同点投影读 32 °C）**：投影在窗上错位——窗是独立的 glass 部件，单应只对有地标的面（墙）生效，窗户部件没有自己的四个地标就退回针孔，墙对齐、窗错一扇窗的宽度，取到旁边墙面的像素。帧 `setHomographies` 加**宿主面继承** `hostFaceFor`：没有单应的 (部件,面) 若与另一个盒状部件的同名面共面（容差 max(0.4 m, 2% 宿主尺寸)，窗凸出墙 0.05–0.3 m 在内）且沿面的两轴落在宿主范围内（10% 余量），就写入宿主的单应（取面积最大的宿主）；着色器与探针共用同一 hom 图集/`proj.homs`。未真机 QA。

### 26.4 模型描边 + 右上角开关（2026-09-18 晚，用户："可以给模型边缘加上描边吗，并添加按钮在右上角可以开关描边"，本地已实现、未提交、未部署）

- 帧内实现，不走 postMessage：`edges` Group 是 fixture（adopt 不会收进 building，探针射线目标只有 building/ground），`buildEdges()` 在每次 build 的 `describeParts` 之后对 building 里每个有几何的网格做 `EdgesGeometry(geometry, 20°)` → `LineSegments`（InstancedMesh 按每个实例矩阵各放一份），`clearBuilding` 先 `clearEdges()`。线材质 `LineBasicMaterial`（内建材质自带 log depth），热成像视图白色 55%、真实视图深色 40%，`depthWrite:false`；每条线只在其来源网格 `drawn()` 时可见。**深度图集与 ID 图两个 pass 都先隐藏 edges**（否则线会以 override 材质写进图里）。
- 按钮 `#edges` 固定在画布右上角：透明底、线框立方体 SVG 图标，开=纯白、关=半透明白，悬停淡底；真实视图（浅底）下 body.light 切成深色图标。默认开，`aria-pressed`，点击切换 `edges.visible`。
- 验证：eslint/prettier、vite build、帧 node --check 绿。未真机 QA。

### 26.5 临时补丁：玻璃网格一律加深（2026-09-18 晚，用户："添加一个临时补丁，不要管算法了，只要是判断出是窗户，颜色就加深"）

- 帧 `WINDOW_PATCH_K = −1`（−6 → −4 → −2.5，最后**用户自己定为 −1，不要再改**）：测温着色器在算出最终温度 t 之后（投影像素、表值、噪声、玻璃偏移全部之后）对 `aGlass`=1 的顶点一律 `t += WINDOW_PATCH_K`；`applyPaint` 给 kind=glass 的网格写 `aGlass`。探针 `readSurface` 包一层，同样减同一个数并在标签末尾写 " · window patch −1 K"。只在测温视图生效，模拟视图不动。**这是临时补丁，投影能把窗户落到自己的像素上后应删除**（搜 WINDOW_PATCH_K）。
- 验证：eslint/prettier、vite build、帧 node --check 绿。未真机 QA。

### 26.6 测温面板去掉两行控件（2026-09-18 晚，用户："Infer 这里不需要了，所有场景都按照 everything 走"；"Look from 这个也不需要了"）

- **Infer**：Segmented 与 `FILLS` 表删除，`fill` 状态改为常量 `FILL = 'all'`（`FILL_HINT` 保留那句说明，接在 Measured 段首句后）；paint 消息固定 `measuredOnly: false, stripes: false`。`TwinFill` 类型与 `buildSurfaceTable` 的 fill 参数保留（util 的三种填充逻辑不动，只是前端不再暴露选择）。
- **Look from**：整行（Photo N / Overview 按钮）删除，`viewFromCamera` 与 antd `Space` 的 import 一并去掉；帧的 `view` / `overview` 消息处理仍在（`Colours` 行仍用 `registered`）。
- 验证：tsc 固有、eslint/prettier、vite build 绿。未真机 QA。

## 27. 描表面/地标模型解绑：构建表单第二个下拉「Reads the photos」（2026-09-21 用户："为什么模型要固定gpt-5.6？"→"解绑。我想看看其他模型的效果，测试一下"，本地已实现、未提交、未部署）

- **背景**：§18.6 A1 把第二阶段（每张热像照片两次调用：描表面四边形 + 2D–3D 地标 → `fitPhotoCamera`）钉在 GPT-5.6，理由是按像素定位只在它上面量过、相机拟合门槛（`CAMERA_INLIER_TOL` 3% 画高、`CAMERA_MAX_RMS` 2.5%、内点 ≥6 且 ≥45%、跨度 ≥10%、相机背后 ≤25%）是按它的答案定的，且只有 OpenAI 认 strict json_schema 与每图 `detail`。§26 之后相机拟合成功的照片走客户端 ID 图反投影，描面只做兜底，所以真正不可替代的是**地标那次调用**。用户要解绑试其他模型。
- **服务端**：`TWIN_SURFACE_MODEL_KEYS` = 与场景程序相同的五个（deepseek/gpt56/gpt52/gemini/grok），默认仍 `TWIN_SURFACE_MODEL_KEY = gpt56`；`analyzeTwinBuilding` 新可选字段 `surfaceModel`（`readTwinModelKey` 同样校验，不在列表 → invalid-argument）；`traceTwinSurfaces` 接 `modelKey`。两条提示词本来就把答案形状写在文里（"Answer with JSON only: { … }"），所以 DeepSeek 从 json_object 起步也能答；`callModelForTwinScene` 删掉 `extras` 参数、一律带 `provider.twinExtras`（DeepSeek 必须 `reasoning_effort: low`，原先描面传 `{}` 会让它默认 high 把预算全用来想）；token 上限改按厂商 `TWIN_TRACE_MAX_TOKENS`（openai 6000 / google 16000 / xai 16000 / deepseek 30000，取代原 SURFACE/LANDMARK 两个 6000）；记录新字段 `surfaceModelKey`（无热像照片也写）；修改（feedback）沿用记录的 `surfaceModelKey`（`RevisableTwin.surfaceModelKey`，旧记录 null → gpt56），除非随意见发来 `surfaceModel`（修改框 UI 没有这个选择）；`twin_surfaces` 日志加 `model`，"failed on every photo" 错误写明是哪个模型。
- **客户端**：`twinModels.ts` 引入 `TwinModelSlot = TwinBuildKind | 'surfaces'`（`TWIN_MODELS.surfaces`、`TWIN_DEFAULT_MODEL.surfaces = gpt56`、偏好键 `twin-model:surfaces`、草稿 `models.surfaces`），删 `TWIN_SURFACE_MODEL_LABEL`，加 `twinSurfaceModelOf` / `twinSurfaceModelLabel`（没有 key 的旧记录 → GPT-5.6）；`TwinBuildRequest.surfaceModel?`（只在 `traced && kind === 'program'` 时发）；`services/ai.ts` `TwinBuildOptions.surfaceModel`；构建表单的模型选择改为**标签在上的 `.twin-compose-field`**（"Writes the scene" / "Reads the photos"；只有一个时仍叫 "AI model"），`flex: 0 1 220px; min-width: 168px`，宽时并排、窄时上下，按钮行 `align-items: flex-end` 与下拉对齐（只作用于 `.twin-compose`，修改框 `.twin-revise` 不受影响）；原提示句改为 "The second model finds each thermal photo's surfaces and corners on the scene… GPT-5.6 is the one measured so far"；进度文案与 About 出处行（"…; the thermal photos traced onto it by X"，只在有照片到达描面模型时）写明第二个模型。
- **验证**：functions tsc 0 错、twinBuilding + twinCamera 86/86、app tsc -b 只剩 8 条固有、eslint/prettier、vite build 绿；headless Chrome 走真实面板（§20 的 harness 复制到本会话 scratchpad `harness/`：`driveSurface.mjs` 图片集面板 38 项、`driveRecSurface.mjs` 录像面板 Regenerate→Walk-around 内联表单 30 项，1100/600/380 三宽度：两字段并排或上下、下拉 ≥168px 不截断、无横向溢出、请求体 `{model, surfaceModel, instructions}`、偏好 `twin-model:surfaces`、草稿 `models.surfaces`、记录 `surfaceModelKey`、出处行）。**图片集面板现已没有 Regenerate（只有 Delete 后重建），内联表单只在录像面板。未真机 QA。部署先 functions 后 hosting**（旧函数忽略 `surfaceModel` 仍用 gpt56；旧前端不发该字段）。

### 27.1 本地对比（2026-09-21，用户："现在本地测试，不要部署函数"）

- **走 callable 的对比作废**（本会话 scratchpad `bake/bakeoff.mts`：模拟器 + 线上 Firestore，先备份 twinScene，跑完 `restore.mts` 已恢复）：5 次重建里 gpt52 / gemini 那两次 DeepSeek 写场景时 **`views: []`**（第一阶段 json_object 抖动），三张照片全是 "no judged viewpoint to anchor the camera"，跟描面模型无关；grok 那次整个构建 >300 s 被 undici 的 headers 超时掐断（服务端随即中止）。教训：**比描面模型必须固定第一阶段的程序与 views**。
- **受控对比**（`bake/landmarks.mts <expId> <record.json> [models] [repeats] [--surfaces]`：读同一份构建记录的 code/parts/views，从 Storage 取同样的 vis/data 图，直接调各家 API 走 `buildTwinLandmarkPrompt` → `parseTwinLandmarks` → `fitPhotoCamera`，不写任何东西；`functions/lib` 的 CJS 用 `createRequire` 引，Windows 绝对路径不能当 ESM specifier）。输入 = GPT-5.6 那次构建（DeepSeek 场景，21 部件，3 views），house 三张热像，每模型一次：

| 地标模型 | 注册 | photo 1 | photo 2 | photo 3 | 内点合计 | 最慢一次 | 备注 |
|---|---|---|---|---|---|---|---|
| gpt56 | 3/3 | 14/15 · 1.5% | 12/15 · 1.6% | 11/16 · 1.5% | 37/46 | 19 s | 基线，内点最多 |
| gpt52 | 3/3 | 11/16 · 1.9% | 8/12 · 1.8% | 7/14 · 1.7% | 26/42 | 8 s | 最快、最差；photo 2 重复地标 2 个被删 |
| gemini | 3/3 | 9/13 · 1.2% | 14/16 · 1.6% | 9/14 · 1.4% | 32/43 | 56 s | RMS 最低，慢 3× |
| grok | 3/3 | 13/16 · 1.4% | 8/16 · 1.9% | 11/15 · 1.6% | 32/47 | **242 s** | 一次调用挂 4 分钟（解释了上面 >300 s 的构建） |
| deepseek | 3/3 | 13/15 · 1.6% | 10/16 · 1.2% | 8/13 · 1.7% | 31/44 | 90 s | json_object；每次 15–22k 推理 token（low），`TWIN_TRACE_MAX_TOKENS.deepseek` 30000→40000 |

  五家都过了全部门槛（内点 ≥6 且 ≥45%、RMS ≤2.5%），house 是容易的题；单次运行，未量同模型的重复方差（`repeats` 参数可跑）。我的建议是默认仍 GPT-5.6；Gemini 是可信的替代（精度相当、慢）；GPT-5.2 快但内点少；Grok 有挂住的风险（受 perCallMs 保护，但会吃掉整个照片预算）；DeepSeek 可用。

### 27.2 最终形态：一个选择管两个阶段（2026-09-21，用户看到两个下拉后："把这两个合成一个选项，每次修改。不需要 5.6 后台默认"）

- **描面/地标模型 = 写场景的模型**，修改（feedback）时 = 意见发给的那个模型；`TWIN_SURFACE_MODEL_KEY` / `TWIN_SURFACE_MODEL_KEYS` / 请求字段 `surfaceModel` 全部删除，`traceTwinSurfaces({ modelKey })` 直接收 `modelKey`。**没有任何后台默认**——选 DeepSeek 就是 DeepSeek 描面（json_object、low 推理、每张照片两次约 15–22k 推理 token、60–90 s）。
- 记录仍写 `surfaceModelKey`（= modelKey）；旧记录没有这个键，是 GPT-5.6 描的。About 出处行只在描面模型 ≠ 场景模型时加 "; the thermal photos were traced onto it by GPT-5.6"（即只有旧记录会显示；`twinTracerOf`）。（§28.4 起出处行整行删除，`twinTracerOf` 也删了；`surfaceModelKey` 仍写入记录。）
- 客户端：表单回到 HEAD 的单个 "AI model" 下拉，删 `traced` prop、`TWIN_SURFACE_MODEL_LABEL` 与那句提示；§27 里的 `TwinModelSlot 'surfaces'`、`twin-model:surfaces`、草稿 `models.surfaces`、`.twin-compose-field` 样式与 `services/ai.ts` 的 `surfaceModel` 全部撤回（App.css / ai.ts / twinBuilding.ts / 测试都是 HEAD 原样）。`TWIN_TRACE_MAX_TOKENS` 与 `provider.twinExtras` 的改动保留（DeepSeek 描面全靠它）。
- 未真机 QA。部署先 functions 后 hosting（旧前端不受影响；旧函数仍钉 5.6）。

## 28. 修改对话升级：不生成树木、选中部件、便条带图片（2026-09-22 用户："在提示词中说明，目前不需要生成树木。并且生成的模型中应该可以选择某一部分，比如用户可以说把选中的部分改成什么样子，这样子比较好和ai交流，并且ai输入应该可以输入图片"，本地已实现、未提交、未部署）

- **不生成植被**：场景程序系统提示词的 Surroundings 条加 "No vegetation for now: leave out every tree, bush, hedge and planting even where the photos show them (the ground they stand on may stay)"；REVISING 段加 "The rule against vegetation stands too: a tree, bush or hedge the model still has goes"（修改时会把旧模型里的树删掉）。`TWIN_PART_KINDS` 的 'vegetation' 与模拟材料表不动。
- **选中部件（场景孪生、Realistic 视图）**：帧内新 fixture 组 `selection`（`selectionMaterial` = teal 半透明 MeshBasicMaterial + polygonOffset），`drawSelection()` 为选中部件的每个已绘网格放一份**共享几何**的副本（InstancedMesh 逐实例，同 buildEdges），深度/ID 两个 pass 与 edges 一样先隐藏，只在 realistic 模式可见（热图上会盖住温度）。点击（≤4 px、≤600 ms、左键、非探针态）→ `pick` → 部件名（ground/unnamed/天空清空；再点同一部件取消）→ `selectPart(name, announce)` → `{type:'selected', part}`；悬停在可选部件上 `canvas.pickable` 手形（动画循环里每次 pointer.moved 一次 pick）；底部提示 `updateHint()`；面板发 `{type:'select', part}` 同步；`clearBuilding` 先 `clearSelection()`（副本共享几何，须在 dispose 之前），有选中时回发 null。面板：`selectedPart` state（code 变了即清）、`selectPart` 回发帧、`TwinRevise` 新 props `parts`（built 的部件名，兜底记录的 parts，滤掉 unnamed）/`selectedPart`/`onSelectPart`：修改框顶部 "About [the whole twin ▾]" 可搜索下拉（allowClear）与帧点击双向同步。服务端：请求字段 `part` → `readRevisionPart(raw, previous.parts)`（不在声明部件里 → invalid-argument，先于限流），`describeRevision` 在便条前加 "The owner selected the part X in the viewer before writing the note: the note is about that part unless it plainly says otherwise"，历史条目带 "(about the part X)"；记录 `revisions[].part`。
- **便条带图片**：`TwinRevise` `pictures` + `captureView`：「Attach a picture」（文件选择、可多选）、粘贴进文本框、「Attach this view」（帧 `{type:'snapshot', id}` → 先 `renderer.render` 再 `toDataURL('image/jpeg', 0.85)` → `{type:'snapshot', id, dataUrl}`，面板 4 s 超时）；`src/utils/noteImages.ts` `readNoteImage`（createImageBitmap `imageOrientation:'from-image'` 修手机照片的 EXIF 方向，长边 ≤1280，白底铺平，JPEG 0.85）；最多 3 张（`NOTE_IMAGES_MAX` = 服务端 `TWIN_NOTE_IMAGES_MAX`），缩略图可删。请求 `images: [{data, mediaType}]`；服务端 `readNoteImages`（≤3、每张 ≤2 MB、`detectImageMediaType` 认字节、detail high）**接在照片之后**发给模型；用户文本在照片清单后加 "Then N more pictures: what the owner attached to their note…"，便条后加 "With the note the owner attached N pictures — after the photos above — … read them as part of the note, not as photos of the subject to model from or to give views for"；记录只存 `revisions[].images`（张数），图片不入库；线程 / 进行中 / 未应用条目显示 "about X · with N pictures"。**固定机位孪生的修改框不提供这两项**（twinPanel 没传这些 props；`revise` 多的第 5 参数它忽略）。
- **验证**：新 `functions/src/twinBuildingNote.test.ts` 6 条（readRevisionPart、readRevisions 保留 part/images、提示词三条）+ twinBuilding/twinCamera 共 92/92；帧 module 脚本抽出后 `node --check` 通过（**又踩一次帧内注释写反引号把 String.raw 提前结束的坑**，tsc 报 twinFrame.ts "',' expected"）；functions tsc、app tsc -b（固有 8 条）、eslint、prettier、vite build 绿；headless Chrome 走真实录像面板（本会话 scratchpad `harness/driveSelect.mjs`，`?record=orbit`）16 项全过：点模型选中 body → About 下拉跟着变、再点取消、下拉选 base → 帧画 teal 高亮 + 底部提示、Attach this view 得到 18 KB JPEG 缩略图、`DOM.setFileInputFiles` 附一张 PNG 转成 JPEG、删缩略图、发送后桩收到 `{part:'base', images:[{mediaType:'image/jpeg', data}]}`、进行中条目显示 "about base · with 1 picture"；截图目检过。**未真机 QA**（粘贴图片没测）。部署先 functions 后 hosting（旧函数忽略 part/images）。

### 28.1 单选为默认、可多选（2026-09-22 用户："选择部件的时候应该可以单选或者多选，不应该默认多选"）

- 帧：`selectedParts = []`（数组，按选中顺序）。**普通点击 = 只选这一个**（替换整个选择；它是唯一选中时再点取消；点地面/天空/unnamed 清空）；**Ctrl / Shift / Cmd + 点击 = 加入或移出**（点空处不变）。`selectParts(names, announce)` 去重、只认 partMeta 里有的、顺序相同就不重发；消息改为 `{type:'select', parts}` / `{type:'selected', parts}`（`select` 仍兼容旧的 `part` 字符串）。底部提示："click a part to select it · Ctrl+click for several…" / "body, base selected · Ctrl+click adds or removes · click elsewhere to clear…"。
- 面板：`selectedParts: string[]`；About 下拉改 antd `mode="multiple"`（`maxTagCount="responsive"`、allowClear、占位 "the whole twin"），列表里选一个就是一个标签，再选一个加一个——单选是自然默认，多选要主动加。lead 文案加 "(Ctrl+click for several)"。
- 服务端：请求字段 `parts: string[]`（单个字符串也收），`readRevisionParts` 逐个核对声明部件、去重、≤`TWIN_NOTE_PARTS_MAX`=24；提示词 "The owner selected the part X / the parts X, Y in the viewer…the note is about that part / those parts"，历史 "(about the part X)" / "(about the parts X, Y)"；`TwinBuildingRevisionInput.selectedParts`（`parts` 已是模型声明的部件表，撞名过一次 tsc 报 Duplicate identifier）；记录 `revisions[].parts: string[]`。线程显示 "about base, body"。
- 验证：twinBuildingNote.test.ts 改为 7 条（单/多/去重/上限/提示词措辞），headless `driveSelect.mjs` 加 Ctrl+click 加、Ctrl+click 移出、普通点击替换、列表逐个加，21 项全过。

### 28.3 选到面和网格，不再整部件（2026-09-22 用户："选中的时候应该分开细节，现在每次选中一面墙，周围的全都会一起选中，不能单独选择一面墙或者一个房顶。应该细化"）

- **选择单位 = 项 `{ part, mesh, face }`**：整部件（mesh null；服务端仍收，§28.4 起界面里已没有地方选它）、部件的某个网格（`describeParts` 给每个网格编号 `userData.meshIndex`）、盒状网格的某一面（`faceOf(法线)` 六面之一；圆形网格整只选）。点击取 `pick()` 命中的网格 + 法线面；同 key 再点移出；点天空/地面清空。高亮：`faceGeometry(geom, matrix, face)` 按世界法线筛出属于该面的三角形做一份局部坐标几何（`selectionGeoms` 随选择 dispose），整网格仍共享几何；InstancedMesh 逐实例。帧回发 `{type:'selected', items:[{part, mesh, face, kind, round, center, size, meshes, label}]}`（center/size 是网格世界包围盒，米，3 位小数；label 如 "walls #2 front face"，单网格部件不带 #）；面板发 `{type:'select', items:[{part, mesh, face}]}`。
- 面板 `selectedItems: TwinSelectionItem[]`（`utils/twinSelection.ts`：`validSelectionItem` 逐字段校验、`selectionKey`、`wholePartItem`）；About 多选列表的 value 是 key，选项 = 各部件整体 + 当前点选的面/网格（能看、能删、不能从列表点出）。
- 服务端 `readRevisionSelection(raw, parts)`：≤24 项，part 须声明，mesh 整数或 null，face 六面之一或 null，center/size 三个有限数（取 2 位小数），kind ≤24 字、round 布尔、label ≤120（缺省按 part/#mesh/face 拼）；提示词："The owner selected in the viewer, before writing the note: the box of part walls (8 × 3 × 0.3 m, centred at (0, 1.5, 4) m), its front (+z) face; the part porch as a whole. The note is about those unless it plainly says otherwise — find each in the program by its part, size and position, and change only what the note asks."（`describeSelection`，面附轴向 ±x/±y/±z）。记录 `revisions[].selection: string[]`（标签），历史行 "(about walls #2 front face)"。`TWIN_FACES` 含 all/upper/middle/lower，校验用单独的 `SIX_FACES`。
- 已知取舍：斜屋顶两坡的法线可能都归到 top → 点一坡两坡都亮；转过角度的盒子按世界法线分面。（About 列表已在 §28.4 删除。）

### 28.2 点什么选什么，不用修饰键（2026-09-22 用户："不需要按住多余的键多选，点击什么就选中什么"）

- 帧 pointerup：**点部件 = 加入选择；点已选中的部件 = 移出；点地面/天空/unnamed = 清空**。Ctrl/Shift 分支删除。提示改为 "click a part to select it…" / "body, base selected · click a part to add or remove it · click elsewhere to clear…"。lead 文案 "Click parts in the view, or pick them here…"。面板/服务端不变（仍是 `parts: string[]`）。headless `driveSelect.mjs` 改为：点 body → [body]；点 base → [body, base]；再点 base → [body]；点 base、点 body → [base]；点天空 → []；下拉逐个加；21 项全过。

### 28.4 删掉 About 下拉、出处句、lead 前半句；树木规则再收紧（2026-09-22 用户看到空的 "About [the whole twin ▾]"："不需要这些。生成的模型中不需要树木"→"我是说不需要 about 那部分的 UI 显示，不需要下拉框"；"这段话只保留 click 这句就可以，前面删掉"；"这段话也不需要了"（出处句））

- **修改框里不再显示任何选择 UI**：没有下拉，也没有标签行——我先换成了有选中时才出现的 "About [lid top face ×]" Tag 行，用户说明"不需要 about 那部分的 UI 显示"后一并删掉。选什么只在视图里点，帧的 teal 高亮 + 底部提示（"lid top face, body selected · click to add or remove · click elsewhere to clear"）就是全部反馈；便条发出后线程 meta 行仍写 "about lid top face, body"。`TwinRevise` 的 `parts`/`onSelect` prop、viewer 的 `selectItems`（帧的 `select` 消息保留，暂无人发）、`utils/twinSelection.ts` 的 `wholePartItem`/`selectionKey`、`.twin-revise-part` 样式删除；`selection` prop 存在即表示"这个 host 可点选"。服务端 `readRevisionSelection` 仍接受整部件（mesh/face 为 null），只是界面不再产生。
- **lead 只留一句 → 再挪进输入框**：先按"这段话只保留 click 这句"只留 "Click a wall, a roof or a part in the view to say what the note is about; click it again to unselect."，用户随后说"把这部分放到输入框中的提示词"——现在场景孪生的修改框上方没有任何文字，这句是 textarea 的 placeholder（`SELECT_HINT`）；"Something wrong with the twin? Tell the AI what to fix." / "Anything else wrong…" 的 lead 行只在不可点选的固定机位孪生里保留（那里没有 placeholder）。
- **出处句删除**："Written as a scene by DeepSeek V4.1 Flash from 3 photos; the thermal photos were traced onto it by OpenAI GPT-5.6 Luna; proportions are the AI's estimate." 整行不再显示；`tracerNote`/`twinTracerOf`/`revisionCount` 随之删除（`surfaceModelKey` 记录字段照写，只是没人读）。写程序的模型仍可从线程每轮的 "to X" 和构建表单看到。
- **构建进度句删除**（用户："这个也不需要"）："Sending 3 photos to DeepSeek V4.1 Flash — it is writing the subject as a 3D scene; the surfaces the camera measured are traced after that…" 与录像面板环绕构建的 "Sampling frames from the recording — …" 都不再显示：图片集面板的 `status` 去掉 `.twin-status-live` 行、任务不再 `set()`；录像面板环绕任务 `set('')`，状态行只在 `building.progress` 非空时渲染（固定机位的 "Checking camera motion… n/m frames" 是真实步骤，保留）。构建中的提示就是表单按钮转圈 + 旁边的 Stop。修改对话进行中那一轮的 "Sending your note … This takes a minute or two." 未动。
- **表单下 "Any language · readers see it with the twin" 删除**（用户："这句也不需要"）：`.twin-compose-hint` 只在要求接近 1000 字上限时显示计数（右对齐）。
- **修改进行中的长句与 "about …" 标签清单删除**（用户看到 "Sending your note about porchGlass #8 left face, … #11 right face, the program and the 3 photos to DeepSeek — it is rewriting the scene… This takes a minute or two."："这些细节也不要"）：场景孪生与固定机位的修改任务都 `set('')`，线程里进行中那一轮只剩转圈图标（Stop 后短暂 "Stopping…"）；线程每轮 meta 行不再列 "about lid top face, body"（`TwinRunRevision.selection` 删，记录里的 `revisions[].selection` 标签照存、提示词照发，只是不显示），保留 "with N pictures" 与 "to 模型"。
- **树木**：规则从 Surroundings 条里独立成一条并加重："No trees for now: leave out every tree, bush, hedge and standing plant even where the photos show them — never as a part, never as scenery. Ground cover stays flat: a lawn or a planted bed is a thin 'vegetation' slab on the ground, nothing rising from it."（保留 'vegetation' kind 给草坪——测温推断的 ground cover 权重靠它）；REVISING："The rule against trees stands too: a tree, bush or hedge the model still has goes (a flat lawn may stay)."。**顺手把提示词里自相矛盾的例子清掉**：主体举例 "a vehicle, a tree, a statue" 去掉 tree；`api.box` 的 "(a distant tree, a kerb)" → "(a kerb, a fence, a distant wall)"；subjectKind 的 "nature: a tree, rock, animal or landscape" → "a rock, an animal or a landscape"；描面提示 "A cylinder, a tree or any body" → "a column"。照片里的树仍列在遮挡物清单（那是真照片）。测试改为 /No trees for now/ + 断言例子里没有 tree。
- **已有的孪生里的树**：只有下一次修改（任何便条）或 Regenerate 才会去掉——函数未部署前线上仍按旧提示词生成。
- 验证：functions tsc 0、twin 测试 93/93、app tsc -b 固有 8 条、eslint/prettier 绿、vite build 绿；headless `driveSelect.mjs`（选择状态改从页面 window 上监听帧的 `selected` 消息读，因为框里已无处可读）全过：框里没有 About UI、lead 只有 click 一句、没有出处句；点 body → [body]，点 base 加、再点移出、点 lid 只选顶面、点天空清空；发送的 selection = lid 顶面 + body 网格 `{mesh:0, face:null, round:true}`，进行中条目 "You · about lid top face, body · with 1 picture"。

### 28.5 构建过程流式反馈（2026-09-22 用户："模型生成中的时候可不可以做成流式的？在等待过程中能有一些反馈或者输出给用户看的？"）

- **通道**：twin 的三个调用（analyzeTwinBuilding 构建/修改、analyzeTwinScene 固定机位/修改）本来就走 callable 的流式通道（只为了能取消，从不发 chunk），现在真的发：`TwinProgressChunk { phase?: 'photos'|'scene'|'surfaces'|'saving', modelKey?, photos?, done?, total?, text?, thought?, reset? }`（functions/src/index.ts 的 `TwinProgress` 类；src/services/ai.ts 同名镜像）。phase 标记立即发；模型增量攒 150 ms 一发（`TWIN_PROGRESS_FLUSH_MS`），场景程序几万 token 不至于一 token 一 chunk。客户端没开流式通道时 `sendChunk` 是空操作。
- **服务端**：`callModelForTwinScene` 多一个可选 `progress` 参数——有则请求 `stream: true`（provider.streamUsage 时加 `stream_options.include_usage`，否则流式回答没有 usage 记账），SSE 由新的 `readTwinCompletionStream` 读：`delta.content` → text，`delta.reasoning_content`（DeepSeek）→ thought，末尾 chunk 取 finish_reason/usage；读流中途断掉报 unavailable "answer was cut off"，Stop/超时的 abort 原样抛出。阶梯降档（json_schema→json_object→text）时若上一档已流出过内容，先发 `reset` 让客户端清屏。**只有人在等的那一次调用是流式的**（写场景、固定机位、修改）；描面/地标 4 路并行仍是非流式，只在每张照片的两次调用都回来后 `onTraced()` → `{phase:'surfaces', done, total}`（total = 真会调模型的照片数，无帧/比例不对/超时跳过的不算）。analyzeTwinBuilding 的顺序：photos → scene(modelKey, 图片数) → surfaces(0/n…n/n) → saving；analyzeTwinScene：scene(有热像 2 张否则 1 张) → saving。
- **客户端**：`callTwinFunction` 多一个 `onChunk`，`for await` 读完流再 `await data`（先给 data 挂空 catch，同 streamLabReport，否则取消时多一条 unhandled rejection）；`analyzeTwinScene`/`reviseTwinScene`/`analyzeTwinBuilding` 末尾多一个可选 `onChunk`。`twinRun.ts`：任务签名多第三个参数 `feed`（`TwinFeed`），`TwinRun.live: TwinLive | null`（phase/modelKey/photos/done/total/text/thought/phaseAt），每个 chunk 换一个新对象再 notify（服务端已攒批，客户端不再节流）；`set()` 的字符串进度仍在，固定机位的 "Checking camera motion… n/m frames" 就是它。
- **显示**：新组件 `twinLiveProgress.tsx`（`<TwinLiveProgress run=… icon? className?>`）：状态行按 phase——"Reading the pictures…" / "DeepSeek V4.1 Flash is writing the scene… 42 s · 12.4k characters so far"（还没有正文但有思考 → "· thinking"；秒数每秒 tick，从该 phase 开始算）/ "Tracing the surfaces the camera measured… 3/6 photos" / "Saving the twin…"；live 为空时退回 run.progress。状态行下 `.twin-live-box`（等宽 11 px、最高 160 px、pre-wrap、不横滚）实时显示模型写的东西：`src/utils/twinLive.ts` 的 `renderTwinLive(raw)` 把 JSON **前缀**渲染成可读行——顶层 `key: value`、`code` 原样多行（前后空行隔开、不写 "code:"）、数组一项一行（对象字段用 " · " 连）、更深一层的对象内联加括号、数字数组方括号；未闭合的字符串显示到哪算哪、写了一半的 key 不显示、被截断的转义丢掉不留反斜杠、非 JSON（text 档、围栏）原样显示。**单调性**：前一刻显示的永远是后一刻的前缀（值闭合时补的换行除外），所以盒子只会往后长不会抖。只渲染末尾 6k 字符；贴底时自动跟到底，用户往上翻就不打扰，翻回底部又跟。thought（reasoning）灰斜体在正文前。run 结束（成功/失败/Stop）盒子随 `building`/`pending` 一起消失。三处都用：图片集面板表单下/工具栏下（`.twin-start` 开始构建时滚到底，恢复了 §28.4 删掉的那个依赖）、录像面板 status（固定机位/环绕都走）、修改线程的进行中条目（替换原来的 spinner+progress 行，icon 传 spinner，className 沿用 `.twin-revise-reply.twin-revise-live`）。§28.4 删掉的那句静态进度句没有回来。
- **测试**：`src/utils/twinLive.test.ts` 8 条：整段渲染、全部前缀不抛且单调、截断字符串/半个 key、code 解码、截断转义、截断数组项、嵌套内联、非 JSON/围栏/空串。
- **未做 / 待验证**：功能未部署（functions 先于 hosting；未部署前线上 Function 不发 chunk，新前端只是看不到进度，不会坏）；未真机看 DeepSeek 在 `reasoning_effort: 'low'` 下是否真的流出 `reasoning_content`；Gemini 的 OpenAI 兼容层 `stream + response_format json_schema` 未实测（不行会 400 → 阶梯降到 json_object）；模拟器/真机还没看过一次完整构建的实际观感（chunk 频率、盒子滚动）。
- 验证（2026-09-22）：functions tsc 0；app `tsc -b` 只有固有的 8 条（无新增）；eslint 0 警告（`twinLiveStatus` 不导出，免得 react-refresh 抱怨）、prettier 绿；`node --import tsx --test functions/src/twin*.test.ts src/utils/twinLive.test.ts` 136/136；vite build 绿。本地未提交、未部署、未真机 QA。

### 28.6 构建中的卡片就是进度（2026-09-22 用户本地跑通 §28.5 后："重新规划一下这里的UI，我感觉流式输出的结果是不是应该往上放一些"）

- **病根**：§28.5 把状态行和实时盒子放在卡片**下面**；构建期间卡片里的 lead 一段、空的要求框、模型下拉全是禁用的死内容，却占着最显眼的位置，输出被挤到最底下（盒子还只有 160 px 高）。
- **改法**：`TwinBuildCompose` 新增可选 `progress: ReactNode`；`building && layout === 'card' && progress` 时整张卡片换成构建视图 `.twin-compose-card.twin-compose-building`：标题行 `.twin-compose-head`（标题 + 右侧 Stop）→ 有要求时一行斜体引号 `.twin-compose-asked`（clamp 2 行）→ `progress`（`<TwinLiveProgress run icon={<LoadingOutlined spin />} />`：13 px 状态行带转圈 + 盒子，卡片内盒子 `max-height: min(360px, 50vh)`）。表单（lead / label / textarea / 模型行 / 按钮行）不渲染；组件不卸载，`draft` state 还在，Stop 或失败后表单原样回来，结果 Alert 仍在卡片下面。inline 布局不走这条（构建中宿主本来就换成工具栏）。
- **宿主**：twinBuildingPanel 用 `liveProgress`（该文件已有 `live` = store 里的实验；第一版重名成了语法错误，进了 3ebe132（那个 HEAD 编译不过），改名修复随另一会话的 amend 一并进了 dev 1b0e023）；无记录时卡片显示进度，`.twin-start` 不再在构建开始时滚到底（只在 stop/失败时）；有记录时 `controls` 里工具栏下仍显示。twinPanel 同样：`progress={…}` 传给表单，`status` 里的 TwinLiveProgress 只在 `rawRecord` 时渲染（固定机位的 "Checking camera motion… n/m frames" 也进卡片）。
- **本地怎么测（用户问"本地能测试吗"）**：`yarn start`（web + functions 模拟器），`.env.local` 已有 `VITE_USE_FUNCTIONS_EMULATOR=true`，三个孪生 callable 打本机 5001，函数是本地 lib、密钥 `functions/.secret.local`，不用部署；Auth/Firestore 是线上的，构建会真替换 twinScene。本会话 scratchpad `streamSmoke.cjs <expId> [model] [stopAfterTextChunks]`（cwd functions，NODE_PATH=./node_modules）对模拟器打流并中途 abort：首个 chunk 1.3 s，DeepSeek low 推理先流 reasoning_content（50 s、33k 字符、每 165 ms 一条），然后正文；abort 后 twinScene.analyzedAt 未变。`harness/`（复制自 §28 会话的 compose harness，`stubAiCompose.ts` 按 ?tick/?piece/?thought/?fail 流 chunk，`driveLive.mjs` 24 项断言 + L1–L6 截图）。
- **验证（2026-09-22）**：app `tsc -b` 只有固有 8 条、eslint 0、prettier 绿、vite build 绿；harness `driveLive.mjs` 24/24（构建中：无表单/lead，引号要求，转圈状态行 + 盒子在卡片内，Stop 在标题行；盒子 358 px 高、贴底跟随、往上翻不打扰；Stop/失败后表单回来 + Alert；修改线程 pending 条目同样）。§28.5/§28.6 代码已在 dev 1b0e023；本节文档段落未提交；未 push 未部署（先 functions 后 hosting）；用户真机只看过 §28.5 的版本，§28.6 的卡片布局未真机看。

### 28.7 修改框上方显示选中了几个部件（2026-09-23 用户："3d模型中选中部件后，应该在右侧提示用户选中了几个部件"）

- **一行计数，不是清单**：`TwinRevise` 有选中项时在输入框上方显示 teal 一行 "2 parts selected in the view"（单数 "1 part selected in the view"；`.twin-revise-selected`，色 `--ifi-teal-dark` 与帧里的高亮同色系，`aria-live="polite"`）；没选中时什么都不显示，§28.4 的"框上方无文字"照旧。选了什么仍只在帧里看（高亮 + 底部提示），框里不列名字、不出标签——§28.4 用户删掉的那种 About 清单没有回来。
- **placeholder 跟着换**：有选中时 textarea 的占位从 "Click a wall, a roof or a part in the view…" 换成 "Say what to change about the selected parts."（`SELECTED_HINT`），免得已经点选了还在教怎么点。
- 固定机位孪生（`selection` prop 不传）不受影响。计数随 host 的 `selectedItems` 走：重建清空、点天空清空时这一行也随之消失。
- 验证：tsc -b 固有 8 条、eslint/prettier 绿、vite build 绿；未真机 QA。

## 29. 生成模型的几何兜底：帧内落地检查 + 屋顶造型器 + 提示词（2026-09-23 用户截图房子悬空、屋顶比楼身窄："生成的模型怎么能够避免这种情况的发生"→"按照你的推荐修改"，本地已实现、未提交、未部署）

- **病根**：模型一次性写自由 three.js；服务端 `checkSceneCode` 只查安全；帧跑完只报包围盒不做约束；屋顶只能用原生几何（BoxGeometry 以中心为原点、ExtrudeGeometry 从 z=0 挤出）要模型自己平移，错半高/半深是常事；没有自校正回路（§17.3 记着没做）。
- **帧内落地检查（新文件 `twinFrameGeometry.ts` 的 `TWIN_GEOMETRY_JS`，以 `__GEOMETRY_JS__` 拼进帧，同 `__SIM_DEFAULTS__`；`settleScene`）**：`build()` 里 adopt 之后、describeParts 之前跑（部件包围盒读的是落下后的位置）。每个网格取世界包围盒；容差 tol = clamp(1.2%·最大尺寸, 5 mm, 25 cm)；包围盒三轴间距都 ≤ tol 算接触；接触图的连通分量是一个「体」；地面 G = min(0, 场景最低点)（帧的地面 fixture 本来就贴在最低点下）；最低点 ≤ G+tol 的网格为种子，flood 出已落地集合。剩下的悬空体按最低点从低到高逐个处理（先低后高，屋顶才落到墙上而不是穿过墙落地）：默认向下落到 xz 重叠 (>0.5 tol) 的最近已落地网格顶面或地面；**若落差 > 该体自身高度**，再比较任意方向最近的已落地体（上/左右/前后），取位移最小者——窗玻璃悬在墙前 0.3 m 贴回墙、吊灯贴回天花板而不是掉到地上。位移在世界坐标做（`parent.worldToLocal`），逐网格一次；嵌套在网格下的网格包围盒跟着平移；落地后重算该体与外界的接触并 flood。>1500 网格不处理；抛异常则模型照原样。
- **屋顶覆盖报告（`roofCover`，只报不改——加宽屋顶是建模决定）**：每个有 roof 网格的部件取屋顶包围盒；「其下的墙」= wall/glass 网格、顶在屋顶底 −4 tol 以上、不高于屋顶顶、起点在屋顶底以下、xz 与屋顶重叠 > tol；墙并集超出屋顶盒 > 2 tol 的边报出（left=−x, front=+z）。
- **上报与呈现**：`built.settled = { moved: [{parts, kinds, meshes, dx, dy, dz}], uncovered: [{part, sides}] }`（没事就不带字段）。面板 `readSettled` 逐字段校验（帧的话不可信，程序能冒名 post）、`describeSettled` 成句，About 里 `twin-note-muted` 一行："The viewer moved what the program left floating onto what is under or beside it: mainBlock down 0.4 m; pane 0.32 m back." / "The roof of roof leaves the walls under it bare: 2 m on the left, 2 m on the right."——屏幕上的模型与程序差了这几步，用户该知道；写便条前也知道屋顶短了。error 时清掉。
- **造型器**（part builder 与 `api.*` 同名，后者做布景）：`p.gable(w,h,d,x,y,z,ridge,kind?,color?)`（ridge 'x'|'z'，默认 x）、`p.hip(w,h,d,x,y,z,…)`（长边为脊，方则金字塔）、`p.shed(w,h,d,x,y,z,high,…)`（high 'front'|'back'|'left'|'right'，默认 back）、`p.prism(points,h,x,y,z,…)`（[dx,dz] 轮廓，绕 x,z，向上挤 h；不成轮廓退化为 1×h×1 盒，程序照跑）。都是**底在 y、中心在 x,z**（同 box）。几何：`polyGeometry` 凸体按面列表扇形三角化、Newell 法线 + 质心判向、非索引平面着色（paint 的逐顶点属性照 box 一样挂，不需要 uv）；prism 用 ExtrudeGeometry + `rotateX(−π/2)`，shape 点取 (dx, −dz) 才能让平面 z 保持为 z。
- **提示词**（`buildTwinBuildingPrompt`，契约版本不动，旧程序照跑）：PARTS 条列出四个造型器并强调「every builder STANDS ON y」；api 条改「原生几何只用于 builder 做不了的（壶嘴/穹顶/倒角/弧墙）——屋顶和板绝不用，Box 中心原点/Extrude 从 z=0 会错半高半深」；新条「Everything STANDS ON something…先写层高常量 `const L0 = 0, L1 = 3…` 再给每个 builder 底高…屋顶盖住整个墙脚印并略出挑…帧会把悬空的落下去但不会加宽屋顶或补层」；新条「程序开头用注释从照片数层数、列每部件底/顶高，再照单建」；自检条加「每个部件是否站在东西上、每个屋顶是否盖住墙」。
- **验证（2026-09-23）**：新 `twinFrameGeometry.test.ts` 17 条（node --test + 真 three 包跑同一段 JS：不动已落地模型、屋顶落到墙上、截图案例整体落到基座（墙+窗+顶一个体）、先低后高不穿墙、窗贴回墙、吊灯贴回天花、旋转组内世界坐标位移 + 最低点为地、给定地面、覆盖报告、四种几何朝外/包围盒/脊向、prism 的 z 映射与非法轮廓、readSettled/describeSettled、字符串无反引号）；twinBuilding + twinBuildingNote 65/65；app `tsc -b` 固有 8 条、functions tsc 0、eslint 0、prettier 绿、vite build 绿；帧 module 脚本抽出后 `node --check` 通过（scratchpad `frameCheck.ts`）。**未真机跑帧**：浏览器里 p.gable 等经 place() 的实际观感、About 那一行、真实模型程序上落地检查有没有误伤（最担心：故意悬空的东西——吊物、挑出的阳台若与墙不接触——会被挪）。
- **没做**：推荐里的第 3 条自校正一轮（按 views 从各照片机位截图 + 本清单回喂模型修一次，走 §19/§28 的便条通道）。默认模型仍是 DeepSeek Flash，结构对不对主要还是看模型。
- 部署：functions（提示词）先于 hosting（帧 + 面板）。

## 30. 全面审查后的六项修复（2026-09-24，用户："按照你的推荐执行，一步一步来"；多代理审查 48 条、33 条双核实确认，本节做其中推荐的 F01/F14/F15/F02/F12/F19，外加同一循环里的 F06/F27/F38；已提交 dev 0335559，未部署）

### 30.1 落地后相机随模型走（F01，附 F06/F27）

- **病根**：§29 的 settleScene 在帧里把悬空体挪下去，但每张热像照片的相机是服务端按**未落地**程序算出的地标拟合的；投影、ID 采样、逐面单应全都偏移一个位移（0.4 m、10 m 处约 4.6% 画高，墙脚读到地面像素）。
- **帧**（`twinFrameGeometry.ts`）：settleScene 逐网格累计被带走的位移，返回 `shifts: [{part, dx, dy, dz}]`（整部件同一位移，毫米）与 `split: [part]`（部件的网格位移不一）；built 消息的 `settled` 带上两者；`readSettled` 逐字段校验。同一循环修 F06（网格挂在同体另一网格下时只随父移动一次，原先移两次）与 F27（matrixAutoUpdate=false 的网格先 decompose，原先旋转/缩放被抹掉）。
- **客户端**（新 `src/utils/twinSettleRegistration.ts`，直接复用服务端 `fitPhotoCamera`；`tsconfig.app.json` include 加 `functions/src/twinCamera.ts`、`twinBuilding.ts` 两个无依赖文件）：每张照片的地标按所属部件平移；split 部件的地标丢弃；若存储相机认可的地标全部同一位移 → 相机平移同样距离（精确）；否则以存储相机为先验重拟合；拟合被拒的照片不投影（其描面仍计入）。返回的地标按新相机重判 inlier，逐面单应用它们拟合。viewer `photosToSend` 用它；**photos 消息改为等 built 之后才发**（顺带消除 F38 的每次构建发两遍）。
- 测试：`twinFrameGeometry.test.ts` +4（嵌套、matrix-only、shifts/split、readSettled；在 HEAD 代码上这 4 条失败）、`twinSettleRegistration.test.ts` 4 条；headless Chrome：悬空房子 built 报 mainBlock −0.4、roof −0.9。

### 30.2 帧与面板走私有 MessagePort（F14）

- 帧只在 window 上发一次 `ready`（任何程序运行之前）；面板回 `{type:'connect'}` 附 MessageChannel 的 port2，之后双向消息全走端口。端口在模块作用域，`new Function` 跑的程序（全局作用域）拿不到；帧在程序运行前取好 `MessagePort.prototype.postMessage` 与 `Reflect.apply`，程序改原型也截不到端口。帧接到 connect 后移除 window 监听（程序在 window 上伪造 message 事件无效）。
- `bareCode` 认识正则字面量（`/'/` 不再开字符串把后面的代码藏起来；`)` 前是 if/while/for 头、`}` 之后都按正则）与函数体接受的 HTML 注释（`<!--`、行首 `-->`）；测试 +1（6 个绕过写法 + 3 个合法写法）。四处"程序能冒名发消息"的注释改掉。
- headless Chrome：程序 `const p = parent; p.postMessage(伪 sampled)`、伪 `ready`、伪 connect、改写 `MessagePort.prototype.postMessage` 与 `Reflect.apply`——伪消息只到 window（面板忽略），帧仍经端口正常发 built/snapshot，无任何 stolen。
- **残留**：程序与帧同一个 realm，改写 Array/Math 等内建仍可歪曲帧算出的统计；这与"程序本来就决定几何"同级，未做 SES 式冻结。

### 30.3 CSP 收紧 + 帧离开即拆（F15）

- CSP：`script-src` 只放行 `https://cdn.jsdelivr.net/npm/three@<版本>/`；新增 `worker-src/child-src/frame-src/object-src/form-action/base-uri 'none'`；`<meta name="referrer" content="no-referrer">`，iframe 也加 `referrerPolicy="no-referrer"`。
- 沙箱帧能导航自己（CSP 管不了）：面板按 iframe 元素计 load 次数，第二次 load 或第二次 `ready` = 程序让帧离开 → 关端口、卸载 iframe、红框 "The model's program tried to load another page in the 3D viewer, so the viewer was stopped."；程序换了（修改/重建）再挂一个新帧。
- headless Chrome：three 照常加载；jsdelivr Worker → SecurityError，blob Worker → worker-src 违规，`/gh/` 脚本、其他包的 import、嵌套 iframe 都报违规；导航后出现第二次 load。**残留**（30.8 复审后更正）：导航请求本身照发，URL 里能带程序编码进去的任何东西（包括它从 scene 读到的数据），泄露观看者 IP/UA；拆帧只是事后止损，不能阻止数据出去。回应 204 的导航不提交、不卸载，面板察觉不到，程序可以反复这样发请求，只有 checkSceneCode 拦得住明写的 location。

### 30.4 DeepSeek 看得到完整答案形状（F02）

- `describeJsonSchema` 从 twinScene.ts 移到 twinBuilding.ts（避免循环依赖，twinScene 再导出）；`buildTwinBuildingPrompt` 新 `shapeInPrompt`，为真时系统提示词末尾附完整 schema（views 的 photo/x…targetZ、confidence、修改时含 changes）；callable 传 `shapeInPrompt: !provider.jsonSchema`（只影响 DeepSeek）。
- 解析宽容：confidence 为 "0.8"/"80%"/85 读成数（原先静默 0 → 被 blocker 挡掉）；views 为按照片号键的对象、photo 为数字字符串也读；views 缺失/非列表记错。
- 阶段 1 没给某张照片 view 时**不再发地标调用**（原先每张白付 15–22k 推理 token，结果必被 "no judged viewpoint" 丢弃）。
- 测试 +5。未用付费模型实测。

### 30.5 天空洪泛只认像天空的区域（F12）

- `skyMask`：从顶边洪泛后若区域中位数 > `SKY_MAX_MEDIAN_C`（12 °C）→ 用 12 °C 作 cut 再洪泛一次（只留真冷的天空）；建筑类照片的洪泛本来就像天空，行为不变。
- `skyCut(thermal, subjectKind)`：apparatus / other 把 apparent（玻璃、金属）读数计入最小值（烧杯 22 °C 让 cut 停在 14 °C 而非热板的 52 °C）；建筑仍排除窗户。
- 新 `mergeSampledSurfaces`（twinSceneThermal.ts）：ID 采样按 (照片, 部件, 面) 替换描面，采不到的面保留描面读数（原先整张照片的描面一律丢掉）；圆形部件的面视为一个。
- 测试 +5（热板实验室、同场景阴天、实验台 cut、逐面合并、圆形部件）。

### 30.6 部件类型按声明、ID 采样剔除异质网格（F19）

- `describeParts`：部件 kinds 排序改为"声明的 kind（有网格用它时）在前，其余按表面积"，原先按网格数（一块墙 + 两块窗 → 被当成 glass）。kinds[0] 同时是 ID 采样的标签和表格的部件类。
- ID pass：网格 kind 与所属部件 kind 一个 apparent 一个不是（墙部件里的窗玻璃、塑料盒上的钢盖、玻璃部件里的窗框）→ B 通道 +8 标记，collectSamples 剔除这些像素（也参与一像素腐蚀的边界）。
- headless Chrome（墙 30 °C、两扇窗 10 °C、正对相机）：HEAD 帧 kinds [glass, wall]、采样 kind glass、p10 10、mixed；新帧 kinds [wall, glass]、kind wall、中位/p10/p90 全 30、不 mixed。

### 30.7 验证与部署

- twin 测试 334/334；functions tsc 0；根 `tsc -b` 仍是固有 8 条；eslint/prettier 绿；`vite build` 绿；headless Chrome 场景脚本在本会话 scratchpad `impl/harness/`（host2.html = 新握手的宿主，s1/s2/s3/s6 场景）。
- **未真机 QA**；部署先 functions（F02）后 hosting（其余）。旧前端 + 新函数、新前端 + 旧函数都兼容（settled 新字段可缺省；端口握手两端同在 hosting）。

### 30.8 对六项修复的复审与修正（2026-09-24，6 个方向审查 + 每条两位反驳者：22 条中 20 条确认、1 条存疑、1 条驳回；全部确认项已修）

- **端口仍可被拿到（最严重）**：程序在端口的 message 处理函数里同步运行，全局 `window.event` 就是那条消息，`event.currentTarget` 就是私有端口；程序还能改写 `MessageEvent.prototype.data` 的 getter，帧读 `m.data` 时把事件交给它。修：帧在任何程序运行前把 `window.event` 定义为不可配置的 undefined，预先取好 data getter、`addEventListener`、`start`，用 `Reflect.apply` 调；`event` 加进 checkSceneCode 的成员根与提示词的保留名。headless Chrome：`event` 为 undefined，被改写的 getter 从未被帧调用。
- **bareCode 新开的绕过**：`}`、`a++`、`of`、`o.for(1)` 之后的除号被当成正则，中间的 window/fetch 被藏起来。修：checkSceneCode 按两种读法各查一遍（认正则 / 全当除号），任一命中即拒；+1 测试。
- **拆帧**：改为**每个程序一个帧文档**（iframe `key={frameGen}`，程序变了就换新帧，旧程序的定时器和监听随旧文档消失），责任只归当前帧跑过的那个程序（`frameProgram`），不再误伤新程序；帧的 `pagehide` 经端口发 `leaving`，导航提交时（新页面加载前）即拆；拆帧时清掉 built/sampled/settled/warning/选择/探针/快照等待，"Attach this view" 隐藏；端口 effect 清理时换新帧（开发时 Fast Refresh 不再把查看器弄死）。Navigation API 在不透明源文档里不发事件，拦截不了，已删。
- **落地配准**：被 split 的部件不再丢掉地标——帧给出其**面积最大网格**的位移，客户端照此平移但标记"不确定"；只要有存储内点落在不确定部件上就不走平移捷径，改为重拟合（RANSAC 剔除挪错的地标）；重拟合被拒时，若存储相机仍认可 ≥6 个确定未动的地标就保留它（原先直接丢照片）。被拒照片在 Measured 段的 "Not registered —" 里写明原因、不计入 registered、不进 Colours；重拟合结果按输入缓存，不再每次快照都跑 RANSAC。+3 测试（审查者的两个复现场景 + 主导网格未动）。
- **解析**：置信度只有明写 % 或 20–100 才当百分比，1.2、8 这种超出 0..1 的按 1（原先 1.5 → 0.015 会把能用的孪生挡掉）；按键写的 views 认 "photo 1"/"photo_1"、从 0 起的键 +1、键不覆盖已有 photo、一个都没读到时如实记错；几处挂错位置的注释归位。
- **天空**：重洪泛只用于 apparatus/other（建筑的暖天空渐变不再被切一半、天空读数不再偏冷）；apparent 读数只有高于 12 °C（不可能是天空）才计入 cut（室外 other 场景里反光的金属不再把 cut 压到天空以下）；按面合并时，采到圆形部件的 'all' 即取代同一照片该部件的侧面描面，采到某面即取代同一照片对面的描面（镜像命名）。+3 测试。
- **部件类型**：`p.add()` 加入的、没有 kind 的网格继承部件 kind（原先是 'other'，在金属/玻璃部件里成了异质网格，主体不被采样）；adopt 兜底得来的 kind 标 `kindImplicit`，永不算异质；按名字解析的原生 THREE 组用 build 消息带来的声明 kind（viewer 现在发 `{name, kind}`）；kind 面积改用网格自身几何盒 × 世界缩放 × 实例数（不受旋转、实例分布影响）。headless Chrome：add 进来的钢锅主体正常采样（n 818，中位 70），按名字解析的窗组 kinds[0] = glass。
- 验证：twin 测试 340/340；functions tsc 0；根 tsc -b 固有 8；eslint 0；vite build 绿；headless Chrome 场景 s1/s2/s2b/s3/s6/s6b 全过。驳回的一条：shapeInPrompt 按厂商而非按阶梯档位决定——有 schema 的厂商降档时提示词无形状，两位核实者都认为影响可忽略。

## 31. 第一轮审查余下各项（2026-09-24，用户："提交并继续"；§30 的审查清单里剩下的确认项，按步做；已提交 dev，未部署，先 functions 后 hosting；F03 与 F04 见 §32）

### 31.1 帧不再静默停摆（F08 / F20）

- **渲染循环（F08）**：three 的动画循环要等回调正常返回才请求下一帧，程序自己的 `onAfterRender` 抛错、或 three 画不了的东西，会让画面永久冻结而工具栏照常响应。现在循环体包 try/catch：一次构建后的第一次失败按该构建的 buildId 报 `error`（"The model could not be drawn: …"），丢掉模型，循环继续。面板收到非上色类的 error 时连 built/sampled 一起清掉（模型已不在帧里）。
- **adopt 兜底**：程序拿走或换掉的材质（`m.material = null`、数组里的空位）换成该 kind 的默认材质；不是 BufferGeometry 的几何换成空几何。
- **构建后半段兜底**：describeParts / 描边 / 适配 / 投影 / 上色整段包 try：任何一步读不了程序的网格，就丢掉模型并报 "The model could not be set up in the viewer: …"——原先直接抛出、什么都不发，面板永远等不到 built（如 `mesh.geometry = null`）。
- **启动失败（F20）**：帧的 head 里、importmap 之前加一段经典脚本，捕获 error（capture 阶段，脚本元素的加载失败也听得到）和 unhandledrejection，第一次就在 window 上发 `{type:'failed', message}`。面板只在还没拿到端口时理会它（之后 window 上的消息可能出自程序）；另起 20 s 计时器，帧没说 ready 就显示"did not start within 20 seconds … cdn.jsdelivr.net may be slow or blocked"。两种情况都在画布上盖一层说明 + **Try again**（换新帧）；帧后来仍说了 ready（慢 CDN）就自动撤掉。
- headless Chrome：抛错的 onAfterRender → built 后收到 buildId 1 的 error，下一个程序照常被画（HEAD：无 error、循环冻结、第三个程序没有任何回应）；`material = null` + `geometry = null` 的程序正常 built 并被画出；three 地址 404 → `failed: three.js could not be loaded from cdn.jsdelivr.net`；WebGLRenderer 抛错 → `failed: Error creating WebGL context.`；正常启动无 failed。原 s1/s2/s2b/s3/s6/s6b 全过。

### 31.2 探针与单应贴图读对地方（F09 / F11）

- **模拟视图探针（F09）**：模拟着色器对背面把法向翻向观看者（`gl_FrontFacing`，模拟材质是 DoubleSide），探针原先直接用命中点法向——开放壳、车削容器内侧、从下方看的平面，颜色和读数能差几 K 到几十 K。现在 pick 额外记下命中三角形自身（按绕序、非平滑）的世界法向，读数时按相机在它哪一侧决定是否翻转法向；只动模拟分支，hit.face 和 ID 通道不变。用几何法向而不是插值法向判断，是为了在圆形网格的轮廓处与着色器一致。
- **凹陷面的单应（F11）**：单应按部件并集盒的那一侧平面拟合，只用面内两个坐标，着色器和探针却按 `part|face` 槽位套给该部件所有同名面——翼楼后退 3 m 的前脸被画上前方的像素。现在 applyPaint 只给落在该平面上的顶点（容差 = 该部件最大尺寸的 4 %，至少 2 cm——§31.7 从模型尺寸改为部件尺寸；实例网格抽样最多 64 个实例都要在）分配槽位，其余走针孔；再把角上槽位不一致的三角形整片改走针孔（插值出来的槽位会读到中间的槽，斜面、共点的两面都会这样），直到每个三角形只有一个槽位。探针直接读命中三角形角上的槽位（`hitSlot`），与着色器逐字一致。4 % 的依据：离面 d 的点误差约为 0.4·d/D（D≈1.5 倍模型尺寸），4 % 时在画面边缘约 1–2 个热像素；比墙凸出 0.3 m 的窗户仍在平面内。
- headless Chrome（s9-probe）：从下方看薄板读 −3.7 °C，与同高度盒子底面相同（HEAD：−7.4 °C，即朝上的读数）；翼楼前脸 (4, 2, 2) 读 49.9 °C = 针孔预期（HEAD：51.4 °C = 单应预期），主楼前脸两者都是 30.0 °C；主楼右侧面（在翼楼里面）与翼楼的前/后/左/顶面槽位为 −1。

### 31.3 孪生按用户的查看顺序编号照片（F05）

- **问题**：`analyzeTwinBuilding` 从不读 `exp.photoOrder`，按采集槽位取片、编号；条带、报告、便条里的 "photo 3" 却是查看顺序。槽位 7 被拖到最前后，孪生的 "Photo 7" 就是条带的 "Photo 1"；超过 8 张时的均匀抽样也是沿采集顺序；提示词里"仪器/室内的正面取自 photo 1"取错了照片。
- **服务端**：`normalizePhotoOrder` 得到查看顺序（槽位按位置排列）；`pickTwinPhotos(count, max, order)` 沿查看顺序取（≤8 张全取，否则沿条带均匀抽、保首尾），按查看顺序发给模型，所以 photo 1 就是条带上的第一张。图片名 `pictureLabel(序号, 位置)`：全部发送时序号 = 位置，就叫 "Photo N"；抽样时括号里写条带上的位置（"Photo 3 (photo 6 of the set)"），不再写存储号。描面/地标阶段同名。views 解析器多一个 `sentPlaces`：模型若按括号里的位置作答，映射回存储号并记一条修复说明（照片集不再接受存储号兜底，模型从没见过它）。修改沿用 `previous.photosSent` 的顺序（views 按位置对应），括号里的名字按当前顺序写。**记录契约不变**：photosSent、views、thermal 仍按存储号（槽位 + 1），不持久化位置。
- **客户端**：viewer 由 `experiment.photoOrder` 算出存储号 → 位置的映射（捕获顺序时为 null，一切照旧）：探针药丸的照片名、Measured 段 "Not registered —" 的照片名、测温表标签里的 "photo N"、Colours 选择条（按条带顺序排列、显示位置、值仍是存储号，默认仍跟播放器当前照片）都按位置显示。`photoLabel(photo, shot, places?)`、`registrationSummary(…, places?)`、`buildSurfaceTable(…, fill, places?)` 各加一个可选参数。
- 测试：服务端 +3（按顺序取片与抽样、按位置命名、按位置作答的 view 映射回存储号），客户端 +3（photoLabel、registrationSummary、表标签按位置命名）。

### 31.4 一批小修（F10 / F24 / F34 / F35 / F16 / F17 / F25）

- **聚合容差（F10）**：同一面多张照片是否"一致"的容差取场景中位数跨度的 15 %，原先把 apparent 读数也算进跨度——一个 150 °C 的反光金属能让相差 10 K 的两张墙面读数被当成一致而平均。现在跨度只取非 apparent 的中位数（全是 apparent 时才用全部），与服务端 `sceneSpanOf` 和帧的 mixed 阈值一致。+1 测试。
- **注释里的 api.part（F24）**：`extractPartsFromCode` 原先在原文上匹配、首次出现优先，注释 `// api.part('roof')` 会让真 roof 变成 kind other、注释里独有的名字成为幽灵部件。现在调用点必须在 bareCode 的任一读法里是代码（位置不变，参数仍从原文读）；`hasDynamicPartCalls` 同理。+1 测试。
- **百分位定义（F34）**：帧的 ID 采样统计改为与服务端 `readSurfaceStats` 逐字相同（round 秩、median = at(0.5)），不再是 floor 秩和双中值平均。
- **Regenerate 字样（F35）**：Measured 段的描面失败提示改用 "Delete it and build it again…"（Realistic 视图外加 "In the Realistic view, …"），与同文件其他提示一致；`onRealistic`/`regenerate` 提前定义（原位置在 thermalNote 之后，引用会落在暂时性死区）。twinBuildingPanel 的构建表单只在没有孪生时出现，`record ? 'Regenerate'` 与"替换 N 次修改"的警告是死分支，已删。
- **屋顶造型器约定进第二阶段（F16）**：新导出 `TWIN_BUILDER_SHAPES`，逐一说明 gable / hip / shed / prism 的顶点在哪（都站在 y 上、以 x,z 为中心；gable 屋脊在 y+h、默认沿 x；hip 屋脊沿长边、两端距中心 |w−d|/2；shed 的 high 边在 y+h、默认 back；prism 每个轮廓点是一条从 y 到 y+h 的竖边），以及斜面按倾向命名（< 45° 为 top，否则为朝向那一侧）。地标提示词与描面提示词都带上它。屋顶地标按错误约定放（屋脊在 h/2）时拟合不会拒绝而是吸收、相机偏 1–3 m。+2 测试。
- **finish_reason 与流内错误（F17）**：`callModelForTwinScene` 返回 finishReason 并记进 `ai_usage` 日志；答案读不出且是被截断（length）或被内容过滤时，错误信息写明原因（场景、程序、描面、地标四处）；流里的 `error` 事件直接以 unavailable 抛出并取消读取，不再静默变成短答案；最后一档（text）空答案也不再原样返回，而是和前几档一样记下并最终报"no usable answer: …各档原因"。
- **网络失败（F25）**：`fetch` 本身包 try：非中止的拒绝（DNS、TLS、连接重置）抛 unavailable "The vision model could not be reached (原因: cause)"，不再成为裸 internal 被客户端误写成"服务/模拟器/你的网络"。

### 31.5 运行状态：停止、关闭提示、忙点、便条草稿（F13 / F21 / F29 / F45）

- **保存阶段的停止（F13）**：服务端最后一次看停止信号是在写库之前，之后发 `saving` 并照写不误；客户端按了 Stop 就一律报"未保存"——文档里其实已是新孪生，store 仍是旧的，修改线程显示 Not applied，再发一次便条会被应用两次。现在：① 收到 `saving` 后所有 Stop 按钮置灰（"Saving — too late to stop"），`stopTwinRun` 也不再生效（`twinRunStoppable`）；② 真的停止了，就在约 1.2 s 与 3.7 s 两次读回存储的孪生（`readStoredTwin`），与运行开始时 store 里的比（程序孪生比程序、修改轮数、最新一轮的时间与模型——§31.7 起基线从服务器读、修改须找到带自己便条的新一轮；固定机位比排序键后的整条记录，去掉 analyzedAt——callable 与文档对它盖的时间不同），不同就放进 store，运行记为 `savedAfterStop`，面板显示 "The twin was already being saved when Stop reached the server, so the new one was kept."，修改线程则显示已应用的那一轮。
- **关闭过的提示（F21）**：dismiss 原是组件 state，切标签卸载面板后错误提示又回来。现在 `dismissed` 记在 run 上、`dismissTwinRun(expId)` 通知所有订阅者：构建工具条、修改线程的 Not applied 气泡、twinPanel 折叠 About 标题上的失败提示都从它派生。
- **标签忙点（F29）**：store 的 `twinRunningExpId` 只有一个槽，B 一开始 A 的忙点就消失、B 结束又被置空。删掉这个槽，workspacePanel 直接 `useTwinRun(experiment.id)`。
- **便条草稿（F45）**：切工作区标签会卸载修改面板，写了一半的便条、选的模型、附图都丢。现在文字和模型像构建表单那样存 `twin-note:${expId}`（刷新也在），附图（≤3 张 data URL）存模块级 Map；发出后清掉。视图里的选中不保留（它在帧里，切标签换新帧），已在注释里说明。

### 31.6 资源、上限与参数（F43 / F48 / F42 / F39 / F44 / F41）

- **程序留下的场景外观（F43）**：§30.3 之后每个程序一个帧文档，跨构建的几何/材质泄漏已不存在；剩下的是程序在 `scene` 上设的全局外观——`overrideMaterial` 会把每个网格（热视图的也一样）画成它、`fog` 按距离给温度上色、`environment` 凭空打光。adopt 之后一律清掉。另在 `pagehide` 时 `renderer.dispose()` + `forceContextLoss()`，帧文档随程序走时立刻释放 WebGL 上下文（修改线程每轮一个帧，浏览器同时只保留有限个上下文）。headless Chrome（s11-look）：新帧三者均为 null，HEAD 保留程序设的值。
- **自由文本上限（F48）**：第一阶段答案的 subject / reason 300、name 80、description 2000、部件 description 200 字符，超出截断并记一条修复说明（部件描述会回放进每次修改的提示词）；存储结构不变。+1 测试。
- **ID 采样的边距（F42）**：帧原先固定腐蚀 1 px，服务端描面按配准质量 2–5 px。现在 photos 消息带相机拟合的 RMS（画面高度的比例；落地重拟合的相机带新的），帧按 `clamp(ceil(rms·160), 1, 3)` 个热像素的边距只取面内部像素（逐环腐蚀的深度图，一次算好）；面太小留不下 SAMPLE_MIN 个像素就退回 1 px 并标 smallSample。headless Chrome（s10-erode）：画面比模型偏 3 px 时，1.5 m 的面板在 rms 0 下 p90 = 墙温 30、mixed；rms 0.02（3 px 边距）下 p10–p90 全是 10、不再 mixed（HEAD 三种 rms 都是 30 / mixed）。
- **FLIR 镜头先验（F39）**：服务端拟合相机时焦距先验从手机的 50° 改为 FLIR One 的 55°（`FLIR_VFOV_DEG`，竖向 160 px），经 `fitPhotoCamera` 的 `opts.fovV` 传入；`CAMERA_PRIOR_FOV_V` 默认值与 `FOCAL_SIGMA` 不动。三个固定件上焦距几乎不受地标约束、跟着先验走，50° 时相机前后偏 1.9–2.5 m；Look from 用同一 fovV，对齐本来不受影响，受影响的是记录里的位置与 fovV。
- **跟随照片的调色板（F44）**：混合调色板的照片集里，跟随照片 N 的颜色改用 `photoPalettes[N-1]`（播放器渲染它用的那个），没有才用集合的调色板；跟随 Scale 时照旧。+1 测试。
- **窄表面（F41）**：描面提示词的最小宽度改为按这张照片实际的腐蚀算：`surfaceMinShare(erodePx)` = 120 / (2·erode + 2)（配准好的 2 px → 1/20，照旧；未配准的 5 px → 1/10），原先一律 1/20，未配准照片上 6–11 px 宽的四边形腐蚀后一个像素不剩。描到但读不出的表面（no-pixels / too-few / excluded）除了日志，还记进照片行的 `unread`（≤24 条，可选字段）；Measured 段对没有投影回读的照片写一行 "Outlined but not read — photo 3: 2 surfaces too narrow once its edges are trimmed off"。+1 测试。

### 31.7 对 §31 的复审与修正（2026-09-24，5 个方向审查 + 每条 1–2 位反驳者：22 条中 14 条确认、8 条驳回；确认项全修）

- **空几何的部件**：adopt 把被拿走的几何换成空几何后，部件若只有这一个网格，包围盒是空的，上报 ±Infinity，面板的 isVec3 拒收并丢掉整份 built，面板又静默等待。现在空盒按第一个网格的位置报成一个点；面板丢弃畸形报告时改为显示错误，不再静默（丢弃整份的策略不变）。
- **伪造 'failed'**：程序先在 window 上发 'ready'（面板拆帧、端口置空）再发 'failed'，就能把自己的文字放进"无法启动"覆盖层，还挡住 20 s 计时器。现在只认从未拿到端口的 iframe 元素（WeakSet）发来的 'failed'，文字截到 300 字，拆帧时清掉。
- **固定点的背面**：模拟视图的固定读数改为在拾取时就定下看的是三角形哪一面（射线方向），不再在下次重标时随相机位置翻面；悬停每次移动都重新拾取，照旧跟随视图。
- **平面容差**：4 % 从整个模型尺寸改为该部件的最大尺寸——模型里有一片 60 m 的草坪时，原先容差变成 2.4 m，凹陷面又被套上单应（headless：同一房子加草坪后翼楼前脸读回单应值 51.4，修后 50.4 = 针孔值）。
- **settleSlots 性能**：改为一遍扫描 + 从被清掉的角出发的洪泛（索引网格才建顶点→三角形邻接表），线性时间；槽位按构建缓存（WeakMap 以 aSlot 属性为键），拖色标触发的每次 paint 不再重算。400×400 分段的院子：修前 1063/1318/999 ms，修后 623/374/372 ms（HEAD 561/423/372）。
- **修改时的照片顺序**：修改原按建模时的 photosSent 顺序发送，若之后调过条带顺序，便条里的 "photo 1" 就与提示词里的 photo 1 不是同一张。现在照片集的修改也按当前条带顺序发送（views 由 describeRevision 按新位置重编号，解析器映射回存储号），修改规则加一句"正面仍是程序里的 +z，不管现在哪张列在第一"；抽样超过 8 张、括号编号与位置不同时，若有用户的话（请求或便条），提示词说明用户用的是集合里的编号。+1 测试。
- **api.part 的吞并**：注释或字符串里未闭合的调用，其匹配会一直延伸到后面真正的调用里，跳过之后那个真调用也丢了（比 HEAD 更糟）。改为 exec 循环，跳过时从匹配起点的下一个字符继续。+1 测试（行注释、块注释、字符串三种）。
- **造型器的枢轴**：地标提示词原说"造型器网格被移动或旋转后同样按中心"，但 gable/hip/shed/prism 的网格原点在底面中心（y），box/cylinder 才在实体中心（y + h/2）。已在 TWIN_BUILDER_SHAPES 里写明，并把"每条檐口都在 y"限定为 gable 与 hip（shed 的高边在 y + h）。
- **停止中的状态**：按下 Stop 后到读回完成约 4 s，原先计时照走、输出框还开着、Stop 仍可点。现在 run 上记 `stopping`：Stop 置灰（提示 "Stopping…"），进度只显示 "Stopping…"，不计时、收起输出框；Function 什么都还没发时（固定机位仍在运动检测）直接算停止，不读回。
- **读回的基线**：原先拿本标签页 store 里的孪生当基线，store 落后于文档时（别的标签页刚改过）会把别人的孪生当成"停止后仍保存"，修改便条也随之消失。现在运行开始时就从服务器读一次基线；修改只有在出现一轮比基线最新一轮更晚、且便条相同（忽略空白差异）的记录时才算已保存，否则仍按停止处理（便条留在线程里，Not applied，可以重发），但文档变了就同步进 store。程序指纹加入最新一轮的时间（历史满 8 轮时条数不变）。
- **便条草稿**：发出后清掉选定的模型（原先会一直留在 localStorage 里，压过"做这个孪生的模型"）；删除孪生时连同附图一起清掉草稿（附图 Map 移到 twinModels）。
- **Outlined but not read**：热像帧加载期间不显示（此时还不知道哪些照片会被投影）。
- **过时注释**：删掉 twinProjection 里那句"按存储号命名"的旧注释。
- 被驳回的 8 条包括：adopt 在 try 之外（它只遍历、不读几何）；实例只抽样 64 个；测温视图探针按插值法向选面（非本次改动）；非流式空 content；Gemini 不报 usage 时 finishReason 进不了日志（logModelUsage 在 usage 为空时整条不记，属旧行为）；工作区条每个 chunk 重渲染等。
- 验证：twin 测试 397/397；functions tsc 0；根 tsc -b 固有 8；eslint 0；vite build 绿；headless 场景 s1/s2/s2b/s3/s6/s6b/s7/s8/s9/s10/s11 与审查者的 rv3-emptygeo / pinside / lawntol2 / settleperf 均通过。

### 31.8 §30.8 复审漏修的一条

- 回查 §30.8 那轮复审的全部 24 条结论（任务 wutja30oc）：23 条已在 0335559 处理，漏了一条低级别的——被帧回读过的照片，剩下的描面（帧没读到的面）仍进朝向检查，被计作 "faced away from the camera" / "mirrored to the face the camera could see"，和 "N surfaces read through the model" 并列出现在状态行里，看上去像那张照片的配准或描面失败了。现在 `checkOrientation` 照常检查、取舍这些描面，只是不把回读照片的计入 rejected / flipped / 未知部件数。+1 测试（同一描面在照片被回读时不计、未被回读时照计）。

## 32. 单独重描照片与照片集回归评估（F03 / F04，2026-09-24，用户："继续"；已提交 dev，未部署，先 functions 后 hosting）

### 32.1 Trace again：只重描失败的照片（F03）

- **问题**：第二阶段（每张热像照片的描面 + 地标两次调用）和第一阶段挤在同一个 360 s 里。8 张照片、DeepSeek 写程序超过 165 s 时，每次调用剩不到 90 s，DeepSeek 的描面装不下，照片被记成 "timed out" / "not traced"。原先唯一的补救是删掉重建：要再付一次写程序的钱，修改线程也丢了。修改更糟：每条便条都把全部照片的两次调用重跑一遍。
- **服务端**：`analyzeTwinBuilding` 加 `retrace: number[]`（存储号，只能是测温记录里有行的照片，最多 8 张；不能同时带 note / model / instructions / selection / images）。新的 `retraceTwinBuilding` 按记录里的 code / parts / views / subject 跑 `traceTwinSurfaces`，只跑点名的照片，独享整个 360 s（按 4 路并发分波）；模型用记录的 `surfaceModelKey`（没有时用 GPT-5.6，§27 之前的记录是它描的）。照片按当前条带顺序编号，与修改一致。
- **写入**：事务里重读 twinScene，`code` 和 `analyzedAt` 都没变才写（重建、修改、删除都会改掉其中一个），否则 aborted。合并进写入那一刻的 thermal（`mergeTwinThermal`）：被重描照片的行原位替换，旧表面换成新表面，其它照片不动；mixed 标记和色标范围按合并后的整体重算（`finishTwinThermal`，从 traceTwinSurfaces 尾部抽出，构建也用它）。只更新 `twinScene.thermal`，并记 `tracedAt`；模型、修改线程、analyzedAt 都不变。
- 与构建一样：占一个限流名额，读图阶段失败或被停止就退还；所有照片都因模型失败（不是超时）而失败时报错、不写。
- **修改时沿用测温**：修改后 code、parts（名称 / kind / 描述，按顺序）和 views（按照片排序后比较）都与原来相同，并且原图全部读到——比如只回答了问题，或模型没接受改动——就不再重描，直接保留原 thermal（日志 `twin_surfaces_kept`）。事务里取写入那一刻文档里的 thermal，期间另一个标签页重描过的照片不会被旧数据覆盖。便条按钮的说明改为 "…the measured temperatures are read again if the model changes"。
- **客户端**：`retraceablePhotos(thermal)` 挑出模型调用没带回结果的照片：描面调用失败、超时、没来得及调用或答案读不出（status model-failed）；或地标调用失败、读不出，因此没有相机。模型答了但答错的不算，比如拟合被拒、没有视点、找不到地标——同一个模型再问一遍同样的问题没有意义，那要靠便条或重建。
  - About 里描面失败的那句说明后面跟一个 **Trace again**，替代原来的"删掉重建（换个更快的模型）"。Measured 段 "Not registered — …" 后面，如有缺相机的可重描照片，也有同一个按钮。
  - 按钮只对当前契约版本、可修改的孪生出现（所有者 + staff），有运行时置灰。title 列出要重描的照片，按条带位置命名。
  - 运行走 `startTwinRun`（`retrace: true`），显示在 About 的工具条：Reading the pictures → Tracing … N/M photos → Saving。Stop 的 title 是 "Stop tracing — …"；在测温视图时提示 "Tracing the photos again — switch to Realistic to follow it or stop it."，停止和失败的提示也换成重描的说法。
  - 停止后读回：程序孪生的指纹加入 `thermal.tracedAt`，这样重描在保存时才被停止也能认出来（savedAfterStop）。
- 测试：服务端 +6（读取存储的测温与 subject、沿用判定、retrace 参数校验、finishTwinThermal、合并），客户端 +1（retraceablePhotos）。**未做端到端**：callable 路径需要模拟器和模型密钥，目前只有类型检查和纯函数测试覆盖。部署后先在一个有超时照片的孪生上按 Trace again 验证。

### 32.2 照片集孪生的回归评估（F04）

- **问题**：只有固定机位的评估脚本（evalTwinScene.ts）；§27.1 的对比赛脚本留在 scratchpad 里，而且走模拟器、会改写线上的 twinScene。提示词、token 预算和模型选择的改动都没法离线量化，§29 的落地检查也只有单元测试。
- **帧 API 抽出（twinFrameApi.ts）**：帧里 program 用的那段 API（LOOK / makeMaterial / 各 builder / partBuilder / api）原样移到 `TWIN_API_JS`，帧在原位置 `__API_JS__` 处拼回。抽出时帧页面逐字节不变：前后 TWIN_FRAME_HTML 的 sha256 相同，都是 b8055c02…，194 771 字节（§32.3 把 Path 补丁挪进 API 文本后，长度不变、段落位置变了）。
- **Node 里的运行器（twinProgramNode.ts，只给测试和脚本用，应用不引用）**：`runTwinProgram(code, declared, timeoutMs)` 用同一份 API 文本跑程序，按 adopt() 的规则给网格定 kind 和部件，再跑 settleScene / roofCover；返回部件、网格数、落地移动、裸露屋顶、程序错误或中途停止处，不需要渲染器。
  - 程序是模型写的，帧把它关在沙箱 iframe 里，这里也不直接在进程里跑：three（CommonJS 版）、API、程序和检查都在一个新的 node:vm 上下文里执行，不传入任何宿主对象（没有 require、process、fetch、定时器），全局对象没有原型可攀，10 s 超时（微任务也算在内）。结果以 JSON 字符串带出。试过经 `this.constructor.constructor` 取 process：拿到的是上下文自己的 Function，结果是 undefined。每次运行约 6 ms。
  - vm 不是安全边界，挡的是普通程序和死循环，不是专门写来逃逸的代码。程序若用到 document（如 canvas 纹理），这里会以 stoppedAt 报出，帧里则不会。
- **scripts/evalTwinBuilding.ts**：
  - 按 analyzeTwinBuilding 的方式取片（条带顺序、`pickTwinPhotos`、按位置命名、vis 优先），用同一套提示词、schema、梯级（json_schema → json_object → text）、token 上限和 twinExtras 调各家模型（不流式），然后解析、判 blocker、在 Node 里跑程序。
  - `--landmarks` 另对每张可描的热像照片调地标、按 FLIR 55° 先验拟合相机。
  - 每个答案按固定件格式存进运行目录；summary.md / summary.json 按"套 × 模型"列出：耗时、token、结束原因、修复条数、blocker、置信度、views、部件（未建出的）、网格（unnamed）、程序结果、落地（最大位移）、裸露屋顶（最大缺口）、相机（配准数 / 内点 / RMS）。
  - `--dry` 只读数据、写提示词；`--replay=<运行目录 | 答案文件 | 固定件目录>` 完全离线，用当前的解析器和帧 API 重新评一遍；`--keep` 把"解析成功、未被拦、程序无错"的答案复制进固定件目录。
  - 只读线上 Firestore / Storage（serviceAccount.json），不写库。
- **固定件（functions/src/__fixtures__/twinBuilding）**：§27.1 对比赛里 DeepSeek Flash 为房子照片集写的两份第一阶段答案（从当时存下的记录还原成解析器读的答案）；第二份还带着 DeepSeek 在同一程序上给三张照片的地标答案。
  - 测试：解析（只需要 reason 超长截断这一条修复——DeepSeek 的 reason 有 406 / 674 字，§31.6 的上限在真实答案上生效）；在 Node 里跑程序（51 / 62 个网格，声明的部件都建出来了，都报 roofMain 左侧裸露 1.27 / 1.03 m）；按 55° 先验拟合三张照片的相机（14/15、10/16、8/13 内点，全部配准）。
  - 运行器另有 6 条测试：builder 与 kind；落地与裸露屋顶；按声明名认领裸 THREE 对象；各种失败的说法；进程隔离、超时与每次新上下文；API 名字不可达与 Path 挤出。
  - 以后 `--keep` 进来的答案只需满足"能解析、未被拦、程序无错"。
- 验证：`--replay` 在两份固定件上离线跑通（加上地标答案后相机列为 3/3）；`--dry --limit=2` 只读取到最新两套房子照片集（条带顺序 3、1、2，提示词按位置命名）。**没有真正调用模型**：那要花钱，未跑。例：`npx tsx scripts/evalTwinBuilding.ts --ids=<实验id> --models=deepseek,gpt56 --landmarks`。

### 32.3 对 §32 的复审与修正（2026-09-24，两路审查：F03 4 条、F04 6 条，全部核实后修掉）

- **重描不丢好的那一半（F03）**：一张照片的两次调用可能这次一个成、一个败。`mergeTwinThermal` 原先整行替换：描面好、地标超时的照片重描后，地标成了而描面超时，原有的表面就被删了；反过来也会丢掉已有的相机。现在两半分开合并：这次描面失败而原来读到过，保留原来的状态和表面；这次没有相机而原来有，保留原来的相机、地标和说明。+1 测试。
- **沿用测温时记对描面模型（F03）**：修改沿用原 thermal 时，记录的 `surfaceModelKey` 原先写成便条交给的模型；之后 Trace again 会换一个模型重描同一份记录。现在沿用时带上原来的 `surfaceModelKey`（原来没有就不写，即 GPT-5.6）。
- **沿用测温的并发守卫（F03）**：沿用测温的修改在事务里除了比对 code，还要求 analyzedAt 没变。期间另一个修改（同一 code、不同 views）已保存，就拒绝写入，免得把别人按新 views 描的测温配上自己的旧 views；重描不改 analyzedAt，照常合并。
- **读不到帧的照片不参与重描（F03）**：点名的照片若此刻热像帧读不出来，原先会以 no-frame 行替换原来的 model-failed 行，名额也不退，照片还从可重描列表里消失。现在只把帧读得出、形状对的照片交给模型；一张都没有就退名额并拒绝。
- **Path 补丁进 API 文本（F04）**：帧给 THREE.Path 补的 `extractPoints`（模型常把 Path 交给 ExtrudeGeometry）原在帧模块里，Node 运行器没有，会把帧里能建的程序判成失败。现在它是 `TWIN_API_JS` 的第一段，两边共用。帧页面因此不再逐字节相同：长度仍是 194 771，只是这段挪了位置。headless Chrome 新场景 s12-path（Path 挤出建成）以及 s1 / s2 / s6 / s7 都通过。
- **API 名字不再是全局（F04）**：Node 里 API 原先以经典脚本运行，`num` / `dim` / `place` / `settleScene` 都是程序可改的全局，帧里它们在模块作用域。现在 three 在自己的函数里、导出对象冻结（同帧的模块命名空间），API、程序、检查都包在一个严格模式函数里；宿主放在全局上的三样东西进函数后立刻删掉；结果用程序运行前取下的 `JSON.stringify` 生成，宿主只接受字符串；读错误信息不调用程序的代码（不走 getter / toString）。+1 测试。
- **程序留下被拒的 promise（F04）**：这种程序原会被 `--keep` 收进固定件，然后让测试文件整体失败。评估脚本现在一次只跑一个程序，跑完等一轮事件循环，数 `unhandledRejection`：有就标 "left a promise rejected"，不收。
- **固定件命名（F04）**：`--keep` 原按"套-模型"命名，会覆盖同套同模型的旧固定件，从固定件目录重放再 keep 还会复制一层。现在命名为 `<套>-<模型>-<日期>-<文本哈希6位>.json`，用 wx 写（已存在就提示"already kept"），来源已在固定件目录里的跳过；结果行与答案一一对应，不再按"套 + 模型"查找。
- **与 callable 对齐（F04）**：`--landmarks` 只对热像帧能完整解码、形状对的照片调用，答案没有部件时不调（callable 此时跳过第二阶段）；`--instructions` 走 `readBuildInstructions`（整理空白、限长）。
- 仍然成立的局限：vm 与进程共用堆，无限分配的程序能让评估进程内存耗尽（审查里 3000×3000 段的球体）。要彻底隔离得用带 resourceLimits 的 worker，暂不做。
