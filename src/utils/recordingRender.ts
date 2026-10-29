/**
 * A recording's rendered frames (data_N.png, the FLIR SDK's palette render the player shows) read back as
 * pixels on the thermal grid, for the colour table a frame was painted through (frameColourTable.ts).
 * Fetched as the player fetches them (a Storage blob, so the canvas that reads them is never tainted),
 * scaled to 120 × 160 by paletteDetect.readGridPixels, and kept in a bounded cache keyed by recording
 * frame — the player has its own cache of the same pictures as images, which cannot be shared across the
 * analyzer, so following the player with colours downloads each frame's render a second time.
 */
import { getBlob, ref } from 'firebase/storage';
import { firebaseStorage } from '../services/firebase';
import { readGridPixels } from './paletteDetect';

/** Renders kept, as grid pixels (120 × 160 × 4 bytes ≈ 77 KB each): a minute of a 5 fps recording. */
export const RENDER_PIXELS_CACHE_MAX = 300;

const cache = new Map<string, Promise<Uint8ClampedArray | null>>();

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

async function fetchPixels(recordingId: string, index: number): Promise<Uint8ClampedArray | null> {
  const blob = await getBlob(ref(firebaseStorage, `recordings/${recordingId}/data_${index}.png`));
  const url = URL.createObjectURL(blob);
  try {
    return readGridPixels(await loadImage(url));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The render's pixels on the thermal grid, or null when it could not be read; a failed fetch is not kept. */
export function fetchRecordingRenderPixelsCached(
  recordingId: string,
  index: number,
): Promise<Uint8ClampedArray | null> {
  const key = `${recordingId}/${index}`;
  const hit = cache.get(key);
  if (hit) {
    // Most recently used last: re-insert so the eviction below drops the stalest entry.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = fetchPixels(recordingId, index).catch(() => {
    cache.delete(key);
    return null;
  });
  cache.set(key, p);
  while (cache.size > RENDER_PIXELS_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return p;
}
