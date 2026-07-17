# Infrared Explorer 首页重设计方案

> 状态:定稿待实施 · 2026-07-16
> 可交互 mockup(3:4 竖版 ⇄ 16:10 对照):https://claude.ai/code/artifact/c03a5f71-f448-4b32-b6f8-57e7862a201a
>
> 技术基线:antd ^5.19.4(67 个文件)+ App.css(1973 行)+ styled-components(18 文件)+ 内联 style 约 264 处;`main.tsx` 目前**无**全局 ConfigProvider;`src/index.css` 已有 8 个 `--ifi-*` 变量、被引用 61 次。方案全部按「antd v5 全局 theme + CSS 变量令牌」落地,不引入其他 UI 库。

---

## 0. 定位

> **「冷仪器,热数据」** —— 界面外壳冷静、精密、低饱和;只有内容、数据读数和交互焦点允许"发热"。热谱渐变是全站最稀缺的品牌资源,按白名单使用,每屏同时可见 ≤ 2 处。

内容(热成像伪彩)天生鲜艳、天生科技感,问题从来不是内容"花",而是外壳没有退让、没有给它秩序。

---

## 1. 现状诊断(按影响排序)

1. **触屏用户看不到任何元数据(功能缺陷,最致命)。** 作者、评分、时长、浏览量、日期全部藏在 hover 遮罩 `rgba(0,0,0,0.72)` 里;K12 主力设备是 iPad / 触屏 Chromebook,评分体系对他们等于不存在。卡片正面只有缩略图 + 标题。
2. **卡片标题不可读。** `.card-name` 是 32px 高 `rgba(40,40,40,0.5)` 纯色半透明条,白字压在不可控伪彩上,JS 逐 px 缩字号至 9px 下限——教室投影上无法阅读。
3. **加载体验是 CLS 灾难。** `card.tsx` 在缩略图未到时 `return <></>`,整卡不渲染:首屏卡片乱序蹦出、网格数秒内反复塌缩;无骨架屏、无空态、fetch 无 catch(失败 = 空白),全页只有一个 antd Spin。
4. **三套主色打架,品牌无识别。** antd 默认蓝 `#1677ff`(搜索按钮等 7 处 TSX)、品牌 teal `rgba(0,140,140,1)`(链接/FAB)、幽灵紫 `#6b2280`(App.css:526 引用**从未定义**的 `--ifi-primary`,永远走 fallback)同屏并存;全站唯一有"红外感"的 iron 渐变只出现在 Me hub 头图,首页零像素。
5. **emoji 当图标。** `subjectMeta.ts` 的原子/试管/DNA emoji 跨 OS 渲染成三种彩色位图(Windows Segoe UI Emoji 尤其粗糙),三学科共用同一 `rgba(0,0,0,0.55)` 黑底——教育平台最强的分类轴"学科"没有颜色身份。
6. **首页信息架构 = 文件管理器。** 单个 `repeat(auto-fill, minmax(200px,1fr))` 网格一铺到底,2560 宽屏拉出 7 列杂色伪彩;无策展、无分区、无节奏;现成的 `scrollRow.tsx`(渐隐遮罩 + 箭头翻页)在首页闲置。
7. **缩略图秩序缺失。** 内容以竖屏 3:4 为主(播放器默认 `--frame-aspect: 3/4`,运行时实测修正),0.75 卡的画布比例本身是对的;"贴纸墙"观感的真因是:高饱和伪彩直接贴在白底上、压图标题制造额外噪音、无信息区缓冲。
8. **动效是半成品。** 卡片 `transition: 0.2s` 只写在 `:hover` 上(移出瞬间跳回)、`translate(-2px,-2px)` 向左上斜移违背物理直觉、对 all 过渡导致 box-shadow 每帧重绘;过滤/排序切换零过渡;全库零 `prefers-reduced-motion`。
9. **令牌体系已漂移。** 字号 10–34px 全硬编码、约 9 种圆角 10 种手写阴影并存;antd 组件另吃默认 6px 圆角与默认蓝;`--ifi-primary` / `--ifi-accent` 被引用却从未定义;Inter 未自托管(多数用户实际看到 system-ui);统计行 `#a9a9a9` 对比度 ~2.3:1 不达标。
10. **语义错位细节。** "Share 整个网站"按钮占据工具条黄金位;星色 `#fadb14` 是 antd 默认黄,与"热"叙事零关联;搜索无 `/` 快捷键;首屏被上传时间绑架(默认 Newest、无策展池)。

---

## 2. 关键裁决

### 裁决 1:浅色为主 +「灯箱」策略,暗色分阶段

- **首页及全站默认浅色**(surface 从 `#f8f8f8` 微调为更冷的 `#F6F7F9`)。理由:① K12 刚需——教室投影仪上深色 UI 发灰、对比崩坏,教师打印需要浅底;② 全站暗色 = 全部灰阶/阴影/67 个 antd 文件语义化重做,成本高一档;③ "白墙荧光贴纸"的真因由卡片重构(见裁决 2)消解,不必翻转全站底色。
- **「灯箱」:所有压在缩略图上的元素统一深夜蓝玻璃 `rgba(11,16,38,α)`**(徽章、时长 chip、hero 渐变、遮罩)——内容周边是暗的、页面外壳是浅的,伪彩在灯箱里发光而不是白墙上。废除 `rgba(40,40,40)` / `rgba(13,20,28)` 等杂写。
- **暗色的正确登陆点是实验分析页**(播放器天生属于暗房,P2)。注意接缝:届时需把分析页**整页**(含 `.content` 背景)纳入暗色作用域——嵌套 `ConfigProvider theme={{algorithm: darkAlgorithm}}` 包分析页子树 + 容器级 `[data-theme=dark]` 变量覆盖,不能只暗工具栏,否则拼缝比现状更刺眼。
- 全站暗色主题保留为 P2 可选项:必须三件套齐备——zustand 主题 state 驱动 ConfigProvider algorithm、`[data-theme]` 双套 CSS 变量、`index.html` 内联脚本首帧前注入 `data-theme` 防闪白(FOUC)。

