/**
 * Cloud Functions for Infrared Explorer (2nd gen, region us-central1).
 *
 * Responsibilities that genuinely cannot live in the pure-frontend client:
 *  - onUserSignIn:   provision the user doc and inject the `mongoId` custom claim
 *                    (identity key = legacy Mongo ObjectId — NOT auth.uid).
 *  - aggregateRatings: maintain experiment.ratingSum/ratingCount via a transaction,
 *                    and notify the owner on a new rating.
 *  - notifyOnComment: notify the experiment owner on a new comment.
 *  - aggregateCommentCount: maintain experiment.commentCount via the count() aggregation.
 *  - cascadeDeleteReplies: when a comment is deleted, delete its replies (the owner
 *                    cannot delete others' replies under the security rules).
 *  - submitContactMessage: server-side entry for the public Contact-us form — rate-limits
 *                    per IP, then writes contactMessages/ (the security rules forbid clients
 *                    writing it directly).
 *  - onContactMessageCreated: email the site owner when a contact message lands.
 *  - getSiteStats:    public, cached global counts (users + experiments) for the homepage
 *                    footer — the security rules don't let clients enumerate either collection.
 *
 * See docs/telelab-migration.md §6.
 */
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall, HttpsError, CallableResponse } from 'firebase-functions/v2/https';
import { onDocumentCreated, onDocumentDeleted, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineSecret, defineString } from 'firebase-functions/params';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import * as crypto from 'crypto';
import * as nodemailer from 'nodemailer';
import Anthropic from '@anthropic-ai/sdk';
import { FPS, frameStats, recordingSampling, thermometerCelsius, type Segment, type ThermometerLike } from './thermal';

admin.initializeApp();
setGlobalOptions({ region: 'us-central1' });

const db = admin.firestore();

/** Generate a 24-hex Mongo-style ObjectId (4-byte time + 5-byte random + 3-byte counter). */
let objectIdCounter = crypto.randomBytes(3).readUIntBE(0, 3);
function newObjectId(): string {
  const ts = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, '0');
  const rand = crypto.randomBytes(5).toString('hex');
  objectIdCounter = (objectIdCounter + 1) % 0xffffff;
  const counter = objectIdCounter.toString(16).padStart(6, '0');
  return ts + rand + counter;
}

/**
 * Called by the client right after Google sign-in. Resolves (or provisions) the caller's
 * Mongo ObjectId, mints the `mongoId` custom claim, and keeps an authUid->mongoId map.
 * The client must call getIdToken(true) afterwards to pick up the claim.
 */
export const onUserSignIn = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const uid = auth.uid;
  const email = (auth.token.email as string | undefined) ?? null;
  const displayName = (auth.token.name as string | undefined) ?? null;
  const avatar = (auth.token.picture as string | undefined) ?? null;

  // Already minted on a previous sign-in.
  const existingClaim = auth.token.mongoId as string | undefined;
  if (existingClaim) {
    return { mongoId: existingClaim, provisioned: false };
  }

  let mongoId: string | null = null;

  // Reuse an existing (seeded / migrated) user doc that matches this email.
  if (email) {
    const byEmail = await db.collection('users').where('email', '==', email).limit(1).get();
    if (!byEmail.empty) {
      const docSnap = byEmail.docs[0];
      // Seeded docs may store the ObjectId in an `id` field rather than as the doc id.
      mongoId = (docSnap.data().id as string | undefined) ?? docSnap.id;
    }
  }

  const provisioned = mongoId === null;
  if (mongoId === null) {
    mongoId = newObjectId();
    await db.doc(`users/${mongoId}`).set({
      id: mongoId,
      authUid: uid,
      email,
      displayName,
      avatar,
      role: 'student',
      prefs: { disallowCopy: false, disallowNotification: false, disallowNewsletter: false },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    await db.doc(`users/${mongoId}`).set({ authUid: uid }, { merge: true });
  }

  // Public profile slice (anyone can read displayName/avatar; email/prefs/role stay private).
  await db.doc(`usersPublic/${mongoId}`).set({ displayName, avatar }, { merge: true });
  // Transition map so rules can bridge authUid -> mongoId before the claim propagates.
  await db.doc(`uidMap/${uid}`).set({ mongoId });

  await admin.auth().setCustomUserClaims(uid, { mongoId });
  return { mongoId, provisioned };
});

/** Write a notification to the experiment owner (skips system/self/opted-out). */
async function notifyExperimentOwner(expId: string, fromId: string, type: 'comment' | 'rating') {
  const expSnap = await db.doc(`experiments/${expId}`).get();
  const exp = expSnap.data();
  if (!exp) return;
  const ownerId = exp.ownerId as string | undefined;
  if (!ownerId || ownerId === 'system' || ownerId === fromId) return;

  const ownerSnap = await db.doc(`users/${ownerId}`).get();
  if (ownerSnap.data()?.prefs?.disallowNotification) return;

  // Coalesce: if an unread notification of the same (type, from) already exists, bump it
  // instead of stacking duplicates.
  const dup = await db
    .collection(`users/${ownerId}/notifications`)
    .where('expId', '==', expId)
    .where('fromId', '==', fromId)
    .where('type', '==', type)
    .where('read', '==', false)
    .limit(1)
    .get();
  const fromName = (await db.doc(`usersPublic/${fromId}`).get()).data()?.displayName ?? 'Someone';
  const date = new Date().toISOString();
  if (!dup.empty) {
    await dup.docs[0].ref.set({ fromName, date }, { merge: true });
  } else {
    await db.collection(`users/${ownerId}/notifications`).add({ fromId, fromName, type, expId, read: false, date });
  }
}

/** Recompute ratingSum/ratingCount on the parent experiment; notify owner on a new rating. */
export const aggregateRatings = onDocumentWritten('experiments/{expId}/ratings/{ratingId}', async (event) => {
  const { expId, ratingId } = event.params;
  const expRef = db.doc(`experiments/${expId}`);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(expRef.collection('ratings'));
    let sum = 0;
    let count = 0;
    snap.forEach((d) => {
      const r = d.data().rating;
      if (typeof r === 'number') {
        sum += r;
        count += 1;
      }
    });
    tx.set(expRef, { ratingSum: sum, ratingCount: count }, { merge: true });
  });

  const created = !event.data?.before.exists && !!event.data?.after.exists;
  if (created) {
    await notifyExperimentOwner(expId, ratingId, 'rating');
  }
});

/** Notify the experiment owner when a new comment is posted. */
export const notifyOnComment = onDocumentCreated('experiments/{expId}/comments/{commentId}', async (event) => {
  const data = event.data?.data();
  if (!data?.senderId) return;
  await notifyExperimentOwner(event.params.expId, data.senderId as string, 'comment');
});

/**
 * Maintain experiment.commentCount. Recomputes via the server-side count() aggregation on
 * any comment create/delete, so it is idempotent under Functions' at-least-once delivery
 * (an edit leaves the count unchanged and is skipped). Client-read-only, like the rating aggregates.
 */
export const aggregateCommentCount = onDocumentWritten('experiments/{expId}/comments/{commentId}', async (event) => {
  const created = !event.data?.before.exists && !!event.data?.after.exists;
  const deleted = !!event.data?.before.exists && !event.data?.after.exists;
  if (!created && !deleted) return;
  const expRef = db.doc(`experiments/${event.params.expId}`);
  const agg = await expRef.collection('comments').count().get();
  await expRef.set({ commentCount: agg.data().count }, { merge: true });
});

/** When a comment is deleted, delete its replies (rules forbid the owner deleting others' replies). */
export const cascadeDeleteReplies = onDocumentDeleted('experiments/{expId}/comments/{commentId}', async (event) => {
  const { expId, commentId } = event.params;
  const replies = await db.collection(`experiments/${expId}/comments`).where('replyTo', '==', commentId).get();
  if (replies.empty) return;
  const batch = db.batch();
  replies.forEach((d) => batch.delete(d.ref));
  await batch.commit();
});

