# Web「查看街景 / View Street View」实施方案（定稿）

状态：**方案定稿；阶段 1+2+3 已实现（2026-08-06）**。作者：Claude（基于对 `infrared-explorer-app` / `infrared-explorer-web` / `aladdin2` 三仓库的调研）。

> **进度补记（2026-08-06）——宽全景 + 热像工具**：在 1+2 之上又实现：① **宽全景**：`scripts/stitchAll.mjs` 给每条 legacy 片段烤一张全 360° 等距柱状 **JPEG**(按 azimuth 切片摆位 + 图像互相关对齐 + 环闭合 + 曝光补偿 + 羽化);查看器加**全屏模式**(拖动平移全景,谷歌街景手感),小窗保留单帧环视;**指南针重做**(玻璃盘+固定朝向索引+旋转北针)+读数玻璃药丸。② **热像四工具**(数据来自从 `.vir` 解出、与画面对齐的**温度全景**,厘开尔文无损存进 PNG 的 R/G):**取温**(光标实时 °C)、**色标条**、**直方图**(只统计当前可见范围,分位数域)、**等温线**(marching-squares 多条轮廓线 + 可编辑图例,蓝→红,4× 分辨率画布保清晰)。小窗+全屏都可用。数据字段:`panoUrl`/`panoTempUrl`(+dims、°C 范围)由 stitchAll 写入;跑 `node scripts/stitchAll.mjs` 补烤(缺 `panoTempUrl` 才处理)。新依赖 `jpeg-js`/`pngjs`。`tsc`(新文件零错)/`vite build`/`eslint` 全绿,经多轮可视化 QA。

> **实现进度（2026-08-04）**：阶段 1（路由 `/streetview` + 侧栏/页头 + `@react-google-maps/api` 地图 + `MarkerClusterer` 聚合 + `useStreetViews` 数据钩子 + 归一 util）与阶段 2（`streetViewPano` 数学、`streetViewViewer` 视频按帧 seek 环视、`streetViewCompass` DOM-SVG HUD）已实现，`tsc`（新文件零错）/`vite build`/`eslint` 全绿。经一轮对抗式 review（5 finder × per-finding 验证）修掉 5 个确认缺陷：①指针捕获吞掉邻居点击→改为越过阈值才捕获+邻居 bail；②seek 合并器按「达成时间」比较会死循环卡死→改为按帧比较、onSeeked 无条件清 flag 再 pump、并对可 seek 末端裁剪；③罗盘 HUD 按整舞台尺寸→改按 object-fit contain 命中矩形定位；④地图未 memo→`memo()`；⑤钩子 active 翻转卡 loading→inactive 分支重置。**阶段 0 的 `streamAll` 批处理与 CORS 核实仍待用户执行**（legacy 无 `streamUrl` 时查看器回退播原 `.mp4`，seek 较慢）。未提交，待用户 review + 运行时可视化 QA。

> 定位：把 **App 已上线的**「地图浏览 + 全景环视看图」搬到 Web（React + Vite + TS + antd + Firebase，teal 主题）。**采集/上传继续留在 App**，Web 只做**只读浏览 + 查看器**；策展/可见性写操作后期可选。

## 已定决策（本轮拍板）

| 决策 | 结论 |
|---|---|
| 路由名 | **`/streetview`** |
| 底图方案 | **Google Maps**，复刻 `aladdin2` 的 Models Map 模式（`@react-google-maps/api`）；**不用** MapLibre/OSM |
| 地图 API key | **复用 aladdin2 的 `VITE_MAPS_API_KEY`**（需给该 key 的 HTTP-referrer 白名单加 `ie.intofuture.org` + `localhost:5173`） |
| 聚合 | 用 Google Maps 内置 `MarkerClusterer`；**不引** `supercluster` |
| 卫星/混合底图 | Google Maps 原生 `mapTypeId`（roadmap/satellite/hybrid），对齐旧版 Java 的三态——**免费得到** |
| MVP 是否含读温 | 阶段 0–2（地图 + 环视看图）为 MVP；读温/色标为阶段 3 可选增强（legacy 读温有跨域硬阻塞，见 §5） |

---

## 1. 三条核心发现（决定方案可行性）

