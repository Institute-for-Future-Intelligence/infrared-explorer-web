// Full rollout of the Option-C stream for EVERY public street view: re-encode
// each legacy clip ALL-INTRA (+ tail pad), upload to Firebase Storage, and stamp
// `streamUrl` + `videoDurationSec` on the doc. Idempotent + resumable: any doc
// that already has `streamUrl` is skipped, so a re-run continues where it left
// off. A single clip's failure (e.g. a 404 source) is logged and skipped.
//
//   node scripts/streamAll.mjs [--limit=N] [--redo]
//     --limit=N  process at most N pending docs (smoke test)
//     --redo     re-process even docs that already have streamUrl
import {readFileSync, statSync, createWriteStream, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import ffmpegPath from 'ffmpeg-static';
import {initializeApp, cert} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {getStorage} from 'firebase-admin/storage';

const BUCKET = 'infrared-explorer.appspot.com';
const PAD_SEC = 8;
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;
const REDO = process.argv.includes('--redo');

const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
initializeApp({credential: cert(sa), storageBucket: BUCKET});
const db = getFirestore();
const bucket = getStorage().bucket();
const mb = n => (n / (1024 * 1024)).toFixed(1);

function probeContentSec(file) {
  try {
    execFileSync(ffmpegPath, ['-hide_banner', '-i', file], {encoding: 'utf8'});
  } catch (e) {
    const m = String(e.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  }
  return 0;
}

async function processOne(id, virUrl) {
  const mp4Url = virUrl.replace(/\.vir$/i, '.mp4');
  const src = join(tmpdir(), `sv_${id}.src.mp4`);
  const out = join(tmpdir(), `sv_${id}.intra.mp4`);
  try {
    const r = await fetch(mp4Url);
    if (!r.ok) throw new Error(`mp4 HTTP ${r.status}`);
    await pipeline(Readable.fromWeb(r.body), createWriteStream(src));
    const contentSec = probeContentSec(src);
    if (!contentSec) throw new Error('no duration');
    execFileSync(
      ffmpegPath,
      [
        '-y', '-i', src, '-an',
        '-vf', `tpad=stop_mode=clone:stop_duration=${PAD_SEC}`,
        '-c:v', 'libx264', '-g', '1', '-keyint_min', '1', '-sc_threshold', '0',
        '-crf', '22', '-preset', 'medium', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', out,
      ],
      {stdio: ['ignore', 'ignore', 'ignore']},
    );
    const dest = `streetviews/${id}/stream.mp4`;
    await bucket.upload(out, {
      destination: dest,
      metadata: {contentType: 'video/mp4', cacheControl: 'public, max-age=31536000'},
    });
    const streamUrl =
      `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/` +
      encodeURIComponent(dest) + '?alt=media';
    await db.collection('streetviews').doc(id).update({streamUrl, videoDurationSec: contentSec});
    const size = mb(statSync(out).size);
    return {ok: true, size, contentSec};
  } finally {
    for (const f of [src, out]) {
      try { rmSync(f); } catch {}
    }
  }
}

async function main() {
  const snap = await db.collection('streetviews')
    .where('visibility', '==', 'public').where('trash', '==', false).get();
  const todo = [];
  snap.forEach(d => {
    const f = d.data();
    if (f.virUrl && (REDO || !f.streamUrl)) todo.push({id: d.id, virUrl: f.virUrl});
  });
  const work = todo.slice(0, LIMIT);
  console.log(`START rollout: ${work.length} to process (of ${snap.size} public)`);
  let ok = 0, fail = 0;
  const failed = [];
  for (let i = 0; i < work.length; i++) {
    const {id, virUrl} = work[i];
    const tag = `[${i + 1}/${work.length}] ${id}`;
    try {
      const res = await processOne(id, virUrl);
      ok++;
      console.log(`${tag} OK ${res.size}MB ${res.contentSec}s`);
    } catch (e) {
      fail++;
      failed.push({id, err: String(e.message || e)});
      console.log(`${tag} FAIL ${String(e.message || e)}`);
    }
  }
  console.log(`DONE: ok=${ok} fail=${fail}`);
  if (failed.length) console.log('FAILED:', JSON.stringify(failed));
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL', e); process.exit(1); });
