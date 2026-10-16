/*
 * Website-side shim, not synced: the `../heatmap` the copied
 * core/sandboxPage.ts imports (the app's src/lib/heatmap.ts). The same
 * `paletteRgba` as the app's, over the website's own palette table
 * (utils/paletteData.ts — the same reproduction of the FLIR ramps as the
 * app's, generated from the same .pal files), so a frame the website draws
 * for the AI is coloured as the phone draws it. render.ts draws with it too.
 */

import { PALETTE_COLORS } from '../utils/paletteData';

/** '#rrggbb' → [r, g, b] (0..255). Malformed → black. */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  if (h.length !== 6) {
    return [0, 0, 0];
  }
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) {
    return [0, 0, 0];
  }
  return [Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256];
}

const luts = new Map<string, [number, number, number][]>();

/**
 * RGBA (unpremultiplied, alpha 255) pixels of `celsius` mapped through the
 * palette over [min, max]. Null for an unknown palette. Length =
 * celsius.length * 4. NaN and out-of-range values clamp to the ramp's ends;
 * a degenerate range (max <= min) paints everything at t = 0.
 */
export function paletteRgba(
  celsius: Float32Array | readonly number[],
  min: number,
  max: number,
  paletteKey: string,
): Uint8Array | null {
  const table = PALETTE_COLORS[paletteKey];
  if (!table || table.length === 0) {
    return null;
  }
  let lut = luts.get(paletteKey);
  if (!lut) {
    lut = table.map(hexToRgb);
    luts.set(paletteKey, lut);
  }
  const last = lut.length - 1;
  const span = max - min;
  const out = new Uint8Array(celsius.length * 4);
  for (let i = 0; i < celsius.length; i++) {
    const v = celsius[i];
    let idx = 0;
    if (span > 0 && Number.isFinite(v)) {
      const t = (v - min) / span;
      idx = t <= 0 ? 0 : t >= 1 ? last : Math.floor(t * lut.length);
      if (idx > last) {
        idx = last;
      }
    }
    const [r, g, b] = lut[idx];
    const o = i * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = 255;
  }
  return out;
}
