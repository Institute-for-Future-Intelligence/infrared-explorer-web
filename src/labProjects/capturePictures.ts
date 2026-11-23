/*
 * The captures that are a picture and nothing more: a photo with no
 * temperature data, taken with the phone's own camera or picked from its
 * library (the app's "Shoot from System Camera" and "Add from System
 * Gallery"). Its cloud copy is a one-photo set whose photo is marked
 * picture-only (ExperimentDoc.photoThermal, src/types.ts) and whose thumbnail
 * is the picture itself; the analyzer has nothing to measure on it. So its
 * tile in the Captures tab and in the tray beside the message box opens it in
 * the experiment's own Lightbox, among the other such pictures of that place,
 * not on the recording's page (user decision, 2026-11-12). A photo with
 * temperature data and a recording open in the analyzer from there, as before.
 *
 * Pure; tested in capturePictures.test.ts.
 */

import type { CaptureName } from './core/captureNumbers';
import type { Take } from './core/types';
import type { LightboxPicture } from './components/Lightbox';
import { capturePhoto } from './discussViewer';
import type { CloudThumbState } from './useCloudThumbs';

/**
 * What an experiment document says of itself: one picture, without
 * temperature data. A set of several stays a recording's page matter (the
 * Lightbox would show its first photo only), and absent flags — an upload
 * from before they were written — mean the photo has its data.
 */
export function isPictureOnly(doc: { sourceType?: unknown; photoCount?: unknown; photoThermal?: unknown }): boolean {
  if (doc.sourceType !== 'photos' || !Array.isArray(doc.photoThermal)) {
    return false;
  }
  const count = typeof doc.photoCount === 'number' ? doc.photoCount : doc.photoThermal.length;
  return count === 1 && doc.photoThermal[0] === false;
}

// The file name a cover ends in, in either spelling (a download URL does not escape it).
const APP_THUMB_FILE = /(\/|%2F)thumb\.jpg(?=$|[?#])/i;

/**
 * Where a photo capture's own picture is when its thumbnail is not it. Since 2026-11-21 the app sends
 * a photo with temperature data a thumb.jpg — its gallery tile, small (the app's cloudThumbnail.ts) —
 * and the thumbnail points there; the photo itself is still the render beside it, data_N.png, which is
 * what the Lightbox shows. Null when the thumbnail is the picture (every other cover: data_N.png, a
 * custom one), or the document is not a photo set.
 */
export function photoPictureUrl(
  doc: { sourceType?: unknown; photoOrder?: unknown },
  thumbnailUrl: string | null,
): string | null {
  if (doc.sourceType !== 'photos' || !thumbnailUrl || !APP_THUMB_FILE.test(thumbnailUrl)) {
    return null;
  }
  const first = Array.isArray(doc.photoOrder) ? doc.photoOrder[0] : 0;
  const slot = typeof first === 'number' && Number.isInteger(first) && first >= 0 ? first : 0;
  return thumbnailUrl.replace(APP_THUMB_FILE, `$1data_${slot + 1}.png`);
}

/**
 * A capture as the Lightbox shows it from the Captures tab or the tray: a
 * picture-only photo with a cloud copy, captioned as in Discuss
 * (capturePhoto). Null for anything else.
 */
export function capturePicture(
  take: Take | null | undefined,
  called: string | null | undefined,
  state: CloudThumbState | undefined,
): LightboxPicture | null {
  return state?.kind === 'ready' && state.thumb.pictureOnly ? capturePhoto(take, called, state) : null;
}

/** The picture-only captures among `takes`, in the order given: what the Lightbox pages through. */
export function capturePictureSequence(
  takes: readonly Take[],
  names: ReadonlyMap<string, CaptureName>,
  cloud: ReadonlyMap<string, CloudThumbState>,
): LightboxPicture[] {
  return takes.flatMap((t) => capturePicture(t, names.get(t.takeId)?.label, cloud.get(t.takeId)) ?? []);
}
