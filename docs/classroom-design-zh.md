# Infrared Explorer — 班级功能 v1 实现规格

> **状态：v1 设计定稿 2026-06-26。** 本文取代旧版《班级 + 直播 + AI》设计（旧版自 §0 起已自相矛盾）。
>
> **v1 范围：纯班级。** 建班 / 加入（班级号码 + 密码）、作业制提交、**老师精选**展示墙、名单与详情、复用评论做反馈。**不含 AI，不含帧级直播。**
>
> 旧版含直播 / AI 的工程推理（包络 / DTW / 帧流式上传的对抗性评审修复等）**保留在本文件的 git 历史中**，P2+ 启用相应功能时再取回。
>
> 本文所有代码事实均已对当前代码核实（见各处 `file:line`）。

---

## 0. 已定决策（2026-06-26 会话）

1. **谁建班谁是老师。** 老师身份 = `class.teacherUid === user.id`；任何登录用户都能建班。**不需要全局角色系统**，也**不需要给 `User` 加 `role` / `authUid`**（v1 只用已有的 `user.id` = mongoId）。
2. **加入 = 班级号码 + 密码**，走 callable 服务端校验 + 限流。密码**以明文存** `classSecrets/{classId}`，规则只允许**本班老师读取**（老师要在自己页面查看/修改口令），学生不可读。班级口令是低敏共享密钥，可查看的价值大于不可恢复的哈希。
3. **作业制提交（非自由监控）。** 老师建作业，学生提交；提交**仅老师 + 本人可见**，同学之间互不可见。
4. **展示墙仅老师可写。** 老师发布自己的材料 + 从学生提交里**精选**发布；学生**不能**自助公开自己的实验。
5. **实时 = 列表级（`onSnapshot`）。** 老师页面随学生提交即时刷新。不做帧级直播。
6. **反馈复用现有评论系统**；私密评分走老师专属 `grades/` 子集合。
7. **接受 `recordings/**` 当前公开读**（靠不可猜 24-hex id 防护），v1 不做私有录制 grant 机器。

---

## 1. 现有地基（直接复用，不重建）

| 能力 | 现状 | 复用方式 |
|---|---|---|
| 身份 | `mongoId` 自定义 claim 由 [`onUserSignIn`](../functions/src/index.ts) 铸造；[`resolveMongoId`](../src/services/auth.ts) 读 claim→邮箱兜底；规则有 `signedIn()`(=`email_verified`)、`mongoId()`、`isOwner()`、`isStaff()` | 班级规则直接用 `mongoId()`；老师 = `teacherUid===mongoId()` |
| 实验 | 顶层 `experiments/{expId}`（[`types.ts:42-71`](../src/types.ts)），路由 [`experiments/:expId`](../src/App.tsx)；[`cloneExperiment`](../src/services/experiments.ts) 只拷引用 | 提交/展示项去规范化携带 `expId/recordingId/title/thumbnailURL`，点开跳 `#/experiments/{expId}` |
| 反馈 | `experiments/{expId}/comments`：`read: if true`，登录可评（[`firestore.rules`](../firestore.rules) 75-93） | **老师在现有"评论"Tab 里写评语，零开发** |
| 画廊 | [`ExperimentGrid`](../src/components/card/experimentGrid.tsx) + [`Card`](../src/components/card/card.tsx) + [`useThumbnail`](../src/components/card/useThumbnail.ts) | 提交/展示项喂进去即渲染 |
| 路由/导航 | [`App.tsx`](../src/App.tsx) `createHashRouter` children；[`mainMenu.tsx`](../src/components/mainMenu/mainMenu.tsx) `items[]`；[`infoSection.tsx`](../src/pages/experimentAnalyzer/infoSection/infoSection.tsx) antd `<Tabs>` | 加两条路由 + 一个菜单项 + Tab 模式 |
| Functions | 9 个二代函数，`us-central1`；callable + 触发器 + 按 IP 限流（[`submitContactMessage`](../functions/src/index.ts)，`contactRateLimits`）+ `recursiveDelete`（[`onExperimentDeleted`](../functions/src/index.ts)）。**无定时函数** | 抄模板写班级 callable / 触发器；v1 不需要定时函数 |
| Storage | `recordings/{recId}/{file=**}` `read: if true`（[`storage.rules`](../storage.rules) 23-26） | 帧公开读，提交/展示无需改 Storage |

---

## 2. 角色与可见性矩阵

