import { ExperimentType } from '../types';

/**
 * When an experiment's footage was taken — the "Captured" date on the owner's cards (My Experiments /
 * Raw Data).
 *
 * Docs that say it outright: a photo set stamps every photo (photoCapturedAt) and a recording its start
 * (startedAt — every app upload since 2026-10, only time-lapses before), and a copy or clip carries both
 * over. An older ordinary recording says nothing, so the nearest the doc gets is when the app uploaded it
 * — the original's createdAt. That is usually minutes after the take, but a re-upload from the app's
 * gallery can be days later, so it comes back with `exact: false` and the card says "Uploaded" rather than
 * claim a capture time. A copy's own createdAt is when it was copied, never when it was shot, so a copy
 * follows clonedFrom back to its original.
 */
export interface CaptureTime {
  ms: number; // epoch ms
  exact: boolean; // false = only the original's upload time is known
}

/** The fields the answer is read from (an ExperimentDoc satisfies it). */
export interface CaptureDoc {
  sourceType?: ExperimentType | null;
  photoCapturedAt?: number[];
  startedAt?: number;
  clonedFrom?: string;
  createdAt?: { toMillis(): number } | null;
}

/**
 * Looks up a source by id: the doc, null when it can't be had (deleted, or private to this viewer), or
 * undefined when it hasn't been loaded yet.
 */
export type CaptureLookup = (id: string) => CaptureDoc | null | undefined;

// A copy of a copy of … — far more hops than any real chain, only there to stop a cycle.
const MAX_HOPS = 16;

const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** The capture instant a doc stamps itself: its earliest photo, or the start of a time-lapse take. */
function stampedMs(d: CaptureDoc): number | null {
  const photos = (d.photoCapturedAt ?? []).filter(isPositive);
  if (photos.length) return Math.min(...photos);
  return isPositive(d.startedAt) ? d.startedAt : null;
}

/**
 * `time` is the answer (null = nothing to go on). `missing` names the source the walk stopped at because
 * `lookup` hasn't loaded it yet — fetch it and ask again.
 */
export function resolveCaptureTime(
  d: CaptureDoc,
  lookup: CaptureLookup,
): { time: CaptureTime | null; missing?: string } {
  const seen = new Set<string>();
  let cur: CaptureDoc = d;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const shot = stampedMs(cur);
    if (shot != null) return { time: { ms: shot, exact: true } };
    const from = cur.clonedFrom;
    if (!from) {
      // An original: only one the app uploaded has an upload time that stands in for the take (a video
      // showcase's createdAt is when it was imported to this site).
      const isCapture = cur.sourceType === ExperimentType.Recording || cur.sourceType === ExperimentType.Photos;
      const uploaded = isCapture ? cur.createdAt?.toMillis?.() : undefined;
      return { time: isPositive(uploaded) ? { ms: uploaded, exact: false } : null };
    }
    if (seen.has(from)) break;
    seen.add(from);
    const src = lookup(from);
    if (src === undefined) return { time: null, missing: from };
    if (src === null) break;
    cur = src;
  }
  return { time: null };
}
