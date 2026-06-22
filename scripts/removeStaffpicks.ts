/**
 * One-off cleanup: remove the recording-sourced "staff pick" experiments from Firestore.
 * Their frame data (recordings/{recordingId}/data_N.*) was never migrated to Firebase
 * Storage (it lived on the old telelab server), so they 404 and can't play.
 *
 * Reversible: re-run `npm run seed` after uploading the recordings to Storage to bring
 * them back. See docs/telelab-migration.md §3/§7.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json npx tsx scripts/removeStaffpicks.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'infrared-explorer';
const useEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;

initializeApp(useEmulator ? { projectId: PROJECT_ID } : { projectId: PROJECT_ID, credential: applicationDefault() });
const db = getFirestore();

const staffpicks: Array<{ id: string }> = JSON.parse(readFileSync(resolve(here, '..', 'db/staffpicks.json'), 'utf8'));
const ids = staffpicks.map((r) => r.id.replace(/^clip\//, ''));

async function run() {
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = db.batch();
    for (const id of ids.slice(i, i + CHUNK)) batch.delete(db.doc(`experiments/${id}`));
    await batch.commit();
  }
  console.log(`Removed ${ids.length} recording-sourced staff-pick experiments from "${PROJECT_ID}".`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
