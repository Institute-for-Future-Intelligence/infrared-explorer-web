# 色标条调色板对齐方案(palette plumbing + 检测)

状态:P0–P3 已实现(web),P2 app 基建已实现,均**本地未提交**。2026-07-20。
关联:分析页 Tier-1 色标条(scaleBar)/冷热点(hotspots)已实现;「scale 按钮固定范围模式」(P4)以本方案为前置,未实施。

## 实施状态(2026-07-20)

- **P0 完成**(web):`utils/paletteData.ts`(从 app 搬来的 11 个 FLIR LUT)、`utils/palette.ts`(normalize/hexAt/gradientCss + 纯检测 `detectPaletteFromPixels`);`ExperimentDoc`/`Experiment` 加 `palette?`/`paletteSource?`(读取靠 experimentAnalyzer 的 `...data` spread 自动带上);clone 携带 palette;`scaleHotspots` 新增 `paletteName` prop,已知则画真 LUT、未知则 HSL + “approx.” 标注(温度标签始终精确);两 player 传 `experiment.palette ?? detectedPalette`。
- **P1 完成**(web):`utils/paletteDetect.ts`(图像/视频帧→120×160 canvas 像素→match,阈值 `ACCEPT_DISTANCE=60`);imagePlayer 一次性检测 IR 渲染(用 `cacheImageRef.current.ir`,即使在看 visible/blended 也正确),会话内 state 缓存、失败换帧重试、不并发。
- ~~**P3-C2**(web):owner/staff 手选下拉~~ **已整条删除(2026-07-22,用户拍板)**:调色板是录制时的客观事实、只有一个真答案,让人手选就是开填错值的口子。删了 `experimentPalette.tsx`、`updateExperimentPalette`(+`deleteField` import)、`description.tsx` 的挂载/`canTagPalette`/showRight 项、`firestore.rules` 的 staff palette-tag 规则(本就未部署)。`paletteSource` 联合类型保留 `'manual'` 仅为读旧值兼容。
- **P3-C1 完成但休眠**(web):`utils/paletteDetect.detectPaletteFromVideo` + videoPlayer 的一次性视频帧检测 + ReactPlayer `crossOrigin`,全部 gated 于 `constants.VIDEO_PIXEL_CORS_READY=false`。**翻 true 前必须先应用 `storage.cors.json` 到 videostore 桶**,否则视频加载失败。
- **P2 部分完成**:
  - **web `firestore.rules`**:加了 staff palette-tag 规则(`hasOnly(['palette','paletteSource','updatedAt'])` + paletteSource=='manual'),让 staff 能标注 system-owned showcase。owner 走既有「非保护字段」写权限;create 不限字段,app 建档可带 palette。**未部署**。
  - **app 数据链路已打通**(`infrared-explorer-app`):`experimentDoc.ts`(input/doc 加 palette + builder 写 paletteSource='app')、`recordingQueue.ts`(entry.palette)、`cloudUploader.ts`(UploadRequest.palette→entry→createExperiment)。全部对 undefined 安全(无值时不写字段),app tsc 干净。
  - **未做(有意)**:上传时从 store 抓 palette——因 palette 必须**录制时**冻结(设备端 palette 可变),而 `meta.json` 由原生 `FlirRecordingWriter.finish`(Kotlin/Swift)写。上传时抓会存**错值且盖过正确检测**。→ 见「跟进项」的原生 hop。recording 目前已由 P1 检测准确覆盖,不阻塞。

**解析优先级(已实现,2026-07-22 简化为三级)**:stored 'app'(record-time,已供值) > detected(P1 recordings;P3-C1 videos 待 CORS) > HSL+approx fallback。手选 tier 已删——不再有人肉覆盖。

**部署/运维跟进项**:
1. ~~`firebase deploy --only firestore:rules`(staff palette 规则)~~ 作废:该规则已删,无需部署(其余 rules 变更另议)。
2. 给 videostore 桶应用 CORS:`gsutil cors set storage.cors.json gs://<bucket>`(填真实 bucket + 域名),然后把 `VIDEO_PIXEL_CORS_READY` 翻 true → 视频自动检测生效,**顺带修视频截图 tainted / 关键时刻无缩略图两个旧伤**。
3. ~~原生 record-time hop(权威值)~~ **已实现(Android,2026-07-22,app 仓库本地未提交)**:`FlirCameraController.startRecording` 在录制开始冻结当前 palette 名(`currentPaletteName()`)存入 `RecordingSession`,`FlirRecordingWriter.finish(frames, palette)` 把它写进 `meta.json`;`files.ts` 的 `RecordingMeta`/`VideoItem` 加 `palette`(`listVideos` 把原始 SDK 名 lower-case 成 web key),`VideosScreen` 上传时传 `palette: item.palette` 进 `requestUpload`→`experiments.palette` + `paletteSource:'app'`。web create 规则无 key 白名单,新字段免改规则直接放行。**iOS 录制是 graceful stub(无 bundle/meta.json),不受影响。** 存量视频仍靠 P1 检测。待 Android 真机构建 + 录制→上传→web 端色标一致性 QA。

