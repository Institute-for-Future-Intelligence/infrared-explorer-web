import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_PAINT_PALETTE,
  cubicWeights,
  normaliseTemperatures,
  paintRamp,
  paintRange,
  paintThermalRgba,
  paletteRamp,
  type PaletteRamp,
} from './thermalPaint';
import { PALETTE_COLORS } from './paletteData';

/** A ramp whose red channel IS the entry's index (green counts down), so a pixel says which entry it took. */
const indexRamp = (n: number): PaletteRamp => {
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = i;
    rgba[i * 4 + 1] = n - 1 - i;
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, length: n };
};

/**
 * The recipe written the long way — the 16-tap form of the capture app's reference
 * (thermalRenderParams.renderReference): the entry each output pixel takes.
 */
function referenceEntries(
  temps: ArrayLike<number>,
  gridW: number,
  gridH: number,
  min: number,
  max: number,
  n: number,
  outW: number,
  outH: number,
): number[] {
  const norm = normaliseTemperatures(temps, min, max);
  const cell = (cx: number, cy: number) =>
    norm[Math.min(gridH - 1, Math.max(0, cy)) * gridW + Math.min(gridW - 1, Math.max(0, cx))];
  const out: number[] = [];
  for (let py = 0; py < outH; py++) {
    const gy = ((py + 0.5) / outH) * gridH - 0.5;
    const by = Math.floor(gy);
    const wy = cubicWeights(gy - by);
    for (let px = 0; px < outW; px++) {
      const gx = ((px + 0.5) / outW) * gridW - 0.5;
      const bx = Math.floor(gx);
      const wx = cubicWeights(gx - bx);
      let v = 0;
      for (let j = 0; j < 4; j++) {
        let r = 0;
        for (let i = 0; i < 4; i++) r += wx[i] * cell(bx + i - 1, by + j - 1);
        v += wy[j] * r;
      }
      v = Math.min(1, Math.max(0, v));
      out.push(Math.min(n - 1, Math.floor(v * n)));
    }
  }
  return out;
}

describe('paletteRamp', () => {
  it("is the palette's table as RGBA bytes, cold end first", () => {
    const iron = paletteRamp('iron');
    assert.ok(iron);
    assert.equal(iron.length, PALETTE_COLORS.iron.length);
    assert.equal(iron.rgba.length, iron.length * 4);
    const first = parseInt(PALETTE_COLORS.iron[0].slice(1), 16);
    assert.deepEqual([...iron.rgba.slice(0, 4)], [(first >> 16) & 255, (first >> 8) & 255, first & 255, 255]);
    const lastHex = parseInt(PALETTE_COLORS.iron[iron.length - 1].slice(1), 16);
    assert.deepEqual(
      [...iron.rgba.slice((iron.length - 1) * 4)],
      [(lastHex >> 16) & 255, (lastHex >> 8) & 255, lastHex & 255, 255],
    );
  });

  it("takes a key as the doc writes it, and holds every palette the capture app's camera has", () => {
    assert.equal(paletteRamp(' Iron '), paletteRamp('iron'));
    for (const key of Object.keys(PALETTE_COLORS)) assert.ok(paletteRamp(key), key);
  });

  it('is null for a palette the tables do not hold, and paintRamp then falls back', () => {
    assert.equal(paletteRamp('plasma'), null);
    assert.equal(paletteRamp(null), null);
    assert.equal(paletteRamp('toString'), null);
    assert.equal(paintRamp('plasma'), paletteRamp(FALLBACK_PAINT_PALETTE));
    assert.equal(paintRamp(undefined), paletteRamp(FALLBACK_PAINT_PALETTE));
    assert.equal(paintRamp('rainbow'), paletteRamp('rainbow'));
  });
});

describe('normaliseTemperatures', () => {
  it('maps the range onto 0..1, clamped, held to 16 bits', () => {
    const n = normaliseTemperatures([10, 20, 30, 5, 40, 15], 10, 30);
    assert.equal(n[0], 0);
    assert.equal(n[1], Math.fround(Math.round(0.5 * 65535) / 65535));
    assert.equal(n[2], 1);
    assert.equal(n[3], 0);
    assert.equal(n[4], 1);
    assert.equal(n[5], Math.fround(Math.round(0.25 * 65535) / 65535));
  });

  it('reads a NaN cell and a range with no span as the cold end', () => {
    assert.deepEqual(
      [...normaliseTemperatures([NaN, 20], 10, 30)],
      [0, 0.5].map((v) => Math.fround(Math.round(v * 65535) / 65535)),
    );
    assert.deepEqual([...normaliseTemperatures([10, 20, 30], 20, 20)], [0, 0, 0]);
    assert.deepEqual([...normaliseTemperatures([10, 20, 30], 30, 10)], [0, 0, 0]);
  });
});

