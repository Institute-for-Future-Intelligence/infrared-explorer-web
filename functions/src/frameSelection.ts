/* eslint-disable no-bitwise */
/*
 * Which frames of a recording the AI report should read — decided from the recording's own block
 * statistics, on whichever side holds them (app repo docs/proposals/ai-report-latency.md §3.E).
 *
 * SHARED MODULE. This file exists byte-for-byte in both repositories:
 *   infrared-explorer-app/src/lib/frameSelection.ts
 *   infrared-explorer-web/functions/src/frameSelection.ts
 * and a golden test in each pins the output on the same synthetic recording, so the phone (choosing
 * frames for a local recording) and the server (choosing them for an uploaded one, or checking the
 * phone's choice) land on the same frames. Pure: no imports, no platform APIs, no Date.
 *
 * THE SIDECAR. `frame-stats.bin` sits next to a recording's frames, written by the recorder as it goes
 * (or by a one-off scan of an older recording), and holds for every frame the mean of each 10 x 10
 * pixel block of the 120 x 160 temperature grid — 12 x 16 = 192 block means, as uint16 centi-kelvin
 * (the frame's own quantisation), 384 bytes a frame, ~345 KB for three minutes. A block mean averages
 * sensor noise down to a few hundredths of a degree and still shows a mug handle; it is also the signal
 * the camera-motion and shutter (NUC) detectors read. Whole-frame extremes are NOT stored: nothing
 * consumed them (decision ⑥).
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
 * THE RULE. Not "sample every N seconds" and not "sample when something changed": a frame is selected
 * when it is UNPREDICTABLE — when any block's mean departs from the straight-line extrapolation of the
 * last two selected frames by more than that block's own threshold (the swinging-door compressor of
 * process historians). A steady ramp, however fast, is predictable and keeps only its ends; the
 * moments physics happens — a pour, a switch, a peak, a turn — defeat the extrapolation and are kept
 * frame by frame, down to the recording's 0.2 s. A plateau is sampled every MAX_GAP seconds so its
 * flatness is measured rather than assumed. The per-block threshold is max(0.3 °C, 2 % of that block's
 * own excursion), so a mug heating by 60 degrees does not raise the bar for the bench beside it.
 *
 * MUST-INCLUDE. The first and last frames; the frame of each block's maximum and minimum (an extremum
 * the extrapolation rounds off would otherwise be dated to the nearest kept frame, seconds away); the
 * frames the caller names (annotations the report will cite); each shutter-calibration step.
 *
 * SOFT CAP. More than SOFT_CAP frames (a scene in constant motion) widens every threshold by half and
 * runs again; the multiplier is reported so the report's Limitations can say so.
 *
 * CAMERA. The same block grid says whether the camera moved: a block-grid translation that explains the
 * change between two frames, or most of the grid changing at once, is a move; a uniform offset of every
 * block is a shutter calibration (NUC). Moving stretches are sampled at the plateau rate only — a probe
 * reads a different place while the camera moves — and the poses between them are what the visible
 * photos are picked from.
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

/** The version string stamped into inputs descriptors: bump with ANY change to selectFrames's output. */
export const SELECTION_ALGO_VERSION = 'pe1';

export const DEFAULT_MAX_GAP_SEC = 5;
export const DEFAULT_DELTA_FLOOR_C = 0.3;
export const DEFAULT_DELTA_FRACTION = 0.02;
export const DEFAULT_SOFT_CAP = 400;

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

// ---------------------------------------------------------------- selection

export interface SelectionOptions {
  /** Seconds between consecutive frames (0.2 for an ordinary recording). */
  secondPerFrame: number;
  maxGapSec?: number;
  deltaFloorC?: number;
  deltaFraction?: number;
  softCap?: number;
  /** Frames (1-based) the report will cite — annotations, key moments — kept whatever the signal does. */
  keepFrames?: readonly number[];
  /** Precomputed camera segments; computed here when absent. */
  camera?: CameraSegments;
}

export interface Selection {
  /** The selected frames, 1-based, ascending. */
  picked: number[];
  /** Why frames were kept. A frame can satisfy several reasons; it is counted under the first that applied. */
  reasons: { edge: number; kink: number; backbone: number; extreme: number; annotation: number; nuc: number };
  /** The threshold multiplier the soft cap settled on (1 = the thresholds as specified). */
  deltaMultiplier: number;
  maxGapSec: number;
  algo: typeof SELECTION_ALGO_VERSION;
  camera: CameraSegments;
}

/**
 * Select the frames worth reading (see the file comment). Deterministic: the same sidecar and options
 * give the same list on every platform, which the golden tests in both repositories pin.
 */