### 裁决 2:卡片 = 3:4 竖版画布 + 图下信息区

> 修订说明:合稿初版定 16:10 横版,依据"热成像帧是横的"——该前提经核实不成立(内容以竖屏 3:4 为主,未来横竖屏并存)。画布回归 3:4。

- **画布 3:4**:与现有竖屏内容零裁切、零黑边。画布比例收口为一个令牌 `--ifi-thumb-ratio: 3 / 4`,网格/横向行/骨架屏共用;未来横屏内容反超时翻转整个系统只改这一行。
- **图下信息区(YouTube 结构)**:标题 15px/600 两行 clamp(永久废除 9px JS 缩字)、作者·相对日期、评分+浏览量。触屏用户第一次在正面看到元数据。
- **「热晕填充」规则(为横竖混排准备)**:比例不匹配的内容**不裁切**——同图 `cover + blur(22px)` 作底、叠 `rgba(11,16,38,.45)` 夜蓝压暗,前景 `contain` 居中。黑边变成暗房辉光,与灯箱语言一致。**科学内容永不裁切**是原则(热像边缘常有温度条/读数)。阈值:内容与画布比例相对差 <10% 时允许 cover 微裁,否则热晕 contain。
- **不做**按方向分区(Shorts 式独立 shelf)与双卡型:内容池小,切分两边都稀;违反"控制卡片变体数量"。
- 后端配套:上传/保存时把缩略图 `width/height` 写入 experiment 文档(现 `ShowcaseData` 无尺寸字段)——渲染前即可决定 cover/热晕与骨架比例,否则等 `onLoad` 才知方向,与"CLS≈0"红线冲突。

### 裁决 3:学科色(双档制)

| 学科 | 主色(膜/描边/图标) | 深档(文字专用,≥4.5:1) | 浅底膜 |
|---|---|---|---|
| Physics | `#6366F1` | `#4F52D0` | `rgba(99,102,241,.10)` |
| Chemistry | `#D6409F` | `#B02D82` | `rgba(214,64,159,.10)` |
| Biology | `#30A46C` | `#1F7A4D` | `rgba(48,164,108,.10)` |

否决备选:Chemistry 用 teal(与品牌冲突)、Chemistry 用橙(与热强调冲突——热色专属"温度/评分/热度"语义)。学科色贯穿:卡片徽章、chip 选中态、行标题图标、详情页标签、recharts 系列色(tooltip 文字用深档)。

### 裁决 4:图标 → lucide-react

Physics=`Atom`、Chemistry=`FlaskConical`、Biology=`Dna`,16px、strokeWidth 1.75,替换全部 emoji。侧边栏 antd 图标二期再统一,一期只灭 emoji。

### 裁决 5:热强调色 `#F08C1E`

取自 iron 渐变 80% 处。统一替换 `#fadb14` / `#faad14`(TSX 8 处星色)。约束:星形**永远伴随 mono 数值**(非文本 3:1 的豁免条件,防止别处复用只出星踩坑);`#F08C1E` 禁止作白底上的**文字**色(warning 文字用 `#B45309` 级深档,warning 填充可用)。

### 裁决 6:Hero 拼板承担"头条"职能

不新增特殊横版大卡行;Trending 用标准卡,控制卡片变体数量。

---

## 3. 设计令牌层(进 `src/index.css :root`,统一 `--ifi-` 前缀;antd 侧同步 ConfigProvider)

### 3.1 中性色(浅色默认)

| 令牌 | 值 | 用途 |
|---|---|---|
| `--ifi-panel` | `#FFFFFF` | 卡片信息区 / header / 侧栏 |
| `--ifi-surface` | `#F6F7F9` | 页面底 |
| `--ifi-fill-1` | `#ECEFF3` | 骨架底 / 浅填充 |
| `--ifi-stroke-1` | `#E2E6EB` | 弱描边 / 分隔线 |
| `--ifi-stroke-2` | `#D3D9E0` | 输入框 / 控件描边 |
| `--ifi-grey` | `#A6B2BF` | 仅装饰(禁作正文与 placeholder;placeholder 用 text-3) |
| `--ifi-text-3` | `#6E6E6E` | 三级文字(日期/meta;在 surface 上也 ≥4.5:1) |
| `--ifi-text-2` | `#595959` | 二级文字(作者/说明,≥7:1) |
| `--ifi-ink` | `#213547` | 一级文字 / 标题 |
| `--ifi-night` | `#0B1026` | 灯箱基色:图上玻璃元素统一 `rgba(11,16,38,α)` |

暗色 N 阶(播放器先行 + P2 备用,210° 冷蓝调):N950 `#0B0E12` · N900 `#11151B` · N850 `#171C24` · N800 `#1F2630` · N700 `#2A333F` · N600 `#3D4856` · N500 `#5B6878` · N400 `#7E8B9A` · N300 `#A6B2BF` · N100 `#E8EDF2`。

### 3.2 品牌色

