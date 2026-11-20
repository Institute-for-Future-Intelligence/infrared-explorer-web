/**
 * The infrared picture of a frame, painted from its temperatures — the pure half (typed arrays in, RGBA
 * out; the canvas half is utils/thermalPaintDom.ts).
 *
 * A camera-timed recording (doc `timing: 'camera'`, utils/frameIndex.ts) uploads no data_N.png, so
 * wherever the site showed that render it paints the frame from data_N.dat instead. The recipe is the
 * capture app's own (its src/lib/thermalRenderParams.ts — the two must stay the same picture), per
 * output pixel:
 *
 *   v   = the frame's temperatures, each first normalised over the colour range to 0..1 (clamped, and
 *         held to 16 bits as the app's shader texture holds it), resampled at this pixel with a bicubic
 *         (Catmull-Rom) kernel over the 4 × 4 cells around it (cells past the edge repeat the edge)
 *   out = the palette's ramp entry at v (clamped to 0..1; `floor(v · N)`)
 *
 * The order matters: the temperatures are interpolated and THEN coloured. Colouring the 120 × 160 cells
 * and stretching the colours blends neighbouring ramp entries, which is not a colour the ramp holds.
 *
 * The kernel is separable, so the picture is made in two passes (across, then down) — the same sums as
 * the 16-tap form in another order, at a quarter of the work.
 */
import { PALETTE_COLORS } from './paletteData';

/** Output pixels per grid cell, each way: 120 × 160 → 720 × 960, the size the capture app paints. */
export const THERMAL_PAINT_SCALE = 6;

/** The palette a take is painted through when its doc names none the tables hold. */
export const FALLBACK_PAINT_PALETTE = 'iron';

/** A palette's ramp as one row of RGBA bytes (alpha 255), cold end first. */
export interface PaletteRamp {
  rgba: Uint8Array;
  length: number;
}

const ramps = new Map<string, PaletteRamp | null>();

/** The ramp of a palette key (lowercase, e.g. 'iron'); null for one the tables do not hold. Made once a key. */
export function paletteRamp(paletteKey: string | null | undefined): PaletteRamp | null {
  const key = (paletteKey ?? '').trim().toLowerCase();
  const hit = ramps.get(key);
  if (hit !== undefined) return hit;
  const table = Object.prototype.hasOwnProperty.call(PALETTE_COLORS, key) ? PALETTE_COLORS[key] : undefined;
  let ramp: PaletteRamp | null = null;
  if (table && table.length > 0) {
    const rgba = new Uint8Array(table.length * 4);
    for (let i = 0; i < table.length; i++) {
      const hex = table[i].charCodeAt(0) === 35 ? table[i].slice(1) : table[i];
      const n = hex.length === 6 ? parseInt(hex, 16) : 0;
      const c = Number.isFinite(n) ? n : 0;
      rgba[i * 4] = (c >> 16) & 0xff;
      rgba[i * 4 + 1] = (c >> 8) & 0xff;
      rgba[i * 4 + 2] = c & 0xff;
      rgba[i * 4 + 3] = 255;
    }
    ramp = { rgba, length: table.length };
  }
  ramps.set(key, ramp);
  return ramp;
}

/** The ramp to paint a take through: its palette's, else the fallback's. */
export const paintRamp = (paletteKey: string | null | undefined): PaletteRamp =>
  paletteRamp(paletteKey) ?? (paletteRamp(FALLBACK_PAINT_PALETTE) as PaletteRamp);

const U16_MAX = 65535;

/**
 * The temperatures normalised over [min, max]: 0..1, clamped, rounded to 16 bits (the app's
 * packTemperatures). A NaN cell and a degenerate range (max <= min) read as 0 — the ramp's cold end.
 */
export function normaliseTemperatures(temps: ArrayLike<number>, min: number, max: number): Float32Array {
  const out = new Float32Array(temps.length);
  const span = max - min;
  if (!(span > 0)) return out;
  for (let i = 0; i < temps.length; i++) {
    const v = temps[i];
    if (!Number.isFinite(v)) continue;
    const t = (v - min) / span;
    out[i] = t <= 0 ? 0 : t >= 1 ? 1 : Math.round(t * U16_MAX) / U16_MAX;
  }
  return out;
}

/** Catmull-Rom weights of the four cells around a point `t` (0..1) past the second. */
export function cubicWeights(t: number): [number, number, number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2];
}

/** For each of `out` pixels along an axis of `grid` cells: the four cells it reads (edge-clamped) and their weights. */
interface AxisTaps {
  cells: Int32Array; // out × 4
  weights: Float32Array; // out × 4
}

const tapCache = new Map<string, AxisTaps>();

