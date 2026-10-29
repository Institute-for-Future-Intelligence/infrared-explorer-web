/*
 * Synthesized Blended view — the website's version of the capture app's recipe
 * (app repo: src/lib/msxSynthParams.ts, the Node oracle; src/lib/msxSynth.ts,
 * the Skia shader), with the gate, spacing and limits re-set on real frames
 * (see below). Since 2026-10-08 a recording made with the app no longer
 * uploads FLIR's MSX render (mix_N.jpg); it keeps the palette-rendered infrared
 * (data_N.png) and the visible-light frame (vis_N.jpg), which the recorder
 * renders through the SDK's fusion with ONE transform, so they are pixel-aligned.
 * The player recreates the blend from those two.
 *
 * The recipe is MSX's own idea: the visible frame's fine detail — its
 * high-pass — laid over the thermal picture, so edges and texture show where
 * the thermal image is flat. Per pixel:
 *
 *   lum  = luminance of the visible frame (Rec. 601)
 *   low  = mean of the 24 neighbours in the 5×5 ring around it, the ring's
 *          taps `step` pixels apart (edges clamp)
 *   hp   = (lum − low) / max(low, MSX_LOW_FLOOR)   (local CONTRAST, not a raw
 *                                                   difference: a dim visible
 *                                                   frame draws lines as well
 *                                                   as a bright one)
 *   hp   = 0 where |lum − low| < MSX_MIN_DIFF       (JPEG and sensor noise in
 *                                                   the dark: the contrast of
 *                                                   nothing is still nothing)
 *   d    = sign(hp) · max(|hp| − threshold, 0)     (a soft noise gate)
 *   out  = clamp(ir + clamp(strength · d, ±MSX_LIMIT))
 *                                                  (added to every channel:
 *                                                   bright on the light side of
 *                                                   an edge, dark on the other —
 *                                                   the relief look of MSX)
 *
 * The numbers were set on real frames, not guessed. The app's comments assume
 * a 480-wide frame and a ring of adjacent pixels; the frames the app writes are
 * 1080×1440 (a FLIR ONE's 640×480 visible picture stretched 2.25×, then JPEG),
 * where an edge is spread over several pixels and the adjacent-pixel ring sees
 * almost no contrast — measured on two phone recordings (2026-10-28, headless
 * Chrome): the 99th percentile of |hp| was 0.013, under any sensible threshold,
 * and the blend changed 0.0 % of the pixels. Spacing the taps by 1/270 of the
 * width (4 px at 1080) reads the contrast across the edge; a wider ring (6 px)
 * drew thick halos, a narrower one (3 px) lost the grains of salt in a dish. The first numbers tried with it (strength 4, threshold
 * 0.03, floor 0.1, limit 0.75) made a laptop on a dark desk (2026-10-29) a mess
 * of burnt-white keys and grain over the whole dark background: in the dark the
 * contrast divides by the floor, so JPEG noise of 0.02 in luminance became a
 * "contrast" of 0.2 and a full-strength line. Hence the absolute gate
 * MSX_MIN_DIFF, a higher floor, a lower limit and a gentler gain — with those
 * the keys, the screen's text and the desk's edge draw as thin outlines and the
 * thermal picture stays readable. (The app's shader still samples adjacent
 * pixels at strength 2.5 / threshold 0.08; bringing it in step is `xy +
 * float2(i, j) * step` with a `step` uniform in its SkSL, the absolute gate,
 * and these numbers.)
 *
 * The 25 taps are a separable sum (5 along x, then 5 along y) over a frame
 * padded by the ring's radius, which keeps a 1080×1440 frame under ~50 ms so
 * playback at 5 fps does not stall.
 */

export interface MsxParams {
  /** Gain on the visible high-pass (1 = add the detail as measured). */
  strength: number;
  /** Contrast-unit dead band below which detail is sensor noise. */
  threshold: number;
}

/** Set on real phone frames with the ring spacing of `ringStep` (see the header). */
export const DEFAULT_MSX_PARAMS: MsxParams = { strength: 3, threshold: 0.03 };

