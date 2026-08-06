// Bake a WIDE panorama for every public street view: extract the legacy clip's
// frames, place each one into a full-360° equirectangular strip by its per-frame
// azimuth (no computer vision — the azimuth is already in the doc), upload the
// stitched `pano.png` to Firebase Storage, and stamp `panoUrl` + `panoSpanDeg` on
// the doc. The web viewer then prefers this pano (drag-to-pan the whole 360°, wide
// FOV) over the frame-seek video.
//
//   node scripts/stitchAll.mjs [--limit=N] [--redo]
//     --limit=N  process at most N pending docs (smoke test)
//     --redo     re-process even docs that already have panoUrl
//
// Idempotent + resumable: docs that already have `panoUrl` are skipped (unless
// --redo). A single clip's failure is logged and skipped.
//
// How the stitch works (see docs/street-view-web-plan.md §5):
//  - Each frame covers HFOV=43° horizontally, VFOV=55° vertically (FLIR thermal).
//  - The clip is a slow ~360° rotation (near-zero parallax → clean rotational
//    stitch). We build an output column-by-column: for output angle θ (0°=North at
//    x=0), pick the frame whose azimuth is circularly closest to θ and copy the
//    column of that frame that looks at exactly θ. A small per-frame pitch shift
//    keeps the horizon level. Columns with no frame within the camera FOV stay black.
import { readFileSync, writeFileSync, statSync, createWriteStream, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpegPath from 'ffmpeg-static';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const BUCKET = 'infrared-explorer.appspot.com';
const HFOV = 43; // FLIR thermal camera horizontal field of view (deg)
const VFOV = 55; // vertical field of view (deg)
const JPEG_QUALITY = 82; // pano.jpg encode quality (≈0.5–1 MB vs ~6.7 MB PNG)

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;
const REDO = process.argv.includes('--redo');
// --match=<substr>  only process docs whose displayName contains this (case-insensitive),
//                   e.g. --match="Beacon Hill" to bake one neighbourhood for a smoke test.
const matchArg = process.argv.find((a) => a.startsWith('--match='));
const MATCH = matchArg ? matchArg.slice('--match='.length).toLowerCase() : null;
// --feather=<frac>  cross-fade half-width as a fraction of the frame spacing (default
//                   0.5 = fade only across the midpoint between neighbours → sharp).
// --noalign         skip image-based geometric alignment (place purely by azimuth).
const featherArg = process.argv.find((a) => a.startsWith('--feather='));
const FEATHER = featherArg ? Math.max(0.05, parseFloat(featherArg.split('=')[1])) : 0.5;
const ALIGN = !process.argv.includes('--noalign');

const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
initializeApp({ credential: cert(sa), storageBucket: BUCKET });
const db = getFirestore();
const bucket = getStorage().bucket();
const mb = (n) => (n / (1024 * 1024)).toFixed(2);

/** Normalize degrees to (−180, 180]. */
const normDeg = (d) => {
  const x = ((((d + 180) % 360) + 360) % 360) - 180;
  return x === -180 ? 180 : x;
};
const median = (arr) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Read a number[] field defensively. */
function numArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'number' && Number.isFinite(x)) : [];
}

function extractFrames(src, outDir) {
  mkdirSync(outDir, { recursive: true });
  // -vsync 0: emit every decoded frame once, in order (aligned 1:1 with azimuth[]).
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', src, '-vsync', '0', join(outDir, 'f_%05d.png')], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return readdirSync(outDir)
    .filter((f) => /^f_\d+\.png$/.test(f))
    .sort()
    .map((f) => PNG.sync.read(readFileSync(join(outDir, f))));
}

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Per-column vertical-edge energy (horizontal gradient magnitude summed over rows) —
 *  a 1-D signature dominated by vertical structure (buildings, poles, railings), which
 *  registers cleanly under a horizontal (azimuth) shift. */
