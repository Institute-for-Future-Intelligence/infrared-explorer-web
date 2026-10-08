/**
 * Derived thermal ANALYSIS — the quantitative layer between the raw sampled numbers
 * (buildThermalSummary) and the AI prompt.
 *
 * Why this exists: the report model used to be handed a bare 25-point series per probe and asked to
 * describe "the trend". Reading a cooling curve off floats is exactly the kind of numeric work a language
 * model is worst at and a dozen lines of least squares are best at — so the fits, the extrema, the phase
 * segmentation and the spatial statistics are computed HERE, deterministically, and the model is left to
 * do what it is actually good at: explaining what they mean.
 *
 * The mathematics is a server-side port of the analyzer's own tools, so a number quoted in a report is the
 * same number the user sees when they run the tool by hand in the UI:
 *   - fitNewtonCooling  <- src/utils/curveFit.ts   (T(t) cooling/heating fit tool: tau, T-infinity, R^2)
 *   - linearFit         <- src/utils/lineProfile.ts (T(l) dT/dx gradient tool)
 * Both are pure and dependency-free in the client, so they are copied verbatim rather than re-derived.
 * KEEP IN SYNC: a fix to the maths belongs in both files (there is no shared package between the web app
 * and functions/).
 *
 * Everything here is pure computation over frames the caller has ALREADY decoded — no Storage reads, no
 * Firestore, no I/O at all. Cost is a few milliseconds on top of the summary's existing frame fan-out.
 */
import { createHash } from 'crypto';
import {
  DecodedFrame,
  FrameStats,
  IR_ARRAY_WIDTH,
  IR_ARRAY_HEIGHT,
  celsiusAtIndex,
  celsiusAtPoint,
  frameStats,
} from './thermal';

// ---------------------------------------------------------------------------
// Newton cooling/heating fit — verbatim port of src/utils/curveFit.ts.
// Model: T(t) = Tinf + A*exp(-k*(t - t0)), k > 0. A > 0 cooling (falling toward Tinf), A < 0 heating.
// ---------------------------------------------------------------------------

export interface ExpFit {
  tInf: number; // asymptote (deg C)
  a: number; // signed amplitude at t0: >0 cooling, <0 heating
  k: number; // rate constant (1/s), strictly > 0
  tau: number; // time constant 1/k (s)
  t0: number; // exponent anchor (s) — the window's first sample time
  r2: number; // coefficient of determination in temperature space, clamped [0,1]
  n: number; // finite points used
  direction: 'cooling' | 'heating';
}

/** How far beyond the observed range the asymptote may sit, as a multiple of the observed span. */
const ASYMPTOTE_SPAN = 10;

interface SideFit {
  tInf: number;
  a: number;
  k: number;
  ssr: number;
}

/**
 * Least-squares log-linear fit for ONE fixed asymptote on one side, scored back in temperature space.
 * 'below' expects Tinf < every reading (cooling); 'above' expects Tinf > every reading (heating).
 * Returns null when the side is infeasible for these points or the series does not decay toward Tinf —
 * so the correct side is simply the one that yields a result and the wrong side self-rejects.
 */
const fitForAsymptote = (xs: number[], ts: number[], tInf: number, side: 'below' | 'above'): SideFit | null => {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = side === 'below' ? ts[i] - tInf : tInf - ts[i];
    if (d <= 1e-9) return null; // a reading on/past the asymptote -> this side can't hold these points
    const y = Math.log(d);
    const x = xs[i];
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom < 1e-12) return null; // no spread in time -> slope undefined
  const m = (n * sxy - sx * sy) / denom;
  const b = (sy - m * sx) / n;
  if (m >= -1e-12) return null; // growth, not decay toward Tinf -> not this side's model
  const k = -m;
  const mag = Math.exp(b);
  const a = side === 'below' ? mag : -mag;
  let ssr = 0;
  for (let i = 0; i < xs.length; i++) {
    const tHat = tInf + a * Math.exp(-k * xs[i]);
    ssr += (ts[i] - tHat) ** 2;
  }
  return { tInf, a, k, ssr };
};

/** Golden-section search for the asymptote minimising SSR within [lo, hi] on one side. */
const searchAsymptote = (
  xs: number[],
  ts: number[],
  lo: number,
  hi: number,
  side: 'below' | 'above',
): SideFit | null => {
  const gr = (Math.sqrt(5) - 1) / 2;
  const f = (x: number): number => fitForAsymptote(xs, ts, x, side)?.ssr ?? Infinity;
  let a = lo;
  let b = hi;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let it = 0; it < 100 && b - a > 1e-4; it++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - gr * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + gr * (b - a);
      fd = f(d);
    }
  }
  return fitForAsymptote(xs, ts, (a + b) / 2, side);
};

/** Minimum points for a meaningful three-parameter (Tinf, A, k) exponential fit. */
export const MIN_FIT_POINTS = 4;

/**
 * Fit T(t) = Tinf + A*exp(-k*(t - t0)) by searching the asymptote on both sides and keeping the
 * lower-residual one. Null when there are too few finite points, the readings are flat, or neither side
 * yields a decaying fit.
 */
export const fitNewtonCooling = (pts: { t: number; T: number }[]): ExpFit | null => {
  const clean = pts.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.T)).sort((p, q) => p.t - q.t);
  if (clean.length < MIN_FIT_POINTS) return null;

  const t0 = clean[0].t;
  const xs = clean.map((p) => p.t - t0);
  const ts = clean.map((p) => p.T);

  let minT = Infinity;
  let maxT = -Infinity;
  let mean = 0;
  for (const T of ts) {
    if (T < minT) minT = T;
    if (T > maxT) maxT = T;
    mean += T;
  }
  mean /= ts.length;
  const span = maxT - minT;
  if (span < 1e-6) return null; // flat -> no exponential

  let sst = 0;
  for (const T of ts) sst += (T - mean) ** 2;

  const below = searchAsymptote(xs, ts, minT - ASYMPTOTE_SPAN * span, minT - 1e-4 * span, 'below');
  const above = searchAsymptote(xs, ts, maxT + 1e-4 * span, maxT + ASYMPTOTE_SPAN * span, 'above');
  const candidates = [below, above].filter((c): c is SideFit => c !== null);
  if (candidates.length === 0) return null;

  const best = candidates.reduce((p, c) => (c.ssr < p.ssr ? c : p));
  const r2 = sst > 1e-12 ? Math.min(1, Math.max(0, 1 - best.ssr / sst)) : 1;
  return {
    tInf: best.tInf,
    a: best.a,
    k: best.k,
    tau: 1 / best.k,
    t0,
    r2,
    n: clean.length,
    direction: best.a >= 0 ? 'cooling' : 'heating',
  };
};

// ---------------------------------------------------------------------------
// Linear (OLS) fit — verbatim port of src/utils/lineProfile.ts linearFit, used for the profile-line
// gradient. Kept separate from the exponential fit above: a transect is linear in space, not in time.
// ---------------------------------------------------------------------------

export interface LinearFit {
  slope: number; // d(temperature)/d(x)
  intercept: number;
  r2: number; // clamped [0,1]
  n: number;
}

export const linearFit = (pts: { x: number; y: number }[]): LinearFit | null => {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const { x, y } of pts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }
  if (n < 2) return null;
  const denomX = n * sxx - sx * sx;
  if (denomX < 1e-12) return null; // no spread in x -> slope undefined
  const cov = n * sxy - sx * sy;
  const slope = cov / denomX;
  const intercept = (sy - slope * sx) / n;
  const denomY = n * syy - sy * sy;
  const r2 = denomY > 1e-12 ? Math.min(1, Math.max(0, (cov * cov) / (denomX * denomY))) : 1;
  return { slope, intercept, r2, n };
};

/** A transect drawn on the image, in fractional [0,1] coordinates (mirrors the client ProfileLine). */
export interface ProfileLineLike {
  id?: string;
  name?: string | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lengthCm?: number | null;
}

/**
 * Sample temperature along the transect A->B on one frame, nearest-pixel (never interpolated), so a
 * reading names a real pixel exactly as the analyzer's T(l) chart does. `pos` runs 0 at A to 1 at B.
 */
export const sampleLineProfile = (
  frame: DecodedFrame,
  line: ProfileLineLike,
  samples: number,
): { pos: number; tempC: number }[] => {
  const n = Math.max(2, Math.floor(samples));
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const out: { pos: number; tempC: number }[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out[i] = { pos: t, tempC: celsiusAtPoint(frame, line.x1 + dx * t, line.y1 + dy * t) };
  }
  return out;
};

/** On-image pixel length of a transect — the divisor that turns a per-position slope into deg/pixel. */
export const linePixelLength = (line: ProfileLineLike, width: number, height: number): number =>
  Math.hypot((line.x2 - line.x1) * width, (line.y2 - line.y1) * height);

// ---------------------------------------------------------------------------
// The digest.
// ---------------------------------------------------------------------------

const round2 = (v: number) => Number(v.toFixed(2));
const round3 = (v: number) => Number(v.toFixed(3));

/** One sampled frame the digest can re-read pixels from, with the identity needed to name its instant. */
export interface KeptFrame {
  frame: DecodedFrame;
  recordingIndex: number;
  tSec: number;
}

/**
 * Which axis a summary's `t` values live on: seconds into a clip, or a photo's number in a photo set
 * (its 1-based place in the owner's viewing order — see photoSet.ts). Defined here rather than in
 * photoSet.ts because this module is also compiled into the web app's test project (the freshness
 * parity test imports it), and every server module it pulls in is one more file that project must know.
 */
export type AnalysisAxis = 'time' | 'photo';

/**
 * A photo set's stored viewing order repaired into a permutation of 0..count-1 — MIRROR of the client's
 * utils/photoOrder.ts normalizePhotoOrder (the two builds share no package). `photoOrder[p]` is the
 * 0-based capture SLOT shown at PLACE p; entries that are not a slot of this set are dropped and every
 * slot the order misses is appended in capture order. Absent → capture order. Lives here, beside the
 * cache key and the freshness descriptor that need it (see AnalysisAxis for why not photoSet.ts).
 */
export function normalizePhotoOrder(stored: unknown, count: number): number[] {
  const n = Math.max(0, Math.floor(count));
  const taken = new Array<boolean>(n).fill(false);
  const order: number[] = [];
  if (Array.isArray(stored)) {
    for (const v of stored) {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n && !taken[v]) {
        taken[v] = true;
        order.push(v);
      }
    }
  }
  for (let slot = 0; slot < n; slot++) if (!taken[slot]) order.push(slot);
  return order;
}

/** The per-probe series the digest analyses, as produced by the summary builders. */
export interface SeriesInput {
  label: string;
  series: number[];
  /** Who chose this position: the student, or the automatic analysis. Absent = student. */
  placedBy?: 'student' | 'ai';
}

// ---------------------------------------------------------------------------
// Probe signal quality.
//
// A probe is a claim that this position is worth measuring, and the claim can be wrong: a probe on the
// static background produces a series whose only content is sensor noise. Nothing downstream used to
// check — the phase segmentation would happily narrate that noise as "T3 peaks and begins to fall", the
// event list filled up with fictitious turning points, and the adaptive sampler could be captured by a
// jittering background probe because it picked the widest span with no floor.
//
// So every series is assessed before anything narrates it. The categories deliberately do not say
// "useless": a static probe may be a deliberate control, which is good experimental practice — the
// assessment states what the data shows and leaves the judgement to the prose, which also has the
// student's own notes in hand.
// ---------------------------------------------------------------------------

export interface ProbeSignal {
  /** Total excursion over the clip, °C. */
  spanC: number;
  /** Noise estimate from median absolute second differences (trend-cancelled), °C per sample. */
  noiseC: number;
  /** spanC / noiseC (floored at the 0.01 °C reading resolution). */
  snr: number;
  /** 'active': a real signal to narrate. 'static': essentially unchanged — a control, or a probe on
   *  nothing. 'noisy': it moved, but indistinguishably from sensor noise. */
  assessment: 'active' | 'static' | 'noisy';
}

/** Below this total excursion a probe measured "nothing happened here" — whatever the SNR says. */
const STATIC_SPAN_C = 0.8;
/**
 * Signal must exceed this multiple of the excursion pure noise would show ANYWAY.
 *
 * The comparison has to be range-against-range: the span of n noise samples is not sigma, it is about
 * 2*sqrt(2*ln n)*sigma (~3.9 sigma at n=25), so a fixed span/sigma threshold quietly passes pure noise —
 * Monte Carlo on the first version showed 84% of sigma=0.25 °C noise series classified 'active'. The
 * expected noise range is computed per series length and the span must beat 1.4x of it.
 */
const NOISY_RANGE_FACTOR = 1.4;