## 原方案（保留）

## 1. 问题

色标条要能当「颜色→温度」的钥匙,渐变就必须和播放器里烘焙好的伪彩画面**逐色一致**。实测(用户截图)两个实验用了**不同的调色板**:

- telelab 视频(盐水/清水,19.8–21.9°C):**Rainbow/RainHC** 类(蓝→绿→黄→红)
- 另一视频(蜡烛,12.8–150.3°C):**Iron**(深蓝→紫→品红→橙→白)

而 web 端此前的两版色标条(inferno、HSL 蓝→红)都只是猜测,对不同实验必然有错。

## 2. 已查明事实(证据)

| 事实 | 出处 |
|---|---|
| 画面调色板是 FLIR 相机的 **11 个命名调色板**之一:Iron / Rainbow / RainHC / Contrast / Arctic / Lava / ColorWheel6 / WhiteHot / BlackHot / Coldest / Hottest | `infrared-explorer-app/src/lib/paletteData.ts`(精确 ~256 级 hex LUT,由 Infrared-Explorer-2 的 .pal 资产生成);顺序见 `src/native/FlirThermal.ts:58` + `MainScreen.tsx` FALLBACK_PALETTE_NAMES |
| app 默认 `selectedPaletteIndex: 0` = **Iron**;用户可在设备上换 | `app/src/state/store.ts:76` |
| 调色板选择只存**设备本地** AsyncStorage,**不随录制上传**;`.dat` 格式契约里 data_N.png 仅注明 palette-rendered,无板名 | `app/src/state/persistence.ts`、`app/src/lib/recordingFormat.ts` |
| web 端实验文档 / `.wrk` / storage 元数据**均无调色板字段**(grep 全仓库无) | `web/src/types.ts` ExperimentDoc |
| 每帧 AGC:当帧 min→max 拉满调色板(已由产品方确认) | — |
| app 里已有现成色标条组件可参考(按板名查 LUT 画渐变) | `app/src/components/ColorGradientBar.tsx` |
| recording 的 data_N.png 经 Storage SDK 以 blob 加载(同源可读像素);**视频 mp4 是跨域流,canvas 读不到像素**(现有截图失败/关键时刻无缩略图即此因) | `web/src/pages/experimentAnalyzer/imagePlayer/imagePlayer.tsx`、`videoPlayer.tsx` |

**当前临时态**(工作区,未提交):色标条用 `temp01ToCss` HSL 蓝→红近似,注释已标注 INTERIM。

## 3. 目标

1. 每个实验的色标条使用**该实验实际的调色板**,逐色精确。
2. 为后续「固定范围模式」(客户端按固定温度区间重上色画面)打好地基——重上色也需要精确 LUT。
3. 拿不到调色板时**明确降级**,不装作精确。

## 4. 总体设计:每实验解析,四级优先

新增 web 端调色板解析器,对每个实验按优先级取板:

```
manual(人工标注,最高) > stored(app 上传时写入) > detected(像素自动检测) > fallback(未知,降级)
```

数据模型(ExperimentDoc 增量,向后兼容):

```ts
palette?: string;          // 'iron' | 'rainbow' | ... (paletteData 的 key,小写)
paletteSource?: 'app' | 'detected' | 'manual';
```

### 4.1 LUT 库搬进 web(基础,无风险)

把 `app/src/lib/paletteData.ts` 原样搬到 `web/src/utils/paletteData.ts`(它是生成文件,注明「Do not edit by hand;源在 app 仓库」)。新增:

- `paletteCss(name, t)`:归一化温度 → hex(LUT 线性查表);
- 色标条渐变改为按解析出的板名生成(LUT 本身就是 ~256 stop,可直接 `linear-gradient` 拼 24~32 个采样 stop);
- 3D 表面 / 等温线图例**不动**(它们是 app 自己的 overlay 语言,蓝→红 HSL,本来就不是模拟画面)。

### 4.2 路径 A:app→Firestore→web plumbing(已拍板的主路径,覆盖今后新录制)

- **app 端**:上传录制时,把 `paletteNames[selectedPaletteIndex].toLowerCase()` 写进实验文档(`palette` + `paletteSource:'app'`)。改动点在 app 的上传/建档流程(具体位置待在 app 仓库定位,见 §8 开放问题)。
- **web 端**:`fetchExperiment` 已整取文档,`palette` 字段随手即得,零额外读。
- **firestore.rules**:字段是文档一部分,owner 写路径已覆盖;若 app 用独立建档接口需同步允许该字段。

### 4.3 路径 B:存量 recording——像素自动检测(可全自动)

对没有 `palette` 字段的 recording:

