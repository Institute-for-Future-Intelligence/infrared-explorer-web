# Telelab 全量用户数据迁移计划

> 目标：把旧 telelab（MongoDB Atlas）里**全部 593 个用户、1112 条实验、相关测温点/评论/评分**迁移进新版 Firebase（`infrared-explorer`），让**老用户用 Google 登录后立即看到并能编辑自己以前的所有实验**；同时修复 charles 及其余 259 个录像缺失的帧。
>
> 状态：方案设计稿（经 4 路并行设计 + 2 路对抗性评审 + 对 Atlas/Firebase 实测校验）。所有数字均为 **2026-06-24 实测**。
>
> 关联记忆：`telelab-atlas-source`、`telelab-migration-decisions`、`telelab-recordings-recovery`。

---

## 0. 一页纸总览

| 维度 | 旧 Atlas（源） | 新 Firebase（目标） | **待迁移差距** |
|---|---|---|---|
| 用户 | 593 | 3 | **590** |
| 实验/clip（非回收站） | 1112 | 已迁 88 | **1024** |
| 引用的录像 | 320（被非回收站 clip 引用） | Storage 有 74 个 | **259 需恢复帧**（约 90% 可从 telelab2 取回，约 10% 可能永久丢失） |

**源**：MongoDB Atlas，`cluster-telelab.n3yjy.mongodb.net`，db `heroku_nvhk53z3`（连接串在 `D:\IFI\telelab\infra\k8s-prod\server-depl.yaml` 的 `DB_URI`）。当前 IP 允许列表可直连，读已验证。
**目标**：Firebase 项目 `infrared-explorer`，bucket `infrared-explorer.appspot.com`。

**整体顺序**：`冻结登录 + 卸载触发器 + 基线快照` → `用户` → `实验+子集合` → `帧恢复` → `(可选)社交/通知/历史` → `验证` → `重新部署触发器 + 解冻登录`。

---

## 1. 身份绑定——为什么这套能让老用户"看见"数据（核心）

新版 App 的身份键是**旧 Mongo ObjectId（`mongoId`）**，不是 Firebase `auth.uid`。三条事实决定了迁移策略：

1. **登录回绑按 email 匹配**：`functions/src/index.ts` 的 `onUserSignIn` 在没有 claim 时执行 `users.where('email','==',email).limit(1)` → `mongoId = data().id ?? doc.id`，然后写回 `authUid`、铸造自定义声明 `mongoId`。
   → **只要我们把每个老用户写成 `users/{mongoId}`（doc id = mongoId，字段 email 正确），他下次 Google 登录就会自动绑回原 mongoId**，于是 `experiments where ownerId==mongoId` 查到他全部迁移的 clip。
2. **读权限**：`firestore.rules` 中 experiments 读允许 `visibility in [public, unlisted] || isOwner`。`isOwner` 依赖 mongoId claim。**因此迁移的 clip 必须是 `unlisted`（不是 private）**，这样即使 claim 还没下发，老用户也能读到自己的数据。
3. **写权限**：重命名/裁剪/保存分析/评论/评分都走 `isOwner` → 需要 claim（`onUserSignIn` 铸造）+ `email_verified==true`。

**实测把风险大幅消除**：
- **593 个用户 email 全部唯一、0 个重复、0 个空 email**（按规范化小写比较）。→ 不存在"重复 email 拆分/别名"问题，无需 `ownerAliases`，无人因 email 丢失而无法认领。
- 旧 telelab 仅用 Google OAuth（每个 User 都有 `providerID` = Google sub）→ 老用户重新登录即 `email_verified==true`，不触发只读锁死。
- 现有 3 个用户的 email 均为小写（`charles@/xiaotong@intofuture.org`、`xiaotong.ding0223@gmail.com`），与 Google token 的小写 email 一致。

> ⚠️ 仍要做的两件事（见 §6）：迁移期间**冻结登录**（避免 onUserSignIn 在用户文档写入前给老用户铸造一个全新 ObjectId 造成重复账号）；email 一律**小写写入**（Google token 本就是小写，确保精确匹配）。

---

## 2. 数据模型映射（源 → 目标）

### 2.1 源（Atlas，mongoose model → 集合名）

