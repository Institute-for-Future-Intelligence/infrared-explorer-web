// Seed the `streetviews` collection from the legacy Infrared Street View dataset
// (intofuture.org/telelab/streetview/index.json — 238 geo-tagged thermal
// panoramas). Doc-only: location + metadata + a `virUrl` pointing at the legacy
// `.vir` clip, which the mobile app converts ON-DEVICE when a marker is opened
// (the videostore pipeline) — no frame files are copied into Firebase Storage.
// These are curated content: ownerId 'system', visibility 'public', legacy: true.
// Idempotent (deterministic doc id from the url slug; set({merge:true})).
//
//   node scripts/seedStreetViews.mjs         # seed / refresh
//   node scripts/seedStreetViews.mjs --clear # delete all legacy==true street views
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, GeoPoint } from 'firebase-admin/firestore';

const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const INDEX_URL = 'https://intofuture.org/telelab/streetview/index.json';
const BASE = 'https://intofuture.org/telelab/streetview';

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
function geohash(lat, lng, precision = 9) {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180, hash = '', bits = 0, bit = 0, even = true;
  lng = ((((lng + 180) % 360) + 360) % 360) - 180;
  lat = Math.max(-90, Math.min(90, lat));
  while (hash.length < precision) {
    if (even) { const m = (lngMin + lngMax) / 2; if (lng >= m) { bit = bit * 2 + 1; lngMin = m; } else { bit *= 2; lngMax = m; } }
    else { const m = (latMin + latMax) / 2; if (lat >= m) { bit = bit * 2 + 1; latMin = m; } else { bit *= 2; latMax = m; } }
    even = !even;
    if (++bits === 5) { hash += BASE32[bit]; bits = 0; bit = 0; }
  }
  return hash;
}
const slug = (url) => url.replace(/\.mp4$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();

async function clearLegacy() {
  const snap = await db.collection('streetviews').where('legacy', '==', true).get();
  let batch = db.batch(), n = 0;
  for (const d of snap.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); } }
  if (n % 400 !== 0) await batch.commit();
  console.log('deleted', n, 'legacy street views');
}

async function seed() {
  const entries = await (await fetch(INDEX_URL)).json();
  console.log('legacy entries:', entries.length);
  const now = new Date();
  let batch = db.batch(), n = 0;
  for (const e of entries) {
    if (typeof e.latitude !== 'number' || typeof e.longitude !== 'number' || !e.url) continue;
    const doc = {
      sourceType: 'pano', ownerId: 'system', visibility: 'public',
      location: new GeoPoint(e.latitude, e.longitude),
      geohash: geohash(e.latitude, e.longitude),
      displayName: e.address || e.town || 'Street View',
      author: [e.town, e.state].filter(Boolean).join(', '),
      description: [e.address, e.town, e.state, e.country].filter(Boolean).join(', '),
      thermalUnit: 'celsius', palette: 'inferno', shots: [],
      virUrl: `${BASE}/${e.url.replace(/\.mp4$/, '.vir')}`,
      legacy: true, date: now, createdAt: now, trash: false,
      ratingSum: 0, ratingCount: 0, viewCount: 0, commentCount: 0,
    };
    batch.set(db.collection('streetviews').doc(slug(e.url)), doc, { merge: true });
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  if (n % 400 !== 0) await batch.commit();
  const q = await db.collection('streetviews').where('visibility', '==', 'public').where('trash', '==', false).get();
  console.log('seeded', n, '| public && !trash now:', q.size);
}

const clear = process.argv.includes('--clear');
(clear ? clearLegacy() : seed())
  .then(() => process.exit(0))
  .catch((e) => { console.error('ERR', e.message); process.exit(1); });
