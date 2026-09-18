// Bake app-uploaded street views into all-intra streams — the backfill / redo companion of
// the onStreetViewCreated Cloud Function (functions/src/streetViewBake.ts, which this runs
// unchanged). New uploads are baked by the function on their own; this is for the ones
// that predate it, for re-baking after a recipe change, and for looking at the encode
// before trusting it. See docs/street-view-bake.md.
//
//   npm --prefix functions run build            (once — the module is compiled TypeScript)
//   node scripts/bakeStreetViews.mjs --id=<svId>              bake one upload
//   node scripts/bakeStreetViews.mjs --all [--limit=N]        every upload not yet baked
//   node scripts/bakeStreetViews.mjs --id=<svId> --out=<dir>  encode only: streams land in
//                                                             <dir>, Storage and the doc
//                                                             are not touched
//   --redo   re-bake even when the doc is already at the current bake version
//   --dry    decide and report only
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { bakeDecision, bakeStreetView } from '../functions/lib/streetViewBake.js';

const BUCKET = 'infrared-explorer.appspot.com';
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

const ID = arg('id');
const ALL = flag('all');
const LIMIT = arg('limit') ? parseInt(arg('limit'), 10) : Infinity;
const OUT = arg('out');
const REDO = flag('redo');
const DRY = flag('dry');

if (!ID && !ALL) {
  console.error('usage: node scripts/bakeStreetViews.mjs --id=<svId> | --all [--limit=N] [--out=<dir>] [--redo] [--dry]');
  process.exit(2);
}
if (!ffmpegPath) throw new Error('ffmpeg-static has no binary for this platform');

const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
initializeApp({ credential: cert(sa), storageBucket: BUCKET });
const db = getFirestore();
const bucket = getStorage().bucket();

async function candidates() {
  if (ID) return [ID];
  // Every non-seeded panorama; the bake decides per doc what still needs doing.
  const snap = await db.collection('streetviews').where('ownerId', '!=', 'system').get();
  const ids = [];
  for (const d of snap.docs) {
    const decision = bakeDecision(d.data(), { redo: REDO });
    if (decision.bake) ids.push(d.id);
    else console.log(`${d.id}: skip (${decision.reason})`);
  }
  return ids.slice(0, LIMIT);
}

async function main() {
  const ids = await candidates();
  console.log(`${ids.length} to bake${DRY ? ' (dry run)' : ''}${OUT ? `, encode only → ${resolve(OUT)}` : ''}`);
  let ok = 0;
  let fail = 0;
  for (const svId of ids) {
    if (DRY) {
      const snap = await db.doc(`streetviews/${svId}`).get();
      console.log(`${svId}: ${JSON.stringify(bakeDecision(snap.data(), { redo: REDO }))} "${snap.data()?.displayName ?? ''}"`);
      continue;
    }
    let workDir;
    if (OUT) {
      workDir = resolve(OUT, svId);
      mkdirSync(workDir, { recursive: true });
    }
    try {
      const t0 = Date.now();
      const result = await bakeStreetView(
        svId,
        { db, bucket, ffmpegPath, workDir, log: (line) => console.log('  ' + line) },
        { redo: REDO, localOnly: !!OUT },
      );
      ok += 1;
      if ('baked' in result) {
        const tracks = result.baked.map((b) => `${b.track}=${(b.bytes / 1048576).toFixed(1)}MB`).join(' ');
        console.log(`${svId}: OK ${result.frameCount} frames ${tracks} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      } else {
        console.log(`${svId}: nothing to do (${result.skippedReason})`);
      }
    } catch (e) {
      fail += 1;
      console.log(`${svId}: FAIL ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`DONE ok=${ok} fail=${fail}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