1. **App 的地图本身就是 MapLibre GL JS 的 HTML 页**（app `src/assets/html/streetViewMapHtml.ts`），App 只是用 `react-native-webview` 套着它。Web 端不需要 WebView——但本方案进一步决定 **Web 地图改用 Google Maps 复刻 aladdin2**，以白拿卫星/混合底图 + 内置聚合 + 内部先例。
2. **App 的「全景」不是 WebGL 球面**，而是对一段缓慢平移约 360° 的视频做**「拖动 = 按帧 seek」的环视**：app `src/lib/streetViewPano.ts` 的 `panToFrameSeek` / `closestFrameToAzimuth`，落地在 `src/screens/PlaybackScreen.tsx`（`StreetPlayer` 路由，L1321/L1340 seek、L1111-1146 合并器、L1416 邻居 push）。Web 用 HTML5 `<video>` seek 即可复刻，**不需要 three.js**。
3. **`.vir` 渲染难题已被后端预处理解决**：`scripts/streamAll.mjs` 把每条 legacy 片段用 ffmpeg 重编码成 **all-intra `stream.mp4`**（每帧关键帧、可廉价 seek、剥掉 jcodec 的 `moov/meta`、尾部 clone-pad 8s），上传到公开 Storage `streetviews/{id}/stream.mp4`，并回写 `streamUrl` + `videoDurationSec`（内容时长，不含 pad）。**浏览器直接播这段 mp4，根本不用解码 `.vir`。**

---

## 2. 数据现状（同一 `streetviews` 集合，两种文档形态）

App `src/lib/streetViewBrowse.ts::toStreetViewMarker`（L125-161）把两种形态归一：

| | **A. legacy 种子**（约 238 条） | **B. app-native**（App 上传，当前 gated） |
|---|---|---|
| 来源 | `scripts/seedStreetViews.mjs` L172-187；`ownerId:'system'`、`legacy:true` | App `buildStreetViewDoc`；24-hex doc id |
| `sourceType` | `'pano'` | `'single' \| 'pano'` |
| 朝向 | **顶层数组** `azimuthDeg[]`/`pitchDeg[]`（2dp）、`frameCount`、`neighbors:[{azimuthDeg,svId}]` | `shots:[{index,azimuthDeg,pitchDeg}]`（无顶层 `frameCount`，取 `shots.length`；无 `neighbors`/`virUrl`） |
| 像素 | 外部 `virUrl`（`intofuture.org/telelab/streetview/…`）+ 预烤 `streetviews/{id}/stream.mp4` | Storage `streetviews/{id}/data_N.dat`（pako-deflate 温度栅格）+ `data_N.png`（inferno 图），可选 `vis_N.jpg`/`mix_N.jpg` |
| 位置 | `location`(GeoPoint) + `geohash`(precision 9) | 同左 |
| 元数据 | `displayName`/`author`/`description`/`thermalUnit:'celsius'`/`palette:'inferno'`/`date`/`createdAt`/`trash:false`/聚合字段=0 | 同惯例 |
| **Web 今天能否显示** | ✅ **前提：已跑 streamAll**（否则原 mp4 非 all-intra、seek 昂贵 + 跨域 Range 未验） | ✅ 直接换 `data_N.png` |
| **Web 今天能否读温** | ⚠️ 需外部 `.vir` 跨域（CORS 未验）→ 硬阻塞 | ✅ `data_N.dat` + 现成 `getTemperatureAtPosition` |

**规则 / 权限（已就位，无需改）**
- Firestore `firestore.rules:175-216`：`visibility` 为 public/unlisted **匿名可读** → Web 读取无需登录、无需改规则。
- Storage `storage.rules:50-57`：`streetviews/** read: if true` → `stream.mp4`、`data_N.*` 浏览器可直接取。
- `storage.cors.json` 白名单含 `ie.intofuture.org` 等、放行 `GET/HEAD`+`Range`；但线上桶实际 CORS 需 `gsutil cors get gs://infrared-explorer.appspot.com` 核实（曾记录为通配 `*`）。

**⇒ 数据前置（crux）**：要让 legacy 街景在 Web 可靠可视，必须先对全部 legacy 文档跑通 `scripts/streamAll.mjs`（幂等、跳过已有 `streamUrl`），并核实**当前带 `streamUrl` 的比例**。

