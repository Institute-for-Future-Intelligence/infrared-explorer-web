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
/** A position must swing at least this much over the clip to be worth suggesting. */
const SUGGEST_MIN_RANGE_C = 1.5;
/** Hotspot drift beyond this fraction of the image means the subject moved — range maps to edges. */
const SUGGEST_MAX_DRIFT = 0.25;

export function suggestProbePositions(
  frames: KeptFrame[],
  frameGlobal: { hotspot: { x: number; y: number } }[],
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
  const lo = new Float32Array(n).fill(Infinity);
  const hi = new Float32Array(n).fill(-Infinity);
  for (const kept of frames) {
    if (kept.frame.w !== w || kept.frame.h !== h) continue;
    for (let i = 0; i < n; i++) {
      const c = celsiusAtIndex(kept.frame, i);
      if (c < lo[i]) lo[i] = c;
      if (c > hi[i]) hi[i] = c;
    }
  }

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
  for (let pick = 0; pick < k; pick++) {
    let bestIdx = -1;
    let bestVal = SUGGEST_MIN_RANGE_C;
    for (let i = 0; i < n; i++) {
      if (range[i] <= bestVal) continue;
      const px = ((i % w) + 0.5) / w;
      const py = (Math.floor(i / w) + 0.5) / h;
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
    taken.push({ x, y });
    out.push({ x, y, rangeC: round2(range[bestIdx]) });
  }
  return out;
}

export interface Phase {
  kind: 'rising' | 'falling' | 'plateau';
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
   *  narrating a static or noise-dominated series as physical turning points is worse than silence. */
  signal: ProbeSignal;
  /** Fitted Newton cooling/heating law, or null. Null MUST be read as "no exponential behaviour shown". */
  newtonFit: { tau: number; tInf: number; r2: number; direction: 'cooling' | 'heating'; nPoints: number } | null;
  maxAt: { t: number; tempC: number } | null;
  minAt: { t: number; tempC: number } | null;
  /** Steepest local rate over the sampled series (central differences), signed, with its instant. */
  peakRate: { cPerSec: number; t: number } | null;
  phases: Phase[];
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
}

/** Digest computation version. Bump on ANY change to what the functions below produce (the derived-cache
 *  key folds this in, so old cached digests are recomputed rather than served forever).
 *  v2: adaptive densification, the event timeline and the sampling record.
 *  v3: per-probe signal assessment with noise gating, placedBy, and AI-suggested virtual probes. */
export const DIGEST_VERSION = 3;

/**
 * Turn each probe's phase segmentation into named moments.
 *
 * A phase list says what the curve did; an event says WHEN it changed and to what — which is what a
 * chronological write-up is built from, and what a "jump to this moment" affordance would need.
 */
const phaseEvents = (label: string, phases: Phase[]): DigestEvent[] => {
  const out: DigestEvent[] = [];
  for (let i = 1; i < phases.length; i++) {
    const prev = phases[i - 1];
    const next = phases[i];
    const kind: DigestEvent['kind'] =
      next.kind === 'plateau'
        ? 'steady'
        : prev.kind === 'rising' && next.kind === 'falling'
          ? 'peak'
          : prev.kind === 'falling' && next.kind === 'rising'
            ? 'trough'
            : 'onset';
    out.push({
      t: next.tStart,
      kind,
      thermometer: label,
      tempC: next.tempStart,
      detail:
        kind === 'steady'
          ? `${label} levels off near ${next.tempEnd} °C`
          : kind === 'peak'
            ? `${label} peaks and begins to fall`
            : kind === 'trough'
              ? `${label} bottoms out and begins to rise`
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
 * Classify the series into rising / falling / plateau phases.
 *
 * A phase boundary is a genuine change of behaviour, not sampling noise, so the per-interval slope is
 * measured against the series' own span: an interval moving less than PLATEAU_FRACTION of the total
 * excursion counts as flat. Runs are then merged, and a single-interval blip is absorbed into its
 * neighbour so a 25-point series doesn't come back as eleven "phases".
 */
const PLATEAU_FRACTION = 0.05;

const segmentPhases = (times: number[], temps: number[]): Phase[] => {
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
  const threshold = span * PLATEAU_FRACTION;

  const kinds: Phase['kind'][] = [];
  for (let i = 1; i < n; i++) {
    const d = temps[i] - temps[i - 1];
    kinds.push(Math.abs(d) < threshold ? 'plateau' : d > 0 ? 'rising' : 'falling');
  }
  // Absorb one-interval blips into the surrounding run so the phase list stays readable.
  for (let i = 1; i < kinds.length - 1; i++) {
    if (kinds[i] !== kinds[i - 1] && kinds[i - 1] === kinds[i + 1]) kinds[i] = kinds[i - 1];
  }

  const phases: Phase[] = [];
  let start = 0;
  for (let i = 1; i <= kinds.length; i++) {
    if (i === kinds.length || kinds[i] !== kinds[start]) {
      phases.push({
        kind: kinds[start],
        tStart: times[start],
        tEnd: times[i],
        tempStart: round2(temps[start]),
        tempEnd: round2(temps[i]),
      });
      start = i;
    }
  }
  return phases;
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
    .map((d) => ({ d, events: phaseEvents(d.label, d.phases) }))
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

/** Steepest local rate via central differences (forward/backward at the ends). */
const peakRate = (times: number[], temps: number[]): { cPerSec: number; t: number } | null => {
  const n = Math.min(times.length, temps.length);
  if (n < 2) return null;
  let best: { cPerSec: number; t: number } | null = null;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(n - 1, i + 1);
    const dt = times[hi] - times[lo];
    if (!(Math.abs(dt) > 1e-9)) continue;
    const rate = (temps[hi] - temps[lo]) / dt;
    if (!Number.isFinite(rate)) continue;
    if (!best || Math.abs(rate) > Math.abs(best.cPerSec)) best = { cPerSec: round3(rate), t: times[i] };
  }
  return best;
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
  frameGlobal: { t: number; min: number; max: number; mean: number; hotspot: { x: number; y: number } }[];
  frames: KeptFrame[];
  profileLines: ProfileLineLike[];
  sampling?: { requested: number; used: number; truncated: number; densifiedWindows: number };
}): AnalysisDigest => {
  const { times, thermometers, frameGlobal, frames, profileLines } = args;

  const thermoDigests: ThermometerDigest[] = thermometers.map((t) => {
    const temps = t.series ?? [];
    const n = Math.min(times.length, temps.length);
    const tt = times.slice(0, n);
    const yy = temps.slice(0, n);
    const signal = assessProbeSignal(yy);
    // Only an ACTIVE series earns a narrative. A static probe's "phases" would be sub-threshold wiggles,
    // and a noisy probe's peakRate is the steepest jitter — both would be quoted as physics. The raw
    // extremes stay (they are real readings); the trend machinery does not.
    const active = signal.assessment === 'active';
    const fit = active ? fitNewtonCooling(tt.map((t2, i) => ({ t: t2, T: yy[i] }))) : null;
    return {
      label: t.label,
      placedBy: t.placedBy ?? 'student',
      signal,
      // Gate on quality, not just convergence: below FIT_MIN_R2 the exponential is not what the data does.
      newtonFit:
        fit && fit.r2 >= FIT_MIN_R2 && fit.n >= MIN_FIT_POINTS
          ? {
              tau: round2(fit.tau),
              tInf: round2(fit.tInf),
              r2: round3(fit.r2),
              direction: fit.direction,
              nPoints: fit.n,
            }
          : null,
      maxAt: extremum(tt, yy, 'max'),
      minAt: extremum(tt, yy, 'min'),
      peakRate: active ? peakRate(tt, yy) : null,
      phases: active ? segmentPhases(tt, yy) : [],
    };
  });

  // Where the hottest pixel sits at the start vs the end of the clip: a hotspot that stays put reads very
  // differently (a fixed heat source) from one that migrates (conduction along an object, a moving subject).
  let hotspotDrift: AnalysisDigest['clip']['hotspotDrift'] = null;
  if (frameGlobal.length >= 2) {
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

  return {
    version: DIGEST_VERSION,
    note:
      'Derived by the server from the sampled frames listed in the summary — every fit and rate here is ' +
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
  };
};

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

/** Sorted unique values, plus every pairwise difference — a report legitimately says "a rise of 12.4 °C",
 *  which is a number the data implies but never contains. Capped so the O(n^2) stays small. */
const PAIRWISE_CAP = 400;

const withDifferences = (values: number[]): number[] => {
  const base = Array.from(new Set(values.filter((v) => Number.isFinite(v)).map((v) => Number(v.toFixed(3)))));
  const src = base.slice(0, PAIRWISE_CAP);
  const all = new Set(base);
  for (let i = 0; i < src.length; i++) {
    for (let j = i + 1; j < src.length; j++) all.add(Number(Math.abs(src[i] - src[j]).toFixed(3)));
  }
  return Array.from(all).sort((a, b) => a - b);
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
}

/**
 * Cross-check every figure a report cites against the data it was given.
 *
 * Legal sources are enumerated explicitly rather than "anything numeric in the JSON": every probe reading
 * and its summary statistics, every frame's global statistics, the shared time axis, and every quantity
 * the derived analysis produced — plus all pairwise differences, since stating a change is legitimate.
 */
export function verifyReportNumbers(
  report: string,
  summary: VerifiableSummary,
  digest: AnalysisDigest | null,
): VerificationResult {
  const temps: number[] = [];
  const times: number[] = [];
  const rates: number[] = [];

  for (const t of [...(summary.thermometers ?? []), ...(summary.aiProbes ?? [])]) {
    for (const v of t.series ?? []) temps.push(v);
    for (const v of [t.min, t.max, t.startTemp, t.endTemp, t.changeC]) if (v != null) temps.push(v);
    if (t.secantCPerSec != null) rates.push(t.secantCPerSec);
  }
  for (const g of summary.frameGlobal ?? []) {
    times.push(g.t);
    temps.push(g.min, g.max, g.mean);
    if (g.p02 != null) temps.push(g.p02);
    if (g.p98 != null) temps.push(g.p98);
  }
  for (const t of summary.times ?? []) times.push(t);

  if (digest) {
    for (const d of digest.thermometers ?? []) {
      if (d.newtonFit) {
        // tau is a duration, so it is checked against the time axis; the asymptote is a temperature.
        // Its small multiples are legal too: "within a few per cent of the final temperature by 3*tau"
        // is the standard way to read a time constant, and the report prompt explicitly asks for it —
        // a verifier that cannot represent a product would flag the very sentence it requested.
        times.push(d.newtonFit.tau, 2 * d.newtonFit.tau, 3 * d.newtonFit.tau, 5 * d.newtonFit.tau);
        temps.push(d.newtonFit.tInf);
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
  }

  const legalTemps = withDifferences(temps);
  const legalTimes = withDifferences(times);
  // The time axis has a real resolution — samples sit whole seconds apart on a long clip — and a report
  // naming an instant between two of them is reading the data at its resolution, not inventing a number.
  // The fixed tolerance only ever covered rounding, so it flagged honest prose on any coarsely sampled
  // clip; half the median sample spacing is the actual uncertainty.
  const spacings: number[] = [];
  for (let i = 1; i < (summary.times ?? []).length; i++) spacings.push(summary.times[i] - summary.times[i - 1]);
  spacings.sort((a, b) => a - b);
  const medianSpacing = spacings.length ? spacings[Math.floor(spacings.length / 2)] : 0;
  const timeTolerance = Math.max(TIME_TOLERANCE, medianSpacing / 2);
  // Rates are compared as magnitudes on both sides. The data stores a signed rate (-0.667 °C/s for a
  // probe that is cooling), but prose carries the direction in the verb — "cools at 0.667 °C/s" — and
  // flagging that as unsupported would be a false positive on the most natural way to write it.
  const legalRates = withDifferences(rates.map(Math.abs));

  const cited = extractCitedValues(report);
  const unmatched: CitedValue[] = [];
  for (const c of cited) {
    const ok =
      c.kind === 'temperature'
        ? nearAny(legalTemps, c.value, TEMP_TOLERANCE)
        : c.kind === 'time'
          ? nearAny(legalTimes, c.value, timeTolerance)
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
}

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
}

export function reportInputsDescriptor(exp: AnalysisInputsDoc, frameSamples: number): ReportInputsDescriptor {
  const segments = Array.isArray(exp.segments) ? (exp.segments as { start: number; end: number }[]) : [];
  const lines = Array.isArray(exp.profileLines) ? (exp.profileLines as ProfileLineLike[]) : [];
  return {
    v: ANALYSIS_ALGO_VERSION,
    samples: frameSamples,
    source: typeof exp.sourceType === 'string' ? exp.sourceType : null,
    recordingId: typeof exp.recordingId === 'string' ? exp.recordingId : null,
    name: typeof exp.name === 'string' ? exp.name : null,
    duration: Number(exp.duration) || 0,
    segments: segments.map((s) => ({ start: s.start, end: s.end })),
    profileLines: lines.map((l) => ({ x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, lengthCm: l.lengthCm ?? null })),
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
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}
