/**
 * Server-side port of the client thermal-decode utilities
 * (src/utils/temperatureReader.ts, constants.ts, helpers.ts, and the segment mapping in
 * src/pages/experimentAnalyzer/hooks.ts) so Cloud Functions can read the EXACT same per-pixel
 * temperatures the analyzer shows the user.
 *
 * Encoding (identical to the client): each frame is a pako-DEFLATEd buffer of row-major pixels;
 * every pixel is a 4-byte record whose big-endian uint16 at byte offset +2 is the temperature in
 * deci-Kelvin (value / 100 Kelvin). Celsius = value / 100 - 273.15.
 */
import * as pako from 'pako';

export const IR_ARRAY_WIDTH = 120;
export const IR_ARRAY_HEIGHT = 160;
export const INTSIZE = 4; // 4 bytes per pixel record
export const FPS = 5; // recordings play at a fixed 5 fps (0.2s per frame)

export const kelvinToCelsius = (t: number) => t - 273.15;

export interface Segment {
  start: number;
  end: number;
}

/**
 * One frame decoded ONCE: a DataView over its raw pixel records, plus the frame's dimensions.
 *
 * Decoding is separated from reading for two reasons:
 *  - `complete` is false when the buffer is shorter than w*h*INTSIZE (a truncated or corrupt frame).
 *    Reads past the end yield 0 deci-Kelvin — a spurious -273.15 °C — which would otherwise become the
 *    frame's reported minimum and drag its mean down by ~273 x the missing fraction. The client's chart
 *    already refuses to plot such a frame (linePlot: `complete ? displayTemp(min) : null`); the server
 *    had no equivalent, so an AI report could earnestly explain "a coldest point of -273.15 °C".
 *  - It ends the re-inflate-per-read cost: a frame used to be inflated again for EVERY read, and each
 *    pixel read allocated a 4-byte slice plus a DataView.
 */
export interface DecodedFrame {
  view: DataView;
  w: number;
  h: number;
  complete: boolean;
}

/** Inflate one DEFLATEd frame buffer (a recording's data_N.dat) into a DecodedFrame. */
export const decodeFrame = (frame: Uint8Array, w = IR_ARRAY_WIDTH, h = IR_ARRAY_HEIGHT): DecodedFrame => {
  const raw = pako.inflate(frame);
  return {
    view: new DataView(raw.buffer, raw.byteOffset, raw.byteLength),
    w,
    h,
    complete: raw.byteLength >= w * h * INTSIZE,
  };
};

/** Read the big-endian uint16 (deci-Kelvin) at pixel record `idx`. Mirrors readArrayBufferPoint; a read
 *  past the end of a truncated buffer yields 0, exactly as the old slice + try/catch did. */
const readPoint = (f: DecodedFrame, idx: number): number => {
  const off = idx * INTSIZE + 2;
  return idx >= 0 && off + 2 <= f.view.byteLength ? f.view.getUint16(off, false) : 0;
};

/** Celsius at a raw pixel index (row-major, idx = y*w + x). The cheapest read there is — used by the
 *  whole-frame passes, which would otherwise pay a fraction->pixel conversion 19,200 times per frame. */
export const celsiusAtIndex = (f: DecodedFrame, idx: number): number => kelvinToCelsius(readPoint(f, idx) / 100);

/**
 * The time base of a recording's frames, read off its experiment doc (mirrors the client's
 * src/utils/frameTime.ts; contract in docs/time-lapse-experiments.md). A TIME-LAPSE doc carries
 * `timelapse.intervalSec` (> 0: frame N sits at (N-1) × intervalSec seconds of recording time) and
 * `frameCount`; its `duration` is the real span in seconds, so the frame count must never be derived
 * from it. Both absent → the 5 fps grid below.
 */
export interface RecordingTiming {
  /** Frames the recording holds (data_1 … data_frameCount); absent → round(duration × FPS). */
  frameCount?: number;
  /** Seconds between consecutive frames; absent → 1 / FPS. */
  secondPerFrame?: number;
}

/** The doc's time-lapse interval in seconds, or null when it is not a time-lapse. */
export const timelapseIntervalSec = (exp: { timelapse?: unknown }): number | null => {
  const t = exp.timelapse;
  if (!t || typeof t !== 'object') return null;
  const s = Number((t as { intervalSec?: unknown }).intervalSec);
  return Number.isFinite(s) && s > 0 ? s : null;
};

/** The sampler timing for an experiment doc. */
export const recordingTiming = (exp: { frameCount?: unknown; timelapse?: unknown }): RecordingTiming => ({
  frameCount: typeof exp.frameCount === 'number' ? exp.frameCount : undefined,
  secondPerFrame: timelapseIntervalSec(exp) ?? undefined,
});

