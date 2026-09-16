/**
 * A photo set's shape as the AI analysis reads it (docs/photo-set-experiments.md, "AI analysis").
 *
 * A set shares a recording's Storage layout — photo k is data_k.* — but has no time axis: its photos are
 * separate shots, often of different scenes, and the doc's `duration` is 0. The analysis therefore runs on
 * the PHOTO axis: every place a recording's summary stamps a time in seconds, a set's summary stamps the
 * photo's NUMBER — its 1-based place in the owner's viewing order, exactly what the strip shows as
 * "Photo k of N". The whole downstream pipeline (the shared `times` axis, frame statistics, the deep tools'
 * nearest-instant lookups, figure markers, the number verifier) keeps working on that axis unchanged; the
 * only things withheld are the ones that need a clock — fits, rates, phases, events — which
 * buildAnalysisDigest skips for `axis: 'photo'`.
 *
 * Pure functions, so the sampling plan is testable without Storage.
 */

import { normalizePhotoOrder, type AnalysisAxis } from './analysis';

// The axis type and the order normalizer live in analysis.ts (its cache key and freshness descriptor
// need them, and that module is also compiled into the web app's test project); re-exported here so the
// photo-set vocabulary has one import.
export { normalizePhotoOrder, type AnalysisAxis };

/** The photo-set fields of an experiment document the analysis reads. Loose: a raw Firestore doc. */
export interface PhotoSetDoc {
  photoCount?: unknown;
  photoOrder?: unknown;
  photoThermal?: unknown;
  photoCapturedAt?: unknown;
  photoTitles?: unknown;
}

/** One photo as the analysis addresses it. */
export interface PhotoSample {
  /** 1-based number in the viewing order — the `t` of every array the summary builds for it. */
  place: number;
  /** 0-based capture slot: index into the doc's per-photo arrays. */
  slot: number;
  /** The Storage frame number: data_{recordingIndex}.dat. */
  recordingIndex: number;
}

/** The set's photos in viewing order, with what the doc says about each. */
export interface PhotoCatalogueEntry {
  /** The number the report calls it by ("photo 2"). */
  n: number;
  /** Whether this photo carries temperature data (photoThermal[slot] !== false). */
  thermal: boolean;
  /** The owner's caption for the photo, or null. */
  caption: string | null;
  /** When it was taken, as an ISO instant, or null when unknown. */
  capturedAt: string | null;
  /** Seconds after the earliest known shot in the set, or null when this or that instant is unknown. */
  sinceFirstSec: number | null;
}

const photoCountOf = (exp: PhotoSetDoc): number => Math.max(0, Math.floor(Number(exp.photoCount) || 0));

/** Whether photo `slot` has temperature data. Absent flags mean every photo does. */
const hasThermal = (exp: PhotoSetDoc, slot: number): boolean =>
  !Array.isArray(exp.photoThermal) || exp.photoThermal[slot] !== false;

/**
 * Which photos the summary decodes: every photo with temperature data, in viewing order, or — past
 * `limit` of them — an even spread across that order that always keeps the first and the last. A set is
 * short as a rule (a handful of shots), so the common case reads all of them.
 */
export function planPhotoSamples(exp: PhotoSetDoc, limit: number): { samples: PhotoSample[]; thermalCount: number } {
  const count = photoCountOf(exp);
  const order = normalizePhotoOrder(exp.photoOrder, count);
  const thermal: PhotoSample[] = [];
  order.forEach((slot, place) => {
    if (hasThermal(exp, slot)) thermal.push({ place: place + 1, slot, recordingIndex: slot + 1 });
  });
  const maxPoints = Math.min(Math.max(0, Math.floor(limit)), thermal.length);
  if (maxPoints <= 0) return { samples: [], thermalCount: thermal.length };
  if (maxPoints >= thermal.length) return { samples: thermal, thermalCount: thermal.length };
  const samples: PhotoSample[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round((i * (thermal.length - 1)) / (maxPoints - 1));
    if (seen.has(idx)) continue;
    seen.add(idx);
    samples.push(thermal[idx]);
  }
  return { samples, thermalCount: thermal.length };
}

/** The photo at viewing place `place` (1-based, rounded), or null when the set has no such photo — a
 *  number off the end is NOT clamped onto the last photo: the caller asked for a photo that does not
 *  exist and must be told so, not handed another. */
export function photoAtPlace(exp: PhotoSetDoc, place: number): PhotoSample | null {
  const count = photoCountOf(exp);
  if (count === 0 || !Number.isFinite(place)) return null;
  const p = Math.round(place);
  if (p < 1 || p > count) return null;
  const order = normalizePhotoOrder(exp.photoOrder, count);
  const slot = order[p - 1];
  return { place: p, slot, recordingIndex: slot + 1 };
}

/** Whether the photo at a capture slot carries temperature data. */
export const photoHasThermal = (exp: PhotoSetDoc, slot: number): boolean => hasThermal(exp, slot);

/**
 * Every photo of the set in viewing order, with its caption and capture instant — the model's guide to
 * what "photo 3" is, including the picture-only ones the summary has no numbers for. Times are given
 * both absolutely and relative to the earliest known shot: a set taken minutes apart of one subject is
 * a legitimate time series, and the model can only judge that with the clock in front of it.
 */
export function photoCatalogue(exp: PhotoSetDoc): PhotoCatalogueEntry[] {
  const count = photoCountOf(exp);
  const order = normalizePhotoOrder(exp.photoOrder, count);
  const at = Array.isArray(exp.photoCapturedAt) ? exp.photoCapturedAt : [];
  const titles = Array.isArray(exp.photoTitles) ? exp.photoTitles : [];
  const known = at.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const first = known.length ? Math.min(...known) : null;
  return order.map((slot, place) => {
    const ms = at[slot];
    const knownMs = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : null;
    const title = titles[slot];
    return {
      n: place + 1,
      thermal: hasThermal(exp, slot),
      caption: typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : null,
      capturedAt: knownMs ? new Date(knownMs).toISOString() : null,
      sinceFirstSec: knownMs && first !== null ? Number(((knownMs - first) / 1000).toFixed(1)) : null,
    };
  });
}

/**
 * Which photos a vision model is shown. A set is usually short enough to show whole; past the budget,
 * the first and last photos, the one whose frame ran hottest, and an even spread of the rest — the set
 * has no start, peak or turning point to prefer, so coverage is the only sensible rule.
 */
export function pickPhotoSetFigureTimes(frameGlobal: { t: number; max: number }[], maxFrames: number): number[] {
  if (frameGlobal.length === 0 || maxFrames <= 0) return [];
  const all = frameGlobal.map((f) => f.t);
  if (all.length <= maxFrames) return all;
  let hottest = frameGlobal[0];
  for (const f of frameGlobal) if (f.max > hottest.max) hottest = f;
  const wanted = [all[0], hottest.t, all[all.length - 1]];
  for (let i = 1; i < all.length - 1 && wanted.length < maxFrames * 2; i++) {
    wanted.push(all[Math.round((i * (all.length - 1)) / (maxFrames - 1))]);
  }
  const picked: number[] = [];
  for (const t of wanted) {
    if (picked.includes(t)) continue;
    picked.push(t);
    if (picked.length >= maxFrames) break;
  }
  return picked.sort((a, b) => a - b);
}

/** How an instant on the axis is written in prose and in figure markers. */
export const axisLabel = (axis: AnalysisAxis, t: number): string =>
  axis === 'photo' ? `photo ${Math.round(t)}` : `t = ${t} s`;
