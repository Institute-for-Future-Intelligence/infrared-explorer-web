/**
 * Server-side thermal frame rendering — turning decoded temperatures into a picture a vision model can
 * look at, for the content that has no baked renders of its own.
 *
 * Every recording ships a false-colour data_N.png per frame, so a recording never needs this. A VIDEO
 * showcase does: its thermal data is one .vir holding raw frames and nothing else, so until now a
 * vision-capable model asked about a video was handed numbers and told to imagine the rest.
 *
 * Two decisions matter more than the code:
 *
 *  - The palette is the analyzer's own inferno ramp (src/utils/colormap.ts), with the same brightening
 *    gamma the moment thumbnails use, so a synthetic render looks like the thumbnails the student is
 *    looking at rather than like a different instrument.
 *  - Normalization is over the WHOLE CLIP, not per frame. A per-frame stretch makes every frame span the
 *    full palette, so the same colour means a different temperature in each one and a model comparing two
 *    instants concludes nothing changed. Clip-wide bounds make the colours comparable across frames —
 *    which is the only reason to show a model more than one.
 *
 * The images are still never a source of temperature: the prompts say so, and the caller labels each one
 * as a synthetic render with its bounds.
 */
import { encode as encodeJpeg } from 'jpeg-js';
import { celsiusAtIndex, type DecodedFrame } from './thermal';

/** Inferno colour stops — copied verbatim from src/utils/colormap.ts so a render matches the analyzer. */
const INFERNO_STOPS: readonly [number, number, number][] = [
  [0, 0, 4],
  [22, 11, 57],
  [66, 10, 104],
  [106, 23, 110],
  [147, 38, 103],
  [188, 55, 84],
  [221, 81, 58],
  [243, 120, 25],
  [252, 165, 10],
  [246, 215, 70],
  [252, 255, 164],
];

/** Normalized value (0 = coldest, 1 = hottest) -> inferno RGB in 0-255, linearly interpolated. */
export const infernoRgb = (t: number): [number, number, number] => {
  const scaled = Math.max(0, Math.min(1, t)) * (INFERNO_STOPS.length - 1);
  const i = Math.min(INFERNO_STOPS.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const [r0, g0, b0] = INFERNO_STOPS[i];
  const [r1, g1, b1] = INFERNO_STOPS[i + 1];
  return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
};

/** Inferno's cold end is nearly black, which crushes a large cool subject into a featureless blob.
 *  Same gamma the client thumbnails use — this is a viewing curve, not a change to the data. */
const BRIGHTEN_GAMMA = 0.4;

/** JPEG quality. The source grid is 120x160, so there is little detail for a higher setting to preserve
 *  and every extra kilobyte is prompt cost. */
const JPEG_QUALITY = 82;

export interface RenderedFrame {
  data: string; // base64 JPEG
  mediaType: 'image/jpeg';
}

/**
 * Render one decoded frame as a false-colour JPEG, with the palette anchored to `minC`..`maxC`.
 *
 * Pass the CLIP's bounds, not the frame's, whenever more than one frame will be shown together. Returns
 * null for a truncated frame: its missing pixels read as -273.15 °C, which would anchor the ramp to a
 * temperature that was never measured and wash the real scene into one colour.
 */
export function renderThermalFrame(frame: DecodedFrame, minC: number, maxC: number): RenderedFrame | null {
  if (!frame.complete) return null;
  const n = frame.w * frame.h;
  if (n <= 0) return null;
  const span = maxC - minC || 1;
  const rgba = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = infernoRgb(Math.pow((celsiusAtIndex(frame, i) - minC) / span, BRIGHTEN_GAMMA));
    const o = i * 4;
    rgba[o] = Math.round(r);
    rgba[o + 1] = Math.round(g);
    rgba[o + 2] = Math.round(b);
    rgba[o + 3] = 255;
  }
  const jpeg = encodeJpeg({ data: rgba, width: frame.w, height: frame.h }, JPEG_QUALITY);
  return { data: jpeg.data.toString('base64'), mediaType: 'image/jpeg' };
}