function columnProfile(frame) {
  const { width: w, height: h, data: d } = frame;
  const prof = new Float64Array(w);
  for (let c = 1; c < w; c++) {
    let s = 0;
    for (let r = 0; r < h; r += 2) {
      const i = (r * w + c) * 4;
      const j = (r * w + c - 1) * 4;
      s += Math.abs(luma(d[i], d[i + 1], d[i + 2]) - luma(d[j], d[j + 1], d[j + 2]));
    }
    prof[c] = s;
  }
  prof[0] = prof[1];
  return prof;
}

/** Best horizontal shift s (B is `s` px to the right of A) maximising the normalised
 *  cross-correlation of the two column profiles over their overlap, searched around
 *  `expected` ± `margin`. Returns {shift, score∈[-1,1]}. */
function bestShift(profA, profB, expected, margin) {
  const w = profA.length;
  let best = expected;
  let bestScore = -Infinity;
  for (let s = expected - margin; s <= expected + margin; s++) {
    const c0 = Math.max(0, s);
    const c1 = Math.min(w - 1, w - 1 + s);
    const n = c1 - c0 + 1;
    if (n < w * 0.3) continue; // require a meaningful overlap
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    for (let c = c0; c <= c1; c++) {
      const a = profA[c];
      const b = profB[c - s];
      sa += a;
      sb += b;
      saa += a * a;
      sbb += b * b;
      sab += a * b;
    }
    const cov = sab - (sa * sb) / n;
    const denom = Math.sqrt(Math.max(1e-9, (saa - (sa * sa) / n) * (sbb - (sb * sb) / n)));
    const score = cov / denom;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return { shift: best, score: bestScore };
}

/** Per-frame pano-x centres from IMAGE registration (corrects magnetometer error):
 *  chain the measured consecutive shifts, anchor frame 0 at its azimuth, and — when the
 *  clip is a clean ~360° sweep — distribute the loop-closure residual so the ends meet.
 *  Falls back to the azimuth-expected shift for any pair that registers poorly. */
function alignCenters(frames, az, pxPerDeg, panoW) {
  const K = frames.length;
  const profs = frames.map(columnProfile);
  const margin = Math.max(4, Math.round(5 * pxPerDeg));
  const MIN_SCORE = 0.25;
  const shifts = new Array(K - 1);
  for (let k = 0; k < K - 1; k++) {
    const expected = Math.round(normDeg(az[k + 1] - az[k]) * pxPerDeg);
    const { shift, score } = bestShift(profs[k], profs[k + 1], expected, margin);
    shifts[k] = score >= MIN_SCORE ? shift : expected;
  }
  // Loop closure (last → first).
  const expW = Math.round(normDeg(az[0] - az[K - 1]) * pxPerDeg);
  const wrap = bestShift(profs[K - 1], profs[0], expW, margin);
  const total = shifts.reduce((a, b) => a + b, 0) + (wrap.score >= MIN_SCORE ? wrap.shift : expW);
  const corr = Math.abs(total - panoW) < 0.35 * panoW && total > 0 ? (panoW - total) / K : 0;
  const cx = new Array(K);
  cx[0] = (((az[0] % 360) + 360) % 360) * pxPerDeg;
  for (let k = 1; k < K; k++) cx[k] = cx[k - 1] + shifts[k - 1] + corr;
  return cx.map((v) => ((v % panoW) + panoW) % panoW);
}

/**
 * Stitch the extracted frames into a full-360° RGBA panorama, with:
 *  - EXPOSURE COMPENSATION: each frame's per-frame AGC bakes a different brightness/
 *    contrast → vertical bands where slices meet. Match every frame's luma mean+std to
 *    the clip median (affine, in-place, hue-preserving) so slices share one exposure.
 *  - GEOMETRIC ALIGNMENT: place each frame by IMAGE cross-correlation (alignCenters),
 *    correcting magnetometer azimuth error so features line up across seams. (--noalign
 *    reverts to pure azimuth placement.)
 *  - NARROW FEATHER: each output column blends only the frames within FEATHER×spacing
 *    px of it (default half the spacing), so aligned frames cross-fade at their midpoint
 *    — seamless but still sharp.
 */
function stitchPano(frames, azimuthDeg, pitchDeg) {
  const K = frames.length;
  const { width: frameW, height: frameH } = frames[0];
  const N = azimuthDeg.length;
  // Align extracted frame k → orientation index (proportional; identity when K===N).
  const at = (arr, k) => (arr.length ? arr[Math.min(arr.length - 1, Math.round((k / Math.max(1, K - 1)) * (N - 1)))] : 0);
  const az = frames.map((_, k) => at(azimuthDeg, k));
  const pit = frames.map((_, k) => at(pitchDeg, k));
  const refPitch = median(pit);

  // ── Exposure compensation (in-place): match each frame's luma mean+std to the
  // clip median, then rescale each RGB pixel toward its new luma (keeps colour). ──
  const means = [];
  const stds = [];
  for (const fr of frames) {
    const d = fr.data;
    const n = fr.width * fr.height;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < d.length; i += 4) {
      const L = luma(d[i], d[i + 1], d[i + 2]);
      s += L;
      s2 += L * L;
    }
    const m = s / n;
    means.push(m);
    stds.push(Math.sqrt(Math.max(1, s2 / n - m * m)));
  }
  const refMean = median(means);
  const refStd = median(stds);
  for (let k = 0; k < K; k++) {
    const d = frames[k].data;
    const m = means[k];
    const g = refStd / stds[k];
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const gg = d[i + 1];
      const b = d[i + 2];
      const L = luma(r, gg, b);
      if (L <= 1) continue;
      const newL = (L - m) * g + refMean;
      const sc = Math.max(0, newL / L);
      d[i] = Math.min(255, Math.round(r * sc));
      d[i + 1] = Math.min(255, Math.round(gg * sc));
      d[i + 2] = Math.min(255, Math.round(b * sc));
    }
  }

  const pxPerDeg = frameW / HFOV;
  const pxPerDegV = frameH / VFOV;
  const panoW = Math.round(360 * pxPerDeg);
  const panoH = frameH;
  const halfFovPx = (HFOV / 2) * pxPerDeg;

  // Per-frame pano-x centre (image-aligned, or azimuth if --noalign / too few frames).
  const cx =
    ALIGN && K >= 2 ? alignCenters(frames, az, pxPerDeg, panoW) : az.map((a) => (((a % 360) + 360) % 360) * pxPerDeg);

  const spacingPx = panoW / Math.max(1, K);
  const blendHalfPx = Math.max(1, spacingPx * FEATHER);

  const out = new PNG({ width: panoW, height: panoH }); // zero-filled = transparent black
  const od = out.data;

  for (let x = 0; x < panoW; x++) {
    // Frames whose FOV covers this column, weighted by proximity (narrow feather);
    // fall back to the nearest in-FOV frame so a sparse arc doesn't punch a hole.
    const contrib = [];
    let nearest = -1;
    let nd = Infinity;
    let nearestD = 0;
    for (let k = 0; k < K; k++) {
      let d = x - cx[k]; // circular offset in pano px
      if (d > panoW / 2) d -= panoW;
      else if (d < -panoW / 2) d += panoW;
      const ad = Math.abs(d);
      if (ad < nd) {
        nd = ad;
        nearest = k;
        nearestD = d;
      }
      if (ad >= halfFovPx) continue;
      const col = Math.round(frameW / 2 + d);
      if (col < 0 || col >= frameW) continue;
      const w = ad < blendHalfPx ? 1 - ad / blendHalfPx : 0;
      if (w <= 0) continue;
      contrib.push({ k, col, w, rowShift: Math.round((pit[k] - refPitch) * pxPerDegV) });
    }
    if (contrib.length === 0 && nearest >= 0) {
      const col = Math.round(frameW / 2 + nearestD);
      if (col >= 0 && col < frameW) {
        contrib.push({ k: nearest, col, w: 1, rowShift: Math.round((pit[nearest] - refPitch) * pxPerDegV) });
      }
    }
    if (contrib.length === 0) continue; // real gap → transparent (shows the viewer's black)

    for (let y = 0; y < panoH; y++) {
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aw = 0;
      for (const c of contrib) {
        const sy = y + c.rowShift;
        if (sy < 0 || sy >= frameH) continue;
        const fr = frames[c.k].data;
        const si = (sy * frameW + c.col) * 4;
        ar += fr[si] * c.w;
        ag += fr[si + 1] * c.w;
        ab += fr[si + 2] * c.w;
        aw += c.w;
      }
      if (aw <= 0) continue;
      const di = (y * panoW + x) * 4;
      od[di] = Math.round(ar / aw);
      od[di + 1] = Math.round(ag / aw);
      od[di + 2] = Math.round(ab / aw);
      od[di + 3] = 255;
    }
  }
  // Also return the geometry so the temperature pano can reuse the SAME alignment.
  return { data: out.data, panoW, panoH, cx, az, pit, refPitch, frameW };
}

