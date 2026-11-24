/**
 * What the Process panel reads off the picture on screen, and the small pictures it shows of it
 * (processPanel.tsx): Auto's histogram, and the Effects tab's row of thumbnails. On the page, from the
 * frame's picture AS MADE — the blob the player holds before any settings go on it. The capture app's
 * lumaHistogram and effectPreviews (its pictureAdjust.ts), to the number.
 */
import { decode, release, sizeOf } from '../utils/msxSynth';
import { adjustedFrameBlob } from './adjustFrame';
import {
  ADJUST_EFFECTS,
  AdjustEffect,
  EFFECT_DEFAULT,
  PictureAdjust,
  autoAdjust,
  withEffects,
} from './core/pictureAdjustParams';

/** Bins of the histogram Auto reads, and the width of the copy the picture is measured on. */
const HISTOGRAM_BINS = 64;
const HISTOGRAM_WIDTH = 96;
/** A thumbnail's width, px (the panel shows a square cut from its middle). */
const PREVIEW_WIDTH = 144;

/** `picture` drawn `width` px wide on a canvas of its own shape. */
async function smallCanvas(picture: Blob, width: number): Promise<HTMLCanvasElement> {
  const decoded = await decode(picture);
  try {
    const size = sizeOf(decoded);
    if (!size.w || !size.h) throw new Error('The picture is empty.');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.max(1, Math.round((width * size.h) / size.w));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('The picture could not be drawn.');
    ctx.drawImage(decoded, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    release(decoded);
  }
}

/** The picture's luminance histogram (equal bins over 0..1), read off a small copy; null when it cannot be. */
export async function lumaHistogram(picture: Blob): Promise<number[] | null> {
  try {
    const canvas = await smallCanvas(picture, HISTOGRAM_WIDTH);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const hist = new Array<number>(HISTOGRAM_BINS).fill(0);
    for (let o = 0; o + 3 < bytes.length; o += 4) {
      const l = (bytes[o] * 0.299 + bytes[o + 1] * 0.587 + bytes[o + 2] * 0.114) / 255;
      hist[Math.min(HISTOGRAM_BINS - 1, Math.floor(l * HISTOGRAM_BINS))] += 1;
    }
    return hist;
  } catch {
    return null;
  }
}

/** Auto for `picture`: the Brightness and Contrast the app's rule picks for it; null when it cannot be read. */
export async function autoFor(picture: Blob): Promise<Pick<PictureAdjust, 'brightness' | 'contrast'> | null> {
  const hist = await lumaHistogram(picture);
  if (!hist) return null;
  const { brightness, contrast } = autoAdjust(hist);
  return { brightness, contrast };
}

/** The picture under each effect — and under none — as object URLs for the panel's row. */
export type EffectPreviews = Record<AdjustEffect | 'none', string>;

/** Let a row's pictures go (their object URLs). */
export function releasePreviews(previews: EffectPreviews | null | undefined): void {
  if (previews) Object.values(previews).forEach((url) => URL.revokeObjectURL(url));
}

/**
 * `picture` as the panel's row of thumbnails shows it: once with no effect and once under each, alone and
 * at the amount it comes on at, all with `sliders` on — what each effect does to this picture, whatever
 * else is on it now. Null when they cannot be made. The caller lets them go (releasePreviews).
 */
export async function effectPreviews(picture: Blob, sliders: PictureAdjust): Promise<EffectPreviews | null> {
  const made: string[] = [];
  try {
    const canvas = await smallCanvas(picture, PREVIEW_WIDTH);
    const small = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!small) return null;
    const keys = ['none', ...ADJUST_EFFECTS] as const;
    const blobs = await Promise.all(
      keys.map((key) =>
        adjustedFrameBlob(
          small,
          withEffects(sliders, key === 'none' ? null : [{ effect: key, amount: EFFECT_DEFAULT[key] }]),
        ),
      ),
    );
    const out: Partial<EffectPreviews> = {};
    keys.forEach((key, i) => {
      const url = URL.createObjectURL(blobs[i]);
      made.push(url);
      out[key] = url;
    });
    return out as EffectPreviews;
  } catch {
    made.forEach((url) => URL.revokeObjectURL(url));
    return null;
  }
}