export const assessProbeSignal = (temps: number[]): ProbeSignal => {
  const clean = temps.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return { spanC: 0, noiseC: 0, snr: 0, assessment: 'static' };
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of clean) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const spanC = hi - lo;
  // Noise sigma from SECOND differences, not successive ones. A fast genuine trend puts the whole trend
  // into every successive difference — a clean exponential sampled at four points would read as "all
  // noise" and be gated out. The second difference cancels the local linear trend and keeps what
  // jitters; 0.605 = 1.4826/sqrt(6) converts the MEDIAN absolute second difference of Gaussian noise
  // back to its per-sample sigma (1.4826 is the half-normal median-to-sigma factor, sqrt(6) the second
  // difference's variance inflation).
  const d2 = [];
  for (let i = 2; i < clean.length; i++) d2.push(Math.abs(clean[i] - 2 * clean[i - 1] + clean[i - 2]));
  d2.sort((a, b) => a - b);
  const noiseC = d2.length > 0 ? d2[Math.floor(d2.length / 2)] * 0.605 : Math.abs(clean[1] - clean[0]);
  const snr = spanC / Math.max(noiseC, 0.01);
  // What pure noise of this sigma would span across THIS MANY samples — the only fair thing to compare
  // the observed span against. A fixed span/sigma cutoff is not: the max of 25 noise samples sits ~3.9
  // sigma above the min all by itself.
  const expectedNoiseRange = 2 * Math.sqrt(2 * Math.log(Math.max(clean.length, 3))) * Math.max(noiseC, 0.01);
  return {
    spanC: round2(spanC),
    noiseC: round2(noiseC),
    snr: round2(snr),
    assessment: spanC < STATIC_SPAN_C ? 'static' : spanC < NOISY_RANGE_FACTOR * expectedNoiseRange ? 'noisy' : 'active',
  };
};

// ---------------------------------------------------------------------------
// Automatic probe placement.
//
// "Where should a probe go?" has a measurable half: a position whose temperature actually CHANGES over
// the clip is carrying information, and a position that never moves is not. The per-pixel temporal range
// over the kept frames finds the former. What it cannot judge is the experiment's intent — which is why
// these are suggestions and virtual measurements, never writes to the student's probe set.
//
// Guards, each against a specific known failure:
//  - the range map is box-blurred first, because a single flickering sensor element otherwise outscores
//    a whole warming plate (the same single-pixel disease p02/p98 exist for);
//  - candidates near an existing probe are excluded — a suggestion duplicating T1 adds nothing;
//  - candidates need a real absolute excursion, so a static scene yields no suggestions at all;
//  - a clip whose hotspot migrates far is refused outright: on a moving subject the highest-range pixels
//    are the silhouette EDGES — positions where a fixed probe alternately reads subject and background,
//    i.e. the worst probes in the frame scored as the best.
// ---------------------------------------------------------------------------

export interface SuggestedProbe {
  x: number; // normalized [0,1]
  y: number;
  /** Temperature excursion at this position over the clip, °C — why it was chosen. */
  rangeC: number;
}

/** Suggestions and existing probes must sit at least this far apart (normalized image units). */
const SUGGEST_EXCLUDE_RADIUS = 0.14;
/** No suggestion within this (normalized) distance of the picture's edge: the outermost pixels of a
 *  FLIR frame drift with the camera's own temperature more than the middle does, and a probe on the
 *  very corner pixel measures the lens housing, not the scene. One was once suggested at (0.004, 0.003). */
const SUGGEST_EDGE_MARGIN = 0.05;
/** A position must swing at least this much over the clip to be worth suggesting. */
const SUGGEST_MIN_RANGE_C = 1.5;
/** Hotspot drift beyond this fraction of the image means the subject moved — range maps to edges. */
const SUGGEST_MAX_DRIFT = 0.25;
/** Two positions whose readings never part by this much (°C) are one measurement made twice. Spatial
 *  separation does not imply a different measurement: on a single warm object, points a comfortable
 *  distance apart still trace the SAME curve, and each duplicate costs a permanent probe on the
 *  student's experiment plus a paragraph restating the one before it. */
const SUGGEST_MIN_SERIES_DIFF_C = 1.5;
/** Candidates to consider per probe asked for. Rejected duplicates have to come from somewhere; past
 *  this the frame has nothing thermally distinct left to offer and the search stops on its own. */
const SUGGEST_MAX_ATTEMPTS = 4;

/** The largest gap between two series, or Infinity if there is nothing to compare — an unmeasurable
 *  candidate must never be mistaken for a duplicate of one that was measured. */
const maxAbsDiff = (a: number[], b: number[]): number => {
  const n = Math.min(a.length, b.length);
  if (n === 0) return Infinity;
  let m = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
};

export function suggestProbePositions(
  frames: KeptFrame[],
  frameGlobal: { hotspot: { x: number; y: number }; p02?: number }[],
  exclude: { x: number; y: number }[],
  k: number,
): SuggestedProbe[] {
  if (frames.length < 3 || k <= 0) return [];
  const { w, h } = frames[0].frame;
  const n = w * h;
  if (n <= 0) return [];

  // Moving-subject guard: when the hottest pixel migrates across the clip, per-pixel range measures the
  // silhouette sweeping past, not fixed positions worth probing. Checked against EVERY frame, not just
  // the endpoints — a subject that swings away and back (a hand, a pendulum) ends where it started and
  // would pass a first-vs-last test while smearing its silhouette across the whole range map.
  if (frameGlobal.length >= 2) {
    const a = frameGlobal[0].hotspot;
    for (const g of frameGlobal) {
      if (Math.hypot(g.hotspot.x - a.x, g.hotspot.y - a.y) > SUGGEST_MAX_DRIFT) return [];
    }
  }

  // Per-pixel temporal range. Range, not first-vs-last: the codebase already documents why differencing
  // fails ("a probe that warms and then cools back returns roughly zero").
  // Measured ABOVE THE SCENE'S FLOOR of each frame (its p02, when the caller has it): a camera that
  // drifts between calibrations lifts every pixel together, and a hand in frame warms the whole
  // picture a little — neither is a position worth probing, yet both once ranked the top-left corner
  // first. What is left after the floor is subtracted is what changed at THAT position.
  const floors =
    frameGlobal.length === frames.length ? frameGlobal.map((g) => (typeof g.p02 === 'number' ? g.p02 : 0)) : null;
  const lo = new Float32Array(n).fill(Infinity);
  const hi = new Float32Array(n).fill(-Infinity);
  frames.forEach((kept, fi) => {
    if (kept.frame.w !== w || kept.frame.h !== h) return;
    const floor = floors ? floors[fi] : 0;
    for (let i = 0; i < n; i++) {
      const c = celsiusAtIndex(kept.frame, i) - floor;
      if (c < lo[i]) lo[i] = c;
      if (c > hi[i]) hi[i] = c;
    }
  });

  // 3x3 box blur of the range map, so a candidate is a REGION that changes, not one pixel.
  const range = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const i = yy * w + xx;
          sum += hi[i] - lo[i];
          cnt += 1;
        }
      }
      range[y * w + x] = sum / cnt;
    }
  }

  // Greedy non-max suppression with an exclusion radius, seeded with the user's own probes so a
  // suggestion never lands on something already measured.
  const taken: { x: number; y: number }[] = exclude.map((p) => ({ x: p.x, y: p.y }));
  const out: SuggestedProbe[] = [];
  // What each accepted position actually read, for the redundancy test below.
  const accepted: number[][] = [];
  // A rejected candidate still blanks its own disc, so the search space shrinks on every pass and this
  // terminates well before the cap — which only bounds a pathological frame.
  for (let attempt = 0; out.length < k && attempt < k * SUGGEST_MAX_ATTEMPTS; attempt++) {
    let bestIdx = -1;
    let bestVal = SUGGEST_MIN_RANGE_C;
    for (let i = 0; i < n; i++) {
      if (range[i] <= bestVal) continue;
      const px = ((i % w) + 0.5) / w;
      const py = (Math.floor(i / w) + 0.5) / h;
      if (
        px < SUGGEST_EDGE_MARGIN ||
        px > 1 - SUGGEST_EDGE_MARGIN ||
        py < SUGGEST_EDGE_MARGIN ||
        py > 1 - SUGGEST_EDGE_MARGIN
      )
        continue;
      let blocked = false;
      for (const t of taken) {
        if (Math.hypot(px - t.x, py - t.y) < SUGGEST_EXCLUDE_RADIUS) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        bestIdx = i;
        bestVal = range[i];
      }
    }
    if (bestIdx < 0) break;
    const x = Number((((bestIdx % w) + 0.5) / w).toFixed(3));
    const y = Number(((Math.floor(bestIdx / w) + 0.5) / h).toFixed(3));
    // Excluded whether it is kept or not: a duplicate's neighbourhood holds nothing but more of the
    // same curve, so re-examining it would burn every remaining attempt on one object.
    taken.push({ x, y });
    // Read the candidate over the same frames the range map was built from (the geometry guard has to
    // match, or the series would be sampled from frames the range never saw).
    const series: number[] = [];
    const relative: number[] = [];
    frames.forEach((kept, fi) => {
      if (kept.frame.w !== w || kept.frame.h !== h) return;
      const c = celsiusAtIndex(kept.frame, bestIdx);
      series.push(c);
      relative.push(c - (floors ? floors[fi] : 0));
    });
    // The blurred map RANKS regions; this pixel's own reading is what decides. They come apart on the
    // skirt of a strong blob, where a pixel inherits its neighbours' excursion while measuring none of
    // it — a probe dropped there reads a flat line, under a rangeC that promised a swing. Cheap to
    // ignore while only the top two positions were ever taken; with a larger budget the skirt of the
    // hottest object is precisely what fills the remaining slots.
    // The excursion that decides is the floor-relative one (what the range map ranked on); the rangeC
    // reported is the raw reading's, which is what the model sees in the series beside it.
    const ownRange = series.length ? Math.max(...series) - Math.min(...series) : 0;
    const ownRelative = relative.length ? Math.max(...relative) - Math.min(...relative) : 0;
    if (ownRelative < SUGGEST_MIN_RANGE_C) continue;
    // A position whose excursion is one jump is where something ARRIVED (or left): a fingertip pressed
    // onto a ruler, a mug set down. The range map ranks it first every time — nothing in a scene swings
    // like a 33 °C hand appearing on a 22 °C bench — and a probe there measures the hand, not the
    // experiment. Four of five virtual probes once sat on two fingertips and were narrated as the rulers
    // under them. A gradual change at the same position (the ruler warming after the finger arrived) is
    // what the probes are for and is not a step.
    if (
      arrivalStep(
        frames.map((k) => k.tSec),
        series,
      )
    )
      continue;
    if (accepted.some((s) => maxAbsDiff(s, series) < SUGGEST_MIN_SERIES_DIFF_C)) continue;
    accepted.push(series);
    // Reported from the reading, not the blur, so "chosen because it swung by rangeC" is a claim about
    // the series the model is handed alongside it.
    out.push({ x, y, rangeC: round2(ownRange) });
  }
  return out;
}

/**
 * First free number for a new AI probe label ("AI3" when "AI1"/"AI2" exist).
 *
 * A generated report now PERSISTS its virtual probes as real thermometer docs named by their label, so
 * on the next run those come back as ordinary probes and the fresh virtual ones must not reuse their
 * names — a summary holding a saved "AI1" and a virtual "AI1" would give the model one name for two
 * different positions. Scans the saved probes' names rather than counting them: a user can delete AI1
 * and keep AI2, and reusing the freed number would resurrect a label old reports still cite.
 */