/**
 * The darkest `low` the contrast divides by: below it the visible frame is
 * noise and a lamp's shadow, and amplifying it further would only draw grain.
 */
export const MSX_LOW_FLOOR = 0.2;
/** The most a line may add to or take from the infrared picture (0..1). */
export const MSX_LIMIT = 0.5;
/**
 * A luminance difference (0..1) under this is noise whatever the contrast says:
 * JPEG grain on a dark wall is about 0.01–0.02, the faintest real edge about
 * 0.04.
 */
export const MSX_MIN_DIFF = 0.02;

/** Rec. 601 luma weights. */
export const LUMA = [0.299, 0.587, 0.114] as const;

/** The ring's taps sit this fraction of the frame's width apart (1080 → 4 px, 480 → 2 px). */
export const MSX_RING_STEP_FRACTION = 1 / 270;

/** The ring spacing, in pixels, for a frame of width `w`: whole pixels, never under one. */
export function ringStep(w: number): number {
  return Math.max(1, Math.round(w * MSX_RING_STEP_FRACTION));
}

/**
 * The recipe over RGBA byte buffers (row-major, 4 bytes a pixel, both w×h).
 * Returns a new RGBA buffer; the alpha is the infrared's. `step` defaults to
 * ringStep(w); a test passes its own. Pure, so it can run in Node — the test
 * pins it against a plain 25-tap reference.
 */
export function blendPixels(
  ir: Uint8Array | Uint8ClampedArray,
  vis: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  params: MsxParams = DEFAULT_MSX_PARAMS,
  step: number = ringStep(w),
): Uint8ClampedArray {
  if (ir.length !== w * h * 4 || vis.length !== w * h * 4) {
    throw new Error('blendPixels: buffers must be w*h*4 bytes');
  }
  if (!Number.isInteger(step) || step < 1) {
    throw new Error('blendPixels: step must be a whole number of pixels, at least 1');
  }
  // Luminance on a frame padded by the ring's radius with the border pixel
  // repeated: a border pixel's missing neighbours then read as itself, as the
  // app's clamped sampling does.
  const pad = 2 * step;
  const pw = w + 2 * pad;
  const ph = h + 2 * pad;
  const lum = new Float32Array(pw * ph);
  for (let py = 0; py < ph; py++) {
    const y = Math.min(h - 1, Math.max(0, py - pad));
    for (let px = 0; px < pw; px++) {
      const x = Math.min(w - 1, Math.max(0, px - pad));
      const i = (y * w + x) * 4;
      lum[py * pw + px] = (vis[i] * LUMA[0] + vis[i + 1] * LUMA[1] + vis[i + 2] * LUMA[2]) / 255;
    }
  }
  // Separable 5-tap sums: along x on every padded row (only the columns the
  // vertical pass will read), then along y for the frame's own pixels.
  const rowSum = new Float32Array(pw * ph);
  for (let py = 0; py < ph; py++) {
    const row = py * pw;
    for (let px = pad; px < pad + w; px++) {
      const c = row + px;
      rowSum[c] = lum[c - 2 * step] + lum[c - step] + lum[c] + lum[c + step] + lum[c + 2 * step];
    }
  }
  const out = new Uint8ClampedArray(ir.length);
  const { strength, threshold } = params;
  for (let y = 0; y < h; y++) {
    const row = (y + pad) * pw;
    for (let x = 0; x < w; x++) {
      const c = row + x + pad;
      const sum =
        rowSum[c - 2 * step * pw] +
        rowSum[c - step * pw] +
        rowSum[c] +
        rowSum[c + step * pw] +
        rowSum[c + 2 * step * pw];
      const centre = lum[c];
      const low = (sum - centre) / 24;
      const diff = centre - low;
      const hp = diff / (low > MSX_LOW_FLOOR ? low : MSX_LOW_FLOOR);
      const i = (y * w + x) * 4;
      // Under either gate (most of a frame) the pixel is the infrared's, byte for byte.
      if ((diff < MSX_MIN_DIFF && diff > -MSX_MIN_DIFF) || (hp <= threshold && hp >= -threshold)) {
        out[i] = ir[i];
        out[i + 1] = ir[i + 1];
        out[i + 2] = ir[i + 2];
        out[i + 3] = ir[i + 3];
        continue;
      }
      let d = strength * (hp > 0 ? hp - threshold : hp + threshold);
      if (d > MSX_LIMIT) d = MSX_LIMIT;
      else if (d < -MSX_LIMIT) d = -MSX_LIMIT;
      // In byte units; the clamped array rounds and clamps the sum to 0..255.
      const add = d * 255;
      out[i] = ir[i] + add;
      out[i + 1] = ir[i + 1] + add;
      out[i + 2] = ir[i + 2] + add;
      out[i + 3] = ir[i + 3];
    }
  }
  return out;
}

