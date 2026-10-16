/*
 * Shape-preserving compression of a temperature series, for what the phone
 * hands the AI (measure, and the curves in a take's overview).
 *
 * Kept, always: the first and last points, the highest and the lowest. Then,
 * between any two kept points, the point that departs most from the straight
 * line joining them is kept if it departs by more than the tolerance — and
 * the halves on either side are examined the same way (Ramer–Douglas–Peucker,
 * measured vertically in °C because time and temperature share no unit).
 * Every turn in the curve larger than the tolerance survives; a straight
 * ramp, however long, keeps only its ends.
 *
 * A series no longer than `maxPoints` comes back whole. A longer one whose
 * compression still exceeds `maxPoints` is recompressed with the tolerance
 * doubled until it fits; the tolerance actually used and the largest
 * deviation are reported, so the reader knows what it got.
 *
 * Pure; tested in __tests__/labProjectsCompress.test.ts.
 */

export interface SeriesPoint {
  /** Seconds from the start of the take. */
  t: number;
  /** °C; NaN for a frame with no reading. */
  v: number;
}

export interface CompressedSeries {
  /** [t seconds, °C], both rounded to 0.01. */
  points: [number, number][];
  /** Frames with a reading. */
  read: number;
  /** Frames without one (unreadable, missing). */
  missing: number;
  kept: number;
  /** °C; 0 when the series came back whole. */
  tolerance: number;
  /** Largest vertical distance of a dropped point from the kept curve, °C. */
  maxDeviation: number;
  whole: boolean;
}

export const DEFAULT_TOLERANCE_C = 0.1;
export const DEFAULT_MAX_POINTS = 120;

const r2 = (x: number) => Math.round(x * 100) / 100;

function deviation(p: SeriesPoint, a: SeriesPoint, b: SeriesPoint): number {
  if (b.t === a.t) {
    return Math.abs(p.v - a.v);
  }
  const f = (p.t - a.t) / (b.t - a.t);
  return Math.abs(p.v - (a.v + f * (b.v - a.v)));
}

/** Indexes kept at tolerance `tol` (sorted). */
function rdp(pts: SeriesPoint[], tol: number): number[] {
  const n = pts.length;
  if (n <= 2) {
    return pts.map((_, i) => i);
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  let hi = 0;
  let lo = 0;
  for (let i = 1; i < n; i++) {
    if (pts[i].v > pts[hi].v) {
      hi = i;
    }
    if (pts[i].v < pts[lo].v) {
      lo = i;
    }
  }
  keep[hi] = 1;
  keep[lo] = 1;
  const anchors: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) {
      anchors.push(i);
    }
  }
  const stack: [number, number][] = [];
  for (let k = 0; k + 1 < anchors.length; k++) {
    stack.push([anchors[k], anchors[k + 1]]);
  }
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) {
      continue;
    }
    let best = -1;
    let bestDev = tol;
    for (let i = a + 1; i < b; i++) {
      const d = deviation(pts[i], pts[a], pts[b]);
      if (d > bestDev) {
        bestDev = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) {
      out.push(i);
    }
  }
  return out;
}

function maxDeviationOf(pts: SeriesPoint[], kept: number[]): number {
  let worst = 0;
  for (let k = 0; k + 1 < kept.length; k++) {
    const a = pts[kept[k]];
    const b = pts[kept[k + 1]];
    for (let i = kept[k] + 1; i < kept[k + 1]; i++) {
      worst = Math.max(worst, deviation(pts[i], a, b));
    }
  }
  return worst;
}

export function compressSeries(
  series: SeriesPoint[],
  opts: {tolerance?: number; maxPoints?: number} = {},
): CompressedSeries {
  const tol0 =
    opts.tolerance != null && Number.isFinite(opts.tolerance) && opts.tolerance > 0
      ? opts.tolerance
      : DEFAULT_TOLERANCE_C;
  const maxPoints =
    opts.maxPoints != null && Number.isFinite(opts.maxPoints) && opts.maxPoints >= 3
      ? Math.floor(opts.maxPoints)
      : DEFAULT_MAX_POINTS;
  const pts = series.filter(p => Number.isFinite(p.v) && Number.isFinite(p.t));
  const missing = series.length - pts.length;
  if (pts.length <= maxPoints) {
    return {
      points: pts.map(p => [r2(p.t), r2(p.v)]),
      read: pts.length,
      missing,
      kept: pts.length,
      tolerance: 0,
      maxDeviation: 0,
      whole: true,
    };
  }
  let tol = tol0;
  let kept = rdp(pts, tol);
  // Wider tolerance until it fits; the forced extremes alone always fit.
  for (let guard = 0; kept.length > maxPoints && guard < 40; guard++) {
    tol *= 2;
    kept = rdp(pts, tol);
  }
  if (kept.length > maxPoints) {
    // Pathological (a series of pure noise wider than any tolerance tried):
    // keep the ends, the extremes and an even spread.
    const step = (pts.length - 1) / (maxPoints - 1);
    const set = new Set<number>();
    for (let i = 0; i < maxPoints; i++) {
      set.add(Math.round(i * step));
    }
    kept = [...set].sort((a, b) => a - b);
  }
  return {
    points: kept.map(i => [r2(pts[i].t), r2(pts[i].v)]),
    read: pts.length,
    missing,
    kept: kept.length,
    tolerance: r2(tol),
    maxDeviation: r2(maxDeviationOf(pts, kept)),
    whole: false,
  };
}

/** Min, max, first and last of a series (non-finite readings skipped). */
export function seriesStats(series: SeriesPoint[]): {
  start: [number, number] | null;
  end: [number, number] | null;
  min: [number, number] | null;
  max: [number, number] | null;
} {
  const pts = series.filter(p => Number.isFinite(p.v));
  if (pts.length === 0) {
    return {start: null, end: null, min: null, max: null};
  }
  let lo = pts[0];
  let hi = pts[0];
  for (const p of pts) {
    if (p.v < lo.v) {
      lo = p;
    }
    if (p.v > hi.v) {
      hi = p;
    }
  }
  const pair = (p: SeriesPoint): [number, number] => [r2(p.t), r2(p.v)];
  return {start: pair(pts[0]), end: pair(pts[pts.length - 1]), min: pair(lo), max: pair(hi)};
}
