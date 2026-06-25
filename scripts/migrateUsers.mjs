// Phase 1: migrate Atlas users (+ profile avatars) -> users/{mongoId} + usersPublic/{mongoId}.
// DRY-RUN by default; WRITE=true to persist. Idempotent (merge; never overwrites authUid).
//   node scripts/migrateUsers.mjs                 # dry run
//   WRITE=true node scripts/migrateUsers.mjs      # write
import { connectAtlas, getFb, mapUser, oid, normEmail } from './migrationLib.mjs';

const WRITE = process.env.WRITE === 'true';
const { db } = getFb();
const { client, db: m } = await connectAtlas();

// avatars: owner(mongoId) -> latest avatar (sort by createdAt so it's deterministic)
const profiles = await m.collection('profiles').find({}, { projection: { avatar: 1, owner: 1, createdAt: 1 } }).toArray();
profiles.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
const avatarByOwner = new Map();
for (const p of profiles) if (p.owner && p.avatar) avatarByOwner.set(oid(p.owner), p.avatar);

const users = await m.collection('users').find({}).toArray();
await client.close();

let written = 0,
  skippedExisting = 0,
  blankEmail = 0;
const seenEmail = new Map();
const collisions = [];

for (const u of users) {
  const email = normEmail(u.email);
  if (!email) blankEmail++;
  if (email) {
    if (seenEmail.has(email)) collisions.push({ email, ids: [seenEmail.get(email), oid(u._id)] });
    else seenEmail.set(email, oid(u._id));
  }
  const { docId, userDoc, publicDoc } = mapUser(u, avatarByOwner.get(oid(u._id)));

  const existing = await db.doc(`users/${docId}`).get();
  if (existing.exists) {
    // Reconcile only: ensure email is normalized; never touch authUid or overwrite role/createdAt.
    skippedExisting++;
    if (WRITE && normEmail(existing.data().email) !== email && email) {
      await db.doc(`users/${docId}`).set({ email, emailRaw: u.email ?? null }, { merge: true });
    }
    continue;
  }
  if (WRITE) {
    await db.doc(`users/${docId}`).set(userDoc, { merge: true });
    await db.doc(`usersPublic/${docId}`).set(publicDoc, { merge: true });
  }
  written++;
}

console.log('\n==== migrateUsers SUMMARY ====');
console.log(`mode: ${WRITE ? 'WRITE' : 'DRY RUN'}`);
console.log(`atlas users: ${users.length}`);
console.log(`  to write (new): ${written}`);
console.log(`  already in FB (reconcile-only): ${skippedExisting}`);
console.log(`  blank email (cannot reclaim via login): ${blankEmail}`);
console.log(`  normalized-email collisions: ${collisions.length}`);
for (const c of collisions.slice(0, 10)) console.log(`     ${c.email}: ${c.ids.join(' , ')}`);
process.exit(0);
