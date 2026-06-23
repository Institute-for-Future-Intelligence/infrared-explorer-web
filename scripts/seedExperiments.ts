/**
 * One-off seed script: merge db/showcases.json (video) + db/staffpicks.json (recording)
 * into the top-level Firestore `experiments` collection (ownerId:'system', visibility:'public').
 *
 * Run against the EMULATOR (no credentials needed):
 *   firebase emulators:start            # in another terminal
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run seed
 *
 * Run against PRODUCTION (needs a service-account key):
 *   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json npm run seed
 *
 * See docs/telelab-migration.md §7. This writes metadata only; the matching Storage
 * objects (videostore/*, recordings/<id>/data_N.*) must already exist for playback.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'infrared-explorer';
const useEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;

initializeApp(useEmulator ? { projectId: PROJECT_ID } : { projectId: PROJECT_ID, credential: applicationDefault() });
const db = getFirestore();

interface RawShowcase {
  name: string;
  id: string;
  display_name: string;
  author?: string;
  description?: string;
  subject?: string;
  duration?: number;
  date?: string;
  currentFrameNumber?: number;
}

function readJson(rel: string): RawShowcase[] {
  return JSON.parse(readFileSync(resolve(here, '..', rel), 'utf8'));
}

function baseDoc(r: RawShowcase) {
  return {
    displayName: r.display_name,
    author: r.author ?? '',
    description: r.description ?? '',
    subject: r.subject ?? 'not available',
    duration: r.duration ?? 0,
    date: r.date ?? '',
    ownerId: 'system',
    visibility: 'public',
    trash: false,
    isRaw: true, // untrimmed source clip
    segments: null,
    graphsOptions: [1] as number[], // default: time plot T(t), matching legacy showcase behavior
    thermalUnit: 'celsius',
    ratingSum: 0,
    ratingCount: 0,
    viewCount: 0,
    commentCount: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

type SeedDoc = { id: string; data: Record<string, unknown> };

function buildDocs(): SeedDoc[] {
  const docs: SeedDoc[] = [];

  // Video showcases — media lives in videostore/<name>.{mp4,vir,wrk,png}.
  for (const r of readJson('db/showcases.json')) {
    docs.push({
      id: r.id,
      data: { ...baseDoc(r), sourceType: 'video', name: r.name, thumbnailURL: `videostore/${r.name}.png` },
    });
  }

  // Staff picks (recording-sourced) are intentionally NOT seeded: their frame data
  // (recordings/{recordingId}/data_N.*) was never migrated to Firebase Storage, so the
  // cards 404 and can't play. Re-enable this block once the recordings are uploaded.
  // See docs/telelab-migration.md §3/§7 and scripts/removeStaffpicks.ts.
  //
  // for (const r of readJson('db/staffpicks.json')) {
  //   const expId = r.id.replace(/^clip\//, ''); // '/' is illegal in a doc id
  //   const recordingId = r.name;
  //   docs.push({
  //     id: expId,
  //     data: {
  //       ...baseDoc(r),
  //       sourceType: 'recording',
  //       recordingId,
  //       thumbnailURL: `recordings/${recordingId}/data_1.png`,
  //     },
  //   });
  // }

  return docs;
}

async function seed() {
  const docs = buildDocs();
  const CHUNK = 400; // Firestore batch limit is 500
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + CHUNK)) {
      batch.set(db.doc(`experiments/${d.id}`), d.data, { merge: true });
    }
    await batch.commit();
  }
  console.log(`Seeded ${docs.length} experiments into "${PROJECT_ID}"${useEmulator ? ' (emulator)' : ''}.`);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