export function selectFrames(file: FrameStatsFile, opts: SelectionOptions): Selection {
  const maxGapSec = opts.maxGapSec ?? DEFAULT_MAX_GAP_SEC;
  const floorC = opts.deltaFloorC ?? DEFAULT_DELTA_FLOOR_C;
  const fraction = opts.deltaFraction ?? DEFAULT_DELTA_FRACTION;
  const softCap = opts.softCap ?? DEFAULT_SOFT_CAP;
  const spf = opts.secondPerFrame > 0 ? opts.secondPerFrame : 0.2;
  const camera = opts.camera ?? detectCamera(file);
  const n = file.frameCount;

  const available: number[] = [];
  for (let i = 0; i < n; i++) if (frameAvailable(file, i)) available.push(i);
  const empty: Selection = {
    picked: [],
    reasons: { edge: 0, kink: 0, backbone: 0, extreme: 0, annotation: 0, nuc: 0 },
    deltaMultiplier: 1,
    maxGapSec,
    algo: SELECTION_ALGO_VERSION,
    camera,
  };
  if (available.length === 0) return empty;

  // Per-block thresholds from each block's own excursion over the available frames.
  const celsius = new Map<number, Float64Array>();
  const lo = new Float64Array(BLOCKS).fill(Infinity);
  const hi = new Float64Array(BLOCKS).fill(-Infinity);
  const argLo = new Int32Array(BLOCKS).fill(-1);
  const argHi = new Int32Array(BLOCKS).fill(-1);
  for (const i of available) {
    const c = frameCelsius(file, i);
    celsius.set(i, c);
    for (let b = 0; b < BLOCKS; b++) {
      if (c[b] < lo[b]) {
        lo[b] = c[b];
        argLo[b] = i;
      }
      if (c[b] > hi[b]) {
        hi[b] = c[b];
        argHi[b] = i;
      }
    }
  }
  const delta = new Float64Array(BLOCKS);
  for (let b = 0; b < BLOCKS; b++) delta[b] = Math.max(floorC, fraction * (hi[b] - lo[b]));

  const moving = new Uint8Array(n);
  for (const m of camera.moves) for (let f = m.from; f <= m.to; f++) if (f >= 1 && f <= n) moving[f - 1] = 1;
  const nucAt = new Set(camera.nuc.map((f) => f - 1));

  const scan = (mult: number) => {
    const picked = new Set<number>();
    const reasons = { edge: 0, kink: 0, backbone: 0, extreme: 0, annotation: 0, nuc: 0 };
    let l1 = -1; // last selected
    let l0 = -1; // the one before it
    const select = (i: number, why: keyof typeof reasons) => {
      picked.add(i);
      reasons[why]++;
      l0 = l1;
      l1 = i;
    };
    for (const i of available) {
      if (l1 < 0) {
        select(i, 'edge');
        continue;
      }
      const gap = (i - l1) * spf;
      if (nucAt.has(i)) {
        select(i, 'nuc');
        continue;
      }
      if (moving[i]) {
        if (gap >= maxGapSec) select(i, 'backbone');
        continue;
      }
      const cur = celsius.get(i)!;
      const b1 = celsius.get(l1)!;
      const residual = new Float64Array(BLOCKS);
      if (l0 >= 0 && !moving[l1]) {
        const b0 = celsius.get(l0)!;
        const span = (l1 - l0) * spf;
        const ahead = (i - l1) * spf;
        for (let b = 0; b < BLOCKS; b++) residual[b] = cur[b] - (b1[b] + ((b1[b] - b0[b]) * ahead) / span);
      } else {
        for (let b = 0; b < BLOCKS; b++) residual[b] = cur[b] - b1[b];
      }
      const m = median(residual);
      let worst = 0;
      for (let b = 0; b < BLOCKS; b++) {
        const e = Math.abs(residual[b] - m) / (delta[b] * mult);
        if (e > worst) worst = e;
      }
      if (worst >= 1) select(i, 'kink');
      else if (gap >= maxGapSec) select(i, 'backbone');
    }
    const last = available[available.length - 1];
    if (!picked.has(last)) {
      picked.add(last);
      reasons.edge++;
    }
    return { picked, reasons };
  };

  let mult = 1;
  let result = scan(mult);
  for (let round = 0; result.picked.size > softCap && round < 12; round++) {
    mult *= 1.5;
    result = scan(mult);
  }
  const { picked, reasons } = result;

  // Must-include: each changing block's extremes (not inside a move — a block that sees new scenery
  // while the camera pans has a new extreme that is not the experiment's), and the caller's frames.
  for (let b = 0; b < BLOCKS; b++) {
    if (hi[b] - lo[b] <= delta[b] * mult) continue;
    for (const i of [argHi[b], argLo[b]]) {
      if (i >= 0 && !moving[i] && !picked.has(i)) {
        picked.add(i);
        reasons.extreme++;
      }
    }
  }
  for (const f of opts.keepFrames ?? []) {
    const i = Math.round(f) - 1;
    if (i >= 0 && i < n && frameAvailable(file, i) && !picked.has(i)) {
      picked.add(i);
      reasons.annotation++;
    }
  }

  return {
    picked: Array.from(picked)
      .sort((a, b) => a - b)
      .map((i) => i + 1),
    reasons,
    deltaMultiplier: mult,
    maxGapSec,
    algo: SELECTION_ALGO_VERSION,
    camera,
  };
}

/**
 * A stable fingerprint of a selection's inputs for an inputs descriptor: the algorithm, its parameters
 * and the sidecar's content hash (FNV-1a over the bytes — cheap, and collisions do not matter for a
 * "has anything changed" comparison).
 */
export function frameStatsFingerprint(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${bytes.length}-${h.toString(16).padStart(8, '0')}`;
}
