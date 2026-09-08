// Seed the `streetviews` collection from the legacy Infrared Street View dataset
// (intofuture.org/telelab/streetview/index.json — 238 geo-tagged thermal
// panoramas). Doc-only: location + metadata + a `virUrl` pointing at the legacy
// `.vir` clip, which the mobile app converts ON-DEVICE when a marker is opened
// (the videostore pipeline) — no frame files are copied into Firebase Storage.
//
// PER-FRAME ORIENTATION: the legacy `.mp4` carries per-frame azimuth[]/pitch[]
// (BE float64 arrays) in its `moov/meta` keyed metadata (keys `azimuth`,`pitch`,
// written by jcodec's MetadataEditor). We range-fetch just the head of each mp4
// (moov sits at the front, ~5 KB) and store those arrays as `azimuthDeg`/
// `pitchDeg` + `frameCount`, plus `neighbors` (from index.json, link→doc-id) so
// the app can render the Java `VideoStreetView` panorama: drag-to-look, a
// compass, N/E/S/W bearing lines, a pitch line, and neighbor navigation.
//
// These are curated content: ownerId 'system', visibility 'public', legacy true.
// Idempotent (deterministic doc id from the url slug; set({merge:true})).
//
// RE-RUNNING IS NOT A RESET. A re-bake must never undo moderation or lose engagement:
// for a document that already exists this script drops `visibility`, `trash` and the four
// aggregate counters from the write, so a panorama staff took down stays down and its
// view/rating counts survive. Only the fields the bake actually produces are merged.
// (The Admin SDK bypasses security rules, so the rules cannot enforce this — the check
// has to live here.)
//
// `--clear` deletes the DOCUMENTS ONLY. It leaves Storage alone, and the
// onStreetViewDeleted trigger deliberately skips anything with ownerId 'system' or
// legacy true — otherwise one clear would delete the re-hosted stream.mp4 / pano.jpg /
// pano_temp.png that streamAll.mjs and stitchAll.mjs spent hours producing under
// streetviews/{id}/. See the app repo, docs/proposals/street-view-ugc-governance.md.
//
//   node scripts/seedStreetViews.mjs         # seed / refresh (fetches mp4 heads)
//   node scripts/seedStreetViews.mjs --clear # delete all legacy==true street views
//   node scripts/seedStreetViews.mjs --limit=5   # seed only the first N (smoke test)
import {readFileSync} from 'node:fs';
import {initializeApp, cert} from 'firebase-admin/app';
import {getFirestore, GeoPoint} from 'firebase-admin/firestore';

const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
initializeApp({credential: cert(sa)});
const db = getFirestore();

const INDEX_URL = 'https://intofuture.org/telelab/streetview/index.json';
const BASE = 'https://intofuture.org/telelab/streetview';
const HEAD_BYTES = 524288; // 512 KB — enough to hold the front-loaded moov box

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

// ---- minimal MP4 box walker to pull moov/meta keys+ilst (azimuth/pitch) -----
function fourcc(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
function boxes(buf, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = fourcc(buf, off + 4);
    let hlen = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); hlen = 16; }
    else if (size === 0) size = end - off;
    if (size < hlen || off + size > end) break;
    out.push({type, start: off, size, dataStart: off + hlen, dataEnd: off + size});
    off += size;
  }
  return out;
}
function findChild(buf, box, want) {
  let cs = box.dataStart;
  if (box.type === 'meta') { // ISO FullBox variant carries a 4-byte version/flags
    const t1 = fourcc(buf, box.dataStart + 4);
    if (!['hdlr', 'keys', 'ilst', 'mhdr'].includes(t1)) cs = box.dataStart + 4;
  }
  return boxes(buf, cs, box.dataEnd).find(b => b.type === want) ?? null;
}
function extractOrientation(buf) {
  const moov = boxes(buf, 0, buf.length).find(b => b.type === 'moov');
  if (!moov) return null;
  const meta = boxes(buf, moov.dataStart, moov.dataEnd).find(b => b.type === 'meta');
  if (!meta) return null;
  const keysBox = findChild(buf, meta, 'keys');
  const ilstBox = findChild(buf, meta, 'ilst');
  if (!keysBox || !ilstBox) return null;
  const keyNames = [];
  let off = keysBox.dataStart + 4;
  const count = buf.readUInt32BE(off); off += 4;
  for (let i = 0; i < count; i++) {
    const sz = buf.readUInt32BE(off);
    keyNames.push(buf.toString('utf8', off + 8, off + sz));
    off += sz;
  }
  const out = {};
  for (const it of boxes(buf, ilstBox.dataStart, ilstBox.dataEnd)) {
    const keyIndex = buf.readUInt32BE(it.start + 4); // item type == 1-based key index
    const name = keyNames[keyIndex - 1];
    const data = boxes(buf, it.dataStart, it.dataEnd).find(b => b.type === 'data');
    if (!name || !data) continue;
    const typeInd = buf.readUInt32BE(data.dataStart);
    const ps = data.dataStart + 8, pe = data.dataEnd, len = pe - ps;
    if (typeInd === 1) out[name] = buf.toString('utf8', ps, pe);
    else if (typeInd === 23 && len === 4) out[name] = buf.readFloatBE(ps);
    else if (typeInd === 24 && len === 8) out[name] = buf.readDoubleBE(ps);
    else if (typeInd === 24 && len % 8 === 0) {
      const arr = [];
      for (let p = ps; p + 8 <= pe; p += 8) arr.push(buf.readDoubleBE(p));
      out[name] = arr;
    }
  }
  return out;
}
async function fetchOrientation(mp4Url) {
  // Try a ranged head first (moov is front-loaded); fall back to the full file.
  try {
    const r = await fetch(mp4Url, {headers: {Range: `bytes=0-${HEAD_BYTES - 1}`}});
    if (r.ok || r.status === 206) {
      const o = extractOrientation(Buffer.from(await r.arrayBuffer()));
      if (o && Array.isArray(o.azimuth)) return o;
    }
  } catch { /* fall through to full */ }
  const r2 = await fetch(mp4Url);
  if (!r2.ok) throw new Error(`mp4 HTTP ${r2.status}`);
  return extractOrientation(Buffer.from(await r2.arrayBuffer()));
}