// ── Temperature panorama ────────────────────────────────────────────────────
// The legacy `.vir` is the raw thermal track: an 8-byte header (width @ byte 2,
// height @ byte 6, big-endian uint16) then frames back-to-back, each pixel a
// 4-byte record whose big-endian uint16 at +2 is centi-kelvin
// (°C = value/100 − 273.15), row-major. See app src/lib/virImport.ts.
const VIR_HEADER_BYTES = 8;
const INTSIZE = 4;

function decodeVir(buf) {
  if (buf.byteLength < VIR_HEADER_BYTES) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = dv.getUint16(2, false);
  const height = dv.getUint16(6, false);
  const size = width * height;
  if (size === 0) return null;
  const frameCount = Math.floor((buf.byteLength - VIR_HEADER_BYTES) / (size * INTSIZE));
  if (frameCount <= 0) return null;
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    const cel = new Float32Array(size);
    let off = VIR_HEADER_BYTES + f * size * INTSIZE;
    for (let i = 0; i < size; i++) {
      cel[i] = dv.getUint16(off + 2, false) / 100 - 273.15;
      off += INTSIZE;
    }
    frames.push(cel);
  }
  return { width, height, frames };
}

async function fetchVir(virUrl) {
  try {
    const r = await fetch(virUrl);
    if (!r.ok) return null;
    return decodeVir(Buffer.from(await r.arrayBuffer()));
  } catch {
    return null;
  }
}