| 集合 | 含义 | 关键字段 |
|---|---|---|
| `users` (593) | 用户=身份 | `_id`(=mongoId), `email`, `firstName/lastName/nickname`, `role`, `profile`, `disallowCopy/Notification/Newsletter`, `providerID`, `createdAt` |
| `profiles` (598) | 头像 | `avatar`, `owner`→User |
| `recordings` (686) | 录像/episode | `_id`(=recordingId), `lastFrameNumber`, `topic`, `room` |
| `userrecordingconfigs` (1204；非回收站 1112) | **clip=拥有的实验** | `_id`(=clipId), `user`→User, `recording`→Recording, `segments:[{startFrame,endFrame}]\|null`, `trash`, `viewCount` |
| `experiments` (633) | **clip 的元数据/分析（ExperimentState）**，按字段 `id`(=clipId) 索引 | `displayName`, `author`, `description`, `subject`, `duration`, `date`, `unit`, `graphsOptions[]`, `thermometers[]`(ThermometerState 的 id), `annotations`(JSON 字符串), `currentFrameNumber`, `thumbnailURL` |
| `thermometers` (1798) | 测温点状态（ThermometerState），按字段 `id` 索引 | `id,x,y,color,value,unit,measuringAreaType,measuringAreaWidth,measuringAreaHeight` |
| `comments` (105) | 评论 | `expID`(=clipId), `sender`→User, `content`, `date`, `reply:[Comment _id]`(线程), `type` |
| `ratings` (65) | 评分 | `expID`(=clipId), `user`→User, `rating` |
| `notifications` (420) / `historyclipconfigs` (1345) | 通知 / 浏览历史 | 可选迁移（见 §4.5） |

### 2.2 目标（Firebase）

```
experiments/{clipId}                        ← clipId = UserRecordingConfig._id（保留，作精确去重）
  ├─ thermometers/{thermId}                 ← thermId = ThermometerState.id 字段
  ├─ comments/{commentId}                   ← commentId = Comment._id
  ├─ ratings/{raterMongoId}                 ← doc id = 评分者 mongoId
  └─ annotations/{deterministicId}
users/{mongoId}                             ← doc id = mongoId（onUserSignIn 要求）
  └─ history/{expId}                        ← 可选
usersPublic/{mongoId}                       ← {displayName, avatar}，他人看评论/作者头像要用
Storage: recordings/{recordingId}/data_<N>.{png,dat}
```

### 2.3 三个"会静默丢数据"的映射陷阱（已实测定论）

1. **segments 必须改名**：源是 `{startFrame, endFrame}`，新 App 类型是 `Segment = {start, end}`（`src/types.ts:23`，`hooks.ts:13` 解构 `{start,end}`）。**必须 `{startFrame→start, endFrame→end}` 重映射**，否则所有分段 clip 播放错乱。（注意：现有 `scripts/migrateUserExperiments.mjs` 是从 FB 嵌套层直传 `segments`，对 Atlas 源不可照搬。）
2. **annotations 字段名**：实测存储字段是 `annotations`（复数，327 条非空；`annotation` 单数 = 0 条）。但很多值是空数组字符串 `"[]"`——**`JSON.parse` 后仅迁移非空数组**。
3. **547 条 clip 没有 ExperimentState**（无 displayName/duration）：
   - `duration=0` 会让播放器算出 `lastFrameIndex = duration*5 - 1 = -1`（FPS=5，`hooks.ts:48`）→ **整段空白播放，跟恢复多少帧无关**。
   - 修复：对无元数据的 raw clip，**`duration = recording.lastFrameNumber / 5`**，并令帧恢复的帧集对齐 `1..lastFrameNumber`。
   - displayName 回退：`recording.topic || 'Untitled ' + 日期`。

---

## 3. 字段映射详表

### 3.1 `users/{mongoId}`（doc id = `User._id.toHexString()`）