| 令牌 | 值 | 用途 |
|---|---|---|
| `--ifi-teal`(= `--ifi-primary`) | `#008C8C` | 交互识别:链接/选中/焦点环/描边 |
| `--ifi-teal-fill` | `#007A7A` | **实底按钮填充**(白字 ≥4.5:1;`#008C8C` 上白字仅 4.09:1 不达 AA) |
| `--ifi-teal-dark` | `#006E6E` | hover / 可读控件文本 |
| `--ifi-teal-press` | `#005C5C` | 按下 |
| `--ifi-teal-film` | `rgba(0,140,140,.08)` | 选中底膜 |
| `--ifi-teal-dk` | `#1FB6A6` | 暗底提亮档(播放器/未来暗色) |
| `--ifi-heat` | `#F08C1E` | 热强调:评分星/温度读数/Featured/热度 |
| `--ifi-plum` | `#6B2280` | 仅限 Me hub 头图族,禁入首页 |
| `--ifi-spectrum` | `linear-gradient(90deg,#0B1026 0%,#3D0F63 20%,#8B1E5F 40%,#C73E2E 60%,#F08C1E 80%,#FDE68A 100%)` | 品牌热谱,白名单制(§4.8) |

`--ifi-accent` 正式定义为指向 teal。**注意(G2)**:定义变量前先 grep 全部 `--ifi-primary` / `--ifi-accent` 引用处,逐一确认语义(该 teal 的指 teal、该紫的改 `--ifi-plum`),防止原本吃紫色 fallback 的 UI 突变色。`#1677ff` 全站清零。

### 3.3 语义色

danger `#CF1322`(文本)/ `#FF4D4F`(填充);success `#2F9E44`;warning 填充 = `--ifi-heat`、warning 文字 = `#B45309`;info = teal;星色 = `--ifi-heat`。

### 3.4 画布令牌

```css
--ifi-thumb-ratio: 3 / 4;   /* 图区画布;横屏时代来临翻转此值 */
--ifi-grid-min: 216px; --ifi-gap-c: 16px; --ifi-gap-r: 28px;   /* 网格 */
--ifi-strip-w: 200px;       /* 横向行卡宽 */
```

### 3.5 字体体系(自托管 woff2,`font-display: swap`)

- `--ifi-font-display`: **Space Grotesk**(标题;无 CJK 字形——中文标题回落 **Noto Sans SC 600**,规范明确 CJK 场景 display 策略,避免混排基线不齐)
- `--ifi-font-body`: **Inter**(variable),回落 `"PingFang SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif`
- `--ifi-font-mono`: **IBM Plex Mono**(400/500,~40KB)

防 CLS(D6):各字体 subset 到 latin;preload 两个关键 woff2;fallback 用 `size-adjust` / `ascent-override` 度量补偿——否则 swap 造成标题 reflow,与"CLS≈0"红线矛盾。

字阶(1.25 模数):

| 级 | 规格 | 用途 |
|---|---|---|
| Display | 32/1.15/600 SG, ls -0.01em | hub 大标题 |
| H1 | 24/1.2/600 SG | `.page-title` |
| H2 | 20/1.25/600 SG | 首页分区行标题 |
| H3 | 15/1.35/600 Inter | 卡片标题(两行 clamp) |
| Body | 14/1.55/400 | 正文 |
| Caption | 12/1.4/400 text-3 | 作者/日期/meta |
| Micro | 11/1.3/500, ls .04em, 大写 | 徽章/标签 |
| Readout | 11–13/500 mono, tabular-nums | 读数(见下) |

**mono 白名单(仪器感不廉价的边界:只给"读数",≤13px;正文/标题/按钮禁用)**:播放器温度读数(13px,首个迁移)、卡片时长 chip(11px)、时间码 `00:12.40`、评分数值 `4.6 (12)`(12px)、统计行(12px,颜色从 `#a9a9a9` 提到 text-2)。所有数字 `font-variant-numeric: tabular-nums`。

### 3.6 圆角 / 阴影 / 间距 / 动效令牌

- 圆角:`--ifi-radius-s` 8(chip/输入)、`--ifi-radius-m` 12(卡片)、`--ifi-radius-l` 16(面板/modal);antd token `borderRadius: 10` 兜底。
- 阴影四档(归拢现有 10 种手写):e1 `0 1px 4px rgba(0,0,0,.08)`(header/吸顶条);e2 `0 8px 24px rgba(0,0,0,.12)`(卡 hover,经伪元素);e3 `0 12px 32px rgba(0,0,0,.16)`(popover/FAB);e4 `0 24px 64px rgba(0,0,0,.24)`(modal)。
- 间距:`--ifi-space-1..8` = 4/8/12/16/24/32/48/64。垂直节奏:首元素距 header 24、工具条与网格 24、分区行间 40、hero 与首行 48。
- 动效:`--ifi-dur-fast` 120ms、`--ifi-dur-base` 200ms、`--ifi-dur-slow` 320ms、`--ifi-dur-max` 480ms;`--ifi-ease-out` `cubic-bezier(.25,1,.5,1)`、`--ifi-ease-inout` `cubic-bezier(.45,0,.55,1)`、`--ifi-ease-pop` `cubic-bezier(.34,1.56,.64,1)`(仅 FAB 允许过冲)。

### 3.7 antd 全局主题(`main.tsx`)

