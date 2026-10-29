/**
 * The colour scale a rendered frame actually used, measured from the frame itself (docs/digital-twin-plan.md
 * §43.5). A recording stores no scale: each frame is a temperature grid (data_N.dat) and the FLIR SDK's
 * render of it (data_N.png), nothing about how one became the other. But the two are pixel-aligned, so
 * every pixel is a (temperature, colour) pair, and sorting the pairs by temperature recovers the SDK's own
 * temperature → colour table for that frame — its auto-gain, its palette, exactly, to the render's smoothing.
 * The twin painted through this table shows the player's colours for the same temperatures (useLiveTwinFrame),
 * where a reproduction of the SDK's mapping (twinThermal.plateauEqualization) only came close.
 *
 * The table has 256 bins over the frame's own range (bin = floor((c − min) / (max − min) · 255), as the
 * frame's auto-gain is defined); a bin's colour is the mean of its pixels' colours — the render is
 * upsampled and smoothed, so a mean cancels that noise — and a bin no pixel fell in takes the colours
 * either side of it, blended by distance (the ends extend the nearest filled bin).
 */

const BINS = 256;
/** Fewer filled bins than this and the frame has too little range to describe a scale (a flat scene). */
const MIN_FILLED = 8;

export interface FrameColourTable {
  /** The frame's coldest and warmest readable pixel, °C: the ends of its scale. */
  min: number;
  max: number;
  /** 256 hex colours, cold → hot, as a palette LUT. */
  palette: string[];
}

const hex2 = (v: number) => Math.round(v).toString(16).padStart(2, '0');

/**
 * `temps`: the frame's temperatures, °C, row-major (unreadable pixels below −100). `pixels`: the render's
 * RGBA bytes on the SAME grid (temps.length × 4, as paletteDetect.readGridPixels reads them); a pixel
 * whose alpha is under 250 is skipped. Null when the frame is flat or the pixels do not fit the grid.
 */
export function frameColourTable(temps: ArrayLike<number>, pixels: ArrayLike<number>): FrameColourTable | null {
  const n = temps.length;
  if (!n || pixels.length < n * 4) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = temps[i];
    if (!(c > -100)) continue;
    if (c < min) min = c;
    if (c > max) max = c;
  }
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return null;
  const sum = new Float64Array(BINS * 3);
  const count = new Uint32Array(BINS);
  for (let i = 0; i < n; i++) {
    const c = temps[i];
    if (!(c > -100)) continue;
    const o = i * 4;
    if (pixels[o + 3] < 250) continue;
    let b = Math.floor(((c - min) / span) * (BINS - 1));
    if (b < 0) b = 0;
    else if (b > BINS - 1) b = BINS - 1;
    sum[b * 3] += pixels[o];
    sum[b * 3 + 1] += pixels[o + 1];
    sum[b * 3 + 2] += pixels[o + 2];
    count[b]++;
  }
  let filled = 0;
  for (let b = 0; b < BINS; b++) if (count[b]) filled++;
  if (filled < MIN_FILLED) return null;
  // The filled bins' mean colours, then the gaps: each empty bin blends the nearest filled bin on either
  // side by its distance to them; before the first (after the last) filled bin, that bin's colour.
  const rgb = new Float64Array(BINS * 3);
  let prev = -1;
  for (let b = 0; b < BINS; b++) {
    if (!count[b]) continue;
    for (let k = 0; k < 3; k++) rgb[b * 3 + k] = sum[b * 3 + k] / count[b];
    if (prev < 0) {
      for (let e = 0; e < b; e++) for (let k = 0; k < 3; k++) rgb[e * 3 + k] = rgb[b * 3 + k];
    } else {
      for (let e = prev + 1; e < b; e++) {
        const f = (e - prev) / (b - prev);
        for (let k = 0; k < 3; k++) rgb[e * 3 + k] = rgb[prev * 3 + k] * (1 - f) + rgb[b * 3 + k] * f;
      }
    }
    prev = b;
  }
  for (let e = prev + 1; e < BINS; e++) for (let k = 0; k < 3; k++) rgb[e * 3 + k] = rgb[prev * 3 + k];
  const palette: string[] = new Array(BINS);
  for (let b = 0; b < BINS; b++) palette[b] = `#${hex2(rgb[b * 3])}${hex2(rgb[b * 3 + 1])}${hex2(rgb[b * 3 + 2])}`;
  return { min, max, palette };
}
