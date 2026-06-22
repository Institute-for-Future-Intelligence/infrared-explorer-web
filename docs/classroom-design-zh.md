# Infrared Explorer — 课堂、直播与 AI 对比 工程设计方案

> **状态：已定稿（2026-06-20）。** 本文档整合了五个已最终确认的设计维度，并**应用了设计评审中所有对抗性"必须修复"项**。凡评审推翻了先前决定的地方，均已采纳修复并在行内标注 **[FIX-APPLIED]**。以下代码事实均已针对真实代码库（`signInButton.tsx`、`types.ts`、`imagePlayer.tsx`、`hooks.ts`、`temperatureReader.ts`）及 `firebase.json` / `firestore.rules` / `storage.rules` / `firestore.indexes.json` / `functions/` 均不存在这一现状进行了核实。
>
> 身份模型、冻结快照提交模型、AI 技术栈、直播帧保留策略以及新用户自动建档，均已**确定**（§1）。从 P1 开始（§9）。未经重新评审，不得偏离四项锁定决策。

---

## 1. 执行摘要 + 锁定决策

我们将在 infrared-explorer-web（IE）中新增课堂功能：教师创建班级（入班码），学生加入并提交热成像实验，教师通过采样缩略图墙**实时**监控学生，AI 层将学生实验与教师录制的参考实验进行对比并发出警报。分四个阶段交付（P1 班级+提交，P2 规则+身份强化，P3 直播监控，P4 AI）。

该架构复用 IE 现有的逐帧 Storage 约定（`recordings/{recordingId}/data_{N}.png|.dat`）以及现有分析路由（`experiments/:expType/:userId/:expId`），因此唯一净新增的直播传输组件是一个 Firestore 尾指针。像素数据永远不进入 Firestore。

Android 录制 app（`Infrared-Explorer-2`）是帧的生产者；**本 Web 仓库仅负责查看/分析/管理**（`src/services/upload.ts` 是一次性数据种子脚本，不是录制器）。

### 产品决策——已锁定（2026-06-20）

四项决策均确认为推荐的默认方案。

1. **提交模型 = 冻结快照。** 提交时将实验元数据+缩略图复制到班级子树（`classes/{id}/submissions`）。教师仅读取班级子树——**无需跨用户读取 `users/{studentUid}/experiments/**`，也无需客户端写入授权文档**（后者是权限提升漏洞）。批改作业是时间点固化的产物，提交后学生的实时编辑在教学上也不需要看到。真正的实时需求（观看学生实时操作）由独立的 **LiveSession** 路径提供（§6）。*覆盖路径（服务端写入授权）记录于 §5.4，但未选用。*
2. **AI 技术栈 = Azure o4-mini**（`chat.completions`，使用 `reasoning_effort` + `max_completion_tokens`），复用现有 `firebase-functions` callable 模式。负载为纯数值，视觉接口在能力验证标志后启用。
3. **直播帧保留 = 临时存储 + 手动保存。** 直播帧写入 `live/{classId}/{studentUid}/{sessionId}/`，由**定时 Cloud Function**在 24 小时后清除（GCS 生命周期规则无法依据 Firestore 状态触发——[FIX-APPLIED] §6.7）。"保存"时将帧最终化到 `recordings/{recordingId}/`。限制了每个学生 40 分钟约 320 MB 的存储责任。
4. **新学生自动建档 = 是。** 登录时若无 email 对应的 `users/{mongoId}` 文档，则自动创建（客户端生成 ObjectId），写入 `email`、`displayName`、`role:'student'`，再继续流程。若无此机制，学生将无法加入（已核实：当前 `signInButton.tsx` 的 `forEach` 对未知用户是空操作）。

---

## 2. 身份模型（核心问题——已彻底解决）

**决策：应用内的规范身份是遗留 Mongo ObjectId（`useCommonStore.user.id`）。Firestore/Storage 规则通过 Firebase 自定义 claim `mongoId` 进行授权，该 claim 由 Cloud Function 设置，并以 `request.auth.token.email_verified == true` 作为硬性门槛。`uidMap` 文档仅作为 P1 的临时过渡桥梁。**

原因以及为何拒绝了其他方案：

- 每个实验都在 `users/{mongoId}/experiments/{expId}`，唯一的分析路由是以 ObjectId 为键的 `experiments/:expType/:userId/:expId`。迁移到 `auth.uid` 意味着重写所有数据+路由——不在范围之内。**ObjectId 保持为文档 id、路径、路由以及所有 `*Uid` 字段所使用的身份标识。**
- 规则无法将 `auth.uid` 与 ObjectId 文档 id 进行比较，也无法运行 `where()` 查询。考虑了两种桥接方案：
  - **以 email 为文档 id 的门控**——可行，但 **[FIX-APPLIED, MAJOR]** 若无 `email_verified == true`，可被未验证邮件提供商路径冒充（一个未验证邮件 = 账号被接管）；且 **[FIX-APPLIED, MAJOR]** Firestore 规则**没有 `toLowerCase()`/`trim()`**，因此以 email 为键的 id 在任何大小写不匹配时会静默拒绝。
  - **`uidMap` get()**——每次教室规则评估（包括 5 fps 的逐帧 Storage 读取）都是一次计费读取。作为短期过渡尚可接受，不适合永久设计。

**最终方案——自定义 claim `mongoId`（主方案）：**
- 一个阻塞性 callable Cloud Function `onUserSignIn`，在客户端 `signInWithPopup` 完成后立即调用，验证 Google token，通过 email 解析/自动建档 `users/{mongoId}`，并通过 Admin SDK 为 Auth 用户设置自定义 claim `{ mongoId }`。客户端强制刷新 ID token。
- 规则随后读取 `request.auth.token.mongoId`，**零额外读取**，直接与以 ObjectId 为键的文档 id 和 `*Uid` 字段进行比较。每个门控同时要求 `request.auth.token.email_verified == true`。
- `users/{mongoId}` 还额外存储 `authUid`（Firebase uid）和 `role`。
- **P1 临时回退方案（claim CF 上线前）：** 在登录时幂等写入 `uidMap/{authUid} = { mongoId, email }`；规则使用 `appId()` = `get(uidMap/$(auth.uid)).data.mongoId`。P2 中切换到 claim 方案。

**以下各处均适用此影响：**
- 所有 `teacherUid` / `studentUid` / 成员文档 id / `ownerUserId` = Mongo ObjectId。
- 所有规则均与 `request.auth.token.mongoId`（即 claim）进行比较——**不是** `auth.uid`，**不是** email 作为文档 id。
- 每个个人文档还记录 `authEmail`（已验证的 token email）用于审计/纵深防御，但**授权基于 claim**，而非 email。

`signInButton.tsx` 改动（替换已核实的空操作 `forEach`）：

```ts
onAuthStateChanged(auth, async (fbUser) => {
  if (!fbUser) { useCommonStore.getState().setUser(null); return; }
  // 1) 阻塞式：确保 users 文档 + 自定义 claim，然后刷新 token
  const { mongoId, role } = await callOnUserSignIn();   // CF：建档 + 设置 {mongoId} claim
  await fbUser.getIdToken(true);                          // 强制刷新，使规则能看到 claim
  // 2) 填充 store（当前 id/role/authUid 均被丢弃——在此修复）
  useCommonStore.getState().setUser({
    id: mongoId, role, authUid: fbUser.uid,
    displayName: fbUser.displayName, email: fbUser.email, avatar: fbUser.photoURL,
  } as User);
});
```

