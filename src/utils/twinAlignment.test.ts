import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALIGN_H,
  ALIGN_W,
  MIN_CONTRAST,
  alignmentReport,
  alignmentSentence,
  overlayRgba,
  partInstances,
  segmentThermal,
} from './twinAlignment';

// ---- fixtures: a warm bench with cold discs, as the ice-and-salt recording reads ------------------------

const W = ALIGN_W;
const H = ALIGN_H;

function disc(grid: Float32Array | Uint16Array, cx: number, cy: number, r: number, value: number, rIn = 0) {
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const d2 = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
      if (d2 <= r * r && d2 >= rIn * rIn) grid[y * W + x] = value;
    }
}

/** A 22 °C bench with a little noise and cold discs at the given places. */
function frame(discs: [number, number, number][], noise = 0.3): Float32Array {
  const t = new Float32Array(W * H);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * noise;
  for (let k = 0; k < W * H; k++) t[k] = 22 + rnd();
  for (const [cx, cy, r] of discs) disc(t, cx, cy, r, 3);
  return t;
}

/** The ID image of a model: a bench part under everything, discs as parts 2.. */
function model(discs: [number, number, number][], bench = true): { mask: Uint16Array; names: string[] } {
  const mask = new Uint16Array(W * H);
  const names = ['', 'bench'];
  if (bench) mask.fill(1);
  discs.forEach(([cx, cy, r], i) => {
    disc(mask, cx, cy, r, i + 2);
    names.push(`dish${i + 1}`);
  });
  return { mask, names };
}

const DISCS: [number, number, number][] = [
  [58.5, 46.8, 25],
  [58.2, 114.3, 25.5],
];

const report = (t: Float32Array, m: { mask: Uint16Array; names: string[] }) =>
  alignmentReport(segmentThermal(t), partInstances(m.mask, m.names));

// ---- segmentThermal ------------------------------------------------------------------------------------

describe('segmentThermal', () => {
  it('finds the cold discs on a warm bench, largest first', () => {
    const s = segmentThermal(frame(DISCS));
    assert.equal(s.polarity, 'cold');
    assert.ok(s.contrast > MIN_CONTRAST, `contrast ${s.contrast}`);
    assert.equal(s.blobs.length, 2);
    assert.ok(s.blobs[0].area >= s.blobs[1].area);
    const lower = s.blobs.find((b) => b.cy > 80)!;
    assert.ok(Math.abs(lower.cx - 58.2) < 0.6 && Math.abs(lower.cy - 114.3) < 0.6, `${lower.cx}, ${lower.cy}`);
    assert.ok(Math.abs(lower.rEq - 25.5) < 0.6, `rEq ${lower.rEq}`);
    assert.ok(Math.abs(lower.meanC - 3) < 0.1);
    // Labels agree with the blobs' areas.
    let n = 0;
    for (const l of s.labels) if (l === lower.id) n++;
    assert.equal(n, lower.area);
  });
  it('reads a hot object on a cold bench the other way round', () => {
    const t = frame([]);
    for (let k = 0; k < t.length; k++) t[k] = 18;
    disc(t, 60, 80, 20, 60);
    const s = segmentThermal(t);
    assert.equal(s.polarity, 'hot');
    assert.equal(s.blobs.length, 1);
    assert.ok(Math.abs(s.blobs[0].cx - 60) < 0.6);
  });
  it('is inconclusive on a bench of one temperature, noise or not', () => {
    const noisy = segmentThermal(frame([], 0.3));
    assert.equal(noisy.blobs.length, 0);
    assert.match(noisy.weak!, /stands apart from the bench/);
    const flat = segmentThermal(frame([], 0));
    assert.equal(flat.blobs.length, 0);
    assert.ok(flat.weak);
  });
  it('is inconclusive on a gradient across the bench', () => {
    const t = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) t[y * W + x] = 18 + (6 * y) / H;
    const s = segmentThermal(t);
    assert.equal(s.blobs.length, 0);
    assert.match(s.weak!, /no distinct objects/);
  });
  it('separates two flat classes without a spread of their own', () => {
    const t = new Float32Array(W * H).fill(22);
    disc(t, 60, 80, 20, 3);
    const s = segmentThermal(t);
    assert.equal(s.contrast, Infinity);
    assert.equal(s.blobs.length, 1);
  });
  it('ignores masked pixels and specks', () => {
    const t = frame(DISCS);
    for (let y = 0; y < 10; y++) for (let x = 0; x < W; x++) t[y * W + x] = NaN; // a sky band
    t[80 * W + 5] = 3; // one cold speck
    const s = segmentThermal(t);
    assert.equal(s.readable, W * H - 10 * W);
    assert.equal(s.blobs.length, 2);
  });
});

// ---- partInstances -------------------------------------------------------------------------------------