/**
 * When an experiment is permanently deleted, recursively delete its subcollections
 * (thermometers / annotations / comments / ratings). Firestore does not cascade to
 * subcollections, and the security rules forbid the client from deleting others' rating
 * docs, so this Admin-SDK cleanup prevents orphaned sub-docs. See docs/telelab-migration.md §6.
 */
export const onExperimentDeleted = onDocumentDeleted('experiments/{expId}', async (event) => {
  await db.recursiveDelete(db.doc(`experiments/${event.params.expId}`));
});

// ---------------------------------------------------------------------------
// Contact-us form: server-side submission (anti-spam) + owner email notification
// ---------------------------------------------------------------------------

// SMTP transport for the notification email. Leave SMTP_HOST unset to skip sending.
// Host/port aren't sensitive (plain params); only the credentials are secrets.
const SMTP_HOST = defineString('SMTP_HOST', { default: '' });
const SMTP_PORT = defineString('SMTP_PORT', { default: '587' });
const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');
// Where contact messages are emailed (and the From: address). Defaults to the site owner.
const CONTACT_NOTIFY_TO = defineString('CONTACT_NOTIFY_TO', { default: 'xiaotong@intofuture.org' });

// Per-IP rate limit: at most this many submissions within the rolling window.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Pull the best-guess client IP out of an onCall raw request. */
function clientIp(req: { ip?: string; headers: Record<string, string | string[] | undefined> }): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  if (Array.isArray(fwd) && fwd.length > 0) return String(fwd[0]).trim();
  return req.ip || 'unknown';
}

/**
 * Public callable for the Contact-us form. No auth required, but submissions are rate-limited
 * per IP. On success it writes the message with the Admin SDK (rules forbid clients writing
 * contactMessages directly).
 */
export const submitContactMessage = onCall(async (request) => {
  const { name, email, message } = (request.data ?? {}) as {
    name?: string;
    email?: string;
    message?: string;
  };

  // Basic validation (mirrors the security rules that previously guarded the client write).
  const trimmedName = (name ?? '').trim();
  const trimmedEmail = (email ?? '').trim();
  const trimmedMessage = (message ?? '').trim();
  if (!trimmedName || !trimmedEmail || !trimmedMessage) {
    throw new HttpsError('invalid-argument', 'Name, email and message are all required.');
  }
  if (trimmedMessage.length > 5000 || trimmedName.length > 200 || trimmedEmail.length > 320) {
    throw new HttpsError('invalid-argument', 'One of the fields is too long.');
  }

  // Anti-spam: a per-IP rolling-window rate limit.
  const ip = clientIp(request.rawRequest);
  const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
  const limitRef = db.doc(`contactRateLimits/${ipHash}`);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(limitRef);
    const data = snap.data() as { count?: number; windowStart?: number } | undefined;
    const within = data?.windowStart != null && now - data.windowStart < RATE_LIMIT_WINDOW_MS;
    const count = within ? (data?.count ?? 0) : 0;
    if (count >= RATE_LIMIT_MAX) {
      throw new HttpsError('resource-exhausted', 'Too many messages from your network. Please try again later.');
    }
    tx.set(limitRef, { count: count + 1, windowStart: within ? data!.windowStart : now }, { merge: true });
  });

  await db.collection('contactMessages').add({
    name: trimmedName,
    email: trimmedEmail,
    message: trimmedMessage,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true };
});

/** Email the site owner when a contact message is created. Decoupled so SMTP issues never
 *  surface to the visitor (the message is already safely stored). */
export const onContactMessageCreated = onDocumentCreated(
  { document: 'contactMessages/{id}', secrets: [SMTP_USER, SMTP_PASS] },
  async (event) => {
    const host = SMTP_HOST.value();
    if (!host) return; // SMTP not configured -> nothing to send
    const msg = event.data?.data();
    if (!msg) return;

    const transport = nodemailer.createTransport({
      host,
      port: Number.parseInt(SMTP_PORT.value(), 10) || 587,
      secure: (Number.parseInt(SMTP_PORT.value(), 10) || 587) === 465,
      auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() },
    });

    const to = CONTACT_NOTIFY_TO.value();
    await transport.sendMail({
      from: `Infrared Explorer <${SMTP_USER.value() || to}>`,
      to,
      replyTo: `${msg.name} <${msg.email}>`,
      subject: `[Contact] New message from ${msg.name}`,
      text: `From: ${msg.name} <${msg.email}>\n\n${msg.message}`,
    });
  },
);

/**
 * Public global site statistics for the homepage footer ("N users created M experiments").
 * The security rules deliberately keep the `users` and `experiments` collections
 * un-enumerable by clients, so the counts are computed here with the Admin SDK (which
 * bypasses rules) via count() aggregations. Results are cached in-instance for STATS_TTL_MS
 * so a burst of homepage loads doesn't issue a count query each time. No auth required.
 */
const STATS_TTL_MS = 5 * 60 * 1000;
let statsCache: { value: { users: number; experiments: number }; expires: number } | null = null;

export const getSiteStats = onCall(async () => {
  const now = Date.now();
  if (statsCache && statsCache.expires > now) return statsCache.value;

  const [usersSnap, experimentsSnap] = await Promise.all([
    db.collection('users').count().get(),
    db.collection('experiments').count().get(),
  ]);
  const value = {
    users: usersSnap.data().count,
    experiments: experimentsSnap.data().count,
  };
  statsCache = { value, expires: now + STATS_TTL_MS };
  return value;
});

// ---------------------------------------------------------------------------
// Classroom (v1) — create/join by class-number + password, teacher-curated
// showcase, denormalized counters. See docs/classroom-design-zh.md.
//   - createClass / joinClass / promoteToShowcase: callables (password hashing,
//     number uniqueness, cross-user writes that the rules can't safely allow).
//   - onClassDeleted / onMemberWritten / onSubmissionWritten: maintenance triggers.
// ---------------------------------------------------------------------------

// Class join passwords are stored as plaintext in classSecrets/{classId} (read-gated to the
// class teacher by the security rules). This is intentional: the join code is a low-value
// shared secret the teacher hands to students, and the teacher must be able to view it on
// their own page. Students cannot read it (only the teacher / Admin SDK can).

/** The caller's Mongo ObjectId from the custom claim, or throw. */
function requireMongoId(auth: { uid: string; token: Record<string, unknown> } | undefined): string {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const mongoId = auth.token.mongoId as string | undefined;
  if (!mongoId) throw new HttpsError('failed-precondition', 'Identity not provisioned yet. Sign in again.');
  return mongoId;
}

