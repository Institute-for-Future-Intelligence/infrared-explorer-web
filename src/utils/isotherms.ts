/**
 * Isotherm (contour line) computation via marching squares — no external dependency.
 * Input is a row-major temperature grid (grid[y * width + x]); output line segments are in
 * normalized [0,1] image coordinates so they can be drawn in an SVG viewBox of "0 0 1 1".
 */

export type IsothermSegment = [number, number, number, number]; // x1, y1, x2, y2 in [0,1]

export interface IsothermLine {
  value: number;
  segments: IsothermSegment[];
}

type Grid = readonly number[] | Float32Array; // a decoded frame's Celsius plane (utils/thermalFrame.ts) or a plain array

const marchingSquares = (grid: Grid, width: number, height: number, threshold: number): IsothermSegment[] => {
  const segs: IsothermSegment[] = [];
  const at = (cx: number, cy: number) => grid[cy * width + cx];
  const interp = (a: number, b: number) => (a === b ? 0.5 : (threshold - a) / (b - a));

  for (let cy = 0; cy < height - 1; cy++) {
    for (let cx = 0; cx < width - 1; cx++) {
      const tl = at(cx, cy);
      const tr = at(cx + 1, cy);
      const br = at(cx + 1, cy + 1);
      const bl = at(cx, cy + 1);

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
        case 5: // saddle
          push(left(), top());
          push(bottom(), right());
          break;
        case 10: // saddle
          push(top(), right());
          push(left(), bottom());
          break;
      }
    }
  }
  return segs;
};

/** Compute `levels` evenly-spaced isotherm lines between the grid's min and max temperature. */
export const computeIsotherms = (grid: Grid, width: number, height: number, levels: number): IsothermLine[] => {
  let min = Infinity;
  let max = -Infinity;
  for (const v of grid) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!isFinite(min) || !isFinite(max) || max - min < 1e-6) return [];

  const lines: IsothermLine[] = [];
  for (let l = 1; l <= levels; l++) {
    const threshold = min + ((max - min) * l) / (levels + 1);
    lines.push({ value: threshold, segments: marchingSquares(grid, width, height, threshold) });
  }
  return lines;
};
