// One-off migration for the public-profile feature (run once, before deploying the new
// homepage query). Safe to re-run at ANY time, including after launch:
//
//   1. experiments: SYSTEM-owned visibility:'public' docs get featured:true, so the homepage
//      (which now lists `featured`) keeps its current showcase content. Deliberately limited
//      to ownerId=='system' — once the feature is live, users self-publish with
//      visibility:'public', and flagging those would push user content onto the homepage.
//      Non-system public docs are only REPORTED, for a manual `feature.mjs add` decision.
//   2. usersPublic: copy users/{id}.createdAt into usersPublic/{id}.createdAt (the profile
//      page's "Joined" date). Missing usersPublic docs are created with it; docs that
//      already carry createdAt are left alone. New sign-ups get it from onUserSignIn.
//
//   node scripts/backfillProfileFeature.mjs          (uses ./serviceAccount.json)
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

// -- 1. featured backfill (system showcases only) -----------------------------
const publicSnap = await db.collection('experiments').where('visibility', '==', 'public').get();
let featured = 0;
const nonSystem = [];
for (const d of publicSnap.docs) {
  if (d.data().ownerId !== 'system') {
    nonSystem.push(d);
    continue;
  }
  if (d.data().featured !== true) {
    await d.ref.set({ featured: true }, { merge: true });
    featured++;
  }
}
console.log(`experiments: ${publicSnap.size} public, ${featured} system showcases newly flagged featured`);
if (nonSystem.length) {
  console.log(`  ${nonSystem.length} non-system public experiments NOT flagged (feature manually if wanted):`);
  for (const d of nonSystem) {
    console.log(`    ${d.id}  ${d.data().displayName ?? ''}  (owner ${d.data().ownerId})`);
  }
}

// -- 2. usersPublic.createdAt backfill ---------------------------------------
const usersSnap = await db.collection('users').get();
let stamped = 0;
let skipped = 0;
for (const d of usersSnap.docs) {
  const createdAt = d.data().createdAt;
  if (!createdAt) {
    skipped++;
    continue; // migrated doc without a join date — nothing truthful to copy
  }
  const pubRef = db.doc(`usersPublic/${d.id}`);
  const pub = await pubRef.get();
  if (pub.exists && pub.data().createdAt) continue; // already stamped — don't clobber
  await pubRef.set({ createdAt }, { merge: true });
  stamped++;
}
console.log(`usersPublic: ${stamped} joined-dates stamped, ${skipped} users had no createdAt`);
process.exit(0);
