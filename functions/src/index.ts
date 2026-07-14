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
import {
  FPS,
  frameStats,
  readVirHeader,
  recordingSampling,
  thermometerCelsius,
  virFrameDeflated,
  type Segment,
  type ThermometerLike,
  type VirHeader,
} from './thermal';

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

  // Public profile slice (anyone can read displayName/avatar/bio/createdAt; email/prefs/role stay
  // private). `createdAt` is the profile page's "Joined" date — stamped only for freshly
  // provisioned users; migrated users get theirs from scripts/backfillProfileFeature.mjs, which
  // this merge must not clobber.
  await db.doc(`usersPublic/${mongoId}`).set(
    {
      displayName,
      avatar,
      ...(provisioned ? { createdAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
    },
    { merge: true },
  );
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
// Keys for the OpenAI-compatible third-party models. DeepSeek, OpenAI (ChatGPT) and xAI (Grok) all speak
// the same /chat/completions API, so one selectable model each rides the shared OpenAI-compatible path.
// All optional: the functions still deploy without them, but choosing a model whose secret is unset fails
// at call time.
const DEEPSEEK_API_KEY = defineSecret('DEEPSEEK_API_KEY');
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const XAI_API_KEY = defineSecret('XAI_API_KEY');
// Google AI Studio (Gemini) key. Gemini exposes an OpenAI-compatible endpoint, so it rides the same path.
const GOOGLE_API_KEY = defineSecret('GOOGLE_API_KEY');

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

/** The DeepSeek API key, cleaned the same way as claudeApiKey (see its note on quote/whitespace padding). */
function deepseekApiKey(): string {
  const key = DEEPSEEK_API_KEY.value()
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!key) throw new HttpsError('failed-precondition', 'The DeepSeek model is not configured on the server.');
  return key;
}

/** The OpenAI (ChatGPT) API key, cleaned the same way as claudeApiKey. */
function openaiApiKey(): string {
  const key = OPENAI_API_KEY.value()
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!key) throw new HttpsError('failed-precondition', 'The ChatGPT model is not configured on the server.');
  return key;
}

/** The xAI (Grok) API key, cleaned the same way as claudeApiKey. */
function xaiApiKey(): string {
  const key = XAI_API_KEY.value()
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!key) throw new HttpsError('failed-precondition', 'The Grok model is not configured on the server.');
  return key;
}

/** The Google (Gemini) API key, cleaned the same way as claudeApiKey. */
function googleApiKey(): string {
  const key = GOOGLE_API_KEY.value()
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!key) throw new HttpsError('failed-precondition', 'The Gemini model is not configured on the server.');
  return key;
}

