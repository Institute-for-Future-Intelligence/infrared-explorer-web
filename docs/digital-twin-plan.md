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

- 触发：owner 在 3D 标签页点 Generate。v1 沿用 generateLabReport 的 staff 门（内部账号），稳定后再放开。**门只管生成不管查看**：twinScene 随实验文档持久化在云端，凡能读到文档的人（分享出去的 public / unlisted 链接的访客，含未登录）都看到「3D Twin」标签页——有孪生就显示 owner 留下的孪生（含 twinEdits 修正），没有就显示「owner 尚未生成」——只是没有 Build / Regenerate / Clear 按钮（2026-09-09 定，2026-09-10 改为标签页不再以孪生存在为条件）。
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
- D7 探针：统一 `readSurface(hit) → { tempC|null, kind, part, face, status, label }`；钉记 `part/kind/face`，模式或表变化时重打标签；`probeActive = probeOn && mode !== 'realistic'`；标签格式：实测 `21.3 °C · wall · measured · photo 3 · n=412 · p10–p90 19.8–23.9`，推断 `21.3 °C · wall · inferred from 2 wall faces facing the same way (weak)`，表观 `14.2 °C · glass · apparent (reflects sky) · photo 2`，无数据 `— · roof · no measurement`。`label` 由面板算好随 entries 下发，帧直接显示。
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
- **写入有条件**：修改用事务写，事务里比较当前 `twinScene.code` 是否仍是被修改的那份；期间被别处 Regenerate/修改/清除 → aborted "The 3D twin changed while this revision was being made…"，不写。记录多一个 `revisions: [{feedback, changes, at(ms)}]`（最近 8 轮）；**不带 feedback 的 Regenerate 生成全新模型，没有 revisions**。
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

- **两个孪生函数都多两个可选字段** `model`（模型 key）与 `instructions`（owner 的要求）。`readTwinModelKey(raw, offered, fallback)`：缺省 → 默认；不在该类孪生的列表里 → invalid-argument "That model is not offered for this kind of 3D twin."（**拒绝而不是悄悄换成默认**；在占限流名额之前检查）。
  - 场景程序（图片集 / 录像环绕，`analyzeTwinBuilding`）：`TWIN_PROGRAM_MODEL_KEYS` = deepseek（V4.1 Flash，默认，即原来的钉）、gpt56、gpt52、gemini、grok——应用接入的都能看图（另一会话同日把 DeepSeek 两个 key 合并成 `deepseek` → `deepseek-flash` 并标为 vision）；不提供 Claude（§0）。
  - 固定机位（`analyzeTwinScene`）：`TWIN_FIXED_MODEL_KEYS` = gpt56（默认）、gpt52、gemini、grok。**不含 DeepSeek**：它拒绝 json_schema，而固定机位提示词把字段完全交给 schema，降到 json_object 时模型不知道要哪些字段。
  - 第二阶段描表面/地标仍钉 GPT-5.6（`TWIN_SURFACE_MODEL_KEY`），与第一阶段选谁无关——表单上写明。