export function nextAiProbeNumber(names: (string | null | undefined)[]): number {
  let max = 0;
  for (const n of names) {
    const m = typeof n === 'string' ? /^AI(\d{1,4})$/.exec(n.trim()) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// MIRROR of FIGURE_LINE_RE in src/utils/reportFigures.ts — the client decides what renders as a figure,
// this decides what survives into the saved report; the two must agree on what a marker IS. The caption
// group is one greedy run with no adjacent whitespace quantifiers (backtracking blowup — see the client).
// Two spellings, one per axis: `t = 48 s` names an instant of a clip, `photo 2` a photo of a set.
const FIGURE_MARKER_RE =
  /^\s*\[\s*figure\s*:\s*(?:t\s*=\s*(\d+(?:\.\d+)?)\s*s|photo\s*(\d+(?:\.\d+)?))\s*(?:\|([^\]]*))?\]\s*$/i;
const FIGURE_MARKER_LINE_MAX = 400;

/**
 * Make every [figure: t = X s | caption] marker in a report name a REAL sampled instant, or remove it.
 *
 * The numeric verifier cannot do this: its legal-time set deliberately includes durations (pairwise
 * differences) and tau multiples, so "t = 150 s" can pass verification on a 60-second clip whose fit
 * gave tau = 30 s — and the client would then clamp it to the last frame and render a thumbnail
 * captioned with an instant that does not exist. A marker is a rendering instruction, not a prose
 * claim, so it is held to the stricter rule the prompt states: the instant must be one of `instants`
 * (the sampled times, including any the deep mode added).
 *
 * A time within half the median sample spacing (at least ±0.75 s) of a sampled instant is SNAPPED to
 * it — models round, and the thumbnail shown is that frame's anyway, so the caption should name it
 * exactly. Anything further off, and any marker past `maxFigures`, is dropped whole. Non-marker lines
 * pass through byte-identical.
 *
 * `axis` is the axis `instants` live on, and decides the spelling every kept marker is rewritten in: a
 * photo set's markers name photos (`[figure: photo 2 | …]`) — a marker written in the other axis's
 * spelling is still understood (the number is read the same way) but comes out in the right one, so the
 * client never has to guess what a marker's number means from the experiment it sits on.
 */
export function sanitizeReportFigures(
  report: string,
  instants: number[],
  maxFigures: number,
  axis: AnalysisAxis = 'time',
): string {
  const sorted = [...new Set(instants.filter((t) => Number.isFinite(t)))].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((t, i) => t - sorted[i]);
  const medianGap = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
  const tol = Math.max(0.75, medianGap / 2);
  let kept = 0;
  const out: string[] = [];
  for (const line of report.split('\n')) {
    const m = line.length <= FIGURE_MARKER_LINE_MAX ? FIGURE_MARKER_RE.exec(line) : null;
    if (!m) {
      out.push(line);
      continue;
    }
    const t = Number(m[1] ?? m[2]);
    let nearest: number | null = null;
    for (const s of sorted) if (nearest === null || Math.abs(s - t) < Math.abs(nearest - t)) nearest = s;
    if (nearest === null || Math.abs(nearest - t) > tol || kept >= maxFigures) continue;
    kept += 1;
    const caption = (m[3] ?? '').trim();
    const shown = Number(nearest.toFixed(2));
    const at = axis === 'photo' ? `photo ${shown}` : `t = ${shown} s`;
    out.push(`[figure: ${at}${caption ? ` | ${caption}` : ''}]`);
  }
  return out.join('\n');
}

/** Longest stretch before the title that stripReportPreamble treats as stray narration. */
const REPORT_PREAMBLE_MAX = 500;

/**
 * Drop what a model wrote before the report's title. The prompt makes the level-1 title the first line,
 * but a model whose thinking is switched off (DeepSeek's newest, see chatExtras in index.ts) narrates
 * between tool calls in its answer text — and when it writes the report in a round that still had tools
 * attached, that round's whole text is the report, so a line like "I have what I need. Writing the
 * report." lands above the title and is saved with it (3 of 10 such reports in a live run, 2026-09-11).
 *
 * Only a short preamble with no heading of its own goes. A report with no level-1 title at all (an older
 * format, or a model that ignored the structure) comes back untouched rather than guessed at.
 */
export function stripReportPreamble(report: string): string {
  const title = /^#[ \t]/m.exec(report);
  if (!title || title.index === 0) return report;
  const preamble = report.slice(0, title.index);
  if (preamble.length > REPORT_PREAMBLE_MAX || /^[ \t]*#/m.test(preamble)) return report;
  return report.slice(title.index);
}

/**
 * One stretch of a probe's story. 'rising' / 'falling' move at least the fast-change rate on average;
 * 'drift-up' / 'drift-down' change by more than the noise over the stretch but slowly — a slow creep or
 * a long cooling tail, which is NOT a plateau and must not be narrated as one; 'plateau' changed by less
 * than the noise end to end. The kind is decided by the stretch's NET change (tempEnd − tempStart)
 * against the probe's noise, so a label can never contradict its own endpoints.
 */
export interface Phase {
  kind: 'rising' | 'falling' | 'plateau' | 'drift-up' | 'drift-down';
  tStart: number;
  tEnd: number;
  tempStart: number;
  tempEnd: number;
}

export interface ThermometerDigest {
  label: string;
  /** Who chose this position — the student, or the automatic analysis (an AI-suggested virtual probe). */
  placedBy: 'student' | 'ai';
  /** Is this series signal or noise? Phases, events and peakRate exist only for an 'active' probe —
   *  narrating a static or noise-dominated series as physical turning points is worse than silence.
   *  Null on the photo axis: readings taken on separate photos are not a series in time, so there is no
   *  signal to assess — and a noise estimate from the differences between unrelated scenes would only be
   *  quoted as one. */
  signal: ProbeSignal | null;
  /** Fitted Newton cooling/heating law, or null. Null MUST be read as "no exponential behaviour shown".
   *  `fromT` is where the fitted stretch starts: the whole series, or the tail from the probe's extreme
   *  onward when the series first had to get there (an object arriving, a kettle switched on). */
  newtonFit: {
    tau: number;
    tInf: number;
    r2: number;
    direction: 'cooling' | 'heating';
    nPoints: number;
    fromT: number;
  } | null;
  maxAt: { t: number; tempC: number } | null;
  minAt: { t: number; tempC: number } | null;
  /** Steepest local rate over the sampled series (a regression over ±1 s where the sampling is dense,
   *  central differences where it is sparse), signed, with its instant. Null when no stretch moved by
   *  more than the noise within its window — the steepest jitter is not a rate. */
  peakRate: { cPerSec: number; t: number } | null;
  phases: Phase[];
  /** The largest single-interval jump when it is a step the surface cannot make — something warmer or
   *  cooler arrived at or left this position at `t` (a hand, a mug, a ruler's edge). The readings before
   *  and after are of different objects, and the step itself is not a heating rate. Null otherwise. */
  step: { t: number; deltaC: number } | null;
  /** The reading relative to the scene's own floor (the frame's p02) at the first and last sample, and
   *  how that gap changed. A probe can read +1.4 °C while the whole picture drifted +1.4 °C — a camera
   *  between calibrations drifts, and a hand in frame warms the air — and only this says whether the
   *  surface under the probe warmed relative to its surroundings. Null without frame percentiles. */
  vsBackground: { startC: number; endC: number; changeC: number } | null;
}

export interface ProfileLineDigest {
  name: string;
  lengthCm: number | null;
  /** Fitted gradient at each probed instant. `unit` is 'C/cm' when the user calibrated a real length. */
  gradients: { t: number; slope: number; unit: 'C/cm' | 'C/px'; r2: number; deltaC: number }[];
}

/** A moment where the experiment's behaviour changed, in clip time. */
export interface DigestEvent {
  t: number;
  kind: 'onset' | 'peak' | 'trough' | 'steady';
  thermometer: string;
  tempC: number;
  detail: string;
}

export interface AnalysisDigest {
  /** Bumped whenever the computation below changes — see the cache's algorithm version. */
  version: number;
  note: string;
  /** How many frames actually went into all of this, so the report can state its own resolution. */
  sampling: { requested: number; used: number; truncated: number; densifiedWindows: number };
  /** The clip's turning points, chronologically — what the Observations section should be built around. */
  events: DigestEvent[];
  thermometers: ThermometerDigest[];
  clip: {
    hotspotDrift: {
      fromT: number;
      toT: number;
      from: { x: number; y: number };
      to: { x: number; y: number };
      movedFraction: number;
    } | null;
    warmArea: { thresholdC: number; atT: number; fractionPct: number }[] | null;
  };
  profileLines: ProfileLineDigest[];
  /**
   * Whether the SCENE as a whole warmed: the robust bounds and the mean of the frame at the start, the
   * hottest instant and the end, with the warm-area fraction where one was computed. Three rows that
   * replace the per-frame frameGlobal table the model used to be handed (it never needed 25 rows of
   * single-pixel extremes, and every one of them became a "legal" figure for the verifier). Empty on the
   * photo axis is NOT the rule — a set gets its three photos too, by photo number.
   */
  scene: { t: number; p02: number; p98: number; mean: number; warmPct: number | null }[];
}

/** Digest computation version. Bump on ANY change to what the functions below produce (the derived-cache
 *  key folds this in, so old cached digests are recomputed rather than served forever).
 *  v2: adaptive densification, the event timeline and the sampling record.
 *  v3: per-probe signal assessment with noise gating, placedBy, and AI-suggested virtual probes.
 *  v4: the scene block (start / peak / end bounds), standing in for frameGlobal in the model's view.
 *  v5: windowed rates and phases for dense sampling, the fit on a uniform grid.
 *  v6: phases labelled by net change against noise (drift kinds, at most PHASE_MAX), the peak rate
 *      gated on noise, the fit from the extreme onward, per-probe step and vsBackground. */
export const DIGEST_VERSION = 6;

/**
 * Turn each probe's phase segmentation into named moments.
 *
 * A phase list says what the curve did; an event says WHEN it changed and to what — which is what a
 * chronological write-up is built from, and what a "jump to this moment" affordance would need.
 */
const upward = (k: Phase['kind']): boolean => k === 'rising' || k === 'drift-up';
const downward = (k: Phase['kind']): boolean => k === 'falling' || k === 'drift-down';

const phaseEvents = (
  label: string,
  phases: Phase[],
  maxAt: { t: number; tempC: number } | null = null,
  minAt: { t: number; tempC: number } | null = null,
): DigestEvent[] => {
  const out: DigestEvent[] = [];
  for (let i = 1; i < phases.length; i++) {
    const prev = phases[i - 1];
    const next = phases[i];
    const kind: DigestEvent['kind'] =
      next.kind === 'plateau'
        ? 'steady'
        : upward(prev.kind) && downward(next.kind)
          ? 'peak'
          : downward(prev.kind) && upward(next.kind)
            ? 'trough'
            : 'onset';
    // A peak is the series' maximum, not the boundary between the stretches: a fast rise that turns
    // into a slow drift down still climbs a while into the drift (a fingertip read 32.95 °C where the
    // rise ended and 33.53 °C seven seconds later). When the extreme lies within the two stretches, the
    // event is placed on it — the number the table quotes as the maximum.
    const extreme = kind === 'peak' ? maxAt : kind === 'trough' ? minAt : null;
    const at =
      extreme && extreme.t >= prev.tStart && extreme.t <= next.tEnd
        ? { t: extreme.t, tempC: extreme.tempC }
        : { t: next.tStart, tempC: next.tempStart };
    out.push({
      t: at.t,
      kind,
      thermometer: label,
      tempC: at.tempC,
      detail:
        kind === 'steady'
          ? // The value it levelled off AT — the stretch's start, which is what the reading was when the
            // change stopped (its end can sit a noise-width away and once read as a different number).
            `${label} levels off near ${next.tempStart} °C`
          : kind === 'peak'
            ? `${label} peaks and begins to fall`
            : kind === 'trough'
              ? `${label} bottoms out and begins to rise`
              : next.kind === 'drift-up'
                ? `${label} starts a slow upward drift`
                : next.kind === 'drift-down'
                  ? `${label} starts a slow downward drift`
                  : `${label} starts ${next.kind}`,
    });
  }
  return out;
};

/**
 * Only accept a fit that actually describes the data. A poor exponential presented confidently is worse
 * than no fit at all: the model will faithfully explain a time constant that means nothing.
 */
const FIT_MIN_R2 = 0.9;
/**
 * A fit that starts at the probe's extreme rather than at t = 0 has to cover at least this fraction of
 * the series' span. The tail after a peak is the Newton curve when a hand arrived and left a warm patch
 * behind; a tail short enough to be anything is not evidence of an exponential.
 */
const FIT_MIN_SPAN_FRACTION = 0.3;
/** The fitted stretch has to cover at least this many time constants — see bestNewtonFit. */
const FIT_MIN_TAU_COVERAGE = 0.5;

/**
 * Classify the series into rising / falling / plateau / drift phases.
 *
 * A phase boundary is a genuine change of behaviour, not sampling noise, so the per-interval slope is
 * measured against the series' own span: an interval moving less than PLATEAU_FRACTION of the total
 * excursion counts as flat. Runs are then merged, and a single-interval blip is absorbed into its
 * neighbour so a 25-point series doesn't come back as eleven "phases".
 */
const PLATEAU_FRACTION = 0.05;
/**
 * The slope threshold is also held above the noise: a windowed slope that a jitter of NOISE_RATE_K sigma
 * across the window could produce is not a move. A probe with a 3 °C span and 0.1 °C noise came back as
 * 22 phases on the span rule alone — every wobble a "rising" or "falling" stretch, half of them labelled
 * against their own endpoints.
 */
const NOISE_RATE_K = 2;
/**
 * A stretch's KIND is decided by its net change (end minus start): less than this many noise sigma, or
 * less than PHASE_NET_SPAN_FRACTION of the span, and it is a plateau whatever the local slopes said.
 * The reverse holds too — a stretch whose local slopes were all "flat" but which ends 2 °C from where it
 * began is a drift, not a plateau: a 116 s decline of a fingertip pressed on a ruler was once reported
 * as "levels off", because 2 °C over 116 s is below any per-second rate threshold.
 */
const PHASE_NET_NOISE_K = 3;
const PHASE_NET_SPAN_FRACTION = 0.1;
/** The most phases a probe gets: the smallest-change stretches are folded into their neighbours past
 *  this, so the narrative is the few things that happened rather than every bend of the curve. */
const PHASE_MAX = 6;
/**
 * A stretch is a DRIFT only when it is slow in absolute terms as well: below the span-relative rate AND
 * below this many degrees per second (3 °C a minute). The span rule alone calls a steady 0.5 °C/s ramp
 * that fills the clip "slow", because every 2.4 s of it is a small fraction of the whole — and nobody
 * calls 30 °C a minute a drift.
 */
const DRIFT_MAX_RATE = 0.05;
/**
 * A rate is only quoted when the change across its window exceeds this many noise sigma: on a ±1 s
 * window of a probe with 0.11 °C noise, three samples 0.4 °C apart make a 0.46 °C/s "steepest rate"
 * that is jitter, and was once tabled as physics.
 */
const RATE_NOISE_K = 4;
/**
 * A single-interval jump of at least this much AND this fraction of the probe's whole span is something
 * arriving or leaving, not the surface changing: no surface a classroom films warms 4 °C between two
 * frames a fifth of a second apart. A shutter step (a few tenths) and a fast pour (dense samples, each
 * a fraction of the span) both stay below it.
 */
const STEP_MIN_C = 1;
const STEP_SPAN_FRACTION = 0.4;
/**
 * The sampling interval the plateau fraction was tuned on — a minute's clip on the old 25-point grid.
 * The threshold is applied as a RATE (that fraction of the span per this many seconds), so a series
 * sampled every 0.2 s through a change classifies the same way as one sampled every 2.4 s; per interval
 * it would have called every dense step flat and every sparse one a move.
 */
const PHASE_REFERENCE_SEC = 2.4;
/**
 * A phase shorter than this belongs to its neighbours' story. A probe sampled every 0.2 s through a
 * flickering convection plume came back as dozens of phases a second or two long, every flicker a
 * "turning point" in the timeline; the old grid never produced one shorter than its own 2.4 s step.
 */
const PHASE_MIN_SEC = 2;

/**
 * Regression window for a local rate: the slope of the least-squares line through the samples within
 * this many seconds either side. A series dense through a change (every 0.2 s) would otherwise make
 * the "steepest rate" the steepest single-frame jitter — 2 °C/s quoted as physics where the probe
 * moved 0.4 °C in one frame and back.
 */
const RATE_WINDOW_SEC = 1;

/** Slope over the samples within RATE_WINDOW_SEC of sample i, or null when fewer than three fall inside
 *  it (a sparse series — the caller then uses the difference it would have used before). */
const rateWindow = (times: number[], n: number, i: number): { lo: number; hi: number } => {
  const t0 = times[i];
  let lo = i;
  while (lo > 0 && t0 - times[lo - 1] <= RATE_WINDOW_SEC) lo--;
  let hi = i;
  while (hi < n - 1 && times[hi + 1] - t0 <= RATE_WINDOW_SEC) hi++;
  return { lo, hi };
};

const windowedSlope = (times: number[], temps: number[], i: number): number | null => {
  const n = Math.min(times.length, temps.length);
  const { lo, hi } = rateWindow(times, n, i);
  if (hi - lo + 1 < 3) return null;
  const fit = linearFit(times.slice(lo, hi + 1).map((t, k) => ({ x: t, y: temps[lo + k] })));
  return fit && Number.isFinite(fit.slope) ? fit.slope : null;
};

const segmentPhases = (times: number[], temps: number[], noiseC: number): Phase[] => {
  const n = Math.min(times.length, temps.length);
  if (n < 3) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (temps[i] < lo) lo = temps[i];
    if (temps[i] > hi) hi = temps[i];
  }
  const span = hi - lo;
  if (!(span > 1e-6)) return [];
  const noise = Number.isFinite(noiseC) && noiseC > 0 ? noiseC : 0;
  const rateThreshold = Math.max(
    (span * PLATEAU_FRACTION) / PHASE_REFERENCE_SEC,
    (NOISE_RATE_K * noise) / RATE_WINDOW_SEC,
  );
  const netThreshold = Math.max(PHASE_NET_NOISE_K * noise, PHASE_NET_SPAN_FRACTION * span);

  // One kind per interval, from the local slope: the windowed regression where the sampling is dense
  // enough to have one, the interval's own slope where it is not (the old grid, unchanged). These
  // decide only where the boundaries fall; each stretch's kind is settled from its net change below.
  const kinds: Phase['kind'][] = [];
  for (let i = 1; i < n; i++) {
    const dt = times[i] - times[i - 1];
    const slope = windowedSlope(times, temps, i) ?? (dt > 1e-9 ? (temps[i] - temps[i - 1]) / dt : 0);
    kinds.push(Math.abs(slope) < rateThreshold ? 'plateau' : slope > 0 ? 'rising' : 'falling');
  }
  // Absorb one-interval blips into the surrounding run so the phase list stays readable.
  for (let i = 1; i < kinds.length - 1; i++) {
    if (kinds[i] !== kinds[i - 1] && kinds[i - 1] === kinds[i + 1]) kinds[i] = kinds[i - 1];
  }

  // Runs of one kind, as index ranges into the samples (kinds[k] is the interval samples k → k + 1).
  type Run = { kind: Phase['kind']; start: number; end: number };
  let runs: Run[] = [];
  let start = 0;
  for (let i = 1; i <= kinds.length; i++) {
    if (i === kinds.length || kinds[i] !== kinds[start]) {
      runs.push({ kind: kinds[start], start, end: i });
      start = i;
    }
  }
  const dur = (r: Run): number => times[r.end] - times[r.start];
  const net = (r: Run): number => temps[r.end] - temps[r.start];
  // The kind a stretch earns from its endpoints: flat within the noise, else fast or slow by its mean
  // rate against the same threshold the boundaries were found with.
  const kindOf = (r: Run): Phase['kind'] => {
    const d = net(r);
    if (Math.abs(d) < netThreshold) return 'plateau';
    const rate = dur(r) > 1e-9 ? Math.abs(d) / dur(r) : Infinity;
    const fast = rate >= Math.min(rateThreshold, DRIFT_MAX_RATE);
    return d > 0 ? (fast ? 'rising' : 'drift-up') : fast ? 'falling' : 'drift-down';
  };
  const join = (rs: Run[]): Run[] => {
    const joined: Run[] = [];
    for (const r of rs) {
      const last = joined[joined.length - 1];
      if (last && last.kind === r.kind) last.end = r.end;
      else joined.push({ ...r });
    }
    return joined;
  };
  // Relabel every stretch from its net change and join the neighbours that come to agree, until nothing
  // moves (joining changes a stretch's endpoints, which can change its kind). Bounded: each pass that
  // changes anything either joins two runs or settles a label.
  const settle = (rs: Run[]): Run[] => {
    let cur = rs;
    for (let pass = 0; pass < 64; pass++) {
      let changed = false;
      for (const r of cur) {
        const k = kindOf(r);
        if (k !== r.kind) {
          r.kind = k;
          changed = true;
        }
      }
      const joined = join(cur);
      if (joined.length !== cur.length) changed = true;
      cur = joined;
      if (!changed) break;
    }
    return cur;
  };
  // Fold run `si` into the longer of its neighbours.
  const fold = (rs: Run[], si: number): Run[] => {
    const left = si > 0 ? rs[si - 1] : null;
    const right = si < rs.length - 1 ? rs[si + 1] : null;
    const into = left && right ? (dur(left) >= dur(right) ? left : right) : (left ?? right)!;
    const merged: Run = {
      kind: into.kind,
      start: Math.min(into.start, rs[si].start),
      end: Math.max(into.end, rs[si].end),
    };
    const out = [...rs];
    out.splice(into === left ? si - 1 : si, 2, merged);
    return join(out);
  };
  // A run shorter than PHASE_MIN_SEC is given to the longer of its neighbours, shortest first, until
  // every run is long enough or one is left; runs of one kind that come to meet are joined.
  for (;;) {
    if (runs.length <= 1) break;
    let si = -1;
    for (let i = 0; i < runs.length; i++) {
      if (dur(runs[i]) < PHASE_MIN_SEC && (si < 0 || dur(runs[i]) < dur(runs[si]))) si = i;
    }
    if (si < 0) break;
    runs = fold(runs, si);
  }
  runs = settle(runs);
  // A stretch whose readings went well beyond its own endpoints hides a bump — a rise that fell back,
  // which nets to nothing and so settled as a plateau (a corner point once "levelled off at 23.61 °C"
  // while it climbed to 24.39 °C and came back down, and the event table contradicted the maximum). Such
  // a stretch is split at the sample furthest from the chord between its endpoints, and the halves are
  // settled on their own. Bounded: every split makes two shorter runs, and a half shorter than
  // PHASE_MIN_SEC is not made.
  for (let pass = 0; pass < 32; pass++) {
    let si = -1;
    let at = -1;
    for (let i = 0; i < runs.length && si < 0; i++) {
      const r = runs[i];
      let rLo = Infinity;
      let rHi = -Infinity;
      for (let k = r.start; k <= r.end; k++) {
        if (temps[k] < rLo) rLo = temps[k];
        if (temps[k] > rHi) rHi = temps[k];
      }
      if (rHi - rLo < Math.abs(net(r)) + 2 * netThreshold) continue;
      const t0 = times[r.start];
      const t1 = times[r.end];
      const chord = (t: number): number =>
        t1 > t0 ? temps[r.start] + ((temps[r.end] - temps[r.start]) * (t - t0)) / (t1 - t0) : temps[r.start];
      let best = 0;
      for (let k = r.start + 1; k < r.end; k++) {
        const dev = Math.abs(temps[k] - chord(times[k]));
        if (dev > best && times[k] - t0 >= PHASE_MIN_SEC && t1 - times[k] >= PHASE_MIN_SEC) {
          best = dev;
          si = i;
          at = k;
        }
      }
    }
    if (si < 0) break;
    const r = runs[si];
    runs.splice(si, 1, { kind: r.kind, start: r.start, end: at }, { kind: r.kind, start: at, end: r.end });
    runs = settle(runs);
  }
  // A plateau wedged between two stretches of one kind is a pause in that stretch, not a phase of its
  // own: "drift-up, plateau for two seconds, drift-up" is one drift. Folding it joins its neighbours.
  for (;;) {
    let si = -1;
    for (let i = 1; i < runs.length - 1; i++) {
      if (runs[i].kind === 'plateau' && runs[i - 1].kind !== 'plateau' && runs[i - 1].kind === runs[i + 1].kind) {
        si = i;
        break;
      }
    }
    if (si < 0) break;
    runs = settle(fold(runs, si));
  }
  // Past PHASE_MAX, the stretch that changed least goes to its neighbours, and the labels are settled
  // again — a merged stretch's net change is its own, not either part's.
  while (runs.length > PHASE_MAX) {
    let si = 0;
    for (let i = 1; i < runs.length; i++) {
      const a = Math.abs(net(runs[i]));
      const b = Math.abs(net(runs[si]));
      if (a < b || (a === b && dur(runs[i]) < dur(runs[si]))) si = i;
    }
    runs = settle(fold(runs, si));
  }
  return runs.map((r) => ({
    kind: r.kind,
    tStart: times[r.start],
    tEnd: times[r.end],
    tempStart: round2(temps[r.start]),
    tempEnd: round2(temps[r.end]),
  }));
};

/** Ceiling on digest.events, so a busy clip cannot flood the prompt. */
const EVENT_CAP = 20;

/**
 * Merge every probe's turning points into one timeline, capped FAIRLY.
 *
 * The old "sort chronologically, keep the first 20" truncation dropped the END of the clip — the very
 * events ("levels off", the final peak) a write-up is built around — and let a busy probe's early
 * transitions crowd out another's late ones. The budget is now split per probe, and when a probe
 * overflows its share it keeps its earliest transitions AND its final one, so how the clip ended
 * survives for every series.
 */
const buildEventTimeline = (digests: ThermometerDigest[]): DigestEvent[] => {
  const withEvents = digests
    .map((d) => ({ d, events: phaseEvents(d.label, d.phases, d.maxAt, d.minAt) }))
    .filter((x) => x.events.length > 0);
  if (withEvents.length === 0) return [];
  const share = Math.max(2, Math.floor(EVENT_CAP / withEvents.length));
  return withEvents
    .flatMap(({ events }) =>
      events.length <= share ? events : [...events.slice(0, share - 1), events[events.length - 1]],
    )
    .sort((a, b) => a.t - b.t)
    .slice(0, EVENT_CAP);
};

/** Steepest local rate: the regression slope over ±RATE_WINDOW_SEC where the sampling is dense enough
 *  for one, the central difference (forward/backward at the ends) where it is not — the old grid's own
 *  measure, so a sparse series reads exactly as before. */
const peakRate = (
  times: number[],
  temps: number[],
  noiseC: number,
  phases: Phase[],
): { cPerSec: number; t: number } | null => {
  const n = Math.min(times.length, temps.length);
  if (n < 2) return null;
  const minChange = RATE_NOISE_K * (Number.isFinite(noiseC) && noiseC > 0 ? noiseC : 0);
  // Only where the probe was actually changing: the steepest instant of a plateau or a slow drift is
  // its steepest wobble, which is not a rate of anything. With no fast stretch at all there is no rate
  // to quote — the null tells the model so.
  const fast = phases.filter((p) => p.kind === 'rising' || p.kind === 'falling');
  if (phases.length > 0 && fast.length === 0) return null;
  const inFast = (t: number): boolean => fast.length === 0 || fast.some((p) => t >= p.tStart && t <= p.tEnd);
  let best: { cPerSec: number; t: number } | null = null;
  for (let i = 0; i < n; i++) {
    if (!inFast(times[i])) continue;
    let rate = windowedSlope(times, temps, i);
    // What the probe moved across the window the rate was read over — the regression's own line where
    // there was one, the two samples' difference where there was not. A rate whose window moved less
    // than the noise could is the noise.
    let change: number;
    if (rate != null) {
      const { lo, hi } = rateWindow(times, n, i);
      change = Math.abs(rate) * (times[hi] - times[lo]);
    } else {
      const lo = Math.max(0, i - 1);
      const hi = Math.min(n - 1, i + 1);
      const dt = times[hi] - times[lo];
      if (!(Math.abs(dt) > 1e-9)) continue;
      rate = (temps[hi] - temps[lo]) / dt;
      change = Math.abs(temps[hi] - temps[lo]);
    }
    if (!Number.isFinite(rate) || change < minChange) continue;
    if (!best || Math.abs(rate) > Math.abs(best.cPerSec)) best = { cPerSec: round3(rate), t: times[i] };
  }
  return best;
};

/**
 * Something arrived at or left this position: the largest single-interval jump, when it is both large in
 * absolute terms and most of the probe's whole excursion. Returned as the instant AFTER the jump (the
 * first sample of the new object) and the signed size. Null for a series that changed gradually, however
 * fast — a pour sampled every 0.2 s climbs in many small steps.
 */
export const arrivalStep = (times: number[], temps: number[]): { t: number; deltaC: number } | null => {
  const n = Math.min(times.length, temps.length);
  if (n < 2) return null;
  let lo = Infinity;
  let hi = -Infinity;
  let bi = -1;
  let bd = 0;
  for (let i = 0; i < n; i++) {
    const v = temps[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    if (i > 0 && Number.isFinite(temps[i - 1])) {
      const d = v - temps[i - 1];
      if (Math.abs(d) > Math.abs(bd)) {
        bd = d;
        bi = i;
      }
    }
  }
  if (bi < 0) return null;
  const span = hi - lo;
  if (Math.abs(bd) < STEP_MIN_C || Math.abs(bd) < STEP_SPAN_FRACTION * span) return null;
  return { t: times[bi], deltaC: round2(bd) };
};

/**
 * The best Newton fit of the series — over all of it, or over the tail from its extreme onward when the
 * series first had to reach that extreme (a hand arriving, a heater switched on: the Newton curve is what
 * follows, and a fit from t = 0 through the arrival is no exponential at all). A tail fit has to cover
 * FIT_MIN_SPAN_FRACTION of the span and run the way an extreme's tail must (cooling after a maximum,
 * heating after a minimum); among the candidates that pass FIT_MIN_R2, the best r² wins.
 */
const bestNewtonFit = (
  times: number[],
  temps: number[],
): { fit: NonNullable<ReturnType<typeof fitNewtonCooling>>; fromT: number } | null => {
  const n = Math.min(times.length, temps.length);
  if (n < MIN_FIT_POINTS) return null;
  const span = times[n - 1] - times[0];
  let iMax = 0;
  let iMin = 0;
  for (let i = 1; i < n; i++) {
    if (temps[i] > temps[iMax]) iMax = i;
    if (temps[i] < temps[iMin]) iMin = i;
  }
  const starts: { i: number; need: 'cooling' | 'heating' | null }[] = [{ i: 0, need: null }];
  if (iMax > 0) starts.push({ i: iMax, need: 'cooling' });
  if (iMin > 0) starts.push({ i: iMin, need: 'heating' });
  let best: { fit: NonNullable<ReturnType<typeof fitNewtonCooling>>; fromT: number } | null = null;
  for (const s of starts) {
    if (n - s.i < MIN_FIT_POINTS) continue;
    if (s.i > 0 && times[n - 1] - times[s.i] < FIT_MIN_SPAN_FRACTION * span) continue;
    const pts = forFit(times.slice(s.i), temps.slice(s.i));
    const fit = fitNewtonCooling(pts);
    if (!fit || fit.r2 < FIT_MIN_R2 || fit.n < MIN_FIT_POINTS) continue;
    if (s.need && fit.direction !== s.need) continue;
    // The data has to cover enough of a time constant to have pinned one: a 2 °C decline over two
    // minutes fits an exponential with tau = 15 min and an asymptote 9 °C below the room to r² = 0.94,
    // because over an eighth of a time constant every exponential is a straight line. And the shape
    // has to be an exponential's — steepest first — rather than an S-curve's: a half-cosine from peak
    // to trough also fits to r² > 0.9.
    const covered = (pts[pts.length - 1].t - pts[0].t) / fit.tau;
    if (!(covered >= FIT_MIN_TAU_COVERAGE)) continue;
    if (!steepestFirst(pts)) continue;
    if (!best || fit.r2 > best.fit.r2) best = { fit, fromT: times[s.i] };
  }
  return best;
};

/** An exponential approach is steepest at its start: the first third of the stretch moves at least as
 *  fast, on average, as the last third. A half-sine (slow, fast, slow) and a ramp that bends up fail. */
const steepestFirst = (pts: { t: number; T: number }[]): boolean => {
  const n = pts.length;
  if (n < 6) return true;
  const third = Math.floor(n / 3);
  const slopeOf = (part: { t: number; T: number }[]): number | null => {
    const fit = linearFit(part.map((p) => ({ x: p.t, y: p.T })));
    return fit && Number.isFinite(fit.slope) ? Math.abs(fit.slope) : null;
  };
  const first = slopeOf(pts.slice(0, third));
  const last = slopeOf(pts.slice(n - third));
  if (first == null || last == null) return true;
  return first >= last;
};

/** Points the Newton fit is given for a clip this long: one a second, at least MIN_FIT_POINTS, at most 120. */
const fitPointCount = (durationSec: number): number => Math.max(MIN_FIT_POINTS, Math.min(120, Math.round(durationSec)));

/**
 * The series the Newton fit sees: the samples as they are when there are no more of them than the
 * uniform one-a-second grid would hold (the old 25-point grid, a short clip), else that grid by linear
 * interpolation. A selection dense through the changes and sparse along the plateaus would otherwise
 * weight the fit — and its r², which decides whether it is shown at all — toward the dense stretches,
 * so the same curve passed or failed by how it happened to be sampled.
 */
const forFit = (times: number[], temps: number[]): { t: number; T: number }[] => {
  const n = Math.min(times.length, temps.length);
  const raw = times.slice(0, n).map((t, i) => ({ t, T: temps[i] }));
  if (n < 2) return raw;
  const target = fitPointCount(times[n - 1] - times[0]);
  if (n <= target) return raw;
  const out: { t: number; T: number }[] = [];
  let k = 0;
  for (let j = 0; j < target; j++) {
    const t = times[0] + ((times[n - 1] - times[0]) * j) / (target - 1);
    while (k < n - 2 && times[k + 1] < t) k++;
    const dt = times[k + 1] - times[k];
    const w = dt > 1e-9 ? Math.max(0, Math.min(1, (t - times[k]) / dt)) : 0;
    out.push({ t, T: temps[k] + (temps[k + 1] - temps[k]) * w });
  }
  return out;
};

const extremum = (times: number[], temps: number[], want: 'max' | 'min'): { t: number; tempC: number } | null => {
  const n = Math.min(times.length, temps.length);
  if (n === 0) return null;
  let bi = 0;
  for (let i = 1; i < n; i++) {
    const better = want === 'max' ? temps[i] > temps[bi] : temps[i] < temps[bi];
    if (better) bi = i;
  }
  return { t: times[bi], tempC: round2(temps[bi]) };
};

/** Fraction of a frame's pixels at or above `thresholdC`, as a percentage. */
const fractionAbove = (frame: DecodedFrame, thresholdC: number): number => {
  const n = frame.w * frame.h;
  let count = 0;
  for (let idx = 0; idx < n; idx++) if (celsiusAtIndex(frame, idx) >= thresholdC) count += 1;
  return n > 0 ? round2((count / n) * 100) : 0;
};

/**
 * Compute the derived analysis for one clip.
 *
 * `times` / `series` come straight from the summary (already truncation-filtered — a dropped frame is
 * absent from every array at once), and `frames` are the SAME kept frames, still decoded, so the spatial
 * statistics cost no extra download. Everything is null-safe: a clip with no probes, no profile lines or
 * a single usable frame yields an empty-but-valid digest rather than throwing into the report path.
 */
export const buildAnalysisDigest = (args: {
  times: number[];
  thermometers: SeriesInput[];
  frameGlobal: {
    t: number;
    min: number;
    max: number;
    mean: number;
    hotspot: { x: number; y: number };
    p02?: number;
    p98?: number;
  }[];
  frames: KeptFrame[];
  profileLines: ProfileLineLike[];
  sampling?: { requested: number; used: number; truncated: number; densifiedWindows: number };
  /**
   * What `times` counts: seconds into a clip (the default), or photo numbers of a photo set. On the photo
   * axis the frames are separate shots with no clock between them, so everything that reads the series
   * as a function of time — the Newton fit, the peak rate, the phases and the event timeline, the
   * hotspot's drift — is withheld rather than computed over an axis it would misdescribe. What survives
   * is per-photo: each probe's extreme readings and WHICH photo they were on, the warm-area fractions
   * and the transect gradients photo by photo.
   */
  axis?: AnalysisAxis;
}): AnalysisDigest => {
  const { times, thermometers, frameGlobal, frames, profileLines } = args;
  const photoAxis = args.axis === 'photo';

  const thermoDigests: ThermometerDigest[] = thermometers.map((t) => {
    const temps = t.series ?? [];
    const n = Math.min(times.length, temps.length);
    const tt = times.slice(0, n);
    const yy = temps.slice(0, n);
    const signal = photoAxis ? null : assessProbeSignal(yy);
    // Only an ACTIVE series earns a narrative. A static probe's "phases" would be sub-threshold wiggles,
    // and a noisy probe's peakRate is the steepest jitter — both would be quoted as physics. The raw
    // extremes stay (they are real readings); the trend machinery does not.
    const active = signal?.assessment === 'active';
    const noiseC = signal?.noiseC ?? 0;
    const phases = active ? segmentPhases(tt, yy, noiseC) : [];
    // Gated on quality inside bestNewtonFit: below FIT_MIN_R2 the exponential is not what the data does.
    const fit = active ? bestNewtonFit(tt, yy) : null;
    // The reading against the scene's floor at the same instants — only when every sample has its frame
    // percentiles alongside (the summary keeps the arrays aligned; a photo set has no floor to drift).
    let vsBackground: ThermometerDigest['vsBackground'] = null;
    if (!photoAxis && n >= 2 && frameGlobal.length >= n) {
      const first = frameGlobal[0].p02;
      const last = frameGlobal[n - 1].p02;
      if (
        typeof first === 'number' &&
        typeof last === 'number' &&
        Number.isFinite(yy[0]) &&
        Number.isFinite(yy[n - 1])
      ) {
        const startC = yy[0] - first;
        const endC = yy[n - 1] - last;
        vsBackground = { startC: round2(startC), endC: round2(endC), changeC: round2(endC - startC) };
      }
    }
    return {
      label: t.label,
      placedBy: t.placedBy ?? 'student',
      signal,
      newtonFit: fit
        ? {
            tau: round2(fit.fit.tau),
            tInf: round2(fit.fit.tInf),
            r2: round3(fit.fit.r2),
            direction: fit.fit.direction,
            nPoints: fit.fit.n,
            fromT: fit.fromT,
          }
        : null,
      maxAt: extremum(tt, yy, 'max'),
      minAt: extremum(tt, yy, 'min'),
      peakRate: active ? peakRate(tt, yy, noiseC, phases) : null,
      phases,
      step: photoAxis ? null : arrivalStep(tt, yy),
      vsBackground,
    };
  });

  // Where the hottest pixel sits at the start vs the end of the clip: a hotspot that stays put reads very
  // differently (a fixed heat source) from one that migrates (conduction along an object, a moving subject).
  let hotspotDrift: AnalysisDigest['clip']['hotspotDrift'] = null;
  if (!photoAxis && frameGlobal.length >= 2) {
    const a = frameGlobal[0];
    const b = frameGlobal[frameGlobal.length - 1];
    hotspotDrift = {
      fromT: a.t,
      toT: b.t,
      from: a.hotspot,
      to: b.hotspot,
      movedFraction: round3(Math.hypot(b.hotspot.x - a.hotspot.x, b.hotspot.y - a.hotspot.y)),
    };
  }

  // How much of the SCENE is warm, not just how hot the single hottest pixel is. The threshold is derived
  // from the clip's own range (midway between the coolest frame's minimum and the hottest frame's maximum)
  // so it adapts to a mug of tea and to a hand alike, and it is reported alongside every reading it
  // produced — a percentage without its threshold would be uninterpretable.
  let warmArea: AnalysisDigest['clip']['warmArea'] = null;
  if (frames.length > 0 && frameGlobal.length > 0) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const g of frameGlobal) {
      if (g.min < lo) lo = g.min;
      if (g.max > hi) hi = g.max;
    }
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi - lo > 1) {
      const thresholdC = round2(lo + (hi - lo) / 2);
      const picks = [0, Math.floor((frames.length - 1) / 2), frames.length - 1].filter(
        (v, i, arr) => arr.indexOf(v) === i,
      );
      warmArea = picks.map((i) => ({
        thresholdC,
        atT: frames[i].tSec,
        fractionPct: fractionAbove(frames[i].frame, thresholdC),
      }));
    }
  }

  // Per transect, the fitted spatial gradient at the start / middle / end of the clip. `lengthCm` is the
  // user's own calibration: with it the slope is a physical deg/cm, without it only deg/pixel.
  const PROFILE_SAMPLES = 120;
  const profileDigests: ProfileLineDigest[] = profileLines.map((line, li) => {
    const picks =
      frames.length === 0
        ? []
        : [0, Math.floor((frames.length - 1) / 2), frames.length - 1].filter((v, i, arr) => arr.indexOf(v) === i);
    const lengthCm = typeof line.lengthCm === 'number' && Number.isFinite(line.lengthCm) ? line.lengthCm : null;
    const gradients: ProfileLineDigest['gradients'] = [];
    for (const i of picks) {
      const kept = frames[i];
      const pts = sampleLineProfile(kept.frame, line, PROFILE_SAMPLES);
      const fit = linearFit(pts.map((p) => ({ x: p.pos, y: p.tempC })));
      if (!fit) continue;
      // The fit's slope is per unit of NORMALIZED position (0->1 across the whole transect), so dividing
      // by the transect's real length converts it into a gradient per centimetre (or per pixel).
      const denom = lengthCm ?? linePixelLength(line, kept.frame.w || IR_ARRAY_WIDTH, kept.frame.h || IR_ARRAY_HEIGHT);
      if (!(denom > 1e-9)) continue;
      gradients.push({
        t: kept.tSec,
        slope: round3(fit.slope / denom),
        unit: lengthCm ? 'C/cm' : 'C/px',
        r2: round3(fit.r2),
        // End-to-end temperature difference along the transect implied by the fit — the quantity a
        // student actually reads off ("one end is 12 C hotter than the other").
        deltaC: round2(fit.slope),
      });
    }
    return { name: line.name || `L${li + 1}`, lengthCm, gradients };
  });

  // The scene at its start, its hottest instant (by the robust p98, so one saturated pixel cannot pick
  // the frame) and its end. The warm-area fraction rides along where it was computed at the same instant.
  const scene: AnalysisDigest['scene'] = [];
  if (frameGlobal.length > 0) {
    let hottest = frameGlobal[0];
    for (const g of frameGlobal) if ((g.p98 ?? g.max) > (hottest.p98 ?? hottest.max)) hottest = g;
    const picks = [frameGlobal[0], hottest, frameGlobal[frameGlobal.length - 1]];
    const seen = new Set<number>();
    for (const g of picks) {
      if (seen.has(g.t)) continue;
      seen.add(g.t);
      const warm = warmArea?.find((w) => w.atT === g.t);
      scene.push({
        t: g.t,
        p02: round2(g.p02 ?? g.min),
        p98: round2(g.p98 ?? g.max),
        mean: round2(g.mean),
        warmPct: warm ? warm.fractionPct : null,
      });
    }
    scene.sort((a, b) => a.t - b.t);
  }

  return {
    version: DIGEST_VERSION,
    note: photoAxis
      ? 'Derived by the server from the photos listed in the summary. Every "t" here is a PHOTO NUMBER, not ' +
        'a time: the photos are separate shots, so no fit, rate, phase or event is computed — only per-photo ' +
        'quantities (which photo a probe read hottest or coldest on, warm-area fractions and transect ' +
        'gradients photo by photo).'
      : 'Derived by the server from the sampled frames listed in the summary — every fit and rate here is ' +
        'computed on those samples, not on the full-rate recording.',
    sampling: args.sampling ?? {
      requested: times.length,
      used: times.length,
      truncated: 0,
      densifiedWindows: 0,
    },
    events: buildEventTimeline(thermoDigests),
    thermometers: thermoDigests,
    clip: { hotspotDrift, warmArea },
    profileLines: profileDigests,
    scene,
  };
};