```tsx
<ConfigProvider theme={{
  token: {
    colorPrimary: '#008C8C', colorInfo: '#008C8C', colorLink: '#008C8C',
    borderRadius: 10, fontFamily: 'var(--ifi-font-body)', colorTextBase: '#213547',
    motionDurationMid: '0.2s', motionEaseOut: 'cubic-bezier(0.25,1,0.5,1)',
  },
  components: {
    Rate: { starColor: '#F08C1E' },
    Button: { colorPrimary: '#007A7A', primaryShadow: '0 2px 6px rgba(0,140,140,0.28)' },
  },
}}>
```

- **风险控制(F1)**:一次拉 67 个文件的 antd,回归面 = 全部约 15 个路由,无截图测试兜底 → 拆两步:P0 只改 colorPrimary/colorLink/Rate(色变、低风险);borderRadius 与 fontFamily 放 P0.5 单独过检。
- **Rate 星色冲突(F1)**:评分重构方案 C 里 "Your rating" 是 teal 星——全局 `starColor:#F08C1E` 会把它染橙。`rating.tsx` 的局部 ConfigProvider **必须保留**(或 className 覆盖),只删确认重复的 `AiChatWidget.tsx` 局部 Provider;`controlBar.tsx` 的 Slider token 保留至播放器改版。

---

## 4. 分区详细方案

### 4.1 Header

- 高度 72px(移动 52px)不变;背景 panel + e1。
- **Logo 重绘 SVG**(替换 lab-logo.png):线框取景器方框(四角括号,描边用热谱 linearGradient)内一个圆点热源;wordmark "Infrared Explorer" 用 Space Grotesk 600,下方 2px 热谱下划线(`border-image: var(--ifi-spectrum) 1`,宽=文字宽)。PNG 留作 favicon 过渡。
- **搜索框**:focus 时 `max-width 480→560px`(200ms ease-out)+ 焦点环 `0 0 0 3px rgba(0,140,140,.18)`;全局 `/` 快捷键聚焦(**IME 守卫**:compositionstart 期间不劫持;Esc 失焦),placeholder 尾部 kbd 样式 `/` 提示;搜索按钮随全局主题变 teal。联想候选加类型前缀图标,author 命中插 "View author's profile"(P2)。
- 路由切换:header 底部 2px 热谱进度条(`transform: scaleX` 驱动,origin left,600ms 后淡出)。

### 4.2 侧边栏

- 选中态:`rgba(0,140,140,.08)` 底 + 左缘 3px teal 竖条(`::before`,radius 0 2px 2px 0)+ 文字 `#006E6E`/600;hover 保持 `rgba(0,0,0,.06)`。
- 图标一期不动,二期统一 lucide;宽度动画缓动改 ease-out。

### 4.3 工具条(只挂在底部 All experiments 分区)

- sticky 起点改为该分区容器;**实现细节(F4)**:滚动容器是 `.content`(overflow-y auto,padding 8px)——IO 哨兵的 root 必须指定 `.content` 而非 viewport;去掉现有 `top:-8px` + 负 margin 黑魔法,改分区容器自管通栏;z-index 定 20(避让 FAB 1000 / 抽屉 1001);`.home-toolbar` 同时被 my-experiments / user-profile 复用,**拆 class 或三页一起改**。
- 材质:吸顶时浅玻璃 `rgba(255,255,255,.82) + backdrop-filter: blur(12px) saturate(140%)` + e1 + 底 1px stroke-1;`@supports not` 与低端设备回退实底 `rgba(255,255,255,.94)`(D5:旧核显滚动逐帧重采样会抖,上线前实测帧率再定去留)。玻璃拟态全站只许 header 与此工具条两处,禁用于卡片。
- 学科 chip **单选**(K12 心智是"换频道");选中态 = 学科色膜 + 1.5px 学科色描边 + **深档文字** + 字重 600 + 前置 `Check` 图标(A6:非颜色信号,色盲可辨);chip 内 emoji 换 16px lucide 学科色图标。
- **Share 移出工具条**,收进头像 Dropdown "Share this site"(教室扫码场景保留);原位改结果计数 `128 experiments`(12px mono text-3)。统计行改写为 hero 底部社会证明一行。
- 排序保持 5 项、默认 Newest(策展已由分区行承担,底部网格作兜底)。

### 4.4 Hero Featured 拼板(新组件 `src/components/home/heroBoard.tsx`)

- 形态:**1 大 + 4 小**,不做自动轮播(K12 banner blindness)。高度 `clamp(300px, 38vh, 400px)`,`grid-template-columns: 1.6fr 1fr 1fr`,主卡跨两行,gap 16px。
- **主卡「左图右文」**(3:4 内容适配 + A4 对比度一并解决):左侧 media 区约 46% 宽,竖屏画面 contain 居中 + 热晕填充;右侧实底夜蓝面板放 学科徽章、标题 22px/700 白字两行 clamp、作者 13px `rgba(255,255,255,.85)`、`Watch experiment` 实心按钮(`--ifi-teal-fill`,高 40,radius 10)。文字不压图,对比度可控。
- 4 张小卡:竖版画布 + 底部两段式渐变(下段 `rgba(11,16,38,.88)` 近实底 + 上段缓冲)+ 14px/600 白字。
- hover / focus:1.5px 热谱描边(`::before` + mask 挖空,z-index 2);主卡 hover 2–3 帧关键帧交叉淡入(每帧 1.2s,复用 Info panel 的 recording 缩略图重建;reduced-motion 关闭)——**不用 `<video>` 自动播放**(流量/功耗/投影卡顿)。
- 未登录:主卡加一句价值主张 "Explore real infrared experiments from classrooms worldwide"。
- 数据:零后端版 = **贝叶斯加权评分** `(ratingSum + m·C)/(ratingCount + C)`,C=3、m=全站均分,取 Top5(与 Top rated 的 `ratingCount≥3` 门槛统一成一个工具函数);增强版 = `heroRank` 字段 + Admin 星标置顶(P2)。
- **LCP(D1,必须与 hero 同期)**:hero 前 5 张改 `getDownloadURL` 直链 `<img fetchpriority="high">` + Storage 侧 Cache-Control;`index.html` 加 `preconnect firebasestorage.googleapis.com`。现走 `getBlob→dataURL`:无法 preload、无 HTTP/磁盘缓存、内存常驻(4GB Chromebook 压力实打实)。
- 移动端(≤768px):单张主卡(竖排:图上文下或收窄 media)+ 小卡横滑。

