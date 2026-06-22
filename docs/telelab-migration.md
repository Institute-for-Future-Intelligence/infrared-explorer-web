# Telelab → infrared-explorer-web 移植方案(v2,经多智能体评审修正)

> 目标:把 telelab(`D:\IFI\telelab`)的全部功能(剔除直播)移植到本项目,
> 后端完全交给 Firebase(Auth / Firestore / Storage / Functions / Hosting),
> 不使用任何自建常驻服务、不使用 Docker/k8s。纯前端 SPA + Firebase 托管。
>
> v2 修正了 v1 的两处地基性结构错误(身份键、experiments 集合布局)+ 一批种子/字段/规则不一致。
> 评审结论:方向正确;v1 评级 B−,本版按全部 Critical/High 修正。

## 0. 决策汇总(已确认)

| # | 决策 |
|---|------|
| 旧数据 | **先不迁移**,Firebase 从零运营,只灌 showcase 种子数据 |
| 静态资源 | showcase 媒体沿用 Firebase Storage `videostore/` 现状;不动 intofuture.org 其它资源 |
| 派生列表 | **简化**:Trash/Raw/History/Recent/Related 用字段标记 + 单集合 query,不建独立集合 |
| clip 另存为 | **只存引用**(`recordingId` + `segments`),不复制热数据二进制 |
| Functions | **允许使用**(serverless);用于身份 claim、通知、评分聚合 |
| 角色权限 | **本次不做**(平权);但**身份 claim `mongoId` 现在就要落地**(≠ 角色) |
| 一次性脚本 | **允许**本地 firebase-admin 脚本(导种子/批处理),跑完即退 |
| **身份键** | **= 旧 Mongo ObjectId(`userId`),不是 `auth.uid`**;经 custom claim `mongoId` 注入(对齐 classroom 锁定决策) |
| **集合布局** | experiments 提为**顶层 `experiments/{expId}`**,不放 `users/{uid}` 子集合 |
| **合并** | **showcases 与用户 experiments 合并为同一个 `experiments` 集合**,用 `sourceType` 判别、`ownerId='system'` + `visibility='public'` 表达 showcase |
| **showcase 元数据** | 随合并**迁入 Firestore**(不再只当打包 JSON) |

约束澄清:"不要 node 后端" = 不要自建 Express/Mongo/Redis/Socket/Docker/k8s 这类**常驻架构**;
Firebase Functions(托管 serverless)与一次性本地脚本不在禁止之列。

## 1. 丢弃的功能(直播相关,全删)

| telelab 模块 | 原因 |
|---|---|
| `liveStream` / `waitingRoom` | 直播,依赖 Socket.io 中继 |
| `mediaStreaming`(Agora) | 音视频流 |
| `robotControl` | 树莓派/机器人控制中继 |
| `chatWidget` | 实时聊天(用评论替代) |
| 在线状态 / 房间授权 / `entities/recording` | 服务器会话与房间状态 |
| `blurredImg` | 只用于模糊已删的 RPi 实时帧,随直播一并删(**勿**误绑 disallowCopy) |

连带不再需要:MongoDB、Redis、Socket.io、Express、Agora SDK、Docker、k8s、certbot、skaffold。

## 2. 目标架构

```
React 18 + Vite (纯前端 SPA)
  ├─ Firebase Auth       … Google 登录;onAuthStateChanged 提升为应用级 useAuthInit()(见 §11)
  ├─ Cloud Firestore     … 所有元数据(见 §4),身份键 = mongoId
  ├─ Firebase Storage    … 视频/.vir/.wrk/.png/.dat 二进制(现状)
  ├─ Firebase Functions  … onUserSignIn(claim 注入)、评分聚合 + 通知(见 §6)
  └─ Firebase Hosting    … 部署(取代 gh-pages;清理 base path,见 §11)
```

热数据解析(解压 `.vir` + 按坐标取温度)**全部在浏览器端**完成
(`utils/virReader.ts` + `utils/temperatureReader.ts`),无需任何服务器查询——这是相对 telelab 的核心改进。

## 3. Firebase Storage 布局

```
videostore/{name}.mp4   … showcase 视频(sourceType:'video')
videostore/{name}.vir   … showcase 热数据(pako 压缩)
videostore/{name}.wrk   … showcase 预设(温度计/图表配置, gzip 文本)
videostore/{name}.png   … showcase 缩略图
recordings/{recId}/data_N.png|.dat … 录像帧 —— ⚠️【必需、活跃读取源】
                                      所有 sourceType:'recording' 实验逐帧来源
                                      (imagePlayer.tsx / myExperimentsList.tsx 缩略图)
thumbnails/{uid}/{expId}.png … 仅在未来需要烤入温度计叠加时启用(默认不用,见下)
```