async function clearLegacy() {
  const snap = await db.collection('streetviews').where('legacy', '==', true).get();
  let batch = db.batch(), n = 0;
  for (const d of snap.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); } }
  if (n % 400 !== 0) await batch.commit();
  console.log('deleted', n, 'legacy street views');
}

// bounded-concurrency map
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function seed(limit) {
  let entries = await (await fetch(INDEX_URL)).json();
  entries = entries.filter(e => typeof e.latitude === 'number' && typeof e.longitude === 'number' && e.url);
  if (limit) entries = entries.slice(0, limit);
  console.log('legacy entries:', entries.length, '— fetching mp4 orientation metadata…');

  let ok = 0, noMeta = 0, failed = 0;
  const docs = await mapLimit(entries, 6, async (e) => {
    const mp4Url = `${BASE}/${e.url}`;
    let azimuth = null, pitch = null, timestamp = null;
    try {
      const o = await fetchOrientation(mp4Url);
      if (o && Array.isArray(o.azimuth)) {
        azimuth = o.azimuth.map(v => Math.round(v * 100) / 100);
        pitch = Array.isArray(o.pitch) ? o.pitch.map(v => Math.round(v * 100) / 100) : [];
        const t = Number(o.timestamp);
        if (Number.isFinite(t) && t > 0) timestamp = t;
        ok++;
      } else { noMeta++; }
    } catch (err) { failed++; console.warn('  meta fail', e.url, err.message); }
    const neighbors = Array.isArray(e.neighbors)
      ? e.neighbors
          .filter(nb => nb && typeof nb.azimuth === 'number' && typeof nb.link === 'string')
          .map(nb => ({azimuthDeg: nb.azimuth, svId: slug(nb.link)}))
      : [];
    return {e, azimuth, pitch, timestamp, neighbors};
  });

  const now = new Date();
  // Which of these already exist decides what we are allowed to overwrite (see the header).
  const existing = new Set(
    (await db.collection('streetviews').where('legacy', '==', true).select().get()).docs.map(d => d.id),
  );
  // State that belongs to the live site, not to the bake: moderation verdicts and the
  // counters the aggregate triggers maintain.
  const PRESERVE_ON_EXISTING = ['visibility', 'trash', 'ratingSum', 'ratingCount', 'viewCount', 'commentCount'];
  let preserved = 0;
  let batch = db.batch(), n = 0;
  for (const {e, azimuth, pitch, timestamp, neighbors} of docs) {
    const created = timestamp ? new Date(timestamp) : now;
    const doc = {
      sourceType: 'pano', ownerId: 'system', visibility: 'public',
      location: new GeoPoint(e.latitude, e.longitude),
      geohash: geohash(e.latitude, e.longitude),
      displayName: e.address || e.town || 'Street View',
      author: [e.town, e.state].filter(Boolean).join(', '),
      description: [e.address, e.town, e.state, e.country].filter(Boolean).join(', '),
      thermalUnit: 'celsius', palette: 'inferno',
      // Per-frame orientation extracted from the mp4 (empty when unavailable).
      azimuthDeg: azimuth ?? [], pitchDeg: pitch ?? [],
      frameCount: azimuth ? azimuth.length : 0,
      neighbors,
      virUrl: `${BASE}/${e.url.replace(/\.mp4$/, '.vir')}`,
      legacy: true, date: created, createdAt: created, trash: false,
      ratingSum: 0, ratingCount: 0, viewCount: 0, commentCount: 0,
    };
    const id = slug(e.url);
    if (existing.has(id)) {
      for (const key of PRESERVE_ON_EXISTING) delete doc[key];
      preserved += 1;
    }
    batch.set(db.collection('streetviews').doc(id), doc, {merge: true});
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  if (n % 400 !== 0) await batch.commit();
  const q = await db.collection('streetviews').where('visibility', '==', 'public').where('trash', '==', false).get();
  console.log(`seeded ${n} (${preserved} already existed — visibility/trash/counters left alone) | orientation ok=${ok} no-meta=${noMeta} failed=${failed} | public && !trash now: ${q.size}`);
}

const clear = process.argv.includes('--clear');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;
(clear ? clearLegacy() : seed(limit))
  .then(() => process.exit(0))
  .catch((e) => { console.error('ERR', e.message); process.exit(1); });
