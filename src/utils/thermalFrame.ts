/*
 * @Copyright 2021. Institute for Future Intelligence, Inc.
 */

import Pako from 'pako';
import { Dimension } from '../types';
import { INTSIZE, IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from './constants';

/**
 * One thermal frame decoded a single time: the pako-inflate and the per-pixel walk are the expensive
 * part of every thermal read, and the analyzer reads the SAME frame many times per tick (one point/area
 * read per probe, plus whole-grid passes for isotherms / the 3D surface / the AI summary). Splitting the
 * decode out and caching it (see getDecodedFrame) turns "N reads of a frame" into one inflate + one walk.
 *
 * Two planes are kept per frame:
 *  - `raw`   — the untouched centi-Kelvin uint16 values. Probe readings decode off THIS so they stay
 *              bit-for-bit identical to the old point/area readers (integer in → same Celsius out), with
 *              no float32 rounding in the path.
 *  - `temps` — Celsius (float32), for the whole-grid consumers (isotherms threshold math, 3D vertex
 *              height, thumbnail normalisation) that would otherwise recompute kelvinToCelsius per read.
 *
 * `min`/`max`/`mean`/`minIdx`/`maxIdx` are the frame's Celsius stats over `temps`, computed in the same
 * pass (strict compares → first-occurrence argmin/argmax, matching the old frameStatsClient loop).
 */
export interface DecodedFrame {
  width: number;
  height: number;
  temps: Float32Array; // Celsius, row-major (idx = y * width + x); DO NOT MUTATE — shared across consumers
  raw: Uint16Array; // centi-Kelvin, row-major; source of truth for probe reads
  min: number;
  max: number;
  mean: number;
  minIdx: number;
  maxIdx: number;
  complete: boolean; // false when the inflated buffer was shorter than width*height (a corrupt/truncated frame)
}

const DEFAULT_DIM: Dimension = {
  width: IR_ARRAY_WIDTH,
  height: IR_ARRAY_HEIGHT,
  size: IR_ARRAY_WIDTH * IR_ARRAY_HEIGHT,
};

/**
 * Decode one pako-DEFLATEd frame buffer (a recording's data_N.dat, or one .vir frame). Pako.inflate accepts
 * the Uint8Array (video) or ArrayBuffer (recording getBytes) as-is and always returns a fresh, exact-length
 * Uint8Array, so we index its bytes directly (uint16 big-endian at offset +2 of each 4-byte record). Throws
 * only if the inflate itself fails (corrupt gzip) — the same failure the old readers surfaced; a merely
 * SHORT inflate is tolerated (missing pixels read 0 → -273.15, as the old slice-past-end sentinel did) and
 * flagged via `complete=false` for callers that want to fall back (e.g. the thumbnail).
 */
export const decodeThermalFrame = (deflated: ArrayBufferLike, dim: Dimension = DEFAULT_DIM): DecodedFrame => {
  const inflated = Pako.inflate(deflated); // Uint8Array; throws on corrupt input
  const size = dim.size;
  const available = Math.min(size, Math.floor(inflated.length / INTSIZE));

  const temps = new Float32Array(size);
  const raw = new Uint16Array(size);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0; // f64 accumulator — keeps the mean off float32's rounding
  let minIdx = 0;
  let maxIdx = 0;

  for (let i = 0; i < size; i++) {
    // Past `available` (only a truncated frame) the record is absent → value 0 → -273.15, mirroring the old
    // readArrayBufferPoint slice-past-end behaviour so probe reads over `raw` stay identical.
    const b = i * INTSIZE;
    const v = i < available ? (inflated[b + 2] << 8) | inflated[b + 3] : 0;
    raw[i] = v;
    const c = v / 100 - 273.15; // kelvinToCelsius(v / 100)
    temps[i] = c;
    sum += c;
    if (c < min) {
      min = c;
      minIdx = i;
    }
    if (c > max) {
      max = c;
      maxIdx = i;
    }
  }

  return {
    width: dim.width,
    height: dim.height,
    temps,
    raw,
    min,
    max,
    mean: sum / size,
    minIdx,
    maxIdx,
    complete: available === size,
  };
};

// LRU of decoded frames, keyed by the DEFLATED buffer's object identity (never normalised to `.buffer`, so
// video Uint8Arrays and recording ArrayBuffers both key stably — every call site passes the stored object
// itself). Cap 64: the largest single-pass working set is scatterPlot's 25 sampled frames (probe-outer),
// and concurrent key-moment (≤24) / line-plot (25) sets stay well under, so a decoded frame is never
// evicted mid-pass. ≈64 × (76.8KB temps + 38.4KB raw) ≈ 7.4MB, bounded (not a growing cache).
const CACHE_CAP = 64;
const cache = new Map<object, DecodedFrame>();

// CAUTION: the cache holds ONE decoded frame per buffer identity and IGNORES `dim` on a hit. Every current
// caller passes the default 120x160, so this is safe. If a non-120x160 path ever needs a real dim here,
// switch the key to a composite `${bufferId}:${w}x${h}` first — otherwise a buffer decoded at two dims
// would thrash (decode-first-wins). See virReader's non-standard-dimension guard.
/** decodeThermalFrame with an identity-keyed LRU. Throws (uncached) if the frame can't be inflated. */
export const getDecodedFrame = (deflated: ArrayBufferLike, dim: Dimension = DEFAULT_DIM): DecodedFrame => {
  const key = deflated as object;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // touch → most-recently-used
    cache.set(key, hit);
    return hit;
  }
  const frame = decodeThermalFrame(deflated, dim);
  cache.set(key, frame);
  if (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return frame;
};

/** Drop all cached frames (e.g. to release memory when leaving the analyzer). */
export const clearDecodedFrameCache = () => cache.clear();
