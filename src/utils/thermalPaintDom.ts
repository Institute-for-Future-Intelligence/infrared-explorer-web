/**
 * The infrared picture of a frame, painted from its temperatures — the canvas half (the recipe is
 * utils/thermalPaint.ts). Turns a decoded frame into the picture a camera-timed recording has no
 * data_N.png for: a PNG blob / data URL the player, the key-moment thumbnails and the Blended synthesis
 * take exactly as they took the stored render.
 */
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from './constants';
import type { DecodedFrame } from './thermalFrame';
import { THERMAL_PAINT_SCALE, paintRamp, paintRange, paintThermalRgba } from './thermalPaint';

/** The painted picture's size: the grid at THERMAL_PAINT_SCALE (720 × 960 for the 120 × 160 grid). */
export const PAINTED_WIDTH = IR_ARRAY_WIDTH * THERMAL_PAINT_SCALE;
export const PAINTED_HEIGHT = IR_ARRAY_HEIGHT * THERMAL_PAINT_SCALE;

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

type AnyContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** A w × h canvas with a 2D context: off screen where the browser has one that draws in 2D, else an element. */
function canvasOf(w: number, h: number): { canvas: AnyCanvas; ctx: AnyContext } {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
      if (ctx) return { canvas, ctx };
    } catch {
      // fall through to an element
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The frame could not be drawn.');
  return { canvas, ctx };
}

/** The frame painted onto a canvas of its own (PAINTED_WIDTH × PAINTED_HEIGHT). */
function paintedCanvas(
  frame: DecodedFrame,
  paletteKey: string | null | undefined,
  cameraScale: { min: number; max: number } | null | undefined,
): AnyCanvas {
  const outW = frame.width * THERMAL_PAINT_SCALE;
  const outH = frame.height * THERMAL_PAINT_SCALE;
  const { min, max } = paintRange(frame.temps, cameraScale);
  const rgba = paintThermalRgba(frame.temps, frame.width, frame.height, min, max, paintRamp(paletteKey), outW, outH);
  const { canvas, ctx } = canvasOf(outW, outH);
  ctx.putImageData(new ImageData(rgba, outW, outH), 0, 0);
  return canvas;
}

/**
 * The infrared picture of `frame` as a PNG blob: its temperatures over `cameraScale` (the range the
 * camera coloured it over, when the take recorded one — else the frame's own coldest to warmest),
 * through the palette `paletteKey` names. Lossless, so a colour in the picture is a colour of the ramp.
 */
export async function paintedFrameBlob(
  frame: DecodedFrame,
  paletteKey: string | null | undefined,
  cameraScale?: { min: number; max: number } | null,
): Promise<Blob> {
  const canvas = paintedCanvas(frame, paletteKey, cameraScale);
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The frame could not be encoded.'))), 'image/png'),
  );
}

/** paintedFrameBlob as a data URL (what an <img> and the key-moment strip take). */
export async function paintedFrameDataUrl(
  frame: DecodedFrame,
  paletteKey: string | null | undefined,
  cameraScale?: { min: number; max: number } | null,
): Promise<string> {
  const blob = await paintedFrameBlob(frame, paletteKey, cameraScale);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => (reader.result ? resolve(reader.result as string) : reject(new Error('empty frame read')));
    reader.onerror = () => reject(reader.error ?? new Error('frame read failed'));
    reader.readAsDataURL(blob);
  });
}