// The OpenAI-compatible providers (OpenAI/ChatGPT, Google/Gemini, xAI/Grok, DeepSeek) share one call path
// — only the endpoint, the API key, and whether the chosen model can see images differ. This resolves
// those per provider so the report/answer/agent helpers below stay provider-agnostic. `vision` gates
// whether the attached false-colour frames are forwarded (the GPT / Gemini / Grok models are multimodal;
// the DeepSeek models are text-only). Each key is resolved lazily, so selecting one provider never touches
// (nor requires) another provider's secret.
type OpenAiProvider = 'deepseek' | 'openai' | 'xai' | 'google';
// Which JSON field caps the output length. OpenAI's GPT-5 family REJECTS the legacy `max_tokens` (HTTP 400
// "Unsupported parameter … Use max_completion_tokens instead"), so the OpenAI path must send the newer
// `max_completion_tokens`; the other OpenAI-compatible providers still take `max_tokens`.
type MaxTokensParam = 'max_tokens' | 'max_completion_tokens';
function resolveOpenAiProvider(provider: OpenAiProvider): {
  baseUrl: string;
  apiKey: string;
  vision: boolean;
  maxTokensParam: MaxTokensParam;
} {
  switch (provider) {
    case 'openai':
      return {
        baseUrl: 'https://api.openai.com/v1/chat/completions',
        apiKey: openaiApiKey(),
        vision: true,
        maxTokensParam: 'max_completion_tokens',
      };
    case 'google':
      return {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        apiKey: googleApiKey(),
        vision: true,
        maxTokensParam: 'max_tokens',
      };
    case 'xai':
      return {
        baseUrl: 'https://api.x.ai/v1/chat/completions',
        apiKey: xaiApiKey(),
        vision: true,
        maxTokensParam: 'max_tokens',
      };
    case 'deepseek':
    default:
      return {
        baseUrl: 'https://api.deepseek.com/chat/completions',
        apiKey: deepseekApiKey(),
        vision: false,
        maxTokensParam: 'max_tokens',
      };
  }
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

const REPORT_USER_PROMPT = (summary: unknown) =>
  `Thermal experiment data (JSON):\n\n${JSON.stringify(summary)}\n\n` +
  `Write the lab report now in English, following the required section structure.`;

/** Call Claude for the report draft with the selected model. Streams server-side so a long generation
 *  can't hit an HTTP timeout. */
async function callClaudeForReport(summary: unknown, apiKey: string, model: string): Promise<string> {
  const anthropic = new Anthropic({ apiKey });
  const stream = anthropic.messages.stream({
    model,
    max_tokens: 6000,
    thinking: { type: 'adaptive' },
    system: REPORT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: REPORT_USER_PROMPT(summary) }],
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

/** Call an OpenAI-compatible provider (DeepSeek / OpenAI / xAI Grok, `baseUrl`) for the report draft. The
 *  report is text-only (no frame images), so every provider receives the same grounding the Claude path
 *  does. Non-streaming: the generateLabReport callable isn't a streaming endpoint, so we just await the
 *  single completion. */
async function callOpenAiForReport(
  summary: unknown,
  baseUrl: string,
  apiKey: string,
  model: string,
  maxTokensParam: MaxTokensParam,
): Promise<string> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        [maxTokensParam]: 6000,
        messages: [
          { role: 'system', content: REPORT_SYSTEM_PROMPT },
          { role: 'user', content: REPORT_USER_PROMPT(summary) },
        ],
      }),
    });
  } catch (err) {
    console.error('OpenAI-compatible report call failed', err);
    throw new HttpsError('internal', `AI request failed: ${(err as { message?: string })?.message ?? 'unknown error'}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('OpenAI-compatible report call failed', res.status, detail.slice(0, 500));
    throw new HttpsError('internal', `AI request failed (${res.status}).`);
  }
  const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
  const text = (data?.choices?.[0]?.message?.content ?? '').trim();
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

// A thermometer resolved for a video experiment: label (T1…Tn, doc/preset order) + the geometry the
// thermal decoders need. Mirrors the client — custom clips carry full geometry, .wrk presets are points.
type VideoThermometer = {
  label: string;
  x: number;
  y: number;
  measuringAreaType?: string;
  measuringAreaWidth?: number;
  measuringAreaHeight?: number;
};

/**
 * Resolve a video experiment's thermometers the same way the analyzer does (fetchExperiment): a clone
 * saved with edited probes (customThermometers) keeps them in the subcollection; a showcase video
 * derives them from its videostore/<name>.wrk preset (Thermometer<k>.x/.y points). A missing/broken
 * preset yields no probes — the summary still carries the whole-frame stats, so Q&A degrades gracefully.
 */
async function loadVideoThermometers(expId: string, exp: FirebaseFirestore.DocumentData): Promise<VideoThermometer[]> {
  if (exp.customThermometers) {
    const snap = await db.collection(`experiments/${expId}/thermometers`).get();
    return snap.docs.map((d, i) => {
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
  }
  const name = exp.name as string | undefined;
  if (!name) return [];
  try {
    const [buf] = await admin.storage().bucket().file(`videostore/${name}.wrk`).download();
    const preset = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
    const count = Number(preset['ThermometerCount']) || 0;
    const thermometers: VideoThermometer[] = [];
    for (let k = 0; k < count; k++) {
      const x = Number(preset[`Thermometer${k}.x`]);
      const y = Number(preset[`Thermometer${k}.y`]);
      if (Number.isFinite(x) && Number.isFinite(y)) thermometers.push({ label: `T${k + 1}`, x, y });
    }
    return thermometers;
  } catch (e) {
    console.warn('failed to load .wrk preset thermometers', name, e);
    return [];
  }
}

/**
 * Video counterpart of buildThermalSummary: sample frames evenly across the single videostore/<name>.vir
 * file and produce the IDENTICAL summary shape (per-thermometer T(t) series + per-frame global stats), so
 * the report/Q&A prompt code is media-agnostic. Time is derived from exp.duration (videos aren't the fixed
 * 5fps recordings are). Throws failed-precondition when no frames decode.
 */
function buildVideoThermalSummary(
  exp: FirebaseFirestore.DocumentData,
  vir: Uint8Array,
  header: VirHeader,
  thermometers: VideoThermometer[],
) {
  if (header.frameCount <= 0) {
    throw new HttpsError('failed-precondition', 'This video has no thermal frames to analyze.');
  }
  const { width, height, frameCount } = header;
  const duration = Number(exp.duration) || 0;
  const secondPerFrame = duration > 0 ? duration / frameCount : 0;
  const maxPoints = Math.min(REPORT_FRAME_SAMPLES, frameCount);
  const step = Math.max(1, Math.floor(frameCount / maxPoints));

  const series = thermometers.map((t) => ({
    label: t.label,
    position: { x: Number((t.x ?? 0).toFixed(3)), y: Number((t.y ?? 0).toFixed(3)) },
    temps: [] as number[],
  }));
  const frameGlobal: { t: number; min: number; max: number; mean: number; hotspot: { x: number; y: number } }[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.min(frameCount - 1, i * step);
    const frame = virFrameDeflated(vir, header, idx);
    if (!frame) continue;
    const tSec = Number((idx * secondPerFrame).toFixed(1));
    thermometers.forEach((t, ti) => series[ti].temps.push(thermometerCelsius(frame, t, width, height)));
    frameGlobal.push({ t: tSec, ...frameStats(frame, width, height) });
  }
  if (frameGlobal.length === 0) {
    throw new HttpsError('failed-precondition', 'Could not read this video’s thermal frames.');
  }

  const lastT = frameGlobal[frameGlobal.length - 1].t;
  return {
    durationSec: duration,
    fps: secondPerFrame > 0 ? Number((1 / secondPerFrame).toFixed(2)) : null,
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
  {
    secrets: [ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY, XAI_API_KEY, GOOGLE_API_KEY],
    timeoutSeconds: 180,
    memory: '512MiB',
  },
  async (request) => {
    const mongoId = requireMongoId(request.auth);
    // The AI feature is restricted to internal IFI accounts (mirrors the client isStaff() gate).
    const email = ((request.auth!.token.email as string | undefined) ?? '').toLowerCase();
    if (!email.endsWith('@intofuture.org')) {
      throw new HttpsError('permission-denied', 'The AI feature is restricted to intofuture.org accounts.');
    }
    const { expId, model: rawModel } = (request.data ?? {}) as { expId?: string; model?: string };
    if (!expId) throw new HttpsError('invalid-argument', 'Missing expId.');
    // Same selectable set as the Q&A panel (report is text-only, so every provider works). Falls back to
    // the default model when the client omits / sends an unknown key.
    const modelKey: QaModelKey = isQaModelKey(rawModel) ? rawModel : DEFAULT_MODEL_KEY;

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
    const m = QA_MODELS[modelKey];
    let report: string;
    if (m.provider === 'anthropic') {
      report = await callClaudeForReport(summary, claudeApiKey(), m.model);
    } else {
      const p = resolveOpenAiProvider(m.provider);
      report = await callOpenAiForReport(summary, p.baseUrl, p.apiKey, m.model, p.maxTokensParam);
    }
    // Persist on the experiment doc (Admin SDK bypasses the security rules) so the report shows on
    // revisit and is readable by anyone who can view the experiment — no recompute, no extra cost.
    // aiReportModel records which model produced the saved report (for the UI badge).
    await db
      .doc(`experiments/${expId}`)
      .set({ aiReport: report, aiReportModel: modelKey, aiReportAt: FieldValue.serverTimestamp() }, { merge: true });
    return { report, model: modelKey };
  },
);

// ---------------------------------------------------------------------------
// Shared thermal-frame image helpers (used by the AI Q&A vision path).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// AI Q&A (free-form). The "pull" complement to the two curated surfaces above: the staff owner asks
// any question about the experiment. Grounded on the same whole-clip numeric summary the report uses,
// plus the existing report (if any) and up to 3 student-attached "moments" (each a false-colour frame
// + its probe readings). One question = ONE Claude call (a single AI-rate-limit tick). The model is
// selectable (default Sonnet, or Opus); nothing is persisted — the Q&A thread is session-only.
// ---------------------------------------------------------------------------

// Selectable models for Q&A. The client offers the OpenAI-compatible set below (OpenAI / Gemini / Grok /
// DeepSeek); the client sends the key. `provider` picks the call path — the Anthropic SDK vs the shared
// OpenAI-compatible endpoint (resolveOpenAiProvider). The GPT / Gemini / Grok models can see the attached
// frames; the DeepSeek models drop them (see the provider `vision` flag). The concrete model ids are
// slugs of the product's model names — adjust here if a vendor's real id differs. The Claude (Anthropic)
// entries are retained but no longer offered by the client picker; they keep the anthropic call path wired
// (re-add one to MODEL_KEYS in src/types.ts to surface Claude again).
const QA_MODELS = {
  sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  opus: { provider: 'anthropic', model: 'claude-opus-4-8' },
  gpt53: { provider: 'openai', model: 'gpt-5.3-chat-latest' },
  gpt52: { provider: 'openai', model: 'gpt-5.2' },
  gemini: { provider: 'google', model: 'gemini-2.5-pro' },
  grok: { provider: 'xai', model: 'grok-4.5' },
  deepseekPro: { provider: 'deepseek', model: 'deepseek-v4-pro' },
  deepseekFlash: { provider: 'deepseek', model: 'deepseek-v4-flash' },
} as const;
type QaModelKey = keyof typeof QA_MODELS;
// Own-property check (NOT the `in` operator, which would also match inherited Object.prototype names like
// 'toString'/'constructor' from a crafted client value and resolve QA_MODELS[...] to a bogus entry).
const isQaModelKey = (v: unknown): v is QaModelKey =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(QA_MODELS, v);
// Fallback when the client omits / sends an unknown model key. Mirrors DEFAULT_MODEL in src/types.ts and
// is a valid key of both QA_MODELS and AGENT_MODELS (identical key sets), so it serves every callable.
const DEFAULT_MODEL_KEY: QaModelKey = 'gpt53';
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

// Appended to the system prompt ONLY for a text-only model (DeepSeek, or the Grok text model): it never
// receives the false-colour frame images, so it must not narrate the scene as if it can see it. Without
// this it tends to write "What the image shows…" from the description alone, which reads as vision and can
// mislead the student. (Vision-capable models — Claude, GPT-4o — are given the frames and skip this.)
const NO_VISION_NOTE = `IMPORTANT: You cannot see any images — no thermal frames or photos are provided to you, only text and numbers. Do NOT describe "what the image shows" or use phrasing that implies you can see a picture. Base every statement strictly on the numeric data and the experiment's written description, and when you rely on the description say so ("per the description…").`;

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

/** Call an OpenAI-compatible provider (DeepSeek / OpenAI / xAI Grok, `baseUrl`) for a free-form answer.
 *  A `vision`-capable model (GPT-4o) receives the interleaved false-colour frames as OpenAI image_url
 *  parts; a text-only model (DeepSeek, the Grok text model) gets the numeric text blocks only, plus a note
 *  counting the dropped frames so it doesn't reference one it never saw. Streams over SSE and forwards each
 *  content delta via sendChunk, mirroring callClaudeForAnswer. */
async function callOpenAiForAnswer(
  content: Anthropic.ContentBlockParam[],
  baseUrl: string,
  apiKey: string,
  model: string,
  vision: boolean,
  maxTokensParam: MaxTokensParam,
  response?: CallableResponse,
): Promise<string> {
  // Build the OpenAI-shaped user message. Vision models get a content-part array preserving text + images;
  // text-only models get one flattened string, with any images counted and noted (never silently seen).
  let userMessageContent: unknown;
  if (vision) {
    userMessageContent = content.map((block) =>
      block.type === 'image' && block.source.type === 'base64'
        ? { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } }
        : { type: 'text', text: block.type === 'text' ? block.text : '' },
    );
  } else {
    let droppedImages = 0;
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === 'text') parts.push(block.text);
      else if (block.type === 'image') droppedImages += 1;
    }
    if (droppedImages > 0) {
      parts.push(
        `(Note: ${droppedImages} false-colour frame image(s) were attached but are not visible to you; ` +
          `rely on the numeric probe readings and whole-frame stats above.)`,
      );
    }
    userMessageContent = parts.join('\n\n');
  }
  // Text-only models get the "you can't see images" note; vision models are handed the frames instead.
  const systemContent = vision ? QA_SYSTEM_PROMPT : `${QA_SYSTEM_PROMPT}\n\n${NO_VISION_NOTE}`;

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        [maxTokensParam]: 6000,
        stream: true,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userMessageContent },
        ],
      }),
    });
  } catch (err) {
    console.error('OpenAI-compatible answer call failed', err);
    throw new HttpsError('internal', `AI request failed: ${(err as { message?: string })?.message ?? 'unknown error'}`);
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    console.error('OpenAI-compatible answer call failed', res.status, detail.slice(0, 500));
    throw new HttpsError('internal', `AI request failed (${res.status}).`);
  }

  // Parse the OpenAI-style SSE stream: newline-delimited `data: {json}` frames ending with `data: [DONE]`.
  // Each chunk's choices[0].delta.content is an answer-text delta.
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = '';
  let answer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            answer += delta;
            void response?.sendChunk({ text: delta });
          }
        } catch {
          // Ignore a partial/non-JSON keep-alive line.
        }
      }
    }
  } catch (err) {
    console.error('OpenAI-compatible stream read failed', err);
    throw new HttpsError('internal', `AI request failed: ${(err as { message?: string })?.message ?? 'unknown error'}`);
  }
  const text = answer.trim();
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
  {
    secrets: [ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY, XAI_API_KEY, GOOGLE_API_KEY],
    timeoutSeconds: 180,
    memory: '512MiB',
  },
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
    const modelKey: QaModelKey = isQaModelKey(rawModel) ? rawModel : DEFAULT_MODEL_KEY;

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
    // NOT owner-gated (unlike generateLabReport): any staff may ask about any
    // experiment they can view. Only the OWNER's turns are persisted to Firestore (below); a non-owner's
    // thread lives in their own browser (localStorage), never uploaded.
    const isVideo = exp.sourceType === 'video';
    if (exp.sourceType !== 'recording' && !isVideo) {
      throw new HttpsError('failed-precondition', 'AI Q&A is not supported for this experiment type.');
    }

    await enforceAiRateLimit(mongoId);

    // Whole-clip numeric context (grounds time-agnostic questions even with no moment attached) plus, for
    // each attached moment, probe readings + whole-frame stats. Recording and video store their frames
    // differently — one pako'd data_N.dat per frame vs a single .vir — so each media type builds the same
    // summary shape and moment records its own way. Recording moments also carry the false-colour PNG for
    // vision; video has no per-frame PNGs, so a video moment is numbers-only (png stays null).
    let summary: Awaited<ReturnType<typeof buildThermalSummary>> | ReturnType<typeof buildVideoThermalSummary>;
    let momentData: {
      order: number;
      tSeconds: number;
      probes: { label: string; tempC: number }[];
      global: ReturnType<typeof frameStats> | null;
      png: FrameImage | null;
    }[];

    if (isVideo) {
      const name = exp.name as string | undefined;
      if (!name) throw new HttpsError('failed-precondition', 'This experiment has no video data.');
      const [virBuf] = await admin.storage().bucket().file(`videostore/${name}.vir`).download();
      const vir = new Uint8Array(virBuf);
      const header = readVirHeader(vir);
      const thermometers = await loadVideoThermometers(expId, exp);
      summary = buildVideoThermalSummary(exp, vir, header, thermometers);
      momentData = moments.map((m, i) => {
        // recordingIndex is the .vir frame index for a video moment (see the analyzer's VideoPlayer).
        const frame = virFrameDeflated(vir, header, m.recordingIndex);
        return {
          order: i + 1,
          tSeconds: Number(m.tSeconds.toFixed(1)),
          probes: frame
            ? thermometers.map((t) => ({
                label: t.label,
                tempC: thermometerCelsius(frame, t, header.width, header.height),
              }))
            : [],
          global: frame ? frameStats(frame, header.width, header.height) : null,
          png: null,
        };
      });
    } else {
      const recordingId = exp.recordingId as string | undefined;
      if (!recordingId) throw new HttpsError('failed-precondition', 'This experiment has no recording data.');
      summary = await buildThermalSummary(expId, exp, recordingId);

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
      momentData = await Promise.all(
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
    }

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

    const qa = QA_MODELS[modelKey];
    let answer: string;
    if (qa.provider === 'anthropic') {
      answer = await callClaudeForAnswer(userContent, claudeApiKey(), qa.model, response);
    } else {
      const p = resolveOpenAiProvider(qa.provider);
      answer = await callOpenAiForAnswer(
        userContent,
        p.baseUrl,
        p.apiKey,
        qa.model,
        p.vision,
        p.maxTokensParam,
        response,
      );
    }

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

// ---------------------------------------------------------------------------
// Lab Assistant (agent) — the site-wide chat widget. It drives the app via CLIENT-side tools (open
// experiments, list thermometers, etc.): the tool SCHEMAS are authoritative HERE, but the tools
// EXECUTE in the browser (mutating the SPA's state / router). This callable is a stateless proxy —
// one invocation = one agent turn: it declares the tools, calls Claude once, and returns the assistant
// turn (which may contain tool_use blocks). The browser executes the tools and calls back with
// tool_result blocks until Claude returns a plain-text answer. The one exception is read_experiment_data,
// whose heavy Firestore/Storage read runs server-side in its own getExperimentData callable (the client
// tool just calls it) — so the loop here stays uniform. Same staff gate + rate limit as the other AI
// callables; the Claude key stays in Secret Manager. v1 = read-only + navigation tools only.
// ---------------------------------------------------------------------------

// Selectable models for the Lab Assistant agent — same OpenAI-compatible set as Q&A (all support function
// calling, so they drive the same tool loop; the Anthropic-shaped transcript is translated to/from the
// OpenAI shape in callOpenAiForAgent). Keys match the client's AgentModel type; the concrete ids are slugs
// of the product's model names — adjust here if a vendor's real id differs. The Claude (Anthropic) entries
// are retained but no longer offered by the client picker (they keep the anthropic call path wired).
const AGENT_MODELS = {
  sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  opus: { provider: 'anthropic', model: 'claude-opus-4-8' },
  gpt53: { provider: 'openai', model: 'gpt-5.3-chat-latest' },
  gpt52: { provider: 'openai', model: 'gpt-5.2' },
  gemini: { provider: 'google', model: 'gemini-2.5-pro' },
  grok: { provider: 'xai', model: 'grok-4.5' },
  deepseekPro: { provider: 'deepseek', model: 'deepseek-v4-pro' },
  deepseekFlash: { provider: 'deepseek', model: 'deepseek-v4-flash' },
} as const;
type AgentModelKey = keyof typeof AGENT_MODELS;
// Own-property check (NOT `in`, which would match inherited names — see isQaModelKey).
const isAgentModelKey = (v: unknown): v is AgentModelKey =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(AGENT_MODELS, v);
const AGENT_MAX_MESSAGES = 60; // cap transcript length sent per turn (payload / cost guard)
const AGENT_MAX_CHARS = 12000; // cap per text/tool_result block length
const AGENT_MAX_BLOCKS = 24; // cap content blocks per message

const AGENT_SYSTEM_PROMPT = `You are the Lab Assistant, the built-in AI helper for Infrared Explorer, a web app where students analyze infrared (thermal-imaging) experiments — thermal video clips with placeable "thermometers" (temperature probes), temperature-vs-time charts, and AI analysis tools.

Your job is to help users understand thermal physics AND to operate the app for them using the tools provided. Be concise, friendly, and accurate.

Using tools:
- The message includes a "Current app state" JSON block (page, the open experiment, its thermometers with labels T1/T2…, temperature unit). Read it first — you usually don't need a tool to know what's open or which thermometers exist.
- To go to an experiment the user names or describes: find it with search_experiments (all public experiments) or list_my_experiments (the user's own), then open_experiment with its id. If the id is already in the app state, just open_experiment.
- Whenever you show or mention a specific experiment (a list, a table, or inline), make its title a clickable Markdown link to "#/experiments/<id>" using its id — e.g. [Melting Ice with Salt](#/experiments/abc123) — so the user can click to open it. Always include this link when listing experiments.
- To go to a SECTION of the app (not a specific experiment), use navigate_to: home (the public gallery), my_experiments, my_profile (the user's public profile page), recent (recently viewed), raw (raw recordings), classroom, trash, settings, about, contact, or the admin pages.
- Before any quantitative claim about how temperatures changed, call read_experiment_data (it returns the measured numbers, including each sampled frame's "hotspot" location). Ground every number in that data — never invent temperatures, rates, or times.
- You can operate the analyzer: add_thermometer (place a probe — to target the hottest spot, call read_experiment_data first and use its hotspot coordinates), rename_thermometer, select_thermometer, remove_thermometer, remove_all_thermometers, set_temperature_unit, seek_to_time, set_playback. Refer to a thermometer by its label (T1, T2…) or name. These act on the experiment currently open in the analyzer — open one first if needed.
- You can add and edit text annotations (callout notes) on the open experiment: add_annotation (text at an [0,1] position, optionally limited to a time window), edit_annotation, list_annotations, remove_annotation. Refer to an annotation by its label (A1, A2…) or a snippet of its note. Only add or change a note the user actually asked for; on an experiment they don't own it's a local-only sandbox note (tell them so, from the result's 'persisted' flag).
- Deleting asks the user to confirm; if they decline (the tool says so), acknowledge and stop. Do only what the user asked — don't place or delete probes they didn't request.

Still out of scope (v1): editing clips/segments and generating the AI lab report or Q&A answers. If asked for one of those, briefly tell the user how to do it in the app.

Explain the physics (conduction, convection, radiation, evaporative cooling, thermal equilibrium, phase change) only when the data supports it; hedge when a mechanism is ambiguous. Answer in the user's language (English or Chinese). Keep answers short unless asked for depth. Use Markdown. No meta commentary about being an AI.`;

// Tool SCHEMAS (authoritative). Execution lives in the browser (src/components/aiChat/agentTools.ts),
// except read_experiment_data whose data read runs in getExperimentData below. Keep names in sync.
const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_experiments',
    description:
      'Search all public experiments (system showcases and user-published work) by keyword (matches the title and subject). Use this to find an experiment to open when the user names or describes one. Returns up to 15 matches, each with id, title, and subject.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keywords to match against experiment titles/subjects.' } },
      required: ['query'],
    },
  },
  {
    name: 'list_my_experiments',
    description:
      "List the signed-in user's own experiments (their saved clips), most recent first. Returns id, title, and subject.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'open_experiment',
    description:
      'Open an experiment in the analyzer (navigates the app to it). Pass the experiment id (from search_experiments / list_my_experiments, or the current app state). After opening, its thermometers and data become available.',
    input_schema: {
      type: 'object',
      properties: { expId: { type: 'string', description: 'The experiment id to open.' } },
      required: ['expId'],
    },
  },
  {
    name: 'list_thermometers',
    description:
      'List the temperature probes ("thermometers") on the experiment currently open in the analyzer: label (T1, T2…), name, normalized [0,1] position, measuring-area type, and latest on-screen reading. Only works when an experiment is open.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_experiment_data',
    description:
      "Read an experiment's measured thermal data: a compact JSON summary with each thermometer's temperature-vs-time series and the whole-frame min/max/mean/hotspot sampled across the clip. Call this before any quantitative claim about how temperatures changed. Omit expId to use the currently open experiment. Recording experiments can be read by id even if not open; a VIDEO experiment must be OPEN first (its data is read in the browser), so open_experiment before reading a video's data.",
    input_schema: {
      type: 'object',
      properties: { expId: { type: 'string', description: 'Experiment id; omit to use the currently open one.' } },
    },
  },
  {
    name: 'add_thermometer',
    description:
      'Place a new temperature probe ("thermometer") on the open recording experiment at normalized image coordinates (x left→right, y top→bottom, both in [0,1]; 0.5,0.5 is the centre). Its reading is taken from the current frame. Optionally name it and give it a measuring area. To place it on the hottest spot, call read_experiment_data first and use a frame\'s "hotspot" coordinates.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Normalized x in [0,1] (left→right).' },
        y: { type: 'number', description: 'Normalized y in [0,1] (top→bottom, 0 = top).' },
        name: { type: 'string', description: 'Optional name (else the positional default T1, T2, … is used).' },
        areaType: {
          type: 'string',
          enum: ['point', 'rectangle', 'ellipse'],
          description: 'Measuring area shape; default point.',
        },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'rename_thermometer',
    description:
      'Rename a thermometer on the open experiment. Identify it by its label (T1, T2, …), its current name, or its id.',
    input_schema: {
      type: 'object',
      properties: {
        thermometer: { type: 'string', description: 'Which thermometer: a label (e.g. "T2"), its name, or id.' },
        name: { type: 'string', description: 'The new name.' },
      },
      required: ['thermometer', 'name'],
    },
  },
  {
    name: 'select_thermometer',
    description:
      'Select/highlight a thermometer on the open experiment (highlights it on the image and its chart series). Identify it by label, name, or id.',
    input_schema: {
      type: 'object',
      properties: { thermometer: { type: 'string', description: 'A label (e.g. "T1"), name, or id.' } },
      required: ['thermometer'],
    },
  },
  {
    name: 'remove_thermometer',
    description:
      'Delete one thermometer from the open experiment. The user is asked to confirm before it is removed. Identify it by label, name, or id.',
    input_schema: {
      type: 'object',
      properties: { thermometer: { type: 'string', description: 'A label (e.g. "T3"), name, or id.' } },
      required: ['thermometer'],
    },
  },
  {
    name: 'remove_all_thermometers',
    description: 'Delete ALL thermometers from the open experiment. The user is asked to confirm first.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_temperature_unit',
    description: 'Set the temperature display unit for the whole app.',
    input_schema: {
      type: 'object',
      properties: { unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'The unit to display.' } },
      required: ['unit'],
    },
  },
  {
    name: 'seek_to_time',
    description:
      'Move the playhead of the open recording experiment to a time in seconds (clamped to the clip). Stops playback.',
    input_schema: {
      type: 'object',
      properties: { seconds: { type: 'number', description: 'Target time in seconds from the clip start.' } },
      required: ['seconds'],
    },
  },
  {
    name: 'set_playback',
    description: 'Play or pause the open recording experiment.',
    input_schema: {
      type: 'object',
      properties: { playing: { type: 'boolean', description: 'true = play, false = pause.' } },
      required: ['playing'],
    },
  },
  {
    name: 'navigate_to',
    description: 'Navigate the app to a top-level page (not a specific experiment — use open_experiment for that).',
    input_schema: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          enum: [
            'home',
            'my_experiments',
            'my_profile',
            'recent',
            'raw',
            'classroom',
            'trash',
            'settings',
            'about',
            'contact',
            'admin_users',
            'admin_experiments',
          ],
          description:
            "home = the homepage (staff-featured gallery); my_experiments = the user's saved clips; my_profile = the user's public profile page; recent = recently viewed; raw = raw recordings; classroom = classes; trash = deleted experiments; plus settings / about / contact and the admin pages.",
        },
      },
      required: ['page'],
    },
  },
  {
    name: 'list_annotations',
    description:
      'List the annotations (text callout notes) on the open experiment: label (A1, A2…), note text, normalized position, and time window.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'add_annotation',
    description:
      "Add a text annotation (a callout note) to the open experiment at normalized image coordinates (x left→right, y top→bottom in [0,1]; defaults to a central spot). Optionally limit it to a time window with startSec/endSec (default: visible for the whole clip). Note: on an experiment the user doesn't own, the annotation is a local sandbox and isn't saved to the source — the result's `persisted` flag says which.",
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The annotation text.' },
        x: { type: 'number', description: 'Normalized x in [0,1]; default 0.5.' },
        y: { type: 'number', description: 'Normalized y in [0,1]; default 0.4.' },
        startSec: { type: 'number', description: 'Optional: show from this time (seconds).' },
        endSec: { type: 'number', description: 'Optional: show until this time (seconds).' },
      },
      required: ['note'],
    },
  },
  {
    name: 'edit_annotation',
    description:
      'Edit an existing annotation on the open experiment — its text, position, and/or time window. Identify it by label (A1, A2…), a snippet of its note, or its id.',
    input_schema: {
      type: 'object',
      properties: {
        annotation: { type: 'string', description: 'Which annotation: a label (e.g. "A2"), note text, or id.' },
        note: { type: 'string', description: 'New text.' },
        x: { type: 'number', description: 'New normalized x in [0,1].' },
        y: { type: 'number', description: 'New normalized y in [0,1].' },
        startSec: { type: 'number', description: 'New window start (seconds).' },
        endSec: { type: 'number', description: 'New window end (seconds).' },
      },
      required: ['annotation'],
    },
  },
  {
    name: 'remove_annotation',
    description:
      'Delete one annotation from the open experiment. The user is asked to confirm first. Identify it by label, note text, or id.',
    input_schema: {
      type: 'object',
      properties: { annotation: { type: 'string', description: 'A label (e.g. "A1"), note text, or id.' } },
      required: ['annotation'],
    },
  },
];

