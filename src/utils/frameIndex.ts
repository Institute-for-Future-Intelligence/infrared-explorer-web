/**
 * A CAMERA-TIMED recording's frame index — `recordings/{recordingId}/frame-index.bin`
 * (docs/time-lapse-experiments.md, "Camera-timed recordings").
 *
 * An ordinary recording is a 5 fps grid and a time-lapse an interval grid, so a frame's time is its index
 * times a constant. A camera-timed take (doc `timing: 'camera'`, uploaded by the capture app since
 * 2026-11) keeps every frame the camera delivered — about 8.3 a second, unevenly spaced, with a gap of
 * over a second whenever the camera's shutter recalibrates — so each frame's time is its own, and the
 * upload carries them in this one file beside the frames:
 *
 *   {"version":1,"timing":"camera","frameCount":N,
 *    "frameCaptureMs":[N integers: ms since the take's start, non-decreasing; index 0 = frame 1],
 *    "frameScaleMin":[N numbers or null, °C],"frameScaleMax":[N numbers or null, °C]}
 *
 * `frameScaleMin/Max[i]` is the range the camera coloured frame i + 1 over. Such a take uploads no
 * data_N.png, so its infrared picture is painted from data_N.dat (utils/thermalPaint.ts) — over this range,
 * through the doc's palette, which gives the camera's own picture.
 *
 * JSON text under a `.bin` name, stored as application/octet-stream. The name matters to the uploader:
 * Storage records an object called *.json as application/json whatever Content-Type it is sent with, and
 * the recordings rule's allow-list has no JSON type (the app repo's src/lib/frameIndex.ts has the story).
 *
 * This is the pure half (parsing, lookups); the fetch and its cache are utils/frameIndexLoader.ts.
 */

/** The file's name under the recording's Storage prefix. */
export const FRAME_INDEX_FILE = 'frame-index.bin';

export interface FrameIndex {
  /** Frames the index describes (data_1 … data_frameCount). */
  frameCount: number;
  /** Capture time of each recording frame, ms since the take's start (index 0 = frame 1); never decreasing. */
  captureMs: number[];
  /** The °C range the camera coloured each frame over; null where the take did not record one. */
  scaleMin: (number | null)[];
  scaleMax: (number | null)[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The index out of the file's parsed JSON, or null when it is not one (no capture times). Tolerant where
 * it can be: a time that runs backwards takes its predecessor's (the frames are in order, so that is a
 * rounding slip, not a reordering), a missing or malformed scale entry reads as null, and a `frameCount`
 * that disagrees with the list gives way to the shorter of the two.
 */
export function parseFrameIndex(raw: unknown): FrameIndex | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const times = o.frameCaptureMs;
  if (!Array.isArray(times) || times.length === 0) return null;
  const declared = finite(o.frameCount) && o.frameCount >= 1 ? Math.floor(o.frameCount) : times.length;
  const frameCount = Math.min(declared, times.length);
  const captureMs: number[] = new Array(frameCount);
  let last = -Infinity;
  for (let i = 0; i < frameCount; i++) {
    const t = times[i];
    if (!finite(t)) return null; // a frame with no time: the index cannot place it, so it places none
    last = t < last ? last : t;
    captureMs[i] = last;
  }
  const scale = (list: unknown): (number | null)[] => {
    const out: (number | null)[] = new Array(frameCount).fill(null);
    if (Array.isArray(list)) {
      for (let i = 0; i < frameCount && i < list.length; i++) {
        if (finite(list[i])) out[i] = list[i];
      }
    }
    return out;
  };
  return { frameCount, captureMs, scaleMin: scale(o.frameScaleMin), scaleMax: scale(o.frameScaleMax) };
}

/** parseFrameIndex over the file's bytes (UTF-8 JSON); null when they are not that. */
export function parseFrameIndexBytes(bytes: ArrayBuffer | Uint8Array): FrameIndex | null {
  try {
    return parseFrameIndex(JSON.parse(new TextDecoder('utf-8').decode(bytes)));
  } catch {
    return null;
  }
}

/**
 * The range the camera coloured recording frame `recordingFrame` (1-based) over, or null when the index
 * has none for it (no index, an entry left null, or a degenerate max <= min) — the caller then paints
 * the frame over its own coldest and warmest pixel.
 */
export function frameScaleOf(
  index: FrameIndex | null | undefined,
  recordingFrame: number,
): { min: number; max: number } | null {
  if (!index) return null;
  const i = Math.floor(recordingFrame) - 1;
  const min = index.scaleMin[i];
  const max = index.scaleMax[i];
  return typeof min === 'number' && typeof max === 'number' && max > min ? { min, max } : null;
}
