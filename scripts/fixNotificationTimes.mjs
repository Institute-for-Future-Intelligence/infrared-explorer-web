// Re-date the owner notifications that the comment/rating backfills generated so they show the
// ORIGINAL event time (from each source doc's ObjectId) instead of the backfill "now" time.
// Idempotent. DRY-RUN default. Only touches notifications that match a backfilled (owner,from,
// exp,type) target; never creates or deletes, only sets `date`.
//   node scripts/fixNotificationTimes.mjs              # dry run (report what it would change)
//   WRITE=true node scripts/fixNotificationTimes.mjs   # apply; waits for late triggers first
import { connectAtlas, getFb, oid, oidDate } from './migrationLib.mjs';

const WRITE = process.env.WRITE === 'true';

const { db } = getFb();
const { client, db: m } = await connectAtlas();
const [comments, ratings] = await Promise.all([
  m.collection('comments').find({}, { projection: { expID: 1, sender: 1 } }).toArray(),
  m.collection('ratings').find({}, { projection: { expID: 1, user: 1 } }).toArray(),
]);
await client.close();

// Build per-(expId,fromId,type) the original time = newest source-doc ObjectId time.
const targets = new Map(); // key `${expId}|${fromId}|${type}` -> { expId, fromId, type, ms }
const add = (expId, fromId, type, srcId) => {
  const t = oidDate(srcId);
  if (!fromId || !t) return;
  const key = `${expId}|${fromId}|${type}`;
  const cur = targets.get(key);
  if (!cur || t.getTime() > cur.ms) targets.set(key, { expId, fromId, type, ms: t.getTime() });
};
for (const c of comments) add(String(c.expID), oid(c.sender), 'comment', c._id);
for (const r of ratings) add(String(r.expID), oid(r.user), 'rating', r._id);

// Resolve experiment owners (only non-system owners get notifications); index targets by owner.
const ownerCache = new Map();
const ownerOf = async (expId) => {
  if (ownerCache.has(expId)) return ownerCache.get(expId);
  const s = await db.doc(`experiments/${expId}`).get();
  const o = s.exists ? s.data().ownerId : null;
  ownerCache.set(expId, o);
  return o;
};

const byOwner = new Map(); // owner -> [target...]
for (const t of targets.values()) {
  const owner = await ownerOf(t.expId);
  if (!owner || owner === 'system' || owner === t.fromId) continue; // mirror notifyExperimentOwner skips
  (byOwner.get(owner) ?? byOwner.set(owner, []).get(owner)).push(t);
}

console.log('==== fixNotificationTimes ====');
console.log(`mode: ${WRITE ? 'WRITE' : 'DRY RUN'}`);
console.log(`distinct (exp,from,type) targets with a notifiable owner = ${[...byOwner.values()].reduce((a, b) => a + b.length, 0)} across ${byOwner.size} owners`);

if (WRITE) {
  // Rating notifications fire asynchronously after the backfill; wait so we catch them all.
  console.log('waiting 30s for any late rating/comment notification triggers to land...');
  await new Promise((r) => setTimeout(r, 30000));
}

let matched = 0, redated = 0, alreadyOld = 0;
for (const [owner, ts] of byOwner) {
  const notifs = await db.collection(`users/${owner}/notifications`).get();
  const index = new Map(ts.map((t) => [`${t.expId}|${t.fromId}|${t.type}`, t]));
  for (const n of notifs.docs) {
    const d = n.data();
    const t = index.get(`${d.expId}|${d.fromId}|${d.type}`);
    if (!t) continue;
    matched++;
    const targetIso = new Date(t.ms).toISOString();
    if (d.date === targetIso) { alreadyOld++; continue; }
    // Only pull dates BACKWARD (a backfill notif is dated "now"); never clobber a genuinely newer one.
    if (d.date && new Date(d.date).getTime() <= t.ms) { alreadyOld++; continue; }
    if (WRITE) await n.ref.set({ date: targetIso }, { merge: true });
    redated++;
    if (redated <= 12) console.log(`  ${owner}/${n.id}: ${d.date} -> ${targetIso}  (${d.type} on ${d.expId})`);
  }
}
console.log(`matched notifications = ${matched}  | ${WRITE ? 're-dated' : 'would re-date'} = ${redated}  | already original/older = ${alreadyOld}`);
process.exit(0);