/** Sanitize one client-supplied content block into a Claude ContentBlockParam (or drop it). */
function sanitizeAgentBlock(b: unknown): Anthropic.ContentBlockParam | null {
  if (!b || typeof b !== 'object') return null;
  const block = b as Record<string, unknown>;
  if (block.type === 'text') return { type: 'text', text: String(block.text ?? '').slice(0, AGENT_MAX_CHARS) };
  if (block.type === 'tool_use' && block.id && block.name) {
    return { type: 'tool_use', id: String(block.id), name: String(block.name), input: block.input ?? {} };
  }
  if (block.type === 'tool_result' && block.tool_use_id) {
    return {
      type: 'tool_result',
      tool_use_id: String(block.tool_use_id),
      content: String(block.content ?? '').slice(0, AGENT_MAX_CHARS),
      ...(block.is_error ? { is_error: true } : {}),
    };
  }
  return null;
}

/** Sanitize a message's content: a plain string, or an array of content blocks (text/tool_use/tool_result). */
function sanitizeAgentContent(content: unknown): string | Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') return content.slice(0, AGENT_MAX_CHARS);
  if (Array.isArray(content)) {
    return content
      .slice(0, AGENT_MAX_BLOCKS)
      .map(sanitizeAgentBlock)
      .filter((b): b is Anthropic.ContentBlockParam => b !== null);
  }
  return '';
}

