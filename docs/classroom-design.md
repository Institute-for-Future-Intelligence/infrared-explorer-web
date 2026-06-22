# Infrared Explorer — Classroom, Live-Streaming & AI-Comparison Engineering Spec

> **Status: DECIDED (2026-06-20).** This document merges five finalized design dimensions and **applies every adversarial must-fix** from the design review. Where a verdict broke a prior decision, the fix is adopted and flagged inline as **[FIX-APPLIED]**. Code facts below were verified against the live repo (`signInButton.tsx`, `types.ts`, `imagePlayer.tsx`, `hooks.ts`, `temperatureReader.ts`) and the absence of `firebase.json` / `firestore.rules` / `storage.rules` / `firestore.indexes.json` / `functions/`.
>
> Identity, the frozen-snapshot submission model, the AI stack, live retention, and new-user provisioning are **settled** (§1). Start with P1 (§9). Do not deviate from the four locked decisions without re-review.

---

## 1. Executive summary + locked decisions

We are adding a Classroom feature to infrared-explorer-web (IE): teachers create classes (join code), students join and submit thermal experiments, teachers monitor students **live** via a sampled thumbnail wall, and an AI layer compares student runs to a teacher-authored reference and raises alerts. Delivered in four phases (P1 classes+submission, P2 rules+identity hardening, P3 live monitoring, P4 AI).

The architecture reuses IE's existing per-frame Storage convention (`recordings/{recordingId}/data_{N}.png|.dat`) and the existing analyzer route (`experiments/:expType/:userId/:expId`) so the *only* net-new live transport piece is a Firestore tail pointer. Pixels never enter Firestore.

The Android capture app (`Infrared-Explorer-2`) is the frame producer; **this web repo is viewer / analyzer / management only** (`src/services/upload.ts` is a one-off seed script, not the recorder).

### Product-owner decisions — LOCKED (2026-06-20)

All four confirmed at the recommended default.

1. **Submission model = FROZEN SNAPSHOT.** Submission copies experiment metadata + thumbnail into the class subtree (`classes/{id}/submissions`). The teacher reads only the class subtree — **no cross-user read of `users/{studentUid}/experiments/**`, and no client-written grant doc** (which would be a privilege-escalation hole). Graded work is a point-in-time artifact; live edits after submission are not pedagogically desirable. The genuinely-live need (watch a student work in real time) is served by the independent **LiveSession** path (§6). *Override path (server-written grant) documented in §5.4 but NOT chosen.*
2. **AI stack = Azure o4-mini** (`chat.completions`, `reasoning_effort` + `max_completion_tokens`), reusing the existing `firebase-functions` callable pattern. Numeric-only payloads; vision gated behind a verified-capability flag.
3. **Live-frame retention = ephemeral + manual save.** Live frames write to `live/{classId}/{studentUid}/{sessionId}/` and are purged after 24 h by a **scheduled Cloud Function** (GCS lifecycle cannot key off Firestore status — [FIX-APPLIED] §6.7). On a graceful "Save", frames are finalized into `recordings/{recordingId}/`. Bounds the ~320 MB/student/40-min liability.
4. **New-student auto-provisioning = YES.** On sign-in with no matching `users/{mongoId}` doc by email, create one (client-generated ObjectId) with `email`, `displayName`, `role:'student'`, then proceed. Without this, students cannot join (verified: today `signInButton.tsx` `forEach` is a no-op for unknown users).

---

## 2. Identity model (the linchpin — resolved definitively)

**DECISION: The canonical app identity is the legacy Mongo ObjectId (`useCommonStore.user.id`). Firestore/Storage rules authorize on a Firebase custom claim `mongoId`, set by a Cloud Function, with `request.auth.token.email_verified == true` as a hard gate. The `uidMap` doc is the P1 interim bridge only.**

Why, and why the alternatives were rejected:

- Every experiment lives at `users/{mongoId}/experiments/{expId}` and the only analyzer route is `experiments/:expType/:userId/:expId` keyed on that ObjectId. Migrating to `auth.uid` would rewrite all data + routes — out of scope. **ObjectId stays the identity used in doc ids, paths, routes, and all `*Uid` fields.**
- Rules cannot match `auth.uid` against an ObjectId doc id, and cannot run `where()` queries. Two bridges were considered:
  - **email-as-doc-id gating** — works but **[FIX-APPLIED, MAJOR]** is impersonable without `email_verified == true` (one unverified-email provider path = takeover), and **[FIX-APPLIED, MAJOR]** Firestore rules have **no `toLowerCase()`/`trim()`**, so email-keyed ids silently deny on any case mismatch.
  - **`uidMap` get()** — a billed read on *every* classroom rule eval, including per-frame Storage reads at 5 fps. Acceptable as a short interim, not as the permanent design.

**Resolution — custom claim `mongoId` (primary):**
- A blocking callable Cloud Function `onUserSignIn`, invoked by the client right after `signInWithPopup` resolves, verifies the Google token, resolves/auto-provisions `users/{mongoId}` by email, and sets a custom claim `{ mongoId }` on the Auth user via the Admin SDK. The client force-refreshes its ID token.
- Rules then read `request.auth.token.mongoId` with **zero extra reads** and compare it to ObjectId-keyed doc ids and `*Uid` fields directly. Every gate also requires `request.auth.token.email_verified == true`.
- `users/{mongoId}` additionally stores `authUid` (the Firebase uid) and `role`.
- **P1 interim fallback (before the claim CF ships):** `uidMap/{authUid} = { mongoId, email }` written idempotently at sign-in; rules use `appId()` = `get(uidMap/$(auth.uid)).data.mongoId`. Swapped to the claim in P2.

**Consequences applied everywhere below:**
- All `teacherUid` / `studentUid` / member-doc-ids / `ownerUserId` = Mongo ObjectId.
- All rules compare against `request.auth.token.mongoId` (the claim) — **not** `auth.uid`, **not** email-as-doc-id.
- Every per-person doc *also* stamps `authEmail` (the verified token email) for audit/defense-in-depth, but **authorization is on the claim**, not the email.

`signInButton.tsx` change (replaces the verified no-op `forEach`):

