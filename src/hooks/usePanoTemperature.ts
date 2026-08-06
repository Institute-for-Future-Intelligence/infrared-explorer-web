import { useCallback, useEffect, useState } from 'react';

/*
 * Load a street view's temperature panorama (streetviews/{id}/pano_temp.png, baked by
 * stitchAll.mjs) and expose it for the thermal tools. The PNG encodes centi-kelvin in
 * its R/G bytes (°C = (R*256 + G)/100 − 273.15), with A=0 marking gaps. We draw it to
 * an offscreen canvas once and read the pixels back (needs CORS — the Storage bucket
 * serves it; on a CORS/taint failure the tools stay disabled). Aligned to the visual
 * pano (both span the full 360°, 0°=North at x=0), so a point is addressed by
 * azimuth-fraction [0,1) × vertical-fraction [0,1].
 *
 * Exposes: sampleAt (probe), the raw grid (histogram + isotherm overlay), the true
 * min/max, and robust pLow/pHigh (2nd/98th percentile) so a single hot pixel doesn't
 * stretch the scale / histogram domain / isotherm slider.
 */

interface Loaded {
  grid: Float32Array;
  valid: Uint8Array;
  w: number;
  h: number;
  tMin: number;
  tMax: number;
  pLow: number;
  pHigh: number;
}

export interface PanoTemperature {
  ready: boolean;
  error: boolean;
  tMin: number;
  tMax: number;
  pLow: number;
  pHigh: number;
  data: { grid: Float32Array; valid: Uint8Array; w: number; h: number } | null;
  /** °C at azimuth-fraction [0,1) and vertical-fraction [0,1], or null (gap / not ready). */
  sampleAt: (azFrac: number, yFrac: number) => number | null;
}

export function usePanoTemperature(url: string | undefined, fallbackMin = 0, fallbackMax = 1): PanoTemperature {
  const [state, setState] = useState<Loaded | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setState(null);
    setError(false);
    if (!url) return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('no 2d context');
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, w, h).data; // throws if CORS-tainted
        const grid = new Float32Array(w * h);
        const valid = new Uint8Array(w * h);
        const vals: number[] = [];
        let tMin = Infinity;
        let tMax = -Infinity;
        for (let i = 0; i < w * h; i++) {
          const o = i * 4;
          if (px[o + 3] < 128) {
            grid[i] = NaN;
            continue;
          }
          const c = (px[o] * 256 + px[o + 1]) / 100 - 273.15;
          grid[i] = c;
          valid[i] = 1;
          vals.push(c);
          if (c < tMin) tMin = c;
          if (c > tMax) tMax = c;
        }
        if (!Number.isFinite(tMin)) {
          tMin = fallbackMin;
          tMax = fallbackMax;
        }
        // Robust bounds so a single hot/cold pixel doesn't dominate the scale/histogram.
        vals.sort((a, b) => a - b);
        const pct = (p: number) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : tMin);
        const pLow = vals.length ? pct(0.02) : tMin;
        const pHigh = vals.length ? pct(0.98) : tMax;
        setState({ grid, valid, w, h, tMin, tMax, pLow, pHigh: pHigh > pLow ? pHigh : pLow + 1 });
      } catch {
        setError(true);
      }
    };
    img.onerror = () => {
      if (!cancelled) setError(true);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url, fallbackMin, fallbackMax]);

  const sampleAt = useCallback(
    (azFrac: number, yFrac: number): number | null => {
      if (!state) return null;
      const col = Math.min(state.w - 1, Math.max(0, Math.floor((((azFrac % 1) + 1) % 1) * state.w)));
      const row = Math.min(state.h - 1, Math.max(0, Math.floor(yFrac * state.h)));
      const i = row * state.w + col;
      return state.valid[i] ? state.grid[i] : null;
    },
    [state],
  );

  return {
    ready: !!state,
    error,
    tMin: state?.tMin ?? fallbackMin,
    tMax: state?.tMax ?? fallbackMax,
    pLow: state?.pLow ?? fallbackMin,
    pHigh: state?.pHigh ?? fallbackMax,
    data: state ? { grid: state.grid, valid: state.valid, w: state.w, h: state.h } : null,
    sampleAt,
  };
}