/** The JPEG quality of a synthesized frame — the same class of picture as the mix_N.jpg it stands in for. */
const BLENDED_JPEG_QUALITY = 0.9;

type Decoded = ImageBitmap | HTMLImageElement;

/** A blob or data URL decoded for drawing (a bitmap where the browser has them, an element otherwise). */
async function decode(source: Blob | string): Promise<Decoded> {
  if (typeof source !== 'string' && typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(source);
    } catch {
      // Not a picture createImageBitmap reads: the element may still.
    }
  }
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('The frame could not be decoded.'));
      img.src = url;
    });
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}

function sizeOf(p: Decoded): { w: number; h: number } {
  return 'naturalWidth' in p ? { w: p.naturalWidth, h: p.naturalHeight } : { w: p.width, h: p.height };
}

function release(p: Decoded) {
  if ('close' in p) p.close();
}

type Canvas2D =
  | { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D }
  | { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };

/** A 2D canvas of the given size — offscreen where the browser has it (no layout, no DOM). */
function canvas2d(w: number, h: number): Canvas2D {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (ctx) return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The frame could not be drawn.');
  return { canvas, ctx };
}

/** The pixels of a decoded picture drawn at w×h (a visible frame of another size is stretched onto the infrared's grid). */
function pixelsOf(picture: Decoded, w: number, h: number): Uint8ClampedArray {
  const { ctx } = canvas2d(w, h);
  ctx.drawImage(picture, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

async function encode(pixels: Uint8ClampedArray, w: number, h: number): Promise<Blob> {
  const c = canvas2d(w, h);
  c.ctx.putImageData(new ImageData(pixels, w, h), 0, 0);
  if ('convertToBlob' in c.canvas) return c.canvas.convertToBlob({ type: 'image/jpeg', quality: BLENDED_JPEG_QUALITY });
  const element = c.canvas;
  return new Promise<Blob>((resolve, reject) =>
    element.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('The frame could not be encoded.'))),
      'image/jpeg',
      BLENDED_JPEG_QUALITY,
    ),
  );
}

/**
 * The Blended render of one frame from its infrared render and visible-light frame (each a blob from
 * Storage or an already-cached data URL): a JPEG blob, the infrared's size. This is what the player and
 * the lightbox show for a recording whose upload carries vis_N.jpg but no mix_N.jpg (every app recording
 * since 2026-10-08). Rejects when either picture cannot be decoded; the callers fall back to infrared.
 */
export async function synthesizeBlended(
  ir: Blob | string,
  vis: Blob | string,
  params: MsxParams = DEFAULT_MSX_PARAMS,
): Promise<Blob> {
  const [irPic, visPic] = await Promise.all([decode(ir), decode(vis)]);
  try {
    const { w, h } = sizeOf(irPic);
    if (!w || !h) throw new Error('The infrared frame is empty.');
    const blended = blendPixels(pixelsOf(irPic, w, h), pixelsOf(visPic, w, h), w, h, params);
    return await encode(blended, w, h);
  } finally {
    release(irPic);
    release(visPic);
  }
}