```ts
onAuthStateChanged(auth, async (fbUser) => {
  if (!fbUser) { useCommonStore.getState().setUser(null); return; }
  // 1) blocking: ensure users doc + custom claim, then refresh token
  const { mongoId, role } = await callOnUserSignIn();   // CF: provisions + sets {mongoId} claim
  await fbUser.getIdToken(true);                          // force-refresh so rules see the claim
  // 2) populate store (today id/role/authUid are all dropped — fixed here)
  useCommonStore.getState().setUser({
    id: mongoId, role, authUid: fbUser.uid,
    displayName: fbUser.displayName, email: fbUser.email, avatar: fbUser.photoURL,
  } as User);
});
```

---

## 3. Finalized data model (TypeScript)

All temperatures Celsius. `*Uid` = Mongo ObjectId. `authEmail` = verified token email (audit/defense-in-depth only; never the authorization key).

```ts
// types.ts — User gains role + authUid (both dropped today; verified at signInButton.tsx)
export interface User {
  displayName: string | null;
  email: string | null;
  avatar: string | null;
  id: string;                                   // CANONICAL Mongo ObjectId
  role?: 'Admin' | 'student' | 'teacher';       // NEW (read at sign-in)
  authUid?: string;                             // NEW (Firebase uid; only for uidMap fallback)
}

// Experiment gains the real-but-untyped Firestore fields (stop `as any` casts):
//   userId?: string;        // owner Mongo id
//   thumbnailFrame?: number;
```

```ts
export interface ClassInfo {
  readonly id: string;                 // Firestore auto-id, stored as info.id
  name: string;
  teacherUid: string;                  // Mongo ObjectId
  teacherEmail: string;                // verified email (audit)
  teacherName: string;
  joinCode: string;                    // 6-char; stored in joinCodes/, NOT here [FIX-APPLIED §4]
  description?: string;
  createdAt: string;                   // ISO
  updatedAt?: unknown;                 // serverTimestamp
}

export interface ClassMember {
  uid: string;                         // == studentUid == doc id (Mongo ObjectId)
  email: string;                       // verified email at join
  displayName: string;
  joinedAt: string;                    // ISO
  classRole?: 'student' | 'ta';
}
```

```ts
// FROZEN-SNAPSHOT submission. Doc id = `${studentUid}_${expId}`.
// Idempotent re-submit overwrites + refreshes submittedAt. expId is ObjectId (no underscores).
export interface Submission {
  expType: ExperimentType;             // 'image' (student work) | 'video' (showcase)
  ownerUserId: string | null;          // Mongo id; null for showcase
  expId: string;
  recordingId?: string;                // image: thumbnail recordings/{recordingId}/data_1.png
  thumbnailPath?: string;              // video/showcase explicit thumbnail
  // --- denormalized snapshot so the teacher gallery reads ONLY the class subtree (no cross-user read) ---
  displayName: string;
  duration: number;
  thumbnailFrame?: number;
  studentUid: string;                  // rule owner field (Mongo id)
  studentName: string;                 // denormalized (FormerMember display)
  authEmail: string;                   // audit
  submittedAt: string;                 // ISO
}
```

```ts
// Live presence + tail pointer. Doc id == studentUid. Pixels in Storage only.
export interface LiveSession {
  studentUid: string;                  // == doc id, rule owner field (Mongo id)
  studentName: string;
  authEmail: string;
  classId: string;
  sessionId: string;                   // live/{classId}/{studentUid}/{sessionId}
  recordingId: string;                 // path builder for viewers
  expId: string;
  expType: ExperimentType;
  // LIVE growing tail. Replaces static lastFrameIndex (hooks.ts:44-46).
  // Stored as 1-based FILE index. Player index conversion in §6.3 [FIX-APPLIED off-by-one].
  latestFrameIndex: number;
  fps: number;                         // 5 (mirror of FPS constant)
  active: boolean;
  status: 'live' | 'paused' | 'ended';
  startedAt: string;                   // ISO
  updatedAt: unknown;                  // serverTimestamp; rewritten on heartbeat
  // alertLevel REMOVED [FIX-APPLIED]: a tamper-bearing safety signal must not live under
  // unrestricted owner-write. Alerts live in the alerts collection (server-written).
}
```

```ts
// Server-written alert (admin SDK). Doc id = `${studentUid}_${ruleId}` (idempotent dedupe).
export interface Alert {
  readonly id: string;                 // `${studentUid}_${ruleId}`
  studentUid: string;                  // rule owner field
  studentName: string;
  authEmail: string;
  classId: string;
  ruleId: string;                      // 'envelope:meanT' | 'safety:maxT' | ...
  level: 1 | 2;                        // 1 warn, 2 critical
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
  frameIndex: number;                  // 1-based recording-space
  t: number;                           // seconds = frameIndex * (1/FPS); derive from FPS, not literal 0.2 [FIX-APPLIED]
  maxT: number; minT: number; meanT: number; stdT: number;
  p10: number; p50: number; p90: number;
  dTdt: number;                        // (meanT - prevMeanT)/dt; 0 on first frame; dt = max(1/FPS, (idx-prevIdx)/FPS)
  spatialGradMean: number;
  hotspotX: number; hotspotY: number;  // argmax normalized [0,1]
  roi3x3: number[];                    // 9 ROI mean temps row-major (fixed basis, comparable across users)
  thermometers?: { id: string; x: number; y: number; c: number }[]; // advisory only
}

export interface EnvelopeBand {
  feature: string;                     // 'meanT'|'maxT'|'dTdt'|... | `roi:${n}`
  tau: number[]; center: number[]; lo: number[]; hi: number[];   // parallel arrays, ~50 anchors
  absTol: number; relTol: number;
}

export interface ReferenceBaseline {   // class-scoped, teacher-authored
  readonly id: string;
  classId: string;
  ownerUid: string;                    // == ClassInfo.teacherUid
  name: string; description?: string;
  sourceExpType: ExperimentType;
  sourceRecordingId?: string; sourceExpId?: string;
  durationFrames: number;
  phaseAnchor: 'index' | 'meanT';      // 'index' default (monotonic-in-time, safe for heat-then-cool)
  features: FrameFeature[];            // compact; raw .dat stays in Storage
  bands: EnvelopeBand[];
  hardSafety: { maxAbsC: number };     // e.g. 80C
  createdAt: string; updatedAt?: unknown;
}
```

---

## 4. Firestore layout + indexes + cascade-delete

