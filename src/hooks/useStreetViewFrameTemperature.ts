/*
 * useStreetViewFrameTemperature — °C for ONE frame of an app-captured street view, so the
 * probe / scale / histogram / isotherm tools work on an upload the same way they work on the
 * seeded map.
 *
 * The seeded map reads temperatures out of a baked temperature panorama (usePanoTemperature,
 * stitchAll.mjs). An app upload has no bake — but it carries the same data per frame, as
 * `streetviews/{id}/data_N.dat`: the 120×160 pako frame the analyzer already decodes, ~30 KB,
 * a fifteenth of the picture beside it. So the tools don't need the bake; they need the frame
 * under the cursor, which is what this fetches.
 *
 * Two deliberate differences from the panorama source:
 *  - a point is addressed in the FRAME's own space (x across the picture), not by azimuth
 *    across 360°, since one frame is all there is to sample;
 *  - min/max are the FRAME's. That is the honest scale here: each data_N.png is rendered with
 *    its own AGC, so what a colour means is a property of the frame, not of the sweep.
 *
 * While a new frame's `.dat` is in flight the previous frame's readings stay up rather than
 * blinking "unavailable" through a drag; frames are ~3° apart, so what it says stays true to
 * within a hair until it lands.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getDecodedFrame } from '../utils/thermalFrame';
import { streetViewFileUrl } from '../utils/streetView';
import type { PanoTemperature } from './usePanoTemperature';

interface FrameTemperature {
  grid: Float32Array;
  valid: Uint8Array;
  w: number;
  h: number;
  tMin: number;
  tMax: number;
  pLow: number;
  pHigh: number;
}

/** A truncated frame decodes to 0 centi-kelvin → −273.15 °C; that is a gap, not a reading. */
const ABSOLUTE_ZERO_GUARD = -270;

/** Decoded frames kept across a session (≈96 KB each) — a whole 110-shot sweep and change. */
const CACHE_MAX = 140;
const cache = new Map<string, FrameTemperature>();

function remember(key: string, value: FrameTemperature) {
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function summarise(buffer: ArrayBuffer): FrameTemperature {
  const { temps, width, height } = getDecodedFrame(buffer);
  const valid = new Uint8Array(temps.length);
  const vals: number[] = [];
  let tMin = Infinity;
  let tMax = -Infinity;
  for (let i = 0; i < temps.length; i++) {
    const c = temps[i];
    if (!Number.isFinite(c) || c <= ABSOLUTE_ZERO_GUARD) continue;
    valid[i] = 1;
    vals.push(c);
    if (c < tMin) tMin = c;
    if (c > tMax) tMax = c;
  }
  if (!Number.isFinite(tMin)) {
    tMin = 0;
    tMax = 1;
  }
  // Robust bounds (2nd/98th percentile) so one hot pixel can't stretch the scale, the
  // histogram's domain or the isotherm defaults — same contract as the panorama source.
  vals.sort((a, b) => a - b);
  const pct = (p: number) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : tMin);
  const pLow = vals.length ? pct(0.02) : tMin;
  const pHigh = vals.length ? pct(0.98) : tMax;
  return { grid: temps, valid, w: width, h: height, tMin, tMax, pLow, pHigh: pHigh > pLow ? pHigh : pLow + 1 };
}

export function useStreetViewFrameTemperature(svId: string, frame: number, enabled: boolean): PanoTemperature {
  const [state, setState] = useState<FrameTemperature | null>(null);
  const [error, setError] = useState(false);
  // What the viewer would ask for, kept out of the effect's deps: a late fetch must not
  // overwrite the readings for a frame the drag has already moved past.
  const wantedRef = useRef(frame);
  wantedRef.current = frame;

  useEffect(() => {
    if (!enabled) return;
    const key = `${svId}/${frame}`;
    const hit = cache.get(key);
    if (hit) {
      setState(hit);
      setError(false);
      return;
    }
    const ac = new AbortController();
    fetch(streetViewFileUrl(svId, `data_${frame}.dat`), { signal: ac.signal })
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((buf) => {
        const summary = summarise(buf);
        remember(key, summary);
        if (wantedRef.current === frame) {
          setState(summary);
          setError(false);
        }
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // No .dat beside the pictures (a legacy clip, a half-finished upload): the tools have
        // nothing to read, and say so rather than offering buttons that do nothing.
        if (wantedRef.current === frame) setError(true);
      });
    return () => ac.abort();
  }, [svId, frame, enabled]);

  const sampleAt = useCallback(
    (xFrac: number, yFrac: number): number | null => {
      if (!state) return null;
      if (xFrac < 0 || xFrac > 1 || yFrac < 0 || yFrac > 1) return null;
      const col = Math.min(state.w - 1, Math.max(0, Math.floor(xFrac * state.w)));
      const row = Math.min(state.h - 1, Math.max(0, Math.floor(yFrac * state.h)));
      const i = row * state.w + col;
      return state.valid[i] ? state.grid[i] : null;
    },
    [state],
  );

  return {
    ready: !!state,
    error,
    tMin: state?.tMin ?? 0,
    tMax: state?.tMax ?? 1,
    pLow: state?.pLow ?? 0,
    pHigh: state?.pHigh ?? 1,
    data: state ? { grid: state.grid, valid: state.valid, w: state.w, h: state.h } : null,
    sampleAt,
  };
}
