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
}

/** Inflate one DEFLATEd frame buffer to its raw ArrayBuffer of pixel records. */
const inflateFrame = (frame: Uint8Array): ArrayBufferLike => pako.inflate(frame).buffer;

/** Read the big-endian uint16 (deci-Kelvin) at pixel record `begin`. Mirrors readArrayBufferPoint. */
const readPoint = (buf: ArrayBufferLike, begin: number): number => {
  const view = new DataView(buf.slice(begin * INTSIZE, (begin + 1) * INTSIZE));
  try {
    return view.getUint16(2, false);
  } catch {
    return 0; // out of bounds
  }
};

const pointCelsius = (buf: ArrayBufferLike, x: number, y: number, w: number, h: number): number => {
  const xAbs = Math.floor(x * w);
  const yAbs = Math.floor(y * h);
  return kelvinToCelsius(readPoint(buf, yAbs * w + xAbs) / 100);
};

/** 7x7-sampled average over a rectangular/elliptical measuring area. Mirrors getAreaAverageTemperature. */
const areaAverageCelsius = (
  buf: ArrayBufferLike,
  x: number,
  y: number,
  width: number,
  height: number,
  ellipse: boolean,
  w: number,
  h: number,
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
      sum += pointCelsius(buf, px, py, w, h);
      count += 1;
    }
  }
  return count ? sum / count : kelvinToCelsius(0);
};

/** A thermometer's Celsius reading on one frame (point, or area average). Mirrors getThermometerValue. */
export const thermometerCelsius = (
  frame: Uint8Array,
  t: ThermometerLike,
  w = IR_ARRAY_WIDTH,
  h = IR_ARRAY_HEIGHT,
): number => {
  const buf = inflateFrame(frame);
  const { x, y, measuringAreaType, measuringAreaWidth = 0.15, measuringAreaHeight = 0.15 } = t;
  let c: number;
  if (measuringAreaType === 'rectangle' || measuringAreaType === 'ellipse') {
    c = areaAverageCelsius(buf, x, y, measuringAreaWidth, measuringAreaHeight, measuringAreaType === 'ellipse', w, h);
  } else {
    c = pointCelsius(buf, x, y, w, h);
  }
  return Number(c.toFixed(2));
};

/** Per-frame global min / max / mean temperature + the hottest pixel's normalized location. */
export const frameStats = (frame: Uint8Array, w = IR_ARRAY_WIDTH, h = IR_ARRAY_HEIGHT): FrameStats => {
  const buf = inflateFrame(frame);
  const n = w * h;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let hotIdx = 0;
  for (let idx = 0; idx < n; idx++) {
    const c = kelvinToCelsius(readPoint(buf, idx) / 100);
    sum += c;
    if (c < min) min = c;
    if (c > max) {
      max = c;
      hotIdx = idx;
    }
  }
  return {
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    mean: Number((sum / n).toFixed(2)),
    hotspot: {
      x: Number((((hotIdx % w) + 0.5) / w).toFixed(3)),
      y: Number(((Math.floor(hotIdx / w) + 0.5) / h).toFixed(3)),
    },
  };
};

/**
 * Pick which recording frames to sample for a report, reproducing the analyzer's own sampling:
 *  - lastFrameIndex + getRecordingIndex from useMappingIndex (segment-aware; raw clips are 1-indexed)
 *  - even subsampling to at most `limit` points, exactly like loadThermoDataForPlot.
 * Returns the player/recording index pairs and the per-frame time step (seconds).
 */
export const recordingSampling = (segments: Segment[] | null | undefined, duration: number, limit: number) => {
  const hasSegments = !!segments && segments.length > 0;

  let lastFrameIndex: number;
  let getRecordingIndex: (currIdx: number) => number;

  if (!hasSegments) {
    lastFrameIndex = duration * FPS - 1;
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

  const maxPoints = Math.min(limit, lastFrameIndex + 1);
  const samples: { playerIndex: number; recordingIndex: number }[] = [];
  if (maxPoints <= 0) {
    return { secondPerFrame: 1 / FPS, step: 1, samples };
  }
  const step = Math.floor((lastFrameIndex + 1) / maxPoints);
  for (let i = 0; i < maxPoints; i++) {
    const playerIndex = Math.min(lastFrameIndex, i * step);
    samples.push({ playerIndex, recordingIndex: getRecordingIndex(playerIndex) });
  }
  return { secondPerFrame: 1 / FPS, step, samples };
};

// ---------------------------------------------------------------------------
// .vir (video showcase) thermal decode. A recording stores one pako-DEFLATEd frame per data_N.dat;
// a VIDEO stores every frame in a single videostore/<name>.vir file: an 8-byte header (width as a
// big-endian uint16 at byte offset 2, height at offset 6 — the client's getDimension convention) then
// `frameCount` back-to-back RAW frames, each `width*height` pixel records of INTSIZE bytes. Slicing one
// raw frame and DEFLATEing it yields exactly the buffer thermometerCelsius()/frameStats() expect (they
// inflate + take explicit w,h), so the same tested decoders serve both media types. Mirrors the client
// src/utils/virReader.ts (getDimension + parseRawThermalData).
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
 * Extract frame `index` from a .vir buffer as a DEFLATEd frame (the shape thermometerCelsius/frameStats
 * inflate). Returns null for an out-of-range index. Byte offset mirrors the client stride:
 * 8-byte header + index full frames, each pixel record INTSIZE bytes.
 */
export const virFrameDeflated = (buf: Uint8Array, header: VirHeader, index: number): Uint8Array | null => {
  if (index < 0 || index >= header.frameCount) return null;
  const start = 8 + index * header.size * INTSIZE;
  const end = start + header.size * INTSIZE;
  return pako.deflate(buf.slice(start, end));
};