```
classes/{classId}                                    -> ClassInfo (auto-id, stored as info.id)
classes/{classId}/members/{studentUid}              -> ClassMember (doc id == studentUid)
classes/{classId}/submissions/{studentUid}_{expId}  -> Submission (frozen snapshot, idempotent)
classes/{classId}/liveSessions/{studentUid}         -> LiveSession (presence + tail pointer)
classes/{classId}/alerts/{studentUid}_{ruleId}      -> Alert (server-written)
classes/{classId}/referenceBaselines/{baselineId}   -> ReferenceBaseline (teacher-authored)

joinCodes/{code}                                    -> { classId } [FIX-APPLIED: not on the world-readable class doc]
users/{mongoId}                                     -> User doc; + joinedClasses: string[]
users/{mongoId}/experiments/{expId}                 -> Experiment (existing)
uidMap/{authUid}                                    -> { mongoId, email } (P1 interim fallback only)

Storage (existing): recordings/{recordingId}/data_{N}.png|.dat
Storage (NEW live): live/{classId}/{studentUid}/{sessionId}/data_{N}.png|.dat  (ephemeral)
```

**[FIX-APPLIED, MINOR] Join code moved off the world-readable class doc.** Class metadata is `allow read: if signed-in`, so a join code stored on it is harvestable. Join codes live in `joinCodes/{code}` (the code *is* the doc id → single-doc `get()`, transactional uniqueness). Join lookup = `get(joinCodes/{normalizedCode})`; no `where()` query, no composite index.

**Composite indexes (`firestore.indexes.json`):**
```
submissions:    studentUid ASC + submittedAt DESC      (student "my submissions")
alerts:         studentUid ASC + lastSeenAt DESC        (student reads own alerts)
alerts:         level ASC + lastSeenAt DESC             (teacher triage by severity)
liveSessions:   status ASC + updatedAt DESC             (teacher live grid by activity)
```
> `liveSessions` is a **per-class subcollection**; the teacher grid query is `collection(classes/{classId}/liveSessions)` ordered by `updatedAt` — no `classId` field filter needed.

**Cascade-delete (`deleteClass`, best-effort manual — Firestore has no cascade):**
1. `getDocs` + `Promise.all(deleteDoc)` over `members`, `submissions`, `liveSessions`, `alerts`, `referenceBaselines`.
2. Delete the `joinCodes/{code}` reservation doc.
3. **[FIX-APPLIED, MAJOR]** Because submissions are frozen snapshots (§1), there are **no cross-user grant docs to clean** — the entire "stale grant leaks cross-user read after class deletion" defect is **eliminated by the frozen-snapshot choice**.
4. `deleteDoc` the class doc.
5. A **scheduled Cloud Function** (NOT GCS lifecycle — [FIX-APPLIED, §6.7]) purges `live/{classId}/**`.
6. Stale `joinedClasses` entries on former students are **not** cleaned (no cross-user write); prune-on-read covers it.

**removeMember:** delete only `members/{studentUid}` (no cross-user write). Student's stale `joinedClasses` entry pruned on their next read.

**`joinedClasses` prune-on-read:** `fetchJoinedClasses` confirms `classes/{classId}/members/{studentUid}` still `exists()` for each entry, dropping ghosts without rewriting the user doc. Every reader must prune.

---

## 5. Finalized security rules

**[FIX-APPLIED, CRITICAL — deploy-state blocker]:** the repo has **no `firebase.json`, no `firestore.rules`, no `storage.rules`, no `firestore.indexes.json`**. Before any rule work (P2 gate):
1. Inspect the IE Firebase project's **currently deployed** console rules and **port them verbatim** into new repo files (non-destructive).
2. Create `firebase.json` referencing `firestore.rules`, `storage.rules`, `firestore.indexes.json`.
3. Test in the emulator. Storage rules are **deny-by-default** under `rules_version='2'` — deploying an incomplete file **breaks existing `getBlob(recordings/...)` reads** in `imagePlayer.tsx`. The `recordings/**` block must be correct on first deploy.
4. Source of truth = repo; deploy via `firebase deploy --only firestore:rules,firestore:indexes,storage`.

Helpers: `mongoId()` = `request.auth.token.mongoId` (custom claim, §2); `verified()` = `request.auth != null && request.auth.token.email_verified == true`.