const JOIN_RATE_MAX = 10;
const JOIN_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Create a class: allocate a unique 6-digit number, hash the password, write the class doc. */
export const createClass = onCall(async (request) => {
  const mongoId = requireMongoId(request.auth);
  const { name, password } = (request.data ?? {}) as { name?: string; password?: string };
  const trimmedName = (name ?? '').trim();
  const pwd = (password ?? '').trim();
  if (!trimmedName || trimmedName.length > 100) {
    throw new HttpsError('invalid-argument', 'Class name is required (≤100 chars).');
  }
  if (pwd.length < 4 || pwd.length > 100) {
    throw new HttpsError('invalid-argument', 'Password must be 4–100 characters.');
  }

  const teacherName = (request.auth!.token.name as string | undefined) ?? '';
  const teacherEmail = (request.auth!.token.email as string | undefined) ?? '';

  // Reserve a unique class number transactionally (retry on the rare collision).
  const classRef = db.collection('classes').doc();
  let classNumber = '';
  for (let attempt = 0; attempt < 12 && !classNumber; attempt++) {
    const candidate = crypto.randomInt(100000, 1000000).toString();
    const numRef = db.doc(`classNumbers/${candidate}`);
    const ok = await db.runTransaction(async (tx) => {
      if ((await tx.get(numRef)).exists) return false;
      tx.set(numRef, { classId: classRef.id });
      return true;
    });
    if (ok) classNumber = candidate;
  }
  if (!classNumber) throw new HttpsError('resource-exhausted', 'Could not allocate a class number. Try again.');

  await db.doc(`classSecrets/${classRef.id}`).set({ password: pwd });
  await classRef.set({
    name: trimmedName,
    classNumber,
    teacherUid: mongoId,
    teacherName,
    teacherEmail,
    joinOpen: true,
    memberCount: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { classId: classRef.id, classNumber };
});

/** Join a class by number + password. Rate-limited per user to blunt brute-force. */
export const joinClass = onCall(async (request) => {
  const mongoId = requireMongoId(request.auth);
  const { classNumber, password } = (request.data ?? {}) as { classNumber?: string; password?: string };
  const num = (classNumber ?? '').trim();
  const pwd = (password ?? '').trim();
  if (!num || !pwd) throw new HttpsError('invalid-argument', 'Class number and password are required.');

  // Per-user rolling-window rate limit (mirrors submitContactMessage).
  const limitRef = db.doc(`classJoinRateLimits/${mongoId}`);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const data = (await tx.get(limitRef)).data() as { count?: number; windowStart?: number } | undefined;
    const within = data?.windowStart != null && now - data.windowStart < JOIN_RATE_WINDOW_MS;
    const count = within ? (data?.count ?? 0) : 0;
    if (count >= JOIN_RATE_MAX) {
      throw new HttpsError('resource-exhausted', 'Too many join attempts. Please try again later.');
    }
    tx.set(limitRef, { count: count + 1, windowStart: within ? data!.windowStart : now }, { merge: true });
  });

  const numSnap = await db.doc(`classNumbers/${num}`).get();
  if (!numSnap.exists) throw new HttpsError('not-found', 'No class with that number.');
  const classId = numSnap.data()!.classId as string;

  const [classSnap, secretSnap, memberSnap, pubSnap] = await Promise.all([
    db.doc(`classes/${classId}`).get(),
    db.doc(`classSecrets/${classId}`).get(),
    db.doc(`classes/${classId}/members/${mongoId}`).get(),
    db.doc(`usersPublic/${mongoId}`).get(),
  ]);
  const cls = classSnap.data();
  const secret = secretSnap.data();
  if (!cls || !secret) throw new HttpsError('not-found', 'Class not found.');
  if (cls.teacherUid === mongoId) throw new HttpsError('failed-precondition', 'You are the teacher of this class.');
  if (memberSnap.exists) return { classId, alreadyMember: true };
  if (cls.joinOpen === false) throw new HttpsError('failed-precondition', 'This class is not accepting new members.');
  if (secret.password !== pwd) {
    throw new HttpsError('permission-denied', 'Incorrect password.');
  }

  const displayName =
    (pubSnap.data()?.displayName as string | undefined) ?? (request.auth!.token.name as string | undefined) ?? '';
  const email = (request.auth!.token.email as string | undefined) ?? '';
  await db.doc(`classes/${classId}/members/${mongoId}`).set({
    uid: mongoId,
    displayName,
    email,
    classRole: 'student',
    joinedAt: admin.firestore.FieldValue.serverTimestamp(),
    submissionCount: 0,
    lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db
    .doc(`users/${mongoId}`)
    .set({ joinedClasses: admin.firestore.FieldValue.arrayUnion(classId) }, { merge: true });
  return { classId, joined: true };
});

/**
 * Teacher resets the class join password. The password is one-way hashed (scrypt), so it
 * can't be recovered/shown — the teacher sets a new one and the old one stops working.
 * Only the class's teacher may do this.
 */
export const changeClassPassword = onCall(async (request) => {
  const mongoId = requireMongoId(request.auth);
  const { classId, newPassword } = (request.data ?? {}) as { classId?: string; newPassword?: string };
  if (!classId) throw new HttpsError('invalid-argument', 'Missing classId.');
  const pwd = (newPassword ?? '').trim();
  if (pwd.length < 4 || pwd.length > 100) {
    throw new HttpsError('invalid-argument', 'Password must be 4–100 characters.');
  }
  const cls = (await db.doc(`classes/${classId}`).get()).data();
  if (!cls) throw new HttpsError('not-found', 'Class not found.');
  if (cls.teacherUid !== mongoId)
    throw new HttpsError('permission-denied', 'Only the teacher can change the password.');

  await db.doc(`classSecrets/${classId}`).set({ password: pwd });
  return { ok: true };
});

/**
 * Teacher promotes a student's submission to the class showcase. Bumps a `private`
 * experiment to `unlisted` (Admin SDK) so classmates can open it; otherwise they'd 403.
 */
export const promoteToShowcase = onCall(async (request) => {
  const mongoId = requireMongoId(request.auth);
  const { classId, assignmentId, studentUid } = (request.data ?? {}) as {
    classId?: string;
    assignmentId?: string;
    studentUid?: string;
  };
  if (!classId || !assignmentId || !studentUid) throw new HttpsError('invalid-argument', 'Missing parameters.');

  const cls = (await db.doc(`classes/${classId}`).get()).data();
  if (!cls) throw new HttpsError('not-found', 'Class not found.');
  if (cls.teacherUid !== mongoId) throw new HttpsError('permission-denied', 'Only the teacher can promote work.');

  const sub = (await db.doc(`classes/${classId}/assignments/${assignmentId}/submissions/${studentUid}`).get()).data();
  if (!sub) throw new HttpsError('not-found', 'Submission not found.');

  if (sub.expId) {
    const expRef = db.doc(`experiments/${sub.expId}`);
    const exp = (await expRef.get()).data();
    if (exp && exp.visibility === 'private') {
      await expRef.set({ visibility: 'unlisted' }, { merge: true });
    }
  }

  const itemRef = db.doc(`classes/${classId}/showcase/${studentUid}_${assignmentId}`);
  await itemRef.set({
    kind: 'student-work',
    ownerUid: studentUid,
    ownerName: sub.studentName ?? '',
    expId: sub.expId ?? '',
    recordingId: sub.recordingId ?? null,
    sourceType: sub.sourceType ?? null,
    title: sub.title ?? '',
    thumbnailURL: sub.thumbnailURL ?? '',
    sourceAssignmentId: assignmentId,
    pinned: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { itemId: itemRef.id };
});

/** Class deleted -> recursively delete its subtree + the secret/number reservation docs. */
export const onClassDeleted = onDocumentDeleted('classes/{classId}', async (event) => {
  const { classId } = event.params;
  await db.recursiveDelete(db.doc(`classes/${classId}`));
  const cls = event.data?.data();
  const batch = db.batch();
  batch.delete(db.doc(`classSecrets/${classId}`));
  if (cls?.classNumber) batch.delete(db.doc(`classNumbers/${cls.classNumber}`));
  await batch.commit();
});

/** Maintain class.memberCount via the count() aggregation (idempotent). */
export const onMemberWritten = onDocumentWritten('classes/{classId}/members/{studentUid}', async (event) => {
  const created = !event.data?.before.exists && !!event.data?.after.exists;
  const deleted = !!event.data?.before.exists && !event.data?.after.exists;
  if (!created && !deleted) return;
  const classRef = db.doc(`classes/${event.params.classId}`);
  // Skip if the class is being torn down, so a merge-set doesn't resurrect the deleted doc.
  if (!(await classRef.get()).exists) return;
  const agg = await classRef.collection('members').count().get();
  await classRef.set({ memberCount: agg.data().count }, { merge: true });
});

/** Maintain member.submissionCount + lastActiveAt when a submission is written. */
export const onSubmissionWritten = onDocumentWritten(
  'classes/{classId}/assignments/{aId}/submissions/{studentUid}',
  async (event) => {
    const { classId, studentUid } = event.params;
    const memberRef = db.doc(`classes/${classId}/members/${studentUid}`);
    if (!(await memberRef.get()).exists) return; // not a member / torn down

    // Recompute across the class's assignments (idempotent; avoids a collection-group index).
    const assignments = await db.collection(`classes/${classId}/assignments`).get();
    const present = await Promise.all(
      assignments.docs.map((a) =>
        db
          .doc(`classes/${classId}/assignments/${a.id}/submissions/${studentUid}`)
          .get()
          .then((s) => s.exists),
      ),
    );
    const submissionCount = present.filter(Boolean).length;
    await memberRef.set(
      { submissionCount, lastActiveAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true },
    );
  },
);

// ---------------------------------------------------------------------------
// AI lab-report generator (P0). A secure server-side proxy to the Claude API:
// it reads the experiment's real thermal data (per-thermometer T(t) series + per-frame
// global min/max/mean/hotspot, decoded from the same Storage frames the analyzer plays),
// then asks Claude for a physics-grounded lab-report DRAFT in the experiment's language.
// The draft pre-fills the editable "WRITE HERE" description box — nothing is auto-saved.
// The Claude key never reaches the client: it lives in Secret Manager (defineSecret), exactly
// like SMTP_USER/SMTP_PASS. See docs/telelab-migration.md §6 and the project memory.
// ---------------------------------------------------------------------------

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

/**
 * The Claude API key, tolerating a value accidentally wrapped in quotes or padded with whitespace
 * (e.g. `ANTHROPIC_API_KEY="sk-ant-..."` in functions/.secret.local, which the emulator passes through
 * verbatim -> Anthropic 401 -> an opaque 500). A clean key is returned unchanged.
 */
function claudeApiKey(): string {
  return ANTHROPIC_API_KEY.value()
    .trim()
    .replace(/^["']|["']$/g, '');
}

// At most this many frames sampled across the clip for the report (matches the analyzer's
// LINTPLOT_DATAPOINT_LIMIT so the AI sees the same T(t) the user does).
const REPORT_FRAME_SAMPLES = 25;

// Per-user AI rate limit (rolling window) — reuses the contact/join limiter pattern to cap cost.
const AI_RATE_MAX = 20;
const AI_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Per-user rolling-window rate limit for AI calls (mirrors joinClass / submitContactMessage). */
async function enforceAiRateLimit(mongoId: string): Promise<void> {
  const limitRef = db.doc(`aiRateLimits/${mongoId}`);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const data = (await tx.get(limitRef)).data() as { count?: number; windowStart?: number } | undefined;
    const within = data?.windowStart != null && now - data.windowStart < AI_RATE_WINDOW_MS;
    const count = within ? (data?.count ?? 0) : 0;
    if (count >= AI_RATE_MAX) {
      throw new HttpsError('resource-exhausted', 'AI usage limit reached for now. Please try again later.');
    }
    tx.set(limitRef, { count: count + 1, windowStart: within ? data!.windowStart : now }, { merge: true });
  });
}

const REPORT_SYSTEM_PROMPT = `You are a patient, rigorous science teacher helping a secondary-school student write up an infrared (thermal-imaging) experiment.

You are given a compact JSON summary of the experiment's measured data:
- Temperatures are in degrees Celsius; times are in seconds; image positions are normalized to [0,1] where x runs left->right and y runs top->bottom (y=0 is the top of the image). "hotspot" is the location of the hottest pixel in a frame.
- "thermometers" are the probes the student placed; each has a position and a temperature-vs-time series.
- "frameGlobal" is the whole-frame min/max/mean and hotspot at each sampled time.

Rules:
- Ground EVERY quantitative claim in the provided numbers. NEVER invent temperatures, rates, times, or objects that are not in the data.
- Explain the physics of WHY the heat behaves as it does (conduction, convection, radiation, evaporative cooling, thermal equilibrium, phase change) ONLY when the data supports it; when a mechanism is ambiguous, say so and hedge ("this is consistent with...").
- Keep the tone encouraging and age-appropriate. Do not speculate about what the object is beyond what the data implies.
- Output a well-structured lab report in English Markdown with these sections: Suggested title / Observations / Quantitative analysis / Physics explanation / Conclusion.
- Respond with ONLY the report body — no preamble, no meta commentary about being an AI.`;

/** Call Claude for the report draft. Streams server-side so a long generation can't hit an HTTP timeout. */
async function callClaudeForReport(summary: unknown, apiKey: string): Promise<string> {
  const anthropic = new Anthropic({ apiKey });
  const userPrompt =
    `Thermal experiment data (JSON):\n\n${JSON.stringify(summary)}\n\n` +
    `Write the lab report now in English, following the required section structure.`;

  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 6000,
    thinking: { type: 'adaptive' },
    system: REPORT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const msg = await stream.finalMessage();
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw new HttpsError('internal', 'The model returned no text.');
  return text;
}

/**
 * Build the compact numeric summary of a recording experiment: per-thermometer T(t) series plus the
 * per-frame whole-image min/max/mean/hotspot, sampled across the clip. This is the grounding context
 * shared by the whole-clip lab report and the free-form AI Q&A. Throws failed-precondition when no
 * frames decode. (The Admin SDK bypasses the visibility rules for the thermometer + frame reads.)
 */
async function buildThermalSummary(expId: string, exp: FirebaseFirestore.DocumentData, recordingId: string) {
  const thermoSnap = await db.collection(`experiments/${expId}/thermometers`).get();
  const thermometers = thermoSnap.docs.map((d, i) => {
    const t = d.data() as ThermometerLike;
    return {
      label: `T${i + 1}`,
      x: t.x,
      y: t.y,
      measuringAreaType: t.measuringAreaType,
      measuringAreaWidth: t.measuringAreaWidth,
      measuringAreaHeight: t.measuringAreaHeight,
    };
  });

  const duration = Number(exp.duration) || 0;
  const sampling = recordingSampling((exp.segments as Segment[] | null) ?? null, duration, REPORT_FRAME_SAMPLES);
  if (sampling.samples.length === 0) {
    throw new HttpsError('failed-precondition', 'This experiment has no frames to analyze.');
  }

  // Download the sampled thermal frames in parallel (missing frames -> null, skipped).
  const bucket = admin.storage().bucket();
  const frames = await Promise.all(
    sampling.samples.map(async (s) => {
      try {
        const [buf] = await bucket.file(`recordings/${recordingId}/data_${s.recordingIndex}.dat`).download();
        return new Uint8Array(buf);
      } catch {
        return null;
      }
    }),
  );

  // Build a compact numeric summary: per-thermometer T(t) + per-frame global stats.
  const series = thermometers.map((t) => ({
    label: t.label,
    position: { x: Number((t.x ?? 0).toFixed(3)), y: Number((t.y ?? 0).toFixed(3)) },
    temps: [] as number[],
  }));
  const frameGlobal: { t: number; min: number; max: number; mean: number; hotspot: { x: number; y: number } }[] = [];
  sampling.samples.forEach((_s, i) => {
    const frame = frames[i];
    if (!frame) return;
    const tSec = Number((i * sampling.step * sampling.secondPerFrame).toFixed(1));
    thermometers.forEach((t, ti) => series[ti].temps.push(thermometerCelsius(frame, t)));
    frameGlobal.push({ t: tSec, ...frameStats(frame) });
  });
  if (frameGlobal.length === 0) {
    throw new HttpsError('failed-precondition', 'Could not read this experiment’s thermal frames.');
  }

  const lastT = frameGlobal[frameGlobal.length - 1].t;
  return {
    durationSec: duration,
    fps: FPS,
    sampledFrames: frameGlobal.length,
    subject: exp.subject ?? null,
    existingTitle: exp.displayName ?? '',
    existingDescription: exp.description ?? '',
    thermometers: series.map((s) => {
      const temps = s.temps;
      const start = temps[0] ?? null;
      const end = temps.length ? temps[temps.length - 1] : null;
      return {
        label: s.label,
        position: s.position,
        series: temps,
        min: temps.length ? Math.min(...temps) : null,
        max: temps.length ? Math.max(...temps) : null,
        startTemp: start,
        endTemp: end,
        changeC: start != null && end != null ? Number((end - start).toFixed(2)) : null,
        slopeCPerSec: start != null && end != null && lastT > 0 ? Number(((end - start) / lastT).toFixed(3)) : null,
      };
    }),
    frameGlobal,
  };
}

/**
 * Generate a physics-grounded lab-report draft for a recording-based experiment.
 * Authorizes the caller (owner, or any non-private experiment — mirroring analyzer read access),
 * rate-limits per user, decodes the sampled thermal frames with the Admin SDK, and returns the draft.
 */
export const generateLabReport = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 180, memory: '512MiB' },
  async (request) => {
    const mongoId = requireMongoId(request.auth);
    // The AI feature is restricted to internal IFI accounts (mirrors the client isStaff() gate).
    const email = ((request.auth!.token.email as string | undefined) ?? '').toLowerCase();
    if (!email.endsWith('@intofuture.org')) {
      throw new HttpsError('permission-denied', 'The AI feature is restricted to intofuture.org accounts.');
    }
    const { expId } = (request.data ?? {}) as { expId?: string };
    if (!expId) throw new HttpsError('invalid-argument', 'Missing expId.');

    const exp = (await db.doc(`experiments/${expId}`).get()).data();
    if (!exp) throw new HttpsError('not-found', 'Experiment not found.');
    // Owner-only: the report is persisted onto the owner's experiment doc and shown to all viewers.
    if (exp.ownerId !== mongoId) {
      throw new HttpsError('permission-denied', 'Only the experiment owner can generate a report.');
    }
    if (exp.sourceType !== 'recording') {
      throw new HttpsError(
        'failed-precondition',
        'Lab report generation currently supports recording-based experiments only.',
      );
    }
    const recordingId = exp.recordingId as string | undefined;
    if (!recordingId) throw new HttpsError('failed-precondition', 'This experiment has no recording data.');

    await enforceAiRateLimit(mongoId);

    const summary = await buildThermalSummary(expId, exp, recordingId);
    const report = await callClaudeForReport(summary, claudeApiKey());
    // Persist on the experiment doc (Admin SDK bypasses the security rules) so the report shows on
    // revisit and is readable by anyone who can view the experiment — no recompute, no extra cost.
    await db
      .doc(`experiments/${expId}`)
      .set({ aiReport: report, aiReportAt: FieldValue.serverTimestamp() }, { merge: true });
    return { report };
  },
);

// ---------------------------------------------------------------------------
// AI key-frame notes (MVP step 1). A second, "moment-in-context" AI surface that
// COMPLEMENTS the whole-clip generateLabReport: the student curates key MOMENTS (each with a
// typed reason), and for each one the model analyses the INTERVAL between this moment and the
// previous key moment (the first moment is compared against the clip start, t=0). It returns one
// short, Chinese, structured "card" per moment that first JUDGES the student's stated reason
// against the measured delta, then — only when the change clears the sensor-noise floor —
// explains the mechanism. One generate action = ONE batched Claude call (counts as a single tick
// against the AI rate limit). Cards persist to the experiments/{expId}/keyframes subcollection,
// keyed by recordingIndex so re-analysis overwrites rather than duplicates. Text-only for now —
// frame images (the high-value vision upgrade) are deliberately deferred to a later step so this
// validates the moment-in-context framing cheaply first.
// ---------------------------------------------------------------------------

// At most this many moments per batch (one Claude call). Enforced server-side so a crafted request
// can't fan out an unbounded analysis; the client surfaces the same cap.
const KEYFRAME_MAX = 8;
// Temperature changes (Celsius) at or below this are within frame-to-frame sensor noise and must
// not be read as real signal. Passed to the model so it states stability plainly instead of
// inventing a mechanism on a near-static scene.
const KEYFRAME_NOISE_C = 0.2;

/** Detect an image's real media type from its magic bytes (the recording frames are stored under a
 *  .png name but are actually JPEG, which Claude rejects if mislabeled). Returns null for unknown. */
function detectImageMediaType(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}

type FrameImage = { data: string; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' };

/** Download a recording frame's rendered colormap image as base64 for Claude vision. The frames are
 *  stored under a .png name but may actually be JPEG, so the media type is detected from the bytes.
 *  Returns null when the frame is missing or its type is unrecognised. */
async function loadFrameImageBase64(recordingId: string, idx: number): Promise<FrameImage | null> {
  try {
    const [buf] = await admin.storage().bucket().file(`recordings/${recordingId}/data_${idx}.png`).download();
    const mediaType = detectImageMediaType(buf);
    return mediaType ? { data: buf.toString('base64'), mediaType } : null;
  } catch {
    return null;
  }
}

const KEYFRAME_SYSTEM_PROMPT = `You are a patient, rigorous science teacher helping a secondary-school student analyse an infrared (thermal-imaging) experiment one MOMENT at a time.

The student picked several "key moments" and wrote, for each, why they chose it. For each moment you are given the measured CHANGE between it and the previous key moment (the first moment is measured against the experiment start, t=0):
- Temperatures are in degrees Celsius; times in seconds. Image positions are normalized to [0,1] where x runs left->right and y runs top->bottom (y=0 is the top). "hotspot" is the hottest pixel's location in that frame.
- "probes" are the thermometers the student placed; each gives the previous reading tPrev, this reading tThis, the change changeC, and the per-second rate slopePerSec.
- "global" / "globalPrev" are the whole-frame min/max/mean and hotspot at this moment / the previous moment.
- "secondsElapsed" is the time between the two moments. "studentReason" is why the student picked this moment.
- "noiseThresholdC" is the sensor-noise floor; a temperature change at or below it is not trustworthy and must NOT be read as real.
- You may also see the thermal (false-colour) frame image for each moment and its previous moment; use them to understand the object layout and spatial structure (and to name objects by their on-image labels when legible), but EVERY quantitative claim must still come only from the provided numbers.

Rules:
- Ground every quantitative claim in the provided numbers. NEVER invent temperatures, rates, times, or objects not in the data.
- reasonVerdict: judge the student's reason first — "confirm" if the data agrees; "correct" if the data contradicts it; "nuance" if the direction is right but imprecise or incomplete.
- whatChanged: 1-2 sentences, comparing the student's reason to what actually happened over this interval, citing specific numbers (e.g. "T1 fell 0.4 C in 3.0 s while T2 fell only 0.1 C").
- mechanism: only when there is a real change above noiseThresholdC, give a one-sentence physical explanation (conduction, convection, radiation, evaporative cooling, thermal equilibrium, phase change), hedging when the mechanism is ambiguous ("this is consistent with..."). If every probe's change is within the noise floor, state plainly that there was little measurable change over this interval and leave mechanism as an empty string "".
- oneNumber: the single most memorable number for this moment (with its unit and probe label).
- Keep the tone encouraging and age-appropriate; do not speculate about what an object is beyond what the data supports.
- Respond with ONLY the required JSON structure — no extra text.`;

// Strict JSON shape the model must return (output_config.format json_schema). recordingIndex echoes
// each moment back so we can match cards to the student's reasons regardless of order.
const KEYFRAME_CARDS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['recordingIndex', 'reasonVerdict', 'whatChanged', 'mechanism', 'oneNumber'],
        properties: {
          recordingIndex: { type: 'integer' },
          reasonVerdict: { type: 'string', enum: ['confirm', 'correct', 'nuance'] },
          whatChanged: { type: 'string' },
          mechanism: { type: 'string' },
          oneNumber: { type: 'string' },
        },
      },
    },
  },
};

