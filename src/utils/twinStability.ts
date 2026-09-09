/**
 * Camera-motion gate and per-frame alignment for the 3D digital twin (docs/digital-twin-plan.md §4).
 *
 * The twin assumes one fixed camera: every object is placed from where it sits in ONE reference frame,
 * and the heat map is re-projected onto that placement for every other frame. A hand-held phone never
 * holds perfectly still, so rather than demand it, every painted frame is first ALIGNED to the
 * reference — the whole-frame translation that best matches it is measured and the temperatures are
 * read through that offset. The gate then only refuses what alignment cannot fix: a drift so large
 * that a translation stops describing the motion (parallax, roll) and the photo the vision model saw
 * no longer covers the same scene. Deterministic on purpose — no model call, no cost, reproducible.
 *
 * Method: high-pass each thermal frame (removes the frame's own level and slow gradients — AGC and
 * gentle warming change those between samples without anything moving — and keeps the edges a shift
 * actually displaces), then find the (dx, dy) that best aligns two frames by normalised cross-
 * correlation over a search window, refined to sub-pixel with a parabola through the peak. A pair
 * whose best correlation is weak (a featureless scene, or a hand across the lens) says nothing about
 * motion and is left out rather than counted as still.
 */
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from './constants';
import type { TwinStability } from '../types';

/** Largest drift from the reference frame (thermal px) the twin corrects. 12 px of 120 is 10 % of the
 *  frame, about 4° of pan on the FLIR One's 43° field: within it a translation describes the motion
 *  well enough for the paint (the residual is under the solver's own placement accuracy, plan §6);
 *  beyond it the photo the model analysed no longer shows the same scene. */
export const STABLE_MAX_SHIFT_PX = 12;
/** Search window when aligning a frame to the reference, each way. Wider than STABLE_MAX_SHIFT_PX so a
 *  drift just past the limit is measured rather than reported as the window edge. */
export const ALIGN_SEARCH_PX = 16;
/** Search window for consecutive-sample motion, which only serves to pick the stillest reference. */
export const MAX_SEARCH_PX = 6;
/** Below this peak correlation the pair is judged featureless (no edges to align) and skipped. */
export const MIN_NCC_SCORE = 0.25;

export interface ShiftEstimate {
  dx: number;
  dy: number;
  score: number; // peak normalised cross-correlation, -1..1
}

/** Which recording frames to sample for the gate, 1-indexed: every frame of a short clip, and `cap`
 *  evenly spaced frames (always including the first and the last) of a long one, so a long recording
 *  does not fetch hundreds of frames just to be gated. Frames between samples are still aligned one by
 *  one when they are painted. */
export function stabilitySampleIndices(frameCount: number, cap = 120): number[] {
  if (frameCount <= 0) return [];
  const step = Math.max(1, Math.ceil(frameCount / cap));
  const out: number[] = [];
  for (let i = 1; i <= frameCount; i += step) out.push(i);
  if (out[out.length - 1] !== frameCount) out.push(frameCount);
  return out;
}

/**
 * Subtract a (2r+1)² box mean from every pixel (separable, edge-clamped). Values below -100 °C are the
 * truncated-frame sentinel (thermalFrame.ts) and are clamped so one corrupt row does not dominate the
 * correlation.
 */
export function highPass(src: ArrayLike<number>, w: number, h: number, r = 2): Float32Array {
  const n = w * h;
  const clean = new Float32Array(n);
  for (let i = 0; i < n; i++) clean[i] = src[i] < -100 ? -50 : src[i];
  const tmp = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        s += clean[row + xx];
        c++;
      }
      tmp[row + x] = s / c;
    }
  }
  const out = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        s += tmp[yy * w + x];
        c++;
      }
      out[y * w + x] = clean[y * w + x] - s / c;
    }
  }
  return out;
}