- 用户"另存为"的 clip **不写新二进制**,只在 Firestore 存指向上述文件的引用 + segments。
- **缩略图生产者**:默认让 `thumbnailURL` 直接指向 `recordings/{recordingId}/data_{frame}.png`(零新对象、零 Function)。仅当未来丢弃 per-frame PNG 或需烤入温度计叠加时,才用 canvas 捕获写 `thumbnails/{uid}/`(注:当前 imagePlayer 用 `<img>` 非 canvas)。
- ⚠️ 种子 recording 实验若未上传对应 `recordings/{recId}/data_N` 帧文件,则**不可播放**(`imagePlayer.tsx` 无帧返回 null)。§7 必须明确:要么 seed 帧文件,要么声明为"已知不可播放的演示元数据"。

## 4. Firestore 数据模型(顶层合并集合)

> 身份键 `userId` / `ownerId` / `senderId` / `ratings` doc-id **一律 = 旧 Mongo ObjectId(`mongoId`)**,不是 `auth.uid`。

```
experiments/{expId}                       # showcase 与用户实验合并于此
  sourceType: 'video' | 'recording'        # 判别符 → 决定用 VideoPlayer 还是 ImagePlayer
  ownerId: <mongoId> | 'system'            # showcase = 'system'
  visibility: 'private' | 'unlisted' | 'public'   # 默认 private;分享=unlisted;发布/showcase=public
  displayName, author, description, subject, date, duration   # 两类共有
  # video 型独有: name(videostore slug)
  # recording 型独有: recordingId, segments:[{start,end}]|null   # segments==null = 未裁剪(Raw)
  graphsOptions: number[]
  thermalUnit: 'celsius' | 'fahrenheit'
  trash: boolean                           # 回收站标记(非独立集合)
  thumbnailURL
  viewCount                                # 全局,由 Function increment 维护(owner 不可写)
  ratingSum, ratingCount                   # 由 Function 维护(owner 不可写);ratingAvg = sum/count 读时派生
  createdAt, updatedAt
  ── thermometers/{id}  { x, y, color, value, unit, measuringAreaType,
                          measuringAreaWidth, measuringAreaHeight,
                          ownerId, visibility }      # ownerId/visibility 冗余,供 list 规则
  ── annotations/{id}   { note, x, y, dx, dy, time?:{start,end}, ownerId, visibility }
  ── comments/{id}      { senderId, senderName, senderAvatar, content, date,
                          replyTo?: <commentId> }    # 扁平 + replyTo,非嵌套数组
  ── ratings/{mongoId}  { rating }          # doc-id = mongoId,一人一票;payload 仅 {rating}

users/{userId}                             # userId = mongoId
  displayName, email, avatar, authUid, role?, createdAt
  prefs: { disallowCopy, disallowNotification, disallowNewsletter }
  ── history/{expId}    { viewedAt }        # per-user 浏览历史(自己写自己,合规)
  ── notifications/{id} { fromId, fromName, type:'comment'|'rating', expId, read:boolean, date }

usersPublic/{userId}                       # 公开只读子集:仅 displayName, avatar
                                           # (email/prefs/role 留在 users 私有文档)
```

### 派生列表 = 单集合 query(顶层合并集合,均为单复合索引)

| 页面 | 查询 | 复合索引 |
|---|---|---|
| My Experiments | `where ownerId==me && trash==false` | `(ownerId, trash, updatedAt)` |
| Trash(回收站) | `where ownerId==me && trash==true` | `(ownerId, trash)` |
| Recent | `where visibility=='public' && trash==false orderBy createdAt desc` | `(visibility, trash, createdAt)` |
| History | 读 `users/{me}/history orderBy viewedAt desc` 拿 expId 列表再批量取 | — |
| Raw Data | `where ownerId==me && segments==null` | `(ownerId, segments)`(或单独 `isRaw` 布尔) |
| Related | recording 型:`where recordingId==X && visibility in ['public','unlisted']` | `(recordingId, visibility)` |
| Showcase 首页 | `where sourceType=='video' && ownerId=='system'` | `(sourceType, ownerId)` |