/**
 * Stitch a temperature panorama aligned to the visual one: reuse the visual
 * per-frame centres `cx` (scaled to the thermal grid), feather-average the
 * per-pixel °C, and encode centi-kelvin losslessly into a PNG's R/G bytes
 * (A=255 valid, A=0 gap). The viewer decodes it for the probe/scale/histogram/
 * isotherm tools. Returns the PNG buffer + dims + global °C range.
 */
function stitchTempPano(tempFrames, tw, th, cx, az, pit, refPitch, visualFrameW) {
  const K = tempFrames.length;
  const scale = tw / visualFrameW;
  const pxPerDeg = tw / HFOV;
  const pxPerDegV = th / VFOV;
  const panoW = Math.round(360 * pxPerDeg);
  const panoH = th;
  const halfFovPx = (HFOV / 2) * pxPerDeg;
  const cxt = cx.map((v) => v * scale);
  const spacingPx = panoW / Math.max(1, K);
  const blendHalfPx = Math.max(1, spacingPx * FEATHER);
  const sum = new Float64Array(panoW * panoH);
  const wsum = new Float64Array(panoW * panoH);

  for (let x = 0; x < panoW; x++) {
    const contrib = [];
    let nearest = -1;
    let nd = Infinity;
    let nearestD = 0;
    for (let k = 0; k < K; k++) {
      let d = x - cxt[k];
      if (d > panoW / 2) d -= panoW;
      else if (d < -panoW / 2) d += panoW;
      const ad = Math.abs(d);
      if (ad < nd) {
        nd = ad;
        nearest = k;
        nearestD = d;
      }
      if (ad >= halfFovPx) continue;
      const col = Math.round(tw / 2 + d);
      if (col < 0 || col >= tw) continue;
      const w = ad < blendHalfPx ? 1 - ad / blendHalfPx : 0;
      if (w <= 0) continue;
      contrib.push({ k, col, w, rowShift: Math.round((pit[k] - refPitch) * pxPerDegV) });
    }
    if (contrib.length === 0 && nearest >= 0) {
      const col = Math.round(tw / 2 + nearestD);
      if (col >= 0 && col < tw) {
        contrib.push({ k: nearest, col, w: 1, rowShift: Math.round((pit[nearest] - refPitch) * pxPerDegV) });
      }
    }
    if (contrib.length === 0) continue;
    for (let y = 0; y < panoH; y++) {
      let s = 0;
      let ws = 0;
      for (const c of contrib) {
        const sy = y + c.rowShift;
        if (sy < 0 || sy >= th) continue;
        const cel = tempFrames[c.k][sy * tw + c.col];
        if (!Number.isFinite(cel)) continue;
        s += cel * c.w;
        ws += c.w;
      }
      const idx = y * panoW + x;
      sum[idx] = s;
      wsum[idx] = ws;
    }
  }

  const out = new PNG({ width: panoW, height: panoH });
  const od = out.data;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (let i = 0; i < panoW * panoH; i++) {
    const o = i * 4;
    if (wsum[i] <= 0) {
      od[o + 3] = 0;
      continue;
    }
    const c = sum[i] / wsum[i];
    if (c < tMin) tMin = c;
    if (c > tMax) tMax = c;
    let ck = Math.round((c + 273.15) * 100);
    ck = Math.max(0, Math.min(65535, ck));
    od[o] = (ck >> 8) & 0xff;
    od[o + 1] = ck & 0xff;
    od[o + 2] = 0;
    od[o + 3] = 255;
  }
  if (!Number.isFinite(tMin)) {
    tMin = 0;
    tMax = 0;
  }
  return { buffer: PNG.sync.write(out), panoW, panoH, tMin, tMax };
}