// ---------------------------------------------------------------------------
// The model's view of the summary.
//
// What the code analyses and what the model reads are two different things (app repo
// docs/proposals/ai-report-latency.md §3.E). The analysis grid is every sampled frame; the model gets each
// probe's series reduced to the points that carry its SHAPE — a flat control probe becomes three points, a
// cooling curve about fifteen, and nothing is spread over a clock the model then has to index into. The
// per-frame frameGlobal table and the storage-side sampleIndex are left out: the first is replaced by the
// digest's three-row scene block, the second was never the model's business. The verifier reads the same
// view, so a figure is legal only if the model could have seen it.
// ---------------------------------------------------------------------------

export interface ViewPoint {
  t: number;
  T: number;
}

/** Most points one probe's view may carry. An abnormality guard, not a budget: the tolerance decides the
 *  count, and a series only reaches this many points when it keeps oscillating for the whole clip. */
export const MODEL_VIEW_MAX_POINTS = 40;

/** The vertical tolerance a view may deviate from its series by: a tenth of a degree is sensor noise,
 *  one per cent of the excursion is invisible on any chart of it. */
export const modelViewTolerance = (temps: number[]): number => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of temps) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return Number.isFinite(hi - lo) ? Math.max(0.2, (hi - lo) * 0.01) : 0.2;
};

