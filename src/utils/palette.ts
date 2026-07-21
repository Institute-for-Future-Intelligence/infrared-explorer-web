import { PALETTE_COLORS } from './paletteData';

/**
 * FLIR palette helpers. The baked false-colour frames (a recording's data_N.png, a video's mp4) are
 * rendered on-device with one of the FLIR camera's named palettes (see paletteData.ts, an exact per-index
 * LUT copied from infrared-explorer-app). The scale-bar overlay draws the SAME ramp so a colour on the bar
 * maps to the colour on the image. Which palette an experiment used is resolved elsewhere (a stored name,
 * an owner tag, or client-side detection); here we just turn a palette KEY into colours.
 *
 * Every frame is auto-gained (AGC): the frame's coldest pixel = LUT[0], hottest = LUT[last]. So a
 * normalized temperature t = (T − min)/(max − min) indexes straight into the LUT.
 */

/** All known palette keys (lowercase), e.g. 'iron', 'rainbow', 'rainhc'. */
export const PALETTE_KEYS = Object.keys(PALETTE_COLORS);

/**
 * Normalize a FLIR display name ("Iron", "RainHC", "ColorWheel6", "WhiteHot") to a PALETTE_COLORS key,
 * or null if it isn't one we have a LUT for. The app's display names differ from the keys only by case,
 * so a lowercase compare is enough.
 */
export const normalizePaletteName = (name: string | null | undefined): string | null => {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PALETTE_COLORS, key) ? key : null;
};

/** LUT hex at normalized position t in [0,1] (nearest stop). Returns null for an unknown key. */
export const paletteHexAt = (key: string, t: number): string | null => {
  const lut = PALETTE_COLORS[key];
  if (!lut || lut.length === 0) return null;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return lut[Math.round(clamped * (lut.length - 1))];
};

/**
 * A CSS linear-gradient sampled from the palette LUT (cold→hot). `stops` samples are taken across the LUT
 * (the LUTs are ~200–380 entries; ~24 stops render smoothly without a giant string). Returns null for an
 * unknown key so the caller can fall back to an approximate ramp.
 */
export const paletteGradientCss = (key: string, stops = 24, direction = 'to right'): string | null => {
  if (!PALETTE_COLORS[key]) return null;
  const cols: string[] = [];
  for (let i = 0; i <= stops; i++) {
    const hex = paletteHexAt(key, i / stops);
    if (hex) cols.push(hex);
  }
  return cols.length ? `linear-gradient(${direction}, ${cols.join(', ')})` : null;
};

// --- palette detection --------------------------------------------------------------------------------
// When an experiment doesn't carry a palette name (legacy content), we can recover it from the rendered
// frame itself: AGC maps each pixel's temperature t=(T−min)/(max−min) to LUT[t], so for the correct
// palette the rendered colour ≈ LUT[t] at every pixel. We score each candidate by mean per-pixel colour
// distance and take the closest — the palettes are distinct enough that the right FAMILY wins clearly.

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.charCodeAt(0) === 35 ? hex.slice(1) : hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// Parsed-RGB LUTs, memoized (parse each palette's hex list once, not per pixel per candidate).
let RGB_LUTS: Record<string, [number, number, number][]> | null = null;
const rgbLuts = (): Record<string, [number, number, number][]> => {
  if (!RGB_LUTS) {
    RGB_LUTS = {};
    for (const key of PALETTE_KEYS) RGB_LUTS[key] = PALETTE_COLORS[key].map(hexToRgb);
  }
  return RGB_LUTS;
};

export interface PaletteMatch {
  key: string;
  /** Mean per-pixel L1 colour distance over RGB (0 = perfect, ~765 = opposite). Lower is better. */
  distance: number;
  /** Runner-up's distance − best's, over (best+1): 0 = a tie, higher = a clearer win. */
  separation: number;
}

/**
 * Best-matching palette for a rendered frame. `temps` (Celsius, row-major) and `pixels` (RGBA, same w×h
 * grid, `temps.length*4` long) must be pixel-aligned. Returns the closest palette + how good/clear the
 * match is, or null if the frame is unusable (flat/degenerate span). The CALLER decides whether the match
 * is good enough (see detectPaletteFromImageSource's threshold) — this just ranks.
 */
export const detectPaletteFromPixels = (
  temps: Float32Array | ArrayLike<number>,
  min: number,
  max: number,
  pixels: Uint8ClampedArray | ArrayLike<number>,
  opts?: {
    samples?: number;
    // Pixel indices to ALWAYS evaluate on top of the stride sample — pass the frame's argmin/argmax so the
    // extreme LUT bands (t≈0 / t≈1) are never missed. Some palettes (whitehot/coldest/hottest) are
    // byte-identical except at those caps; without a cap sample they tie and the wrong one wins the argmin.
    alwaysSample?: readonly number[];
  },
): PaletteMatch | null => {
  const span = max - min;
  if (!isFinite(span) || span <= 0) return null;
  const n = temps.length;
  if (n === 0 || pixels.length < n * 4) return null;

  const luts = rgbLuts();
  const keys = PALETTE_KEYS;
  const err = new Float64Array(keys.length);
  let counted = 0;

  const evalPixel = (i: number) => {
    if (i < 0 || i >= n) return;
    const t = (temps[i] - min) / span;
    if (t < 0 || t > 1) return;
    const o = i * 4;
    if (pixels[o + 3] < 250) return; // skip transparent/edge pixels
    const r = pixels[o];
    const g = pixels[o + 1];
    const b = pixels[o + 2];
    for (let k = 0; k < keys.length; k++) {
      const lut = luts[keys[k]];
      const [pr, pg, pb] = lut[Math.round(t * (lut.length - 1))];
      err[k] += Math.abs(r - pr) + Math.abs(g - pg) + Math.abs(b - pb);
    }
    counted++;
  };

  const stride = Math.max(1, Math.floor(n / Math.min(opts?.samples ?? 500, n)));
  for (let i = 0; i < n; i += stride) evalPixel(i);
  for (const i of opts?.alwaysSample ?? []) evalPixel(i);
  if (counted === 0) return null;

  let best = 0;
  let bestMean = Infinity;
  let secondMean = Infinity;
  for (let k = 0; k < keys.length; k++) {
    const m = err[k] / counted;
    if (m < bestMean) {
      secondMean = bestMean;
      bestMean = m;
      best = k;
    } else if (m < secondMean) {
      secondMean = m;
    }
  }
  return {
    key: keys[best],
    distance: bestMean,
    separation: secondMean === Infinity ? 1 : (secondMean - bestMean) / (bestMean + 1),
  };
};
