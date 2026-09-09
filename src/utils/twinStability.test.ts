import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STABLE_MAX_SHIFT_PX,
  alignFrame,
  assessStability,
  estimateShift,
  frameSimilarity,
  highPass,
  stabilitySampleIndices,
} from './twinStability';

const W = 120;
const H = 160;

/** A synthetic thermal scene: a warm blob, a hot bar and a cool patch on a 22 °C background. */
function scene(): Float32Array {
  const f = new Float32Array(W * H).fill(22);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d1 = Math.hypot(x - 45, y - 70) / 14;
      const d2 = Math.hypot(x - 80, y - 110) / 9;
      let t = 22 + 30 * Math.exp(-d1 * d1) + 18 * Math.exp(-d2 * d2);
      if (y > 30 && y < 36 && x > 20 && x < 100) t = 60;
      if (x > 90 && x < 110 && y > 20 && y < 50) t = 10;
      f[y * W + x] = t;
    }
  }
  return f;
}

/** b(x, y) = a(x − dx, y − dy), background where the source is out of range. */
function shifted(a: Float32Array, dx: number, dy: number): Float32Array {
  const b = new Float32Array(W * H).fill(22);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = x - dx;
      const sy = y - dy;
      if (sx >= 0 && sx < W && sy >= 0 && sy < H) b[y * W + x] = a[sy * W + sx];
    }
  }
  return b;
}

describe('stabilitySampleIndices', () => {
  it('samples every frame of a short clip and spreads the cap over a long one', () => {
    assert.deepEqual(stabilitySampleIndices(12), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(stabilitySampleIndices(120).length, 120);
    const long = stabilitySampleIndices(5000);
    assert.ok(long.length <= 121 && long[0] === 1 && long[long.length - 1] === 5000);
    assert.equal(long[1] - long[0], 42);
    assert.deepEqual(stabilitySampleIndices(0), []);
  });
});

describe('estimateShift', () => {
  it('recovers an integer shift of a high-passed scene', () => {
    const a = highPass(scene(), W, H);
    const b = highPass(shifted(scene(), 3, -2), W, H);
    const e = estimateShift(a, b, W, H);
    assert.ok(Math.abs(e.dx - 3) < 0.35, `dx=${e.dx}`);
    assert.ok(Math.abs(e.dy + 2) < 0.35, `dy=${e.dy}`);
    assert.ok(e.score > 0.8, `score=${e.score}`);
  });

  it('reports zero for an identical frame and ignores a global level change', () => {
    const s = scene();
    const warmer = s.map((v) => v + 4);
    const e = estimateShift(highPass(s, W, H), highPass(warmer, W, H), W, H);
    assert.ok(Math.abs(e.dx) < 0.05 && Math.abs(e.dy) < 0.05);
    assert.ok(e.score > 0.99);
  });

  it('gives a weak score for a featureless frame', () => {
    const flat = new Float32Array(W * H).fill(22);
    const noise = flat.map((v, i) => v + ((i * 7919) % 13) * 0.01);
    const e = estimateShift(highPass(flat, W, H), highPass(noise, W, H), W, H);
    assert.ok(e.score < 0.25, `score=${e.score}`);
  });

  it('searches around a given centre', () => {
    const a = highPass(scene(), W, H);
    const b = highPass(shifted(scene(), 9, -7), W, H);
    const e = estimateShift(a, b, W, H, 2, 1, { dx: 10, dy: -8 });
    assert.ok(Math.abs(e.dx - 9) < 0.2, `dx=${e.dx}`);
    assert.ok(Math.abs(e.dy + 7) < 0.2, `dy=${e.dy}`);
  });
});

describe('alignFrame', () => {
  it('recovers a drift well beyond the consecutive-pair window', () => {
    const a = highPass(scene(), W, H);
    const b = highPass(shifted(scene(), -10, 8), W, H);
    const e = alignFrame(a, b, W, H);
    assert.ok(Math.abs(e.dx + 10) < 0.2, `dx=${e.dx}`);
    assert.ok(Math.abs(e.dy - 8) < 0.2, `dy=${e.dy}`);
    assert.ok(e.score > 0.8, `score=${e.score}`);
  });

  it('reports a drift past the limit as past the limit, not as the window edge', () => {
    const a = highPass(scene(), W, H);
    const b = highPass(shifted(scene(), STABLE_MAX_SHIFT_PX + 2, 0), W, H);
    const e = alignFrame(a, b, W, H);
    assert.ok(e.dx > STABLE_MAX_SHIFT_PX + 1.5, `dx=${e.dx}`);
  });
});

describe('frameSimilarity', () => {
  it('is ~1 for the same scene at a different level and drops when the scene changes', () => {
    const s = scene();
    const warmer = s.map((v) => v + 6);
    assert.ok(frameSimilarity(s, warmer) > 0.99);
    // Take the hot bar away and move the blob: a different arrangement.
    const changed = new Float32Array(W * H).fill(22);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const d = Math.hypot(x - 90, y - 40) / 14;
        changed[y * W + x] = 22 + 30 * Math.exp(-d * d);
      }
    assert.ok(frameSimilarity(s, changed) < 0.5);
  });
});