/** Ramer–Douglas–Peucker on one segment, by VERTICAL distance (the axes have different units, so a
 *  perpendicular distance would mean nothing). Returns the kept indices, endpoints included. */
const rdpIndices = (times: number[], temps: number[], lo: number, hi: number, tol: number, out: number[]): void => {
  if (hi - lo < 2) return;
  const t0 = times[lo];
  const t1 = times[hi];
  const y0 = temps[lo];
  const y1 = temps[hi];
  const dt = t1 - t0;
  let worst = -1;
  let worstDev = tol;
  for (let i = lo + 1; i < hi; i++) {
    const expected = dt > 0 ? y0 + ((times[i] - t0) / dt) * (y1 - y0) : y0;
    const dev = Math.abs(temps[i] - expected);
    if (dev > worstDev) {
      worstDev = dev;
      worst = i;
    }
  }
  if (worst < 0) return;
  rdpIndices(times, temps, lo, worst, tol, out);
  out.push(worst);
  rdpIndices(times, temps, worst, hi, tol, out);
};

/**
 * Reduce a series to the points that carry its shape: the first and last sample, every instant in
 * `keepTimes` (the digest's events, extremes and phase boundaries — the moments the report will cite),
 * and whatever Ramer–Douglas–Peucker needs between them to stay within `tolerance`. When that is still
 * more than `maxPoints`, the tolerance is widened by half until it fits; the kept instants always stay.
 */
