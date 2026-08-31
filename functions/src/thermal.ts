/**
 * Server-side port of the client thermal-decode utilities
 * (src/utils/temperatureReader.ts, constants.ts, helpers.ts, and the segment mapping in
 * src/pages/experimentAnalyzer/hooks.ts) so Cloud Functions can read the EXACT same per-pixel
 * temperatures the analyzer shows the user. Plus one primitive the client never computes:
 * a per-frame global min / max / mean + hotspot location, which the AI lab-report generator needs.
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

export interface ThermometerLike {
  x: number;
  y: number;
  measuringAreaType?: string; // 'point' | 'rectangle' | 'ellipse'
  measuringAreaWidth?: number;
  measuringAreaHeight?: number;
}

export interface Segment {
  start: number;
  end: number;
}

export interface FrameStats {
  min: number;
  max: number;
  mean: number;
  hotspot: { x: number; y: number }; // normalized [0,1] location of the hottest pixel
  coldspot: { x: number; y: number }; // normalized [0,1] location of the coldest pixel
  // Robust bounds: the 2nd and 98th percentile of the frame's pixels. min/max are single pixels, so one
  // dead or saturated sensor element sets them; p02/p98 describe where the scene's temperatures actually
  // lie, which is what a claim like "the plate is around 60 C" should rest on.
  p02: number;
  p98: number;
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
 *  - It ends the re-inflate-per-probe cost: a frame used to be inflated once for frameStats and again
 *    for EVERY thermometer, and each pixel read allocated a 4-byte slice plus a DataView.
 */
export interface DecodedFrame {
  view: DataView;
  w: number;
  h: number;
  complete: boolean;
}

/** Wrap an already-raw pixel buffer (a .vir frame slice) — no deflate/inflate round trip. */
export const decodeRawFrame = (raw: Uint8Array, w = IR_ARRAY_WIDTH, h = IR_ARRAY_HEIGHT): DecodedFrame => ({
  view: new DataView(raw.buffer, raw.byteOffset, raw.byteLength),
  w,
  h,
  complete: raw.byteLength >= w * h * INTSIZE,
});

/** Inflate one DEFLATEd frame buffer (a recording's data_N.dat) into a DecodedFrame. */
export const decodeFrame = (frame: Uint8Array, w = IR_ARRAY_WIDTH, h = IR_ARRAY_HEIGHT): DecodedFrame =>
  decodeRawFrame(pako.inflate(frame), w, h);

/** Read the big-endian uint16 (deci-Kelvin) at pixel record `idx`. Mirrors readArrayBufferPoint; a read
 *  past the end of a truncated buffer yields 0, exactly as the old slice + try/catch did. */
const readPoint = (f: DecodedFrame, idx: number): number => {
  const off = idx * INTSIZE + 2;
  return idx >= 0 && off + 2 <= f.view.byteLength ? f.view.getUint16(off, false) : 0;
};

/** Celsius at a raw pixel index (row-major, idx = y*w + x). The cheapest read there is — used by the
 *  whole-frame passes, which would otherwise pay a fraction->pixel conversion 19,200 times per frame. */
export const celsiusAtIndex = (f: DecodedFrame, idx: number): number => kelvinToCelsius(readPoint(f, idx) / 100);

const pointCelsius = (f: DecodedFrame, x: number, y: number): number => {
  // Clamp into the last valid column/row so an edge probe (x=1 or y=1) reads the edge pixel instead of an
  // out-of-range index → readPoint returns 0 → a spurious -273.15. Uses the frame's own w,h (a .vir video
  // may differ from 120x160), mirroring the client rawPointCelsius clamp so the numbers match the analyzer.
  const xAbs = Math.min(f.w - 1, Math.max(0, Math.floor(x * f.w)));
  const yAbs = Math.min(f.h - 1, Math.max(0, Math.floor(y * f.h)));
  return kelvinToCelsius(readPoint(f, yAbs * f.w + xAbs) / 100);
};

/** 7x7-sampled average over a rectangular/elliptical measuring area. Mirrors getAreaAverageTemperature. */
const areaAverageCelsius = (
  f: DecodedFrame,
  x: number,
  y: number,
  width: number,
  height: number,
  ellipse: boolean,
): number => {
  const SAMPLES = 7;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      const dx = i / (SAMPLES - 1) - 0.5;
      const dy = j / (SAMPLES - 1) - 0.5;
      if (ellipse && dx * dx + dy * dy > 0.25) continue;
      const px = x + dx * width;
      const py = y + dy * height;
      if (px < 0 || px >= 1 || py < 0 || py >= 1) continue;
      sum += pointCelsius(f, px, py);
      count += 1;
    }
  }
  if (count) return sum / count;
  return pointCelsius(f, x, y); // whole grid clipped (unreachable with clamped probes): centre read, never -273.15
};

/** Celsius at a fractional [0,1] image position, nearest-pixel with edge clamping — the same read the
 *  spot probe uses, exported so the derived-analysis pass samples exactly what a probe would report. */
export const celsiusAtPoint = (f: DecodedFrame, x: number, y: number): number => pointCelsius(f, x, y);