/**
 * Estimate the shift (dx, dy) such that b(x, y) ≈ a(x − dx, y − dy), by normalised cross-correlation
 * over every integer shift within ±maxShift of `center`, then refine to sub-pixel with a parabola
 * through the peak and its neighbours. Inputs should already be high-passed. `stride` sub-samples the
 * lattice the sums run over (the shifts themselves stay at full resolution) — 2 makes the search 4×
 * cheaper at no measurable cost to the estimate on 120×160 frames; 4 is coarse but good enough to find
 * the neighbourhood of a large shift (see alignFrame).
 */
export function estimateShift(
  a: Float32Array,
  b: Float32Array,
  w: number,
  h: number,
  maxShift = MAX_SEARCH_PX,
  stride = 2,
  center: { dx: number; dy: number } = { dx: 0, dy: 0 },
): ShiftEstimate {
  const cx = Math.round(center.dx);
  const cy = Math.round(center.dy);
  const size = 2 * maxShift + 1;
  const scores = new Float32Array(size * size).fill(-2);
  let best = -2;
  let bx = cx;
  let by = cy;
  for (let dy = cy - maxShift; dy <= cy + maxShift; dy++) {
    const y0 = Math.max(0, dy);
    const y1 = Math.min(h, h + dy);
    for (let dx = cx - maxShift; dx <= cx + maxShift; dx++) {
      const x0 = Math.max(0, dx);
      const x1 = Math.min(w, w + dx);
      let sab = 0;
      let saa = 0;
      let sbb = 0;
      for (let y = y0; y < y1; y += stride) {
        const rowB = y * w;
        const rowA = (y - dy) * w;
        for (let x = x0; x < x1; x += stride) {
          const va = a[rowA + x - dx];
          const vb = b[rowB + x];
          sab += va * vb;
          saa += va * va;
          sbb += vb * vb;
        }
      }
      const denom = Math.sqrt(saa * sbb);
      const s = denom > 1e-9 ? sab / denom : 0;
      scores[(dy - cy + maxShift) * size + (dx - cx + maxShift)] = s;
      if (s > best) {
        best = s;
        bx = dx;
        by = dy;
      }
    }
  }
  // Sub-pixel refinement: fit a parabola through the peak and its two neighbours on each axis. Only
  // when both neighbours exist (a peak on the window edge is reported as the edge).
  const at = (dx: number, dy: number) => scores[(dy - cy + maxShift) * size + (dx - cx + maxShift)];
  const refine = (m: number, c: number, p: number, i: number) => {
    const d = m - 2 * c + p;
    return d < 0 ? i + (0.5 * (m - p)) / d : i;
  };
  let dx = bx;
  let dy = by;
  if (Math.abs(bx - cx) < maxShift) dx = refine(at(bx - 1, by), best, at(bx + 1, by), bx);
  if (Math.abs(by - cy) < maxShift) dy = refine(at(bx, by - 1), best, at(bx, by + 1), by);
  return { dx, dy, score: best };
}

/**
 * Align frame `b` to reference `a` over the wide ±maxShift window: a coarse pass on a sparse lattice
 * finds the neighbourhood of the peak, a fine pass around it at full resolution settles the shift to
 * sub-pixel (the sub-pixel parabola needs the full lattice: on a strided one the peak's two neighbours
 * sample different pixel parities and the fit is biased by a quarter pixel). Both inputs high-passed.
 * A couple of million multiply-adds on a 120×160 frame — a few milliseconds — so it can run for every
 * painted frame.
 */
export function alignFrame(
  a: Float32Array,
  b: Float32Array,
  w: number,
  h: number,
  maxShift = ALIGN_SEARCH_PX,
): ShiftEstimate {
  const coarse = estimateShift(a, b, w, h, maxShift, 4);
  return estimateShift(a, b, w, h, 3, 1, { dx: Math.round(coarse.dx), dy: Math.round(coarse.dy) });
}

/**
 * How alike two frames are once their levels are removed: the zero-shift normalised correlation of the
 * high-passed frames, −1..1. The twin uses it while following the playhead to notice when the scene no
 * longer looks like the frame it was built from (something was moved, added or taken away), which the
 * frozen layout cannot follow.
 */
