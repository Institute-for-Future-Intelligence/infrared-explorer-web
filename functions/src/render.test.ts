/**
 * Tests for the server-side thermal renderer.
 *
 * The renders exist to be looked at by a model, so the properties worth pinning are the ones that would
 * silently mislead it: that a truncated frame is refused rather than drawn from -273 °C sentinels, and
 * that the palette is anchored to the range it was given rather than to each frame's own — the whole
 * point of clip-wide bounds is that the same colour means the same temperature in every frame shown.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decode as decodeJpeg } from 'jpeg-js';
import { decodeRawFrame, INTSIZE, type DecodedFrame } from './thermal';
import { infernoRgb, renderThermalFrame } from './render';

const makeFrame = (w: number, h: number, tempAt: (x: number, y: number) => number, bytes?: number): DecodedFrame => {
  const raw = new Uint8Array(bytes ?? w * h * INTSIZE);
  const dv = new DataView(raw.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const off = (y * w + x) * INTSIZE + 2;
      if (off + 2 > raw.byteLength) continue;
      dv.setUint16(off, Math.round((tempAt(x, y) + 273.15) * 100), false);
    }
  }
  return decodeRawFrame(raw, w, h);
};

/** Mean RGB of a rendered frame, decoded back from the JPEG. */
const meanRgb = (data: string): [number, number, number] => {
  const { data: px, width, height } = decodeJpeg(Buffer.from(data, 'base64'), { useTArray: true });
  let r = 0;
  let g = 0;
  let b = 0;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    r += px[i * 4];
    g += px[i * 4 + 1];
    b += px[i * 4 + 2];
  }
  return [r / n, g / n, b / n];
};

describe('infernoRgb', () => {
  it('runs from near-black at the cold end to pale yellow at the hot end', () => {
    const cold = infernoRgb(0);
    const hot = infernoRgb(1);
    assert.deepEqual(cold, [0, 0, 4]);
    assert.deepEqual(hot, [252, 255, 164]);
    // Monotone in brightness across the ramp — a colour scale that dipped would misread as a cold band.
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const [r, g, b] = infernoRgb(i / 10);
      const lum = r + g + b;
      assert.ok(lum > prev, `luminance should rise at t=${i / 10}`);
      prev = lum;
    }
  });

  it('clamps out-of-range inputs instead of wrapping', () => {
    assert.deepEqual(infernoRgb(-5), infernoRgb(0));
    assert.deepEqual(infernoRgb(5), infernoRgb(1));
  });
});

describe('renderThermalFrame', () => {
  it('produces a decodable JPEG at the frame dimensions', () => {
    const out = renderThermalFrame(
      makeFrame(120, 160, (x) => 20 + x * 0.2),
      20,
      44,
    );
    assert.ok(out, 'expected a render');
    assert.equal(out.mediaType, 'image/jpeg');
    const decoded = decodeJpeg(Buffer.from(out.data, 'base64'), { useTArray: true });
    assert.equal(decoded.width, 120);
    assert.equal(decoded.height, 160);
  });

  it('refuses a truncated frame rather than drawing its -273 °C sentinels', () => {
    // Half the pixel records missing: reads past the end yield 0 deci-Kelvin.
    const short = makeFrame(20, 20, () => 30, 20 * 20 * INTSIZE - 400);
    assert.equal(short.complete, false, 'fixture should be incomplete');
    assert.equal(renderThermalFrame(short, 20, 40), null);
  });

  it('anchors the palette to the bounds it is given, not to the frame', () => {
    // The same 30 °C frame drawn against two ranges must come out at different points on the ramp —
    // this is what makes two frames of one clip comparable.
    const frame = makeFrame(20, 20, () => 30);
    const coolScale = renderThermalFrame(frame, 20, 40); // 30 sits mid-range
    const hotScale = renderThermalFrame(frame, 30, 200); // 30 sits at the cold end
    assert.ok(coolScale && hotScale);
    const [r1] = meanRgb(coolScale.data);
    const [r2] = meanRgb(hotScale.data);
    assert.ok(r1 > r2 + 20, `mid-range should render far warmer than the cold end (${r1} vs ${r2})`);
  });

  it('renders a hot region brighter than a cold one in the same frame', () => {
    const half = renderThermalFrame(
      makeFrame(40, 40, (x) => (x < 20 ? 20 : 60)),
      20,
      60,
    );
    assert.ok(half);
    const { data: px, width, height } = decodeJpeg(Buffer.from(half.data, 'base64'), { useTArray: true });
    const at = (x: number, y: number) => px[(y * width + x) * 4] + px[(y * width + x) * 4 + 1];
    assert.ok(at(width - 3, height >> 1) > at(2, height >> 1) + 50, 'the hot half must be brighter');
  });

  it('returns null for a zero-sized frame instead of throwing', () => {
    assert.equal(renderThermalFrame(decodeRawFrame(new Uint8Array(0), 0, 0), 0, 1), null);
  });
});
