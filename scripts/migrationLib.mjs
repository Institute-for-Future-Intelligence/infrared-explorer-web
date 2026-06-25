// Shared helpers for the full telelab Atlas -> Firebase migration.
// See docs/telelab-full-data-migration.md. Pure mappers + connection helpers.
//
// Atlas connection string comes from env ATLAS_URI (do NOT hardcode the secret here).
//   export ATLAS_URI='mongodb+srv://<user>:<pw>@cluster-telelab.n3yjy.mongodb.net/heroku_nvhk53z3?retryWrites=true&w=majority'
import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

export const ATLAS_DB = 'heroku_nvhk53z3';
export const BUCKET = 'infrared-explorer.appspot.com';
export const FPS = 5; // imagePlayer: lastFrameIndex = duration*5 - 1 (src/pages/experimentAnalyzer/hooks.ts)

export function requireAtlasUri() {
  const uri = process.env.ATLAS_URI;
  if (!uri) {
    console.error('ERROR: set ATLAS_URI env (see docs/telelab-full-data-migration.md / telelab prod server-depl.yaml).');
    process.exit(2);
  }
  return uri;
}

export async function connectAtlas() {
  const client = new MongoClient(requireAtlasUri(), { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  return { client, db: client.db(ATLAS_DB) };
}

let _fb = null;
export function getFb() {
  if (_fb) return _fb;
  const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
  initializeApp({ credential: cert(sa), storageBucket: BUCKET });
  _fb = { db: getFirestore(), bucket: getStorage().bucket(), FieldValue, Timestamp };
  return _fb;
}

export const oid = (x) => (x == null ? '' : x.toString());
export const normEmail = (e) => (e || '').trim().toLowerCase();

/** Mongo ObjectId -> creation Date (first 4 bytes = unix seconds), or null if not an ObjectId. */
export function oidDate(id) {
  const s = oid(id);
  if (!/^[a-f0-9]{8}/i.test(s)) return null;
  const d = new Date(parseInt(s.slice(0, 8), 16) * 1000);
  return isNaN(d.getTime()) ? null : d;
}
const isObjectIdLike = (s) => typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s);

/** Parse a legacy date (BSON Date | ISO | locale string) to a Firestore Timestamp, or null. */
export function toTimestamp(v) {
  if (!v) return null;
  try {
    const d = v instanceof Date ? v : new Date(v);
    if (isNaN(d.getTime())) return null;
    return Timestamp.fromDate(d);
  } catch {
    return null;
  }
}

// ---------------- USER ----------------
/** Atlas User (+ avatar) -> { docId, userDoc, publicDoc }. */
export function mapUser(u, avatar) {
  const id = oid(u._id);
  const displayName =
    (u.nickname && u.nickname.trim()) ||
    `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() ||
    (u.email ? normEmail(u.email).split('@')[0] : '') ||
    'User';
  const userDoc = {
    id,
    email: normEmail(u.email),
    emailRaw: u.email ?? null,
    displayName,
    avatar: avatar ?? null,
    role: (u.role ?? 'Student').toLowerCase(),
    providerID: u.providerID ?? null,
    prefs: {
      disallowCopy: !!u.disallowCopy,
      disallowNotification: !!u.disallowNotification,
      disallowNewsletter: !!u.disallowNewsletter,
    },
    // Prefer the real signup time; early users (pre-`timestamps` schema) lack createdAt, so fall
    // back to the ObjectId-embedded creation time before resorting to the migration time.
    createdAt: toTimestamp(u.createdAt) ?? toTimestamp(oidDate(u._id)) ?? FieldValue.serverTimestamp(),
    migratedAt: FieldValue.serverTimestamp(),
    migratedSource: 'atlas-users',
  };
  const publicDoc = { displayName, avatar: avatar ?? null };
  return { docId: id, userDoc, publicDoc };
}

// ---------------- SEGMENTS ----------------
/** Atlas [{startFrame,endFrame}] -> app [{start,end}]; empty/none -> null (whole recording). */
export function remapSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const out = segments
    .filter((s) => s && (s.startFrame != null || s.start != null))
    .map((s) => ({ start: s.startFrame ?? s.start, end: s.endFrame ?? s.end }));
  return out.length ? out : null;
}

const KNOWN_SUBJECTS = new Set(['not available', 'chemistry', 'physics', 'biology']);

// ---------------- CLIP -> EXPERIMENT ----------------
/**
 * Build the experiments/{clipId} doc. ctx = { stateById, recById, userNameById }.
 * Returns { expId, doc, meta:{noState, orphanRecording, synthCreatedAt, subjectDropped} }.
 */
export function mapClip(clip, ctx) {
  const { stateById, recById, userNameById } = ctx;
  const expId = oid(clip._id);
  const ownerId = oid(clip.user);
  const recordingId = oid(clip.recording) || null;
  const state = stateById.get(expId) || null;
  const rec = recordingId ? recById.get(recordingId) || null : null;

  const segments = remapSegments(clip.segments);
  const isRaw = !segments;

  // duration: ExperimentState if >0, else derive from recording so raw clips aren't blank.
  let duration = state && state.duration > 0 ? state.duration : 0;
  if (!duration && rec && rec.lastFrameNumber > 0) duration = rec.lastFrameNumber / FPS;

  // author: may be a userId (resolve to name) or a literal name; fallback to owner's name.
  let author = state?.author ?? '';
  if (isObjectIdLike(author) && userNameById.has(author)) author = userNameById.get(author);
  if (!author) author = userNameById.get(ownerId) ?? '';

  // subject validation
  let subject = state?.subject ?? null;
  let subjectDropped = false;
  if (subject != null && !KNOWN_SUBJECTS.has(subject)) {
    subjectDropped = true;
    subject = null;
  }

  const dateStr = state?.date || (clip.createdAt ? new Date(clip.createdAt).toLocaleString() : '');
  const displayName = (state?.displayName && state.displayName.trim()) || rec?.topic || `Untitled ${dateStr}`.trim();

  const thumbFrame = state?.currentFrameNumber || 1;
  const thumbnailURL = recordingId ? `recordings/${recordingId}/data_${thumbFrame}.png` : '';

  // createdAt: prefer the clip's own timestamp; when absent, fall back to the experiment date
  // (what the analyzer description shows) then the clip _id's embedded ObjectId time, so list
  // cards never show the migration day. Mirrors scripts/patchClipCreatedAt.mjs; only fully-absent
  // data synthesizes a serverTimestamp below.
  const createdTs =
    toTimestamp(clip.createdAt) ?? toTimestamp(state?.date) ?? toTimestamp(oidDate(clip._id));
  const updatedTs = toTimestamp(state?.timeStamp) || createdTs;

  const doc = {
    sourceType: 'recording',
    ownerId,
    visibility: 'unlisted',
    displayName,
    author,
    description: state?.description ?? '',
    subject,
    duration,
    date: dateStr,
    thumbnailURL,
    graphsOptions: Array.isArray(state?.graphsOptions) ? state.graphsOptions : [],
    thermalUnit: state?.unit ?? 'celsius',
    trash: !!clip.trash,
    isRaw,
    segments,
    recordingId,
    viewCount: clip.viewCount ?? 0,
    ratingSum: 0, // filled by caller from ratings
    ratingCount: 0,
    commentCount: 0,
    createdAt: createdTs ?? FieldValue.serverTimestamp(),
    updatedAt: updatedTs ?? FieldValue.serverTimestamp(),
    migratedSource: 'atlas-clips',
  };

  return {
    expId,
    ownerId,
    recordingId,
    doc,
    thumbFrame,
    state,
    rec,
    meta: {
      noState: !state,
      orphanRecording: !!recordingId && !rec,
      synthCreatedAt: !createdTs,
      subjectDropped,
    },
  };
}

// ---------------- THERMOMETER ----------------
export function mapThermometer(t, ownerId) {
  return {
    id: t.id,
    x: t.x ?? 0,
    y: t.y ?? 0,
    unit: t.unit ?? 'celsius',
    measuringAreaType: t.measuringAreaType ?? null, // Point/Ellipse/Rectangle/null (already app enum)
    measuringAreaWidth: t.measuringAreaWidth ?? null,
    measuringAreaHeight: t.measuringAreaHeight ?? null,
    ownerId,
    visibility: 'unlisted',
  };
}

// ---------------- COMMENTS (thread flatten) ----------------
/**
 * comments: Atlas Comment[] for one clip -> [{ id, data }]. parentOf maps childId->parentId
 * built from each comment's reply[] array. Dangling replyTo (parent absent) is dropped
 * (promote to top-level) so the comment stays visible in the UI.
 * publicById: Map mongoId -> { displayName, avatar }.
 */
export function mapComments(comments, publicById) {
  const present = new Set(comments.map((c) => oid(c._id)));
  const parentOf = new Map();
  for (const c of comments) {
    const pid = oid(c._id);
    for (const r of c.reply ?? []) parentOf.set(oid(r), pid);
  }
  return comments.map((c) => {
    const id = oid(c._id);
    const senderId = oid(c.sender);
    const pub = publicById.get(senderId) || {};
    let replyTo = parentOf.get(id);
    if (replyTo && !present.has(replyTo)) replyTo = undefined; // dangling -> top-level
    const data = {
      senderId,
      senderName: pub.displayName ?? '',
      senderAvatar: pub.avatar ?? '',
      content: c.content ?? '',
      date: c.date ?? '',
    };
    if (replyTo) data.replyTo = replyTo;
    return { id, data };
  });
}

// ---------------- ANNOTATIONS ----------------
/** ExperimentState.annotations (JSON string) -> [{ id, data }] (skip empty). */
export function mapAnnotations(state, expId, ownerId) {
  if (!state || !state.annotations) return [];
  let arr;
  try {
    arr = JSON.parse(state.annotations);
  } catch {
    return [];
  }
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return arr.map((a, i) => {
    const data = { ownerId, visibility: 'unlisted', note: a.note ?? a.text ?? '' };
    if (a.x != null) data.x = a.x;
    if (a.y != null) data.y = a.y;
    if (a.dx != null) data.dx = a.dx;
    if (a.dy != null) data.dy = a.dy;
    if (a.time) data.time = a.time;
    return { id: `${expId}_a${i}`, data }; // deterministic id -> idempotent
  });
}

/** Frame-restore union (recording-frame space) for one clip. duration already FPS-derived. */
export function clipFrameSet(clip, durationFrames) {
  const segs = remapSegments(clip.segments);
  const set = new Set();
  if (segs) {
    for (const { start, end } of segs) for (let i = start; i <= end; i++) set.add(i);
  } else {
    for (let i = 1; i <= durationFrames; i++) set.add(i);
  }
  return set;
}