interface KeyframeCardOut {
  recordingIndex: number;
  reasonVerdict: 'confirm' | 'correct' | 'nuance';
  whatChanged: string;
  mechanism: string;
  oneNumber: string;
}

/** Call Claude for the batched key-frame cards (structured JSON). Streams so a long generation
 *  can't hit an HTTP timeout; parses the schema-constrained JSON out of the text blocks. The user
 *  content interleaves the numeric JSON with each moment's thermal frame images (vision). */
async function callClaudeForKeyframes(
  content: Anthropic.ContentBlockParam[],
  apiKey: string,
): Promise<KeyframeCardOut[]> {
  const anthropic = new Anthropic({ apiKey });

  let msg: Anthropic.Message;
  try {
    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system: KEYFRAME_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: KEYFRAME_CARDS_SCHEMA } },
      messages: [{ role: 'user', content }],
    });
    msg = await stream.finalMessage();
  } catch (err) {
    // Surface the real reason (this feature is staff-only) instead of an opaque 500.
    console.error('Claude keyframe call failed', err);
    throw new HttpsError('internal', `AI request failed: ${(err as { message?: string })?.message ?? 'unknown error'}`);
  }
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new HttpsError('internal', 'The model returned no text.');
  let parsed: { cards?: KeyframeCardOut[] };
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    parsed = JSON.parse(start >= 0 && end >= start ? text.slice(start, end + 1) : text);
  } catch {
    throw new HttpsError('internal', 'Could not parse the model output.');
  }
  return Array.isArray(parsed.cards) ? parsed.cards : [];
}

