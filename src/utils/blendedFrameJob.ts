/**
 * One synthesized Blended frame, start to finish — the work a worker is handed (utils/blendedFrame.ts
 * hands it; this file is what runs there, and on the page where there is no worker). Nothing in it, or in
 * what it imports, touches the DOM or Firebase: the files are fetched on the page and arrive as bytes.
 *
 * The infrared half comes one of two ways:
 *
 *  - 'picture': the stored render (data_N.png) — every recording but a camera-timed one;
 *  - 'temps': the frame's data_N.dat, painted here from its temperatures (utils/thermalPaint) — a
 *    camera-timed take, which uploads no render. The painted pixels go straight into the blend: the PNG
 *    the page used to make of them, only for the blend to decode it again, cost more than the blend did.
 */
import { DEFAULT_MSX_PARAMS, MsxParams, synthesizeBlended, synthesizeBlendedOver } from './msxSynth';
import { DecodedFrame, decodeThermalFrame } from './thermalFrame';
import { THERMAL_PAINT_SCALE, paintRamp, paintRange, paintThermalRgba } from './thermalPaint';

export type BlendedInfrared =
  | { kind: 'picture'; picture: Blob | string }
  | {
      kind: 'temps';
      /** The frame's data_N.dat as stored (deflated). */
      dat: ArrayBuffer;
      /** The doc's palette key; one the tables do not hold paints through the painter's fallback. */
      palette?: string | null;
      /** The range the camera coloured the frame over; none = the frame's own coldest to warmest. */
      scale?: { min: number; max: number } | null;
    };

export interface BlendedFrameJob {
  ir: BlendedInfrared;
  /** The frame's vis_N.jpg. */
  vis: Blob;
  params?: MsxParams;
}

/**
 * The job done: a JPEG blob, the infrared picture's size (a painted one is the grid at
 * THERMAL_PAINT_SCALE). `decode`: how a .dat becomes a frame — the page passes its cached decoder, since
 * it reads the same buffer for the sensors; a worker sees each buffer once.
 */
export async function makeBlendedFrame(
  job: BlendedFrameJob,
  decode: (dat: ArrayBuffer) => DecodedFrame = decodeThermalFrame,
): Promise<Blob> {
  const params = job.params ?? DEFAULT_MSX_PARAMS;
  if (job.ir.kind === 'picture') return synthesizeBlended(job.ir.picture, job.vis, params);
  const frame = decode(job.ir.dat);
  const w = frame.width * THERMAL_PAINT_SCALE;
  const h = frame.height * THERMAL_PAINT_SCALE;
  const { min, max } = paintRange(frame.temps, job.ir.scale);
  const painted = paintThermalRgba(frame.temps, frame.width, frame.height, min, max, paintRamp(job.ir.palette), w, h);
  return synthesizeBlendedOver(painted, w, h, job.vis, params);
}
