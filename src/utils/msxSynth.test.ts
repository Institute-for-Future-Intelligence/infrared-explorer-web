import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MSX_PARAMS,
  LUMA,
  MSX_LIMIT,
  MSX_LOW_FLOOR,
  MSX_MIN_DIFF,
  MsxParams,
  blendPixels,
  ringStep,
} from './msxSynth';

const W = 37; // odd, and not a multiple of anything, so the separable indexing has no lucky alignment
const H = 23;

/** The recipe written the plain way (the app's blendPixels with the ring's taps `step` apart): a 25-tap
 *  loop with clamped sampling. The website's version runs the same arithmetic as two 5-tap passes over a
 *  padded frame; this is what it is held to. */
function reference(ir: Uint8Array, vis: Uint8Array, w: number, h: number, params: MsxParams, step: number): Uint8Array {
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = (vis[i * 4] * LUMA[0] + vis[i * 4 + 1] * LUMA[1] + vis[i * 4 + 2] * LUMA[2]) / 255;
  }
  const at = (x: number, y: number): number =>
    lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const out = new Uint8Array(ir.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) sum += at(x + i * step, y + j * step);
      const centre = at(x, y);
      const low = (sum - centre) / 24;
      const hp = Math.abs(centre - low) < MSX_MIN_DIFF ? 0 : (centre - low) / Math.max(low, MSX_LOW_FLOOR);
      const gated = Math.sign(hp) * Math.max(Math.abs(hp) - params.threshold, 0);
      const d = Math.min(MSX_LIMIT, Math.max(-MSX_LIMIT, params.strength * gated));
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(Math.min(1, Math.max(0, ir[i + c] / 255 + d)) * 255);
      out[i + 3] = ir[i + 3];
    }
  }
  return out;
}

/** Deterministic noise (a small LCG) so a failure reproduces. */
function noise(seed: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

function solid(r: number, g: number, b: number): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) out.set([r, g, b, 255], i * 4);
  return out;
}

describe('ringStep', () => {
  it('spaces the ring by the frame width, never under a pixel', () => {
    assert.equal(ringStep(1080), 4);
    assert.equal(ringStep(480), 2);
    assert.equal(ringStep(2160), 8);
    assert.equal(ringStep(10), 1);
  });
});

describe('blendPixels', () => {
  it('matches the plain 25-tap reference pixel for pixel, at several settings and ring spacings', () => {
    const ir = noise(1, W * H * 4);
    const vis = noise(2, W * H * 4);
    const settings: MsxParams[] = [
      DEFAULT_MSX_PARAMS,
      { strength: 0, threshold: 0 },
      { strength: 5, threshold: 0.4 },
      { strength: 1, threshold: 0 },
    ];
    for (const step of [1, 3, 6, 12]) {
      for (const p of settings) {
        const got = blendPixels(ir, vis, W, H, p, step);
        const want = reference(ir, vis, W, H, p, step);
        // The two sum the same 25 values in a different order, so the float32 totals may land a hair
        // apart, which after the gate, gain and rounding is at most one byte step.
        let worst = 0;
        for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
        assert.ok(worst <= 1, `step ${step} strength ${p.strength} threshold ${p.threshold}: differs by ${worst}`);
      }
    }
  });

  it('uses ringStep(w) when no step is given', () => {
    const ir = noise(5, W * H * 4);
    const vis = noise(6, W * H * 4);
    assert.deepEqual(blendPixels(ir, vis, W, H), blendPixels(ir, vis, W, H, DEFAULT_MSX_PARAMS, ringStep(W)));
  });

  it('leaves the infrared alone where the visible frame is flat, and keeps its alpha', () => {
    const ir = noise(3, W * H * 4);
    const vis = solid(90, 120, 200);
    const got = blendPixels(ir, vis, W, H);
    assert.deepEqual(Array.from(got), Array.from(ir));
  });

  it('draws relief at an edge: brighter on the light side, darker on the dark side, within the limit', () => {
    const ir = solid(128, 128, 128);
    const vis = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = x < W / 2 ? 40 : 220;
        vis.set([v, v, v, 255], (y * W + x) * 4);
      }
    }
    const step = 2;
    const got = blendPixels(ir, vis, W, H, { strength: 5, threshold: 0 }, step);
    const edge = Math.ceil(W / 2); // the first light column
    const px = (x: number, y: number) => got[(y * W + x) * 4];
    const y = Math.floor(H / 2);
    assert.ok(px(edge, y) > 128, 'the light side of the edge is lifted');
    assert.ok(px(edge - 1, y) < 128, 'the dark side of the edge is lowered');
    // A pixel 2·step − 1 in from the edge still has one column of taps on the dark side; one more and
    // every tap is light again.
    assert.ok(px(edge + 2 * step - 1, y) > 128, 'the relief reaches the ring radius');
    assert.equal(px(edge + 2 * step, y), 128, 'and stops there');
    assert.equal(px(2, y), 128, 'far from the edge nothing changes');
    assert.equal(px(W - 3, y), 128, 'far from the edge nothing changes');
    for (let i = 0; i < got.length; i += 4) {
      assert.ok(Math.abs(got[i] / 255 - 128 / 255) <= MSX_LIMIT + 1 / 255, 'a line never adds more than the limit');
    }
  });

  it('ignores a luminance ripple under the absolute gate however dark the surround is', () => {
    // A near-black wall with JPEG grain: a ripple of ±0.01 on a 0.05 base. The contrast (÷ the floor)
    // would pass the threshold; the absolute gate must not.
    const ir = solid(30, 30, 30);
    const vis = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const v = Math.round(255 * (0.05 + ((i * 7919) % 3 === 0 ? 0.01 : -0.005)));
      vis.set([v, v, v, 255], i * 4);
    }
    const got = blendPixels(ir, vis, W, H, { strength: 5, threshold: 0 }, 1);
    assert.deepEqual(Array.from(got), Array.from(ir));
  });

  it('refuses buffers of the wrong size, and a ring spacing that is not whole pixels', () => {
    assert.throws(() => blendPixels(new Uint8Array(4), new Uint8Array(8), 1, 1));
    assert.throws(() => blendPixels(new Uint8Array(4), new Uint8Array(4), 1, 1, DEFAULT_MSX_PARAMS, 0));
    assert.throws(() => blendPixels(new Uint8Array(4), new Uint8Array(4), 1, 1, DEFAULT_MSX_PARAMS, 1.5));
  });
});
