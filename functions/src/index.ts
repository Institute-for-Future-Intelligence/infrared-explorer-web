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
import * as crypto from 'crypto';
import * as nodemailer from 'nodemailer';

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