| 目标字段 | 源 | 处理 |
|---|---|---|
| *(doc id)* & `id` | `User._id` | 24-hex 字符串，两处一致（onUserSignIn 读 `data().id ?? doc.id`） |
| `email` | `User.email` | **`trim().toLowerCase()`**（匹配 Google token） |
| `emailRaw` | `User.email` | 原始大小写，仅审计 |
| `displayName` | `nickname` ‖ `firstName+lastName` | 取非空 nickname；否则 `firstName lastName`；再否则 `email` 前缀；保证非空 |
| `avatar` | `profiles.avatar`（`owner==_id`，按 `createdAt` 取最新一条）| 无则 `null` |
| `role` | `User.role` | `(role??'Student').toLowerCase()` |
| `providerID` | `User.providerID` | 保留（Google sub，取证用） |
| `prefs.{disallowCopy,disallowNotification,disallowNewsletter}` | 同名 | `!!` 强制布尔 |
| `createdAt` | `User.createdAt` | `Timestamp.fromDate`，**保留原始时间**；缺失才 `serverTimestamp()` |
| `authUid` | — | **不写**，留给首次登录的 onUserSignIn merge |
| `migratedAt`/`migratedSource:'atlas-users'` | — | 溯源+回滚筛选 |

同时写 `usersPublic/{mongoId} = {displayName, avatar}`（否则他人看该用户的 clip/评论时作者名与头像为空）。

### 3.2 `experiments/{clipId}`（clipId = `UserRecordingConfig._id`）

| 目标字段 | 源 | 处理 |
|---|---|---|
| `sourceType` | — | `'recording'` |
| `ownerId` | `clip.user` | mongoId 字符串 |
| `visibility` | — | **`'unlisted'`** |
| `displayName` | `ExperimentState.displayName` | 无元数据 → `recording.topic || 'Untitled '+date` |
| `author` | `ExperimentState.author` | 若是 userId 则查用户名；否则原样字符串；缺失用 owner 的 displayName |
| `description/subject/date` | 同名 | `subject` 校验属于 `{not available,chemistry,physics,biology}` 否则置 `null` 并记日志 |
| `duration` | `ExperimentState.duration` | **无元数据 → `recording.lastFrameNumber/5`**（避免空白播放） |
| `thermalUnit` | `ExperimentState.unit` | `celsius`/`fahrenheit`，缺失 `celsius` |
| `graphsOptions` | `ExperimentState.graphsOptions` | 缺失 `[]` |
| `segments` | `clip.segments` | **`[{startFrame,endFrame}] → [{start,end}]`**；空/null → `null` |
| `isRaw` | — | `!segments` |
| `recordingId` | `clip.recording` | 字符串 |
| `thumbnailURL` | — | `recordings/{recordingId}/data_{frame}.png`，`frame = currentFrameNumber || 1`；**该 frame 必须在帧恢复并集内**（见 §4.3） |
| `viewCount` | `clip.viewCount` | 缺失 0 |
| `ratingSum/ratingCount/commentCount` | 由评分/评论**直接算好写入**（不靠触发器） | |
| `trash` | `clip.trash` | 非回收站迁移；回收站默认**跳过**（可选迁移并置 `trash:true`） |
| `createdAt/updatedAt` | `clip.createdAt` / `ExperimentState.timeStamp` | 缺失才 `serverTimestamp()`；**统计有多少条用了合成时间**（会影响"我的实验"排序） |

> 孤儿录像分支：若 `clip.recording` 在 `recordings` 集合查不到 → 记入 `orphans.json`，`thumbnailURL=''`、`isRaw` 但无法算帧范围 → 该 clip 迁移元数据但标记不可播。

### 3.3 子集合

- **thermometers/{thermId}**：遍历 `ExperimentState.thermometers[]`（id 列表）→ 查 `thermometers`（按 `id`）→ 写 `{id,x,y,unit,measuringAreaType,measuringAreaWidth,measuringAreaHeight, ownerId, visibility:'unlisted'}`。丢弃瞬态 `value`、`color`。`measuringAreaType` 实测值为 `Point/Rectangle/Ellipse/null`，**与 App 枚举一致，原样透传**（null 时 App 默认按点处理）。
- **comments/{commentId}**（commentId = `Comment._id`）：`{senderId: sender, senderName/senderAvatar: 查 usersPublic, content, date, replyTo?}`。**线程展平**：由父评论的 `reply[]` 建子→父映射，子评论写 `replyTo=父id`。**悬挂引用处理**：若 `replyTo` 指向的父评论不存在 → **丢弃 replyTo（提升为顶层）**，否则该评论在 UI 既不算顶层也找不到父，会消失。
- **ratings/{raterMongoId}**：`Rating where expID==clipId` → 按评分者 mongoId 去重（一人一票，后写覆盖）→ `{rating}`；同时把 `ratingSum/ratingCount` 直接写到父 experiment。
- **annotations/{deterministicId}**：`JSON.parse(ExperimentState.annotations)`，非空才迁移；id 用**确定性 id**（如 `clipId_序号` 或内容 hash）保证可重入幂等；写 `{x,y,dx?,dy?,note,time?, ownerId, visibility:'unlisted'}`。