function axisTaps(grid: number, out: number): AxisTaps {
  const key = `${grid}/${out}`;
  const hit = tapCache.get(key);
  if (hit) return hit;
  const cells = new Int32Array(out * 4);
  const weights = new Float32Array(out * 4);
  for (let p = 0; p < out; p++) {
    // The pixel's centre in cell coordinates (a cell's centre is at its index).
    const g = ((p + 0.5) / out) * grid - 0.5;
    const b = Math.floor(g);
    const w = cubicWeights(g - b);
    for (let k = 0; k < 4; k++) {
      const c = b + k - 1;
      cells[p * 4 + k] = c < 0 ? 0 : c > grid - 1 ? grid - 1 : c;
      weights[p * 4 + k] = w[k];
    }
  }
  const taps = { cells, weights };
  tapCache.set(key, taps);
  return taps;
}

/**
 * Paint `temps` (gridW × gridH cells, row-major, °C) over [min, max] through `ramp`, as an outW × outH
 * RGBA picture (alpha 255). A range with max <= min paints the ramp's cold end throughout.
 */
export function paintThermalRgba(
  temps: ArrayLike<number>,
  gridW: number,
  gridH: number,
  min: number,
  max: number,
  ramp: PaletteRamp,
  outW: number,
  outH: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(outW * outH * 4);
  if (temps.length < gridW * gridH || outW <= 0 || outH <= 0) return out;
  const norm = normaliseTemperatures(temps, min, max);
  const tx = axisTaps(gridW, outW);
  const ty = axisTaps(gridH, outH);
  // Across: every grid row resampled to the output's width.
  const rows = new Float32Array(gridH * outW);
  for (let y = 0; y < gridH; y++) {
    const src = y * gridW;
    const dst = y * outW;
    for (let px = 0; px < outW; px++) {
      const k = px * 4;
      rows[dst + px] =
        tx.weights[k] * norm[src + tx.cells[k]] +
        tx.weights[k + 1] * norm[src + tx.cells[k + 1]] +
        tx.weights[k + 2] * norm[src + tx.cells[k + 2]] +
        tx.weights[k + 3] * norm[src + tx.cells[k + 3]];
    }
  }
  // Down, and through the ramp — a pixel written as one 32-bit word (the ramp's four bytes as they lie
  // in memory, so the byte order of the machine never comes into it).
  const n = ramp.length;
  const top = n - 1;
  const lut = rampWords(ramp);
  const words = new Uint32Array(out.buffer);
  for (let py = 0; py < outH; py++) {
    const k = py * 4;
    const r0 = ty.cells[k] * outW;
    const r1 = ty.cells[k + 1] * outW;
    const r2 = ty.cells[k + 2] * outW;
    const r3 = ty.cells[k + 3] * outW;
    const w0 = ty.weights[k];
    const w1 = ty.weights[k + 1];
    const w2 = ty.weights[k + 2];
    const w3 = ty.weights[k + 3];
    const o = py * outW;
    for (let px = 0; px < outW; px++) {
      const v = w0 * rows[r0 + px] + w1 * rows[r1 + px] + w2 * rows[r2 + px] + w3 * rows[r3 + px];
      // floor(v · n), clamped to the ramp (v is never far outside 0..1, so the truncation is a floor).
      const idx = v <= 0 ? 0 : (v * n) | 0;
      words[o + px] = lut[idx > top ? top : idx];
    }
  }
  return out;
}

const wordsOf = new WeakMap<PaletteRamp, Uint32Array>();

/** A ramp's entries as 32-bit words over its own byte layout (alpha forced opaque), made once a ramp. */
function rampWords(ramp: PaletteRamp): Uint32Array {
  const hit = wordsOf.get(ramp);
  if (hit) return hit;
  const bytes = new Uint8Array(ramp.length * 4);
  bytes.set(ramp.rgba.subarray(0, ramp.length * 4));
  for (let i = 3; i < bytes.length; i += 4) bytes[i] = 255;
  const words = new Uint32Array(bytes.buffer);
  wordsOf.set(ramp, words);
  return words;
}

/**
 * The range to paint a frame over: the one the camera coloured it over when the take recorded it
 * (`cameraScale`, utils/frameIndex.ts frameScaleOf), else the frame's own coldest and warmest readable
 * cell (a cell below −200 °C is a truncated frame's missing record, not a temperature).
 */
export function paintRange(
  temps: ArrayLike<number>,
  cameraScale: { min: number; max: number } | null | undefined,
): { min: number; max: number } {
  if (cameraScale && cameraScale.max > cameraScale.min) return cameraScale;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < temps.length; i++) {
    const c = temps[i];
    if (!(c > -200)) continue;
    if (c < min) min = c;
    if (c > max) max = c;
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : { min: 0, max: 0 };
}