### 5.1 Firestore rules (classroom subtree)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {

    function verified() { return request.auth != null && request.auth.token.email_verified == true; }
    function mongoId()  { return request.auth.token.mongoId; }   // custom claim (§2)

    // P1 interim fallback only (until claim CF ships): uidMap bridge.
    match /uidMap/{authUid} {
      allow read, write: if request.auth != null && request.auth.uid == authUid;
    }

    // Join-code reservation: code is the doc id (off the world-readable class doc).
    match /joinCodes/{code} {
      allow get:    if verified();                          // single-doc lookup at join time
      allow list:   if false;                               // never enumerate codes
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

      allow read:   if verified();                          // metadata; join gated by joinCodes
      allow create: if verified() && request.resource.data.teacherUid == mongoId();
      allow update, delete: if isTeacher();

      match /members/{memberUid} {
        allow read:   if isMember() || isTeacher();
        allow create: if verified() && memberUid == mongoId()
                      && request.resource.data.uid == memberUid;
        allow delete: if isTeacher() || memberUid == mongoId();   // teacher removes; student leaves
      }

      // Frozen-snapshot submissions: teacher reads the snapshot WITHIN the class subtree.
      // No cross-user read -> no grant attack surface. [FIX-APPLIED CRITICAL]
      match /submissions/{subId} {
        allow read:   if (verified() && resource.data.studentUid == mongoId()) || isTeacher();
        allow create, update: if isMember() && request.resource.data.studentUid == mongoId();
        allow delete: if (verified() && resource.data.studentUid == mongoId()) || isTeacher();
      }

      match /liveSessions/{studentUid} {
        allow read:   if studentUid == mongoId() || isTeacher();
        // student writes only own session; constrain mutable fields (no alert/safety fields here) [FIX-APPLIED]
        allow create, update: if studentUid == mongoId()
          && request.resource.data.studentUid == studentUid
          && request.resource.data.diff(resource.data == null ? request.resource.data : resource.data)
               .affectedKeys().hasOnly(['latestFrameIndex','updatedAt','status','active','startedAt',
                                        'recordingId','sessionId','expId','expType','fps','studentName','authEmail','classId']);
        allow delete: if studentUid == mongoId() || isTeacher();
      }

      // Alerts: server-only (admin SDK bypasses rules). Clients READ; never write. [FIX-APPLIED]
      match /alerts/{alertId} {
        allow read:  if (verified() && resource.data.studentUid == mongoId()) || isTeacher();
        allow write: if false;
      }

      match /referenceBaselines/{bid} {
        allow read:   if isMember() || isTeacher();
        allow create, update, delete: if isTeacher();
      }
    }

    // Existing experiment owner rules stay. No cross-user teacher read in the
    // (chosen) frozen-snapshot model. See §5.4 ONLY if overriding to live-pointer.
    match /users/{ownerId}/experiments/{expId} {
      allow read, write: if verified() && ownerId == mongoId();   // owner-only
    }
  }
}
```

### 5.2 The SOLVED cross-user read policy

**Solved by elimination:** frozen snapshots mean the teacher reads only `classes/{classId}/submissions/{subId}` (authorized by one `isTeacher()` `get()`), and the gallery thumbnail comes from the snapshot's `recordingId`/`thumbnailPath`. There is **no** read of `users/{studentUid}/experiments/**` and **no** client-written grant doc — which was the privilege-escalation hole (any authed user writing a grant to read a victim's data). **[FIX-APPLIED, CRITICAL]**

### 5.3 Storage rules (authored from scratch for IE's real paths)

**[FIX-APPLIED, CRITICAL]:** Do **not** paste another app's rules. Author for IE's real paths only. IE reads `recordings/{recordingId}/data_{N}.png` directly (`imagePlayer.tsx`).

Storage rules cannot read custom claims, so they bridge via `firestore.get()` on a server-written index. **[FIX-APPLIED, CRITICAL — recordings leak]:** the naive `allow read: if request.auth != null` on `recordings/**` would leak every recording to every signed-in user. Replaced with an owner-or-grant gate backed by a **server-written** `recordingGrants/{recordingId}` doc.

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function rg(id) { return firestore.get(/databases/(default)/documents/recordingGrants/$(id)).data; }

    // Persisted recordings: owner OR a teacher whose grant the SERVER wrote. Never open. [FIX-APPLIED]
    match /recordings/{recordingId}/{file} {
      allow read:  if request.auth != null && (
        rg(recordingId).ownerAuthUid == request.auth.uid
        || request.auth.uid in rg(recordingId).allowedReaderAuthUids );
      allow write: if request.auth != null
        && rg(recordingId).ownerAuthUid == request.auth.uid
        && request.resource.size < 1 * 1024 * 1024;        // PNG ~20KB, .dat <=~38KB
    }

    // Ephemeral live frames. Same gate; purged by scheduled CF (§6.7).
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

`recordingGrants/{recordingId|sessionId}` — **server-written only** (admin SDK), keyed by Firebase **uid** because Storage rules see `request.auth.uid`, not the claim:
```
{ ownerAuthUid: string, allowedReaderAuthUids: string[], classId: string, updatedAt }
```
Firestore rule: `allow read: if owner-or-listed; allow write: if false`. The grant is created/refreshed by the submit/stream-start Cloud Function, which resolves teacher `authUid`s from the class. **The grant doc must exist before the first frame upload**, so the stream-start CF writes it first; viewers and recorders tolerate 404 on a not-yet-granted object exactly as the live-follow loop tolerates the growing tail (§6.4).

### 5.4 OVERRIDE ONLY (NOT chosen): live-pointer cross-user read

If the product owner ever rejects frozen snapshots, the grant is written **server-side, never by the client**:
- A `submitToClass` Cloud Function verifies (admin SDK) the caller is a member, reads the class `teacherUid`/teacher `authUid`, then writes `users/{studentUid}/experiments/{expId}/grants/{teacherUid}` = `{ teacherAuthUid, classId }` and merges the teacher's `authUid` into `recordingGrants/{recordingId}.allowedReaderAuthUids`.
- Firestore experiment rule gains: `allow read: if ownerId == mongoId() || (exists(grant) && grant.classId in <still-member classes>)`.
- removeMember/deleteClass **must** delete these grants. This cleanup burden is exactly why frozen-snapshot is chosen.

---

## 6. Live streaming

### 6.1 Transport (DECIDED): frame-over-Storage, not WebRTC
The Android capture client writes per-frame `data_{N}.dat` **then** `data_{N}.png` (`.dat` first, so a viewer gating on `.png` never reads a missing `.dat`) to `live/{classId}/{studentUid}/{sessionId}/`, and writes a throttled Firestore `LiveSession` heartbeat. The web viewer reuses `imagePlayer`'s `getBlob`/`getBytes`-by-index path. No media server/SFU. WebRTC is reserved strictly for a future 1:1 "inspect one student" upgrade, never the wall (fan-out explosion + loses per-pixel Kelvin `.dat`).

### 6.2 Android ⇄ Firestore ⇄ Web contract
- **Start:** `setDoc(liveSessions/{studentUid}, { ...fields, latestFrameIndex:0, status:'live', active:true, startedAt, updatedAt:serverTimestamp() })`. The stream-start CF writes `recordingGrants/{sessionId}` (§5.3) **before** the first frame.
- **Per frame i (1,2,3…, gap-free):** upload `data_{i}.dat` then `data_{i}.png`.
- **latestFrameIndex cadence [FIX-APPLIED, MINOR]:** a K=25 (~5 s) heartbeat is too slow for a ~200 ms follower. **Split the writes:** `updatedAt` heartbeat every K=25 frames (respects the 1-write/s/doc soft limit for the *liveness* signal), but `latestFrameIndex` updated **once per second (every 5 frames)** — within the 1-write/s/doc limit and sufficient for the follower. Both go in the same `update()` when they coincide.
- **Graceful stop:** `update({ latestFrameIndex:<final>, status:'ended', active:false, updatedAt })`.
- **Crash:** no write → detected via `updatedAt` staleness.
- **Liveness:** `live` if `now-updatedAt < 15s`, `stalled` 15–60 s, `dead` >60 s or `status==='ended'`.
- **Sequential/gap-free invariant [FIX-APPLIED]:** the recorder MUST upload strictly sequential, gap-free indices, `.dat` before `.png`, and the experiment MUST have **empty segments** during live (so the no-segments path holds). This is a hard contract. If the Android client batches at finalize instead of streaming incrementally, incremental live upload is **significant net-new Android work** — confirm before P3.

### 6.3 Off-by-one (verified against `hooks.ts:25-26`)
`getRecordingIndex(currIdx)` returns `currIdx + 1` in the no-segments path. So **player index N reads file `data_{N+1}`**. `latestFrameIndex` is stored as the **1-based file index**. Therefore:
> **player tail = `latestFrameIndex - 1`.**

The follower chases `liveTailRef.current = latestFrameIndex - 1`. `data_1.png` is player index 0.

### 6.4 `imagePlayer` live-mode changes (override `imagePlayer.tsx:182-199`)
The play loop today resets `currFrameIdxRef.current = 0; stop()` when `currFrameIdxRef.current > lastFrameIndex`. Live mode:
- New `live?: { sessionId, studentUid, classId }` prop; `isLiveRef`, `liveTailRef`, `liveEndedRef`.
- `onSnapshot(liveSessions/{studentUid})` → `liveTailRef.current = Math.max(0, latestFrameIndex - 1)`; `status==='ended'` → `liveEndedRef = true`.
- `getLastFrameIndex()` = live ? `liveTailRef.current` : static.
- In the tick: if `currFrameIdxRef.current > getLastFrameIndex()` → **if live and not ended, `return` (wait)**; else clamp/stop.
- `preloadFrame` clamps look-ahead to `getLastFrameIndex()` and swallows 404 on the unwritten tail.

**[FIX-APPLIED, MAJOR — two confirmed throwers, both MUST-DO]:**
1. **`loadImage` returns before the cache is set** (verified `imagePlayer.tsx:109-120`: `FileReader.onloadend` runs after the function returns). Refactor to a real Promise that resolves inside `onloadend` (after the cache write) and rejects on `getBlob`/`FileReader` error:
```ts
const loadImage = (index: number) => new Promise<void>((resolve, reject) => {
  fetchImage(index).then(blob => {
    const fr = new FileReader();
    fr.onloadend = () => { if (fr.result) { cacheImageRef.current[index] = fr.result as string; resolve(); } else reject(); };
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  }).catch(reject);   // getBlob 404 on unwritten tail
});
```
2. **`Pako.inflate(undefined)` throws** (verified `temperatureReader.ts:27` has no undefined guard). In live mode `updateThermometersByFrame` reads `cacheThermoArrayBufferRef.current[index]`, `undefined` for a not-yet-fetched tail `.dat`. Guard `getTemperatureAtPosition`/`getTempFromArrayBuffer` and the caller: if the buffer is undefined, skip the update and retry next tick — never `Pako.inflate(undefined)`.

Additional [FIX-APPLIED]:
3. **Live T(t):** do not reuse the fixed 25-point downsample (`step` computed once, goes stale as the tail grows). Append the newest cached `.dat` point incrementally.
4. **Cache eviction (MUST, not deferred):** a 40-min session = ~12000 base64 PNGs → OOM. Live mode runs a **windowed LRU keeping ~last 300 frames** for both `cacheImageRef` and `cacheThermoArrayBufferRef`.
5. **"Jump to live"** affordance sets `currFrameIdxRef.current = liveTailRef.current`.
6. **Single-inflate-per-frame helper:** don't call `getTemperatureAtPosition` per probe (re-inflates the whole 76.8 KB buffer each call). Inflate once per frame, index directly.

### 6.5 Live wall + sampling (concrete feasibility numbers)
- One `onSnapshot` over `classes/{classId}/liveSessions` ordered by `updatedAt desc`. One tile per session.
- **PNG-only thumbnails at 1 frame / 3 s, no `.dat`.**
- Feasibility: full-rate N=30 = **31.9 Mbps + 150 PNG decodes/s + 150 DOM swaps/s** → breaks the tab. Sampled PNG-only at 1/3 s, N=30 = **~1.6 Mbps + ~10 decodes/s** (≈20× cost / >15× bandwidth reduction). **Max students per wall: ~30** at this sampling. `.dat` is fetched only on click-to-inspect a single student (then 5 fps PNG+`.dat`).
- Click a tile → `navigate('/experiments/image/{studentUid}/{expId}?live={studentUid}')`; `experimentAnalyzer` parses `?live=` and passes `live={...}` to `imagePlayer`.
- **[FIX-APPLIED]:** `experimentAnalyzer.tsx` must gain `?live=` parsing (none today) and a **new `classes/:classId/live` route** added to `App.tsx`. Wall thumbnail reads are authorized by the §5.3 Storage grant — **not** open auth.

### 6.6 Monitoring AI placement
Per-student inference runs **in the student's own browser** on the newest frame; it does **not** write to Firestore directly. **[FIX-APPLIED, MAJOR — spoofable safety signal]:** a student-written alert is suppressible/forgeable. The browser **posts the inference result to an admin-SDK callable** (`reportAlert`) that re-checks membership and writes `classes/{classId}/alerts/{studentUid}_{ruleId}` (rules: `allow write: if false` for clients). The teacher wall reads alerts via its existing `onSnapshot`. Hard-safety overtemp uses a **noise-robust statistic (p99 or hot-ROI mean), ≥2 consecutive frames** — never single-pixel argmax.

### 6.7 Retention
Live frames write to `live/{classId}/{studentUid}/{sessionId}/`. **[FIX-APPLIED]:** a GCS lifecycle rule **cannot** key off Firestore `status`, so cleanup is a **scheduled Cloud Function** that deletes `live/**` prefixes older than 24 h (or whose session `status==='ended'`/stale). On graceful "Save", frames are finalized into `recordings/{recordingId}/`. `LiveSession` docs TTL-pruned after `status==='ended'`.

---

## 7. AI comparison

### 7.1 FrameFeature (see §3) — where computed
Per-student, **in the student's browser** as each frame is recorded (the recorder inflates the frame before upload). **[FIX-APPLIED, MAJOR — unverified producer]:** the repo has **only a playback component** (`imagePlayer.tsx`); there is **no capture/upload code** (`upload.ts` is a seed script). "Recorder computes & uploads FrameFeature" is therefore an **explicit new deliverable on the (Android) recorder**, not a free byproduct. If the recorder cannot be modified in P4, fall back to slow-path server-side feature derivation. Features are written to a `liveSessions` feature tail, throttled every K=5 frames.

### 7.2 Envelope + time-alignment
- Teacher records a reference once → offline pass computes the `FrameFeature[]` timeseries and per-feature `[lo,hi]` bands over a **normalized phase axis tau∈[0,1]**, sampled at ~50 anchors: `lo = c - (absTol + relTol·|c|)`, `hi = c + (absTol + relTol·|c|)`.
- **FAST path: phase-normalization** (default `phaseAnchor:'index'`, `tau = clamp(frameIndex/(durationFrames-1), 0, 1)`), O(1)/frame, online, no history. `'meanT'` anchoring only for known-monotonic references; heat-then-cool stays `'index'`.
- **SLOW path: DTW** (O(n·m)) over the full stored series for accurate non-monotonic verdicts.
- Edge guards: first frame `dTdt=0`; student longer than ref → tau clamps to 1.0 (holds last band); index gaps → `dt = max(1/FPS, (idx-prevIdx)/FPS)`.

### 7.3 FAST vs SLOW
- **FAST (browser, deterministic):** per student, on each feature batch, `severity = max_feature(distOutsideBand / bandHalfWidth)`. **WARN** if `severity>1` for ≥3 consecutive sampled points (~3 s); **ALERT** if `severity>2` for ≥3 points; **hard-safety** (p99/hot-ROI mean > `maxAbsC`, ≥2 consecutive frames) → ALERT. Auto-clear after 5 in-band samples. Result POSTed to the `reportAlert` callable (§6.6); the callable writes the dedup'd `${studentUid}_${ruleId}` alert. (The teacher cannot write a student-owned doc — the writer is the server.)
- **SLOW (Cloud Functions, onCall v2, region `us-east4`, `enforceAppCheck`, auth-check first line):** server re-verifies teacher via admin SDK before reading peers' data; reads aggregated student data **server-side** (never client payload — anti prompt-injection). For graded verdicts, the SLOW path **re-derives features from `.dat` server-side** (a ported, self-contained per-frame decoder — `pako.inflate`, `getUint16` at offset+2 big-endian, `/100`, `kelvinToCelsius`; **NOT** `parseRawThermalData`, which has the confirmed `i*size` vs `i*size*INTSIZE` stride bug and only affects multi-frame `.vir` playback) rather than trusting student-written feature docs.

### 7.4 Alert schema/thresholds
See §3 `Alert` (doc id `${studentUid}_${ruleId}`, idempotent open/cleared, server-written). Thresholds: WARN `sev>1`, ALERT `sev>2`, 3-sample debounce; hard-safety `maxAbsC≈80°C` with ≥2-frame noise guard.

### 7.5 Cloud Function signatures + missing infra
**[FIX-APPLIED, MAJOR — missing functions infra]:** the repo has **no `functions/` dir**. P4 must **create the `functions` package** and **port** the `requireAuth`/`enforceRateLimit`/`enforceAppCheck`/`callAzureOpenAI`/`onCall` primitives from `firebase-functions`/`aims2`; do not assume coexistence.

```ts
// functions/src/index.ts — onCall v2, region 'us-east4'
export const reportAlert = onCall({ region:'us-east4', enforceAppCheck: APP_CHECK_ENFORCED, secrets:[] },
  async (req) => {
    const uid = requireAuth(req);                         // student
    const { classId, alert } = validateAlertInput(req.data);
    await assertMemberOfClass(uid, classId);              // admin SDK; uid->mongoId via claim/users doc
    await adminWriteAlert(classId, alert);                // write:false for clients
    return { ok: true };
  });

export const diagnoseStudent = onCall(
  { region:'us-east4', timeoutSeconds:60, secrets:['AZURE_OPENAI_API_KEY'], enforceAppCheck: APP_CHECK_ENFORCED },
  async (req): Promise<{ markdown: string }> => {
    const uid = requireAuth(req);
    const { classId, studentUid } = validateDiagnoseInput(req.data);
    await assertTeacherOfClass(uid, classId);             // [FIX-APPLIED] compares class.teacherUid == caller's mongoId (claim), NOT auth.uid
    await enforceRateLimit(uid, 'diagnoseStudent', 200, 86400);
    const env = await loadReferenceBaseline(classId);
    const ts  = await deriveStudentFeaturesFromDat(classId, studentUid);   // server re-derive for graded verdict
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
    await enforceRateLimit(uid, 'analyzeClass', 30, 86400);     // lower: fans out over whole class
    const env = await loadReferenceBaseline(classId);
    const summary = await summarizeAllStudents(classId, env);   // server-side, capped N + capped pts, numeric only
    if (summary.empty) return { markdown: 'No student data yet.' };
    const md = await callAzureO4Mini({ system: CLASS_ANALYSIS_SYSTEM_PROMPT, userNumeric: serialize(env, summary),
      images: [], reasoning_effort:'medium', max_completion_tokens:100000 });
    if (!md) throw new HttpsError('internal','model returned no content');
    return { markdown: md };
  });
```
Notes: o4-mini reasoning eats `max_completion_tokens` → set generously (100000) or content returns empty. Distinct rate-limit buckets (`diagnoseStudent` 200/day, `analyzeClass` 30/day) keyed `${name}__${uid}`. Throw typed `HttpsError`. Vision gated behind a `VISION_ENABLED` flag set only after testing one `image_url` part against the deployment.

### 7.6 Example LLM prompt (diagnoseStudent, numeric-first)
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
  [0.75,46.0,71.2,0.18,0.71,0.30]  <- hotspot moved  [1.00,49.5,73.8,0.06,0.72,0.29]
DEVIATIONS: meanT sev 1.9 @ tau0.75 (below [55,63]); hotspot drift +0.20x,-0.18y after tau0.6
Diagnose.
```

---

## 8. Frontend integration

### File-by-file

| ACTION | PATH | PURPOSE | PHASE | REUSES |
|---|---|---|---|---|
| CREATE | `src/classroom/Classroom.ts` | `ClassInfo`/`ClassMember`/`Submission` types; `JOIN_CODE_ALPHABET` (ABCDEFGHJKMNPQRSTUVWXYZ23456789), `generateJoinCode(6)`, `normalizeJoinCode` | P1 | aims2 verbatim (drop lesson plans) |
| CREATE | `src/classroom/classroomUtil.ts` | pure async Firestore: createClass / findClassByJoinCode (via `joinCodes/`) / joinClass / leaveClass / fetchJoinedClasses(prune) / fetchClassInfo / fetchMembers / removeMember / deleteClass(cascade) / submitProject / fetchSubmissions / fetchMySubmissions | P1 | aims2; swap import to `firebaseDatabase`; touches NO store |
| CREATE | `src/pages/classroom/MyClassesPage.tsx` | list joined/owned classes; Create/Join entry | P1 | store.user, antd |
| CREATE | `src/pages/classroom/ClassDetailPage.tsx` | teacher: roster+gallery(+wall tab P3)+alerts; student: own submissions; `isTeacher = classInfo.teacherUid===user.id` | P1 (P3 tabs) | Roster, SubmissionGallery, AlertList |
| CREATE | `src/components/classroom/CreateClassModal.tsx` | name input; createClass | P1 | react-draggable, antd Modal |
| CREATE | `src/components/classroom/JoinClassModal.tsx` | join-code input; block own-class/already-member | P1 | react-draggable, antd Modal |
| CREATE | `src/components/classroom/SubmitToClassModal.tsx` | pick class; submitProject(expId,expType,...) | P1 | store.user, antd |
| CREATE | `src/components/classroom/Roster.tsx` | member list; teacher Remove (delete member doc only); FormerMember tag | P1 | antd List |
| CREATE | `src/components/classroom/SubmissionGallery.tsx` | gallery cards; **own per-card onClick** carrying full Submission **[FIX-APPLIED]** (not CardListWrapper single-`e.target.id` delegation); branch thumbnail on expType | P1 | Card |
| CREATE | `src/classroom/liveUtil.ts` | LiveSession heartbeat/tail read+write; onSnapshot helpers | P3 | Storage convention |
| CREATE | `src/pages/classroom/LiveWallPage.tsx` | teacher PNG-only sampled grid | P3 | LiveTile |
| CREATE | `src/components/classroom/LiveTile.tsx` | one student PNG thumbnail @1/3s; no .dat | P3 | getBlob+FileReader |
| CREATE | `src/components/classroom/AlertList.tsx` | render alerts (onSnapshot) | P3/P4 | antd |
| CREATE | `src/pages/experimentAnalyzer/imagePlayer/useLiveFollow.ts` | onSnapshot tail → mutable `liveTailRef`; 404-tolerant chase | P3 | liveUtil |
| MODIFY | `src/App.tsx` | add routes `myClasses`, `classes/:classId`, `classes/:classId/live` | P1 (P3) | createHashRouter |
| MODIFY | `src/components/mainMenu/mainMenu.tsx` | add "My Classes" Link to `items[]` | P1 | items array |
| MODIFY | `src/layouts/header/signInButton.tsx` | call `onUserSignIn` CF; store `role`+`authUid`; force-refresh token; auto-provision | P1/P2 | §2 |
| MODIFY | `src/types.ts` | `User += role?, authUid?`; `Experiment += userId?, thumbnailFrame?` | P1 | — |
| MODIFY | `src/stores/common.ts` | only new global field: `user.role` (and `authUid`); no classMap/currentClassId | P1 | existing setUser |
| MODIFY | `src/pages/experimentAnalyzer/experimentAnalyzer.tsx` | **[FIX-APPLIED]** host the Submit button (knows `expType` via useParams); parse `?live=` and pass `live={...}` to imagePlayer; key `experimentMap` by `${userId}_${expId}` (not bare expId) to avoid wrong-owner cache hits | P1 (submit)/P3 (live) | useParams |
| MODIFY | `src/pages/experimentAnalyzer/toolBar.tsx` | accept `expType`/`ownerId`; render "Submit to Class" only for image | P1 | expId prop |
| MODIFY | `src/pages/experimentAnalyzer/imagePlayer/imagePlayer.tsx` | live-follow (§6.4): wait-at-tail override of L182-199; refactor `loadImage` to awaitable Promise; clamp+404-tolerant preload; LRU eviction; incremental T(t) | P3 | useLiveFollow |
| MODIFY | `src/pages/experimentAnalyzer/hooks.ts` | live mutable tail; import FPS instead of literal `5` | P3 | — |
| CREATE (infra) | `firebase.json`, `firestore.rules`, `storage.rules`, `firestore.indexes.json`, `functions/**` | rules/indexes/CFs (none exist today) | P2/P3/P4 | §5 |

**[FIX-APPLIED] Submit entry point:** `toolBar` is mounted only by `ImagePlayer`, never by `VideoPlayer`, and lacks `expType`. So the submit action is **hosted in `experimentAnalyzer.tsx`** (which has `expType` from `useParams`), passing props down. v1 scope: **image submissions only** unless the owner confirms showcase/video (no recordingId → gallery must branch thumbnails).

**[FIX-APPLIED] antd `<App>`:** `main.tsx` renders bare `<App/>`; aims2 modals use `App.useApp()` which throws without an `<App>` ancestor. Either wrap the tree once in antd `<App>`, or use the static `message`/`Modal.confirm` APIs in ported components.

**[FIX-APPLIED] role:** seeded data has only `'Admin'`/`'student'` (no `'teacher'`). **Teacher status is determined by `classInfo.teacherUid === user.id`**, not by `role`. Any user who creates a class is its teacher; `role` only gates *visibility* of the Create entry. Default: any signed-in user may create a class.

**Store:** only new global field is `user.role`/`authUid`. `joinedClasses` lives on the user doc (arrayUnion/Remove, merge), fetched-with-prune in `MyClassesPage` local state. Class roster/submissions/live sit in **local** component state via `onSnapshot`, torn down on unmount (no global classMap → no ghost-class staleness).

### Teacher class-detail screen (ASCII)
```
+--------------------------------------------------------------------------------------+
| < My Classes      Physics P3  -  Join Code: H7K9QP            [Live Wall] [Delete]    |
+----------------------+---------------------------------------------------------------+
| ROSTER (12)          |  SUBMISSIONS (gallery)        [All v] [Newest v]              |
|----------------------|---------------------------------------------------------------|
| o Ava Chen      [x]  |  +----------+  +----------+  +----------+  +----------+        |
| o Liam Ortiz    [x]  |  | [thumb]  |  | [thumb]  |  | [thumb]  |  | [thumb]  |        |
| o Maya Singh    [x]  |  | Heat Bar |  | Ice Melt |  | Hand IR  |  | Candle   |        |
| o Noah Park     [x]  |  | Ava Chen |  | L.Ortiz  |  | M.Singh  |  | N.Park   |        |
| ...                  |  +----------+  +----------+  +----------+  +----------+        |
| -- Former --         |   (click card -> #/experiments/image/{studentUid}/{expId})    |
| o J.Doe (left)(no x) |---------------------------------------------------------------|
|                      |  LIVE WALL (PNG-only, ~1 frame/3s, N<=~30 -> <2 Mbps)         |
|  [join by code only] |  +--------+ +--------+ +--------+ +--------+   green = ok      |
|                      |  | Ava    | | Liam   | | Maya   | | Noah   |   ! = alert       |
|                      |  | [png]  | | [png]  | | [png !]| | [idle] |   idle = no hb    |
|                      |  | LIVE   | | LIVE   | |CRITICAL| | DEAD   |                   |
|                      |  +--------+ +--------+ +--------+ +--------+                   |
|                      |   (click tile -> analyzer live-follow + .dat, single student) |
+----------------------+---------------------------------------------------------------+
| ALERTS (server-written via reportAlert callable; teacher onSnapshot)                  |
|   ! 14:32  Maya Singh  safety:maxT 71C (p99, 2 consecutive frames)                    |
|   ! 14:29  Liam Ortiz  liveness: no heartbeat > 60s                                   |
+--------------------------------------------------------------------------------------+
isTeacher = classInfo.teacherUid === user.id. Remove deletes only the member doc.
Student view of this route: SUBMISSIONS where studentUid==user.id (rules; no roster/wall/alerts).
```

---

## 9. Phased plan (P1–P4)

**P1 — Classes + submission (no live, no AI). Effort: ~M (1.5–2.5 wk).**
Deliverables: `types.ts` (User.role/authUid, Experiment.userId/thumbnailFrame); `signInButton` role/authUid + auto-provision; `Classroom.ts`; `classroomUtil.ts` (CRUD + join via `joinCodes/` + **frozen-snapshot** submit + fetch + prune-on-read); MyClassesPage; ClassDetailPage (roster + gallery + FormerMember); Create/Join/SubmitToClass modals; SubmissionGallery (per-card onClick); routes; mainMenu entry; submit hosted in experimentAnalyzer (image-only); antd `<App>` wrap.
**[FIX-APPLIED carried into P1]:** stamp `authEmail` on every class/member/submission doc; student list queries carry `where('studentUid','==',user.id)` from day one (mandatory under P2 rules, not later); `experimentMap` keyed by `${userId}_${expId}`.
Dependencies: none. Frozen-snapshot means **no cross-user read blocker** for the gallery.

**P2 — Identity + rules hardening. Effort: ~M (1–2 wk). Depends on P1.**
**Blocker first:** capture current deployed console rules → port into repo → create `firebase.json` → emulator test. Then: `onUserSignIn` CF setting the `mongoId` custom claim + token refresh; firestore.rules (§5.1) gated on claim + `email_verified`; storage.rules from scratch (§5.3) with server-written `recordingGrants`; composite indexes (§4). Verify deny-by-default Storage doesn't break existing `getBlob(recordings/...)`.

**P3 — Live monitoring. Effort: ~L (2–3 wk). Depends on P1+P2.**
`liveUtil`; `useLiveFollow`; imagePlayer live mode with **all three throwers fixed** (awaitable `loadImage`, Pako undefined guard, wait-at-tail) + LRU eviction; LiveWallPage + LiveTile (PNG-only @1/3s); `classes/:classId/live` route; `?live=` parsing in experimentAnalyzer; `liveSessions` subcollection rules + index; split-cadence heartbeat (`latestFrameIndex` 1/s, `updatedAt` every 5 s); scheduled CF to purge `live/**`. **Confirm the Android recorder streams incrementally** (gap-free, `.dat`-before-`.png`, empty segments) before starting — this may be material Android work.

**P4 — AI. Effort: ~L (2–3 wk). Depends on P3.**
Create `functions/` package + port `requireAuth`/`enforceRateLimit`/`enforceAppCheck`/`callAzureOpenAI`; FrameFeature computed in the (Android) recorder — **explicit deliverable**; reference-baseline build (offline envelope); FAST browser monitor → `reportAlert` callable (server-written alerts); SLOW `diagnoseStudent`/`analyzeClass` callables with server-side teacher re-check and **server-side feature re-derivation for graded verdicts**; numeric-only payloads (vision behind verified flag); per-endpoint rate buckets.

Dependency chain: **P2 ⟵ P1; P3 ⟵ P1+P2; P4 ⟵ P3.**

---

## 10. Known risks carried forward + bug notes

- **Identity is the linchpin (RESOLVED §2):** custom claim `mongoId` + `email_verified`. Until the claim CF ships, the `uidMap` fallback carries a billed read per rule eval. Email recycling/unverified-email impersonation mitigated by `email_verified==true` on every gate.
- **Cross-user read (DISSOLVED for chosen model):** frozen-snapshot submissions remove the grant attack surface and the `recordings` leak path for graded work entirely. Override path (§5.4) is NOT chosen.
- **Rules/infra do not exist (verified):** P2 must port current console rules non-destructively and stand up `firebase.json` + emulator before adding classroom rules; Storage deny-by-default can break existing reads.
- **Live throwers (verified, fixed in P3):** `loadImage` non-awaitable + `Pako.inflate(undefined)` + reset-to-0 loop. Cache eviction is mandatory (OOM risk).
- **Off-by-one (verified `hooks.ts:25-26`):** no-segments path `getRecordingIndex = currIdx+1`; `latestFrameIndex` is the **file index**, player tail = `latestFrameIndex - 1`. Live experiments must have **empty segments**.
- **Recorder is unverified/absent:** only playback exists in this repo. Incremental live upload + FrameFeature computation are net-new (likely Android) deliverables, not free byproducts.
- **Scaling:** wall is PNG-only @1/3 s, N≈30 → <2 Mbps; full-rate (31.9 Mbps) is infeasible. Alerts are tiny numeric docs; per-student inference scales linearly.
- **Hard-safety false alarms:** overtemp uses p99/hot-ROI mean over ≥2 frames, never single-pixel argmax.
- **`parseRawThermalData` bug note (relevant only to the SLOW-path Node decoder):** `parseRawThermalData` has the confirmed `i*size` vs `i*size*INTSIZE` stride bug, but it only affects the multi-frame `.vir` `VideoPlayer` showcase path. The per-frame `.dat` path (verified self-contained: `Pako.inflate` → `getUint16(offset+2, big-endian)` → `/100` → `kelvinToCelsius`) is bug-free. **If the SLOW path ports a Node decoder, it must use the per-frame path and must NOT reuse `parseRawThermalData`.**
- **Token budget:** o4-mini reasoning consumes `max_completion_tokens`; set 100000 or content returns empty (detect + throw `HttpsError`).