### 4.5 分区行(ScrollRow 复活并增强)

- 行结构:H2 行标题(20px/600,学科行前置 16px lucide 学科色图标)+ 右侧 "See all →" teal 文字链(设置对应排序/过滤后滚到底部网格)。行间距 40px,每行 8–12 张标准卡(行卡宽 `--ifi-strip-w` 200px,竖版海报行形态)。
- ScrollRow 增强(`scrollRow.tsx`):**不做 wheel 劫持**(F6:non-passive preventDefault 会吞掉纵向滚动,7 行叠起来鼠标用户一路被打断;触控板横扫原生有 deltaX);保留 pointer 拖拽(位移 >6px 才算拖,拖中 `cursor:grabbing`、临时关 snap)+ 箭头翻页;`scroll-snap-type: x proximity`;渐隐改 `mask-image` 替代覆盖 div;箭头在 `(hover:hover)` 行 hover 时淡入,**且 `:focus-within` 也显示、箭头本身可 focus**(A7:键盘/触屏可达)。

### 4.6 卡片(完整规格,card.tsx 重构)

结构:panel 白底、radius 12、静止描边 1px stroke-1、静止阴影 e1(现 `0 4px 12px` 太吵)。

- **图区**:`aspect-ratio: var(--ifi-thumb-ratio)`(3:4),背景 `--ifi-night`;内容按热晕规则渲染(同比例直接铺满;比例差 <10% cover 微裁;否则前景 contain + 背景同图 blur(22px) + `rgba(11,16,38,.45)` 压暗)。
- **图上元素(全部夜蓝玻璃,禁 backdrop-filter——A5 性能与 20+ 卡叠加成本)**:
  - 左上 26px 学科徽章:`rgba(11,16,38,.72)` 底 + 1px 学科色描边 + **提亮档**学科色图标(如 Physics `#818CF8` 级;主色图标叠同色伪彩会隐形);
  - 右下时长 chip:mono 11px/500 白字,`rgba(11,16,38,.72)`,radius 6,padding 4px 6px;
  - 左下 `MAX 84.2°C` 读数 chip(同规格、`#FFD9A8` 字,渐进增强,有字段才显示)。
- **图下信息区**(padding 10px 12px 12px):标题 15px/600 ink,两行 clamp、**min-height 固定两行**(F3:防网格行参差);作者 · 相对日期(`Intl.RelativeTimeFormat` **显式传 'en'**,title 属性放绝对日期——E4);星形(heat)+ `4.6 (12)` + 眼睛 + 浏览量,12px,mono tabular-nums;**评分/meta 行无数据时保留占位高度**。
- **hover**:`translateY(-4px) scale(1.015)`,transition 写在**基类**;阴影经 `::after` 预渲染 e2 只动 opacity;四角 L 形取景框(12px 边/1.5px/白 65%,inset 10px,200ms 渐显);遮罩瘦身为只盖图区下半 55% 渐变,只显描述(12px clamp 3 行,delay 40ms 上滑 8px 淡入)——正面已有元数据,不再重复。**触屏无 hover:接受"描述在详情页首屏可见"作为补偿,写明,验收不扯皮(C3)。**
- **可达性(A7)**:卡片由 div onClick 改 `<a>`(或 role=link + tabIndex),`:focus-visible` teal 3px 焦点环;focus 唤出遮罩保留。
- **网格**:`.card-list-wrapper { max-width:1600px; margin-inline:auto; padding-inline:clamp(24px,4vw,64px) }`;`repeat(auto-fill, minmax(var(--ifi-grid-min),1fr))`(216px),gap 16/28;≤768px minmax 150px gap 12/20;≤480px 两列或单列。
- **变体矩阵(F2,重构前定案)**:三形态 = 公开网格卡 / owner 网格卡(visibility 徽章、FeaturedBadge、owner 菜单、showUpdated 落位到信息区右上/右下)/ 横向条卡(card-strip 同步改竖版行卡,My Experiments 等使用处一并迁移,不留第三种旧形态)。点击行为、owner 菜单逻辑维持现状。

### 4.7 空态 / 骨架屏 / 错误态

