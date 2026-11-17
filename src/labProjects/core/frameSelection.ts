/* eslint-disable no-bitwise */
/*
 * A recording's block statistics — the frame-stats.bin sidecar — and what is read off them: when the
 * camera moved and when its shutter recalibrated. Pure: no imports, no platform APIs, no Date.
 *
 * SHARED MODULE. The website copies this file as it is (infrared-explorer-web
 * src/labProjects/core/frameSelection.ts, npm run sync:lab-core): the experiments' tools read the same
 * sidecar on the phone and in the browser. The recorder writes the file natively (FrameStatsSidecar.kt,
 * FlirFrameStats.swift); this module is the format's spec.
 *
 * THE SIDECAR. `frame-stats.bin` sits next to a recording's frames, written by the recorder as it goes
 * (or by a one-off scan of an older recording), and holds for every frame the mean of each 10 x 10
 * pixel block of the 120 x 160 temperature grid — 12 x 16 = 192 block means, as uint16 centi-kelvin
 * (the frame's own quantisation), 384 bytes a frame, ~345 KB for three minutes. A block mean averages
 * sensor noise down to a few hundredths of a degree and still shows a mug handle; it is the signal the
 * camera-motion and shutter (NUC) detectors read. Whole-frame extremes are NOT stored: nothing
 * consumed them.
 *
 *   offset  size  field
 *   0       4     magic "IEFS"
 *   4       1     version (1)
 *   5       1     blocks across (12)
 *   6       1     blocks down (16)
 *   7       1     reserved (0)
 *   8       4     frame count, little-endian uint32 — rewritten when the recording is finalised
 *   12      4     reserved (0)
 *   16      …     frames: count x 192 x uint16 little-endian, block index = row * 12 + column;
 *                 a frame of all zeros means "not available" (unreadable, or never written)
 *
 * CAMERA. The block grid says whether the camera moved: a block-grid translation that explains the
 * change between two frames, or most of the grid changing at once, is a move; a uniform offset of every
 * block that holds is a shutter calibration (NUC). An experiment's AI is told both (the take's
 * overview, and `take.camera` in run_code): a sensor reads a different place after a move, and every
 * reading steps at once at a calibration.
 *
 * Until 2026-11-17 this file also chose WHICH frames the lab report read (selectFrames, a
 * swinging-door selection on the same statistics, mirrored in the website's functions). That report's
 * engine and its client are gone (docs/DECISIONS.md "The lab report's client is removed"); the name of
 * the file stayed.
 */

export const FRAME_STATS_MAGIC = 'IEFS';
export const FRAME_STATS_VERSION = 1;
export const BLOCKS_X = 12;
export const BLOCKS_Y = 16;
export const BLOCKS = BLOCKS_X * BLOCKS_Y;
export const BLOCK_PX = 10;
export const FRAME_W = BLOCKS_X * BLOCK_PX;
export const FRAME_H = BLOCKS_Y * BLOCK_PX;
export const FRAME_STATS_HEADER_BYTES = 16;
export const FRAME_STATS_FRAME_BYTES = BLOCKS * 2;

const KELVIN_OFFSET = 273.15;

export interface FrameStatsFile {
  version: number;
  blocksX: number;
  blocksY: number;
  /** Frames the file holds (the header's count, clamped to the bytes present). */
  frameCount: number;
  /** frameCount x BLOCKS uint16 centi-kelvin block means, frame-major. */
  means: Uint16Array;
}

/** Block means of one raw frame: `centiKelvin` is the 120 x 160 grid row-major, as the .dat stores it. */
export function blockMeansCentiKelvin(centiKelvin: ArrayLike<number>): Uint16Array {
  const out = new Uint16Array(BLOCKS);
  if (centiKelvin.length < FRAME_W * FRAME_H) return out;
  for (let by = 0; by < BLOCKS_Y; by++) {
    for (let bx = 0; bx < BLOCKS_X; bx++) {
      let sum = 0;
      for (let y = by * BLOCK_PX; y < (by + 1) * BLOCK_PX; y++) {
        const row = y * FRAME_W + bx * BLOCK_PX;
        for (let x = 0; x < BLOCK_PX; x++) sum += centiKelvin[row + x];
      }
      // Round half up, as the frame's own quantisation does (Kotlin Math.round agrees).
      const mean = Math.round(sum / (BLOCK_PX * BLOCK_PX));
      out[by * BLOCKS_X + bx] = mean < 0 ? 0 : mean > 0xffff ? 0xffff : mean;
    }
  }
  return out;
}