1. 取当前帧的 data_N.png(已是同源 blob→dataURL,canvas 可读)+ 同帧 .dat 温度网格(已解码缓存);
2. 均匀采样 ~200 个像素:算归一化温度 `t=(T−min)/(max−min)`(AGC 前提),取画面实际 RGB;
3. 对 11 个候选 LUT:`score = mean ΔRGB(实际色, LUT[t])`,取 argmin;
4. **置信门槛**:最优分需低于绝对阈值,且与次优拉开比例差,否则判「未知」→降级;
5. 结果缓存:会话内存缓存必做;是否回写 Firestore(`paletteSource:'detected'`)见 §8——注意 rules 下**非 owner 不能写**,回写只能 owner/staff 触发或走 Cloud Function。

检测跑一次/实验,成本一帧一次遍历,可忽略。

### 4.4 路径 C:存量视频(telelab)——两个子选项(待拍板,见 §8)

mp4 跨域读不到像素,检测卡死。可选:

- **C1 开 CORS + 视频帧检测(推荐)**:videostore 桶配一次 CORS(`gsutil cors set`),ReactPlayer 的 `<video>` 加 `crossOrigin='anonymous'`,即可 canvas 采样视频帧 → 复用 B 的检测。**副产品直接修掉两个已知旧伤:视频截图 tainted-canvas 失败、视频关键时刻无缩略图。**
- **C2 人工标注**:实验页给 owner/staff 一个 11 选 1 的调色板下拉(写 `paletteSource:'manual'`)。showcase 视频是固定小集合,一次标完。无基础设施改动。
- C1+C2 组合(自动为主、人工兜底)最稳。

### 4.5 降级(fallback)

解析不到板名时:色标条渐变退回灰阶或 HSL,并在条上加小字 “approx.”(或 tooltip),**不冒充精确**。冷热点标记、min/max 数字不受影响(它们与调色板无关,始终准确)。

## 5. 与「固定范围模式」的衔接(前置关系)

用户已提出 scale 按钮加「固定范围」模式。在 AGC 画面上,固定范围要真正有用必须**客户端重上色**(level & span):固定模式下用固定 [Tlo,Thi] 把 .dat/.vir 帧渲到 canvas 覆盖原画面,全片同色=同温、消除 AGC 闪烁,色标条与画面天然一致。

- 重上色用的**必须是本方案的精确 LUT**,否则固定模式画面与自动模式画面风格突变;
- 渲染管线可直接扩展 `thermalThumbnail.ts` 的逐像素上色(改为按板名 LUT + 外部传入 min/max,不再固定 inferno + 每帧归一);
- recording:canvas 盖在 `<img>` 上;视频:canvas 盖在 `<video>` 上(帧数据来自 .vir,内存中,无 CORS 依赖——即使不开 C1 也可行);
- 固定范围的取值:默认「全片 min/max」(采样帧扫描),后续可加手动输入。此部分细节在本方案落地后另出实施稿。

## 6. 实施阶段

| 阶段 | 内容 | 仓库 | 规模 |
|---|---|---|---|
| P0 | LUT 库搬运 + 解析器骨架 + 色标条按板名渲染 + fallback 标识 | web | 小 |
| P1 | recording 像素检测(路径 B)+ 会话缓存 | web | 中 |
| P2 | app 上传写 palette(路径 A)+ rules 校验 | app + web | 小(app 端改动点待定位) |
| P3 | 存量视频(路径 C,按 §8 拍板结果) | web(+桶配置) | C1 中 / C2 小 |
| P4 | 固定范围模式(重上色,另出实施稿) | web | 大 |

P0+P1 先行即可让**绝大多数 recording 立刻精确**;P2 保证增量;P3 收尾存量视频。

## 7. 风险与注意

- **检测误判**:AGC 假设若对某来源不成立(如百分位裁剪),ΔRGB 会整体偏大→被置信门槛拦下→降级,不会错标。
- **JPEG/PNG 压缩噪声**:采样均值 + 阈值足以吸收;data_N.png 实际可能是 JPEG(functions 里有 magic-byte 检测先例)。
- **同族板难分**(Rainbow vs RainHC 相近):若分数接近,取哪个视觉差异也小;可在置信规则里允许「族内并列取先」。
- **回写权限**:detected 结果回写受 rules 限制,见 §8。
- **WhiteHot/BlackHot/Coldest/Hottest 是灰阶/带阈值板**:检测同样适用(灰阶反而好认),但色标条对 Coldest/Hottest 这类「阈值高亮」板要按 LUT 原样渲染(它们不是平滑渐变,正好体现真实语义)。

## 8. 开放问题(待拍板)

1. **存量视频走 C1(开 CORS 自动检测,顺带修截图/缩略图旧伤)还是 C2(人工标注)还是组合?**(推荐 C1+C2)
2. **detected 结果是否回写 Firestore?** 选项:a) 不回写,每会话现算(最简,成本可忽略);b) owner 访问时回写;c) Cloud Function 批量回填一次。推荐 a 起步,c 作一次性存量清洗可选。
3. app 端上传/建档代码路径需在 app 仓库定位后补充到 P2(本方案未含 app 侧实施细节)。
4. 色标条 fallback 的视觉(灰阶 vs HSL + “approx.” 标注)。
