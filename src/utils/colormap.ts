/**
 * Temperature → color helpers, shared by visualizations (3D surface, future fusion overlays).
 * Uses the same blue→red hue ramp as the isotherm legend (hue 240° cold → 0° hot).
 */

/** HSL (h in degrees 0–360, s/l in 0–1) → RGB in 0–1. */
export const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
};

/** Normalized temperature (0 = coldest, 1 = hottest) → RGB in 0–1 (blue → red). */
export const temp01ToRgb = (t: number): [number, number, number] => {
  const clamped = Math.max(0, Math.min(1, t));
  return hslToRgb(240 - 240 * clamped, 0.9, 0.55);
};

/** CSS color string for the same ramp — handy for legends/swatches. */
export const temp01ToCss = (t: number): string => {
  const clamped = Math.max(0, Math.min(1, t));
  return `hsl(${240 - 240 * clamped}, 90%, 55%)`;
};

// The matplotlib "inferno" colormap (near-black → deep purple → magenta → red → orange → pale yellow),
// as 11 evenly-spaced RGB anchors. This is (close to) the palette the mobile capture app bakes into a
// recording's data_N.png and a video's .mp4, so colourising a raw thermal frame with it reproduces the
// false colours the user sees in the player — unlike the blue→red temp01ToRgb ramp above (the app's own
// overlay language for the 3D surface / isotherm legend, not the baked frame palette).
const INFERNO_STOPS: readonly [number, number, number][] = [
  [0, 0, 4],
  [22, 11, 57],
  [66, 10, 104],
  [106, 23, 110],
  [147, 38, 103],
  [188, 55, 84],
  [221, 81, 58],
  [243, 120, 25],
  [252, 165, 10],
  [246, 215, 70],
  [252, 255, 164],
];

/** Normalized value (0 = coldest, 1 = hottest) → inferno RGB in 0–255 (linearly interpolated). */
export const infernoRgb = (t: number): [number, number, number] => {
  const scaled = Math.max(0, Math.min(1, t)) * (INFERNO_STOPS.length - 1);
  const i = Math.min(INFERNO_STOPS.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const [r0, g0, b0] = INFERNO_STOPS[i];
  const [r1, g1, b1] = INFERNO_STOPS[i + 1];
  return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
};