---

## 3. 总体架构 & 数据流

```
Firestore streetviews ─useStreetViews()→ StreetView[] (归一两形态)
                                             │  Google Maps + MarkerClusterer ★  click
                                             ▼
                             hydrate 全文档(getDoc) → StreetViewViewer
   legacy: <video src=stream.mp4> Range seek           app-native: data_N.png 换位 (+data_N.dat 读温)
    拖动→panToFrameSeek→video.currentTime                帧图换位 + getTemperatureAtPosition
              └──── 罗盘 / N·E·S·W 方位线 / 水平线 / 邻居传送门（DOM <svg>） ────┘
```

- **地图层**：`@react-google-maps/api` → `useJsApiLoader({ googleMapsApiKey: import.meta.env.VITE_MAPS_API_KEY })` → `<GoogleMap mapTypeId>` + `<MarkerClusterer>`，骨架照搬 `aladdin2/src/components/map/modelsMap.tsx`（L450 GoogleMap、L750 MarkerClusterer、L234 `onMapTypeIdChanged`）与 `modelsMapWrapper.tsx`（L118 loader）。
- **查询**：MVP **load-all 238 条 public**（仿 Community feed），交给 `MarkerClusterer` 客户端聚合；viewport/geohash 范围查询推到阶段 4。
- **查看器**：`stream.mp4`（legacy）/`data_N.png`（app-native）为像素源；拖动→`panToFrameSeek`→`video.currentTime` seek 或帧图换位；叠加罗盘/方位线/邻居传送门。
- **热像复用**（app-native）：`getTemperatureAtPosition`、`getDecodedFrame`、`parseRawThermalData`、`renderThermalFrameThumbnail`、`palette*`——直接调用。

---

## 4. 分阶段实施（逐文件）

### 阶段 0 — 数据前置 & 环境（无 UI）
- [ ] `gsutil cors get gs://infrared-explorer.appspot.com` 核实线上 CORS 放行 `Range`。
- [ ] 对全部 legacy 文档跑 `scripts/streamAll.mjs`（先 `--limit=5` 冒烟），核实 `streamUrl` 覆盖率。
- [ ] **Google Cloud**：给 aladdin2 的 `VITE_MAPS_API_KEY` 的 HTTP-referrer 白名单加 `ie.intofuture.org`、`localhost:5173`（Maps JavaScript API 已启用）。
- [ ] `.env` / `.env.example` / Hosting 构建环境加 `VITE_MAPS_API_KEY`（Web 仓当前只有 `VITE_FIREBASE_API_KEY`）。

### 阶段 1 — 路由 / 外壳 / 地图（Google Maps + 聚合）
新依赖（`package.json`）：**`@react-google-maps/api`**（同 aladdin2 版本 `^2.20.7`）。**不加** maplibre-gl / supercluster。

