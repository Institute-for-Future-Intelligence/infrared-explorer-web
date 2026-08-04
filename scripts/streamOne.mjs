// One-shot Option-C test: take ONE legacy street-view mp4, re-encode it ALL-INTRA
// (every frame a keyframe) so ExoPlayer can stream + seek it cheaply, upload to
// Firebase Storage (public-read streetviews/** path), and stamp `streamUrl` on the
// doc. The re-encode also drops jcodec's ExoPlayer-hostile moov/meta box for free.
//
//   node scripts/streamOne.mjs us-ma-boston-isv-public-garden-02 [--gop N]
//
// --gop N sets the keyframe interval (default 1 = all-intra). Larger = smaller
// file but pricier seeks.
import {readFileSync, writeFileSync, statSync, createWriteStream} from 'node:fs';
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
const svId = process.argv[2] || 'us-ma-boston-isv-public-garden-02';
const gopArg = process.argv.find(a => a.startsWith('--gop='));
const gop = gopArg ? parseInt(gopArg.split('=')[1], 10) : 1;
// Tail padding: clone the last frame for this many seconds so the REAL content
// (esp. the last frames of the sweep) never sits within ExoPlayer's near-EOS
// zone, where paused seek-preview frames render ~1 s late. The app maps
// frame→time using the stored CONTENT duration, never the padded total, so the
// pad is invisible to look-around.
const PAD_SEC = 8;

const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
initializeApp({credential: cert(sa), storageBucket: BUCKET});
const db = getFirestore();
const bucket = getStorage().bucket();

const mb = n => (n / (1024 * 1024)).toFixed(2) + ' MB';

async function main() {
  const ref = db.collection('streetviews').doc(svId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`no doc streetviews/${svId}`);
  const virUrl = snap.data().virUrl;
  const mp4Url = virUrl.replace(/\.vir$/i, '.mp4');
  console.log('source mp4:', mp4Url);

  const src = join(tmpdir(), `${svId}.src.mp4`);
  const out = join(tmpdir(), `${svId}.intra.mp4`);

  // 1) download source
  const r = await fetch(mp4Url);
  if (!r.ok) throw new Error(`mp4 HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(src));
  console.log('downloaded src:', mb(statSync(src).size));

  // probe the CONTENT duration (before padding) — the app maps frame→time to this.
  // `ffmpeg -i <in>` with no output exits non-zero and prints the info to stderr.
  let contentSec = 0;
  try {
    execFileSync(ffmpegPath, ['-hide_banner', '-i', src], {encoding: 'utf8'});
  } catch (e) {
    const m = String(e.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (m) contentSec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  }
  if (!contentSec) throw new Error('could not probe content duration');
  console.log('content duration:', contentSec, 's');

  // 2) re-encode all-intra (gop=1) + tail-pad (clone last frame PAD_SEC), faststart, no audio
  execFileSync(
    ffmpegPath,
    [
      '-y', '-i', src,
      '-an',
      '-vf', `tpad=stop_mode=clone:stop_duration=${PAD_SEC}`,
      '-c:v', 'libx264',
      '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
      '-crf', '22', '-preset', 'medium', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      out,
    ],
    {stdio: ['ignore', 'ignore', 'inherit']},
  );
  console.log(`re-encoded (gop=${gop}, +${PAD_SEC}s pad):`, mb(statSync(out).size));

  // 3) upload to the public-read streetviews path
  const dest = `streetviews/${svId}/stream.mp4`;
  await bucket.upload(out, {
    destination: dest,
    metadata: {contentType: 'video/mp4', cacheControl: 'public, max-age=31536000'},
  });
  const streamUrl =
    `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/` +
    encodeURIComponent(dest) + '?alt=media';
  console.log('uploaded →', streamUrl);

  // 4) stamp the doc: the stream URL + the CONTENT duration (pre-pad) the app
  // maps frame→time to.
  await ref.update({streamUrl, videoDurationSec: contentSec});
  console.log('doc updated: streamUrl + videoDurationSec', contentSec);

  // 5) sanity: range request
  const probe = await fetch(streamUrl, {headers: {Range: 'bytes=0-1'}});
  console.log('range check:', probe.status, probe.headers.get('content-type'),
    'content-range:', probe.headers.get('content-range'));
}

main().then(() => process.exit(0)).catch(e => {console.error('ERR', e); process.exit(1);});
