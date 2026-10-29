import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { frameColourTable } from './frameColourTable';

const W = 120;
const H = 160;

/** A render of `temps` through a known table: colour = (bin, 255 − bin, 128). */
const render = (temps: Float32Array, min: number, max: number): Uint8ClampedArray => {
  const px = new Uint8ClampedArray(temps.length * 4);
  for (let i = 0; i < temps.length; i++) {
    const b = Math.max(0, Math.min(255, Math.floor(((temps[i] - min) / (max - min)) * 255)));
    px[i * 4] = b;
    px[i * 4 + 1] = 255 - b;
    px[i * 4 + 2] = 128;
    px[i * 4 + 3] = 255;
  }
  return px;
};

const channel = (hex: string, k: number) => parseInt(hex.slice(1 + 2 * k, 3 + 2 * k), 16);

describe('frameColourTable', () => {
  it('recovers the table a frame was rendered through, bin by bin', () => {
    const temps = new Float32Array(W * H);
    for (let i = 0; i < temps.length; i++) temps[i] = -5 + 30 * (i / (temps.length - 1)); // every bin filled
    const t = frameColourTable(temps, render(temps, -5, 25));
    assert.ok(t);
    assert.equal(t.min, -5);
    assert.equal(t.max, 25);
    assert.equal(t.palette.length, 256);
    for (const b of [0, 17, 100, 200, 255]) {
      assert.ok(Math.abs(channel(t.palette[b], 0) - b) <= 1, `red of bin ${b}: ${t.palette[b]}`);
      assert.ok(Math.abs(channel(t.palette[b], 1) - (255 - b)) <= 1, `green of bin ${b}: ${t.palette[b]}`);
      assert.equal(channel(t.palette[b], 2), 128);
    }
  });

  it('blends the bins no pixel fell in from their neighbours, and extends the ends', () => {
    // Eleven temperatures, 0, 2 … 20 °C, grey 10 × t: eleven filled bins (0, 25, 51 … 255), gaps between.
    const temps = new Float32Array(W * H);
    for (let i = 0; i < temps.length; i++) temps[i] = (i % 11) * 2;
    const px = new Uint8ClampedArray(temps.length * 4);
    for (let i = 0; i < temps.length; i++) {
      const v = temps[i] * 10;
      px.set([v, v, v, 255], i * 4);
    }
    const t = frameColourTable(temps, px);
    assert.ok(t);
    assert.equal(channel(t.palette[0], 0), 0);
    assert.equal(channel(t.palette[127], 0), 100); // 10 °C → bin 127
    assert.equal(channel(t.palette[255], 0), 200);
    // Bin 12 lies between bin 0 (grey 0) and bin 25 (grey 20): 20 · 12/25 = 9.6.
    const low = channel(t.palette[12], 0);
    assert.ok(low >= 9 && low <= 11, `bin 12 blends 0 and 20: ${low}`);
    // Bin 240 lies between bin 229 (grey 180) and bin 255 (grey 200): 180 + 20 · 11/26 ≈ 188.5.
    const high = channel(t.palette[240], 0);
    assert.ok(high >= 187 && high <= 190, `bin 240 blends 180 and 200: ${high}`);
  });

  it('ignores unreadable pixels and transparent ones', () => {
    const temps = new Float32Array(W * H);
    for (let i = 0; i < temps.length; i++) temps[i] = i < 100 ? -273 : 10 + 10 * (i / temps.length);
    const px = render(temps, 10, 20);
    for (let i = 0; i < 100; i++) px[i * 4 + 3] = 0; // the sentinel pixels are also transparent
    px[500 * 4 + 3] = 10; // one more skipped by alpha
    const t = frameColourTable(temps, px);
    assert.ok(t);
    assert.ok(t.min > 10 && t.min < 10.1, `min is the first readable pixel, not the sentinel: ${t.min}`);
    assert.ok(t.max < 20 && t.max > 19.9);
  });

  it('is null for a flat frame or pixels that do not fit the grid', () => {
    const flat = new Float32Array(W * H).fill(21);
    assert.equal(frameColourTable(flat, render(flat, 20, 22)), null);
    const temps = new Float32Array(W * H);
    for (let i = 0; i < temps.length; i++) temps[i] = i / 1000;
    assert.equal(frameColourTable(temps, new Uint8ClampedArray(10)), null);
  });
});