export function frameSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  w = IR_ARRAY_WIDTH,
  h = IR_ARRAY_HEIGHT,
): number {
  const ha = highPass(a, w, h);
  const hb = highPass(b, w, h);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < ha.length; i++) {
    sab += ha[i] * hb[i];
    saa += ha[i] * ha[i];
    sbb += hb[i] * hb[i];
  }
  const denom = Math.sqrt(saa * sbb);
  return denom > 1e-9 ? sab / denom : 0;
}

export interface StabilitySample {
  index: number; // recording-frame index (1-based)
  temps: ArrayLike<number>; // Celsius, row-major w×h
}

/**
 * Run the gate over the sampled frames. `referenceIndex` is the sample that moved least relative to
 * its neighbours (ties → nearest the middle of the clip), i.e. the best single frame to analyse.
 * `maxShiftPx` / `p95ShiftPx` are the drift of the samples FROM that reference — what the paint will
 * correct — and the clip is stable while the largest trackable drift is within STABLE_MAX_SHIFT_PX.
 */
export function assessStability(samples: StabilitySample[], w = IR_ARRAY_WIDTH, h = IR_ARRAY_HEIGHT): TwinStability {
  if (samples.length === 0) {
    return { stable: false, maxShiftPx: 0, p95ShiftPx: 0, sampled: 0, referenceIndex: 1 };
  }
  if (samples.length === 1) {
    return { stable: true, maxShiftPx: 0, p95ShiftPx: 0, sampled: 1, referenceIndex: samples[0].index };
  }
  const hp = samples.map((s) => highPass(s.temps, w, h));

  // Pass 1 — motion between consecutive samples, only to choose the reference: least motion around
  // the sample (the mean of its neighbouring pairs, so the ends of the clip — one neighbour only — are
  // not favoured; a featureless pair is ignored), with a pull toward the middle of the clip worth up to
  // half a pixel at the ends — enough to beat the estimates' sub-pixel noise when the motion is the
  // same everywhere (a slow creep, whose drift a middle reference halves), never a real difference.
  const pairMag: number[] = [];
  for (let i = 0; i + 1 < hp.length; i++) {
    const e = estimateShift(hp[i], hp[i + 1], w, h);
    pairMag.push(e.score >= MIN_NCC_SCORE ? Math.hypot(e.dx, e.dy) : NaN);
  }
  const mid = (samples.length - 1) / 2;
  let bestI = 0;
  let bestCost = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const around = [i > 0 ? pairMag[i - 1] : NaN, i < pairMag.length ? pairMag[i] : NaN].filter(
      (m) => !Number.isNaN(m),
    );
    const motion = around.length ? around.reduce((s, m) => s + m, 0) / around.length : 0;
    const cost = motion + (0.5 * Math.abs(i - mid)) / Math.max(1, mid);
    if (cost < bestCost) {
      bestCost = cost;
      bestI = i;
    }
  }

  // Pass 2 — every sample against the reference, the way the paint will align it. NaN = untrackable.
  const drift: number[] = [];
  for (let i = 0; i < hp.length; i++) {
    if (i === bestI) continue;
    const e = alignFrame(hp[bestI], hp[i], w, h);
    drift.push(e.score >= MIN_NCC_SCORE ? Math.hypot(e.dx, e.dy) : NaN);
  }
  const valid = drift.filter((m) => !Number.isNaN(m)).sort((x, y) => x - y);
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const maxShiftPx = round2(valid.length ? valid[valid.length - 1] : 0);
  const p95ShiftPx = round2(
    valid.length ? valid[Math.min(valid.length - 1, Math.floor(0.95 * (valid.length - 1)))] : 0,
  );
  // Judged on the rounded figure so the verdict always agrees with the number the user is shown.
  const stable = maxShiftPx <= STABLE_MAX_SHIFT_PX;

  return {
    stable,
    maxShiftPx,
    p95ShiftPx,
    sampled: samples.length,
    referenceIndex: samples[bestI].index,
  };
}