/**
 * Pick which recording frames to sample for a report, reproducing the analyzer's own sampling:
 *  - lastFrameIndex + getRecordingIndex from useMappingIndex (segment-aware; raw clips are 1-indexed)
 *  - even subsampling to at most `limit` points.
 *
 * The subsample spans the clip INCLUSIVELY — the last sample IS the last frame. (The earlier
 * `i * floor(total/limit)` stride stopped short: on a 28.2 s clip it sampled frame 120 of 140, so the
 * final 15% of the clip was never read and "at the end of the experiment" in an AI report actually
 * described t=24 s. Short clips lost the most.)
 *
 * Returns the player/recording index pairs each stamped with its own `tSec`, plus `lastFrameIndex` and
 * the clip's real `spanSec` (= lastFrameIndex × secondPerFrame, the analyzer's own duration convention —
 * see imagePlayer's `duration={lastFrameIndex * spf}`). Callers must prefer `spanSec` over the experiment
 * doc's `duration`, which for a trimmed clip is still the UNTRIMMED source duration. `timing` is the
 * doc's own frame count / clock (recordingTiming); the defaults reproduce the 5 fps grid exactly.
 */
export const recordingSampling = (
  segments: Segment[] | null | undefined,
  duration: number,
  limit: number,
  timing: RecordingTiming = {},
) => {
  const hasSegments = !!segments && segments.length > 0;

  let lastFrameIndex: number;
  let getRecordingIndex: (currIdx: number) => number;

  if (!hasSegments) {
    // The doc's own frame count when it carries one (a time-lapse always does — its duration is a real
    // span of hours, NOT frames / 5). Else round, don't truncate: `duration` is a float, so 28.2 * 5
    // lands on 140.99999999999997 and a bare `- 1` would leave a FRACTIONAL last index — which then asks
    // Storage for `data_140.99….dat`.
    const { frameCount } = timing;
    lastFrameIndex =
      typeof frameCount === 'number' && Number.isFinite(frameCount) && frameCount >= 1
        ? Math.floor(frameCount) - 1
        : Math.max(0, Math.round(duration * FPS) - 1);
    getRecordingIndex = (currIdx) => currIdx + 1; // raw clips are 1-indexed in recording space
  } else {
    const currSegments: Segment[] = [];
    const map = new Map<number, number>();
    let frames = -1;
    for (const { start, end } of segments!) {
      frames += 1;
      const currStart = frames;
      frames += end - start;
      currSegments.push({ start: currStart, end: frames });
      map.set(currStart, start);
      map.set(frames, end);
    }
    lastFrameIndex = currSegments[currSegments.length - 1].end;
    getRecordingIndex = (currIdx) => {
      for (const { start, end } of currSegments) {
        if (currIdx >= start && currIdx <= end) {
          const original = map.get(start);
          if (original !== undefined) return original + currIdx - start;
        }
      }
      return 0;
    };
  }

  // The clock: a time-lapse's interval between frames, else the 5 fps tick.
  const secondPerFrame =
    typeof timing.secondPerFrame === 'number' && Number.isFinite(timing.secondPerFrame) && timing.secondPerFrame > 0
      ? timing.secondPerFrame
      : 1 / FPS;
  /** One player-space frame index as a sample. Exposed so a second pass can densify an interval the
   *  first pass flagged, without re-deriving the segment mapping it already worked out. */
  const sampleAt = (playerIndex: number) => ({
    playerIndex,
    recordingIndex: getRecordingIndex(playerIndex),
    tSec: Number((playerIndex * secondPerFrame).toFixed(2)),
  });
  const maxPoints = Math.min(limit, lastFrameIndex + 1);
  const samples: { playerIndex: number; recordingIndex: number; tSec: number }[] = [];
  if (maxPoints <= 0) {
    return { secondPerFrame, lastFrameIndex: -1, spanSec: 0, samples, sampleAt };
  }
  for (let i = 0; i < maxPoints; i++) {
    // Spread [0, lastFrameIndex] inclusively so the tail is covered. A single-point clip has no
    // interval to divide, so it samples frame 0.
    samples.push(sampleAt(maxPoints === 1 ? 0 : Math.round((i * lastFrameIndex) / (maxPoints - 1))));
  }
  return {
    secondPerFrame,
    lastFrameIndex,
    spanSec: Number((lastFrameIndex * secondPerFrame).toFixed(2)),
    samples,
    sampleAt,
  };
};