describe('assessStability', () => {
  it('passes a still clip and picks a middle-ish reference', () => {
    const s = scene();
    const samples = [1, 6, 11, 16, 21].map((index) => ({ index, temps: s }));
    const r = assessStability(samples);
    assert.equal(r.stable, true);
    assert.equal(r.maxShiftPx, 0);
    assert.equal(r.sampled, 5);
    assert.equal(r.referenceIndex, 11);
  });

  it('fails a clip that pans away and points the reference away from the jump', () => {
    const s = scene();
    const samples = [
      { index: 1, temps: s },
      { index: 6, temps: s },
      { index: 11, temps: s },
      { index: 16, temps: shifted(s, STABLE_MAX_SHIFT_PX + 3, 0) },
      { index: 21, temps: shifted(s, STABLE_MAX_SHIFT_PX + 3, 0) },
    ];
    const r = assessStability(samples);
    assert.equal(r.stable, false, JSON.stringify(r));
    assert.ok(r.maxShiftPx >= STABLE_MAX_SHIFT_PX + 2.5, `max=${r.maxShiftPx}`);
    assert.ok([1, 6, 11, 21].includes(r.referenceIndex));
    assert.notEqual(r.referenceIndex, 16);
  });

  it('passes a hand-held wobble and a nudged stand, reporting the drift from the reference', () => {
    const s = scene();
    const wobble = [
      { index: 1, temps: s },
      { index: 6, temps: shifted(s, 2, -1) },
      { index: 11, temps: shifted(s, 3, 2) },
      { index: 16, temps: shifted(s, 0, 3) },
    ];
    const w = assessStability(wobble);
    assert.equal(w.stable, true, JSON.stringify(w));
    assert.ok(w.maxShiftPx >= 2 && w.maxShiftPx <= 4.5, `max=${w.maxShiftPx}`);

    // One bump part-way through, then still again: the drift from the reference is the bump itself.
    const nudged = [
      { index: 1, temps: s },
      { index: 6, temps: s },
      { index: 11, temps: s },
      { index: 16, temps: shifted(s, 8, 1) },
      { index: 21, temps: shifted(s, 8, 1) },
    ];
    const n = assessStability(nudged);
    assert.equal(n.stable, true, JSON.stringify(n));
    assert.ok(n.maxShiftPx >= 7.5 && n.maxShiftPx <= 8.6, `max=${n.maxShiftPx}`);
  });

  it('measures drift from the reference, not between neighbours, so a slow creep adds up', () => {
    const s = scene();
    // 3 px per sample, monotonic: neighbours only ever differ by 3, but the ends sit 12 apart.
    const creep = [0, 3, 6, 9, 12].map((d, i) => ({ index: 1 + 5 * i, temps: shifted(s, d, 0) }));
    const r = assessStability(creep);
    assert.ok(r.maxShiftPx >= 5.5, `max=${r.maxShiftPx}`);
    assert.equal(r.stable, r.maxShiftPx <= STABLE_MAX_SHIFT_PX);
  });

  it('handles the degenerate sample counts', () => {
    assert.equal(assessStability([]).stable, false);
    const one = assessStability([{ index: 7, temps: scene() }]);
    assert.equal(one.stable, true);
    assert.equal(one.referenceIndex, 7);
  });
});
