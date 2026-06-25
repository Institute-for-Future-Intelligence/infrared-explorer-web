// Phase 2: migrate Atlas clips (UserRecordingConfig) + ExperimentState/thermometers/comments/
// ratings/annotations -> experiments/{clipId} (+subcollections). DRY-RUN by default.
//   node scripts/migrateClips.mjs                      # dry run (no writes)
//   WRITE=true node scripts/migrateClips.mjs           # write
//   INCLUDE_TRASH=true ...                             # also migrate trashed clips (trash:true)
//   ONLY_OWNER=<mongoId> ... | LIMIT=<n> ...           # scope for a validation batch
//
// Idempotency: the PARENT experiments/{clipId} doc is the commit marker — a clip's parent +
// all its subdocs are written in ONE atomic batch, parent included, so "parent exists" means
// "fully migrated". Skip-if-parent-exists (unless REPAIR=true) makes the run resumable.
import { ObjectId } from 'mongodb';
import {
  connectAtlas,
  getFb,
  mapClip,
  mapThermometer,
  mapComments,
  mapAnnotations,
  mapUser,
  oid,
} from './migrationLib.mjs';

const WRITE = process.env.WRITE === 'true';
const REPAIR = process.env.REPAIR === 'true';
const INCLUDE_TRASH = process.env.INCLUDE_TRASH === 'true';
const ONLY_OWNER = process.env.ONLY_OWNER || null;
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : null;

const { db } = getFb();
const { client, db: m } = await connectAtlas();

console.log('Loading Atlas reference data...');
const [states, recs, users, therms, comments, ratings, profiles] = await Promise.all([
  m.collection('experiments').find({}).toArray(),
  m.collection('recordings').find({}, { projection: { lastFrameNumber: 1, topic: 1 } }).toArray(),
  m.collection('users').find({}).toArray(),
  m.collection('thermometers').find({}).toArray(),
  m.collection('comments').find({}).toArray(),
  m.collection('ratings').find({}).toArray(),
  m.collection('profiles').find({}, { projection: { avatar: 1, owner: 1, createdAt: 1 } }).toArray(),
]);

const stateById = new Map(states.map((s) => [String(s.id), s]));
const recById = new Map(recs.map((r) => [oid(r._id), r]));
const thermById = new Map(therms.map((t) => [String(t.id), t]));

profiles.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
const avatarByOwner = new Map();
for (const p of profiles) if (p.owner && p.avatar) avatarByOwner.set(oid(p.owner), p.avatar);

const userNameById = new Map();
const publicById = new Map();
for (const u of users) {
  const { publicDoc } = mapUser(u, avatarByOwner.get(oid(u._id)));
  userNameById.set(oid(u._id), publicDoc.displayName);
  publicById.set(oid(u._id), publicDoc);
}

const commentsByExp = new Map();
for (const c of comments) (commentsByExp.get(String(c.expID)) ?? commentsByExp.set(String(c.expID), []).get(String(c.expID))).push(c);
const ratingsByExp = new Map();
for (const r of ratings) (ratingsByExp.get(String(r.expID)) ?? ratingsByExp.set(String(r.expID), []).get(String(r.expID))).push(r);

// clips
const ownerFilter = ONLY_OWNER ? { user: { $in: [ONLY_OWNER, new ObjectId(ONLY_OWNER)] } } : {};
const q = { ...(INCLUDE_TRASH ? {} : { trash: { $ne: true } }), ...ownerFilter };
let clips = await m.collection('userrecordingconfigs').find(q).toArray();
await client.close();
if (LIMIT) clips = clips.slice(0, LIMIT);

const stats = {
  total: clips.length,
  written: 0,
  skippedExisting: 0,
  noState: 0,
  orphanRecording: 0,
  synthCreatedAt: 0,
  subjectDropped: 0,
  therms: 0,
  comments: 0,
  ratings: 0,
  annotations: 0,
};
const orphans = [];
const perOwner = {};

