/*
 * Isotherm contours for the street-view temperature panorama — marching squares over a
 * row-major °C grid, emitting segments in normalised [0,1] coordinates (drawable in a
 * "0 0 1 1" space). Same algorithm as utils/isotherms.ts, but SKIPS any cell touching a
 * gap (NaN) so the panorama's uncovered arcs don't spawn spurious contours at their edges.
 */

export type IsothermSegment = [number, number, number, number]; // x1, y1, x2, y2 in [0,1]

export interface IsothermLine {
  value: number;
  segments: IsothermSegment[];
}

function march(grid: Float32Array, width: number, height: number, threshold: number): IsothermSegment[] {
  const segs: IsothermSegment[] = [];
  const at = (cx: number, cy: number) => grid[cy * width + cx];
  const interp = (a: number, b: number) => (a === b ? 0.5 : (threshold - a) / (b - a));

  for (let cy = 0; cy < height - 1; cy++) {
    for (let cx = 0; cx < width - 1; cx++) {
      const tl = at(cx, cy);
      const tr = at(cx + 1, cy);
      const br = at(cx + 1, cy + 1);
      const bl = at(cx, cy + 1);
      if (!(Number.isFinite(tl) && Number.isFinite(tr) && Number.isFinite(br) && Number.isFinite(bl))) continue;

      let idx = 0;
      if (tl > threshold) idx |= 8;
      if (tr > threshold) idx |= 4;
      if (br > threshold) idx |= 2;
      if (bl > threshold) idx |= 1;
      if (idx === 0 || idx === 15) continue;

      const top = (): [number, number] => [(cx + interp(tl, tr)) / (width - 1), cy / (height - 1)];
      const bottom = (): [number, number] => [(cx + interp(bl, br)) / (width - 1), (cy + 1) / (height - 1)];
      const left = (): [number, number] => [cx / (width - 1), (cy + interp(tl, bl)) / (height - 1)];
      const right = (): [number, number] => [(cx + 1) / (width - 1), (cy + interp(tr, br)) / (height - 1)];
      const push = (p: [number, number], q: [number, number]) => segs.push([p[0], p[1], q[0], q[1]]);

      switch (idx) {
        case 1:
        case 14:
          push(left(), bottom());
          break;
        case 2:
        case 13:
          push(bottom(), right());
          break;
        case 3:
        case 12:
          push(left(), right());
          break;
        case 4:
        case 11:
          push(top(), right());
          break;
        case 6:
        case 9:
          push(top(), bottom());
          break;
        case 7:
        case 8:
          push(left(), top());
          break;
        case 5:
          push(left(), top());
          push(bottom(), right());
          break;
        case 10:
          push(top(), right());
          push(left(), bottom());
          break;
      }
    }
  }
  return segs;
}

/** Contour lines at the given °C thresholds (order preserved, paired 1:1 by index). */
export const computePanoIsotherms = (
  grid: Float32Array,
  width: number,
  height: number,
  thresholds: number[],
): IsothermLine[] => thresholds.map((value) => ({ value, segments: march(grid, width, height, value) }));

/** `n` evenly-spaced levels strictly between lo and hi (excludes the endpoints). */
export const autoLevels = (lo: number, hi: number, n: number): number[] => {
  const out: number[] = [];
  for (let l = 1; l <= n; l++) out.push(Math.round((lo + ((hi - lo) * l) / (n + 1)) * 10) / 10);
  return out;
};

const hueFor = (li: number, total: number) => 240 - (240 * li) / Math.max(1, total - 1);
/** Blue (coldest) → red (hottest) by level index, matching the analyzer's isotherm ramp. */
export const isothermColor = (li: number, total: number) => `hsl(${hueFor(li, total)}, 90%, 55%)`;