| 内容 | 老师 | 本人(学生) | 其他同学 |
|---|---|---|---|
| 作业元数据 | 读写 | 读 | 读 |
| 作业提交 (`submissions`) | **读全部** | 读写自己 | ✗ |
| 评分 (`grades`) | 读写 | 读自己 | ✗ |
| 展示墙 (`showcase`) | **读写** | 读 | 读 |
| 名单 (`members`) | 读 + 移除 | 读 + 自己退出 | 读 |

> 学生侧没有任何"公开给同学"的开关——同学间能看到对方作品的唯一途径是**老师把它精选进展示墙**。

---

## 3. 数据模型（TypeScript）

时间字段用 Firestore `Timestamp`（`serverTimestamp()` 写入）。`*Uid` = mongoId。

```ts
// src/classroom/types.ts
export interface ClassInfo {
  id: string;              // Firestore 自动 id
  name: string;
  classNumber: string;     // 人类友好、全局唯一（如 6 位数字）；加入时输入
  teacherUid: string;      // mongoId（建班者）
  teacherName: string;
  joinOpen: boolean;       // 老师可关闭加入
  memberCount: number;     // 去规范化，由触发器维护
  createdAt: Timestamp;
}

export interface ClassMember {            // 文档 id == studentUid（mongoId）
  uid: string;
  displayName: string;
  email: string;
  classRole: 'student' | 'ta';
  joinedAt: Timestamp;
  submissionCount: number;                // 去规范化，触发器维护
  lastActiveAt: Timestamp;                // 触发器在提交时更新
}

export interface Assignment {             // classes/{classId}/assignments/{aId}
  id: string;
  title: string;
  description: string;
  dueAt: Timestamp | null;
  refExpId: string | null;                // 老师给本作业的参考实验（可选）
  open: boolean;                          // 是否还收提交
  createdAt: Timestamp;
}

export interface Submission {             // .../assignments/{aId}/submissions/{studentUid}
  studentUid: string;                     // == 文档 id；重交即覆盖（幂等）
  studentName: string;
  expId: string;
  recordingId: string | null;
  sourceType: 'recording' | 'video';
  // —— 去规范化快照：画廊只读班级子树 ——
  title: string;
  thumbnailURL: string;
  duration: number;
  submittedAt: Timestamp;
}

export interface Grade {                  // .../assignments/{aId}/grades/{studentUid}（老师专属）
  studentUid: string;
  score: number | null;
  rubric?: Record<string, number>;
  comment?: string;
  gradedAt: Timestamp;
}

export interface ShowcaseItem {           // classes/{classId}/showcase/{itemId}
  id: string;
  kind: 'material' | 'student-work';      // 老师材料 / 精选学生作品
  ownerUid: string;                       // 老师(material) 或 学生(student-work)
  ownerName: string;
  expId: string;
  recordingId: string | null;
  sourceType: 'recording' | 'video';
  title: string;
  thumbnailURL: string;
  sourceAssignmentId: string | null;      // 由哪个作业精选而来（material 为 null）
  pinned: boolean;
  createdAt: Timestamp;
}
```

`users/{mongoId}` 增量字段：`joinedClasses: string[]`（加入的班级；建班者用 `where('teacherUid','==',me)` 查自己教的班，不入此数组）。

---

## 4. Firestore 布局 + 安全规则 + 索引

### 4.1 布局

```
classes/{classId}                                              ClassInfo
classes/{classId}/members/{studentUid}                         ClassMember
classes/{classId}/assignments/{aId}                            Assignment
classes/{classId}/assignments/{aId}/submissions/{studentUid}   Submission（幂等）
classes/{classId}/assignments/{aId}/grades/{studentUid}        Grade（老师专属）
classes/{classId}/showcase/{itemId}                            ShowcaseItem
classes/{classId}/announcements/{id}                           （可选）公告
classSecrets/{classId}    -> { password }                      明文；仅本班老师可读，仅 callable 写
classNumbers/{number}     -> { classId }                       号码唯一预留 + O(1) 查找，仅 Function 读写
classJoinRateLimits/{uid} -> { count, windowStart }            加入限流，仅 Function 读写
users/{mongoId}.joinedClasses: string[]
```

### 4.2 规则块（追加到现有 [`firestore.rules`](../firestore.rules)）

复用现有 helper：`signedIn()`(=`email_verified==true`)、`mongoId()`。

