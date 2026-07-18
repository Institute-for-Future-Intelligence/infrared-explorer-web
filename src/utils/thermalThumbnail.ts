import { getTempFromArrayBuffer } from './temperatureReader';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from './constants';
import { infernoRgb } from './colormap';

// Gamma (< 1) lifts the normalized value before colour lookup, so a large cold subject lands in inferno's
// purple/magenta band instead of its near-black cold end — the thumbnail then reads bright and legible
// (close to the mp4's own look) rather than a murky dark card. Tune down toward 1 for less lift.
const BRIGHTEN_GAMMA = 0.4;

/**
 * Render one thermal frame (a pako-DEFLATEd .vir / .dat frame buffer, as held in the in-memory
 * showcaseThermalCache) to a false-colour PNG data URL. Used to rebuild a VIDEO key-moment thumbnail: a
 * video has no CORS-safe per-frame image to fetch (unlike a recording's server-rendered data_N.png), but
 * its .vir thermal frames are already loaded, so the frame is colourised instead of fetched.
 *
 * Uses the inferno palette the capture app bakes into the mp4 (see infernoRgb), so the thumbnail reads
 * like the frame in the player. Normalized per frame (coldest → hottest pixel), then lifted by
 * BRIGHTEN_GAMMA so inferno's dark cold end doesn't crush a large cold subject to near-black at thumbnail
 * size. Pixel (x,y) is read from temps[y*W + x] — the same row-major layout getTempFromArrayBuffer and the
 * isotherm overlay use, so the thumbnail is oriented like the app's other thermal views. Returns '' if the
 * frame can't be decoded (the caller keeps the flat pill).
 */
export function renderThermalFrameThumbnail(frame: ArrayBufferLike): string {
  let temps: number[];
  try {
    temps = getTempFromArrayBuffer(frame);
  } catch {
    return '';
  }
  const size = IR_ARRAY_WIDTH * IR_ARRAY_HEIGHT;
  if (temps.length < size) return '';

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < size; i++) {
    const t = temps[i];
    if (t < min) min = t;
    if (t > max) max = t;
  }
  const span = max - min || 1;

  const canvas = document.createElement('canvas');
  canvas.width = IR_ARRAY_WIDTH;
  canvas.height = IR_ARRAY_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const image = ctx.createImageData(IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT);
  for (let i = 0; i < size; i++) {
    const [r, g, b] = infernoRgb(Math.pow((temps[i] - min) / span, BRIGHTEN_GAMMA));
    const o = i * 4;
    image.data[o] = Math.round(r);
    image.data[o + 1] = Math.round(g);
    image.data[o + 2] = Math.round(b);
    image.data[o + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}
