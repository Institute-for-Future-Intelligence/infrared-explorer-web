// Fix migrated users whose Firestore `createdAt` is the migration time ("today") instead of the
// real signup time. Cause: early Atlas users predate the Mongoose `timestamps` schema option, so
// they have no `createdAt`; migrateUsers fell back to serverTimestamp(). Their ObjectId still
// encodes the true creation time, so we recover it from there.
//
// DRY-RUN by default; WRITE=true to persist. Idempotent (re-running after a write is a no-op).
//   ATLAS_URI='mongodb+srv://...' node scripts/patchUserCreatedAt.mjs                # dry run
//   ATLAS_URI='mongodb+srv://...' WRITE=true node scripts/patchUserCreatedAt.mjs     # write
import { connectAtlas, getFb, oid, oidDate, toTimestamp } from './migrationLib.mjs';

const WRITE = process.env.WRITE === 'true';
const DAY_MS = 24 * 60 * 60 * 1000;

const { db } = getFb();
const { client, db: m } = await connectAtlas();
// Source of truth for "which users are affected": those Atlas users with no usable createdAt
// (field absent OR explicitly null) — the same set migrateUsers fell back to serverTimestamp() for.
const affected = await m
  .collection('users')
  .find({ $or: [{ createdAt: { $exists: false } }, { createdAt: null }] }, { projection: { _id: 1, email: 1 } })
  .toArray();
await client.close();

let patched = 0,
  alreadyOk = 0,
  noObjectIdDate = 0,
  missingDoc = 0,
  skippedNotSynthetic = 0;
const examples = [];

for (const u of affected) {
  const id = oid(u._id);
  const realDate = oidDate(u._id);
  if (!realDate) {
    noObjectIdDate++;
    continue;
  }
  const realTs = toTimestamp(realDate);
  const realMs = realDate.getTime();

  const snap = await db.doc(`users/${id}`).get();
  if (!snap.exists) {
    missingDoc++;
    continue;
  }
  const cur = snap.data().createdAt;
  const curMs = cur?.toMillis?.() ?? null;

  // Already corrected (within a day of the ObjectId time): idempotent no-op.
  if (curMs != null && Math.abs(curMs - realMs) <= DAY_MS) {
    alreadyOk++;
    continue;
  }
  // Safety: only overwrite a value that is clearly synthetic (much LATER than the real signup,
  // i.e. the migration date). Never clobber a plausible earlier date we didn't expect.
  if (curMs != null && curMs - realMs <= DAY_MS) {
    skippedNotSynthetic++;
    continue;
  }

  if (examples.length < 10) {
    examples.push({ id, email: u.email, from: curMs ? new Date(curMs).toISOString() : null, to: realDate.toISOString() });
  }
  if (WRITE) {
    await db.doc(`users/${id}`).set(
      { createdAt: realTs, createdAtSource: 'objectId', createdAtPatchedAt: getFb().FieldValue.serverTimestamp() },
      { merge: true },
    );
  }
  patched++;
}

console.log('\n==== patchUserCreatedAt SUMMARY ====');
console.log(`mode: ${WRITE ? 'WRITE' : 'DRY RUN'}`);
console.log(`atlas users missing createdAt:        ${affected.length}`);
console.log(`  ${WRITE ? 'patched' : 'would patch'} (synthetic -> ObjectId time): ${patched}`);
console.log(`  already correct (idempotent skip):  ${alreadyOk}`);
console.log(`  skipped (not synthetic):            ${skippedNotSynthetic}`);
console.log(`  no Firestore doc:                   ${missingDoc}`);
console.log(`  no derivable ObjectId date:         ${noObjectIdDate}`);
if (examples.length) {
  console.log('\n-- examples --');
  for (const e of examples) console.log(`   ${e.id}  ${e.email}  ${e.from} -> ${e.to}`);
}
process.exit(0);
