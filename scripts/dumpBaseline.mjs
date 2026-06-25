// Export the current Firebase state (experiments + subcollections, users, usersPublic) to a
// local JSON file as a ROLLBACK BASELINE. Read-only. Run before any WRITE phase.
//   node scripts/dumpBaseline.mjs            # writes scripts/.baseline/baseline-<date>.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { getFb } from './migrationLib.mjs';

const { db } = getFb();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync('scripts/.baseline', { recursive: true });
const outPath = `scripts/.baseline/baseline-${stamp}.json`;

async function dumpCol(path) {
  const snap = await db.collection(path).get();
  const docs = {};
  for (const d of snap.docs) {
    docs[d.id] = d.data();
    for (const sub of ['thermometers', 'comments', 'ratings', 'annotations']) {
      const ss = await d.ref.collection(sub).get();
      if (!ss.empty) {
        docs[d.id][`__${sub}`] = {};
        ss.forEach((s) => (docs[d.id][`__${sub}`][s.id] = s.data()));
      }
    }
  }
  return docs;
}

console.log('Dumping baseline (read-only)...');
const baseline = {
  takenAt: stamp,
  experiments: await dumpCol('experiments'),
  users: Object.fromEntries((await db.collection('users').get()).docs.map((d) => [d.id, d.data()])),
  usersPublic: Object.fromEntries((await db.collection('usersPublic').get()).docs.map((d) => [d.id, d.data()])),
};
writeFileSync(outPath, JSON.stringify(baseline, null, 0));
console.log(
  `Baseline saved: ${outPath}\n  experiments=${Object.keys(baseline.experiments).length}  users=${Object.keys(baseline.users).length}  usersPublic=${Object.keys(baseline.usersPublic).length}`,
);
process.exit(0);
