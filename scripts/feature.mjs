// Homepage curation tool. The homepage renders config/homepage.items (an ordered list of
// experiment ids); editing the homepage = editing that one list. Featuring an experiment also
// sets its visibility to 'public' so anonymous visitors can read it.
//
//   node scripts/feature.mjs init                     # populate from showcases.json + staffpicks.json
//   node scripts/feature.mjs list                     # show current homepage items
//   node scripts/feature.mjs add <expId> [position]   # add/move to position (default end), set public
//   node scripts/feature.mjs remove <expId>           # remove from homepage (visibility unchanged)
//   node scripts/feature.mjs order id1,id2,id3,...     # set the full order explicitly
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const ref = db.doc('config/homepage');

const getItems = async () => {
  const s = await ref.get();
  return s.exists ? (s.data().items ?? []) : [];
};
const setItems = (items) => ref.set({ items, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
const makePublic = (id) => db.doc(`experiments/${id}`).set({ visibility: 'public' }, { merge: true });

const [cmd, arg, arg2] = process.argv.slice(2);

switch (cmd) {
  case 'init': {
    const showIds = JSON.parse(readFileSync('./db/showcases.json', 'utf8')).map((s) => s.id);
    const pickIds = JSON.parse(readFileSync('./db/staffpicks.json', 'utf8')).map((s) => s.id.replace(/^clip\//, ''));
    for (const id of pickIds) await makePublic(id); // showcases are already system/public
    const items = [...showIds, ...pickIds];
    await setItems(items);
    console.log(`init: ${items.length} homepage items (showcases ${showIds.length} + staffpicks ${pickIds.length}); ${pickIds.length} staffpicks set public`);
    break;
  }
  case 'list': {
    const items = await getItems();
    console.log(`homepage: ${items.length} items`);
    for (const id of items) {
      const d = await db.doc(`experiments/${id}`).get();
      console.log(`  ${id}  ${d.exists ? (d.data().displayName ?? '') : '(MISSING)'}`);
    }
    break;
  }
  case 'add': {
    if (!arg) throw new Error('usage: add <expId> [position]');
    const items = (await getItems()).filter((i) => i !== arg);
    const pos = arg2 !== undefined ? parseInt(arg2, 10) : items.length;
    items.splice(Math.max(0, Math.min(pos, items.length)), 0, arg);
    await makePublic(arg);
    await setItems(items);
    console.log(`added ${arg} at ${pos} (now ${items.length} items, visibility set public)`);
    break;
  }
  case 'remove': {
    if (!arg) throw new Error('usage: remove <expId>');
    const items = (await getItems()).filter((i) => i !== arg);
    await setItems(items);
    console.log(`removed ${arg} (now ${items.length} items; visibility left unchanged)`);
    break;
  }
  case 'order': {
    if (!arg) throw new Error('usage: order id1,id2,...');
    const items = arg.split(',').map((s) => s.trim()).filter(Boolean);
    await setItems(items);
    console.log(`order set: ${items.length} items`);
    break;
  }
  default:
    console.log('usage: node scripts/feature.mjs <init|list|add|remove|order> [arg] [arg2]');
}
process.exit(0);
