/**
 * The FLIR SDK's display mapping, reproduced (docs/digital-twin-plan.md §8, §26.1): the player's palette
 * render is a histogram AGC of the frame, not a linear min→max ramp, and a twin painted to match it
 * (useTwinProjection, twinSceneThermal.photoMatchedPalette) folds its palette through the same curve.
 * (The vertex projection that once lived beside it painted the retired fixed-camera props, plan §42.)
 */

/** The slice of the palette the FLIR SDK's render actually uses: its AGC keeps headroom at both ends, so
 *  a frame's coldest pixel is deep purple rather than black and its hottest orange-yellow rather than
 *  white. Calibrated with SDK_AGC_PLATEAU / SDK_AGC_LINEAR below against the SDK's own data_N.png
 *  renders of three frames of a pouring clip (pixel → nearest palette colour → position, per
 *  temperature): pixel RMS 0.021 of the palette, against 0.175 for a linear min→max mapping. */
export const SDK_PALETTE_RANGE: readonly [number, number] = [0.15, 0.8];
export const SDK_AGC_PLATEAU = 0.008;
export const SDK_AGC_LINEAR = 0.4;

/**
 * Per-frame display mapping that reproduces the FLIR SDK's histogram AGC, which produced the palette
 * render the player shows beside the twin: a 256-bin histogram of the frame between min and max, each
 * bin capped at `plateau` of the pixels so a large uniform background cannot claim most of the palette,
 * and the running sum as the palette position — blended `linearWeight` with the plain linear mapping so
 * a temperature step never lands on an empty stretch of the palette — then squeezed into `range`. A
 * linear min→max mapping paints a hand-warm bottle in a frame with a kettle the same near-black purple
 * as the wall behind it; this gives the few warm pixels the palette room the render gives them.
 * Returns 256 non-decreasing palette positions (range[0] at min … range[1] at max), one per bin:
 * bin = floor((c − min) / (max − min) · 255).
 */
export function plateauEqualization(
  temps: ArrayLike<number>,
  min: number,
  max: number,
  plateau = SDK_AGC_PLATEAU,
  linearWeight = SDK_AGC_LINEAR,
  range: readonly [number, number] = SDK_PALETTE_RANGE,
): Float32Array {
  const map = new Float32Array(256);
  const [lo, hi] = range;
  const span = max - min;
  const hist = new Float64Array(256);
  let n = 0;
  if (span > 1e-9) {
    for (let i = 0; i < temps.length; i++) {
      const c = temps[i];
      if (!(c > -100)) continue; // the truncated-frame sentinel, or NaN
      let b = Math.floor(((c - min) / span) * 255);
      if (b < 0) b = 0;
      else if (b > 255) b = 255;
      hist[b]++;
      n++;
    }
  }
  if (n === 0) {
    for (let i = 0; i < 256; i++) map[i] = lo + (hi - lo) * (i / 255);
    return map;
  }
  const cap = Math.max(1, plateau * n);
  let total = 0;
  for (let i = 0; i < 256; i++) {
    if (hist[i] > cap) hist[i] = cap;
    total += hist[i];
  }
  // Exclusive running sum, so the bottom bin maps to the range's start and the top bin's own pixels
  // are the last step.
  const denom = total - hist[255] > 0 ? total - hist[255] : total;
  let cum = 0;
  for (let i = 0; i < 256; i++) {
    const cdf = Math.min(1, cum / denom);
    map[i] = lo + (hi - lo) * ((1 - linearWeight) * cdf + linearWeight * (i / 255));
    cum += hist[i];
  }
  map[255] = hi;
  return map;
}