```
match /classes/{classId} {
  function classData() { return get(/databases/$(database)/documents/classes/$(classId)).data; }
  function isTeacher() { return signedIn() && classData().teacherUid == mongoId(); }
  function isMember()  { return signedIn()
    && exists(/databases/$(database)/documents/classes/$(classId)/members/$(mongoId())); }

  allow read:   if isMember() || isTeacher();
  allow create: if signedIn()
                && request.resource.data.teacherUid == mongoId()
                && request.resource.data.memberCount == 0;
  // 客户端不能转让班级、不能改 memberCount（触发器维护）
  allow update: if isTeacher()
                && request.resource.data.teacherUid == resource.data.teacherUid
                && request.resource.data.memberCount == resource.data.memberCount;
  allow delete: if isTeacher();

  match /members/{studentUid} {
    allow read:   if isMember() || isTeacher();
    allow create: if false;                 // 加入只走 joinClass callable（强制校验密码）
    allow update: if false;                 // 计数由触发器维护
    allow delete: if isTeacher() || (signedIn() && studentUid == mongoId());  // 老师移除 / 学生退出
  }

  match /assignments/{aId} {
    allow read:   if isMember() || isTeacher();
    allow create, update, delete: if isTeacher();

    match /submissions/{studentUid} {
      allow read:   if isTeacher() || (signedIn() && studentUid == mongoId());
      allow create, update: if signedIn() && studentUid == mongoId() && isMember()
                            && request.resource.data.studentUid == studentUid;
      allow delete: if isTeacher() || (signedIn() && studentUid == mongoId());
    }

    match /grades/{studentUid} {
      allow read:  if isTeacher() || (signedIn() && studentUid == mongoId());  // 学生可看自己分数
      allow write: if isTeacher();
    }
  }

  match /showcase/{itemId} {
    allow read:  if isMember() || isTeacher();
    allow write: if isTeacher();            // 学生完全不能写
  }

  match /announcements/{id} {
    allow read:  if isMember() || isTeacher();
    allow write: if isTeacher();
  }
}

// Function 专属（admin SDK 绕过规则）
// 班级口令（明文）：仅本班老师可读（在自己页面查看），仅 createClass/changeClassPassword callable 写
match /classSecrets/{classId} {
  allow read:  if signedIn() && classData().teacherUid == mongoId(); // classData 同上一处定义
  allow write: if false;
}
match /classNumbers/{number}       { allow read, write: if false; }
match /classJoinRateLimits/{uid}   { allow read, write: if false; }
```

> 规则要点：`get(classes/{classId})` 在一次列表监听里被 Firestore **缓存**（同一路径只算 1 次读），所以老师 `onSnapshot` 整个 submissions 子集合不会按文档数线性计费，无需把 `teacherUid` 去规范化到每条提交。

### 4.3 索引

v1 **不需要复合索引**。用到的查询都是单字段（自动索引）：
- 我教的班：`classes where teacherUid == me`
- 我加入的班：按 `joinedClasses` 数组直接 `getDoc`
- 老师看提交：`collection(.../submissions)` 无过滤监听
- 展示墙 / 作业列表：按 `createdAt` 拉取后**客户端排序**（`pinned` 置顶也在客户端处理，避免复合索引）

---

## 5. Cloud Functions（追加到 [`functions/src/index.ts`](../functions/src/index.ts)）

沿用现有 `us-central1`、`onCall` / `onDocument*` 模板。**无需新依赖**。密码以明文存储（班级口令为低敏共享密钥，老师需可查看）。

```ts
// —— Callables ——
// 建班：生成唯一 classNumber（在 classNumbers/{n} 上事务预留），明文密码写 classSecrets/
export const createClass = onCall(async (req) => { /* in: {name, password} -> {classId, classNumber} */ });

// 加入：限流(classJoinRateLimits) → 查 classNumbers/{n} → 校验 classSecrets 明文密码 → 查重/查 joinOpen
//       → 写 members/{mongoId} + arrayUnion(users/{mongoId}.joinedClasses)
export const joinClass = onCall(async (req) => { /* in: {classNumber, password} -> {classId} */ });

// 改密码：校验是本班老师 → 写 classSecrets/{classId}.password（旧口令立即失效）
export const changeClassPassword = onCall(async (req) => { /* in: {classId, newPassword} -> {ok} */ });

// 精选学生作品到展示墙：校验老师 → 读 submission → 写 showcase/{id}
//   关键：若该实验 visibility=='private' 则用 admin SDK 升为 'unlisted'，否则同学点开会 403
export const promoteToShowcase = onCall(async (req) => {
  /* in: {classId, assignmentId, studentUid} -> {itemId} */ });

// —— Triggers ——
// 班级删除 → 递归删子树 + 删 classSecrets/classNumbers 预留（仿 onExperimentDeleted）
export const onClassDeleted = onDocumentDeleted('classes/{classId}', async (e) => { /* recursiveDelete */ });

// 维护 class.memberCount
export const onMemberWritten = onDocumentWritten('classes/{classId}/members/{studentUid}', async (e) => {});

// 维护 member.submissionCount + lastActiveAt
export const onSubmissionWritten =
  onDocumentWritten('classes/{classId}/assignments/{aId}/submissions/{studentUid}', async (e) => {});
```