- [ ] `src/types.ts`（L111 `ExperimentDoc` 附近）新增 `StreetViewDoc` + 归一后的 `StreetView` 类型（**不复用** `ExperimentDoc`——`ownerId:'system'`/`legacy`/`sourceType`/`location:GeoPoint`/`geohash` 对不上）。归一形：`{ svId, lat, lng, title, author, palette, thermalUnit, azimuthDeg[], pitchDeg[], frameCount, neighbors[], virUrl?, streamUrl?, videoDurationSec?, sourceType, createdAt }`。
- [ ] 新建 `src/utils/streetView.ts`：从 app `streetViewBrowse.ts` 端口 `toStreetViewMarker`（含 `shots[]→azimuthDeg[]` 回退、`neighbors` 读取），用 Web `firebase/firestore` SDK 解 `GeoPoint`/`Timestamp`（不必端口 app 的 REST 解码器）。
- [ ] 新建 `src/hooks/useStreetViews.ts`：克隆 `src/hooks/useCommunityExperiments.ts`，`collection(firebaseDatabase,'streetviews')`，`where('visibility','==','public')` + `where('trash','==',false)`；**删除 `thumbnailURL` 过滤**（种子无该字段，否则全空）；每条过 `toStreetViewMarker`，丢弃无 `location` 的。（MVP 可 load-all，不分页。）
- [ ] `src/App.tsx`（L42 `community` 之后）加 `{ path:'streetview', element:<StreetView/> }` + 顶部 import。查看器用同页 modal 或另加 `/streetview/:svId`（见 §6）。
- [ ] `src/layouts/sidebar/sidebar.tsx`：`main` 组（L64-67，登出可见）加 `{ key:'/streetview', icon:<EnvironmentOutlined/>, label:'Street View', short:'Street' }`；import 块（L3-13）加 `EnvironmentOutlined`。
- [ ] `src/layouts/header/header.tsx`：`PAGE_TITLES` 加 `/streetview → 'Street View'`。
- [ ] 新建 `src/pages/streetView/streetView.tsx`：调 `useStreetViews`，`React.lazy` 懒加载地图子组件（仿 `surface3d` 懒加载先例）；`<Spin>` 载入态、空态仿 `community.tsx`。
- [ ] 新建 `src/pages/streetView/streetViewMap.tsx`：照搬 aladdin2 `modelsMap.tsx` 骨架——`<GoogleMap mapTypeId={mapType}>` + `<MarkerClusterer>` + ★ `<Marker onClick>` 打开查看器 + `<InfoWindow>` 预览卡；`mapType`(roadmap/satellite/hybrid) 存 `src/stores/common.ts` + `usePersistentState` 记忆；默认相机 Boston `{lat:42.3651835,lng:-71.07414}, zoom:12`。
- [ ] `src/App.css` 加 `.streetview-*` 全局 class（teal `#008c8c`/`#006e6e`，匹配现有全局 class 约定，不引 CSS Modules）。

### 阶段 2 — 查看器（环视 / 按帧 seek）
- [ ] 新建 `src/utils/streetViewPano.ts`：逐字端口 app `streetViewPano.ts`（`normalizeDeg`、`wrapFrame`、`panToFrameSeek`（`SEEK_MS_PER_PX=30`、`FRAME_MS=200`，右拖=更早帧）、`closestFrameToAzimuth`、`bearingScreenX`、`pitchScreenY`、`HFOV=43`/`VFOV=55`、`CARDINALS`）。纯数学、零依赖。
- [ ] 新建 `src/pages/streetView/streetViewViewer.tsx`：
  - 打开时 `getDoc` hydrate 全文档。
  - **legacy 路径**：`<video muted playsInline src={streamUrl}>`；pointer/touch 拖动（CSS px × `devicePixelRatio` 对齐 app `PixelRatio.get()`）→ `panToFrameSeek(startFrame, dxPx, frameCount)` → `video.currentTime = ((frame-0.5)/frameCount) * videoDurationSec`（用**内容秒**，非含 pad 总时长）；「单飞行 seek + 重瞄最新目标帧」合并器（仿 app `PlaybackScreen.tsx:1111-1146`）。**不需要** ExoPlayer 的 `moov/meta`→`free` patch（`stream.mp4` 已干净）。
  - **app-native 路径**：`data_N.png` 用 `<img>`/`<canvas>` 换位（prev/cur/next 叠层避黑闪）；帧数 = `shots.length`。
  - 邻居导航：点传送门 pill → hydrate 邻居 → 以离开时的 `curAzimuth` 作 `startAzimuthDeg` + `closestFrameToAzimuth` 让新点朝向进入方向。
- [ ] 新建 `src/pages/streetView/streetViewCompass.tsx`：把 app `components/overlays/StreetViewCompassOverlay.tsx` 的几何照搬，渲染面 `react-native-svg` → DOM `<svg>`：N/E/S/W 虚线方位线（`bearingScreenX`）、水平/俯仰点线（`pitchScreenY`）、左下罗盘玫瑰、右下 `方位°｜日期` 读数、邻居 pill。