---

## 3. 最终数据模型（TypeScript）

所有温度单位为摄氏度。`*Uid` = Mongo ObjectId。`authEmail` = 已验证 token email（仅用于审计/纵深防御；永远不是授权依据）。

```ts
// types.ts — User 新增 role + authUid（当前均被丢弃；已在 signInButton.tsx 核实）
export interface User {
  displayName: string | null;
  email: string | null;
  avatar: string | null;
  id: string;                                   // 规范 Mongo ObjectId
  role?: 'Admin' | 'student' | 'teacher';       // 新增（在登录时读取）
  authUid?: string;                             // 新增（Firebase uid；仅用于 uidMap 回退）
}

// Experiment 新增真实存在但未定义类型的 Firestore 字段（避免 `as any` 强转）：
//   userId?: string;        // 所有者 Mongo id
//   thumbnailFrame?: number;
```

```ts
export interface ClassInfo {
  readonly id: string;                 // Firestore 自动 id，存储于 info.id
  name: string;
  teacherUid: string;                  // Mongo ObjectId
  teacherEmail: string;                // 已验证 email（审计用）
  teacherName: string;
  joinCode: string;                    // 6 位；存于 joinCodes/，不在此处 [FIX-APPLIED §4]
  description?: string;
  createdAt: string;                   // ISO
  updatedAt?: unknown;                 // serverTimestamp
}

export interface ClassMember {
  uid: string;                         // == studentUid == 文档 id（Mongo ObjectId）
  email: string;                       // 加入时已验证 email
  displayName: string;
  joinedAt: string;                    // ISO
  classRole?: 'student' | 'ta';
}
```

```ts
// 冻结快照提交。文档 id = `${studentUid}_${expId}`。
// 幂等重新提交会覆盖并刷新 submittedAt。expId 是 ObjectId（不含下划线）。
export interface Submission {
  expType: ExperimentType;             // 'image'（学生作业）| 'video'（展示）
  ownerUserId: string | null;          // Mongo id；展示型为 null
  expId: string;
  recordingId?: string;                // image 类型：缩略图 recordings/{recordingId}/data_1.png
  thumbnailPath?: string;              // video/showcase 的显式缩略图
  // --- 去规范化快照，使教师图库仅读取班级子树（无跨用户读取）---
  displayName: string;
  duration: number;
  thumbnailFrame?: number;
  studentUid: string;                  // 规则所有者字段（Mongo id）
  studentName: string;                 // 去规范化（FormerMember 展示用）
  authEmail: string;                   // 审计
  submittedAt: string;                 // ISO
}
```

```ts
// 直播存在感知 + 尾指针。文档 id == studentUid。像素仅在 Storage 中。
export interface LiveSession {
  studentUid: string;                  // == 文档 id，规则所有者字段（Mongo id）
  studentName: string;
  authEmail: string;
  classId: string;
  sessionId: string;                   // live/{classId}/{studentUid}/{sessionId}
  recordingId: string;                 // 供查看者使用的路径构建器
  expId: string;
  expType: ExperimentType;
  // 直播增长中的尾部。替换静态 lastFrameIndex（hooks.ts:44-46）。
  // 以 1-based 文件索引存储。播放器索引转换见 §6.3 [FIX-APPLIED 差一错误]。
  latestFrameIndex: number;
  fps: number;                         // 5（与 FPS 常量保持一致）
  active: boolean;
  status: 'live' | 'paused' | 'ended';
  startedAt: string;                   // ISO
  updatedAt: unknown;                  // serverTimestamp；心跳时重写
  // alertLevel 已移除 [FIX-APPLIED]：不可篡改的安全信号不应放在
  // 无限制所有者可写的字段下。警报存于 alerts 集合（服务端写入）。
}
```

```ts
// 服务端写入的警报（admin SDK）。文档 id = `${studentUid}_${ruleId}`（幂等去重）。
export interface Alert {
  readonly id: string;                 // `${studentUid}_${ruleId}`
  studentUid: string;                  // 规则所有者字段
  studentName: string;
  authEmail: string;
  classId: string;
  ruleId: string;                      // 'envelope:meanT' | 'safety:maxT' | ...
  level: 1 | 2;                        // 1 警告，2 严重
  kind: 'overheat' | 'frozen-frame' | 'off-task' | 'ai-flag' | 'custom';
  feature?: string;
  severity?: number;                   // distOutsideBand / bandHalfWidth
  observed?: number; expectedLo?: number; expectedHi?: number; tau?: number;
  message: string;
  frameIndex?: number;
  recordingId?: string;
  status: 'open' | 'cleared';
  createdAt: string;                   // == firstSeenAt
  lastSeenAt: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
}
```

```ts
export interface FrameFeature {
  frameIndex: number;                  // 1-based 录制空间
  t: number;                           // 秒 = frameIndex * (1/FPS)；从 FPS 推导，不是字面 0.2 [FIX-APPLIED]
  maxT: number; minT: number; meanT: number; stdT: number;
  p10: number; p50: number; p90: number;
  dTdt: number;                        // (meanT - prevMeanT)/dt；第一帧为 0；dt = max(1/FPS, (idx-prevIdx)/FPS)
  spatialGradMean: number;
  hotspotX: number; hotspotY: number;  // argmax 归一化 [0,1]
  roi3x3: number[];                    // 9 个 ROI 平均温度（行优先，固定基准，跨用户可比）
  thermometers?: { id: string; x: number; y: number; c: number }[]; // 仅供参考
}

export interface EnvelopeBand {
  feature: string;                     // 'meanT'|'maxT'|'dTdt'|... | `roi:${n}`
  tau: number[]; center: number[]; lo: number[]; hi: number[];   // 并行数组，约 50 个锚点
  absTol: number; relTol: number;
}

export interface ReferenceBaseline {   // 班级范围，教师建立
  readonly id: string;
  classId: string;
  ownerUid: string;                    // == ClassInfo.teacherUid
  name: string; description?: string;
  sourceExpType: ExperimentType;
  sourceRecordingId?: string; sourceExpId?: string;
  durationFrames: number;
  phaseAnchor: 'index' | 'meanT';      // 默认 'index'（时间单调，适合先加热后冷却）
  features: FrameFeature[];            // 紧凑型；原始 .dat 保留在 Storage
  bands: EnvelopeBand[];
  hardSafety: { maxAbsC: number };     // 例如 80°C
  createdAt: string; updatedAt?: unknown;
}
```

---

## 4. Firestore 布局 + 索引 + 级联删除

```
classes/{classId}                                    -> ClassInfo（自动 id，存储为 info.id）
classes/{classId}/members/{studentUid}              -> ClassMember（文档 id == studentUid）
classes/{classId}/submissions/{studentUid}_{expId}  -> Submission（冻结快照，幂等）
classes/{classId}/liveSessions/{studentUid}         -> LiveSession（存在感知 + 尾指针）
classes/{classId}/alerts/{studentUid}_{ruleId}      -> Alert（服务端写入）
classes/{classId}/referenceBaselines/{baselineId}   -> ReferenceBaseline（教师建立）

joinCodes/{code}                                    -> { classId } [FIX-APPLIED：不放在世界可读的班级文档上]
users/{mongoId}                                     -> User 文档；+ joinedClasses: string[]
users/{mongoId}/experiments/{expId}                 -> Experiment（现有）
uidMap/{authUid}                                    -> { mongoId, email }（仅 P1 临时回退）

Storage（现有）：recordings/{recordingId}/data_{N}.png|.dat
Storage（新增直播）：live/{classId}/{studentUid}/{sessionId}/data_{N}.png|.dat（临时）
```

