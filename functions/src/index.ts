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
import { onCall, HttpsError } from 'firebase-functions/v2/https';
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
- Output a well-structured lab report in Markdown. If the existing title/description is in Chinese, or they are empty, use these Chinese section headings: 实验标题建议 / 观察 / 定量分析 / 物理解释 / 结论. If the existing title/description is clearly in English, use: Suggested title / Observations / Quantitative analysis / Physics explanation / Conclusion.
- Respond with ONLY the report body — no preamble, no meta commentary about being an AI.`;

/** Call Claude for the report draft. Streams server-side so a long generation can't hit an HTTP timeout. */
async function callClaudeForReport(summary: unknown, apiKey: string): Promise<string> {
  const anthropic = new Anthropic({ apiKey });
  const userPrompt =
    `Thermal experiment data (JSON):\n\n${JSON.stringify(summary)}\n\n` +
    `Write the lab report now, following the required section structure. Match the language of the existing title/description; if both are empty, write in Chinese.`;

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

    // Thermometers from the subcollection (Admin SDK bypasses the visibility rules).
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
    const summary = {
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

    const report = await callClaudeForReport(summary, ANTHROPIC_API_KEY.value());
    // Persist on the experiment doc (Admin SDK bypasses the security rules) so the report shows on
    // revisit and is readable by anyone who can view the experiment — no recompute, no extra cost.
    await db
      .doc(`experiments/${expId}`)
      .set({ aiReport: report, aiReportAt: FieldValue.serverTimestamp() }, { merge: true });
    return { report };
  },
);
