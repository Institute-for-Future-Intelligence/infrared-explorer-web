// Homepage curation tool. The homepage lists experiments flagged `featured: true`
// (rules freeze the flag against owner edits, so only this Admin-SDK tool sets it).
// `visibility` is the user's own knob — 'public' puts an experiment on the OWNER'S
// PROFILE page, not the homepage. Featuring also sets visibility:'public' (and mirrors
// it onto the thermometer/annotation sub-docs, which carry a redundant visibility field
// for the list rules) so anonymous visitors can open the featured experiment.
//
//   node scripts/feature.mjs list               # audit ALL featured flags (incl. hidden ones)
//   node scripts/feature.mjs add <expId>        # featured:true + visibility:'public' (+ sub-docs)
//   node scripts/feature.mjs remove <expId>     # featured:false (visibility unchanged)
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const [cmd, arg] = process.argv.slice(2);

/** Load the experiment doc or fail loudly — set({merge}) on a bad id would create an orphan stub. */
async function mustGetExperiment(id) {
  const snap = await db.doc(`experiments/${id}`).get();
  if (!snap.exists) throw new Error(`experiment ${id} does not exist`);
  return snap;
}

switch (cmd) {
  case 'list': {
    // Audit view: every doc carrying the flag, including ones the homepage currently hides
    // (trashed or owner-unpublished) — those would silently return when restored/re-published.
    const snap = await db.collection('experiments').where('featured', '==', true).get();
    const docs = snap.docs.sort(
      (a, b) => (b.data().createdAt?.toMillis?.() ?? 0) - (a.data().createdAt?.toMillis?.() ?? 0),
    );
    console.log(`${docs.length} featured experiments (homepage shows only public + non-trashed):`);
    for (const d of docs) {
      const x = d.data();
      const flags = [x.visibility !== 'public' ? `HIDDEN: visibility=${x.visibility}` : '', x.trash ? 'HIDDEN: trashed' : '']
        .filter(Boolean)
        .join(', ');
      console.log(`  ${d.id}  ${x.displayName ?? ''}${flags ? `  [${flags}]` : ''}`);
    }
    break;
  }
  case 'add': {
    if (!arg) throw new Error('usage: add <expId>');
    const snap = await mustGetExperiment(arg);
    await snap.ref.set({ featured: true, visibility: 'public' }, { merge: true });
    // Sub-docs mirror the parent's visibility for the list rules; without this, a previously
    // private experiment's thermometers/annotations stay unreadable to visitors.
    let subDocs = 0;
    for (const sub of ['thermometers', 'annotations']) {
      const subSnap = await snap.ref.collection(sub).get();
      for (const d of subSnap.docs) {
        await d.ref.set({ visibility: 'public' }, { merge: true });
        subDocs++;
      }
    }
    console.log(`featured ${arg} (visibility set public; ${subDocs} sub-docs mirrored)`);
    break;
  }
  case 'remove': {
    if (!arg) throw new Error('usage: remove <expId>');
    const snap = await mustGetExperiment(arg);
    await snap.ref.set({ featured: false }, { merge: true });
    console.log(`unfeatured ${arg} (visibility left unchanged)`);
    break;
  }
  default:
    console.log('usage: node scripts/feature.mjs <list|add|remove> [expId]');
}
process.exit(0);
