/*
 * useStreetViewFrames — the pictures behind an APP-CAPTURED street view's look-around.
 *
 * An app upload has no stitched panorama: its 360° is ~110 separate `data_N.png` frames in
 * Storage, each a 1080×1440 render of the 120×160 sensor (~400 KB) served with
 * `Cache-Control: private, max-age=0`. Pointing an <img src> at the frame under the cursor
 * therefore cost a full round trip PER FRAME, which is why dragging used to sit still until
 * the hand stopped and then jump. This keeps a small window of decoded frames in memory:
 *
 *  - fetched and decoded as ImageBitmaps (off the main thread), downscaled on decode — the
 *    pixels are a 9× upsample of a 120×160 sensor, so a 1024-tall bitmap loses nothing real
 *    and costs a quarter of the memory;
 *  - prefetched outward from the frame being looked at, so the next few degrees of drag are
 *    already in hand, while loads the drag has run away from are aborted;
 *  - evicted farthest-first past a cap, so a long sweep can't grow without bound.
 *
 * The viewer paints whatever is `nearest()` the look direction and shifts it by the angle
 * between that frame and where the viewer is actually facing, so the picture follows the
 * pointer continuously even before the exact frame lands.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { streetViewFileUrl } from '../utils/streetView';
import { wrapFrame } from '../utils/streetViewPano';

/** Decoded height of a cached frame. The sensor behind it is 160 rows, so 768 is already far
 *  more than the picture can actually resolve — it only costs a quarter of full size to hold. */
const DECODE_HEIGHT = 768;
/** Frames held either side of the look direction (±6 of ~110 ≈ ±20° of instant turning). */
const PREFETCH_RADIUS = 6;
/** Decoded frames kept (≈1.8 MB each) before the farthest ones are dropped. */
const CACHE_CAP = 20;
/** Parallel downloads — enough to fill the window quickly, few enough to stay responsive. */
const MAX_INFLIGHT = 4;

export interface StreetViewFrames {
  /** Bumps whenever a frame lands or is dropped, so the canvas repaints. */
  version: number;
  /** Natural size of a frame picture (aspect only — bitmaps are downscaled), or null. */
  natural: { w: number; h: number } | null;
  /** The decoded frame, or null when it isn't in memory. */
  get: (frame: number) => ImageBitmap | null;
  /** The decoded frame circularly nearest `frame`, or null when nothing has landed yet. */
  nearest: (frame: number) => number | null;
}

/** Frames apart the short way round the circle. */
function circularDistance(a: number, b: number, count: number): number {
  const d = Math.abs(a - b) % count;
  return Math.min(d, count - d);
}