async function processOne(id, virUrl, azimuthDeg, pitchDeg) {
  const mp4Url = virUrl.replace(/\.vir$/i, '.mp4');
  const src = join(tmpdir(), `pano_${id}.src.mp4`);
  const framesDir = join(tmpdir(), `pano_${id}_frames`);
  const outPath = join(tmpdir(), `pano_${id}.jpg`);
  const tempOutPath = join(tmpdir(), `pano_${id}_temp.png`);
  try {
    const r = await fetch(mp4Url);
    if (!r.ok) throw new Error(`mp4 HTTP ${r.status}`);
    await pipeline(Readable.fromWeb(r.body), createWriteStream(src));

    const frames = extractFrames(src, framesDir);
    if (frames.length === 0) throw new Error('no frames extracted');

    const { data, panoW, panoH, cx, az, pit, refPitch, frameW } = stitchPano(frames, azimuthDeg, pitchDeg);
    const jpg = jpeg.encode({ data, width: panoW, height: panoH }, JPEG_QUALITY);
    writeFileSync(outPath, jpg.data);
    const dest = `streetviews/${id}/pano.jpg`;
    await bucket.upload(outPath, {
      destination: dest,
      metadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000' },
    });
    // Cache-bust with a version param (the assets carry a 1-year cache header, so a
    // re-bake at the same path would otherwise be masked by the CDN/browser cache).
    const v = Date.now();
    const bust = (p) =>
      `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(p)}?alt=media&v=${v}`;
    const update = { panoUrl: bust(dest), panoSpanDeg: 360 };

    // Temperature panorama (from the .vir), aligned to the visual one. Optional: a
    // missing/short .vir just skips the thermal tools (visual pano still stamped).
    let tempInfo = '';
    const vir = await fetchVir(virUrl);
    if (vir && vir.frames.length) {
      const Kvis = frames.length;
      const Kvir = vir.frames.length;
      const tempByVisual = new Array(Kvis);
      for (let k = 0; k < Kvis; k++) {
        const j = Kvis <= 1 ? 0 : Math.round((k / (Kvis - 1)) * (Kvir - 1));
        tempByVisual[k] = vir.frames[Math.min(Kvir - 1, j)];
      }
      const t = stitchTempPano(tempByVisual, vir.width, vir.height, cx, az, pit, refPitch, frameW);
      writeFileSync(tempOutPath, t.buffer);
      const tdest = `streetviews/${id}/pano_temp.png`;
      await bucket.upload(tempOutPath, {
        destination: tdest,
        metadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000' },
      });
      update.panoTempUrl = bust(tdest);
      update.panoTempW = t.panoW;
      update.panoTempH = t.panoH;
      update.tMin = Math.round(t.tMin * 100) / 100;
      update.tMax = Math.round(t.tMax * 100) / 100;
      tempInfo = ` +temp ${t.panoW}x${t.panoH} [${update.tMin}..${update.tMax}°C] ${mb(statSync(tempOutPath).size)}MB`;
    }

    await db.collection('streetviews').doc(id).update(update);
    return { ok: true, frames: frames.length, panoW, panoH, size: mb(statSync(outPath).size), tempInfo };
  } finally {
    try {
      rmSync(src);
    } catch {}
    try {
      rmSync(outPath);
    } catch {}
    try {
      rmSync(tempOutPath);
    } catch {}
    try {
      rmSync(framesDir, { recursive: true, force: true });
    } catch {}
  }
}