> Phases 0–4 **不使用 collectionGroup**(顶层合并集合天然避开了跨用户子集合查询的行级泄漏问题)。
>
> **持久形状 vs 水合形状**:`types.ts` 应拆 **`ExperimentDoc`(落库)** 与 **`Experiment`(fetch 期合成,带 `thermometersId/commentsId` 等视图字段)** 两型;`name` 与 `sourceName` 统一。

## 5. 安全规则要点(替代 telelab Express 鉴权)

> 辅助函数:`function mongoId(){ return request.auth.token.mongoId; }`
> 通用前提:`request.auth != null && request.auth.token.email_verified == true`。

```
// ---- experiments(合并集合)----
match /experiments/{expId} {
  // 读:owner、或 public/unlisted 可见
  allow read: if mongoId() == resource.data.ownerId
              || resource.data.visibility in ['public','unlisted'];
  // 建:owner 是自己,且禁止铸造系统/公开文档
  allow create: if request.resource.data.ownerId == mongoId()
                && request.resource.data.ownerId != 'system'
                && request.resource.data.visibility != 'public'
                // 聚合字段必须初始化为 0,客户端不得自定
                && request.resource.data.ratingSum == 0
                && request.resource.data.ratingCount == 0
                && request.resource.data.viewCount == 0;
  // 改:仅 owner,且不得改 ownerId 与聚合字段(白名单)
  allow update: if resource.data.ownerId == mongoId()
                && request.resource.data.ownerId == resource.data.ownerId
                && request.resource.data.ratingSum == resource.data.ratingSum
                && request.resource.data.ratingCount == resource.data.ratingCount
                && request.resource.data.viewCount == resource.data.viewCount
                && request.resource.data.visibility != 'public';   // 发布走特殊流程/Function
  allow delete: if resource.data.ownerId == mongoId();

  // 子集合(显式叶子 match;list 规则不能 get 父文档,故 ownerId/visibility 已冗余到子文档)
  match /thermometers/{id} {
    allow read: if resource.data.ownerId == mongoId()
                || resource.data.visibility in ['public','unlisted'];
    allow write: if request.resource.data.ownerId == mongoId();
  }
  match /annotations/{id} { /* 同 thermometers */ }
  match /comments/{id} {
    allow read: if true;   // 评论公开可读(社区);如需收紧可加 visibility 冗余
    allow create: if request.resource.data.senderId == mongoId()
                  && request.resource.data.content is string
                  && request.resource.data.content.size() <= 2000
                  && request.resource.data.keys().hasOnly(
                       ['senderId','senderName','senderAvatar','content','date','replyTo']);
    allow update, delete: if resource.data.senderId == mongoId();
  }
  match /ratings/{ratingId} {
    allow read: if true;
    allow create, update: if ratingId == mongoId()
                  && request.resource.data.rating is int
                  && request.resource.data.rating >= 1
                  && request.resource.data.rating <= 5
                  && request.resource.data.keys().hasOnly(['rating']);
    allow delete: if ratingId == mongoId();
  }
}

// ---- 用户资料 ----
match /users/{userId} {
  allow read, write: if userId == mongoId();   // 私有(email/prefs/role)
  match /history/{expId}       { allow read, write: if userId == mongoId(); }
  match /notifications/{id} {
    allow read: if userId == mongoId();
    allow update: if userId == mongoId()
                  && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['read'])
                  && request.resource.data.read is bool;
    allow create, delete: if false;            // 仅 Function(Admin SDK)写;markRead 写布尔 true
  }
}
match /usersPublic/{userId} {
  allow read: if true;                         // 仅 displayName/avatar
  allow write: if userId == mongoId();
}
```

**Storage 规则**:
```
match /videostore/{file=**}            { allow read: if true; allow write: if false; }  // 公开只读
match /recordings/{recId}/{file=**}    { allow read: if request.auth != null; allow write: if false; }
                                       // ⚠️ classroom 引入私有 recording 时须改 grant 门控
match /thumbnails/{uid}/{file=**} {
  allow read: if true;
  allow write: if request.auth.uid == uid
               && request.resource.size < 2 * 1024 * 1024
               && request.resource.contentType.matches('image/.*');
}
```