describe('partInstances', () => {
  it('names each piece, flags the bench as background, cuts a part that spans two places in two', () => {
    const { mask, names } = model(DISCS);
    // Both dishes as ONE part, as a model may write them.
    for (let k = 0; k < mask.length; k++) if (mask[k] === 3) mask[k] = 2;
    const m = partInstances(mask, ['', 'bench', 'ice']);
    assert.deepEqual(
      m.instances.map((p) => [p.name, p.instance, p.background]),
      [
        ['bench', 1, true],
        ['ice', 1, false],
        ['ice', 2, false],
      ],
    );
    assert.ok(m.instances[1].area >= m.instances[2].area); // largest first within a part
    assert.ok(Math.abs(m.instances[2].cx - 58.5) < 0.6);
    assert.equal(names.length, 4);
    let n = 0;
    for (const l of m.labels) if (l === 2) n++;
    assert.equal(n, m.instances[1].area);
  });
});

// ---- alignmentReport -----------------------------------------------------------------------------------

describe('alignmentReport', () => {
  it('passes a model built where the frame shows the discs', () => {
    const r = report(frame(DISCS), model(DISCS));
    assert.equal(r.verdict, 'pass', JSON.stringify(r.objects.map((o) => [o.iou, o.centroidErrPx, o.areaRatio])));
    assert.equal(r.objects.length, 2);
    assert.ok(r.objects.every((o) => o.instances.length === 1 && o.iou > 0.9 && o.centroidErrPx < 1));
    assert.ok(r.worstCentroidPx < 1);
    assert.deepEqual(r.shared, []);
    assert.match(alignmentSentence(r), /^Aligned: 2 of 2 objects within/);
  });
  it('takes a dish of several parts — base, rim and ice — as one object', () => {
    const mask = new Uint16Array(W * H).fill(1);
    const names = ['', 'bench', 'dishPlastic', 'iceSamples'];
    for (const [cx, cy, r] of DISCS) {
      disc(mask, cx, cy, r, 2); // the dish's base and rim
      disc(mask, cx, cy, r - 3, 3); // the ice inside
    }
    const r = alignmentReport(segmentThermal(frame(DISCS)), partInstances(mask, names));
    assert.equal(r.verdict, 'pass', alignmentSentence(r));
    for (const o of r.objects) {
      assert.deepEqual(o.parts.sort(), ['dishPlastic', 'iceSamples']);
      assert.equal(o.instances.length, 2);
      assert.ok(o.iou > 0.9, `iou ${o.iou}`);
    }
    assert.deepEqual(r.extra, []);
    // Each part spans both dishes: said, not penalised.
    assert.deepEqual(r.shared.map((s) => [s.name, s.objects]).sort(), [
      ['dishPlastic', 2],
      ['iceSamples', 2],
    ]);
    assert.match(
      alignmentSentence(r),
      /^Aligned: 2 of 2 objects within 0\.\d px; iceSamples is one part over 2 objects, dishPlastic is one part over 2 objects\.$/,
    );
  });
  it('fails a model whose discs are too large and off to one side', () => {
    const r = report(
      frame(DISCS),
      model([
        [66, 46.8, 31],
        [66, 114.3, 31],
      ]),
    );
    assert.equal(r.verdict, 'fail');
    assert.equal(r.objects.length, 2);
    for (const o of r.objects) {
      assert.equal(o.instances.length, 1, 'still matched');
      assert.ok(o.centroidErrPx > 6, `err ${o.centroidErrPx}`);
      assert.ok(o.areaRatio > 1.4, `ratio ${o.areaRatio}`);
      assert.equal(o.pass, false);
    }
    assert.match(alignmentSentence(r), /^Misaligned: 2 of 2 objects within 7\.\d px\.$/);
  });
  it('reports an object the model lacks and a part the frame lacks', () => {
    const r = report(
      frame(DISCS),
      model([
        [58.5, 46.8, 25],
        [20, 140, 10],
      ]),
    );
    assert.equal(r.verdict, 'fail');
    assert.equal(r.missing.length, 1);
    assert.ok(r.missing[0].cy > 80);
    assert.deepEqual(
      r.extra.map((p) => p.name),
      ['dish2'],
    );
    assert.match(
      alignmentSentence(r),
      /1 with nothing under it on the model; 1 part with nothing under it in the frame/,
    );
  });
  it('is inconclusive without contrast, and without a part besides the bench', () => {
    const r1 = report(frame([]), model(DISCS));
    assert.equal(r1.verdict, 'inconclusive');
    assert.match(alignmentSentence(r1), /^Alignment not checked: nothing in the frame stands apart/);
    const r2 = report(frame(DISCS), model([]));
    assert.equal(r2.verdict, 'inconclusive');
    assert.match(r2.reason!, /no part besides the bench/);
  });
});

// ---- overlayRgba ---------------------------------------------------------------------------------------

describe('overlayRgba', () => {
  it('paints agreement purple, the frame alone red, the model alone blue, the bench grey', () => {
    const s = segmentThermal(frame(DISCS));
    const m = model([
      [58.5, 46.8, 25],
      [90, 114.3, 25.5],
    ]);
    const px = overlayRgba(s, partInstances(m.mask, m.names));
    const at = (x: number, y: number) => Array.from(px.subarray((y * W + x) * 4, (y * W + x) * 4 + 3));
    assert.deepEqual(at(58, 46), [170, 60, 200]); // both
    assert.deepEqual(at(40, 114), [230, 70, 70]); // the frame's lower disc, which the model put to the right
    assert.deepEqual(at(110, 114), [70, 120, 230]); // the model's
    assert.deepEqual(at(5, 5), [40, 40, 40]); // the bench
  });
});