/** Serialise block means (one Uint16Array of BLOCKS per frame) into the sidecar format. */
export function encodeFrameStats(frames: ArrayLike<ArrayLike<number>>): Uint8Array {
  const n = frames.length;
  const out = new Uint8Array(FRAME_STATS_HEADER_BYTES + n * FRAME_STATS_FRAME_BYTES);
  out[0] = 0x49; // I
  out[1] = 0x45; // E
  out[2] = 0x46; // F
  out[3] = 0x53; // S
  out[4] = FRAME_STATS_VERSION;
  out[5] = BLOCKS_X;
  out[6] = BLOCKS_Y;
  out[7] = 0;
  const view = new DataView(out.buffer);
  view.setUint32(8, n, true);
  view.setUint32(12, 0, true);
  for (let f = 0; f < n; f++) {
    const base = FRAME_STATS_HEADER_BYTES + f * FRAME_STATS_FRAME_BYTES;
    const row = frames[f];
    for (let b = 0; b < BLOCKS; b++) {
      const v = row && b < row.length ? Math.max(0, Math.min(0xffff, Math.round(row[b]))) : 0;
      view.setUint16(base + b * 2, v, true);
    }
  }
  return out;
}

/** Parse a sidecar; null when it is not one (wrong magic, version or grid). A short file keeps the
 *  frames it has — a recorder that died mid-take leaves a valid prefix. */
export function parseFrameStats(bytes: Uint8Array): FrameStatsFile | null {
  if (bytes.length < FRAME_STATS_HEADER_BYTES) return null;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x45 || bytes[2] !== 0x46 || bytes[3] !== 0x53) return null;
  const version = bytes[4];
  const blocksX = bytes[5];
  const blocksY = bytes[6];
  if (version !== FRAME_STATS_VERSION || blocksX !== BLOCKS_X || blocksY !== BLOCKS_Y) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(8, true);
  const available = Math.floor((bytes.length - FRAME_STATS_HEADER_BYTES) / FRAME_STATS_FRAME_BYTES);
  const frameCount = Math.min(declared, available);
  const means = new Uint16Array(frameCount * BLOCKS);
  for (let i = 0; i < means.length; i++) means[i] = view.getUint16(FRAME_STATS_HEADER_BYTES + i * 2, true);
  return { version, blocksX, blocksY, frameCount, means };
}

/** Whether frame `i` (0-based) holds data: a frame of all zeros is the "not available" sentinel. */
export function frameAvailable(file: FrameStatsFile, i: number): boolean {
  if (i < 0 || i >= file.frameCount) return false;
  const base = i * BLOCKS;
  for (let b = 0; b < BLOCKS; b++) if (file.means[base + b] !== 0) return true;
  return false;
}

/** Block means of frame `i` in °C. */
export function frameCelsius(file: FrameStatsFile, i: number): Float64Array {
  const out = new Float64Array(BLOCKS);
  const base = i * BLOCKS;
  for (let b = 0; b < BLOCKS; b++) out[b] = file.means[base + b] / 100 - KELVIN_OFFSET;
  return out;
}

