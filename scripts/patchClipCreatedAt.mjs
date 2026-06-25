// Fix migrated experiments whose Firestore `createdAt` is the migration day ("today") instead of
// the real creation time. Cause: migrateClips set `createdAt = toTimestamp(clip.createdAt) ??
// serverTimestamp()`, so clips whose Atlas `clip.createdAt` was missing/unparseable got the
// migration time — which is what the experiment-list cards display (the description's `date`
// field, shown inside the analyzer, was always correct). Same class of bug as patchUserCreatedAt.
//
// Recovery is self-contained (no Atlas needed): the real time already lives on the doc.
//   1. the `date` field (== ExperimentState.date, what the description shows) — primary
//   2. the doc id, when it's a Mongo ObjectId (clip _id encodes its creation time) — fallback
//
// A doc is patched only when its current `createdAt` is clearly synthetic: MORE than a day LATER
// than the recovered time (i.e. the migration day). Docs already correct, or whose createdAt is
// at/earlier than the recovered time, are left untouched — so native (non-migrated) experiments,
// whose createdAt ≈ their `date`, are never clobbered.
//
// DRY-RUN by default; WRITE=true to persist. Idempotent (re-running after a write is a no-op).
//   node scripts/patchClipCreatedAt.mjs                 # dry run (read-only)
//   WRITE=true node scripts/patchClipCreatedAt.mjs      # write
//   LIMIT=<n> node scripts/patchClipCreatedAt.mjs       # cap docs scanned (validation batch)
import { getFb, toTimestamp, oidDate } from './migrationLib.mjs';

const WRITE = process.env.WRITE === 'true';
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : null;
const DAY_MS = 24 * 60 * 60 * 1000;

const { db, FieldValue } = getFb();

// Strict ObjectId test (24 hex). Firestore auto-ids are 20-char base62 and never match, so a
// native experiment's id is never mistaken for an ObjectId timestamp.
const isObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);

/** Recover the real creation time for an experiment doc: `date` field first, then the id ObjectId. */
function recoverTime(id, data) {
  const fromDate = toTimestamp(data.date); // tolerant of '', null, locale + ISO strings
  if (fromDate) return { ts: fromDate, source: 'clipDate' };
  if (isObjectId(id)) {
    const d = oidDate(id);
    if (d) return { ts: toTimestamp(d), source: 'objectId' };
  }
  return null;
}

let snap = db.collection('experiments');
const docs = (await snap.get()).docs;

let scanned = 0,
  patched = 0,
  alreadyOk = 0,
  unrecoverable = 0,
  earlierThanDate = 0; // createdAt already <= recovered: not synthetic, leave alone
const examples = [];

for (const d of docs) {
  if (LIMIT && scanned >= LIMIT) break;
  scanned++;
  const data = d.data();

  const rec = recoverTime(d.id, data);
  if (!rec) {
    unrecoverable++;
    continue;
  }
  const realMs = rec.ts.toMillis();
  const cur = data.createdAt;
  const curMs = cur?.toMillis?.() ?? null;

  // Already correct (within a day of the recovered time): idempotent no-op.
  if (curMs != null && Math.abs(curMs - realMs) <= DAY_MS) {
    alreadyOk++;
    continue;
  }
  // createdAt at/earlier than the recovered time → not the migration day; never overwrite.
  if (curMs != null && curMs - realMs <= DAY_MS) {
    earlierThanDate++;
    continue;
  }

  // curMs is null (missing) or > realMs + DAY (synthetic migration day) → patch.
  if (examples.length < 12) {
    examples.push({
      id: d.id,
      name: (data.displayName || '').replace(/<[^>]*>/g, '').slice(0, 28),
      from: curMs ? new Date(curMs).toISOString().slice(0, 10) : '(none)',
      to: new Date(realMs).toISOString().slice(0, 10),
      src: rec.source,
    });
  }
  if (WRITE) {
    await d.ref.set(
      { createdAt: rec.ts, createdAtSource: rec.source, createdAtPatchedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }
  patched++;
}

console.log('\n==== patchClipCreatedAt SUMMARY ====');
console.log(`mode: ${WRITE ? 'WRITE' : 'DRY RUN'}${LIMIT ? ` limit=${LIMIT}` : ''}`);
console.log(`experiments scanned:                  ${scanned}`);
console.log(`  ${WRITE ? 'patched' : 'would patch'} (synthetic -> real time): ${patched}`);
console.log(`  already correct (idempotent skip):  ${alreadyOk}`);
console.log(`  createdAt at/earlier than date:     ${earlierThanDate}`);
console.log(`  unrecoverable (no date, non-ObjectId id): ${unrecoverable}`);
if (examples.length) {
  console.log('\n-- examples (createdAt: from -> to, via source) --');
  for (const e of examples) console.log(`   ${e.id}  "${e.name}"  ${e.from} -> ${e.to}  [${e.src}]`);
}
process.exit(0);