export function reduceSeries(
  times: number[],
  temps: number[],
  opts: { keepTimes?: number[]; tolerance?: number; maxPoints?: number } = {},
): ViewPoint[] {
  const n = Math.min(times.length, temps.length);
  const valid: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(times[i]) && Number.isFinite(temps[i])) valid.push(i);
  if (valid.length === 0) return [];
  const tt = valid.map((i) => times[i]);
  const yy = valid.map((i) => temps[i]);
  const maxPoints = opts.maxPoints ?? MODEL_VIEW_MAX_POINTS;
  // Anchors: the ends, and the nearest sample to each instant the caller wants kept.
  const anchors = new Set<number>([0, tt.length - 1]);
  for (const kt of opts.keepTimes ?? []) {
    if (!Number.isFinite(kt)) continue;
    let best = 0;
    for (let i = 1; i < tt.length; i++) if (Math.abs(tt[i] - kt) < Math.abs(tt[best] - kt)) best = i;
    anchors.add(best);
  }
  const anchorList = Array.from(anchors).sort((a, b) => a - b);
  let tol = opts.tolerance ?? modelViewTolerance(yy);
  for (;;) {
    const kept = new Set<number>(anchorList);
    for (let k = 1; k < anchorList.length; k++) {
      const out: number[] = [];
      rdpIndices(tt, yy, anchorList[k - 1], anchorList[k], tol, out);
      for (const i of out) kept.add(i);
    }
    if (kept.size <= maxPoints || kept.size === anchorList.length) {
      return Array.from(kept)
        .sort((a, b) => a - b)
        .map((i) => ({ t: tt[i], T: round2(yy[i]) }));
    }
    tol *= 1.5;
  }
}

/** The instants the digest names for one probe — kept in its view so every cited moment has its reading. */
const digestKeepTimes = (digest: AnalysisDigest | null, label: string): number[] => {
  if (!digest) return [];
  const d = digest.thermometers.find((t) => t.label === label);
  const out: number[] = [];
  if (d) {
    if (d.maxAt) out.push(d.maxAt.t);
    if (d.minAt) out.push(d.minAt.t);
    if (d.peakRate) out.push(d.peakRate.t);
    for (const p of d.phases) out.push(p.tStart, p.tEnd);
  }
  for (const e of digest.events) if (e.thermometer === label) out.push(e.t);
  return out;
};

/** A probe as the summary builders write it; `series` is what the view replaces. */
interface ViewableProbe {
  label: string;
  series: number[];
  [key: string]: unknown;
}

/** The summary with each probe's series replaced by its shape points, and the tables the model never
 *  needed left out. Everything else (metadata, times, the probe statistics) passes through untouched. */
export function modelViewSummary<
  S extends { times: number[]; thermometers: ViewableProbe[]; aiProbes?: ViewableProbe[] },
>(
  summary: S,
  digest: AnalysisDigest | null,
): Omit<S, 'frameGlobal' | 'sampleIndex' | 'thermometers' | 'aiProbes'> & {
  thermometers: (Omit<ViewableProbe, 'series'> & { points: ViewPoint[] })[];
  aiProbes?: (Omit<ViewableProbe, 'series'> & { points: ViewPoint[] })[];
} {
  const view = (p: ViewableProbe) => {
    const { series, ...rest } = p;
    return {
      ...rest,
      points: reduceSeries(summary.times, series ?? [], { keepTimes: digestKeepTimes(digest, p.label) }),
    };
  };
  const {
    frameGlobal: _frameGlobal,
    sampleIndex: _sampleIndex,
    thermometers,
    aiProbes,
    ...rest
  } = summary as S & {
    frameGlobal?: unknown;
    sampleIndex?: unknown;
  };
  void _frameGlobal;
  void _sampleIndex;
  return {
    ...(rest as Omit<S, 'frameGlobal' | 'sampleIndex' | 'thermometers' | 'aiProbes'>),
    thermometers: (thermometers ?? []).map(view),
    ...(aiProbes ? { aiProbes: aiProbes.map(view) } : {}),
  };
}

/** Re-export so callers can build a digest from frames they decoded themselves without a second import. */
export { frameStats };
export type { FrameStats };

// ---------------------------------------------------------------------------
// Adaptive sampling.
//
// A fixed 25 evenly-spread frames is a cost decision, not a measurement one: on a clip where nothing
// happens for two minutes and then everything happens in four seconds, twenty-four of those frames
// describe the nothing. The transient — the very thing the report should be about — falls between two
// samples and is invisible.
//
// So the first pass is used to find where the action is, and a second pass reads more frames THERE.
// ---------------------------------------------------------------------------

/** How much faster than the clip's typical rate an interval must move to be worth a closer look. */
const DENSIFY_RATE_FACTOR = 3;
/** …and it must also cover this fraction of the whole excursion, so noise on a flat series never
 *  qualifies just because the median rate is near zero. */
const DENSIFY_MIN_FRACTION = 0.05;
/** At most this many windows, and this many extra frames in each — the budget is a handful of extra
 *  Storage reads, not a re-read of the clip. */