**客户端直接做的写操作**（无需 Function，规则放行）：建作业、提交作业、老师改作业、老师评分、老师发自己材料到展示墙（老师对自己实验有写权，可先把自己 clip 升 `unlisted` 再发）、取消精选（删 showcase 条目）、移除成员 / 退出班级、删班级（触发器善后）。

> **`createClass` 也用 callable** 的原因：`classNumber` 唯一性需事务保证、口令需服务端集中写入（学生不可写 `classSecrets`）。老师查看口令 = 客户端读 `classSecrets/{classId}`（规则限本班老师）。

---

## 6. 前端集成（逐文件改动表）

| 操作 | 路径 | 用途 |
|---|---|---|
| 新建 | `src/classroom/types.ts` | §3 接口 |
| 新建 | `src/classroom/classroomApi.ts` | 调 callable（create/join/changePassword/promote）+ 纯 Firestore CRUD/监听（建作业、提交、改/删、评分、发/取消展示、名单、退出/移除、删班、列我的班、读口令） |
| 新建 | `src/pages/classroom/MyClassesPage.tsx` | 列"我教的班 + 我加入的班"；建班 / 加入入口 |
| 新建 | `src/pages/classroom/ClassDetailPage.tsx` | 按 `teacherUid===user.id` 分老师/学生视图；antd `<Tabs>`：作业 / 展示墙 / 名单；老师头部含号码 + 口令字段 + 允许加入开关 + 删除 |
| 新建 | `src/components/classroom/CreateClassModal.tsx` | 班名 + 密码 → `createClass`，成功后展示班级号码 |
| 新建 | `src/components/classroom/JoinClassModal.tsx` | 号码 + 密码 → `joinClass`（拦自建班/已加入） |
| 新建 | `src/components/classroom/ClassPasswordField.tsx` | **老师专属**：号码旁内联显示口令，默认 `••••`，点眼睛显示/可复制，铅笔改密码 |
| 新建 | `src/components/classroom/ChangeClassPasswordModal.tsx` | 老师改口令 → `changeClassPassword`（旧口令立即失效） |
| 新建 | `src/components/classroom/Roster.tsx` | 名单 + 详情（提交数 / 最近活跃 / 邮箱）；老师可移除 |
| 新建 | `src/components/classroom/AssignmentList.tsx` | 作业列表（老师 Collapse + 每作业 SubmissionGrid；学生看自己提交状态/评分） |
| 新建 | `src/components/classroom/CreateAssignmentModal.tsx` | 老师建作业（标题/说明/截止） |
| 新建 | `src/components/classroom/SubmissionGrid.tsx` | 老师：某作业全部提交（`onSnapshot` 实时，复用 `Card`）；带"精选到展示墙 / 评分"操作 |
| 新建 | `src/components/classroom/GradeModal.tsx` | 老师私密评分 + 评语（`grades/` 子集合） |
| 新建 | `src/components/classroom/ShowcaseGrid.tsx` | 展示墙（复用 `Card`，`pinned` 置顶）；老师可发材料/置顶/移除 |
| 新建 | `src/components/classroom/SubmitToAssignmentModal.tsx` | 班级页内：学生选自己的实验提交到某作业 |
| 新建 | `src/components/classroom/SubmitToClassButton.tsx` | 分析器内：owner 选班级+作业提交当前实验 |
| 修改 | [`src/App.tsx`](../src/App.tsx) | children 加 `classroom`、`classroom/:classId` 两条路由 |
| 修改 | [`src/components/mainMenu/mainMenu.tsx`](../src/components/mainMenu/mainMenu.tsx) | `items[]` 加"My Classes"项 |
| 修改 | [`src/pages/experimentAnalyzer/experimentAnalyzer.tsx`](../src/pages/experimentAnalyzer/experimentAnalyzer.tsx) | owner 可见"提交到班级"按钮（SubmitToClassButton） |
| 修改 | [`functions/src/index.ts`](../functions/src/index.ts) | §5 四个 callable（create/join/changePassword/promote）+ 三个触发器 |
| 修改 | [`firestore.rules`](../firestore.rules) | 追加 §4.2 规则块（含 `classSecrets` 老师可读） |

