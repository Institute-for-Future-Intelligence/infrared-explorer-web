import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SDK_PALETTE_RANGE, plateauEqualization } from './twinThermal';

describe('plateauEqualization', () => {
  const [LO, HI] = SDK_PALETTE_RANGE;
  const linearInRange = (t: number) => LO + (HI - LO) * t;

  it('is monotone across the SDK palette range and stretches the populated part of it', () => {
    // 95 % background around 20 °C, a warm object at 30–40 °C, a hot spot at 90 °C.
    const temps = new Float32Array(19200);
    for (let i = 0; i < temps.length; i++) {
      const u = (i * 7919) % 1000;
      temps[i] = u < 950 ? 18 + (u % 4) : u < 995 ? 30 + (u % 10) : 90;
    }
    const map = plateauEqualization(temps, 18, 90);
    assert.equal(map.length, 256);
    assert.ok(Math.abs(map[0] - LO) < 1e-6);
    assert.ok(Math.abs(map[255] - HI) < 1e-6);
    for (let i = 1; i < 256; i++) assert.ok(map[i] >= map[i - 1], `not monotone at ${i}`);
    // 35 °C is 0.24 of the way up linearly; the equalisation lifts it well above that, as the FLIR
    // render does for the few warm pixels in a cold frame — but not all the way to the top.
    const bin35 = Math.round(((35 - 18) / (90 - 18)) * 255);
    assert.ok(map[bin35] > linearInRange(0.24) + 0.12, `35 °C → ${map[bin35]}`);
    assert.ok(map[bin35] < linearInRange(0.85), `35 °C → ${map[bin35]}`);
    // The background itself spans a modest slice, not the whole bottom half of the palette.
    const bin22 = Math.round(((22 - 18) / (90 - 18)) * 255);
    assert.ok(map[bin22] < linearInRange(0.4), `22 °C → ${map[bin22]}`);
  });

  it('stays near linear for an evenly spread frame and copes with a flat one', () => {
    const even = new Float32Array(19200).map((_, i) => 10 + (((i * 7919) % 19200) / 19200) * 50);
    const map = plateauEqualization(even, 10, 60);
    for (let i = 0; i < 256; i += 15) assert.ok(Math.abs(map[i] - linearInRange(i / 255)) < 0.06, `${i}: ${map[i]}`);
    const flat = plateauEqualization(new Float32Array(100).fill(20), 20, 20);
    assert.ok(Math.abs(flat[0] - LO) < 1e-6);
    assert.ok(Math.abs(flat[255] - HI) < 1e-6);
    // An explicit full range is still available.
    const full = plateauEqualization(even, 10, 60, undefined, undefined, [0, 1]);
    assert.equal(full[0], 0);
    assert.equal(full[255], 1);
  });
});