/** A thermometer's Celsius reading on one frame (point, or area average). Mirrors getThermometerValue. */
export const thermometerCelsius = (f: DecodedFrame, t: ThermometerLike): number => {
  const { x, y, measuringAreaType, measuringAreaWidth = 0.15, measuringAreaHeight = 0.15 } = t;
  const c =
    measuringAreaType === 'rectangle' || measuringAreaType === 'ellipse'
      ? areaAverageCelsius(f, x, y, measuringAreaWidth, measuringAreaHeight, measuringAreaType === 'ellipse')
      : pointCelsius(f, x, y);
  return Number(c.toFixed(2));
};

/** Per-frame global min / max / mean temperature + the hottest pixel's normalized location.
 *  Only meaningful for a `complete` frame — callers must check, or the sentinel reads become the min. */
export const frameStats = (f: DecodedFrame): FrameStats => {
  const n = f.w * f.h;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let hotIdx = 0;
  let coldIdx = 0;
  // One materialised pass: the values are needed again for the percentiles, and re-reading the DataView a
  // second time costs more than the 19,200-element scratch array.
  const values = new Float64Array(n);
  for (let idx = 0; idx < n; idx++) {
    const c = kelvinToCelsius(readPoint(f, idx) / 100);
    values[idx] = c;
    sum += c;
    if (c < min) {
      min = c;
      coldIdx = idx;
    }
    if (c > max) {
      max = c;
      hotIdx = idx;
    }
  }
  values.sort();
  // Nearest-rank percentiles on the sorted copy (n is always 19,200 here, so no interpolation subtlety
  // is worth the extra arithmetic).
  const at = (q: number) => values[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
  const norm = (idx: number) => ({
    x: Number((((idx % f.w) + 0.5) / f.w).toFixed(3)),
    y: Number(((Math.floor(idx / f.w) + 0.5) / f.h).toFixed(3)),
  });
  return {
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    mean: Number((sum / n).toFixed(2)),
    hotspot: norm(hotIdx),
    coldspot: norm(coldIdx),
    p02: Number(at(0.02).toFixed(2)),
    p98: Number(at(0.98).toFixed(2)),
  };
};

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
 * the clip's real `spanSec` (= lastFrameIndex / FPS, the analyzer's own duration convention — see
 * imagePlayer's `duration={lastFrameIndex / FPS}`). Callers must prefer `spanSec` over the experiment
 * doc's `duration`, which for a trimmed clip is still the UNTRIMMED source duration.
 */
export const recordingSampling = (segments: Segment[] | null | undefined, duration: number, limit: number) => {
  const hasSegments = !!segments && segments.length > 0;

  let lastFrameIndex: number;
  let getRecordingIndex: (currIdx: number) => number;

  if (!hasSegments) {
    // Round, don't truncate: `duration` is a float, so 28.2 * 5 lands on 140.99999999999997 and a bare
    // `- 1` would leave a FRACTIONAL last index — which then asks Storage for `data_140.99….dat`.
    lastFrameIndex = Math.max(0, Math.round(duration * FPS) - 1);
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

  const secondPerFrame = 1 / FPS;
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

// ---------------------------------------------------------------------------
// .vir (video showcase) thermal decode. A recording stores one pako-DEFLATEd frame per data_N.dat;
// a VIDEO stores every frame in a single videostore/<name>.vir file: an 8-byte header (width as a
// big-endian uint16 at byte offset 2, height at offset 6 — the client's getDimension convention) then
// `frameCount` back-to-back RAW frames, each `width*height` pixel records of INTSIZE bytes. A raw slice
// is already the pixel-record layout the decoders read, so it is wrapped directly as a DecodedFrame and
// the same decoders serve both media types. Mirrors the client src/utils/virReader.ts (getDimension +
// parseRawThermalData).
// ---------------------------------------------------------------------------

export interface VirHeader {
  width: number;
  height: number;
  size: number; // pixels per frame (width * height)
  frameCount: number;
}

/** Read the .vir dimensions + frame count from its 8-byte header. */
export const readVirHeader = (buf: Uint8Array): VirHeader => {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = buf.byteLength >= 8 ? dv.getUint16(2, false) : 0;
  const height = buf.byteLength >= 8 ? dv.getUint16(6, false) : 0;
  const size = width * height;
  const totalPixels = (buf.byteLength - 8) / INTSIZE;
  const frameCount = size > 0 ? Math.floor(totalPixels / size) : 0;
  return { width, height, size, frameCount };
};

/**
 * Extract frame `index` from a .vir buffer as a DecodedFrame. Returns null for an out-of-range index.
 * Byte offset mirrors the client stride: 8-byte header + index full frames, each record INTSIZE bytes.
 * (This used to DEFLATE the slice purely so the reader could inflate it straight back again.)
 */
export const virFrameDecoded = (buf: Uint8Array, header: VirHeader, index: number): DecodedFrame | null => {
  if (index < 0 || index >= header.frameCount) return null;
  const start = 8 + index * header.size * INTSIZE;
  const end = start + header.size * INTSIZE;
  return decodeRawFrame(buf.subarray(start, end), header.width, header.height);
};