// --- OpenAI-compatible agent bridge -----------------------------------------
// DeepSeek / OpenAI / xAI Grok all expose an OpenAI-compatible chat API (function calling included), so
// the Lab Assistant's Anthropic-shaped tool loop can run on any of them — we just translate the transcript
// + tool schemas into the OpenAI shape on the way in, and the streamed tool_calls back into Anthropic
// content blocks on the way out, so the browser's loop stays identical regardless of provider.

/** Translate the agent's Anthropic tool schemas into OpenAI function-tool definitions. */
function toOpenAiTools(tools: Anthropic.Tool[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/** Translate the Anthropic-shaped agent transcript into OpenAI chat messages. A user string stays a user
 *  message; an assistant turn's text + tool_use blocks become content + tool_calls; a user turn's
 *  tool_result blocks each become a separate `tool` message (which OpenAI requires to follow the matching
 *  assistant tool_calls). Images never appear in the agent transcript, so none are dropped here. */
function toOpenAiMessages(system: string, messages: Anthropic.MessageParam[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      let text = '';
      const toolCalls: unknown[] = [];
      for (const b of m.content) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_use')
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
      }
      const msg: Record<string, unknown> = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      const texts: string[] = [];
      for (const b of m.content) {
        if (b.type === 'tool_result')
          out.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
          });
        else if (b.type === 'text') texts.push(b.text);
      }
      if (texts.length) out.push({ role: 'user', content: texts.join('\n\n') });
    }
  }
  return out;
}

