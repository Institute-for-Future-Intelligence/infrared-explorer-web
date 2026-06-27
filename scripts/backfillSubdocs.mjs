// Backfill the subcollections the dedup-skip dropped on pre-existing/seed experiments:
// annotations + thermometers (no Function triggers) and, gated behind RATINGS=true, ratings
// (which fire aggregateRatings -> notifyExperimentOwner). Idempotent, DRY-RUN default, and
// only ever writes onto experiments that ALREADY exist in Firebase.
//   node scripts/backfillSubdocs.mjs                       # dry run: annotations + thermometers
//   WRITE=true node scripts/backfillSubdocs.mjs            # write annotations + thermometers
//   WRITE=true RATINGS=true node scripts/backfillSubdocs.mjs   # also write ratings (fires notifs)
import {
  connectAtlas,
  getFb,
  oid,
  mapThermometer,
  mapAnnotations,
} from './migrationLib.mjs';

const WRITE = process.env.WRITE === 'true';
const DO_RATINGS = process.env.RATINGS === 'true';

const { db } = getFb();
const { client, db: m } = await connectAtlas();
const [states, therms, ratings] = await Promise.all([
  m.collection('experiments').find({}).toArray(),
  m.collection('thermometers').find({}).toArray(),
  m.collection('ratings').find({}, { projection: { expID: 1, user: 1, rating: 1 } }).toArray(),
]);
await client.close();

const stateById = new Map(states.map((s) => [String(s.id), s]));
const thermById = new Map(therms.map((t) => [String(t.id), t]));
const ratingsByExp = new Map();
for (const r of ratings) {
  if (typeof r.rating !== 'number' || !r.user) continue;
  const e = String(r.expID);
  (ratingsByExp.get(e) ?? ratingsByExp.set(e, new Map()).get(e)).set(oid(r.user), r.rating);
}

const stats = { thermW: 0, annoW: 0, ratingW: 0, ratingExps: 0, notifsWouldFire: 0 };

const snap = await db.collection('experiments').get();
for (const d of snap.docs) {
  const expId = d.id;
  const ownerId = d.data().ownerId;
  const state = stateById.get(expId);

  // ---- thermometers (from state.thermometers refs) ----
  if (state?.thermometers?.length) {
    const want = state.thermometers.map(String).map((tid) => thermById.get(tid)).filter(Boolean).map((t) => mapThermometer(t, ownerId));
    for (const t of want) {
      const ref = d.ref.collection('thermometers').doc(t.id);
      if (!(await ref.get()).exists) {
        if (WRITE) await ref.set(t);
        stats.thermW++;
      }
    }
  }

  // ---- annotations (from state.annotations JSON) ----
  const annos = mapAnnotations(state, expId, ownerId);
  for (const a of annos) {
    const ref = d.ref.collection('annotations').doc(a.id);
    if (!(await ref.get()).exists) {
      if (WRITE) await ref.set(a.data);
      stats.annoW++;
    }
  }

  // ---- ratings (gated; fires notifications) ----
  if (DO_RATINGS) {
    const byUser = ratingsByExp.get(expId);
    if (byUser?.size) {
      let wroteHere = false;
      for (const [ruid, rating] of byUser) {
        const ref = d.ref.collection('ratings').doc(ruid);
        if (!(await ref.get()).exists) {
          if (WRITE) await ref.set({ rating });
          stats.ratingW++;
          wroteHere = true;
          if (ownerId && ownerId !== 'system' && ownerId !== ruid) stats.notifsWouldFire++;
        }
      }
      if (wroteHere) {
        stats.ratingExps++;
        // self-heal aggregates in-script (don't rely solely on the aggregateRatings Function).
        if (WRITE) {
          const all = await d.ref.collection('ratings').get();
          let sum = 0, count = 0;
          all.forEach((r) => { const v = r.data().rating; if (typeof v === 'number') { sum += v; count++; } });
          await d.ref.set({ ratingSum: sum, ratingCount: count }, { merge: true });
        }
      }
    }
  }
}

console.log('==== backfillSubdocs ====');
console.log(`mode: ${WRITE ? 'WRITE' : 'DRY RUN'}  ratings: ${DO_RATINGS ? 'ON' : 'off'}`);
console.log(`thermometers ${WRITE ? 'written' : 'to write'} = ${stats.thermW}`);
console.log(`annotations  ${WRITE ? 'written' : 'to write'} = ${stats.annoW}`);
if (DO_RATINGS) {
  console.log(`ratings      ${WRITE ? 'written' : 'to write'} = ${stats.ratingW} across ${stats.ratingExps} experiments`);
  console.log(`  rating notifications that would fire (non-system, non-self) = ${stats.notifsWouldFire}`);
}
process.exit(0);
