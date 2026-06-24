// Flip existing user clips (and their thermometer/annotation sub-docs) from
// visibility:'private' to 'unlisted', so their shared links open for logged-out viewers.
// This brings already-created data in line with the app's new default (cloneExperiment now
// creates clips as unlisted). Public/system showcases and already-unlisted clips are left
// untouched. The visibility model stays intact for a future per-clip privacy toggle — this
// only changes the *default* for existing data.
//
//   node scripts/makeClipsUnlisted.mjs                # DRY RUN (reads only, writes nothing)
//   WRITE=true node scripts/makeClipsUnlisted.mjs     # actually write
//   ONLY_OWNER=<mongoId>[,<mongoId>...] node ...      # limit to one or more owners (comma-separated)
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const WRITE = process.env.WRITE === 'true';
const ONLY_OWNERS = process.env.ONLY_OWNER
  ? new Set(process.env.ONLY_OWNER.split(',').map((s) => s.trim()).filter(Boolean))
  : null;

const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

// Only private sub-docs need flipping; match the parent clip's new visibility so the
// anonymous viewer query (visibility in [public, unlisted]) returns them.
async function flipSub(expRef, col) {
  const snap = await expRef.collection(col).where('visibility', '==', 'private').get();
  if (WRITE) for (const d of snap.docs) await d.ref.update({ visibility: 'unlisted' });
  return snap.size;
}

const snap = await db.collection('experiments').where('visibility', '==', 'private').get();
let flipped = 0,
  skipped = 0;

for (const ex of snap.docs) {
  const d = ex.data();
  const owner = d.ownerId ?? '?';
  if (ONLY_OWNERS && !ONLY_OWNERS.has(owner)) {
    skipped++;
    continue;
  }
  const expRef = db.doc(`experiments/${ex.id}`);
  const tN = await flipSub(expRef, 'thermometers');
  const aN = await flipSub(expRef, 'annotations');
  // Visibility-only flip — intentionally does NOT bump updatedAt (preserves list ordering).
  if (WRITE) await expRef.update({ visibility: 'unlisted' });
  flipped++;
  console.log(
    `${WRITE ? 'WROTE' : 'PLAN'} ${ex.id} "${(d.displayName ?? '').slice(0, 32)}" owner=${owner} thermo=${tN} annot=${aN}`,
  );
}

console.log('\n==== SUMMARY ====');
console.log(`mode: ${WRITE ? 'WRITE' : 'DRY RUN (no writes)'}`);
console.log(
  `private experiments flipped to unlisted: ${flipped}${ONLY_OWNERS ? ` (skipped ${skipped} from other owners)` : ''}`,
);
process.exit(0);