- **CardSkeleton(新)**:同画布占位(跟随 `--ifi-thumb-ratio`),图区 fill-1 底 + 热谱 shimmer(`linear-gradient(105deg, transparent 30%, rgba(0,140,140,.07) 44%, rgba(224,102,42,.09) 56%, transparent 70%)`,`transform: translateX(-100%→100%)` 1.6s 循环——transform 驱动、alpha ≤9%,是"体温"不是"彩虹");`useThumbnail` 未就绪渲染骨架而非 `<></>`;首屏按 localStorage 记录的上次条数预铺;删孤立 Spin。**CLS 归零,全页 ROI 最高的一改。**
- **显影**:img onLoad `filter: saturate(0) brightness(1.08) → saturate(1) brightness(1)` 400ms——伪彩从灰度"升温显影"。豁免条件明写(单次、onLoad 触发、≤400ms、仅首屏视口内卡);低端降级(`hardwareConcurrency<=4` 或 saveData 跳终态)(D4)。
- **空态**:「热手印」SVG(iron 伪彩)+ "No heat signatures found"(16/600)+ "Try clearing the subject filter" + teal "Clear filters" 按钮。`<EmptyState image/title/action>` 复用到 Trash("All cool here")与 404("This spot has gone cold")。**手印列入热谱白名单第 6 项,且与骨架 shimmer 互斥(空态时无骨架)(G1)。**
- **错误态**:fetch 加 catch,"Couldn't load experiments" + Retry。

### 4.8 热谱白名单(每屏同时可见 ≤2 处,其余一律禁止)

① logo wordmark 下划线;② 顶部路由/加载进度条;③ hero 卡 hover 描边;④ 骨架 shimmer(≤9%);⑤ 播放器"越播越热"进度条(P2,渐变铺满全轨随播放头裁切,**保留播放头位置指示**——位置是无色觉信号);⑥ 空态热手印(与 ④ 互斥)。Me hub 头图保留既有用法。

### 4.9 FAB(AI 聊天,仅 staff 可见)

入场 load+600ms,scale .6→1,260ms ease-pop(全站唯一过冲);hover 1.06 / active .94;面板开合 origin 锚 FAB 圆心,开 200ms / 关 150ms。仅此而已。

---

## 5. 使用逻辑改造

### 5.1 首页信息架构(自上而下;除注明外全是现有全量数组的 useMemo 切片,零新增查询)

| # | 分区 | 排序/来源 | 条件 | 期 |
|---|---|---|---|---|
| 1 | Hero 拼板(1大+4小) | 贝叶斯加权评分 Top5;P2 改 heroRank | 恒显 | P1 |
| 2 | Continue watching | useViewHistory Top8(**先核 history 文档 schema**:缺 title/thumb 则写入时冗余快照;已删/转私密卡静默剔除——E3) | 登录 | P1 |
| 3 | Trending | views 降序 Top12(真"本周"需 viewsWeekly 字段,P2) | 恒显 | P1 |
| 4 | Top rated | 加权评分 Top12,`ratingCount≥3` 入选 | 恒显 | P1 |
| 5–7 | Physics / Chemistry / Biology 行 | subject + newest Top12 | 去重后 ≥4 才渲染 | P1 |
| 8 | From your classes | 班级成员公开实验 newest Top8(唯一新查询:`ownerId in [...]`,Firestore in 限 30 分批) | 登录有班级 | P2 |
| 9 | All experiments 网格 + sticky 工具条 | 现有代码下移 | 恒显 | P1 |

**硬规则(E2,不做必返工)**:自上而下渲染时**跨行去重**(已出现 id 后续行跳过),每行"去重后 <4 条不渲染";池子总量 <20 时降级为「hero + 单一网格」简版 IA。

**性能(C1)**:懒加载下沉到**行级**(每个 ScrollRow 进视口才挂载)+ **卡级**(useThumbnail 加 IO 门控,行内屏外卡不取图);底部大网格 IO 懒挂载;移动端学科行合并为一个 "Subjects" 入口或砍到 1 行。取数保持全量 getDocs,内容增长后再议 limit。

### 5.2 过滤与搜索

- 单选学科 chip;「有视频」chip 可加(duration>0 现成,P1);「有 AI 分析」需冗余布尔(P2);「调色板/温度范围」无字段不立项。**过滤维度宁缺毋滥。**
- **硬规则(F5)**:任一搜索词或非 All 学科激活 → **折叠全部策展区**,只显工具条 + 结果网格 + 结果计数;清空后恢复。
- 搜索 `/` 快捷键 + focus 展开 + 联想升级(§4.1)。

### 5.3 角色差异(只体现在"行的有无和顺序",不做两套首页)

- 未登录:Hero(带价值主张)+ Trending + Top rated + 学科行 + 网格;不弹注册墙。
- 登录学生:Continue watching 提到 Hero 下第一行;有班级加 From your classes。
- 登录教师:班级行尾加虚线 ghost 卡 "+ Assign an experiment to your class"(1px dashed stroke-2,radius 12,居中 teal 加号)——把首页从"看"接到教师核心动作"布置"。

### 5.4 Showcase / Community 双池(已实现)

底部网格从名不副实的 "All experiments" 拆成 **Segmented 双 tab**,把员工策展内容与全部用户公开内容分开:

- **Showcase**(默认)= 员工策展池(`featured`,与代码内部 `ShowcaseCard` / showcase 命名一致;hero + 上方策展行都从它切片)。副标题 `Hand-picked by the IFI team`。工具条完整:排序 + 学科 chips + `N experiments` 精确计数。
- **Community** = 全部用户公开实验,最新在前。副标题 `The latest from all explorers — newest first`。

命名裁决:选 **Showcase**(而非 Editors'/Staff picks / Featured / Gallery)——与代码词汇统一、对 K12 直白、且不与 hero 的 FEATURED 徽章撞名。

数据(`useCommunityExperiments`,**零后端改动**):`where visibility=='public' && trash==false, orderBy createdAt desc, limit 24` —— 该 list 查询被规则授权给任何人([firestore.rules](../firestore.rules) 行 34),复合索引已存在(当年为 Recent 页建的 `visibility+trash+createdAt`)。`featured` 条目 + 空缩略图客户端去重(它们已有 hero 舞台,且多为 system 种子);`hasMore` 用去重前的原始页大小判定,分页保持正确;懒取(切到 tab 才发首查询);`startAfter` + Load more 分页。

工具条差异(v1):Community **排序锁定 Newest**(服务端 orderBy;"最多浏览"需另建 `visibility+trash+viewCount` 索引,留 v2)、**学科 chips 隐藏**(客户端过滤分页数据会造成结果残缺假象,v2 建 subject 索引后服务端过滤)、计数显示 `N+ loaded`(总数未知,诚实标注)。搜索/学科过滤仅作用于 Showcase:搜索激活时强制 Showcase 为有效池;进入 Community 时清空 subject + 搜索词。`home.pool` 跨访问记住。

**K12 内容安全**:社区内容位于 tab 之后、**不进 hero/策展行**(结构性缓冲——首页门面永远是审过的策展池);空态是号召("Set one of your experiments to Public and it'll be the first")。**留待 v2**:卡片 Report 项(`reports` 集合 + Admin 复核)、员工在社区卡片一键 "feature 进 Showcase"(选材飞轮:分享→被选中→给学生的激励闭环)。

---

## 6. 动效规范

总则:除 FAB 外无弹跳、无 >480ms;新代码只动 transform/opacity(阴影走伪元素 opacity;显影 filter 为唯一豁免,条件见 §4.7);禁动 width/height/top/left(搜索框 focus 为唯一例外)。

| 元素 | 触发 | 属性 | 时长 / 缓动 |
|---|---|---|---|
| 卡片上浮 | hover(基类 transition) | translateY(-4px) scale(1.015) | 200ms / ease-out |
| 卡片阴影 / 取景框 | hover | ::after / .vf opacity 0→1 | 200ms / ease-out |
| 遮罩 + 描述 | hover 进/出 | opacity;描述 delay 40ms 上滑 8px | 180/120ms;200ms |
| 缩略图显影 | onLoad(仅首屏) | saturate(0)→1, brightness 1.08→1 | 400ms / ease-out |
| 骨架 shimmer | 循环 | translateX(-100%→100%) | 1600ms / ease-inout |
| 首挂载 stagger | 首次挂载 | opacity + translateY(10px)→0,delay min(i,12)×35ms;index 0 不做 opacity(LCP) | 320ms / ease-out |
| 过滤/排序切换 | chip/sort 点击 | View Transitions;**>60 卡直接瞬切降级(D3)**;备选 @formkit/auto-animate(3KB);chip 药丸滑移单独用 view-transition-name(单元素便宜) | 260ms / ease-out |
| sticky 工具条 | IO 哨兵 | box-shadow + 底线 | 200ms / ease-out |
| 搜索框 | focus | max-width 480→560 + 焦点环 | 200/150ms |
| 路由进度条 | 导航 | scaleX(origin left) | 600ms / ease-out |
| Hero 关键帧 | 主卡 hover | 2–3 帧 opacity 交叉,每帧 1.2s | 循环 / ease-inout |
| FAB | load+600ms / hover / 面板 | scale .6→1 / 1.06 / origin 锚点开合 | 260 / 120 / 200-150ms |
| reduced-motion | 媒体查询 | 位移/缩放/循环归零;保留 ≤150ms 纯 opacity;JS 侧 matchMedia 短路 View Transitions | — |

---

## 7. 剔除清单(否决理由存档)

1. 全站默认暗色「暗房画廊」→ 浅色 + 灯箱 + 播放器暗房先行(投影/打印刚需、成本)。
2. 页面 feTurbulence 噪点(浅色下无意义)。
3. 逐卡主色"射灯"光晕(加剧色彩噪音,违反「冷仪器」)。
4. hover"热像扫描线"(纯装饰、与取景框抢 hover 语义、高频易腻)。
5. ThermalRating 温度条评分(K12 即读性 > 品牌趣味;星色改 heat 已完成"热"叙事)。
6. 滚动"温度计进度条"(与路由进度条抢同一条线的语义)。
7. FAB"余温脉冲"(仅 staff 可见,ROI≈0)。
8. 行标题迷你光谱色带(把刚收编的噪音放回页面)。
9. Cloud Function 合成 sprite hover 播帧(被"关键帧交叉淡入"替代,零管线改造)。
10. "Hottest this week" 特殊大卡行(与 Hero 职能重叠)。
11. 统计数字滚动进场(装饰性)。
12. 调色板/温度范围过滤(无字段)。
13. wheel 劫持横向行(反模式,吞纵向滚动)。
14. 16:10 横版画布(前提不成立:内容以竖屏为主)。

---

## 8. 实施路线

### P0(1–2 天,观感换血,不动结构)

| 改动 | 文件 |
|---|---|
| 全局 ConfigProvider **第一步**:colorPrimary/colorLink/colorInfo/Rate 星色;`#1677ff` 清零;删 AiChatWidget 重复 Provider;**保留 rating.tsx 局部覆盖(Your rating teal 星)** | `src/main.tsx`、`AiChatWidget.tsx` |
| 令牌全集进 index.css(§3 全部,含画布令牌);**先 grep `--ifi-primary`/`--ifi-accent` 引用逐一确认语义再定义(G2)**;文末 reduced-motion 块 | `src/index.css` |
| emoji → lucide(`yarn add lucide-react`)+ 学科色双档系统 + chip 选中态 | `subjectMeta.ts`、`subjectTag.tsx`、`subjectFilter.tsx` |
| 卡片 hover 修复:transition 移基类、translateY(-4px)、::after 阴影 | `src/App.css` |
| CardSkeleton + `if (!dataURL) return <CardSkeleton/>`(CLS 归零) | `src/components/card/cardSkeleton.tsx`(新)、`card.tsx` |
| EmptyState 组件 + fetch catch 错误态 | `src/components/emptyState.tsx`(新)、`homePage.tsx` |
| 星色 `#fadb14` 8 处 → `var(--ifi-heat)`(rating.tsx 的 MY_STAR_COLOR 除外) | 全局替换 |
| `.card-name` 止血:两段式渐变 + 14px/600 + clamp 2,废 9px 缩放(P1 整卡重构前过渡) | `App.css`、`card.tsx` |

**P0.5**:ConfigProvider 第二步(borderRadius 10 + fontFamily),人工过检约 15 个路由(admin 表格 / analyzer 表单 / classes / settings…)。

### P1(约两周,结构升级)

1. **卡片变体矩阵定案** → 卡片重构:3:4 画布 + 图下信息区 + 热晕填充 + 时长/MAX chip + 取景框 + 显影 + stagger;card-strip 同步迁移(`card.tsx`、`experimentGrid.tsx`、`App.css`);缩略图 `width/height` 落库(写入路径 + 存量回填脚本)。
2. Hero 拼板(`home/heroBoard.tsx`):左图右文主卡 + **前 5 张 getDownloadURL 直链 + fetchpriority + preconnect(LCP,开工前定案)**。
3. 分区行:Trending / Top rated / 学科行 + **跨行去重 + <20 简版降级** + ScrollRow 增强(拖拽+箭头,无 wheel 劫持)+ 行级/卡级懒加载。
4. 工具条:sticky 哨兵(root=.content)+ 浅玻璃(带回退)+ Share 迁头像菜单 + 结果计数 + **F5 折叠规则**(`homePage.tsx`、`mainMenu.tsx`、`siteShareStats.tsx`)。
5. 搜索 `/` 快捷键(IME 守卫)+ focus 动效(`headerSearch.tsx` 约 +15 行)。
6. 过滤切换动效(View Transitions + >60 卡降级;或 auto-animate)。
7. 字体自托管(subset + preload + size-adjust)+ 字阶落位。
8. Logo SVG + 路由进度条(`layout.tsx`、`title.tsx`)。
9. Continue watching 行(先核 history schema,E3)。
10. 收尾「夜蓝 sweep」(G4):全部**图上浮层**类 `rgba(40,40,40)` / `rgba(0,0,0,.55)` 一次 grep 替换为夜蓝令牌(纯色值替换低风险;播放器**面板级**深灰留给 P2)。

### P2(结构性)

- 播放器「暗房」化:**整页暗色作用域**(嵌套 ConfigProvider darkAlgorithm + 容器级变量)+ 越播越热进度条 + mono 温度读数/时间码(全站最高频品牌触点)。
- **教室投影模式**(建议提前至 P1 尾,约一天):header 一键 → 卡片 min 216→280px、字号 +2、信息常显、隐藏侧栏/FAB、hero 渐变 alpha 提至 .95 文字加大;`html[data-projection]` + 变量覆盖,localStorage 持久化。K12 真实高频场景,竞品没有。
- From your classes 行 + 教师 ghost 卡(唯一新查询)。
- 全站暗色主题评估(zustand + ConfigProvider algorithm + 防 FOUC 内联脚本,三件套齐备才立项)。
- Hero 关键帧交叉淡入、heroRank、hasAiAnalysis 过滤、viewsWeekly 计数、多尺寸缩略图管线。
- 侧边栏图标统一 lucide;内联 style 与 styled-components 字面色值逐步收编进令牌(grep 驱动长尾)。

---

## 9. 验收红线

1. 首页 CLS ≈ 0(含字体 swap 与缩略图加载)。
2. 卡片标题最小字号 15px,9px JS 缩字永久废除。
3. 触屏正面可见:作者 / 评分 / 时长 / 浏览量。
4. `#1677ff` 与 emoji 图标全站为零。
5. 热谱每屏同时可见 ≤2 处。
6. `prefers-reduced-motion` 全覆盖。
7. **键盘**:Tab 可达首页全部交互(卡片/行箭头/chip),`:focus-visible` 焦点环全覆盖。
8. **对比度实测**(工具跑,不看设计稿):hero 文字在最亮伪彩帧上、chip 选中态文字、teal 实底按钮白字,全部 ≥4.5:1。
9. **性能预算**:4 核 Chromebook 模拟(Chrome 6× CPU throttle)首页 TTI < 5s;chip 切换无 >200ms 长任务。
10. 科学内容永不裁切(热晕填充规则生效)。

---

## 附录:后端/数据待办汇总

| 项 | 用途 | 期 |
|---|---|---|
| 缩略图 `width/height` 写入 experiment 文档 + 存量回填 | 渲染前定向(cover/热晕/骨架比例),防 CLS | P1 |
| Storage `Cache-Control` + 前 5 张走 `getDownloadURL` 直链 | LCP | P1 |
| viewHistory 文档冗余 title/thumb 快照 | Continue watching 免点查 | P1 |
| `viewsWeekly`(定时归零)| 真·本周热门 | P2 |
| `hasAiAnalysis` 布尔冗余 | 过滤 chip | P2 |
| `heroRank` 字段 + Admin 置顶入口 | 人工策展 | P2 |
