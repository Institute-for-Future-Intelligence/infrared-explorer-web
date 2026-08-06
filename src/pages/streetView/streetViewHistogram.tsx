/*
 * StreetViewHistogram — temperature distribution of the whole panorama, binned over a
 * robust [lo, hi] domain (percentile bounds, so outliers don't flatten it). Bars are
 * inferno-coloured to read like the scale bar. A compact glass panel in the HUD.
 */

import { useMemo } from 'react';

const BINS = 44;

// matplotlib "inferno" anchors (same ramp as the scale bar / baked palette).
const INFERNO: [number, number, number][] = [
  [0, 0, 4],
  [40, 11, 84],
  [101, 21, 110],
  [159, 42, 99],
  [212, 72, 66],
  [245, 125, 21],
  [250, 193, 39],
  [252, 255, 164],
];
function infernoAt(t: number): string {
  const s = Math.max(0, Math.min(1, t)) * (INFERNO.length - 1);
  const i = Math.min(INFERNO.length - 2, Math.floor(s));
  const f = s - i;
  const [r0, g0, b0] = INFERNO[i];
  const [r1, g1, b1] = INFERNO[i + 1];
  return `rgb(${Math.round(r0 + (r1 - r0) * f)},${Math.round(g0 + (g1 - g0) * f)},${Math.round(b0 + (b1 - b0) * f)})`;
}

interface Props {
  grid: Float32Array;
  valid: Uint8Array;
  w: number;
  h: number;
  /** Column window (with wrap) to bin — the currently VISIBLE azimuth range. */
  colStart: number;
  colCount: number;
  /** Fixed temperature domain (global percentile bounds) so the x-axis is stable. */
  lo: number;
  hi: number;
}

export default function StreetViewHistogram({ grid, valid, w, h, colStart, colCount, lo, hi }: Props) {
  const { bins, max } = useMemo(() => {
    const b = new Float64Array(BINS);
    const span = hi - lo || 1;
    // Only the visible columns (all rows) — so the histogram reflects the current view.
    for (let cc = 0; cc < colCount; cc++) {
      const col = (colStart + cc) % w;
      for (let row = 0; row < h; row++) {
        const i = row * w + col;
        if (!valid[i]) continue;
        let k = Math.floor(((grid[i] - lo) / span) * BINS);
        if (k < 0) k = 0;
        else if (k >= BINS) k = BINS - 1;
        b[k]++;
      }
    }
    let m = 0;
    for (const v of b) if (v > m) m = v;
    return { bins: b, max: m };
  }, [grid, valid, w, h, colStart, colCount, lo, hi]);

  const W = 260;
  const H = 68;
  const bw = W / BINS;

  return (
    <div className="sv-hist">
      <svg width={W} height={H} className="sv-hist-svg" aria-label="temperature histogram">
        {Array.from(bins).map((v, i) => {
          const bh = max ? (v / max) * (H - 2) : 0;
          return (
            <rect
              key={i}
              x={i * bw}
              y={H - bh}
              width={Math.max(0.5, bw - 0.6)}
              height={bh}
              fill={infernoAt(i / (BINS - 1))}
            />
          );
        })}
      </svg>
      <div className="sv-hist-axis">
        <span>{Math.round(lo)}°C</span>
        <span>{Math.round(hi)}°C</span>
      </div>
    </div>
  );
}