/** Run one agent turn on an OpenAI-compatible provider (DeepSeek / OpenAI / xAI Grok, `baseUrl`). Streams
 *  the OpenAI-style SSE response: text deltas are forwarded via sendChunk (as the Anthropic path does) and
 *  tool_call fragments are accumulated by index. Returns the turn as Anthropic-shaped content blocks
 *  (text + tool_use) so the caller/browser handle it identically to a Claude turn. */
async function callOpenAiForAgent(
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
  system: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  maxTokensParam: MaxTokensParam,
  response?: CallableResponse,
): Promise<{ content: Anthropic.ContentBlock[]; stopReason: string | null }> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        [maxTokensParam]: 1500,
        stream: true,
        messages: toOpenAiMessages(system, messages),
        tools: toOpenAiTools(tools),
      }),
    });
  } catch (err) {
    console.error('OpenAI-compatible agent call failed', err);
    throw new HttpsError('internal', `AI request failed: ${(err as { message?: string })?.message ?? 'unknown error'}`);
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    console.error('OpenAI-compatible agent call failed', res.status, detail.slice(0, 500));
    throw new HttpsError('internal', `AI request failed (${res.status}).`);
  }

  // Accumulate across SSE deltas: answer text, and tool_calls keyed by their streamed index (each fragment
  // carries an id/name once and appends argument-JSON chars).
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = '';
  let text = '';
  const toolAcc: { id: string; name: string; args: string }[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta;
          if (typeof delta?.content === 'string' && delta.content) {
            text += delta.content;
            void response?.sendChunk({ text: delta.content });
          }
          if (Array.isArray(delta?.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === 'number' ? tc.index : toolAcc.length;
              const slot = (toolAcc[idx] ??= { id: '', name: '', args: '' });
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.name = tc.function.name;
              if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments;
            }
          }
        } catch {
          // Ignore a partial/non-JSON keep-alive line.
        }
      }
    }
  } catch (err) {
    console.error('OpenAI-compatible agent stream read failed', err);
    throw new HttpsError('internal', `AI request failed: ${(err as { message?: string })?.message ?? 'unknown error'}`);
  }

  // Build the Anthropic-shaped turn: a text block (if any) plus one tool_use per accumulated call.
  const content: Anthropic.ContentBlock[] = [];
  if (text.trim()) content.push({ type: 'text', text, citations: null } as Anthropic.ContentBlock);
  toolAcc.forEach((tc, i) => {
    if (!tc?.name) return;
    let input: unknown = {};
    try {
      input = tc.args ? JSON.parse(tc.args) : {};
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: tc.id || `oai_tc_${i}`, name: tc.name, input } as Anthropic.ContentBlock);
  });
  const hasToolUse = content.some((b) => b.type === 'tool_use');
  return { content, stopReason: hasToolUse ? 'tool_use' : 'end_turn' };
}