export function useStreetViewFrames(
  svId: string,
  frameCount: number,
  center: number,
  enabled: boolean,
): StreetViewFrames {
  const bitmaps = useRef(new Map<number, ImageBitmap>());
  const inflight = useRef(new Map<number, AbortController>());
  const failed = useRef(new Set<number>());
  const attempts = useRef(new Map<number, number>());
  const centerRef = useRef(center);
  const [version, setVersion] = useState(0);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  // pump ⇄ load recur through each other (a finished load starts the next one), so the
  // settle handler reaches the current pump through a ref rather than a stale closure.
  const pumpRef = useRef<() => void>(() => {});

  /** Drop the frames farthest from where the viewer is looking, down to the cap. */
  const evict = useCallback(() => {
    while (bitmaps.current.size > CACHE_CAP) {
      let worst = -1;
      let worstDist = -1;
      for (const f of bitmaps.current.keys()) {
        const d = circularDistance(f, centerRef.current, frameCount);
        if (d > worstDist) {
          worstDist = d;
          worst = f;
        }
      }
      if (worst < 0) break;
      bitmaps.current.get(worst)?.close();
      bitmaps.current.delete(worst);
    }
  }, [frameCount]);

  const load = useCallback(
    (frame: number) => {
      const ac = new AbortController();
      inflight.current.set(frame, ac);
      fetch(streetViewFileUrl(svId, `data_${frame}.png`), { signal: ac.signal })
        .then((r) => {
          // A frame that isn't there (a half-finished upload) will never be there; give up on
          // it at once rather than asking again on every pointer move.
          if (!r.ok && r.status >= 400 && r.status < 500) failed.current.add(frame);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.blob();
        })
        .then((blob) =>
          // resizeHeight keeps the aspect; Safari has historically ignored the options
          // dictionary, so fall back to a full-size decode rather than failing the frame.
          createImageBitmap(blob, { resizeHeight: DECODE_HEIGHT, resizeQuality: 'medium' }).catch(() =>
            createImageBitmap(blob),
          ),
        )
        .then((bmp) => {
          if (ac.signal.aborted) {
            bmp.close();
            return;
          }
          bitmaps.current.get(frame)?.close();
          bitmaps.current.set(frame, bmp);
          setNatural((prev) => prev ?? { w: bmp.width, h: bmp.height });
          evict();
          setVersion((v) => v + 1);
        })
        .catch((e: unknown) => {
          // An abort is this hook's own doing (the drag moved on). A dropped connection is
          // worth one more try when the prefetcher next comes round; past that, let it go,
          // because a retry on every pointer move would only spin.
          if (e instanceof DOMException && e.name === 'AbortError') return;
          const tries = (attempts.current.get(frame) ?? 0) + 1;
          attempts.current.set(frame, tries);
          if (tries >= 2) failed.current.add(frame);
        })
        .finally(() => {
          if (inflight.current.get(frame) === ac) inflight.current.delete(frame);
          pumpRef.current();
        });
    },
    [svId, evict],
  );

  const pump = useCallback(() => {
    if (!enabled || frameCount <= 0) return;
    const c = centerRef.current;
    for (const [f, ac] of inflight.current) {
      if (circularDistance(f, c, frameCount) > PREFETCH_RADIUS) {
        ac.abort();
        inflight.current.delete(f);
      }
    }
    for (let d = 0; d <= PREFETCH_RADIUS; d++) {
      const candidates = d === 0 ? [c] : [wrapFrame(c + d, frameCount), wrapFrame(c - d, frameCount)];
      for (const f of candidates) {
        if (inflight.current.size >= MAX_INFLIGHT) return;
        if (bitmaps.current.has(f) || inflight.current.has(f) || failed.current.has(f)) continue;
        load(f);
      }
    }
  }, [enabled, frameCount, load]);
  pumpRef.current = pump;

  useEffect(() => {
    centerRef.current = center;
    pump();
  }, [center, pump]);

  // Everything here belongs to ONE street view; the viewer is keyed by svId so this runs on
  // close, but clear on an svId change too, so a reused instance can't paint the old sweep.
  useEffect(() => {
    const bmps = bitmaps.current;
    const flying = inflight.current;
    const dead = failed.current;
    const tried = attempts.current;
    return () => {
      for (const ac of flying.values()) ac.abort();
      flying.clear();
      for (const b of bmps.values()) b.close();
      bmps.clear();
      dead.clear();
      tried.clear();
    };
  }, [svId]);

  const get = useCallback((frame: number) => bitmaps.current.get(frame) ?? null, []);

  const nearest = useCallback(
    (frame: number) => {
      if (frameCount <= 0) return null;
      if (bitmaps.current.has(frame)) return frame;
      for (let d = 1; d <= frameCount / 2 + 1; d++) {
        const up = wrapFrame(frame + d, frameCount);
        if (bitmaps.current.has(up)) return up;
        const down = wrapFrame(frame - d, frameCount);
        if (bitmaps.current.has(down)) return down;
      }
      return null;
    },
    [frameCount],
  );

  // Identity changes exactly when a frame lands (or the first one settles the size), which
  // is what tells the viewer's paint effect there is something new to draw.
  return useMemo(() => ({ version, natural, get, nearest }), [version, natural, get, nearest]);
}
