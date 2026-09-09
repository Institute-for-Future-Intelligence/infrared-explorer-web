import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateRegistration,
  gradientMagnitude,
  grayFromRgba,
  nccShift,
  normalizeEdges,
  resampleGray,
  shiftGray,
  type Gray,
} from './twinRegistration';

const W = 120;
const H = 160;

/** A synthetic lab photo at a given size: a bright "beaker" rectangle, a dark "burner" disc and a table
 *  edge, on a mid-grey wall. `shift` moves the content (in units of the target 120×160 grid). */
function visiblePhoto(width: number, height: number, shift: [number, number] = [0, 0]): Gray {
  const data = new Float32Array(width * height);
  const sx = width / W;
  const sy = height / H;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx = x / sx - shift[0];
      const gy = y / sy - shift[1];
      let v = 128;
      if (gy > 105) v = 160; // table
      if (gx > 40 && gx < 75 && gy > 45 && gy < 105) v = 220; // beaker
      if (Math.hypot(gx - 95, gy - 90) < 12) v = 40; // burner
      if (gx > 15 && gx < 30 && gy > 70 && gy < 100) v = 90; // a block
      data[y * width + x] = v;
    }
  }
  return { data, width, height };
}

/** The thermal view of the same scene: only the beaker and the burner have contrast; smooth. */
function thermalFrame(shift: [number, number]): Float32Array {
  const t = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = x - shift[0];
      const gy = y - shift[1];
      let v = 22;
      if (gx > 40 && gx < 75 && gy > 45 && gy < 105) v = 60;
      if (Math.hypot(gx - 95, gy - 90) < 12) v = 90;
      if (gx > 15 && gx < 30 && gy > 70 && gy < 100) v = 25; // the block is near ambient
      t[y * W + x] = v;
    }
  }
  return t;
}

describe('primitives', () => {
  it('converts RGBA to luma and resamples by area', () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      rgba[i * 4] = 255;
      rgba[i * 4 + 1] = 255;
      rgba[i * 4 + 2] = 255;
      rgba[i * 4 + 3] = 255;
    }
    const g = grayFromRgba(rgba, 4, 4);
    assert.ok(Math.abs(g.data[0] - 255) < 1e-6);
    const small = resampleGray(g, 2, 2);
    assert.equal(small.width, 2);
    assert.ok(Math.abs(small.data[3] - 255) < 1e-6);
  });

  it('finds edges only where the value changes, and normalises to unit variance', () => {
    const g: Gray = { data: new Float32Array(W * H).fill(10), width: W, height: H };
    for (let y = 0; y < H; y++) for (let x = 60; x < W; x++) g.data[y * W + x] = 50;
    const e = gradientMagnitude(g);
    assert.equal(e.data[80 * W + 20], 0);
    assert.ok(e.data[80 * W + 60] > 0);
    const n = normalizeEdges(e);
    let m = 0;
    for (let i = 0; i < n.data.length; i++) m += n.data[i];
    assert.ok(Math.abs(m / n.data.length) < 0.05);
  });

  it('nccShift recovers a known shift of an edge map', () => {
    const a = normalizeEdges(gradientMagnitude(visiblePhoto(W, H)));
    const b = shiftGray(a, 4, -3);
    const s = nccShift(a, b, 8);
    assert.ok(Math.abs(s.dx - 4) < 0.3 && Math.abs(s.dy + 3) < 0.3, JSON.stringify(s));
    assert.ok(s.score > 0.9);
  });
});

describe('estimateRegistration', () => {
  it('composes the SDK placement and the thermal residual from a full-size photo', () => {
    // The photo is 480×640 (4× the thermal grid); the SDK placed the visible edges 5 px right / 2 px
    // down of where the photo has them, and the thermal content sits a further 2 px right / 1 px down.
    const vis = visiblePhoto(480, 640);
    const mix = visiblePhoto(W, H, [5, 2]);
    const temps = thermalFrame([7, 3]);
    const r = estimateRegistration({ vis, mix, temps, width: W, height: H });
    assert.ok(r, 'no registration');
    assert.equal(r.method, 'vis-mix-thermal');
    assert.ok(Math.abs(r.dx - 7) < 0.75, `dx=${r.dx}`);
    assert.ok(Math.abs(r.dy - 3) < 0.75, `dy=${r.dy}`);
  });

  it('falls back to the direct visible↔thermal estimate without a blend', () => {
    const vis = visiblePhoto(480, 640);
    const temps = thermalFrame([-3, 2]);
    const r = estimateRegistration({ vis, mix: null, temps, width: W, height: H });
    assert.ok(r, 'no registration');
    assert.equal(r.method, 'vis-thermal');
    assert.ok(Math.abs(r.dx + 3) < 0.75 && Math.abs(r.dy - 2) < 0.75, JSON.stringify(r));
  });

  it('returns null when the thermal frame has nothing in common with the photo', () => {
    const vis = visiblePhoto(480, 640);
    const temps = new Float32Array(W * H);
    for (let i = 0; i < temps.length; i++) temps[i] = 22 + ((i * 7919) % 17) * 0.01; // noise only
    const r = estimateRegistration({ vis, mix: null, temps, width: W, height: H });
    assert.equal(r, null);
  });
});