---

## 4. 分阶段执行

> 全部脚本：本地 `node` + `firebase-admin` + `mongodb` 驱动，**默认 DRY-RUN**，`WRITE=true` 才落库；逐条 `skip-if-exists` 幂等、可断点续跑。

### Phase 0 — 准备（不可省）
1. **冻结登录**（见 §6.1）：临时**卸载 `onUserSignIn`**（`firebase functions:delete onUserSignIn`）或在客户端加维护开关——阻止迁移期间老用户被铸造新 ObjectId 造成重复账号。
2. **卸载会被批量写触发的 Cloud Function**：`aggregateRatings`、`aggregateCommentCount`、`notifyOnComment`、`onExperimentDeleted`（`firebase functions:delete ...`）。否则批量写子集合会引发**通知风暴 + 每条评分跑全量事务**，且 `onExperimentDeleted` 会干扰回滚。聚合值我们在脚本里直接算好写入。
3. **基线快照** `dumpBaseline.mjs`：导出当前 `experiments`、`users`、`usersPublic` 全量到本地 JSON（回滚基线）。
4. **预检**：Atlas 只读连通、`serviceAccount.json` 就位、确认 `storage.rules` 中 `recordings/{recId}/{file=**}` 为 `allow read: if true`（**已确认公开可读**，登出/匿名也能播放帧）。
5. **跑 `makeClipsUnlisted.mjs`（无条件、全量）**：把已迁移的 88 条里仍为 `private` 的翻成 `unlisted`，避免老用户 403 自己的旧 clip。

### Phase 1 — 用户 `migrateUsers.mjs`
- 读 593 个 `users` + `profiles`（按 owner 聚合头像，按 createdAt 取最新）→ 写 `users/{mongoId}` + `usersPublic/{mongoId}`。
- 幂等：`users/{mongoId}` 已存在则 merge（不覆盖 `authUid`）。**对现有 3 个用户**：仅校验其 `email` 已是小写（实测是），不动其它字段。
- 输出：写入数、跳过数、合成 createdAt 数。

### Phase 2 — 实验 `migrateClips.mjs`
- 游标遍历 `userrecordingconfigs`（`trash != true`，1112 条），按 §3.2/§3.3 转换。
- **去重已实测可靠**：88 条已迁移 clip 的 Firebase doc id 恰等于其 Atlas `_id`（实测 1112−1024=88 命中）→ `experiments/{clipId}` 已存在则**整条跳过**。
- **子集合按子文档级幂等**（每个 thermometer/comment/rating/annotation 各自 skip-if-exists），这样社交写入中断后**续跑能自愈**，不会因父已存在而漏写子文档。
- Firestore 批量 ≤ 500/批；记录无元数据(547)、孤儿录像、合成时间的统计。

### Phase 3 — 帧恢复 `backfillFrames.mjs`（独立、耗时长）
- 源 `https://telelab2.intofuture.org/public/episodes/<rec>/data_<N>.{png,dat}` → 目标 `recordings/<rec>/data_<N>.{png,dat}`。
- **每个录像要拷的帧集 = 其所有非回收站 clip 的帧并集**：
  - 分段 clip：各 `segment` 的 `startFrame..endFrame` 并集（录像帧空间）。
  - raw clip（segments=null）：`1..recording.lastFrameNumber`（= duration×5）。
  - **强制把每个 clip 的缩略图帧（currentFrameNumber||1）并入**，否则缩略图指向未恢复的 `data_1.png` 会破图。