**[FIX-APPLIED, MINOR] 入班码从世界可读的班级文档中移出。** 班级元数据 `allow read: if signed-in`，因此存储在上面的入班码可被任意枚举。入班码存于 `joinCodes/{code}`（code 即文档 id → 单文档 `get()`，事务性保证唯一性）。入班查找 = `get(joinCodes/{normalizedCode})`；无 `where()` 查询，无复合索引。

**复合索引（`firestore.indexes.json`）：**
```
submissions:    studentUid ASC + submittedAt DESC      （学生查询"我的提交"）
alerts:         studentUid ASC + lastSeenAt DESC        （学生读取自己的警报）
alerts:         level ASC + lastSeenAt DESC             （教师按严重程度分类）
liveSessions:   status ASC + updatedAt DESC             （教师直播网格按活跃度排序）
```
> `liveSessions` 是**每班级的子集合**；教师网格查询为 `collection(classes/{classId}/liveSessions)` 按 `updatedAt` 排序——无需 `classId` 字段过滤。

**级联删除（`deleteClass`，尽力手动——Firestore 无级联）：**
1. `getDocs` + `Promise.all(deleteDoc)` 覆盖 `members`、`submissions`、`liveSessions`、`alerts`、`referenceBaselines`。
2. 删除 `joinCodes/{code}` 预留文档。
3. **[FIX-APPLIED, MAJOR]** 由于提交是冻结快照（§1），**无需清理跨用户授权文档**——"班级删除后陈旧授权导致跨用户读取泄漏"这一缺陷已被**冻结快照选择彻底消除**。
4. `deleteDoc` 班级文档。
5. **定时 Cloud Function**（不是 GCS 生命周期——[FIX-APPLIED, §6.7]）清除 `live/{classId}/**`。
6. 前学生 `joinedClasses` 中的陈旧条目**不**清理（无跨用户写入权限）；按需读时剪枝覆盖。

**removeMember：** 仅删除 `members/{studentUid}`（无跨用户写入）。学生 `joinedClasses` 中的陈旧条目在其下次读取时按需剪枝。

**`joinedClasses` 按需读时剪枝：** `fetchJoinedClasses` 确认每个条目的 `classes/{classId}/members/{studentUid}` 仍 `exists()`，无需重写用户文档即可丢弃幽灵条目。每个读取方均须执行剪枝。

---

## 5. 最终安全规则

**[FIX-APPLIED, CRITICAL——部署阻断]：** 仓库中**没有 `firebase.json`、没有 `firestore.rules`、没有 `storage.rules`、没有 `firestore.indexes.json`**。在任何规则工作（P2 门控）之前：
1. 检查 IE Firebase 项目**当前已部署**的控制台规则，**逐字**移植到新的仓库文件中（非破坏性操作）。
2. 创建引用 `firestore.rules`、`storage.rules`、`firestore.indexes.json` 的 `firebase.json`。
3. 在模拟器中测试。`rules_version='2'` 下 Storage 规则**默认拒绝**——部署不完整的文件**会破坏 `imagePlayer.tsx` 中现有的 `getBlob(recordings/...)` 读取**。`recordings/**` 块必须在首次部署时正确配置。
4. 以仓库为唯一来源；通过 `firebase deploy --only firestore:rules,firestore:indexes,storage` 部署。

辅助函数：`mongoId()` = `request.auth.token.mongoId`（自定义 claim，§2）；`verified()` = `request.auth != null && request.auth.token.email_verified == true`。

### 5.1 Firestore 规则（课堂子树）

```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {

    function verified() { return request.auth != null && request.auth.token.email_verified == true; }
    function mongoId()  { return request.auth.token.mongoId; }   // 自定义 claim（§2）

    // 仅 P1 临时回退（claim CF 上线前）：uidMap 桥接。
    match /uidMap/{authUid} {
      allow read, write: if request.auth != null && request.auth.uid == authUid;
    }

    // 入班码预留：code 即文档 id（不在世界可读的班级文档上）。
    match /joinCodes/{code} {
      allow get:    if verified();                          // 加入时单文档查找
      allow list:   if false;                               // 永不枚举码
      allow create: if verified()
                    && get(/databases/$(db)/documents/classes/$(request.resource.data.classId)).data.teacherUid == mongoId();
      allow delete: if verified()
                    && get(/databases/$(db)/documents/classes/$(resource.data.classId)).data.teacherUid == mongoId();
    }

    match /classes/{classId} {
      function classData() { return get(/databases/$(db)/documents/classes/$(classId)).data; }
      function isTeacher() { return verified() && classData().teacherUid == mongoId(); }
      function isMember()  { return verified()
        && exists(/databases/$(db)/documents/classes/$(classId)/members/$(mongoId())); }

      allow read:   if verified();                          // 元数据；加入由 joinCodes 门控
      allow create: if verified() && request.resource.data.teacherUid == mongoId();
      allow update, delete: if isTeacher();

      match /members/{memberUid} {
        allow read:   if isMember() || isTeacher();
        allow create: if verified() && memberUid == mongoId()
                      && request.resource.data.uid == memberUid;
        allow delete: if isTeacher() || memberUid == mongoId();   // 教师移除；学生离开
      }

      // 冻结快照提交：教师在班级子树内读取快照。
      // 无跨用户读取 -> 无授权攻击面。[FIX-APPLIED CRITICAL]
      match /submissions/{subId} {
        allow read:   if (verified() && resource.data.studentUid == mongoId()) || isTeacher();
        allow create, update: if isMember() && request.resource.data.studentUid == mongoId();
        allow delete: if (verified() && resource.data.studentUid == mongoId()) || isTeacher();
      }

      match /liveSessions/{studentUid} {
        allow read:   if studentUid == mongoId() || isTeacher();
        // 学生仅写自己的会话；限制可变字段（此处无警报/安全字段）[FIX-APPLIED]
        allow create, update: if studentUid == mongoId()
          && request.resource.data.studentUid == studentUid
          && request.resource.data.diff(resource.data == null ? request.resource.data : resource.data)
               .affectedKeys().hasOnly(['latestFrameIndex','updatedAt','status','active','startedAt',
                                        'recordingId','sessionId','expId','expType','fps','studentName','authEmail','classId']);
        allow delete: if studentUid == mongoId() || isTeacher();
      }

      // 警报：仅服务端（admin SDK 绕过规则）。客户端读取；永不写入。[FIX-APPLIED]
      match /alerts/{alertId} {
        allow read:  if (verified() && resource.data.studentUid == mongoId()) || isTeacher();
        allow write: if false;
      }

      match /referenceBaselines/{bid} {
        allow read:   if isMember() || isTeacher();
        allow create, update, delete: if isTeacher();
      }
    }

    // 现有实验所有者规则保留。（选定的）冻结快照模型中无跨用户教师读取。
    // 仅在覆盖为直播指针时参见 §5.4。
    match /users/{ownerId}/experiments/{expId} {
      allow read, write: if verified() && ownerId == mongoId();   // 仅所有者
    }
  }
}
```