export const DENSIFY_MAX_WINDOWS = 2;
export const DENSIFY_FRAMES_PER_WINDOW = 15;

/** An interval of the clip worth sampling more densely, in the caller's own index space. */
export interface DensifyWindow {
  fromIndex: number;
  toIndex: number;
  tStart: number;
  tEnd: number;
  changeC: number;
}

/**
 * Find the intervals where the measurements move fastest.
 *
 * `values[i]` is the quantity being watched at `times[i]` — the probe with the largest excursion when
 * there is one, otherwise the whole-frame mean. `indices[i]` is that sample's position in whatever index
 * space the caller will densify (recording frames, or .vir frame numbers).
 */
export function planDensification(
  times: number[],
  values: number[],
  indices: number[],
  maxWindows = DENSIFY_MAX_WINDOWS,
): DensifyWindow[] {
  const n = Math.min(times.length, values.length, indices.length);
  if (n < 4) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (values[i] < lo) lo = values[i];
    if (values[i] > hi) hi = values[i];
  }
  const span = hi - lo;
  if (!(span > 1e-6)) return [];

  const rates: number[] = [];
  for (let i = 1; i < n; i++) {
    const dt = times[i] - times[i - 1];
    rates.push(dt > 1e-9 ? Math.abs(values[i] - values[i - 1]) / dt : 0);
  }
  const sorted = [...rates].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const threshold = median * DENSIFY_RATE_FACTOR;

  const windows: DensifyWindow[] = [];
  for (let i = 1; i < n; i++) {
    const change = Math.abs(values[i] - values[i - 1]);
    // Both tests must pass: fast RELATIVE to this clip, and large enough to be a real move. On a
    // perfectly flat series the median is ~0, so the rate test alone would flag pure noise.
    if (rates[i - 1] <= threshold || change < span * DENSIFY_MIN_FRACTION) continue;
    const last = windows[windows.length - 1];
    if (last && last.toIndex === indices[i - 1]) {
      // Adjacent fast intervals are one event, not two.
      last.toIndex = indices[i];
      last.tEnd = times[i];
      last.changeC = Number((last.changeC + change).toFixed(2));
    } else {
      windows.push({
        fromIndex: indices[i - 1],
        toIndex: indices[i],
        tStart: times[i - 1],
        tEnd: times[i],
        changeC: Number(change.toFixed(2)),
      });
    }
  }
  return windows.sort((a, b) => b.changeC - a.changeC).slice(0, maxWindows);
}

/** The extra index positions to read inside a window, excluding the two ends the caller already has. */
export function densifyIndices(w: DensifyWindow, perWindow = DENSIFY_FRAMES_PER_WINDOW): number[] {
  const gap = w.toIndex - w.fromIndex;
  if (gap <= 1) return [];
  const count = Math.min(perWindow, gap - 1);
  const out: number[] = [];
  for (let i = 1; i <= count; i++) {
    const idx = w.fromIndex + Math.round((i * gap) / (count + 1));
    if (idx > w.fromIndex && idx < w.toIndex && !out.includes(idx)) out.push(idx);
  }
  return out;
}

/**
 * The series a densification plan should watch: the most ACTIVE probe, else a whole-frame series.
 *
 * Two lessons are encoded here. A probe only qualifies when its excursion clears the noise floor — the
 * old widest-span-wins contest could be captured by a background probe whose 0.05 °C jitter beat the
 * fallback, spending the whole densification budget on noise. And the fallback itself prefers p98 over
 * the mean: a small hot object barely moves the average of 19,200 pixels (2% of the frame rising 30 °C
 * shifts the mean 0.6 °C) but moves the robust hot bound directly, without the single-pixel fragility
 * of the raw max.
 */
export function densifySignal(thermometers: SeriesInput[], frameGlobal: { mean: number; p98?: number }[]): number[] {
  let best: number[] | null = null;
  let bestSpan = 0;
  for (const t of thermometers) {
    const s = t.series ?? [];
    if (s.length < 2) continue;
    const signal = assessProbeSignal(s);
    if (signal.assessment !== 'active') continue;
    if (signal.spanC > bestSpan) {
      bestSpan = signal.spanC;
      best = s;
    }
  }
  return best ?? frameGlobal.map((g) => g.p98 ?? g.mean);
}

// ---------------------------------------------------------------------------
// Number verification.
//
// A hallucinated temperature in a lab report is the worst failure this feature has: it is persisted with
// a model badge, shown to every viewer as machine-generated fact, and fed back in as context for later
// questions. This pass cross-checks every figure the report cites against the numbers it was given.
//
// It is a TRUST SIGNAL, not a proof. It can only say "this value does not appear in the data" — which is
// exactly the class of error worth catching, and is why the wording everywhere is "cross-checked" rather
// than "verified".
// ---------------------------------------------------------------------------

/** One figure the report states, as extracted from its prose. */
export interface CitedValue {
  value: number;
  kind: 'temperature' | 'time' | 'rate';
  text: string; // the matched snippet, for showing the reader what was not found
}

export interface VerificationResult {
  checked: number;
  matched: number;
  unmatched: CitedValue[];
}

/**
 * Pull the quantities a report states, with their units.
 *
 * Rate patterns come FIRST in the alternation on purpose: "0.5 °C/s" must be read as one rate, not as a
 * temperature of 0.5 °C followed by stray text. Unit-less numbers are deliberately not extracted — a
 * count of frames or a section number is not a measurement claim, and treating it as one would drown the
 * real signal in false positives.
 */
const CITATION_SCAN =
  /(-?\d+(?:\.\d+)?)\s*(?:°\s*C|℃|degC)\s*\/\s*(s\b|sec\b|second\b|cm\b|px\b|pixel\b)|(-?\d+(?:\.\d+)?)\s*(?:°\s*C|℃|degrees?\s+C(?:elsius)?\b)|(-?\d+(?:\.\d+)?)\s*(?:seconds?\b|secs?\b|s\b)/gi;

export const extractCitedValues = (report: string): CitedValue[] => {
  const out: CitedValue[] = [];
  for (const m of report.matchAll(CITATION_SCAN)) {
    const [text, rate, , temp, time] = m;
    if (rate !== undefined) out.push({ value: Number(rate), kind: 'rate', text: text.trim() });
    else if (temp !== undefined) out.push({ value: Number(temp), kind: 'temperature', text: text.trim() });
    else if (time !== undefined) out.push({ value: Number(time), kind: 'time', text: text.trim() });
  }
  return out;
};

/** Sorted unique finite values, to 3 dp. */
const sortedUnique = (values: number[]): number[] =>
  Array.from(new Set(values.filter((v) => Number.isFinite(v)).map((v) => Number(v.toFixed(3))))).sort((a, b) => a - b);

/**
 * The differences a report may legitimately state, enumerated by STRUCTURE rather than taken pairwise.
 *
 * The old rule — every pairwise difference of every legal value — was the verifier's quiet failure: a few
 * hundred base values make tens of thousands of differences, which on any clip with a decent span carpet
 * the whole range at a 0.15 °C pitch, so an invented temperature inside the range always "matched". What a
 * report actually subtracts is small and nameable: a probe's change from start to end, its excursion,
 * a phase's rise or fall, the step between two consecutive events, how far a probe sits from its
 * asymptote, how far two probes sit apart at the same instant, how wide the scene's bounds are — and, on
 * the time axis, how long a phase lasted, the gap between two events, the span of the clip.
 */
const structuredDifferences = (
  summary: VerifiableSummary,
  digest: AnalysisDigest | null,
): { temps: number[]; times: number[] } => {
  const temps: number[] = [];
  const times: number[] = [];
  const probes = [...(summary.thermometers ?? []), ...(summary.aiProbes ?? [])];
  for (const p of probes) {
    if (p.startTemp != null && p.endTemp != null) temps.push(Math.abs(p.endTemp - p.startTemp));
    if (p.min != null && p.max != null) temps.push(p.max - p.min);
    if (p.changeC != null) temps.push(Math.abs(p.changeC));
  }
  // Two probes compared at the same instant — "T1 sits 12 °C above T2 at t = 48 s".
  const n = summary.times?.length ?? 0;
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < probes.length; a++) {
      const va = probes[a].series?.[i];
      if (typeof va !== 'number') continue;
      for (let b = a + 1; b < probes.length; b++) {
        const vb = probes[b].series?.[i];
        if (typeof vb === 'number') temps.push(Math.abs(va - vb));
      }
    }
  }
  if (n >= 2) times.push(summary.times[n - 1] - summary.times[0]);
  if (!digest) return { temps, times };
  for (const d of digest.thermometers ?? []) {
    const p = probes.find((x) => (x as { label?: string }).label === d.label);
    for (const ph of d.phases ?? []) {
      temps.push(Math.abs(ph.tempEnd - ph.tempStart));
      times.push(ph.tEnd - ph.tStart);
    }
    if (d.newtonFit) {
      for (const v of [p?.startTemp, p?.endTemp, d.maxAt?.tempC, d.minAt?.tempC]) {
        if (v != null) temps.push(Math.abs(v - d.newtonFit.tInf));
      }
    }
    if (d.maxAt && d.minAt) {
      temps.push(Math.abs(d.maxAt.tempC - d.minAt.tempC));
      times.push(Math.abs(d.maxAt.t - d.minAt.t));
    }
  }
  const events = [...(digest.events ?? [])].sort((a, b) => a.t - b.t);
  for (let i = 1; i < events.length; i++) {
    times.push(events[i].t - events[i - 1].t);
    if (events[i].thermometer === events[i - 1].thermometer)
      temps.push(Math.abs(events[i].tempC - events[i - 1].tempC));
  }
  for (const s of digest.scene ?? []) {
    temps.push(s.p98 - s.p02, s.p98 - s.mean, s.mean - s.p02);
  }
  for (const w of digest.clip?.warmArea ?? [])
    for (const s of digest.scene ?? []) temps.push(Math.abs(s.p98 - w.thresholdC));
  return { temps, times };
};

/** Is `v` within `tol` of any member of the sorted list? Binary search for the insertion point, then
 *  check its two neighbours — the only candidates that can be within tolerance. */
const nearAny = (sorted: number[], v: number, tol: number): boolean => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  for (const i of [lo - 1, lo]) {
    if (i >= 0 && i < sorted.length && Math.abs(sorted[i] - v) <= tol) return true;
  }
  return false;
};

/** Readings round to 2 dp, and a model may round once more when writing prose. */
const TEMP_TOLERANCE = 0.15;
/** Times are stamped to 2 dp; a report that writes "t = 48 s" for 48.2 s is not wrong. */
const TIME_TOLERANCE = 0.55;
/** Rates and gradients are derived, so allow relative slack with a floor for near-zero values. */
const RATE_REL_TOLERANCE = 0.05;
const RATE_ABS_FLOOR = 0.02;

/** One probe's stats as the verifier reads them — user probes and AI virtual probes share the shape. */
interface VerifiableProbe {
  /** Needed to pair the probe with its digest entry (for the instants its view must keep). */
  label?: string;
  series: number[];
  min: number | null;
  max: number | null;
  startTemp: number | null;
  endTemp: number | null;
  changeC: number | null;
  secantCPerSec: number | null;
}

/** The summary fields the verifier reads. Structural only — it never needs the metadata half. */
export interface VerifiableSummary {
  times: number[];
  thermometers: VerifiableProbe[];
  /** Virtual probes the analysis placed itself (AI1..). Their readings are as legal to cite as any. */
  aiProbes?: VerifiableProbe[];
  frameGlobal: { t: number; min: number; max: number; mean: number; p02?: number; p98?: number }[];
  /** A photo set's catalogue: the seconds between shots are the only real times such a report can
   *  cite ("photo 3 was taken 90 s after photo 1"), and they live nowhere else in the summary. */
  photos?: { sinceFirstSec: number | null }[];
  /** Camera moves and shutter steps in seconds (the recording summary's `camera`): the instants a
   *  report cites when it says the camera moved or recalibrated. */
  camera?: {
    poses: { fromSec: number; toSec: number }[];
    moves: { fromSec: number; toSec: number; shiftBlocks: number }[];
    nuc: number[];
  } | null;
}

/** Numbers a deep-mode tool handed the model mid-generation. The prompt tells it those results are
 *  "data of the same standing as the JSON", so the verifier must honour that — a windowed re-fit's tau
 *  is as legal to cite as the digest's, and flagging it would trigger a correction pass that deletes a
 *  correct conclusion. */
export interface ExtraLegalValues {
  temps?: number[];
  times?: number[];
  rates?: number[];
}

/**
 * Cross-check every figure a report cites against the data the model was SHOWN.
 *
 * Legal sources are enumerated explicitly rather than "anything numeric in the JSON": each probe's view
 * points (the reduced series the model reads — modelViewSummary) and its summary statistics, the time
 * axis, every quantity the derived analysis produced, and — in deep mode — every number a tool returned
 * to the model. Differences are the structured ones only (structuredDifferences). On the photo axis the
 * model is still handed the whole summary, frameGlobal included, so that stays legal there.
 */