- **先探测后拷**：对 259 个录像逐一 `HEAD data_1.png`，生成清单；**约 10% 404 的录像**记为不可恢复 → 其 clip 标记不可播（建议在卡片上打标，不隐藏）。
- 幂等/可续：拷前 `file.exists()` 跳过；进度写 `frameProgress.json`；并发限流 + 指数退避；content-type：`.png`→`image/png`，`.dat`→`application/octet-stream`。
- **先跑 charles 的 5 clip / 4 录像子集**做端到端验证（修复其遗漏数据，同时验证整条链路）。
- 量级提示：662 个录像中位 200 帧、最大 28909 帧、总计 ~55 万帧；259 个录像的并集预计**十万级文件、数 GB**——安排在低峰/夜间，关注 Atlas 出网与 Storage 写入配额。

### Phase 4 —（可选）社交补充 / 通知 / 历史
- 评论、评分已在 Phase 2 子集合内完成。
- `notifications`（420）、`historyclipconfigs`（1345）价值低、量大：**默认不迁移**；若要，单独 `migrateNotifications.mjs` / `migrateHistory.mjs`，写 `users/{mongoId}/notifications`、`users/{mongoId}/history/{expId}`。

### Phase 5 — 验证 + 收尾
1. 跑 `verifyMigration.mjs`（§7）。
2. **重新部署**全部 Cloud Function（含 `onUserSignIn` 与 4 个触发器）。
3. **解冻登录**。
4. 真机冒烟：用一个迁移用户的 Google 账号登录，确认拿到 claim、能看到且**能编辑**其旧 clip。

---

## 5. 推荐脚本集（放 `scripts/`）

| 脚本 | 职责 |
|---|---|
| `dumpBaseline.mjs` | 导出 experiments/users/usersPublic 基线（回滚用） |
| `migrateUsers.mjs` | Atlas users+profiles → users/{mongoId} + usersPublic |
| `migrateClips.mjs` | Atlas clips(+ExperimentState/thermometers/comments/ratings/annotations) → experiments/{clipId}+子集合 |
| `backfillFrames.mjs` | telelab2 → Storage recordings/ 帧恢复（探测+并集+续跑） |
| `migrateNotifications.mjs` / `migrateHistory.mjs` | 可选 |
| `verifyMigration.mjs` | 只读验证套件 |
| `rollback.mjs` | 分阶段回滚（含清 claim） |

> `scripts/migrateUserExperiments.mjs`（从 FB 嵌套层迁移）**退役**——源头改为 Atlas，且它的 `segments` 直传、`visibility:'private'` 与新方案冲突。保留备查即可。

---

## 6. 风险登记（来自对抗性评审，含对策）

### 6.1 关键（必须在 WRITE 前处理）
1. **迁移期间老用户登录 → 被铸造新 ObjectId / 重复账号**。
   对策：Phase 0 **冻结登录**（卸载 `onUserSignIn` 或维护开关），用户+实验全部写完再解冻。补救：收尾跑一遍"同 email 多 users 文档"合并 sweep。
2. **触发器风暴 / 与回滚冲突**：批量写子集合会触发 `aggregateRatings`(全量事务)+`notifyOnComment`(通知)+`aggregateCommentCount`。
   对策：Phase 0 **卸载 4 个触发器**，脚本直接写 `ratingSum/ratingCount/commentCount`，Phase 5 再部署。
3. **segments 不改名 → 分段 clip 播放错乱**；**547 条无 duration → 空白播放**；**annotations 字段名**。
   对策：§2.3 已定论（`{startFrame,endFrame}→{start,end}`；duration 由 lastFrameNumber/5 兜底；字段名 `annotations` 且跳过 `"[]"`）。

### 6.2 重要
- **email 大小写**：一律小写写入 `email`；现有 3 个用户已是小写（实测）。**不改 onUserSignIn 读端**（Google token 本就小写），避免反而把已登录用户匹配丢。
- **email_verified 门槛**：规则要求 `email_verified==true` 才能 isOwner。旧 telelab 全 Google OAuth → 重新登录即 true，**风险低**；仍在验证脚本里抽样确认冒烟账号能写。
- **fallback 只读幽灵态**：若登录潮中 `onUserSignIn` 抛错，`auth.ts` 回退按 email 解析身份但**不铸造 claim** → 用户能看 unlisted clip 却所有写操作被拒。冒烟测试要确认"新 token 里有 mongoId claim"，而不仅是"能看到 clip"。
- **缩略图帧未恢复 → 破图**：缩略图帧强制并入帧并集（§4.3）。
- **回滚要清 Auth claim**：迁移窗口内登录过的用户，Auth 里残留 mongoId claim（不在 Firestore）；回滚须 `setCustomUserClaims(uid, null)` + 删 `uidMap/{uid}`，否则重做时 claim 短路 onUserSignIn 绑到已删 id。