### 5.2 已解决的跨用户读取策略

**通过消除解决：** 冻结快照意味着教师仅读取 `classes/{classId}/submissions/{subId}`（由一次 `isTeacher()` `get()` 授权），图库缩略图来自快照的 `recordingId`/`thumbnailPath`。**不存在**对 `users/{studentUid}/experiments/**` 的读取，也**不存在**客户端写入的授权文档——后者是权限提升漏洞（任何已认证用户写入授权以读取受害者数据）。**[FIX-APPLIED, CRITICAL]**

### 5.3 Storage 规则（为 IE 真实路径从头编写）

**[FIX-APPLIED, CRITICAL]：** 不要粘贴其他应用的规则。仅为 IE 的真实路径编写。IE 直接读取 `recordings/{recordingId}/data_{N}.png`（`imagePlayer.tsx`）。

Storage 规则无法读取自定义 claim，因此通过 `firestore.get()` 在服务端写入的索引上进行桥接。**[FIX-APPLIED, CRITICAL——recordings 泄漏]：** 对 `recordings/**` 使用简单的 `allow read: if request.auth != null` 会将每个录制泄漏给每个已登录用户。改为由**服务端写入**的 `recordingGrants/{recordingId}` 文档支持的所有者或授权门控。

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function rg(id) { return firestore.get(/databases/(default)/documents/recordingGrants/$(id)).data; }

    // 持久化录制：所有者 OR 服务端写入授权的教师。永不开放。[FIX-APPLIED]
    match /recordings/{recordingId}/{file} {
      allow read:  if request.auth != null && (
        rg(recordingId).ownerAuthUid == request.auth.uid
        || request.auth.uid in rg(recordingId).allowedReaderAuthUids );
      allow write: if request.auth != null
        && rg(recordingId).ownerAuthUid == request.auth.uid
        && request.resource.size < 1 * 1024 * 1024;        // PNG ~20KB，.dat <=~38KB
    }

    // 临时直播帧。相同门控；由定时 CF 清除（§6.7）。
    match /live/{classId}/{studentUid}/{sessionId}/{file} {
      allow read:  if request.auth != null && (
        rg(sessionId).ownerAuthUid == request.auth.uid
        || request.auth.uid in rg(sessionId).allowedReaderAuthUids );
      allow write: if request.auth != null
        && rg(sessionId).ownerAuthUid == request.auth.uid
        && request.resource.size < 1 * 1024 * 1024;
    }
  }
}
```

`recordingGrants/{recordingId|sessionId}` ——**仅服务端写入**（admin SDK），以 Firebase **uid** 为键，因为 Storage 规则看到的是 `request.auth.uid`，而非 claim：
```
{ ownerAuthUid: string, allowedReaderAuthUids: string[], classId: string, updatedAt }
```
Firestore 规则：`allow read: if owner-or-listed; allow write: if false`。授权文档由提交/直播开始 Cloud Function 创建/刷新，该函数从班级中解析教师的 `authUid`。**授权文档必须在第一帧上传前存在**，因此直播开始 CF 先写入；查看者和录制器对未授权对象的 404 的容忍方式与直播跟随循环对增长中的尾部的容忍方式相同（§6.4）。

### 5.4 仅覆盖时使用（未选用）：直播指针跨用户读取

若产品负责人拒绝冻结快照，授权**由服务端写入，绝不由客户端写入**：
- `submitToClass` Cloud Function 通过 admin SDK 验证调用者是成员，读取班级 `teacherUid`/教师 `authUid`，然后写入 `users/{studentUid}/experiments/{expId}/grants/{teacherUid}` = `{ teacherAuthUid, classId }` 并将教师的 `authUid` 合并到 `recordingGrants/{recordingId}.allowedReaderAuthUids`。
- Firestore 实验规则新增：`allow read: if ownerId == mongoId() || (exists(grant) && grant.classId in <still-member classes>)`。
- removeMember/deleteClass **必须**删除这些授权文档。这种清理负担正是选择冻结快照的原因。

---

## 6. 直播

### 6.1 传输（已决定）：帧经 Storage，而非 WebRTC
Android 录制客户端将逐帧 `data_{N}.dat` **然后** `data_{N}.png`（`.dat` 在前，使得以 `.png` 为门控的查看者永远不会读到缺失的 `.dat`）写入 `live/{classId}/{studentUid}/{sessionId}/`，并写入限速的 Firestore `LiveSession` 心跳。Web 查看器复用 `imagePlayer` 的按索引 `getBlob`/`getBytes` 路径。无媒体服务器/SFU。WebRTC 严格保留给未来的 1:1"检查单个学生"升级，绝不用于墙（扇出爆炸 + 失去逐像素开尔文 `.dat`）。

### 6.2 Android ⇄ Firestore ⇄ Web 契约
- **开始：** `setDoc(liveSessions/{studentUid}, { ...fields, latestFrameIndex:0, status:'live', active:true, startedAt, updatedAt:serverTimestamp() })`。直播开始 CF 在第一帧之前写入 `recordingGrants/{sessionId}`（§5.3）。
- **每帧 i（1,2,3…，连续无间隔）：** 上传 `data_{i}.dat` 然后 `data_{i}.png`。
- **latestFrameIndex 节奏 [FIX-APPLIED, MINOR]：** K=25（约 5 秒）的心跳对约 200 ms 的跟随者来说太慢。**拆分写入：** `updatedAt` 每 K=25 帧心跳一次（遵守*活跃性*信号的 1-写/秒/文档软限制），但 `latestFrameIndex` **每秒更新一次（每 5 帧）**——在 1-写/秒/文档限制内，足够跟随者使用。两者在重合时放入同一 `update()`。
- **优雅停止：** `update({ latestFrameIndex:<final>, status:'ended', active:false, updatedAt })`。
- **崩溃：** 无写入 → 通过 `updatedAt` 陈旧性检测。
- **活跃性：** `now-updatedAt < 15s` 为 `live`，15–60 秒为 `stalled`，>60 秒或 `status==='ended'` 为 `dead`。
- **连续无间隔不变式 [FIX-APPLIED]：** 录制器必须严格按顺序、无间隔地上传索引，`.dat` 在 `.png` 之前，且实验在直播期间必须有**空 segments**（使无 segments 路径成立）。这是硬性契约。若 Android 客户端在最终确认时批量上传而不是流式增量上传，则增量直播上传是**重大的 Android 新增工作**——P3 开始前请确认。

### 6.3 差一错误（已在 `hooks.ts:25-26` 核实）
`getRecordingIndex(currIdx)` 在无 segments 路径下返回 `currIdx + 1`。因此**播放器索引 N 读取文件 `data_{N+1}`**。`latestFrameIndex` 以 **1-based 文件索引**存储。因此：
> **播放器尾部 = `latestFrameIndex - 1`。**

跟随者追踪 `liveTailRef.current = latestFrameIndex - 1`。`data_1.png` 是播放器索引 0。

### 6.4 `imagePlayer` 直播模式改动（覆盖 `imagePlayer.tsx:182-199`）
当前播放循环在 `currFrameIdxRef.current > lastFrameIndex` 时重置 `currFrameIdxRef.current = 0; stop()`。直播模式：
- 新增 `live?: { sessionId, studentUid, classId }` prop；`isLiveRef`、`liveTailRef`、`liveEndedRef`。
- `onSnapshot(liveSessions/{studentUid})` → `liveTailRef.current = Math.max(0, latestFrameIndex - 1)`；`status==='ended'` → `liveEndedRef = true`。
- `getLastFrameIndex()` = 直播时 `liveTailRef.current`，否则为静态值。
- 在 tick 中：若 `currFrameIdxRef.current > getLastFrameIndex()` → **若直播且未结束，`return`（等待）**；否则夹紧/停止。
- `preloadFrame` 将预读夹紧到 `getLastFrameIndex()` 并对未写入的尾部吞掉 404。

**[FIX-APPLIED, MAJOR——两个已确认的抛出点，均必须修复]：**
1. **`loadImage` 在缓存设置前返回**（已核实 `imagePlayer.tsx:109-120`：`FileReader.onloadend` 在函数返回后运行）。重构为真正在 `onloadend`（缓存写入后）内 resolve 并在 `getBlob`/`FileReader` 错误时 reject 的 Promise：
```ts
const loadImage = (index: number) => new Promise<void>((resolve, reject) => {
  fetchImage(index).then(blob => {
    const fr = new FileReader();
    fr.onloadend = () => { if (fr.result) { cacheImageRef.current[index] = fr.result as string; resolve(); } else reject(); };
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  }).catch(reject);   // 未写入尾部的 getBlob 404
});
```
2. **`Pako.inflate(undefined)` 抛出**（已核实 `temperatureReader.ts:27` 无 undefined 守卫）。直播模式下 `updateThermometersByFrame` 读取 `cacheThermoArrayBufferRef.current[index]`，对未获取的尾部 `.dat` 为 `undefined`。守卫 `getTemperatureAtPosition`/`getTempFromArrayBuffer` 及其调用方：若 buffer 为 undefined，跳过更新并在下一 tick 重试——绝不 `Pako.inflate(undefined)`。

其他 [FIX-APPLIED]：
3. **直播 T(t)：** 不要复用固定的 25 点降采样（`step` 计算一次，随尾部增长而过时）。增量追加最新缓存的 `.dat` 点。
4. **缓存驱逐（必须，不可推迟）：** 40 分钟会话 = 约 12000 个 base64 PNG → OOM。直播模式运行**窗口化 LRU，保留约最新 300 帧**，同时适用于 `cacheImageRef` 和 `cacheThermoArrayBufferRef`。
5. **"跳到直播"** 控件将 `currFrameIdxRef.current` 设置为 `liveTailRef.current`。
6. **每帧单次解压辅助函数：** 不要对每个探针调用 `getTemperatureAtPosition`（每次都重新解压整个 76.8 KB buffer）。每帧解压一次，直接按索引访问。

### 6.5 直播墙 + 采样（具体可行性数字）
- 对 `classes/{classId}/liveSessions` 按 `updatedAt desc` 排序的一个 `onSnapshot`。每个会话一个磁贴。
- **仅 PNG 缩略图，每 3 秒 1 帧，不含 `.dat`。**
- 可行性：全速 N=30 = **31.9 Mbps + 150 次 PNG 解码/秒 + 150 次 DOM 更新/秒** → 标签页崩溃。采样仅 PNG @1/3s，N=30 = **约 1.6 Mbps + 约 10 次解码/秒**（约 20 倍成本 / 超过 15 倍带宽降低）。**每面墙最多约 30 名学生**。`.dat` 仅在点击检查单个学生时获取（然后是 5fps PNG+`.dat`）。
- 点击磁贴 → `navigate('/experiments/image/{studentUid}/{expId}?live={studentUid}')`；`experimentAnalyzer` 解析 `?live=` 并将 `live={...}` 传递给 `imagePlayer`。
- **[FIX-APPLIED]：** `experimentAnalyzer.tsx` 必须新增 `?live=` 解析（当前无此功能），且 `App.tsx` 中必须新增**新路由 `classes/:classId/live`**。墙缩略图读取通过 §5.3 Storage 授权——**不是**开放认证。

### 6.6 监控 AI 位置
每个学生的推理在**学生自己的浏览器中**对最新帧运行；它**不**直接写入 Firestore。**[FIX-APPLIED, MAJOR——可伪造的安全信号]：** 学生写入的警报可被抑制/伪造。浏览器将推理结果**POST 到 admin SDK callable**（`reportAlert`），后者重新检查成员资格并写入 `classes/{classId}/alerts/{studentUid}_{ruleId}`（规则：客户端 `allow write: if false`）。教师墙通过现有 `onSnapshot` 读取警报。硬安全过热使用**噪声鲁棒统计量（p99 或热 ROI 均值），≥2 个连续帧**——绝不用单像素 argmax。

### 6.7 保留策略
直播帧写入 `live/{classId}/{studentUid}/{sessionId}/`。**[FIX-APPLIED]：** GCS 生命周期规则**无法**依据 Firestore `status` 触发，因此清理由**定时 Cloud Function** 负责，删除超过 24 小时（或其会话 `status==='ended'`/陈旧）的 `live/**` 前缀。优雅"保存"时，帧最终化到 `recordings/{recordingId}/`。`LiveSession` 文档在 `status==='ended'` 后 TTL 清除。

---

## 7. AI 对比

### 7.1 FrameFeature（见 §3）——计算位置
每个学生，**在学生浏览器中**，在录制每帧时计算（录制器在上传前解压帧）。**[FIX-APPLIED, MAJOR——未验证的生产者]：** 仓库中**只有回放组件**（`imagePlayer.tsx`）；**没有录制/上传代码**（`upload.ts` 是种子脚本）。"录制器计算并上传 FrameFeature"因此是**（Android）录制器上的明确新增交付件**，而非免费副产品。若 P4 中录制器无法修改，则回退到慢速路径服务端特征推导。特征每 K=5 帧限速写入 `liveSessions` 特征尾部。

### 7.2 包络 + 时间对齐
- 教师录制一次参考实验 → 离线计算 `FrameFeature[]` 时间序列，并在**归一化相位轴 tau∈[0,1]** 上按约 50 个锚点计算每特征的 `[lo,hi]` 带：`lo = c - (absTol + relTol·|c|)`，`hi = c + (absTol + relTol·|c|)`。
- **快速路径：相位归一化**（默认 `phaseAnchor:'index'`，`tau = clamp(frameIndex/(durationFrames-1), 0, 1)`），O(1)/帧，在线，无历史记录。`'meanT'` 锚定仅用于已知单调的参考；先加热后冷却保持 `'index'`。
- **慢速路径：DTW**（O(n·m)）对完整存储序列进行，用于非单调情况的准确裁定。
- 边界守卫：第一帧 `dTdt=0`；学生比参考更长 → tau 夹紧到 1.0（保持最后一个带）；索引间隔 → `dt = max(1/FPS, (idx-prevIdx)/FPS)`。

### 7.3 快速路径 vs 慢速路径
- **快速路径（浏览器，确定性）：** 每个学生，每批特征，`severity = max_feature(distOutsideBand / bandHalfWidth)`。**WARN**：`severity>1` 持续 ≥3 个连续采样点（约 3 秒）；**ALERT**：`severity>2` 持续 ≥3 个点；**硬安全**（p99/热 ROI 均值 > `maxAbsC`，≥2 个连续帧）→ ALERT。5 个带内采样后自动清除。结果 POST 到 `reportAlert` callable（§6.6）；callable 写入去重后的 `${studentUid}_${ruleId}` 警报。（教师无法写入学生所有的文档——写入方是服务器。）
- **慢速路径（Cloud Functions，onCall v2，区域 `us-east4`，`enforceAppCheck`，第一行先进行 auth 检查）：** 服务器通过 admin SDK 在读取同伴数据前重新验证教师身份；在**服务端**读取聚合的学生数据（绝不是客户端负载——防止提示注入）。对于评分裁定，慢速路径**在服务端从 `.dat` 重新推导特征**（一个移植的、自包含的逐帧解码器——`pako.inflate`，大端 `getUint16(offset+2, big-endian)`，`/100`，`kelvinToCelsius`；**不是** `parseRawThermalData`，后者有已确认的 `i*size` vs `i*size*INTSIZE` stride bug，仅影响多帧 `.vir` 回放），而非信任学生写入的特征文档。

### 7.4 警报模式/阈值
见 §3 `Alert`（文档 id `${studentUid}_${ruleId}`，幂等 open/cleared，服务端写入）。阈值：WARN `sev>1`，ALERT `sev>2`，3 采样去抖；硬安全 `maxAbsC≈80°C`，≥2 帧噪声守卫。

### 7.5 Cloud Function 签名 + 缺失基础设施
**[FIX-APPLIED, MAJOR——缺失 functions 基础设施]：** 仓库中**没有 `functions/` 目录**。P4 必须**创建 `functions` 包**并从 `firebase-functions`/`aims2` **移植** `requireAuth`/`enforceRateLimit`/`enforceAppCheck`/`callAzureOpenAI`/`onCall` 原语；不要假设共存。

```ts
// functions/src/index.ts — onCall v2，区域 'us-east4'
export const reportAlert = onCall({ region:'us-east4', enforceAppCheck: APP_CHECK_ENFORCED, secrets:[] },
  async (req) => {
    const uid = requireAuth(req);                         // 学生
    const { classId, alert } = validateAlertInput(req.data);
    await assertMemberOfClass(uid, classId);              // admin SDK；uid->mongoId 通过 claim/users 文档
    await adminWriteAlert(classId, alert);                // 客户端 write:false
    return { ok: true };
  });

export const diagnoseStudent = onCall(
  { region:'us-east4', timeoutSeconds:60, secrets:['AZURE_OPENAI_API_KEY'], enforceAppCheck: APP_CHECK_ENFORCED },
  async (req): Promise<{ markdown: string }> => {
    const uid = requireAuth(req);
    const { classId, studentUid } = validateDiagnoseInput(req.data);
    await assertTeacherOfClass(uid, classId);             // [FIX-APPLIED] 比较 class.teacherUid == 调用者的 mongoId（claim），不是 auth.uid
    await enforceRateLimit(uid, 'diagnoseStudent', 200, 86400);
    const env = await loadReferenceBaseline(classId);
    const ts  = await deriveStudentFeaturesFromDat(classId, studentUid);   // 服务端重新推导，用于评分裁定
    const dev = dtwAlignAndScore(ts, env);
    const thumbs = VISION_ENABLED ? await sampleThumbnails(classId, studentUid, 6) : [];
    const md = await callAzureO4Mini({ system: DIAGNOSE_SYSTEM_PROMPT, userNumeric: serialize(env, ts, dev),
      images: thumbs, reasoning_effort:'low', max_completion_tokens:100000 });
    if (!md) throw new HttpsError('internal','model returned no content');
    return { markdown: md };
  });

export const analyzeClass = onCall(
  { region:'us-east4', timeoutSeconds:120, secrets:['AZURE_OPENAI_API_KEY'], enforceAppCheck: APP_CHECK_ENFORCED },
  async (req): Promise<{ markdown: string }> => {
    const uid = requireAuth(req);
    const { classId } = validateClassInput(req.data);
    await assertTeacherOfClass(uid, classId);
    await enforceRateLimit(uid, 'analyzeClass', 30, 86400);     // 更低：扇出至整个班级
    const env = await loadReferenceBaseline(classId);
    const summary = await summarizeAllStudents(classId, env);   // 服务端，上限 N + 上限点数，仅数值
    if (summary.empty) return { markdown: 'No student data yet.' };
    const md = await callAzureO4Mini({ system: CLASS_ANALYSIS_SYSTEM_PROMPT, userNumeric: serialize(env, summary),
      images: [], reasoning_effort:'medium', max_completion_tokens:100000 });
    if (!md) throw new HttpsError('internal','model returned no content');
    return { markdown: md };
  });
```
注意：o4-mini 推理消耗 `max_completion_tokens` → 设置要慷慨（100000），否则内容返回为空。不同的限速桶（`diagnoseStudent` 200/天，`analyzeClass` 30/天），以 `${name}__${uid}` 为键。抛出类型化的 `HttpsError`。视觉接口在仅针对部署测试了一个 `image_url` 部分后才打开 `VISION_ENABLED` 标志。

### 7.6 LLM 提示示例（diagnoseStudent，数值优先）
```
SYSTEM:
You are a physics-lab teaching assistant for Infrared Explorer (browser thermal-imaging,
120x160 IR at 5 fps). Given a TEACHER REFERENCE expected envelope and ONE student's
aligned thermal feature timeseries, diagnose whether the run is proceeding correctly.
Be concrete and physical (heating/cooling rates, hotspot location, where it diverged).
Output plain Markdown: Bottom line (on-track/minor/needs help); What the data shows
(2-4 bullets citing tau/time + features); Likely cause; Suggested teacher action.
Do NOT output JSON. Do NOT invent data not present below.

USER:
Class: phys-201  Student: Maya  Reference: 600 frames (120 s). Alignment: DTW over meanT. Hard-safety maxT cap: 80 C.
EXPECTED ENVELOPE (tau -> [lo,hi]):
  meanT: 0.0[21,23] 0.25[30,36] 0.5[44,52] 0.75[55,63] 1.0[60,68]
  maxT:  0.0[22,25] 0.25[40,52] 0.5[62,74] 0.75[70,82] 1.0[74,86]
  dTdt:  0.0[0.0,0.4] 0.25[0.5,1.1] 0.5[0.2,0.7] 0.75[0.0,0.3] 1.0[-0.1,0.2]
STUDENT [tau,meanT,maxT,dTdt,hotspotX,hotspotY]:
  [0.00,21.8,22.9,0.05,0.50,0.50] [0.25,28.1,47.3,0.41,0.51,0.48] [0.50,39.2,64.1,0.33,0.52,0.47]
  [0.75,46.0,71.2,0.18,0.71,0.30]  <- 热点移动  [1.00,49.5,73.8,0.06,0.72,0.29]
DEVIATIONS: meanT sev 1.9 @ tau0.75 (below [55,63]); hotspot drift +0.20x,-0.18y after tau0.6
Diagnose.
```

---

## 8. 前端集成

### 逐文件改动

| 操作 | 路径 | 用途 | 阶段 | 复用 |
|---|---|---|---|---|
| 新建 | `src/classroom/Classroom.ts` | `ClassInfo`/`ClassMember`/`Submission` 类型；`JOIN_CODE_ALPHABET`（ABCDEFGHJKMNPQRSTUVWXYZ23456789），`generateJoinCode(6)`，`normalizeJoinCode` | P1 | aims2 直接复用（删除课程计划部分） |
| 新建 | `src/classroom/classroomUtil.ts` | 纯异步 Firestore：createClass / findClassByJoinCode（通过 `joinCodes/`）/ joinClass / leaveClass / fetchJoinedClasses（含剪枝）/ fetchClassInfo / fetchMembers / removeMember / deleteClass（级联）/ submitProject / fetchSubmissions / fetchMySubmissions | P1 | aims2；换用 `firebaseDatabase` 导入；不触碰 store |
| 新建 | `src/pages/classroom/MyClassesPage.tsx` | 列出已加入/拥有的班级；创建/加入入口 | P1 | store.user，antd |
| 新建 | `src/pages/classroom/ClassDetailPage.tsx` | 教师：名单+图库（P3 新增直播墙标签）+警报；学生：自己的提交；`isTeacher = classInfo.teacherUid===user.id` | P1（P3 新增标签页） | Roster，SubmissionGallery，AlertList |
| 新建 | `src/components/classroom/CreateClassModal.tsx` | 班级名称输入；createClass | P1 | react-draggable，antd Modal |
| 新建 | `src/components/classroom/JoinClassModal.tsx` | 入班码输入；阻止加入自己的班级/已是成员 | P1 | react-draggable，antd Modal |
| 新建 | `src/components/classroom/SubmitToClassModal.tsx` | 选择班级；submitProject(expId,expType,...) | P1 | store.user，antd |
| 新建 | `src/components/classroom/Roster.tsx` | 成员列表；教师移除（仅删除成员文档）；FormerMember 标签 | P1 | antd List |
| 新建 | `src/components/classroom/SubmissionGallery.tsx` | 图库卡片；**每张卡片独立 onClick** 携带完整 Submission **[FIX-APPLIED]**（不用 CardListWrapper 单一 `e.target.id` 委托）；根据 expType 分支缩略图 | P1 | Card |
| 新建 | `src/classroom/liveUtil.ts` | LiveSession 心跳/尾部读写；onSnapshot 辅助函数 | P3 | Storage 约定 |
| 新建 | `src/pages/classroom/LiveWallPage.tsx` | 教师 PNG 采样网格 | P3 | LiveTile |
| 新建 | `src/components/classroom/LiveTile.tsx` | 单个学生 PNG 缩略图 @1/3s；不含 .dat | P3 | getBlob+FileReader |
| 新建 | `src/components/classroom/AlertList.tsx` | 渲染警报（onSnapshot） | P3/P4 | antd |
| 新建 | `src/pages/experimentAnalyzer/imagePlayer/useLiveFollow.ts` | onSnapshot 尾部 → 可变 `liveTailRef`；容错 404 追踪 | P3 | liveUtil |
| 修改 | `src/App.tsx` | 新增路由 `myClasses`、`classes/:classId`、`classes/:classId/live` | P1（P3） | createHashRouter |
| 修改 | `src/components/mainMenu/mainMenu.tsx` | 在 `items[]` 中新增"我的班级"链接 | P1 | items 数组 |
| 修改 | `src/layouts/header/signInButton.tsx` | 调用 `onUserSignIn` CF；存储 `role`+`authUid`；强制刷新 token；自动建档 | P1/P2 | §2 |
| 修改 | `src/types.ts` | `User += role?, authUid?`；`Experiment += userId?, thumbnailFrame?` | P1 | — |
| 修改 | `src/stores/common.ts` | 唯一新增全局字段：`user.role`（和 `authUid`）；无 classMap/currentClassId | P1 | 现有 setUser |
| 修改 | `src/pages/experimentAnalyzer/experimentAnalyzer.tsx` | **[FIX-APPLIED]** 承载提交按钮（通过 useParams 知道 `expType`）；解析 `?live=` 并传递 `live={...}` 给 imagePlayer；`experimentMap` 以 `${userId}_${expId}` 为键（而非裸 expId）以避免错误所有者缓存命中 | P1（提交）/P3（直播） | useParams |
| 修改 | `src/pages/experimentAnalyzer/toolBar.tsx` | 接受 `expType`/`ownerId`；仅对 image 类型渲染"提交到班级" | P1 | expId prop |
| 修改 | `src/pages/experimentAnalyzer/imagePlayer/imagePlayer.tsx` | 直播跟随（§6.4）：覆盖 L182-199 的等待尾部逻辑；重构 `loadImage` 为可等待 Promise；夹紧+容错 404 预加载；LRU 驱逐；增量 T(t) | P3 | useLiveFollow |
| 修改 | `src/pages/experimentAnalyzer/hooks.ts` | 直播可变尾部；导入 FPS 而非字面 `5` | P3 | — |
| 新建（基础设施） | `firebase.json`，`firestore.rules`，`storage.rules`，`firestore.indexes.json`，`functions/**` | 规则/索引/CF（当前均不存在） | P2/P3/P4 | §5 |

**[FIX-APPLIED] 提交入口点：** `toolBar` 仅由 `ImagePlayer` 挂载，而非 `VideoPlayer`，且缺少 `expType`。因此提交操作**承载在 `experimentAnalyzer.tsx`**（通过 `useParams` 知道 `expType`），向下传递 props。v1 范围：**仅图像提交**，除非所有者确认 showcase/video（无 recordingId → 图库必须分支缩略图）。

**[FIX-APPLIED] antd `<App>`：** `main.tsx` 渲染裸 `<App/>`；aims2 的 modal 使用 `App.useApp()`，若无 `<App>` 祖先则抛出。要么在树的顶部包裹一次 antd `<App>`，要么在移植的组件中使用静态 `message`/`Modal.confirm` API。

**[FIX-APPLIED] 角色：** 种子数据中只有 `'Admin'`/`'student'`（无 `'teacher'`）。**教师身份由 `classInfo.teacherUid === user.id` 决定**，而非 `role`。任何创建班级的用户都是其教师；`role` 仅控制"创建班级"入口的*可见性*。默认：任何已登录用户均可创建班级。

**Store：** 唯一新增的全局字段是 `user.role`/`authUid`。`joinedClasses` 存在用户文档上（arrayUnion/Remove，merge），在 `MyClassesPage` 本地状态中获取（含剪枝）。班级名单/提交/直播存在**本地**组件状态中，通过 `onSnapshot` 获取，在卸载时取消订阅（无全局 classMap → 无幽灵班级陈旧问题）。

### 教师班级详情页面（ASCII 示意图）
```
+--------------------------------------------------------------------------------------+
| < 我的班级      物理 P3  -  入班码: H7K9QP              [直播墙] [删除]              |
+----------------------+---------------------------------------------------------------+
| 名单 (12)            |  提交（图库）                  [全部 v] [最新 v]              |
|----------------------|---------------------------------------------------------------|
| o 陈雅      [x]      |  +----------+  +----------+  +----------+  +----------+        |
| o 廖明      [x]      |  | [缩略图] |  | [缩略图] |  | [缩略图] |  | [缩略图] |        |
| o 马璐      [x]      |  | 加热实验 |  | 冰融化   |  | 手部红外 |  | 蜡烛     |        |
| o 倪康      [x]      |  | 陈雅     |  | 廖明     |  | 马璐     |  | 倪康     |        |
| ...                  |  +----------+  +----------+  +----------+  +----------+        |
| -- 前成员 --         |   （点击卡片 -> #/experiments/image/{studentUid}/{expId}）    |
| o 张磊（已离）(无x) |---------------------------------------------------------------|
|                      |  直播墙（仅 PNG，约 1 帧/3s，N≤30 -> <2 Mbps）              |
|  [仅通过入班码加入]  |  +--------+ +--------+ +--------+ +--------+  绿=正常         |
|                      |  | 陈雅   | | 廖明   | | 马璐   | | 倪康   |  ! = 警报        |
|                      |  | [png]  | | [png]  | | [png !]| | [空闲] |  空闲=无心跳     |
|                      |  | 直播中 | | 直播中 | | 严重!  | | 断线   |                  |
|                      |  +--------+ +--------+ +--------+ +--------+                  |
|                      |   （点击磁贴 -> 分析器直播跟随 + .dat，单个学生）            |
+----------------------+---------------------------------------------------------------+
| 警报（服务端通过 reportAlert callable 写入；教师 onSnapshot）                        |
|   ! 14:32  马璐  safety:maxT 71°C（p99，2个连续帧）                                 |
|   ! 14:29  廖明  liveness: 无心跳 > 60s                                              |
+--------------------------------------------------------------------------------------+
isTeacher = classInfo.teacherUid === user.id。移除仅删除成员文档。
学生查看此路由：SUBMISSIONS where studentUid==user.id（规则；无名单/直播墙/警报）。
```

---

## 9. 分阶段计划（P1–P4）

**P1 — 班级 + 提交（无直播，无 AI）。工作量：约 M（1.5–2.5 周）。**
交付件：`types.ts`（User.role/authUid，Experiment.userId/thumbnailFrame）；`signInButton` role/authUid + 自动建档；`Classroom.ts`；`classroomUtil.ts`（CRUD + 通过 `joinCodes/` 加入 + **冻结快照**提交 + 获取 + 按需剪枝）；MyClassesPage；ClassDetailPage（名单 + 图库 + FormerMember）；创建/加入/提交到班级 Modal；SubmissionGallery（每卡片 onClick）；路由；主菜单入口；提交承载于 experimentAnalyzer（仅图像）；antd `<App>` 包裹。
**[FIX-APPLIED 延续至 P1]：** 每个班级/成员/提交文档上都盖 `authEmail` 印记；学生列表查询从第一天起就携带 `where('studentUid','==',user.id)`（P2 规则下强制，不是事后补救）；`experimentMap` 以 `${userId}_${expId}` 为键。
依赖：无。冻结快照意味着图库**无跨用户读取阻断**。

**P2 — 身份 + 规则强化。工作量：约 M（1–2 周）。依赖 P1。**
**先解阻塞：** 获取当前已部署的控制台规则 → 移植到仓库 → 创建 `firebase.json` → 模拟器测试。然后：设置 `mongoId` 自定义 claim + token 刷新的 `onUserSignIn` CF；firestore.rules（§5.1）以 claim + `email_verified` 为门控；从头编写 storage.rules（§5.3），含服务端写入的 `recordingGrants`；复合索引（§4）。验证默认拒绝的 Storage 不破坏现有的 `getBlob(recordings/...)`。

**P3 — 直播监控。工作量：约 L（2–3 周）。依赖 P1+P2。**
`liveUtil`；`useLiveFollow`；imagePlayer 直播模式，**修复三个抛出点**（可等待 `loadImage`，Pako undefined 守卫，等待尾部）+ LRU 驱逐；LiveWallPage + LiveTile（仅 PNG @1/3s）；`classes/:classId/live` 路由；experimentAnalyzer 中的 `?live=` 解析；`liveSessions` 子集合规则 + 索引；分离节奏心跳（`latestFrameIndex` 1/s，`updatedAt` 每 5s）；定时 CF 清除 `live/**`。**在开始前确认 Android 录制器支持增量流式传输**（连续无间隔，`.dat` 在 `.png` 之前，空 segments）——这可能是重大的 Android 工作量。

**P4 — AI。工作量：约 L（2–3 周）。依赖 P3。**
创建 `functions/` 包 + 移植 `requireAuth`/`enforceRateLimit`/`enforceAppCheck`/`callAzureOpenAI`；FrameFeature 在（Android）录制器中计算——**明确交付件**；参考基线建立（离线包络）；FAST 浏览器监控 → `reportAlert` callable（服务端写入警报）；SLOW `diagnoseStudent`/`analyzeClass` callable，含服务端教师重新检查和**服务端特征重新推导（用于评分裁定）**；仅数值负载（视觉接口在验证标志后启用）；每端点独立限速桶。

依赖链：**P2 ⟵ P1；P3 ⟵ P1+P2；P4 ⟵ P3。**

---

## 10. 已知风险延续 + Bug 说明

- **身份是核心（§2 已解决）：** 自定义 claim `mongoId` + `email_verified`。claim CF 上线前，`uidMap` 回退每次规则评估都是计费读取。`email_verified==true` 在每个门控上降低邮件回收/未验证邮件冒充风险。
- **跨用户读取（所选模型已消除）：** 冻结快照提交彻底消除了评分作业的授权攻击面和 `recordings` 泄漏路径。覆盖路径（§5.4）**未选用**。
- **规则/基础设施不存在（已核实）：** P2 必须非破坏性地移植当前控制台规则并建立 `firebase.json` + 模拟器，然后再添加课堂规则；Storage 默认拒绝可能破坏现有读取。
- **直播抛出点（已核实，P3 中修复）：** `loadImage` 不可等待 + `Pako.inflate(undefined)` + 重置为 0 的循环。缓存驱逐是必须的（OOM 风险）。
- **差一错误（已核实 `hooks.ts:25-26`）：** 无 segments 路径 `getRecordingIndex = currIdx+1`；`latestFrameIndex` 是**文件索引**，播放器尾部 = `latestFrameIndex - 1`。直播实验必须有**空 segments**。
- **录制器未验证/缺失：** 本仓库中只有回放。增量直播上传 + FrameFeature 计算是净新增的（可能是 Android）交付件，不是免费副产品。
- **规模：** 直播墙仅 PNG @1/3s，N≈30 → <2 Mbps；全速（31.9 Mbps）不可行。警报是微小的数值文档；每学生推理线性扩展。
- **硬安全误报：** 过热使用 p99/热 ROI 均值，≥2 帧，从不用单像素 argmax。
- **`parseRawThermalData` bug 说明（仅与 SLOW 路径 Node 解码器相关）：** `parseRawThermalData` 有已确认的 `i*size` vs `i*size*INTSIZE` stride bug，但它只影响多帧 `.vir` `VideoPlayer` 展示路径。逐帧 `.dat` 路径（已核实自包含：`Pako.inflate` → `getUint16(offset+2, big-endian)` → `/100` → `kelvinToCelsius`）无此 bug。**若 SLOW 路径移植 Node 解码器，必须使用逐帧路径，绝不复用 `parseRawThermalData`。**
- **Token 预算：** o4-mini 推理消耗 `max_completion_tokens`；设置 100000，否则内容返回为空（检测到此情况并抛出 `HttpsError`）。
