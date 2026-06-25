// Phase 3: restore recording frames missing from Storage by stream-copying them from the
// still-live legacy server telelab2.intofuture.org. Idempotent (skips files already in Storage),
// resumable (progress file), probe-first (skips recordings the legacy server no longer has).
// DRY-RUN by default.
//   node scripts/backfillFrames.mjs                          # dry run: report volume + availability
//   WRITE=true node scripts/backfillFrames.mjs               # copy
//   ONLY_OWNER=<mongoId> WRITE=true node ...                 # restore only one owner's recordings (e.g. charles)
//   LIMIT_RECORDINGS=<n> ... | CONCURRENCY=<n> ...
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { ObjectId } from 'mongodb';
import { connectAtlas, getFb, oid, FPS } from './migrationLib.mjs';

const WRITE = process.env.WRITE === 'true';
const ONLY_OWNER = process.env.ONLY_OWNER || null;
const LIMIT_RECORDINGS = process.env.LIMIT_RECORDINGS ? parseInt(process.env.LIMIT_RECORDINGS, 10) : null;
const CONCURRENCY = process.env.CONCURRENCY ? parseInt(process.env.CONCURRENCY, 10) : 8;
const BASE = 'https://telelab2.intofuture.org/public/episodes';
const PROGRESS = 'scripts/.baseline/frameProgress.json';

const { bucket } = getFb();
const { client, db: m } = await connectAtlas();
const ownerFilter = ONLY_OWNER ? { user: { $in: [ONLY_OWNER, new ObjectId(ONLY_OWNER)] } } : {};
const q = { trash: { $ne: true }, ...ownerFilter };
const clips = await m.collection('userrecordingconfigs').find(q).toArray();
const states = await m.collection('experiments').find({}, { projection: { id: 1, duration: 1, currentFrameNumber: 1 } }).toArray();
const recs = await m.collection('recordings').find({}, { projection: { lastFrameNumber: 1 } }).toArray();
await client.close();

const stateById = new Map(states.map((s) => [String(s.id), s]));
const lastFrameById = new Map(recs.map((r) => [oid(r._id), r.lastFrameNumber || 0]));

// per-recording needed frame union (segments | raw 1..duration*5 | thumbnail frame)
const needed = new Map(); // recId -> Set(frameNumbers)
for (const c of clips) {
  const recId = oid(c.recording);
  if (!recId) continue;
  const st = stateById.get(oid(c._id));
  const lastFrame = lastFrameById.get(recId) || 0;
  const set = needed.get(recId) ?? needed.set(recId, new Set()).get(recId);
  const segs = Array.isArray(c.segments) && c.segments.length ? c.segments : null;
  if (segs) {
    for (const s of segs) for (let i = s.startFrame; i <= s.endFrame; i++) set.add(i);
  } else {
    const end = st && st.duration > 0 ? Math.ceil(st.duration * FPS) : lastFrame;
    for (let i = 1; i <= end; i++) set.add(i);
  }
  set.add(st?.currentFrameNumber || 1); // thumbnail frame must be present
}

mkdirSync('scripts/.baseline', { recursive: true });
const progress = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, 'utf8')) : { done: [] };
const doneSet = new Set(progress.done);

async function listExisting(recId) {
  const [files] = await bucket.getFiles({ prefix: `recordings/${recId}/` });
  return new Set(files.map((f) => f.name.split('/').pop()));
}
async function headOk(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
    return r.ok;
  } catch {
    return false;
  }
}
async function copyOne(recId, n, existing) {
  const out = {};
  for (const [ext, ct] of [['png', 'image/png'], ['dat', 'application/octet-stream']]) {
    const name = `data_${n}.${ext}`;
    if (existing.has(name)) { out[ext] = 'skip'; continue; }
    try {
      const r = await fetch(`${BASE}/${recId}/${name}`, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) { out[ext] = r.status === 404 ? '404' : 'err'; continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (WRITE) await bucket.file(`recordings/${recId}/${name}`).save(buf, { contentType: ct, resumable: false });
      out[ext] = 'copied';
    } catch { out[ext] = 'err'; }
  }
  return out;
}
async function pool(items, n, fn) {
  const it = items[Symbol.iterator]();
  await Promise.all(Array.from({ length: n }, async () => { for (let x = it.next(); !x.done; x = it.next()) await fn(x.value); }));
}

let recList = [...needed.keys()].filter((r) => !lastFrameById.has(r) || true);
if (LIMIT_RECORDINGS) recList = recList.slice(0, LIMIT_RECORDINGS);

let totalNeeded = 0, copied = 0, skipped = 0, missing404 = 0, recUnavailable = 0, recDone = 0, recTotal = recList.length;
for (const recId of recList) totalNeeded += needed.get(recId).size;

console.log(`mode: ${WRITE ? 'WRITE' : 'DRY RUN'}${ONLY_OWNER ? ' owner=' + ONLY_OWNER : ''}`);
console.log(`recordings to consider: ${recTotal}  total frame-numbers needed (x2 files): ${totalNeeded}`);

for (const recId of recList) {
  if (doneSet.has(recId)) { recDone++; continue; }
  const frames = [...needed.get(recId)].sort((a, b) => a - b);
  const existing = WRITE ? await listExisting(recId) : new Set();
  // probe availability (sample first needed frame)
  const probe = await headOk(`${BASE}/${recId}/data_${frames[0]}.png`);
  if (!probe) { recUnavailable++; console.log(`  UNAVAILABLE on telelab2: ${recId} (${frames.length} frames) -> clips un-playable`); continue; }
  if (!WRITE) { console.log(`  ${recId}: ${frames.length} frames needed`); continue; }
  await pool(frames, CONCURRENCY, async (n) => {
    const r = await copyOne(recId, n, existing);
    for (const v of Object.values(r)) { if (v === 'copied') copied++; else if (v === 'skip') skipped++; else if (v === '404') missing404++; }
  });
  doneSet.add(recId);
  progress.done = [...doneSet];
  writeFileSync(PROGRESS, JSON.stringify(progress));
  recDone++;
  if (recDone % 10 === 0) console.log(`  ... ${recDone}/${recTotal} recordings, copied=${copied} skip=${skipped} 404=${missing404}`);
}

console.log('\n==== backfillFrames SUMMARY ====');
console.log(`recordings processed: ${recDone}/${recTotal}  unavailable(telelab2 404): ${recUnavailable}`);
console.log(`files copied=${copied}  already-present=${skipped}  per-frame 404=${missing404}`);
process.exit(0);