### 6.3 已被实测排除的风险
- 重复 email / 空 email / 因 email 拆分丢数据 → **0 例**，无需别名机制。
- 去重键不可靠 → **已实测 88 条命中**，`experiments/{Atlas _id}` 即去重键，可靠。
- Storage 帧读权限 → **已确认公开可读**。
- measuringAreaType 大小写不匹配 → **实测值即 App 枚举**，原样透传。

---

## 7. 验证套件 `verifyMigration.mjs`（只读，可重复跑）
1. **计数对齐**：`users` ≈ 593；`experiments`(ownerId≠system) = 88 + 新迁移数；每个用户 `ownerId==mongoId` 的 owned 数 == 其 Atlas 非回收站 clip 数。
2. **返回用户模拟**：抽样若干迁移用户 → 按 email 查到 mongoId → `experiments where ownerId==mongoId && trash==false` 有结果且全 `unlisted`。
3. **可播性**：抽样 clip 的 `recordingId` 在 Storage 有帧；缩略图帧存在。
4. **子集合完整性**：抽样 clip 的 thermometers/comments/ratings 数与 Atlas 一致；`ratingSum/ratingCount/commentCount` 正确。
5. **可见性**：迁移 clip 中 `private` 计数 = 0（含已存在的 88）。
6. **报告**：无元数据数、孤儿录像数、不可恢复录像数、合成 createdAt 数。

---

## 8. 回滚（分阶段）
- **用户**：删 `migratedSource=='atlas-users'` 的 `users/{id}`+`usersPublic/{id}`（不动现有 3 个）。
- **实验**：删迁移集合内（按 Atlas `_id`，且非基线已存在）的 `experiments/{id}` 及子集合；**回滚要在重新部署 `onExperimentDeleted` 之前**做。
- **claim/uidMap**：对窗口内登录过的用户清 Auth claim + 删 `uidMap`。
- **帧**：保留即可（公开只读、无害）；或按清单删 `recordings/{id}/`。
- 顺序：先回滚数据 → 再恢复触发器/登录。

---

## 9. 上线检查清单
- [ ] Atlas 只读连通、`serviceAccount.json` 就位、基线已导出。
- [ ] 已冻结登录、已卸载 `onUserSignIn` + 4 个触发器。
- [ ] `makeClipsUnlisted.mjs` 全量跑过（88 条无 private）。
- [ ] DRY-RUN：users / clips / frames 三脚本输出审阅无误（关注 547 无元数据、孤儿录像、404 录像清单）。
- [ ] WRITE：用户 → 实验 → 帧（先 charles 子集）。
- [ ] `verifyMigration.mjs` 全绿。
- [ ] 重新部署全部 Function、解冻登录。
- [ ] 真机冒烟：迁移用户登录 → 有 claim、看得到、**改得动**自己旧 clip。

---

## 10. 关键实测数据（2026-06-24，便于复核）
- 用户 593（待迁 590）；email 全唯一、无空。
- 非回收站 clip 1112（待迁 1024，已迁 88，去重键=Atlas `_id` 实测命中）。
- 无 ExperimentState 元数据的 clip：**547**。
- ExperimentState：633；annotations 非空 327（多为 `"[]"`）。
- thermometers：1798（measuringAreaType：null 1559 / Rectangle 99 / Ellipse 126 / Point 14）。
- comments 105、ratings 65、notifications 420、historyclipconfigs 1345、profiles 598、recordings 686。
- 录像帧：662/686 有 lastFrameNumber>0，中位 200，最大 28909，总计 ~552,224 帧。
- 引用录像 320，缺帧 259（telelab2 抽样 9/10 可取回）。charles：5 clip / 4 录像缺帧（6070c947…、6070d549…、608ad8b6…、608da58b…）。
