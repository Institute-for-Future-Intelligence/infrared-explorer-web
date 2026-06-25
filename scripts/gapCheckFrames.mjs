// Read-only: find non-trash FB experiments whose recording has 0 frames in Storage,
// then classify each gap as restorable (telelab2 has it) or permanently lost.
import { connectAtlas, getFb, oid } from './migrationLib.mjs';
const { db, bucket } = getFb();
const BASE='https://telelab2.intofuture.org/public/episodes';

const exp = await db.collection('experiments').where('sourceType','==','recording').get();
const recToClips = new Map();
let nonTrash=0;
for (const d of exp.docs){ const e=d.data(); if(e.trash) continue; if(!e.recordingId) continue; nonTrash++;
  (recToClips.get(e.recordingId)??recToClips.set(e.recordingId,[]).get(e.recordingId)).push({id:d.id, isRaw:e.isRaw, segs:e.segments}); }
console.log(`non-trash recording-clips: ${nonTrash}  distinct recordings: ${recToClips.size}`);

// which recordings have frames in storage
const gaps=[];
let withFrames=0;
for (const rec of recToClips.keys()){
  const [files]=await bucket.getFiles({ prefix:`recordings/${rec}/`, maxResults:1 });
  if (files.length) withFrames++; else gaps.push(rec);
}
console.log(`recordings WITH frames: ${withFrames}  GAPS (0 frames): ${gaps.length}`);

// classify gaps via telelab2 + atlas lastFrameNumber
const { client, db:m } = await connectAtlas();
const { ObjectId } = await import('mongodb');
const recDocs = await m.collection('recordings').find({_id:{$in:gaps.map(g=>{try{return new ObjectId(g)}catch{return g}})}}).project({lastFrameNumber:1}).toArray();
await client.close();
const lastFrame = new Map(recDocs.map(r=>[oid(r._id), r.lastFrameNumber||0]));

const restorable=[], lost=[];
for (const rec of gaps){
  let ok=false;
  try{ const r=await fetch(`${BASE}/${rec}/data_1.png`,{method:'HEAD',signal:AbortSignal.timeout(15000)}); ok=r.ok; }catch{}
  (ok?restorable:lost).push({rec, clips:recToClips.get(rec).length, lastFrame:lastFrame.get(rec)??'?'});
}
console.log(`\nGAPS restorable (telelab2 has them): ${restorable.length}`);
for (const g of restorable) console.log(`  ${g.rec} clips=${g.clips} lastFrame=${g.lastFrame}`);
console.log(`GAPS permanently lost (telelab2 404): ${lost.length}`);
for (const g of lost) console.log(`  ${g.rec} clips=${g.clips}`);
process.exit(0);
