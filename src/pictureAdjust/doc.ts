/**
 * The Process settings an uploaded capture carries, as this site reads them off its experiment document.
 *
 * The capture app writes them with the upload (its experimentDoc.ts, 2026-11-20): what its Adjust panel —
 * shown as Process — was left at for each view of the capture, eleven sliders and a stack of effects.
 *
 *   a recording   pictureAdjust       { version: 1, views: { ir?, visible?, blended? } }
 *   a photo set   photoPictureAdjust  { version: 1, photos: [ views | null, … ] }   one entry a photo, in
 *                                     capture order (entry k-1 ↔ data_k.*), null where a photo has none
 *
 * Neither key is there when nothing was processed. The settings are never in the files: the frames under
 * recordings/<id>/ are the capture as made, and a processed view is drawn here from them
 * (pictureAdjust/adjustFrame.ts) — so it can always be shown as made, too.
 *
 * Read with the app's own sanitizer (core/pictureAdjustParams): a slider out of its travel is clamped, an
 * effect this build does not know is dropped. A `version` this build does not know is not guessed at: the
 * capture is shown as made.
 *
 * A still's fourth view on the phone, 'captured' (the picture as it was saved, where a bundle holds no
 * clean render), has no counterpart among the three views here, and is not read.
 */
import type { ViewMode } from '../types';
import {
  PictureAdjust,
  ViewAdjusts,
  isAdjusted,
  sameAdjust,
  sanitizeViewAdjusts,
  withViewAdjust,
} from './core/pictureAdjustParams';

/** The settings' shape this build reads (the app's PICTURE_ADJUST_DOC_VERSION). */
export const PICTURE_ADJUST_DOC_VERSION = 1;

/** `pictureAdjust` on a recording's document. */
export interface PictureAdjustDoc {
  version: number;
  views: ViewAdjusts;
}

/** `photoPictureAdjust` on a photo set's document. */
export interface PhotoPictureAdjustDoc {
  version: number;
  photos: (ViewAdjusts | null)[];
}

const known = (raw: unknown): raw is { version: number } =>
  !!raw && typeof raw === 'object' && (raw as { version?: unknown }).version === PICTURE_ADJUST_DOC_VERSION;

/** A recording's processed views; null when it has none this build can read. */
export function recordingAdjusts(raw: unknown): ViewAdjusts | null {
  if (!known(raw)) return null;
  return sanitizeViewAdjusts((raw as { views?: unknown }).views) ?? null;
}

/**
 * A photo set's processed views, one entry a photo in capture order; null when no photo has any this
 * build can read, or the list does not line up with the set's photos.
 */
export function photoAdjusts(raw: unknown, photoCount: number): (ViewAdjusts | null)[] | null {
  if (!known(raw)) return null;
  const photos = (raw as { photos?: unknown }).photos;
  if (!Array.isArray(photos) || photos.length !== photoCount) return null;
  const out = photos.map((one) => sanitizeViewAdjusts(one) ?? null);
  return out.some((one) => one != null) ? out : null;
}

/** What of an experiment the settings are read from. */
export interface AdjustedExperiment {
  pictureAdjust?: unknown;
  photoPictureAdjust?: unknown;
}

/** An experiment's settings, read once: a recording's views, or a photo set's by photo. */
export interface ExperimentAdjusts {
  recording: ViewAdjusts | null;
  photos: (ViewAdjusts | null)[] | null;
}

/** `photoCount`: the set's number of photos; 0 for a recording. */
export function experimentAdjusts(exp: AdjustedExperiment, photoCount: number): ExperimentAdjusts {
  return photoCount > 0
    ? { recording: null, photos: photoAdjusts(exp.photoPictureAdjust, photoCount) }
    : { recording: recordingAdjusts(exp.pictureAdjust), photos: null };
}

/**
 * The settings a frame is drawn with in `mode`; null when that view of it is as made. `photoSlot`: a photo
 * set's 0-based capture slot (frame k is slot k-1); ignored for a recording, whose views are processed
 * whole.
 */
