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

export interface AnalysisDigest {
  /** Bumped whenever the computation below changes — see the cache's algorithm version. */
  version: number;
  note: string;
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
 *  key folds this in, so old cached digests are recomputed rather than served forever). */
export const DIGEST_VERSION = 1;

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
}): AnalysisDigest => {
  const { times, thermometers, frameGlobal, frames, profileLines } = args;

  const thermoDigests: ThermometerDigest[] = thermometers.map((t) => {
    const temps = t.series ?? [];
    const n = Math.min(times.length, temps.length);
    const tt = times.slice(0, n);
    const yy = temps.slice(0, n);
    const fit = fitNewtonCooling(tt.map((t2, i) => ({ t: t2, T: yy[i] })));
    return {
      label: t.label,
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
      peakRate: peakRate(tt, yy),
      phases: segmentPhases(tt, yy),
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
    thermometers: thermoDigests,
    clip: { hotspotDrift, warmArea },
    profileLines: profileDigests,
  };
};

/** Re-export so callers can build a digest from frames they decoded themselves without a second import. */
export { frameStats };
export type { FrameStats };

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
export const ANALYSIS_ALGO_VERSION = 1;

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