describe('cubicWeights', () => {
  it('sums to one and gives the cell itself at its centre', () => {
    assert.deepEqual(cubicWeights(0), [0, 1, 0, 0]);
    for (const t of [0.1, 0.25, 0.5, 0.9]) {
      const w = cubicWeights(t);
      assert.ok(Math.abs(w[0] + w[1] + w[2] + w[3] - 1) < 1e-12);
    }
  });
});

describe('paintThermalRgba', () => {
  // A field with a slope across, a step half way down and a hot cell: every part of the kernel is used.
  const gridW = 12;
  const gridH = 16;
  const field = new Float32Array(gridW * gridH);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) field[y * gridW + x] = 20 + x * 0.7 + (y >= gridH / 2 ? 6 : 0);
  }
  field[5 * gridW + 7] = 41;

  it('paints the same picture as the 16-tap form of the recipe', () => {
    const n = 200;
    for (const scale of [1, 2, 6]) {
      const outW = gridW * scale;
      const outH = gridH * scale;
      const rgba = paintThermalRgba(field, gridW, gridH, 20, 40, indexRamp(n), outW, outH);
      const want = referenceEntries(field, gridW, gridH, 20, 40, n, outW, outH);
      assert.equal(rgba.length, outW * outH * 4);
      let worst = 0;
      for (let i = 0; i < want.length; i++) {
        worst = Math.max(worst, Math.abs(rgba[i * 4] - want[i]));
        assert.equal(rgba[i * 4 + 1], n - 1 - rgba[i * 4]); // the entry's other channel came with it
        assert.equal(rgba[i * 4 + 3], 255);
      }
      // The two passes add the same sixteen products in another order, in single precision: a value on
      // an entry's boundary may fall one entry either side, never further.
      assert.ok(worst <= 1, `scale ${scale}: entries differ by ${worst}`);
    }
  });

  it('at one pixel a cell paints each cell its own ramp entry', () => {
    const n = 100;
    const rgba = paintThermalRgba(field, gridW, gridH, 20, 40, indexRamp(n), gridW, gridH);
    const norm = normaliseTemperatures(field, 20, 40);
    for (let i = 0; i < field.length; i++) {
      assert.ok(Math.abs(rgba[i * 4] - Math.min(n - 1, Math.floor(norm[i] * n))) <= 1);
    }
  });

  it('paints a flat field one colour, and a range with no span the cold end', () => {
    const flat = new Float32Array(gridW * gridH).fill(25);
    const mid = paintThermalRgba(flat, gridW, gridH, 20, 30, indexRamp(100), 24, 32);
    for (let i = 0; i < 24 * 32; i++) assert.equal(mid[i * 4], 50);
    const cold = paintThermalRgba(field, gridW, gridH, 30, 30, indexRamp(100), 24, 32);
    for (let i = 0; i < 24 * 32; i++) assert.equal(cold[i * 4], 0);
  });

  it('clamps what the kernel overshoots: no entry past either end of the ramp', () => {
    // A hard edge: the cubic rings below 0 and above 1 beside it.
    const edge = new Float32Array(gridW * gridH);
    for (let y = 0; y < gridH; y++) for (let x = gridW / 2; x < gridW; x++) edge[y * gridW + x] = 1;
    const n = 64;
    const rgba = paintThermalRgba(edge, gridW, gridH, 0, 1, indexRamp(n), gridW * 6, gridH * 6);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < rgba.length; i += 4) {
      lo = Math.min(lo, rgba[i]);
      hi = Math.max(hi, rgba[i]);
    }
    assert.equal(lo, 0);
    assert.equal(hi, n - 1);
  });

  it('returns an empty picture for a field shorter than the grid', () => {
    const rgba = paintThermalRgba(new Float32Array(10), gridW, gridH, 0, 1, indexRamp(8), 4, 4);
    assert.equal(rgba.length, 64);
    assert.ok(rgba.every((b) => b === 0));
  });
});

describe('paintRange', () => {
  it("is the camera's range when the take recorded one", () => {
    assert.deepEqual(paintRange([20, 25, 30], { min: 18, max: 33 }), { min: 18, max: 33 });
  });

  it("is the frame's own coldest to warmest readable cell otherwise", () => {
    assert.deepEqual(paintRange([20, 25, 30], null), { min: 20, max: 30 });
    assert.deepEqual(paintRange([20, 25, 30], { min: 5, max: 5 }), { min: 20, max: 30 });
    // A truncated frame's missing records read −273.15: not a temperature.
    assert.deepEqual(paintRange([20, -273.15, 30], undefined), { min: 20, max: 30 });
    assert.deepEqual(paintRange([], null), { min: 0, max: 0 });
  });
});