export function verifyReportNumbers(
  report: string,
  summary: VerifiableSummary,
  digest: AnalysisDigest | null,
  extra?: ExtraLegalValues,
  opts: { axis?: AnalysisAxis } = {},
): VerificationResult {
  const temps: number[] = [...(extra?.temps ?? [])];
  const times: number[] = [...(extra?.times ?? [])];
  const rates: number[] = [...(extra?.rates ?? [])];
  const photoAxis = opts.axis === 'photo';

  for (const t of [...(summary.thermometers ?? []), ...(summary.aiProbes ?? [])]) {
    if (photoAxis) {
      for (const v of t.series ?? []) temps.push(v);
    } else {
      // Only the readings the model could see: the same reduction, with the same kept instants.
      for (const p of reduceSeries(summary.times ?? [], t.series ?? [], {
        keepTimes: digestKeepTimes(digest, t.label ?? ''),
      })) {
        temps.push(p.T);
        times.push(p.t);
      }
    }
    for (const v of [t.min, t.max, t.startTemp, t.endTemp, t.changeC]) if (v != null) temps.push(v);
    if (t.secantCPerSec != null) rates.push(t.secantCPerSec);
  }
  if (photoAxis) {
    for (const g of summary.frameGlobal ?? []) {
      times.push(g.t);
      temps.push(g.min, g.max, g.mean);
      if (g.p02 != null) temps.push(g.p02);
      if (g.p98 != null) temps.push(g.p98);
    }
  }
  for (const t of summary.times ?? []) times.push(t);
  for (const p of summary.photos ?? []) if (p.sinceFirstSec != null) times.push(p.sinceFirstSec);
  if (summary.camera) {
    for (const m of summary.camera.moves) times.push(m.fromSec, m.toSec, m.toSec - m.fromSec);
    for (const p of summary.camera.poses) times.push(p.fromSec, p.toSec, p.toSec - p.fromSec);
    for (const t of summary.camera.nuc) times.push(t);
  }

  if (digest) {
    for (const d of digest.thermometers ?? []) {
      if (d.newtonFit) {
        // tau is a duration, so it is checked against the time axis; the asymptote is a temperature.
        // Its small multiples are legal too: "within a few per cent of the final temperature by 3*tau"
        // is the standard way to read a time constant, and the report prompt explicitly asks for it —
        // a verifier that cannot represent a product would flag the very sentence it requested.
        times.push(d.newtonFit.tau, 2 * d.newtonFit.tau, 3 * d.newtonFit.tau, 5 * d.newtonFit.tau);
        temps.push(d.newtonFit.tInf);
        if (typeof d.newtonFit.fromT === 'number') times.push(d.newtonFit.fromT);
      }
      if (d.step) {
        times.push(d.step.t);
        temps.push(Math.abs(d.step.deltaC));
      }
      if (d.vsBackground) {
        temps.push(d.vsBackground.startC, d.vsBackground.endC, Math.abs(d.vsBackground.changeC));
      }
      if (d.maxAt) {
        times.push(d.maxAt.t);
        temps.push(d.maxAt.tempC);
      }
      if (d.minAt) {
        times.push(d.minAt.t);
        temps.push(d.minAt.tempC);
      }
      if (d.peakRate) {
        rates.push(d.peakRate.cPerSec);
        times.push(d.peakRate.t);
      }
      for (const p of d.phases ?? []) {
        times.push(p.tStart, p.tEnd);
        temps.push(p.tempStart, p.tempEnd);
      }
    }
    if (digest.clip?.hotspotDrift) times.push(digest.clip.hotspotDrift.fromT, digest.clip.hotspotDrift.toT);
    for (const w of digest.clip?.warmArea ?? []) {
      temps.push(w.thresholdC);
      times.push(w.atT);
    }
    for (const l of digest.profileLines ?? []) {
      for (const g of l.gradients ?? []) {
        rates.push(g.slope);
        temps.push(g.deltaC);
        times.push(g.t);
      }
    }
    for (const s of digest.scene ?? []) {
      times.push(s.t);
      temps.push(s.p02, s.p98, s.mean);
    }
  }

  const diffs = structuredDifferences(summary, digest);
  const legalTemps = sortedUnique([...temps, ...diffs.temps]);
  const legalTimes = sortedUnique([...times, ...diffs.times]);
  // Rates are compared as magnitudes on both sides. The data stores a signed rate (-0.667 °C/s for a
  // probe that is cooling), but prose carries the direction in the verb — "cools at 0.667 °C/s" — and
  // flagging that as unsupported would be a false positive on the most natural way to write it.
  const legalRates = sortedUnique(rates.map(Math.abs));

  // The time axis has a real resolution, and it is not uniform: a densified window sits 0.2 s apart,
  // a plateau seconds apart. A report naming an instant between two samples is reading the data at its
  // local resolution, so the tolerance is half the spacing AROUND the cited instant — never the median
  // of the whole clip, which let a coarse plateau excuse an invented time inside a dense window.
  const axis = sortedUnique(summary.times ?? []);
  const timeToleranceAt = (v: number): number => {
    if (axis.length < 2) return TIME_TOLERANCE;
    // The gap the cited instant falls in (the end gaps for an instant beyond either end).
    let k = 0;
    while (k + 2 < axis.length && axis[k + 1] <= v) k++;
    return Math.max(TIME_TOLERANCE, (axis[k + 1] - axis[k]) / 2);
  };

  const cited = extractCitedValues(report);
  const unmatched: CitedValue[] = [];
  for (const c of cited) {
    const ok =
      c.kind === 'temperature'
        ? nearAny(legalTemps, c.value, TEMP_TOLERANCE)
        : c.kind === 'time'
          ? nearAny(legalTimes, c.value, timeToleranceAt(c.value))
          : nearAny(legalRates, Math.abs(c.value), Math.max(RATE_ABS_FLOOR, Math.abs(c.value) * RATE_REL_TOLERANCE));
    if (!ok) unmatched.push(c);
  }
  return { checked: cited.length, matched: cited.length - unmatched.length, unmatched };
}

// ---------------------------------------------------------------------------
// Cache key.
// ---------------------------------------------------------------------------

/**
 * Version of the SUMMARY + DIGEST computation, folded into the cache key.
 *
 * Bump this in the same commit as ANY change to what the summary builders or buildAnalysisDigest
 * produce. Without it a cached entry stays valid forever after such a change — the experiment's geometry
 * has not moved, so nothing else in the key differs, and every reader keeps being served numbers computed
 * by the old code.
 */
export const ANALYSIS_ALGO_VERSION = 2; // v2: AI-suggested virtual probes ride in the summary

/** The doc fields that decide what the numbers come out as. Loose on purpose: the caller passes a raw
 *  Firestore document, and a missing field must hash the same way every time rather than throw. */
export interface AnalysisInputsDoc {
  sourceType?: unknown;
  recordingId?: unknown;
  name?: unknown;
  duration?: unknown;
  segments?: unknown;
  profileLines?: unknown;
  // Photo set only. The numbers are stamped by the photo's place in the viewing order, so the order is
  // an input; which photos carry temperatures decides which are decoded at all.
  photoCount?: unknown;
  photoOrder?: unknown;
  photoThermal?: unknown;
}

/**
 * The photo-set fields that go into the cache key and the freshness descriptor — ONLY for a photo set,
 * so a recording's hash and descriptor stay byte-identical to what every saved report already carries
 * (a new key on those would mark every current report outdated and throw away every cached decode).
 * The order is stored normalized, so an order the owner never touched and one written as the identity
 * describe the same numbers the same way.
 */
const photoSetInputs = (exp: AnalysisInputsDoc): { photoCount: number; photoOrder: number[] } | null => {
  if (exp.sourceType !== 'photos') return null;
  const photoCount = Math.max(0, Math.floor(Number(exp.photoCount) || 0));
  return { photoCount, photoOrder: normalizePhotoOrder(exp.photoOrder, photoCount) };
};

/**
 * Fingerprint of the inputs that determine the NUMBERS: the medium, the trim, the probe geometry, the
 * transects, how many frames are sampled, and the algorithm version.
 *
 * Deliberately excludes everything cosmetic — probe names, annotation notes, key-moment captions, the
 * description — because those are merged in live at read time. Hashing them would throw away a cached
 * 25-frame decode because someone fixed a typo, and (worse, in the other direction) a cache that DID
 * store them would keep serving a probe's old name for as long as its position stayed put.
 *
 * Probe order is part of the key rather than sorted away: the order IS the T1..Tn labelling, so two
 * experiments with the same probes in a different order genuinely have different summaries.
 */
/**
 * A description of the thermal inputs a report was written from, for telling the reader when the
 * experiment has moved on since.
 *
 * Deliberately NOT the cache hash, and deliberately without the probes. The cache key covers everything
 * that changes the numbers, including probe geometry, because it is only ever compared server-side
 * against itself. This descriptor is compared by the BROWSER against what it can see, and the browser
 * cannot see the same probe set the server does: the thermometers subcollection is read through a
 * rules-shaped query (own docs, or public/unlisted ones), so any probe document the viewer is not
 * allowed to read would make the two sides disagree forever and pin an "outdated" badge on a report that
 * is perfectly current. Every field here is read verbatim from the SAME experiment document on both
 * sides, so a mismatch always means a real change.
 *
 * The consequence is stated plainly in the UI: this catches re-trimming and transect edits, not a probe
 * that was nudged. The saved date is shown alongside for the judgement calls it cannot make.
 */
export interface ReportInputsDescriptor {
  v: number;
  samples: number;
  source: string | null;
  recordingId: string | null;
  name: string | null;
  duration: number;
  // Arrays of OBJECTS, not the tuples the hash payload uses. Firestore cannot store an array whose
  // elements are themselves arrays, and this descriptor is persisted on the experiment document — a
  // tuple form here makes the whole write throw, losing a report the model has already been paid for.
  segments: { start: number; end: number }[];
  profileLines: { x1: number; y1: number; x2: number; y2: number; lengthCm: number | null }[];
  // Photo set only (absent otherwise, so older descriptors still compare equal). A report names its
  // photos by their place in the viewing order, so reordering the strip makes "photo 2" another photo.
  photoCount?: number;
  photoOrder?: number[];
}

export function reportInputsDescriptor(exp: AnalysisInputsDoc, frameSamples: number): ReportInputsDescriptor {
  const segments = Array.isArray(exp.segments) ? (exp.segments as { start: number; end: number }[]) : [];
  const lines = Array.isArray(exp.profileLines) ? (exp.profileLines as ProfileLineLike[]) : [];
  const photos = photoSetInputs(exp);
  return {
    v: ANALYSIS_ALGO_VERSION,
    samples: frameSamples,
    source: typeof exp.sourceType === 'string' ? exp.sourceType : null,
    recordingId: typeof exp.recordingId === 'string' ? exp.recordingId : null,
    name: typeof exp.name === 'string' ? exp.name : null,
    duration: Number(exp.duration) || 0,
    segments: segments.map((s) => ({ start: s.start, end: s.end })),
    profileLines: lines.map((l) => ({ x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, lengthCm: l.lengthCm ?? null })),
    ...(photos ? { photoCount: photos.photoCount, photoOrder: photos.photoOrder } : {}),
  };
}

export function analysisInputsHash(
  exp: AnalysisInputsDoc,
  thermometers: {
    x: number;
    y: number;
    measuringAreaType?: string;
    measuringAreaWidth?: number;
    measuringAreaHeight?: number;
  }[],
  frameSamples: number,
): string {
  const segments = Array.isArray(exp.segments) ? (exp.segments as { start: number; end: number }[]) : [];
  const lines = Array.isArray(exp.profileLines) ? (exp.profileLines as ProfileLineLike[]) : [];
  const photos = photoSetInputs(exp);
  const payload = {
    v: ANALYSIS_ALGO_VERSION,
    digest: DIGEST_VERSION,
    samples: frameSamples,
    source: exp.sourceType ?? null,
    recordingId: exp.recordingId ?? null,
    name: exp.name ?? null,
    duration: Number(exp.duration) || 0,
    segments: segments.map((s) => [s.start, s.end]),
    thermometers: thermometers.map((t) => [
      t.x,
      t.y,
      t.measuringAreaType ?? null,
      t.measuringAreaWidth ?? null,
      t.measuringAreaHeight ?? null,
    ]),
    profileLines: lines.map((l) => [l.x1, l.y1, l.x2, l.y2, l.lengthCm ?? null]),
    ...(photos
      ? {
          photoCount: photos.photoCount,
          photoOrder: photos.photoOrder,
          photoThermal: Array.isArray(exp.photoThermal) ? exp.photoThermal.map((v) => v !== false) : null,
        }
      : {}),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}