/**
 * Lab Assistant turn. Input: { messages, context?, enabledTools?, model? } — the running Anthropic-shaped
 * transcript (last message from the user or carrying tool_result blocks), the current app-state snapshot
 * (injected into the system prompt), the tool names usable on the current page, and which model answers
 * (Sonnet/Opus on Claude, or DeepSeek/ChatGPT/Grok — see AGENT_MODELS). Declares those tools and returns
 * the assistant turn { content, stopReason } — content may contain tool_use blocks for the browser to
 * execute. Staff-gated (intofuture.org). One rate-limit tick per real user message (tool-result
 * continuations don't tick). Nothing is persisted.
 */
export const agentChat = onCall(
  {
    secrets: [ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY, XAI_API_KEY, GOOGLE_API_KEY],
    timeoutSeconds: 120,
    memory: '512MiB',
  },
  async (request, response) => {
    const mongoId = requireMongoId(request.auth);
    // Mirrors the client isStaff() gate (and the other AI callables): internal IFI accounts only for now.
    const email = ((request.auth!.token.email as string | undefined) ?? '').toLowerCase();
    if (!email.endsWith('@intofuture.org')) {
      throw new HttpsError('permission-denied', 'The AI assistant is restricted to intofuture.org accounts.');
    }

    const {
      messages: rawMessages,
      context,
      enabledTools,
      model: rawModel,
    } = (request.data ?? {}) as {
      messages?: unknown[];
      context?: unknown;
      enabledTools?: string[];
      model?: string;
    };
    // Default model unless the client explicitly asked for another supported one.
    const modelKey: AgentModelKey = isAgentModelKey(rawModel) ? rawModel : DEFAULT_MODEL_KEY;

    const messages: Anthropic.MessageParam[] = (Array.isArray(rawMessages) ? rawMessages : [])
      .slice(-AGENT_MAX_MESSAGES)
      .map((m) => {
        const msg = (m ?? {}) as { role?: string; content?: unknown };
        return {
          role: msg.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          content: sanitizeAgentContent(msg.content),
        };
      })
      .filter((m) => (typeof m.content === 'string' ? m.content.trim().length > 0 : m.content.length > 0));
    if (messages.length === 0) throw new HttpsError('invalid-argument', 'No message to send.');
    const last = messages[messages.length - 1];
    if (last.role !== 'user') throw new HttpsError('invalid-argument', 'The last message must be from the user.');

    // One tick per real user message; a tool-result continuation (client executed a tool and called back)
    // is part of the SAME user turn, so it must not tick again.
    const isContinuation =
      Array.isArray(last.content) && last.content.some((b) => (b as { type?: string }).type === 'tool_result');
    if (!isContinuation) await enforceAiRateLimit(mongoId);

    // Inject the current app-state snapshot so the model knows what's open without spending a tool call.
    const contextText = context ? `\n\n---\nCurrent app state (JSON):\n${JSON.stringify(context).slice(0, 4000)}` : '';
    const tools =
      Array.isArray(enabledTools) && enabledTools.length
        ? AGENT_TOOLS.filter((t) => enabledTools.includes(t.name))
        : AGENT_TOOLS;

    const { provider, model } = AGENT_MODELS[modelKey];
    const system = AGENT_SYSTEM_PROMPT + contextText;

    // DeepSeek / ChatGPT / Grok run the same tool loop through their OpenAI-compatible API (transcript and
    // tools translated in callOpenAiForAgent); it returns the turn already shaped as Anthropic content blocks.
    if (provider !== 'anthropic') {
      const p = resolveOpenAiProvider(provider);
      return await callOpenAiForAgent(messages, tools, system, p.baseUrl, p.apiKey, model, p.maxTokensParam, response);
    }

    const anthropic = new Anthropic({ apiKey: claudeApiKey() });
    let msg: Anthropic.Message;
    try {
      // Stream server-side so the browser can render the answer as it grows (a no-op for the client if it
      // didn't request streaming). Only answer text fires 'text' — tool_use blocks don't, and arrive whole
      // in finalMessage(); a text preamble before a tool call still streams.
      const stream = anthropic.messages.stream({
        model,
        max_tokens: 1500,
        system,
        tools,
        messages,
      });
      stream.on('text', (delta) => {
        void response?.sendChunk({ text: delta });
      });
      msg = await stream.finalMessage();
    } catch (err) {
      console.error('agentChat Claude call failed', err);
      throw new HttpsError(
        'internal',
        `AI request failed: ${(err as { message?: string })?.message ?? 'unknown error'}`,
      );
    }

    // Return the raw assistant content blocks (text + any tool_use) for the browser to render / execute.
    return { content: msg.content, stopReason: msg.stop_reason };
  },
);

