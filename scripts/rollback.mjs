// Rollback the full migration. Targets ONLY docs this migration created, via the
// `migratedSource` markers ('atlas-users' / 'atlas-clips') — so the original 3 users,
// the 88 pre-existing clips, and the 49 showcases are NEVER touched.
// DRY-RUN by default.
//   node scripts/rollback.mjs --phase=clips           # dry run
//   WRITE=true node scripts/rollback.mjs --phase=clips
//   WRITE=true node scripts/rollback.mjs --phase=users
//   WRITE=true node scripts/rollback.mjs --phase=all
import { getFb } from './migrationLib.mjs';

const WRITE = process.env.WRITE === 'true';
const phaseArg = (process.argv.find((a) => a.startsWith('--phase=')) || '--phase=all').split('=')[1];
const { db } = getFb();

async function rollbackClips() {
  const snap = await db.collection('experiments').where('migratedSource', '==', 'atlas-clips').get();
  console.log(`experiments migratedSource=atlas-clips: ${snap.size}`);
  let n = 0;
  for (const d of snap.docs) {
    if (WRITE) await db.recursiveDelete(d.ref); // removes subcollections too
    n++;
  }
  console.log(`  ${WRITE ? 'deleted' : 'would delete'}: ${n}`);
}

async function rollbackUsers() {
  const us = await db.collection('users').where('migratedSource', '==', 'atlas-users').get();
  console.log(`users migratedSource=atlas-users: ${us.size}`);
  let n = 0;
  for (const d of us.docs) {
    // NOTE: if this user logged in during the window, a custom claim persists in Auth and is
    // NOT removed here. Clear it manually: admin.auth().setCustomUserClaims(authUid, null).
    const authUid = d.data().authUid;
    if (WRITE) {
      await db.recursiveDelete(d.ref); // users/{id} + history/notifications
      await db.doc(`usersPublic/${d.id}`).delete().catch(() => {});
      if (authUid) await db.doc(`uidMap/${authUid}`).delete().catch(() => {});
    }
    n++;
  }
  console.log(`  ${WRITE ? 'deleted' : 'would delete'}: ${n}  (clear Auth claims for any authUid manually)`);
}

console.log(`mode: ${WRITE ? 'WRITE' : 'DRY RUN'}  phase: ${phaseArg}`);
if (phaseArg === 'clips' || phaseArg === 'all') await rollbackClips();
if (phaseArg === 'users' || phaseArg === 'all') await rollbackUsers();
process.exit(0);