### 阶段 3 — 读温 + 色标（可选增强）
- [ ] **app-native 读温**：仿 `src/utils/recordingFrame.ts::fetchRecordingFrameBuffer`，`ref` 改到 `streetviews/{id}/data_N.dat` → `getBytes` → `getTemperatureAtPosition(buffer, xFrac, yFrac, unit)`；复用同一 buffer 命中 `getDecodedFrame` 身份缓存。
- [ ] **色标条 / 图例**：复用 `paletteGradientCss(key)`、`paletteHexAt`、`PALETTE_KEYS`，AGC min/max 取 `getDecodedFrame`；`scaleHotspots/scaleHotspots.tsx` 可近乎照搬。**勿重引 level/span 锁定**（系统是逐帧 AGC，此前明确砍掉）。
- [ ] **legacy 读温**：外部 `.vir` 跨域 → 三选一（见 §5.1）。

### 阶段 4 — 规模化 & App 复用（后期可选）
- [ ] `geofire-common` viewport/geohash 查询 + 新增复合索引 `(visibility, trash, geohash)`（`firestore.indexes.json`，当前不存在）。
- [ ] `?embed=1` 去 chrome（`src/layouts/layout.tsx` 已用 `useLocation`）：为真时只渲 `<Outlet/>`，供 App WebView 反向复用 Web 查看器。
- [ ] 策展/可见性写（`src/services/streetviews.ts`，尊重规则保护字段），staff-only（`@intofuture.org`）。

---

## 5. 关键技术难点

### 5.1 legacy 读温（最硬，仅阶段 3 涉及）
外部 `.vir` 跨域 fetch/Range 的 CORS 未验；`parseRawThermalData(virBuf)` 还要求 120×160 分辨率（否则 `UNSUPPORTED_THERMAL_RESOLUTION`）。三条出路：① 外部主机（intofuture.org）加 CORS；② 新增 Cloud Function 代理 `.vir`；③ 在 `streamAll` 增补一步，把 `data_N.dat` 预烤进 Storage（最一致，但存储/算力成本）。**不影响看图，只影响读温**——MVP 可先不做。

### 5.2 全景渲染方式
App 的「全景」= 对缓慢平移片段做按帧 seek 的环视（右拖=更早帧，一屏宽 ≈ 扫完约 360°）；「单点」= `frameCount==1`。Web 照此实现（HTML5 video seek / 帧图换位），**无 three.js**。

### 5.3 缩略图空缺
种子文档无 `thumbnailURL`——地图 ★ 标记不需缩略图（用 emoji/icon），故 MVP 无碍；若后续要卡片网格，需从 `stream.mp4` 抽 poster 或在 streamAll 预烤 `data_1.png`。

### 5.4 隐私 / 策展
规则默认允许登录用户直接写 `public`（代码与注释矛盾、注释过时）。Web 侧把 public 街景当**未审核 UGC**（家庭热像有隐私含义）；MVP 只读、不放大风险；策展/下架仍 staff-only。

---

## 6. 剩余待定（实现期再拍板，不阻塞定稿）

1. 查看器形态：同页 `<Modal>` vs 独立路由 `/streetview/:svId`（后者利于分享/深链）。
2. 阶段 3 是否纳入首版（若纳入，先定 5.1 的 legacy 读温出路）。
3. 地图 feed 是否排序：load-all 免索引（不排序）vs 加 `(visibility,trash,createdAt)` 复合索引并排序。
4. 是否首版就做 `?embed=1`（App WebView 反向复用）。

---

## 7. 工作量估计（粗略）

| 阶段 | 内容 | 估计 |
|---|---|---|
| 0 | CORS 核实 + streamAll 全量 + key referrer/env | 0.5–1 天（ffmpeg 批处理 238 条时长另计） |
| 1 | 依赖 + 类型 + hook + 路由/侧栏/页头 + Google Maps + 聚合 | 2.5–3.5 天（复用 aladdin2 模式，比 MapLibre 省事） |
| 2 | pano 数学端口 + 查看器（video seek + 合并器 + 帧图换位）+ 罗盘 + 邻居 | 4–5 天（seek 手感对齐是主要打磨点） |
| 3 | app-native 读温 + 色标（legacy 读温视方案） | 1.5–2 天（不含 legacy 跨域方案落地） |
| 4 | geohash viewport / `?embed=1` / 策展写 | 各 1–2 天，按需 |

**MVP（阶段 0–2）≈ 7–9 个工作日**；含读温/色标（阶段 3）+≈2 天；阶段 4 按选项叠加。