/**
 * Read an experiment's measured thermal summary for the Lab Assistant's read_experiment_data tool. This
 * is the heavy half of that tool (Firestore + Storage reads via the Admin SDK), kept server-side so the
 * client tool is a thin call. Reuses buildThermalSummary (same numbers the report/Q&A see). Staff-gated;
 * recording-based experiments only. No Claude call, so no AI rate-limit tick.
 */
export const getExperimentData = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
  requireMongoId(request.auth);
  const email = ((request.auth!.token.email as string | undefined) ?? '').toLowerCase();
  if (!email.endsWith('@intofuture.org')) {
    throw new HttpsError('permission-denied', 'The AI assistant is restricted to intofuture.org accounts.');
  }
  const { expId } = (request.data ?? {}) as { expId?: string };
  if (!expId) throw new HttpsError('invalid-argument', 'Missing expId.');
  const exp = (await db.doc(`experiments/${expId}`).get()).data();
  if (!exp) throw new HttpsError('not-found', 'Experiment not found.');
  if (exp.sourceType !== 'recording') {
    throw new HttpsError('failed-precondition', 'Thermal data is available for recording-based experiments only.');
  }
  const recordingId = exp.recordingId as string | undefined;
  if (!recordingId) throw new HttpsError('failed-precondition', 'This experiment has no recording data.');
  const summary = await buildThermalSummary(expId, exp, recordingId);
  return { summary, title: (exp.displayName as string | undefined) ?? null };
});
