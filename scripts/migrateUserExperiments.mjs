// Migrate legacy nested user experiments (users/{uid}/experiments/*) into the merged
// top-level `experiments` collection. References only — the recording frame binaries already
// live in Storage recordings/{recordingId}/, so migrated experiments are playable.
//
//   node scripts/migrateUserExperiments.mjs                 # DRY RUN (reads only, writes nothing)
//   WRITE=true node scripts/migrateUserExperiments.mjs      # actually write
//   ONLY_EMAIL=xiaotong@intofuture.org node ...             # limit to one user
//
// Field fixes applied: type->sourceType:'recording', unit->thermalUnit, ownerId from the
// parent user's mongoId, visibility:'private', isRaw/segments normalized, comment senderID->senderId
// (id dropped, taken from doc id), ratings deduped to one-per-user (docId=userId, {rating} only),
// ratingSum/ratingCount recomputed, thumbnailURL -> recordings/{recordingId}/data_{frame}.png.
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const WRITE = process.env.WRITE === 'true';
const ONLY_EMAIL = process.env.ONLY_EMAIL || null;

const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
initializeApp({ credential: cert(sa), storageBucket: 'infrared-explorer.appspot.com' });
const db = getFirestore();
const bucket = getStorage().bucket();

// Set of recordingIds that actually have frames in Storage (for playability check).
const [, , recApi] = await bucket.getFiles({ prefix: 'recordings/', delimiter: '/', maxResults: 20000, autoPaginate: false });
const recSet = new Set(((recApi && recApi.prefixes) || []).map((p) => p.replace(/^recordings\//, '').replace(/\/$/, '')));

async function copySub(srcPath, destRef, mapFn) {
  const snap = await db.collection(srcPath).get();
  let n = 0;
  for (const d of snap.docs) {
    const out = mapFn(d);
    if (!out) continue;
    if (WRITE) await destRef.collection(out._col).doc(out._id).set(out.data);
    n++;
  }
  return n;
}

const users = await db.collection('users').get();
let totalExp = 0,
  playable = 0,
  unplayable = 0;
const perUser = {};

for (const u of users.docs) {
  const email = u.data().email ?? '?';
  if (ONLY_EMAIL && email !== ONLY_EMAIL) continue;
  const ownerId = u.data().id ?? u.id; // mongoId
  const exps = await db.collection(`users/${u.id}/experiments`).get();
  perUser[email] = { count: 0, playable: 0 };

  for (const ex of exps.docs) {
    const old = ex.data();
    const recordingId = old.recordingId ?? null;
    const segments = Array.isArray(old.segments) && old.segments.length ? old.segments : null;
    const isPlayable = !!(recordingId && recSet.has(recordingId));
    totalExp++;
    perUser[email].count++;
    if (isPlayable) {
      playable++;
      perUser[email].playable++;
    } else unplayable++;

    const expRef = db.doc(`experiments/${ex.id}`);

    // recompute rating aggregate + dedup (one per user, last wins)
    const ratingsSnap = await db.collection(`users/${u.id}/experiments/${ex.id}/ratings`).get();
    const byUser = new Map();
    ratingsSnap.forEach((r) => {
      const rd = r.data();
      const ruid = rd.userId ?? rd.userID;
      if (ruid && typeof rd.rating === 'number') byUser.set(ruid, rd.rating);
    });
    let ratingSum = 0;
    byUser.forEach((v) => (ratingSum += v));
    const ratingCount = byUser.size;

    const newDoc = {
      sourceType: 'recording',
      ownerId,
      visibility: 'private',
      displayName: old.displayName ?? 'Untitled',
      author: old.author ?? '',
      description: old.description ?? '',
      subject: old.subject ?? null,
      duration: old.duration ?? 0,
      date: old.date ?? '',
      thumbnailURL: recordingId ? `recordings/${recordingId}/data_${old.thumbnailFrame ?? 1}.png` : '',
      graphsOptions: old.graphsOptions ?? [],
      thermalUnit: old.unit ?? 'celsius',
      trash: old.trash ?? false,
      isRaw: !segments,
      segments,
      recordingId,
      viewCount: old.viewCount ?? 0,
      currentFrameNumber: old.currentFrameNumber ?? 1,
      ratingSum,
      ratingCount,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (WRITE) await expRef.set(newDoc);

    // thermometers (add ownerId/visibility redundancy for list rules)
    const tN = await copySub(`users/${u.id}/experiments/${ex.id}/thermometers`, expRef, (d) => ({
      _col: 'thermometers',
      _id: d.id,
      data: { ...d.data(), ownerId, visibility: 'private' },
    }));
    // comments (senderID->senderId, drop stored id)
    const cN = await copySub(`users/${u.id}/experiments/${ex.id}/comments`, expRef, (d) => {
      const c = d.data();
      return {
        _col: 'comments',
        _id: d.id,
        data: {
          senderId: c.senderId ?? c.senderID ?? '',
          senderName: c.senderName ?? '',
          senderAvatar: c.senderAvatar ?? '',
          content: c.content ?? '',
          date: c.date ?? '',
        },
      };
    });
    // ratings (docId = userId, {rating} only, deduped)
    let rN = 0;
    if (WRITE) {
      for (const [ruid, rating] of byUser) {
        await expRef.collection('ratings').doc(ruid).set({ rating });
        rN++;
      }
    } else rN = byUser.size;

    console.log(
      `${WRITE ? 'WROTE' : 'PLAN'} ${ex.id} [${isPlayable ? 'playable' : 'NO-FRAMES'}] "${(old.displayName ?? '').slice(0, 28)}" owner=${email} thermo=${tN} comments=${cN} ratings=${rN}`,
    );
  }
}

console.log('\n==== SUMMARY ====');
console.log(`mode: ${WRITE ? 'WRITE' : 'DRY RUN (no writes)'}`);
console.log(`experiments: ${totalExp}  playable=${playable}  no-frames=${unplayable}`);
for (const [email, s] of Object.entries(perUser)) console.log(`  ${email}: ${s.count} (playable ${s.playable})`);
process.exit(0);
