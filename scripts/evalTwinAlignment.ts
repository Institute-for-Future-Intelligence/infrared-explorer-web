/**
 * The alignment regression (docs/digital-twin-plan.md §43.4): for each still-camera twin in production,
 * does the model the AI wrote line up with the thermal frame it was built from? The program is run in
 * Node as the frame runs it (twinProgramNode), seen from the registered frame's camera by raycasting (the
 * frame's verify message, without a GPU), and scored against the frame's own objects with
 * src/utils/twinAlignment.ts — the very code the panel's Measured view scores with.
 *
 *   npx tsx scripts/evalTwinAlignment.ts [--ids=a,b,c] [--limit=10] [--trash] [--out=eval-twin/alignment]
 *
 * Reads production Storage/Firestore through ./serviceAccount.json (read-only; nothing is written back).
 * Without --ids, the newest recordings whose twin was built from picked frames (`framesPicked`: the
 * motion gate's one stillest frame, or the owner's pick) are taken, up to --limit. Each gets a JSON of
 * its report (the blobs, the parts, the per-object scores) under --out/<date>/, and the run ends with a
 * table and the counts — pass / fail / inconclusive, the mean worst offset — which is the number to watch
 * when a prompt, a model or a threshold changes.
 *
 * What it does not do: the viewer moves a photo's camera when the frame's settle moved the parts its
 * landmarks sit on (settleRegistration); here the stored camera is used as fitted, so a model the frame
 * set down by a few centimetres scores a little worse than on screen. Human-labelled object positions
 * (eval-twin/fixed/<id>.json) are not read yet: the frame's own segmentation is the reference.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { celsiusAtIndex, decodeFrame } from '../functions/src/thermal';
import { runTwinProgram } from '../src/pages/experimentAnalyzer/twin/twinProgramNode';
import {
  type AlignmentReport,
  alignmentReport,
  alignmentSentence,
  partInstances,
  segmentThermal,
} from '../src/utils/twinAlignment';
import { THERMAL_H, THERMAL_W, livePhotoOf, maskTemps, registeredPhotos, skyCut } from '../src/utils/twinProjection';
import type { TwinBuildingRecord, TwinSubjectKind } from '../src/types';

const arg = (name: string): string | undefined =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const IDS = (arg('ids') ?? '').split(',').filter(Boolean);
const LIMIT = Number(arg('limit') ?? 10);
const INCLUDE_TRASH = flag('trash');
const OUT_ROOT = arg('out') ?? 'eval-twin/alignment';

interface Row {
  id: string;
  title: string;
  photo: number | null;
  verdict: AlignmentReport['verdict'] | 'no-twin' | 'no-camera' | 'no-frame' | 'program-failed';
  worstPx: number | null;
  objects: number;
  note: string;
}

async function main() {
  const { cert, initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getStorage } = await import('firebase-admin/storage');
  const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
  initializeApp({ credential: cert(sa), storageBucket: 'infrared-explorer.appspot.com' });
  const db = getFirestore();
  const bucket = getStorage().bucket();

  const docs: { id: string; data: FirebaseFirestore.DocumentData }[] = [];
  if (IDS.length) {
    const snaps = await db.getAll(...IDS.map((id) => db.collection('experiments').doc(id)));
    for (const s of snaps) {
      const e = s.data();
      if (e) docs.push({ id: s.id, data: e });
      else console.warn(`experiment ${s.id}: not found`);
    }
  } else {
    const snap = await db.collection('experiments').orderBy('createdAt', 'desc').limit(600).get();
    for (const d of snap.docs) {
      if (docs.length >= LIMIT) break;
      const e = d.data();
      const twin = e.twinScene as Partial<TwinBuildingRecord> | undefined;
      if (e.sourceType !== 'recording' || !e.recordingId || twin?.kind !== 'building' || twin.framesPicked !== true)
        continue;
      if (e.trash && !INCLUDE_TRASH) continue;
      docs.push({ id: d.id, data: e });
    }
  }
  if (!docs.length) {
    console.log('nothing to evaluate');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const outDir = path.join(OUT_ROOT, stamp);
  mkdirSync(outDir, { recursive: true });

  const rows: Row[] = [];
  for (const { id, data: e } of docs) {
    const title = String(e.displayName ?? e.title ?? '');
    const twin = e.twinScene as TwinBuildingRecord | undefined;
    const row = (
      verdict: Row['verdict'],
      note: string,
      photo: number | null = null,
      worstPx: number | null = null,
      objects = 0,
    ) => rows.push({ id, title, photo, verdict, worstPx, objects, note });
    if (!twin || twin.kind !== 'building' || typeof twin.code !== 'string') {
      row('no-twin', 'no scene program on the record');
      continue;
    }
    const live = livePhotoOf(
      registeredPhotos(twin.thermal).map(({ photo, camera }) => ({
        photo: photo.photo,
        rms: camera.rms,
        camera,
        record: photo,
      })),
    );
    if (!live) {
      row('no-camera', 'no registered frame with a fitted camera');
      continue;
    }
    const dat = await bucket
      .file(`recordings/${e.recordingId}/data_${live.photo}.dat`)
      .download()
      .then((r) => r[0])
      .catch(() => null);
    if (!dat) {
      row('no-frame', `data_${live.photo}.dat could not be read`, live.photo);
      continue;
    }
    const frame = decodeFrame(new Uint8Array(dat));
    if (!frame.complete) {
      row('no-frame', `data_${live.photo}.dat is incomplete`, live.photo);
      continue;
    }
    const raw = new Float32Array(THERMAL_W * THERMAL_H);
    for (let k = 0; k < raw.length; k++) {
      const c = celsiusAtIndex(frame, k);
      raw[k] = c > -200 ? c : NaN; // a zero record is a pixel the camera could not read
    }
    const kind = (twin.subjectKind ?? undefined) as TwinSubjectKind | undefined;
    const cut = kind === 'interior' ? null : skyCut(twin.thermal, kind);
    const temps = maskTemps(raw, THERMAL_W, THERMAL_H, cut, kind);
    const reg = live.record.picture === 'vis' ? live.record.registration : null;
    const run = runTwinProgram(
      twin.code,
      (twin.parts ?? []).map((p) => p.name),
      undefined,
      [
        {
          position: [live.camera.position[0], live.camera.position[1], live.camera.position[2]],
          yaw: live.camera.yaw,
          pitch: live.camera.pitch,
          roll: live.camera.roll,
          fovV: live.camera.fovV,
          aspect: live.camera.aspect,
          dx: reg?.dx ?? 0,
          dy: reg?.dy ?? 0,
        },
      ],
    );
    if (run.error || !run.masks?.length) {
      row('program-failed', run.error ?? 'no mask came back', live.photo);
      continue;
    }
    const { mask, names } = run.masks[0];
    const segmentation = segmentThermal(temps);
    const model = partInstances(mask, names);
    const report = alignmentReport(segmentation, model);
    row(
      report.verdict,
      alignmentSentence(report),
      live.photo,
      report.verdict === 'inconclusive' ? null : report.worstCentroidPx,
      report.objects.length,
    );
    writeFileSync(
      path.join(outDir, `${id}.json`),
      JSON.stringify(
        {
          id,
          title,
          model: twin.model,
          photo: live.photo,
          camera: live.camera,
          segmentation: {
            polarity: segmentation.polarity,
            thresholdC: segmentation.thresholdC,
            gapC: segmentation.gapC,
            contrast: segmentation.contrast,
            weak: segmentation.weak,
            blobs: segmentation.blobs,
          },
          instances: model.instances,
          verdict: report.verdict,
          reason: report.reason,
          worstCentroidPx: report.worstCentroidPx,
          objects: report.objects.map((o) => ({
            blob: o.blob.id,
            parts: o.parts,
            instances: o.instances.map((p) => `${p.name} #${p.instance}`),
            iou: o.iou,
            centroidErrPx: o.centroidErrPx,
            areaRatio: o.areaRatio,
            pass: o.pass,
          })),
          missing: report.missing.map((b) => b.id),
          extra: report.extra.map((p) => `${p.name} #${p.instance}`),
          shared: report.shared,
          settled: run.settled,
        },
        null,
        2,
      ),
    );
  }

  // ---- The table and the counts.
  const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
  console.log('');
  console.log(
    pad('experiment', 22) + pad('frame', 7) + pad('verdict', 15) + pad('worst px', 10) + pad('objects', 8) + 'note',
  );
  for (const r of rows) {
    console.log(
      pad(r.id, 22) +
        pad(r.photo === null ? '—' : String(r.photo), 7) +
        pad(r.verdict, 15) +
        pad(r.worstPx === null ? '—' : r.worstPx.toFixed(1), 10) +
        pad(String(r.objects), 8) +
        r.note,
    );
  }
  const count = (v: Row['verdict']) => rows.filter((r) => r.verdict === v).length;
  const scored = rows.filter((r) => r.worstPx !== null);
  const mean = scored.length ? scored.reduce((s, r) => s + (r.worstPx as number), 0) / scored.length : NaN;
  console.log('');
  console.log(
    `${rows.length} twins: ${count('pass')} pass, ${count('fail')} fail, ${count('inconclusive')} inconclusive, ` +
      `${rows.length - count('pass') - count('fail') - count('inconclusive')} not scored; ` +
      `mean worst offset ${Number.isFinite(mean) ? mean.toFixed(1) + ' px' : '—'} over ${scored.length}`,
  );
  console.log(`reports in ${outDir}`);
  if (!existsSync(path.join(OUT_ROOT, 'README.md')))
    writeFileSync(
      path.join(OUT_ROOT, 'README.md'),
      '# Twin alignment runs\n\nOne folder per run of scripts/evalTwinAlignment.ts (plan §43.4); each JSON is one twin scored against its registered frame.\n',
    );
}

void main();