async function main() {
  const snap = await db
    .collection('streetviews')
    .where('visibility', '==', 'public')
    .where('trash', '==', false)
    .get();
  const todo = [];
  snap.forEach((d) => {
    const f = d.data();
    const azimuthDeg = numArray(f.azimuthDeg);
    const displayName = typeof f.displayName === 'string' ? f.displayName : '';
    if (MATCH && !displayName.toLowerCase().includes(MATCH)) return;
    // A doc is "done" once it has the temperature pano; a plain run backfills the rest.
    if (f.virUrl && azimuthDeg.length > 0 && (REDO || !f.panoTempUrl)) {
      todo.push({ id: d.id, virUrl: f.virUrl, azimuthDeg, pitchDeg: numArray(f.pitchDeg), displayName });
    }
  });
  const work = todo.slice(0, LIMIT);
  console.log(`START stitch: ${work.length} to process (of ${snap.size} public)`);
  let ok = 0;
  let fail = 0;
  const failed = [];
  for (let i = 0; i < work.length; i++) {
    const { id, virUrl, azimuthDeg, pitchDeg } = work[i];
    const tag = `[${i + 1}/${work.length}] ${id}`;
    try {
      const res = await processOne(id, virUrl, azimuthDeg, pitchDeg);
      ok++;
      console.log(`${tag} OK ${res.panoW}x${res.panoH} from ${res.frames} frames, ${res.size}MB${res.tempInfo || ''}`);
    } catch (e) {
      fail++;
      failed.push({ id, err: String(e.message || e) });
      console.log(`${tag} FAIL ${String(e.message || e)}`);
    }
  }
  console.log(`DONE: ok=${ok} fail=${fail}`);
  if (failed.length) console.log('FAILED:', JSON.stringify(failed));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });
