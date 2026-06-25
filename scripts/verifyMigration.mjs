// Read-only verification of the migration. Compares Atlas source against Firebase target.
//   node scripts/verifyMigration.mjs
import { connectAtlas, getFb, oid, normEmail } from './migrationLib.mjs';

const { db, bucket } = getFb();
const { client, db: m } = await connectAtlas();

const atlasUsers = await m.collection('users').find({}, { projection: { email: 1 } }).toArray();
const liveClips = await m.collection('userrecordingconfigs').find({ trash: { $ne: true } }, { projection: { user: 1, recording: 1 } }).toArray();
await client.close();

const fbUsers = await db.collection('users').get();
const fbUserIds = new Set();
const emailToId = new Map();
for (const u of fbUsers.docs) {
  const d = u.data();
  if (d.id) fbUserIds.add(d.id);
  fbUserIds.add(u.id);
  if (d.email) emailToId.set(normEmail(d.email), d.id ?? u.id);
}
const fbExp = await db.collection('experiments').get();
const fbExpIds = new Set(fbExp.docs.map((d) => d.id));
const ownerCount = {};
let privateCount = 0;
for (const d of fbExp.docs) {
  const e = d.data();
  if (e.ownerId && e.ownerId !== 'system') ownerCount[e.ownerId] = (ownerCount[e.ownerId] ?? 0) + 1;
  if (e.visibility === 'private') privateCount++;
}

// 1. users present
const usersMissing = atlasUsers.filter((u) => !fbUserIds.has(oid(u._id)));
// 2. clips present
const clipsMissing = liveClips.filter((c) => !fbExpIds.has(oid(c._id)));
// 3. per-user owned == atlas live clip count
const atlasPerUser = {};
for (const c of liveClips) atlasPerUser[oid(c.user)] = (atlasPerUser[oid(c.user)] ?? 0) + 1;
let perUserMismatch = 0;
for (const [uid, n] of Object.entries(atlasPerUser)) if ((ownerCount[uid] ?? 0) < n) perUserMismatch++;
// 4. email-login reachability sample
const sampleEmails = atlasUsers.slice(0, 5).map((u) => normEmail(u.email));
// 5. storage spot check
const recRef = [...new Set(liveClips.map((c) => oid(c.recording)).filter(Boolean))];
let recWithFrames = 0;
for (const r of recRef.slice(0, 30)) {
  const [files] = await bucket.getFiles({ prefix: `recordings/${r}/`, maxResults: 1 });
  if (files.length) recWithFrames++;
}

console.log('==== verifyMigration ====');
console.log(`1. users: atlas=${atlasUsers.length}  missing in FB=${usersMissing.length}  ${usersMissing.length === 0 ? 'OK' : 'FAIL'}`);
console.log(`2. clips: atlas-live=${liveClips.length}  missing in FB=${clipsMissing.length}  ${clipsMissing.length === 0 ? 'OK' : 'FAIL'}`);
console.log(`3. per-user owned >= atlas count: mismatches=${perUserMismatch}  ${perUserMismatch === 0 ? 'OK' : 'FAIL'}`);
console.log(`4. email->mongoId resolvable (sample 5): ${sampleEmails.filter((e) => emailToId.has(e)).length}/5`);
console.log(`5. private among ALL experiments: ${privateCount}  ${privateCount === 0 ? 'OK' : 'WARN (owners 403 pre-claim)'}`);
console.log(`6. recordings w/ frames (sample 30 of ${recRef.length}): ${recWithFrames}/30`);
if (clipsMissing.length) console.log(`   missing clip examples: ${clipsMissing.slice(0, 8).map((c) => oid(c._id)).join(', ')}`);
process.exit(0);