const median = (values: ArrayLike<number>): number => {
  const a = Array.from(values).sort((x, y) => x - y);
  if (a.length === 0) return 0;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

const quartiles = (values: ArrayLike<number>): { q1: number; q3: number } => {
  const a = Array.from(values).sort((x, y) => x - y);
  if (a.length === 0) return { q1: 0, q3: 0 };
  const at = (p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { q1: at(0.25), q3: at(0.75) };
};

// ------------------------------------------------------------------- camera

/** Frame ranges are 1-based and inclusive, as frames are numbered on disk. */
export interface CameraSegments {
  /** Stretches the camera held still. */
  poses: { from: number; to: number }[];
  /** Stretches it moved, with the largest block-grid translation seen inside each. */
  moves: { from: number; to: number; shiftBlocks: number }[];
  /** Frames at which a shutter calibration stepped every block's reading at once. */
  nuc: number[];
}

/** A frame-to-frame change whose uniform part is this large is a shutter step, not physics … */
const NUC_MIN_SHIFT_C = 0.1;
/** … provided the blocks agree on it this closely. */
const NUC_MAX_SPREAD_C = 0.05;
/** The block-grid translation search radius, in blocks. */
const MOTION_SEARCH = 2;
/** Below this mean change between frames nothing moved, whatever a translation would explain. */
const MOTION_NOISE_C = 0.3;
/** A translation must explain the change this much better than standing still to count as a move. */
const MOTION_GAIN = 0.6;
/** A block changing by more than this between consecutive frames is a changed block … */
const MOTION_BLOCK_CHANGE_C = 0.5;
/** … and this fraction of the grid changing at once is a move even without a clean translation. */
const MOTION_FRACTION = 0.5;
/** Flagged frames closer than this (in frames) belong to one move. */
const MOTION_MERGE_FRAMES = 5;
/** A move is at least this many consecutive flagged transitions: a camera that moves keeps changing the
 *  grid frame after frame, while a hand entering the picture changes it once and then holds still. */
const MOTION_MIN_FLAGGED = 2;
/** A translation also has to have changed this fraction of the grid. A camera that turns shifts every
 *  block that has any structure in it; an object set down in the picture (a mug, a hand) changes only
 *  the blocks it covers — and a shift of the grid "explains" its advancing edge just as well as it
 *  explains a pan, so the gain alone cannot tell them apart. The price: a pan across a scene so bare
 *  that fewer blocks than this change goes unflagged, which costs nothing a probe would notice. */
const MOTION_TRANSLATED_FRACTION = 0.25;

/** Mean absolute residual of B against A shifted by (dx, dy) blocks, after removing the uniform offset. */
const shiftResidual = (a: Float64Array, b: Float64Array, dx: number, dy: number): number => {
  const diffs: number[] = [];
  for (let y = 0; y < BLOCKS_Y; y++) {
    const sy = y + dy;
    if (sy < 0 || sy >= BLOCKS_Y) continue;
    for (let x = 0; x < BLOCKS_X; x++) {
      const sx = x + dx;
      if (sx < 0 || sx >= BLOCKS_X) continue;
      diffs.push(b[y * BLOCKS_X + x] - a[sy * BLOCKS_X + sx]);
    }
  }
  if (diffs.length === 0) return Infinity;
  const m = median(diffs);
  let sum = 0;
  for (const d of diffs) sum += Math.abs(d - m);
  return sum / diffs.length;
};

/**
 * A shutter step has to HOLD: the frames after it sit where it put them. The median block shift between
 * the NUC_HOLD_FRAMES before a candidate and the NUC_HOLD_FRAMES from it on has to be at least
 * NUC_MIN_SHIFT_C the same way. A FLIR ONE's whole picture wobbles by ±0.1–0.2 °C between consecutive
 * frames a third of the time, and on a flat scene the wobble is uniform enough to pass the spread test:
 * four such wobbles were once reported as four calibrations, each "stepping every reading by a few
 * tenths of a degree" — frames that in fact wobbled straight back the next fifth of a second.
 */
const NUC_HOLD_FRAMES = 4;

/** Mean of the available frames among indices [from, to), per block; null when none is available. */
const meanFrame = (file: FrameStatsFile, from: number, to: number): Float64Array | null => {
  const sum = new Float64Array(BLOCKS);
  let count = 0;
  for (let i = Math.max(0, from); i < Math.min(file.frameCount, to); i++) {
    if (!frameAvailable(file, i)) continue;
    const f = frameCelsius(file, i);
    for (let b = 0; b < BLOCKS; b++) sum[b] += f[b];
    count++;
  }
  if (count === 0) return null;
  for (let b = 0; b < BLOCKS; b++) sum[b] /= count;
  return sum;
};

/** Does the shift candidate at frame i (compared with i − 1) persist? See NUC_HOLD_FRAMES. The frames
 *  compared are the ones BEFORE i − 1 and AFTER i: a one-frame spike (frame i alone, straight back the
 *  next) would otherwise lend a quarter of itself to the mean it is being tested against. */
const shiftHolds = (file: FrameStatsFile, i: number, m: number): boolean => {
  const before = meanFrame(file, i - 1 - NUC_HOLD_FRAMES, i - 1);
  const after = meanFrame(file, i + 1, i + 1 + NUC_HOLD_FRAMES);
  if (!before || !after) return false;
  const diffs = new Float64Array(BLOCKS);
  for (let b = 0; b < BLOCKS; b++) diffs[b] = after[b] - before[b];
  const held = median(diffs);
  return Math.abs(held) >= NUC_MIN_SHIFT_C && Math.sign(held) === Math.sign(m);
};

/** Camera moves and shutter steps, from consecutive available frames. */
export function detectCamera(file: FrameStatsFile): CameraSegments {
  const n = file.frameCount;
  const nuc: number[] = [];
  const movingShift = new Map<number, number>(); // 0-based frame → translation (blocks) that explained it
  let prev: Float64Array | null = null;
  let prevIndex = -1;
  for (let i = 0; i < n; i++) {
    if (!frameAvailable(file, i)) continue;
    const cur = frameCelsius(file, i);
    if (prev && i === prevIndex + 1) {
      const diffs = new Float64Array(BLOCKS);
      for (let b = 0; b < BLOCKS; b++) diffs[b] = cur[b] - prev[b];
      const m = median(diffs);
      const { q1, q3 } = quartiles(diffs);
      if (Math.abs(m) >= NUC_MIN_SHIFT_C && q3 - q1 <= NUC_MAX_SPREAD_C && shiftHolds(file, i, m)) {
        nuc.push(i + 1);
      } else {
        const still = shiftResidual(prev, cur, 0, 0);
        let best = still;
        let bestShift = 0;
        if (still > MOTION_NOISE_C) {
          for (let dy = -MOTION_SEARCH; dy <= MOTION_SEARCH; dy++) {
            for (let dx = -MOTION_SEARCH; dx <= MOTION_SEARCH; dx++) {
              if (dx === 0 && dy === 0) continue;
              const r = shiftResidual(prev, cur, dx, dy);
              if (r < best) {
                best = r;
                bestShift = Math.abs(dx) + Math.abs(dy);
              }
            }
          }
        }
        let changed = 0;
        for (let b = 0; b < BLOCKS; b++) if (Math.abs(diffs[b] - m) > MOTION_BLOCK_CHANGE_C) changed++;
        const translated =
          bestShift > 0 && best < MOTION_GAIN * still && changed >= MOTION_TRANSLATED_FRACTION * BLOCKS;
        const scattered = changed > MOTION_FRACTION * BLOCKS;
        if (translated || scattered) movingShift.set(i, translated ? bestShift : 0);
      }
    }
    prev = cur;
    prevIndex = i;
  }
  // Runs of flagged frames, merged across short gaps, short runs dropped.
  const flagged = Array.from(movingShift.keys()).sort((a, b) => a - b);
  const runs: { from: number; to: number; shiftBlocks: number; flagged: number }[] = [];
  for (const f of flagged) {
    const last = runs[runs.length - 1];
    const shift = movingShift.get(f) ?? 0;
    if (last && f - last.to <= MOTION_MERGE_FRAMES) {
      last.to = f;
      last.shiftBlocks = Math.max(last.shiftBlocks, shift);
      last.flagged++;
    } else {
      // The move includes the frame before the first flagged one: the flag compares it to its predecessor.
      runs.push({ from: Math.max(0, f - 1), to: f, shiftBlocks: shift, flagged: 1 });
    }
  }
  const moves = runs
    .filter((r) => r.flagged >= MOTION_MIN_FLAGGED)
    .map((r) => ({ from: r.from + 1, to: r.to + 1, shiftBlocks: r.shiftBlocks }));
  const poses: { from: number; to: number }[] = [];
  let cursor = 1;
  for (const m of moves) {
    if (m.from > cursor) poses.push({ from: cursor, to: m.from - 1 });
    cursor = m.to + 1;
  }
  if (n >= cursor) poses.push({ from: cursor, to: n });
  return { poses, moves, nuc };
}