要点:
- claim CF 未上线前,用 `uidMap/{authUid} → mongoId` 的 `get()` 过渡(Phase 0 临时)。
- Storage 规则只能看 `auth.uid`,故 `thumbnails/{uid}` 与未来 grant 以 **authUid** 为键 → users 文档须持久化 `authUid`。
- 规则**无法**限频:速率限制靠 App Check(Phase 0)+ Function 内通知 coalesce + 规则里 `content.size()` 上限。
- ⚠️ **Phase 0 第一步先把现网 Storage/Firestore 规则导出为基线**(`firebase storage:rules:get`),再渐进收紧,避免默认拒绝把现有 showcase/回放打成 403。

## 6. Firebase Functions(2nd gen,`region: 'us-central1'`,Firestore 在 nam5)

> Phase 0 须启用 `eventarc / run / artifactregistry` API,`setGlobalOptions({region:'us-central1'})`。

| 触发器 | 作用 |
|---|---|
| **`onUserSignIn`**(callable,Phase 0) | 首次登录:provision `users/{mongoId}`(若 email 查无)+ 写 `usersPublic/{mongoId}` + 设 custom claim `mongoId`(供 §5 规则);维持 `authUid`↔`mongoId` 映射 |
| **`onWrite experiments/{e}/ratings/{r}`**(单触发器,合并聚合+通知) | ① 用 `runTransaction` 重算父文档 `ratingSum/ratingCount`,定义 create/update/delete 语义;② 若为 create 且 `ratingUid != experiment.ownerId` 且接收者 `disallowNotification!=true`,给 owner 写一条 `notifications` |
| **`onCreate experiments/{e}/comments/{c}`** | 给 experiment.ownerId 写评论通知;`senderId==ownerId` 时跳过;读**接收者**的 `disallowNotification` |
| **`onDelete experiments/{e}/comments/{c}`** | 级联删该评论的 replies(规则不允许用户删他人 reply,故用 Admin SDK) |

设计要点:
- **聚合用事务**(而非 `increment` delta):Functions 至少投递一次、increment 非幂等;单实验评分量小,事务重算更稳且消除重试重复计数。竞态点在**父文档聚合字段**;`ratings/{uid}` 一人一条本身幂等,勿把子集合写包进事务。
- **客户端删除 `rating.tsx` 的本地聚合**,改读 `experiment.ratingAvg(=sum/count)/ratingCount`,否则聚合形同虚设。
- **通知接收者 = author-only**:显式记录**丢弃** telelab 的"线程全体参与者 + 硬编码 admin id"fan-out(简化,可接受)。
- `disallowNotification` 语义重定义为"不为我创建站内通知"(telelab 仅挡邮件;新语义更贴合 UI 文案)。
- 合并集合后,**showcase 评分/评论与用户实验走同一路径**,Function 自动同时覆盖两者(消除 v1 只覆盖一侧的漏洞)。

## 7. 一次性本地脚本(`scripts/`,firebase-admin,跑完即退)

- `seedExperiments.ts`:把 `db/showcases.json` + `db/staffpicks.json` 合并写入顶层 `experiments`:
  - 字段 normalize:`display_name → displayName`;补 `ownerId:'system'`、`visibility:'public'`、`ratingSum:0/ratingCount:0/viewCount:0`。
  - **`sourceType`**:showcases.json → `'video'`(带 `name` slug);staffpicks.json → `'recording'`(带 `recordingId`/`segments`,Image 型)。
  - **id 规范化**:`staffpicks` 的 `id:"clip/60bff8c3..."` 去掉 `clip/` 前缀(含 `/` 不能做 doc id)。
  - 明确是否一并上传对应 `recordings/{recId}/data_N` 帧文件(否则 recording 型种子不可播)。
- 种子评论:字段统一 `senderId`(小写)。
- 种子评分:**doc-id = `userID`**、payload 仅 `{rating}`、**去重**(每 (expId,uid) 至多一条);删掉 v0 种子里同一 user 对同一实验的 3 条重复票。
- 角色相关脚本留到 classroom 阶段。

## 8. 功能清单(telelab 全量,标注去留与归属)

| 功能 | 去留 | 现状 / 归属 |
|---|---|---|
| Google 登录 | ✅ | Firebase Auth(已接);**需修首登 no-op + onUserSignIn provision**(§11) |
| Showcase 展示馆 + staffpicks | ✅ | 合并进 `experiments`(`ownerId:'system'`),homePage 改 Firestore 查询 |
| 录播回放(视频/逐帧) | ✅ | Video/Image Player(已有);`sourceType` 分支 |
| 温度计(点) | ✅ | thermometers(已有) |
| 测量区域(点/椭圆/矩形) | ✅ 补 | thermometer 加 measuringArea 字段 |
| 图表 T(t)/T(x)/T(y) | ✅ | charts(已有) |
| T(r) / 等温线 Isotherms | ✅ 补 | d3-contour(`contour.tsx`) |
| 标注 Annotation | ✅ 补 | annotations 子集合 + UI |
| 摄氏/华氏切换 | ✅ 补 | thermalUnit 字段 |
| My Experiments 列表 | ✅ 补全 | myExperimentsList(改顶层集合查询) |
| 克隆整段(只存引用) | ✅ 补 | **近乎免费**,复用现有段感知回放 → 优先,解锁 Raw/Related/Recent |
| 裁剪 = 新建 segments | ✅ 补 | ⚠️ telelab 剪辑编辑器**完全没移植**,Phase 1 主体工作量(全新交互) |
| 删除→回收站 / 恢复 / 清空 | ✅ 补 | trash 标记 + query |
| Raw / History / Recent / Related | ✅ 补 | 单集合 query(§4) |
| 评论(增删改 + 回复) | ✅ 补全 | commentList 已存在但 **submit 是空操作**;需接 submit + 对齐数据模型(replyTo 非嵌套数组) |
| 评分 | ✅ 补全 | rating.tsx 已读,需加**写入** + 修 **ratingCount(现算成星值之和)** + 改读聚合字段 |
| 通知 | ✅ 补 | Function 触发(§6) |
| 账户资料 | ✅ 补 | users 文档;avatar **复用 Google photoURL 无上传**;**nickname 唯一性本阶段放弃**;clipCount/commentCount 归属写死 |
| 分享链接 | ✅ | shareLinks(已有);依赖 §5 visibility 读规则 |
| 导出(截图/CSV/图像) | ✅ 补 | 移植 `file.ts`;新依赖 papaparse / html2canvas |
| Contact-us | ⚠️ 定 | Function+SendGrid / Formspree / 显式删 |
| Cookie 同意 | ✅ | 保留 `acceptCookie` |
| Team / About | ✅ | 静态保留 |
| 远程日志 `remoteLogger` | ⚠️ **构建级** | 将移植的文件(clipAnalyzer ~25、showcase ~20…)都 import 它且打 `/api/logs` → **移植时删 Logger.* 行,或保留 `logger.ts` no-op/Analytics shim 让代码可编译** |
| Housekeeping | ❌ | 删(Firebase 无服务器 FS) |
| Users 管理表 | ⏸ | 随角色 defer |
| 角色权限(Admin/Teacher/…) | ⏸ | 留 classroom 阶段(但身份 claim 现在就做) |
| 直播/机器人/聊天/在线/blurredImg | ❌ | 删(§1) |

## 9. 分阶段实施

- **Phase 0 — 基建 + 地基修正(最关键)**
  - 加 `firebase.json` / `.firebaserc` / `firestore.rules` / `storage.rules` / `firestore.indexes.json` / `functions/`
  - **先导出现网规则为基线**,再渐进收紧;加 **emulator 套件**(`firebase.ts` 内 `connect*Emulator` 受 `import.meta.env.DEV` 控制)
  - **`onUserSignIn` Function**:provision `users/{mongoId}` + `usersPublic` + 注入 `mongoId` claim;过渡期 `uidMap`
  - **修 `signInButton` 首登 no-op**(查无文档则建);**`onAuthStateChanged` 提升为应用级 `useAuthInit()`**;`firebase.ts` 导出 `firebaseAuth`
  - **types.ts 清理**(删 active/Streaming/LiveRecording/piCar/microphone/roster)+ 加 §4 新字段 + 拆 `ExperimentDoc`/`Experiment`
  - **GitHub Pages → Hosting 清理**:删 `vite.config.ts` 的 `base`;改 `constants.ts` 的 `HOME_URL`;同步 `shareLinks` 链接与 router 模式;`package.json` homepage
  - `scripts/seedExperiments.ts` 灌合并种子;删 `experimentAnalyzer.tsx` 对 `upload.ts` 的死导入与 `src/upload.ts`
  - Functions region/API 启用
- **Phase 1 — clip 管理**
  - 先做**克隆整段(只存引用,免费)**解锁 Raw/Related/Recent;再做**裁剪编辑器**(主体)
  - My Experiments 改顶层集合查询;Trash/恢复/清空;History 走 per-user 子集合
  - **缓存失效**:`common.ts` 五个 Map 补 `delete/clear`;放开 `experimentAnalyzer` 命中缓存后永不重取的守卫;切换实验/卸载时清 thermometer/comment map