export function frameAdjust(all: ExperimentAdjusts, mode: ViewMode, photoSlot: number = 0): PictureAdjust | null {
  const views = all.photos ? all.photos[photoSlot] : all.recording;
  return views?.[mode] ?? null;
}

/** Whether any view of the experiment (any photo of a set) is processed. */
export function anyAdjusted(all: ExperimentAdjusts): boolean {
  return all.recording != null || (all.photos?.some((one) => one != null) ?? false);
}

/** The fields a copy of the experiment carries so that it opens processed as its source does. */
export function adjustFieldsOf(src: AdjustedExperiment): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (src.pictureAdjust && typeof src.pictureAdjust === 'object') out.pictureAdjust = src.pictureAdjust;
  if (src.photoPictureAdjust && typeof src.photoPictureAdjust === 'object') {
    out.photoPictureAdjust = src.photoPictureAdjust;
  }
  return out;
}

/**
 * `all` with the settings of one picture changed — the Process panel's edit (processPanel.tsx): `mode` of a
 * recording, or of the photo in capture slot `photoSlot` of a set of `photoCount`. Settings that change
 * nothing take the view out; a photo, or a recording, left with no processed view is as made again.
 */
export function withFrameAdjust(
  all: ExperimentAdjusts,
  mode: ViewMode,
  next: PictureAdjust | null,
  photoCount: number,
  photoSlot: number = 0,
): ExperimentAdjusts {
  if (photoCount <= 0)
    return { recording: withViewAdjust(all.recording ?? undefined, mode, next) ?? null, photos: null };
  const photos: (ViewAdjusts | null)[] =
    all.photos && all.photos.length === photoCount ? [...all.photos] : new Array(photoCount).fill(null);
  if (photoSlot < 0 || photoSlot >= photoCount) return { recording: null, photos: all.photos };
  photos[photoSlot] = withViewAdjust(photos[photoSlot] ?? undefined, mode, next) ?? null;
  return { recording: null, photos: photos.some((one) => one != null) ? photos : null };
}

/** Whether two sets of settings draw every view of every picture the same. */
export function sameAdjusts(a: ExperimentAdjusts, b: ExperimentAdjusts): boolean {
  const sameViews = (x: ViewAdjusts | null | undefined, y: ViewAdjusts | null | undefined): boolean => {
    const keys = new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})]) as Set<keyof ViewAdjusts>;
    for (const k of keys) {
      const one = x?.[k];
      const other = y?.[k];
      if (!one || !other ? isAdjusted(one) || isAdjusted(other) : !sameAdjust(one, other)) return false;
    }
    return true;
  };
  if (!sameViews(a.recording, b.recording)) return false;
  const n = Math.max(a.photos?.length ?? 0, b.photos?.length ?? 0);
  for (let i = 0; i < n; i++) if (!sameViews(a.photos?.[i], b.photos?.[i])) return false;
  return true;
}

/**
 * The settings as the experiment's document holds them: the two keys, each the value to store or null
 * where the key is to go (nothing processed). The shape the capture app writes with an upload. Plain
 * data: nothing undefined in it, which Firestore refuses.
 */
export function adjustDocFields(
  all: ExperimentAdjusts,
  photoCount: number,
): { pictureAdjust: PictureAdjustDoc | null; photoPictureAdjust: PhotoPictureAdjustDoc | null } {
  const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  if (photoCount > 0) {
    return {
      pictureAdjust: null,
      photoPictureAdjust: all.photos?.some((one) => one != null)
        ? plain({ version: PICTURE_ADJUST_DOC_VERSION, photos: all.photos })
        : null,
    };
  }
  return {
    pictureAdjust: all.recording ? plain({ version: PICTURE_ADJUST_DOC_VERSION, views: all.recording }) : null,
    photoPictureAdjust: null,
  };
}