/**
 * Generate per-moment AI "cards" for student-curated key frames of a recording-based experiment.
 * Same guards as generateLabReport (staff email, owner-only, recording-only, AI rate limit). Input is
 * an array of { recordingIndex, tSeconds, reason } in recording-frame space (durable across re-trims);
 * the server decodes each moment and its predecessor, computes the interval deltas, asks Claude for one
 * batched structured response, and persists a card per moment to experiments/{expId}/keyframes.
 */
export const generateKeyframeNotes = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 180, memory: '512MiB' },
  async (request) => {
    const mongoId = requireMongoId(request.auth);
    // Mirrors the client isStaff() gate (and generateLabReport): internal IFI accounts only for now.
    const email = ((request.auth!.token.email as string | undefined) ?? '').toLowerCase();
    if (!email.endsWith('@intofuture.org')) {
      throw new HttpsError('permission-denied', 'The AI feature is restricted to intofuture.org accounts.');
    }

    const { expId, keyframes: rawKeyframes } = (request.data ?? {}) as {
      expId?: string;
      keyframes?: { recordingIndex?: number; tSeconds?: number; reason?: string }[];
    };
    if (!expId) throw new HttpsError('invalid-argument', 'Missing expId.');
    if (!Array.isArray(rawKeyframes) || rawKeyframes.length === 0) {
      throw new HttpsError('invalid-argument', 'Pick at least one moment to analyze.');
    }

    // Validate + normalize: integer recordingIndex, finite non-negative time, non-empty reason
    // (the reason-gate is load-bearing — a moment without one is rejected). Then sort by time,
    // dedupe by recordingIndex, and cap to KEYFRAME_MAX.
    const normalized = rawKeyframes
      .map((k) => ({
        recordingIndex: Number(k.recordingIndex),
        tSeconds: Number(k.tSeconds),
        reason: (k.reason ?? '').trim().slice(0, 500),
      }))
      .filter(
        (k) =>
          Number.isInteger(k.recordingIndex) &&
          k.recordingIndex >= 0 &&
          Number.isFinite(k.tSeconds) &&
          k.tSeconds >= 0 &&
          k.reason.length > 0,
      )
      .sort((a, b) => a.tSeconds - b.tSeconds);
    const seen = new Set<number>();
    const keyframes: { recordingIndex: number; tSeconds: number; reason: string }[] = [];
    for (const k of normalized) {
      if (seen.has(k.recordingIndex)) continue;
      seen.add(k.recordingIndex);
      keyframes.push(k);
      if (keyframes.length >= KEYFRAME_MAX) break;
    }
    if (keyframes.length === 0) {
      throw new HttpsError('invalid-argument', 'Each moment needs a reason before it can be analyzed.');
    }

    const exp = (await db.doc(`experiments/${expId}`).get()).data();
    if (!exp) throw new HttpsError('not-found', 'Experiment not found.');
    if (exp.ownerId !== mongoId) {
      throw new HttpsError('permission-denied', 'Only the experiment owner can generate analysis.');
    }
    if (exp.sourceType !== 'recording') {
      throw new HttpsError(
        'failed-precondition',
        'Key-frame analysis currently supports recording-based experiments only.',
      );
    }
    const recordingId = exp.recordingId as string | undefined;
    if (!recordingId) throw new HttpsError('failed-precondition', 'This experiment has no recording data.');

    await enforceAiRateLimit(mongoId);

    // Thermometers from the subcollection (Admin SDK bypasses the visibility rules); label T1..Tn in
    // doc order to match how the analyzer numbers them.
    const thermoSnap = await db.collection(`experiments/${expId}/thermometers`).get();
    const thermometers = thermoSnap.docs.map((d, i) => {
      const t = d.data() as ThermometerLike & { id?: string };
      return {
        id: t.id ?? d.id,
        label: `T${i + 1}`,
        x: t.x,
        y: t.y,
        measuringAreaType: t.measuringAreaType,
        measuringAreaWidth: t.measuringAreaWidth,
        measuringAreaHeight: t.measuringAreaHeight,
      };
    });

    // Signature of probe geometry at generation time, so the client can flag a card as stale once a
    // probe is moved (the cards assert specific numbers, so a silent stale card is worse than a stale
    // whole-clip report). Format — KEEP IN SYNC with the client staleness check:
    //   thermometers sorted by id; each "id:x4:y4:type:w:h"; joined by '|'.
    const thermoSig = thermometers
      .map(
        (t) =>
          `${t.id}:${(t.x ?? 0).toFixed(4)}:${(t.y ?? 0).toFixed(4)}:${t.measuringAreaType ?? 'point'}:${
            t.measuringAreaWidth ?? ''
          }:${t.measuringAreaHeight ?? ''}`,
      )
      .sort()
      .join('|');

    const duration = Number(exp.duration) || 0;
    const segments = (exp.segments as Segment[] | null) ?? null;
    // Baseline for the first moment = the clip's very first frame (t=0). recordingSampling(...,1)
    // reproduces the analyzer's own first-frame index (segment-aware; raw clips are 1-indexed).
    const baseSampling = recordingSampling(segments, duration, 1);
    if (baseSampling.samples.length === 0) {
      throw new HttpsError('failed-precondition', 'This experiment has no frames to analyze.');
    }
    const baselineRecordingIndex = baseSampling.samples[0].recordingIndex;

    // Download every frame we need (each moment + the baseline), in parallel; missing -> null. We pull
    // both the .dat (decoded for the numbers) and the rendered colormap .png (vision input).
    const neededIndexes = Array.from(new Set([baselineRecordingIndex, ...keyframes.map((k) => k.recordingIndex)]));
    const bucket = admin.storage().bucket();
    const frameByIndex = new Map<number, Uint8Array | null>();
    type FrameImage = { data: string; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' };
    const pngByIndex = new Map<number, FrameImage | null>();
    await Promise.all(
      neededIndexes.flatMap((idx) => [
        bucket
          .file(`recordings/${recordingId}/data_${idx}.dat`)
          .download()
          .then(([buf]) => frameByIndex.set(idx, new Uint8Array(buf)))
          .catch(() => frameByIndex.set(idx, null)),
        bucket
          .file(`recordings/${recordingId}/data_${idx}.png`)
          .download()
          .then(([buf]) => {
            // The frame is stored under a .png name but is really JPEG — label by the actual bytes.
            const mediaType = detectImageMediaType(buf);
            pngByIndex.set(idx, mediaType ? { data: buf.toString('base64'), mediaType } : null);
          })
          .catch(() => pngByIndex.set(idx, null)),
      ]),
    );

    // Build the per-moment INTERVAL payloads (this moment vs the previous keyframe / clip start), plus
    // an aligned list of which frame images to attach for each moment.
    const payloads: unknown[] = [];
    const imageRefs: { recordingIndex: number; tSeconds: number; prevRecordingIndex: number }[] = [];
    keyframes.forEach((kf, i) => {
      const thisFrame = frameByIndex.get(kf.recordingIndex);
      if (!thisFrame) return; // missing frame -> can't analyze this moment, skip it
      const prevKf = i > 0 ? keyframes[i - 1] : null;
      const prevFrame = prevKf ? frameByIndex.get(prevKf.recordingIndex) : frameByIndex.get(baselineRecordingIndex);
      const baseFrame = prevFrame ?? thisFrame; // fall back to zero-delta if the predecessor is missing
      const prevRecordingIndex = prevFrame
        ? prevKf
          ? prevKf.recordingIndex
          : baselineRecordingIndex
        : kf.recordingIndex;
      const prevTSeconds = prevFrame ? (prevKf ? prevKf.tSeconds : 0) : kf.tSeconds;
      const secondsElapsed = Number(Math.max(0, kf.tSeconds - prevTSeconds).toFixed(2));

      const probes = thermometers.map((t) => {
        const tThis = thermometerCelsius(thisFrame, t);
        const tPrev = thermometerCelsius(baseFrame, t);
        const changeC = Number((tThis - tPrev).toFixed(2));
        return {
          label: t.label,
          x: Number((t.x ?? 0).toFixed(3)),
          y: Number((t.y ?? 0).toFixed(3)),
          tPrev,
          tThis,
          changeC,
          slopePerSec: secondsElapsed > 0 ? Number((changeC / secondsElapsed).toFixed(3)) : 0,
        };
      });

      const tSeconds = Number(kf.tSeconds.toFixed(1));
      payloads.push({
        recordingIndex: kf.recordingIndex,
        tSeconds,
        secondsElapsed,
        studentReason: kf.reason,
        probes,
        global: frameStats(thisFrame),
        globalPrev: frameStats(baseFrame),
      });
      imageRefs.push({ recordingIndex: kf.recordingIndex, tSeconds, prevRecordingIndex });
    });
    if (payloads.length === 0) {
      throw new HttpsError('failed-precondition', 'Could not read this experiment’s thermal frames.');
    }

    // User content: the numeric JSON first, then each moment's (prev + this) thermal frame images.
    const dataJson = JSON.stringify({
      noiseThresholdC: KEYFRAME_NOISE_C,
      fps: FPS,
      subject: exp.subject ?? null,
      title: exp.displayName ?? '',
      keyframes: payloads,
    });
    const userContent: Anthropic.ContentBlockParam[] = [
      {
        type: 'text',
        text:
          `Thermal key-moment data (JSON):\n\n${dataJson}\n\n` +
          `Below are the thermal false-colour frames per moment (the previous moment and this moment, 120x160).`,
      },
    ];
    imageRefs.forEach((r) => {
      const prevPng = r.prevRecordingIndex !== r.recordingIndex ? pngByIndex.get(r.prevRecordingIndex) : null;
      const thisPng = pngByIndex.get(r.recordingIndex);
      if (prevPng) {
        userContent.push({
          type: 'text',
          text: `Moment recordingIndex=${r.recordingIndex} (t≈${r.tSeconds}s), the previous moment's frame:`,
        });
        userContent.push({
          type: 'image',
          source: { type: 'base64', media_type: prevPng.mediaType, data: prevPng.data },
        });
      }
      if (thisPng) {
        userContent.push({
          type: 'text',
          text: `Moment recordingIndex=${r.recordingIndex} (t≈${r.tSeconds}s), this moment's frame:`,
        });
        userContent.push({
          type: 'image',
          source: { type: 'base64', media_type: thisPng.mediaType, data: thisPng.data },
        });
      }
    });
    userContent.push({
      type: 'text',
      text: 'Output one card per key moment; use recordingIndex to map each card back to its moment.',
    });

    const cards = await callClaudeForKeyframes(userContent, claudeApiKey());

    // Persist one doc per moment (id = recordingIndex, so re-analysis overwrites rather than
    // duplicates). Cards carry redundant ownerId/visibility so the read rule can authorize a list
    // query without get()-ing the parent (same shape as thermometers). Admin SDK bypasses the rules.
    const reasonByIndex = new Map(keyframes.map((k) => [k.recordingIndex, k.reason]));
    const timeByIndex = new Map(keyframes.map((k) => [k.recordingIndex, Number(k.tSeconds.toFixed(1))]));
    const batch = db.batch();
    const responseCards: {
      recordingIndex: number;
      tSeconds: number;
      reason: string;
      reasonVerdict: 'confirm' | 'correct' | 'nuance';
      whatChanged: string;
      mechanism: string;
      oneNumber: string;
      thermoSig: string;
    }[] = [];
    cards.forEach((card) => {
      const recordingIndex = Number(card.recordingIndex);
      if (!reasonByIndex.has(recordingIndex)) return; // ignore a hallucinated / unmatched index
      const clean = {
        recordingIndex,
        tSeconds: timeByIndex.get(recordingIndex) ?? 0,
        reason: reasonByIndex.get(recordingIndex) ?? '',
        reasonVerdict: card.reasonVerdict,
        whatChanged: String(card.whatChanged ?? ''),
        mechanism: String(card.mechanism ?? ''),
        oneNumber: String(card.oneNumber ?? ''),
        thermoSig,
      };
      batch.set(
        db.doc(`experiments/${expId}/keyframes/${recordingIndex}`),
        {
          ...clean,
          ownerId: exp.ownerId,
          visibility: exp.visibility ?? 'private',
          createdBy: mongoId,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      responseCards.push(clean);
    });
    await batch.commit();

    // Return the plain cards (no serverTimestamp sentinel) so the client can render immediately.
    return { cards: responseCards };
  },
);

// ---------------------------------------------------------------------------
// AI Q&A (free-form). The "pull" complement to the two curated surfaces above: the staff owner asks
// any question about the experiment. Grounded on the same whole-clip numeric summary the report uses,
// plus the existing report (if any) and up to 3 student-attached "moments" (each a false-colour frame
// + its probe readings). One question = ONE Claude call (a single AI-rate-limit tick). The model is
// selectable (default Sonnet, or Opus); nothing is persisted — the Q&A thread is session-only.
// ---------------------------------------------------------------------------

// Selectable models for Q&A (default Sonnet to cap cost; Opus for a deeper pass). Client sends the key.
const QA_MODELS = { sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-8' } as const;
type QaModelKey = keyof typeof QA_MODELS;
// Cap attached moments (server-enforced so a crafted request can't fan out vision cost); client too.
const QA_MOMENT_MAX = 3;

const QA_SYSTEM_PROMPT = `You are a patient, rigorous science teacher answering a secondary-school student's question about ONE infrared (thermal-imaging) experiment.

You are given: a compact JSON summary of the whole clip's measured data (per-thermometer temperature-vs-time and per-frame whole-image stats), optionally an existing lab report for context, and optionally up to three specific "moments" the student attached — each with its probe readings and its thermal false-colour frame image, labelled ①②③ in time order.
- Temperatures are in degrees Celsius; times in seconds; image positions are normalized to [0,1] (x left->right, y top->bottom, y=0 is the top). "hotspot" is the hottest pixel's location.

Rules:
- Answer ONLY the student's question, and stay within this experiment's thermal physics. If the question is unrelated or the data can't support an answer, say so plainly instead of guessing.
- Ground every quantitative claim in the provided numbers. NEVER invent temperatures, rates, times, or objects not in the data. When you reference an attached moment, name it by its ①②③ label.
- Explain the physics (conduction, convection, radiation, evaporative cooling, thermal equilibrium, phase change) only when the data supports it; hedge when a mechanism is ambiguous ("this is consistent with...").
- Keep it concise, encouraging, and age-appropriate. Answer in English Markdown. No preamble, no meta commentary about being an AI.`;

/** Call Claude for a free-form answer with the selected model. Streams server-side (so a long
 *  generation can't hit an HTTP timeout); when the caller passes a CallableResponse, each text delta is
 *  forwarded to the client via sendChunk (a no-op if the client didn't request streaming). The user
 *  content may interleave text with frame images. Returns the full accumulated answer. */
async function callClaudeForAnswer(
  content: Anthropic.ContentBlockParam[],
  apiKey: string,
  model: string,
  response?: CallableResponse,
): Promise<string> {
  const anthropic = new Anthropic({ apiKey });
  let msg: Anthropic.Message;
  try {
    const stream = anthropic.messages.stream({
      model,
      // Adaptive thinking tokens count against max_tokens, so keep generous headroom — 2500 truncated
      // detailed answers (e.g. a wide probe table) mid-output. It's a ceiling, billed only if used.
      max_tokens: 6000,
      thinking: { type: 'adaptive' },
      system: QA_SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    });
    // Forward each answer-text delta to the client as it arrives (thinking deltas don't fire 'text').
    stream.on('text', (delta) => {
      void response?.sendChunk({ text: delta });
    });
    msg = await stream.finalMessage();
  } catch (err) {
    console.error('Claude answer call failed', err);
    throw new HttpsError('internal', `AI request failed: ${(err as { message?: string })?.message ?? 'unknown error'}`);
  }
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw new HttpsError('internal', 'The model returned no text.');
  return text;
}

/**
 * Answer a free-form question about a recording-based experiment. Same guards as generateLabReport
 * (staff email, owner-only, recording-only, AI rate limit). Input: { expId, question, moments?, model? }
 * where moments are { recordingIndex, tSeconds } in recording-frame space. Grounds the model on the
 * whole-clip summary + existing report + each attached moment's frame/readings, then returns Markdown.
 * Nothing is persisted (v1: the thread is session-only on the client).
 */
export const answerExperimentQuestion = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 180, memory: '512MiB' },
  async (request, response) => {
    const mongoId = requireMongoId(request.auth);
    // Mirrors the client isStaff() gate (and the other AI callables): internal IFI accounts only.
    const email = ((request.auth!.token.email as string | undefined) ?? '').toLowerCase();
    if (!email.endsWith('@intofuture.org')) {
      throw new HttpsError('permission-denied', 'The AI feature is restricted to intofuture.org accounts.');
    }

    const {
      expId,
      question: rawQuestion,
      moments: rawMoments,
      model: rawModel,
    } = (request.data ?? {}) as {
      expId?: string;
      question?: string;
      moments?: { recordingIndex?: number; tSeconds?: number }[];
      model?: string;
    };
    if (!expId) throw new HttpsError('invalid-argument', 'Missing expId.');
    const question = (rawQuestion ?? '').trim().slice(0, 2000);
    if (!question) throw new HttpsError('invalid-argument', 'Ask a question first.');
    const modelKey: QaModelKey = rawModel === 'opus' ? 'opus' : 'sonnet';

    // Normalize attached moments: integer recordingIndex >= 0, finite non-negative time; sort by time,
    // dedupe by recordingIndex, cap to QA_MOMENT_MAX. Moments are optional (time-agnostic by default).
    const normalizedMoments = (Array.isArray(rawMoments) ? rawMoments : [])
      .map((m) => ({ recordingIndex: Number(m.recordingIndex), tSeconds: Number(m.tSeconds) }))
      .filter(
        (m) =>
          Number.isInteger(m.recordingIndex) && m.recordingIndex >= 0 && Number.isFinite(m.tSeconds) && m.tSeconds >= 0,
      )
      .sort((a, b) => a.tSeconds - b.tSeconds);
    const seenMoments = new Set<number>();
    const moments: { recordingIndex: number; tSeconds: number }[] = [];
    for (const m of normalizedMoments) {
      if (seenMoments.has(m.recordingIndex)) continue;
      seenMoments.add(m.recordingIndex);
      moments.push(m);
      if (moments.length >= QA_MOMENT_MAX) break;
    }

    const exp = (await db.doc(`experiments/${expId}`).get()).data();
    if (!exp) throw new HttpsError('not-found', 'Experiment not found.');
    // NOT owner-gated (unlike generateLabReport/generateKeyframeNotes): any staff may ask about any
    // experiment they can view. Only the OWNER's turns are persisted to Firestore (below); a non-owner's
    // thread lives in their own browser (localStorage), never uploaded.
    if (exp.sourceType !== 'recording') {
      throw new HttpsError('failed-precondition', 'AI Q&A currently supports recording-based experiments only.');
    }
    const recordingId = exp.recordingId as string | undefined;
    if (!recordingId) throw new HttpsError('failed-precondition', 'This experiment has no recording data.');

    await enforceAiRateLimit(mongoId);

    // Whole-clip numeric context (the same summary the report is built from) grounds time-agnostic
    // questions even when no moment is attached.
    const summary = await buildThermalSummary(expId, exp, recordingId);

    // Thermometers for per-moment probe readings (label T1..Tn in doc order, matching the analyzer).
    const thermoSnap = await db.collection(`experiments/${expId}/thermometers`).get();
    const thermometers = thermoSnap.docs.map((d, i) => {
      const t = d.data() as ThermometerLike;
      return {
        label: `T${i + 1}`,
        x: t.x,
        y: t.y,
        measuringAreaType: t.measuringAreaType,
        measuringAreaWidth: t.measuringAreaWidth,
        measuringAreaHeight: t.measuringAreaHeight,
      };
    });

    // For each attached moment, decode the .dat (probe numbers + whole-frame stats) and load the .png
    // (the false-colour frame for vision), in parallel; a missing frame just drops that moment's data.
    const bucket = admin.storage().bucket();
    const momentData = await Promise.all(
      moments.map(async (m, i) => {
        const [frame, png] = await Promise.all([
          bucket
            .file(`recordings/${recordingId}/data_${m.recordingIndex}.dat`)
            .download()
            .then(([buf]) => new Uint8Array(buf))
            .catch(() => null),
          loadFrameImageBase64(recordingId, m.recordingIndex),
        ]);
        return {
          order: i + 1,
          tSeconds: Number(m.tSeconds.toFixed(1)),
          probes: frame ? thermometers.map((t) => ({ label: t.label, tempC: thermometerCelsius(frame, t) })) : [],
          global: frame ? frameStats(frame) : null,
          png,
        };
      }),
    );

    // Build the Claude content: whole-clip summary, the existing report (if any), each attached moment
    // (numbers + false-colour frame), then the student's question.
    const userContent: Anthropic.ContentBlockParam[] = [
      {
        type: 'text',
        text: `Whole-clip measured summary of this infrared experiment (JSON):\n\n${JSON.stringify(summary)}`,
      },
    ];
    if (exp.aiReport) {
      userContent.push({
        type: 'text',
        text:
          `An existing AI lab report for this experiment (context only; the numbers above are authoritative):\n\n` +
          String(exp.aiReport).slice(0, 6000),
      });
    }
    if (momentData.length > 0) {
      const circ = ['①', '②', '③'];
      userContent.push({
        type: 'text',
        text: `The student attached ${momentData.length} specific moment(s) to this question, labelled ①②③ in time order. Refer to them by these labels.`,
      });
      momentData.forEach((md) => {
        const label = circ[md.order - 1] ?? String(md.order);
        const probeText = md.probes.length
          ? md.probes.map((p) => `${p.label}=${p.tempC}C`).join(', ')
          : '(probe readings unavailable)';
        userContent.push({
          type: 'text',
          text:
            `Moment ${label} — t≈${md.tSeconds}s, probe readings: ${probeText}.` +
            (md.global ? ` Whole-frame min/max/mean: ${md.global.min}/${md.global.max}/${md.global.mean}C.` : ''),
        });
        if (md.png) {
          userContent.push({
            type: 'image',
            source: { type: 'base64', media_type: md.png.mediaType, data: md.png.data },
          });
        }
      });
    }
    userContent.push({ type: 'text', text: `The student's question:\n\n${question}` });

    const answer = await callClaudeForAnswer(userContent, claudeApiKey(), QA_MODELS[modelKey], response);

    // Persist the turn so the OWNER's thread survives reload / re-open (Admin SDK bypasses the rules, so
    // clients can never forge a turn). Non-owner threads are deliberately NOT uploaded — the client keeps
    // them in localStorage. A persistence failure must NOT fail the answer already streamed — swallow it.
    if (exp.ownerId === mongoId) {
      try {
        await db.collection(`experiments/${expId}/qaTurns`).add({
          userId: mongoId,
          question,
          model: modelKey,
          moments: moments.map((m) => ({ recordingIndex: m.recordingIndex, tSeconds: m.tSeconds })),
          answer,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (err) {
        console.error('failed to persist qa turn', err);
      }
    }

    return { answer };
  },
);