- **Phase 2 — 社交**
  - 评论增删改+回复(对齐数据模型:replyTo 扁平、senderId 小写、senderAvatar 冗余);评分写入 + 修 ratingCount;Functions(聚合+通知);通知中心 UI
  - 迁移清单三项:**字段大小写统一 / ratings 改键(doc-id=uid)/ ratingCount 修复**
- **Phase 3 — 分析增强**
  - 测量区域(椭圆/矩形);等温线 Isotherms;T(r);标注 Annotation;单位切换
- **Phase 4 — 账户与导出**
  - 账户资料/偏好;截图/CSV/图像导出(papaparse/html2canvas)
- **Phase 5 — 收尾**
  - Security Rules 加固(字段白名单全覆盖);索引核对;App Check;生产部署;(角色与 classroom 对齐另议)

## 10. 风险 / 待办

- **复合索引**:见 §4 表;Phases 0–4 **不使用 collectionGroup**。
- **owner 伪造聚合字段**:§5 已用白名单禁止 owner 写 `ratingSum/ratingCount/viewCount` 与铸造 `ownerId:'system'`/`visibility:'public'`。
- **通知防滥用**:App Check(Phase 0)+ Function 内 coalesce(同 type+expId+fromId 未读则更新而非新建);`disallowNotification` 读**接收者** pref。
- **classroom 前向对齐(防呆)**:
  - classroom 实体(`classes/{classId}/...`)故意**顶层**,勿"整理"进 `users/{uid}` 子树重新引入跨用户读。
  - **clone(只存引用)≠ classroom 提交(frozen-snapshot)**:提交是去归一化快照,独立写入 `classes/{id}/submissions/{studentId}_{expId}`(确定性 doc-id、可覆盖刷新),**勿复用 clone helper**。
  - `users` 接口加 `role?` / `authUid?`(本阶段零行为,仅一致性)。
  - `recordings/**` 当前 authenticated-read **仅因**是无主种子语料;classroom 引入私有 recording 时须收紧为 grant 门控。
- **字段一致性清单(细化,非泛泛"确认")**:`senderID→senderId`、ratings doc-id=uid 且 payload 仅 `{rating}`、`ratingCount` 用条数非星值之和、thermometer `measuringAreaType/Width/Height`、annotation `note/x/y/dx/dy/time`、staffpicks `clip/` 前缀 id 规范化、`display_name→displayName`。

## 11. 现有代码已确认缺陷(Phase 0/1/2 须修)

| 位置 | 缺陷 | 修法 |
|---|---|---|
| `signInButton.tsx:14-26` | `setUser` 只在 `forEach` 内调 → **新 Google 用户查无文档 = 永远登出态** | 查无则 provision;`setUser` 移出 forEach |
| `signInButton.tsx:21` | `id` 取 `doc.data().id`(ObjectId)→ 与 `auth.uid` 不一致(规则用 ObjectId) | 保持 ObjectId,经 §6 claim 落库 |
| `signInButton.tsx:12` | 唯一的 `onAuthStateChanged` 寄生在登录按钮 useEffect,登录后按钮卸载 → 刷新可能丢 user | 提升为应用级 `useAuthInit()` |
| `firebase.ts` | 不导出 `auth`;各处裸调 `getAuth()` | 导出 `firebaseAuth` |
| `rating.tsx:28` | `setRatingCount(total)` total=**星值之和**非条数;`Math.round` 丢小数 | 改读 `experiment.ratingCount`,avg=sum/count |
| `upload.ts` | 评论 `senderID`(大写)、ratings 随机 id + 重复票、内嵌陈旧模型 | 迁 `scripts/`,按 §4/§7 重生成 |
| `experimentAnalyzer.tsx:20` | 死导入 `upload.ts` | 删 |
| `common.ts` | 五个 Map 只 set 不 delete,写后显示陈旧 | 补失效路径 |
| `vite.config.ts:13` | `base:'/infrared-explorer-web'`(GH Pages) | 迁 Hosting 时删 |
| recharts | 钉 `2.13.0-alpha.4` 预发布(yarn.lock 锁定) | `yarn upgrade recharts@^2.13` 提交 lock;删分叉的 `package-lock.json` |
