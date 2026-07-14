/**
 * Seed a SYNTHETIC thermal recording into the Firebase EMULATOR so the web analyzer
 * can play it end-to-end WITHOUT a FLIR device — an executable parity test that the
 * mobile app's data_N.dat/.png byte format + experiment-doc shape are opened correctly
 * by the REAL web reader. It imports the app's own contract modules
 * (infrared-explorer-app/src/lib/*), so a green playback proves those encoders match
 * this repo's temperatureReader/ImagePlayer.
 *
 * Prereqs — three terminals in infrared-explorer-web:
 *   1) npm run emulators
 *   2) FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 STORAGE_EMULATOR_HOST=127.0.0.1:9199 \
 *        npx tsx scripts/seedRecording.ts
 *   3) VITE_USE_EMULATORS=true npm start   # then open the /experiments/<id> URL it prints
 *
 * SAFETY: refuses to run unless BOTH emulator hosts are set — it never touches production.
 *
 * The experiment is seeded 'unlisted', which the security rules let anyone READ by direct
 * link, so no sign-in is needed to open it. Add a thermometer on the moving hot spot and
 * confirm it reads ~22 C background rising to ~80 C at the centre.
 */
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { deflateSync } from 'node:zlib';
import {
  IR_ARRAY_HEIGHT,
  IR_ARRAY_WIDTH,
  durationSecondsFromFrames,
  packDatFrame,
  usedFrameCount,
} from '../../infrared-explorer-app/src/lib/recordingFormat';
import { buildRecordingExperimentDoc } from '../../infrared-explorer-app/src/lib/experimentDoc';

// ---- safety: emulator-only -------------------------------------------------
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const STORAGE_HOST = process.env.STORAGE_EMULATOR_HOST;
if (!FIRESTORE_HOST || !STORAGE_HOST) {
  console.error(
    'Refusing to run: set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 and ' +
      'STORAGE_EMULATOR_HOST=127.0.0.1:9199 first (this script is emulator-only).',
  );
  process.exit(1);
}

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'infrared-explorer';
const BUCKET = process.env.STORAGE_BUCKET ?? `${PROJECT_ID}.appspot.com`;
const FRAMES = 25; // 5 s at 5 fps (must be a whole number of seconds' worth)
const OWNER = 'seed-mongoid-emulator';

// ---- synthetic scene: a hot spot drifting left->right on a 22 C background ---
const W = IR_ARRAY_WIDTH;
const H = IR_ARRAY_HEIGHT;
const TEMP_MIN = 20;
const TEMP_MAX = 85;

function frameField(n: number, total: number): Float32Array {
  const f = new Float32Array(W * H);
  const cx = W * (0.2 + (0.6 * (n - 1)) / Math.max(1, total - 1));
  const cy = H * 0.5;
  const sigma = 12;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      f[y * W + x] = 22 + 60 * Math.exp(-d2 / (2 * sigma * sigma));
    }
  }
  return f;
}

// ---- minimal 8-bit grayscale PNG encoder (no deps) --------------------------
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodeGrayPng(field: Float32Array): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type 0 = grayscale
  const raw = Buffer.alloc(H * (W + 1));
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      let g = Math.round(((field[y * W + x] - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)) * 255);
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      raw[p++] = g;
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- seed ------------------------------------------------------------------
async function seed() {
  initializeApp({ projectId: PROJECT_ID, storageBucket: BUCKET });
  const db = getFirestore();
  const bucket = getStorage().bucket();

  const recordingId = `rec-emu-${Date.now().toString(36)}`;
  const usedFrames = usedFrameCount(FRAMES);
  const duration = durationSecondsFromFrames(usedFrames);

  for (let n = 1; n <= usedFrames; n++) {
    const field = frameField(n, usedFrames);
    await bucket
      .file(`recordings/${recordingId}/data_${n}.dat`)
      .save(Buffer.from(deflateSync(packDatFrame(field))), { contentType: 'application/octet-stream' });
    await bucket
      .file(`recordings/${recordingId}/data_${n}.png`)
      .save(encodeGrayPng(field), { contentType: 'image/png' });
  }

  const thumbnailURL =
    `http://${STORAGE_HOST}/v0/b/${BUCKET}/o/` +
    encodeURIComponent(`recordings/${recordingId}/data_1.png`) +
    '?alt=media';

  const doc = buildRecordingExperimentDoc(
    {
      recordingId,
      ownerId: OWNER,
      displayName: 'Synthetic hot spot (emulator test)',
      author: 'seedRecording',
      description: 'Drifting Gaussian hot spot, 22 C background rising to ~80 C. Format parity test.',
      subject: 'physics',
      durationSeconds: duration,
      thumbnailURL,
      thermalUnit: 'celsius',
      visibility: 'unlisted',
    },
    FieldValue.serverTimestamp(),
  );

  const ref = await db.collection('experiments').add(doc);

  // Public profile slice for the seed owner, so /users/<OWNER> renders in the emulator. The
  // seeded experiment is 'unlisted', so the visitor view starts empty — flip it to Public from
  // a card's ⋮ menu (signed in as the owner) or seed more docs to exercise the tabs.
  await db.doc(`usersPublic/${OWNER}`).set(
    {
      displayName: 'Seed User',
      bio: 'Synthetic emulator account for profile-page testing.',
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  console.log(`Seeded recording ${recordingId} (${usedFrames} frames, ${duration}s) into "${PROJECT_ID}" emulator.`);
  console.log(`Open in the dev server (VITE_USE_EMULATORS=true npm start):`);
  console.log(`  /experiments/${ref.id}`);
  console.log(`  /users/${OWNER}   (the seed owner's profile page)`);
  console.log(`Add a thermometer on the bright spot: it should read ~22 C edge -> ~80 C centre.`);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