for (const clip of clips) {
  const built = mapClip(clip, { stateById, recById, userNameById });
  const { expId, ownerId, doc, state, meta } = built;
  if (meta.noState) stats.noState++;
  if (meta.orphanRecording) {
    stats.orphanRecording++;
    orphans.push({ expId, recordingId: built.recordingId });
  }
  if (meta.synthCreatedAt) stats.synthCreatedAt++;
  if (meta.subjectDropped) stats.subjectDropped++;
  perOwner[ownerId] = (perOwner[ownerId] ?? 0) + 1;

  // dedup: parent is the commit marker
  if (!REPAIR) {
    const existing = await db.doc(`experiments/${expId}`).get();
    if (existing.exists) {
      stats.skippedExisting++;
      continue;
    }
  }

  // subdocs
  const thermDocs = (state?.thermometers ?? [])
    .map((tid) => thermById.get(String(tid)))
    .filter(Boolean)
    .map((t) => mapThermometer(t, ownerId));
  const commentDocs = mapComments(commentsByExp.get(expId) ?? [], publicById);
  const annoDocs = mapAnnotations(state, expId, ownerId);
  // ratings: dedup one-per-user (last wins), recompute aggregates
  const byUser = new Map();
  for (const r of ratingsByExp.get(expId) ?? []) {
    const ruid = oid(r.user);
    if (ruid && typeof r.rating === 'number') byUser.set(ruid, r.rating);
  }
  let ratingSum = 0;
  byUser.forEach((v) => (ratingSum += v));
  doc.ratingSum = ratingSum;
  doc.ratingCount = byUser.size;
  doc.commentCount = commentDocs.length;

  stats.therms += thermDocs.length;
  stats.comments += commentDocs.length;
  stats.ratings += byUser.size;
  stats.annotations += annoDocs.length;

  if (WRITE) {
    const expRef = db.doc(`experiments/${expId}`);
    const ops = 1 + thermDocs.length + commentDocs.length + byUser.size + annoDocs.length;
    if (ops <= 500) {
      // one atomic batch; parent LAST is irrelevant within an atomic commit
      const batch = db.batch();
      for (const t of thermDocs) batch.set(expRef.collection('thermometers').doc(t.id), t);
      for (const c of commentDocs) batch.set(expRef.collection('comments').doc(c.id), c.data);
      for (const [ruid, rating] of byUser) batch.set(expRef.collection('ratings').doc(ruid), { rating });
      for (const a of annoDocs) batch.set(expRef.collection('annotations').doc(a.id), a.data);
      batch.set(expRef, doc);
      await batch.commit();
    } else {
      // rare: write subdocs first, parent last (commit marker)
      for (const t of thermDocs) await expRef.collection('thermometers').doc(t.id).set(t);
      for (const c of commentDocs) await expRef.collection('comments').doc(c.id).set(c.data);
      for (const [ruid, rating] of byUser) await expRef.collection('ratings').doc(ruid).set({ rating });
      for (const a of annoDocs) await expRef.collection('annotations').doc(a.id).set(a.data);
      await expRef.set(doc);
    }
  }
  stats.written++;
}

console.log('\n==== migrateClips SUMMARY ====');
console.log(`mode: ${WRITE ? 'WRITE' : 'DRY RUN'}${INCLUDE_TRASH ? ' +trash' : ''}${ONLY_OWNER ? ' owner=' + ONLY_OWNER : ''}${LIMIT ? ' limit=' + LIMIT : ''}`);
console.log(`clips considered: ${stats.total}`);
console.log(`  written/would-write: ${stats.written}`);
console.log(`  skipped (already migrated): ${stats.skippedExisting}`);
console.log(`  no ExperimentState (fallback title+duration): ${stats.noState}`);
console.log(`  orphan recording (no Recording doc): ${stats.orphanRecording}`);
console.log(`  synthesized createdAt (sort-affecting): ${stats.synthCreatedAt}`);
console.log(`  subject dropped (out-of-enum): ${stats.subjectDropped}`);
console.log(`  subdocs -> thermometers=${stats.therms} comments=${stats.comments} ratings=${stats.ratings} annotations=${stats.annotations}`);
console.log(`  distinct owners receiving clips: ${Object.keys(perOwner).length}`);
if (orphans.length) console.log(`  orphan examples: ${orphans.slice(0, 8).map((o) => o.expId + '->' + o.recordingId).join(', ')}`);
process.exit(0);
