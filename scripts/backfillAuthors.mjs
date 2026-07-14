// One-off migration for profile phase 2 (M1): normalize the denormalized `author` string on
// every non-system experiment to the owner's CURRENT usersPublic.displayName — i.e. the name
// their profile/header already shows. Fixes three kinds of drift: Atlas-migration names, mobile
// uploads that stamped the device's local username, and renames made before updateUserProfile()
// fanned the change out.
//
// The source of truth is deliberately usersPublic.displayName (the displayed name), NOT a guess
// at some "original" nickname: for a migrated user whose usersPublic was overwritten by their
// Google name on an early sign-in, that Google name IS what everyone now sees, so making author
// match it is correct/consistent. The onUserSignIn fix only prevents FUTURE overwrites; it does
// not un-overwrite past ones, so there is no ordering dependency on deploying it first (running
// this before or after that deploy yields the same authors). A user who wants a different name
// simply sets it in Settings, which re-fans-out. `updatedAt` is deliberately not touched
// (a backfill must not float clips to the top of "Recently updated").
//
// Idempotent and safe to re-run.
//   node scripts/backfillAuthors.mjs            (uses ./serviceAccount.json)
//   node scripts/backfillAuthors.mjs --dry-run  (report only, write nothing)
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const dryRun = process.argv.includes('--dry-run');
const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

// displayName per owner, resolved once. null = no usable name (skip that owner's docs).
const nameCache = new Map();
async function ownerDisplayName(ownerId) {
  if (nameCache.has(ownerId)) return nameCache.get(ownerId);
  const snap = await db.doc(`usersPublic/${ownerId}`).get();
  const name = snap.exists ? (snap.data().displayName ?? null) : null;
  const usable = typeof name === 'string' && name.trim() !== '' ? name : null;
  nameCache.set(ownerId, usable);
  return usable;
}

const snap = await db.collection('experiments').get();
let updated = 0;
let alreadyCorrect = 0;
const skippedOwners = new Set();

const BATCH_LIMIT = 450;
let batch = db.batch();
let pending = 0;
const flush = async () => {
  if (pending === 0) return;
  if (!dryRun) await batch.commit();
  batch = db.batch();
  pending = 0;
};

for (const d of snap.docs) {
  const { ownerId, author } = d.data();
  if (!ownerId || ownerId === 'system') continue;
  const name = await ownerDisplayName(ownerId);
  if (name === null) {
    skippedOwners.add(ownerId);
    continue;
  }
  if (author === name) {
    alreadyCorrect++;
    continue;
  }
  batch.update(d.ref, { author: name });
  pending++;
  updated++;
  if (pending >= BATCH_LIMIT) await flush();
}
await flush();

console.log(
  `${dryRun ? '[dry-run] would update' : 'updated'} ${updated} experiments; ` +
    `${alreadyCorrect} already correct; ${snap.size} scanned`,
);
if (skippedOwners.size) {
  console.log(`skipped ${skippedOwners.size} owners with no usable usersPublic.displayName:`);
  for (const id of skippedOwners) console.log(`  ${id}`);
}
process.exit(0);
