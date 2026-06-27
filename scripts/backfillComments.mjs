// Backfill comments that the main migration skipped. The 2026-06-25 migrateClips run dedup-
// skips any clip whose experiments/{id} parent already existed (the 88 pre-existing clips +
// seeded showcases), and with it skipped their comments. This re-writes ONLY the missing
// comment docs onto experiments that already exist in Firebase. Idempotent + DRY-RUN default.
//   node scripts/backfillComments.mjs                 # dry run (no writes), reports plan
//   WRITE=true node scripts/backfillComments.mjs      # write missing comments
//
// Notifications: writing a comment fires notifyOnComment. notifyExperimentOwner already skips
// system-owned (showcase) experiments and self-comments, and coalesces duplicates — so the dry
// run prints exactly how many real notifications would fire. If that number is non-trivial and
// you want zero, disable the trigger first:  firebase functions:delete notifyOnComment  (then
// redeploy after).  SUPPRESS_NOTIFS=true additionally deletes any 'comment' notifications this
// run could have created (owner+fromId+expId) right after writing, as a belt-and-braces cleanup.
import {
  connectAtlas,
  getFb,
  mapComments,
  mapUser,
  oid,
} from './migrationLib.mjs';

const WRITE = process.env.WRITE === 'true';
const SUPPRESS_NOTIFS = process.env.SUPPRESS_NOTIFS === 'true';

const { db } = getFb();
const { client, db: m } = await connectAtlas();

const [comments, users, profiles] = await Promise.all([
  m.collection('comments').find({}).toArray(),
  m.collection('users').find({}).toArray(),
  m.collection('profiles').find({}, { projection: { avatar: 1, owner: 1, createdAt: 1 } }).toArray(),
]);
await client.close();

// publicById: mongoId -> { displayName, avatar } (identical to migrateClips).
profiles.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
const avatarByOwner = new Map();
for (const p of profiles) if (p.owner && p.avatar) avatarByOwner.set(oid(p.owner), p.avatar);
const publicById = new Map();
for (const u of users) {
  const { publicDoc } = mapUser(u, avatarByOwner.get(oid(u._id)));
  publicById.set(oid(u._id), publicDoc);
}

// Group Atlas comments by expID, then re-map per experiment so reply threading is preserved.
const byExp = new Map();
for (const c of comments) {
  const e = String(c.expID);
  (byExp.get(e) ?? byExp.set(e, []).get(e)).push(c);
}

const stats = {
  expWithComments: byExp.size,
  expExists: 0,
  expAbsent: 0,
  alreadyPresent: 0,
  toWrite: 0,
  written: 0,
  notifsWouldFire: 0,
};
const absentExp = [];
const writePlan = []; // { expId, ownerId, docs: [{id, data}] }

for (const [expId, group] of byExp) {
  const expSnap = await db.doc(`experiments/${expId}`).get();
  if (!expSnap.exists) {
    stats.expAbsent++;
    absentExp.push({ expId, n: group.length });
    continue;
  }
  stats.expExists++;
  const ownerId = expSnap.data().ownerId;
  const mapped = mapComments(group, publicById); // [{id, data}]
  const missing = [];
  for (const c of mapped) {
    const exists = (await db.doc(`experiments/${expId}/comments/${c.id}`).get()).exists;
    if (exists) {
      stats.alreadyPresent++;
    } else {
      missing.push(c);
      // would a real notification fire? (mirror notifyExperimentOwner's guards)
      if (ownerId && ownerId !== 'system' && ownerId !== c.data.senderId) stats.notifsWouldFire++;
    }
  }
  if (missing.length) {
    stats.toWrite += missing.length;
    writePlan.push({ expId, ownerId, docs: missing });
  }
}

console.log('==== backfillComments plan ====');
console.log(`mode: ${WRITE ? 'WRITE' : 'DRY RUN'}${SUPPRESS_NOTIFS ? ' +suppress-notifs' : ''}`);
console.log(`Atlas comments total          = ${comments.length}`);
console.log(`experiments referenced        = ${stats.expWithComments}  (exist in FB=${stats.expExists}, absent=${stats.expAbsent})`);
console.log(`comments already present      = ${stats.alreadyPresent}`);
console.log(`comments to backfill          = ${stats.toWrite}`);
console.log(`  of those, notifications that would fire (non-system owner, non-self) = ${stats.notifsWouldFire} (before coalescing)`);
console.log(`comments unrecoverable (no FB experiment) = ${stats.expAbsent} experiments / ${absentExp.reduce((a, b) => a + b.n, 0)} comments`);

if (!WRITE) {
  console.log('\nDRY RUN — no writes. Re-run with WRITE=true to apply.');
  console.log('write plan (first 10 experiments):', JSON.stringify(writePlan.slice(0, 10).map((p) => ({ expId: p.expId, owner: p.ownerId, n: p.docs.length })), null, 1));
  process.exit(0);
}

// ---- WRITE ----
const notifTargets = []; // {ownerId, fromId, expId} to optionally clean up afterward
for (const { expId, ownerId, docs } of writePlan) {
  const expRef = db.doc(`experiments/${expId}`);
  const batch = db.batch();
  for (const c of docs) {
    batch.set(expRef.collection('comments').doc(c.id), c.data);
    if (ownerId && ownerId !== 'system' && ownerId !== c.data.senderId)
      notifTargets.push({ ownerId, fromId: c.data.senderId, expId });
  }
  await batch.commit();
  stats.written += docs.length;
  // self-heal the badge count regardless of the aggregateCommentCount Function.
  const agg = await expRef.collection('comments').count().get();
  await expRef.set({ commentCount: agg.data().count }, { merge: true });
  console.log(`  wrote ${docs.length} -> experiments/${expId} (commentCount now ${agg.data().count})`);
}

console.log(`\nDONE. backfilled ${stats.written} comments across ${writePlan.length} experiments.`);

if (SUPPRESS_NOTIFS && notifTargets.length) {
  // notifyOnComment fires asynchronously, so wait for it to land (in-script timer, not a shell
  // sleep), sweep, then sweep once more to catch any straggler the function created late.
  const sweep = async () => {
    let removed = 0;
    for (const t of notifTargets) {
      const dup = await db
        .collection(`users/${t.ownerId}/notifications`)
        .where('expId', '==', t.expId)
        .where('fromId', '==', t.fromId)
        .where('type', '==', 'comment')
        .get();
      for (const d of dup.docs) { await d.ref.delete(); removed++; }
    }
    return removed;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log(`Suppressing notifications for ${notifTargets.length} (owner,from,exp) targets; waiting 30s for triggers to land...`);
  await wait(30000);
  let removed = await sweep();
  console.log(`  pass 1 removed ${removed}; waiting 20s for stragglers...`);
  await wait(20000);
  removed += await sweep();
  console.log(`  total removed ${removed} notification docs.`);
}
process.exit(0);
