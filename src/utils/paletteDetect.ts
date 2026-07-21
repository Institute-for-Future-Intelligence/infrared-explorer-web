import { getDecodedFrame } from './thermalFrame';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from './constants';
import { detectPaletteFromPixels } from './palette';

// A candidate palette is accepted only when its mean per-pixel colour distance is under this (L1 over RGB,
// 0..765). A correct-family match sits well under ~40 even with JPEG/quantization noise; a wrong palette
// scores 150+. Generous enough that noise doesn't force a fallback, tight enough to reject a mismatch.
const ACCEPT_DISTANCE = 60;

// …and only when the winner clears the runner-up by at least this (separation = (2nd−best)/(best+1)). A
// near-tie means two palettes fit almost equally (e.g. the grayscale whitehot/coldest/hottest family when a
// distinguishing cap barely shows) — the pick would be a coin-flip, so fall back to the approximate ramp.
const MIN_SEPARATION = 0.02;

// Draw a source (a loaded <img> or a <video> frame) onto the IR grid and read its pixels, aligned 1:1 with
// the thermal grid (drawImage resamples any source size down to IR_ARRAY_WIDTH×IR_ARRAY_HEIGHT, matching
// the row-major temps grid). Returns null when the 2D read fails — a CORS-tainted <video> throws on
// getImageData (recordings' blob/dataURL images are same-origin and safe; cross-origin video needs bucket
// CORS + crossOrigin).
const readGridPixels = (source: CanvasImageSource): Uint8ClampedArray | null => {
  const canvas = document.createElement('canvas');
  canvas.width = IR_ARRAY_WIDTH;
  canvas.height = IR_ARRAY_HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(source, 0, 0, IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT);
    return ctx.getImageData(0, 0, IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT).data;
  } catch {
    return null; // tainted canvas (cross-origin) or an undecodable frame
  }
};

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

// Match the frame's pixels to a palette, gated on ACCEPT_DISTANCE + MIN_SEPARATION. Returns a key or null.
// The frame's argmin/argmax pixels are always sampled so the extreme LUT bands (which alone separate the
// grayscale palette family) are never missed.
const matchGrid = (deflatedBuffer: ArrayBufferLike, pixels: Uint8ClampedArray): string | null => {
  let decoded;
  try {
    decoded = getDecodedFrame(deflatedBuffer);
  } catch {
    return null;
  }
  const m = detectPaletteFromPixels(decoded.temps, decoded.min, decoded.max, pixels, {
    alwaysSample: [decoded.minIdx, decoded.maxIdx],
  });
  return m && m.distance <= ACCEPT_DISTANCE && m.separation >= MIN_SEPARATION ? m.key : null;
};

/**
 * Detect the palette a recording's rendered frame uses. `imgSrc` is the IR render (data_N.png as a
 * same-origin blob/dataURL — canvas-readable), `deflatedBuffer` is that same frame's .dat. Returns a
 * palette key, or null (image unreadable, or no candidate close enough → caller falls back to an
 * approximate ramp).
 */
export const detectPaletteFromImageSource = async (
  imgSrc: string,
  deflatedBuffer: ArrayBufferLike,
): Promise<string | null> => {
  let img: HTMLImageElement;
  try {
    img = await loadImage(imgSrc);
  } catch {
    return null;
  }
  const pixels = readGridPixels(img);
  return pixels ? matchGrid(deflatedBuffer, pixels) : null;
};

/**
 * Detect the palette from a <video> frame (the mp4). Only works when the video is CORS-clean (bucket CORS +
 * crossOrigin='anonymous'); a tainted canvas returns null → fallback. `deflatedBuffer` is the matching .vir
 * frame's data.
 */
export const detectPaletteFromVideo = (video: HTMLVideoElement, deflatedBuffer: ArrayBufferLike): string | null => {
  if (!video.videoWidth || !video.videoHeight) return null;
  const pixels = readGridPixels(video);
  return pixels ? matchGrid(deflatedBuffer, pixels) : null;
};
