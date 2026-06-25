// READ-ONLY diagnosis: why do migrated users show today's date as "Join Date"?
// Classifies every Atlas user by whether createdAt is present+parseable, missing,
// or present-but-unparseable, and compares against the ObjectId-embedded timestamp.
//   ATLAS_URI='mongodb+srv://...' node scripts/diagnoseUserCreatedAt.mjs
import { connectAtlas, toTimestamp, oid, oidDate } from './migrationLib.mjs';

const { client, db: m } = await connectAtlas();
const users = await m.collection('users').find({}, { projection: { createdAt: 1, email: 1 } }).toArray();
await client.close();

let ok = 0, missing = 0, unparseable = 0;
const samplesMissing = [], samplesUnparseable = [];

for (const u of users) {
  const has = u.createdAt != null;
  const parsed = toTimestamp(u.createdAt);
  if (parsed) { ok++; continue; }
  const od = oidDate(u._id);
  const row = { id: oid(u._id), email: u.email, rawCreatedAt: u.createdAt, type: typeof u.createdAt, oidDate: od?.toISOString() ?? null };
  if (!has) { missing++; if (samplesMissing.length < 8) samplesMissing.push(row); }
  else { unparseable++; if (samplesUnparseable.length < 8) samplesUnparseable.push(row); }
}

console.log('\n==== user createdAt diagnosis ====');
console.log(`total users:                 ${users.length}`);
console.log(`createdAt present+parseable:  ${ok}`);
console.log(`createdAt MISSING:            ${missing}  -> migration used serverTimestamp() = "today"`);
console.log(`createdAt UNPARSEABLE:        ${unparseable}  -> same fallback`);
console.log(`would-be-synthetic total:    ${missing + unparseable}`);
if (samplesMissing.length) {
  console.log('\n-- samples: MISSING createdAt (ObjectId date is the real signup time) --');
  for (const r of samplesMissing) console.log(`   ${r.id}  ${r.email}  oidDate=${r.oidDate}`);
}
if (samplesUnparseable.length) {
  console.log('\n-- samples: UNPARSEABLE createdAt --');
  for (const r of samplesUnparseable) console.log(`   ${r.id}  ${r.email}  raw=${JSON.stringify(r.rawCreatedAt)} (${r.type})  oidDate=${r.oidDate}`);
}
process.exit(0);