- **要求**：`readBuildInstructions`（与修改意见共用 `normalizeOwnerText`）：缺省/空白 → null（不是错误，这是常态）；非字符串/超 `TWIN_INSTRUCTIONS_MAX`=1000 → invalid-argument（拒绝不截断）。场景程序提示词：系统段在 "Answer with JSON only" 前加 **THE OWNER'S REQUEST** 段（照片允许处照做；主体是什么、部件关系以 owner 为准，未提及的比例仍以照片为准；不能改帧的 API、单位、parts 规则与答案格式；做不到的做最接近的），用户文本在标题/描述之后、修改块之前以三引号引用，结尾改为 "Write the model, following the owner's request."。固定机位提示词在用户文本里三引号引用并限定"用它命名物体、判断热角色、决定略去什么；不因要求里提到就报告照片里没有的物体"。
- **修改（§19）也可以选模型**（用户同日看到修改框后要求"这里也应该可以选择不同模型"）：随意见发来的 `model` 同样按 `TWIN_PROGRAM_MODEL_KEYS` 校验；不发则用写出当前程序的模型（`twinModelOfRecord`：记录的 `modelKey` 仍在列表中则用它，否则按厂商 id 反查，再否则默认）。**要求不能随意见更改**（随意见发来的 instructions 忽略），沿用孪生当初的要求（`RevisableTwin.instructions`，REVISING 段加 "The request the model was first built to still stands."）并带进新记录。每轮修改记下 `modelKey`（`TwinBuildingRevision.modelKey`，`readRevisions` 保留），线程里显示 "You · 时间 · to GPT-5.2"；记录的 `model/modelKey` 是写出**当前**程序的模型（修改后即最后一轮的模型），出处行有修改时改为 "Written as a scene from 5 photos and revised twice from the owner's notes, most recently by X"。修改提示词改为不假定"你写的"（"has already been written — its program is in the message, perhaps by another modeller"、"Where each camera was judged to stand"、"— answered:"），换模型修改时说法仍对。
- **记录**多 `modelKey` 与 `instructions`（有才写，Firestore 拒 undefined）；`model` 仍是厂商 id。`logModelUsage` 多 `instructions: bool`。
- **token 上限按厂商**（后台调研，官方文档）：场景程序 `TWIN_BUILDING_MAX_TOKENS` openai 40000（OpenAI 建议给推理+输出至少留 25k）、deepseek 60000、google 60000（Gemini 2.5 Pro 思考计入上限、默认最多想 32k、上限 65,536）、xai 60000（xAI 没说 `max_tokens` 是否含推理；上限 128k）；固定机位 `TWIN_SCENE_MAX_TOKENS` 一律 16000（原 6000 对 Gemini 可能想完就没答案；上限不用不花钱）。`callModelForTwinScene` 的 `format` 改为必填（原默认值只剩死代码）。
- **未实测**：Gemini 2.5 Pro、Grok 4.5、GPT-5.2 写场景程序，以及它们做固定机位分析，都没用真实数据跑过（会写线上 Firestore 并计费）；GPT-5.6 写场景程序在 §17 用过、DeepSeek 是现行默认。Gemini 默认动态思考、Grok 默认 high 推理，可能慢；若超时再考虑给它们各自的 `twinExtras`。

### 20.2 客户端

- **`twin/twinModels.ts`（新）**：两类孪生的模型列表（`program` / `fixed`）、标签（复用 `MODEL_LABELS`）、默认、`twinModelOf(record, kind)`（记录的 key，或旧记录按厂商 id `deepseek-flash`/`gpt-5.6-luna` 反查）、`twinModelLabel`；每类孪生记住上次选的模型（localStorage `twin-model:<kind>`，作为下一个实验的起点）；**每个实验一份表单草稿** `twin-draft:<expId>` = `{ text?, models?: {program?, fixed?}, mode? }`（`text` 缺省=没动过、`''`=有意清空；`mode` 是录像的构建方式）：切标签、刷新、构建失败后表单原样回来；构建成功或 Cancel 清除（成功时按开始时的快照比对，别的标签页新写的草稿不误删）；存储访问全部 try/catch、逐字段校验。
- **`twin/twinBuildCompose.tsx`（新）构建表单**：标签 "Tell the AI what you want · optional"、**输入框里不放 placeholder 例句、框下也不写按键提示**（用户 2026-09-11：先"输入框内不需要提示词"删掉例句，再"不需要 enter to send 这部分文字"删掉按键提示；两个框都只在接近 1000 字上限时显示计数，修改框另在有构建占用时显示 "Wait for the build to finish"；回车发送/构建、Shift+回车换行、有警告时回车只换行的行为不变，只是不再写出来）、1000 字上限与接近上限的计数、"AI model" 下拉、Build / Stop / Cancel、第二阶段由 GPT-5.6 描表面的一行说明（场景程序且有热像时）、替换什么的警告行。**回车构建（仅当已写了内容）、Shift+回车换行、输入法组字不触发**（同修改框）；要求可空，按钮照样构建。两种布局：`card`（空状态，居中 ≤ 560 px 卡片，标题 "Build a 3D twin" + 说明）与 `inline`（Regenerate 打开，替换工具栏，打开时聚焦并只滚动所在设置栏）。另导出 `TwinRequestNote`：给所有读者的折叠 `<details>` "Built to your / the owner's request"。
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
- 文案：本轮新增处 "model" 指 3D 的一律改 "twin"，AI 一律 "AI model"；表单注明 "Any language · readers see it with the twin"；空状态卡片里的 Stop 提示 "nothing is saved"；非 staff 的 owner 不再看到第三人称的 "The owner has not built…"，改为 "Building 3D twins is open to staff accounts only for now."。
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