**反馈无新组件**：老师打开学生提交的实验（`#/experiments/{expId}`），用现有评论 Tab 写评语；私密分数用 `grades/` 子集合（在 SubmissionGrid 里弹个评分框）。

---

## 7. 关键流程

- **建班**：老师填班名 + 密码 → `createClass` → 返回 `classNumber`，展示给老师分发。
- **加入**：学生填号码 + 密码 → `joinClass`（限流，防号码+密码爆破）→ 进班。
- **布置 + 提交**：老师建作业 → 学生在分析器点"提交到作业" → 写 `submissions/{自己}`（幂等，可重交）。
- **老师监控**：作业页 `onSnapshot` 实时看全部提交；点开任一提交进分析器评阅、评论、评分。
- **精选**：老师在某提交上点"精选" → `promoteToShowcase`（必要时把该实验升 `unlisted`）→ 全班在展示墙可见。
- **删班**：老师删 `classes/{classId}` → `onClassDeleted` 递归清子树 + 预留文档。
- **查看/改口令**：老师在班级页号码旁查看口令（默认 `••••`，点眼睛显示），点铅笔改口令（`changeClassPassword`，旧口令立即失效）。

---

## 8. 隐私边界与注意点

1. **底层像素无访问控制**：`recordings/**` 公开读，任何拿到 `recordingId` 的人都能取帧。班级场景通常够用；若日后要"作业像素仅老师+本人"，再做被推迟的私有录制 grant 模型。
2. **精选 private 实验的 403 边界**：学生 clip 默认 `unlisted`（可点开），但若被设成 `private`，同学点展示墙会 403——所以 `promoteToShowcase` 必须用 admin SDK 把它升 `unlisted`。取消精选不回改 visibility（避免误伤）。
3. **加入限流**：6 位号码 + 密码可被爆破，`joinClass` 复用 `submitContactMessage` 的限流模式（建议 ~10 次/小时/uid）。
4. **口令明文存储**：为支持"老师查看口令"，`classSecrets/{classId}.password` 存明文，规则只允许**本班老师读**（学生不可读，`joinClass` 经 admin SDK 校验）。这是有意的取舍——班级口令是要发给学生的低敏共享密钥，可查看 > 不可恢复的哈希。**切勿**在别处复用此模式存真正的账号密码。
4. **去规范化字段的陈旧**：提交快照里的 `title/thumbnailURL` 是提交时刻的；学生事后改实验标题不会回灌。可接受（成绩是时间点凭证）；若要新鲜值，画廊点开读实时 `experiments/{expId}`。

---

## 9. 分阶段（v1）

- **P1a — 班级骨架**：`createClass`/`joinClass` callable + `classSecrets`/`classNumbers` + 限流；`classes`/`members` 规则；MyClassesPage + 建/加入 Modal + Roster；路由 + 菜单项。
- **P1b — 作业与提交**：assignments CRUD（老师）+ SubmitToAssignmentModal + SubmissionGrid（`onSnapshot` 实时）+ 提交/评分规则 + `onSubmissionWritten` 触发器。
- **P1c — 展示墙与反馈**：`promoteToShowcase` + ShowcaseGrid；复用评论做反馈 + `grades/` 评分；`onClassDeleted`/`onMemberWritten` 触发器；（可选）公告。

## 后续（P2+，暂不实现）

- **帧级直播监控**（老师实时看学生录制画面）：需先验证 Android `Infrared-Explorer-2` 支持增量、无间隔、`.dat` 先于 `.png` 的流式上传；并修复 `imagePlayer` 三个抛出点 + LRU 驱逐 + 差一错误。
- **AI 对比**（参考包络 / DTW 对齐 / 过热告警 / `diagnoseStudent`/`analyzeClass`）：可作为"对已提交数据的离线诊断"，不依赖直播。
- 上述两块的**完整工程推理与对抗性评审修复保留在本文件 git 历史**（2026-06-20 定稿版）。
