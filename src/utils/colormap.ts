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
