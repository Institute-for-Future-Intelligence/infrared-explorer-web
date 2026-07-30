/**
 * Newton's-law cooling / heating fit for the T(t) chart's fit tool — the maths behind turning a temperature
 * curve into physical numbers (τ, T∞, R²) the way the T(l) gradient tool turns a profile into a slope.
 *
 * Model: T(t) = T∞ + A·e^(−k·(t − t0)), with k > 0 (a decay toward the asymptote T∞).
 *   • cooling  → A > 0 (temperature falls from above toward ambient T∞)
 *   • heating  → A < 0 (temperature rises from below toward a target T∞)
 * τ = 1/k is the time constant in seconds; t0 anchors the exponent at the window's first sample so the fit
 * is numerically well-conditioned regardless of where the window starts.
 *
 * Method (as described to users: "least-squares with a 1-D search on T∞"): for any FIXED asymptote the model
 * linearises — ln|T − T∞| is linear in t — so a single-pass linear regression gives k and A. We golden-section
 * search T∞ on each feasible side (below the data = cooling, above = heating) to minimise the sum of squared
 * residuals in ORIGINAL temperature space (not log space, which would bias toward the small-residual tail),
 * then keep whichever side fits better. Pure and dependency-free; all inputs are already in the display unit,
 * so τ comes out in seconds and T∞ in whatever unit the chart is showing.
 */

export interface ExpFit {
  tInf: number; // asymptote T∞ (display unit)
  a: number; // signed amplitude at t0: >0 cooling, <0 heating (display unit)
  k: number; // rate constant (1/s), strictly > 0
  tau: number; // time constant 1/k (s)
  t0: number; // exponent anchor time (s) — the window's first sample time
  r2: number; // coefficient of determination in original temperature space, clamped [0,1]
  n: number; // finite points used
  direction: 'cooling' | 'heating';
}

// How far beyond the observed range the asymptote is allowed to sit, as a multiple of the observed span.
// Generous, because a barely-cooled window puts ambient many spans away from the data (an exponential fit is
// genuinely ill-conditioned there — reflected in a wide, low-confidence result rather than an outright fail).
const ASYMPTOTE_SPAN = 10;

interface SideFit {
  tInf: number;
  a: number;
  k: number;
  ssr: number;
}

/**
 * Ordinary-least-squares log-linear fit for one FIXED asymptote on one side, evaluated back in temperature
 * space. `side` picks the sign convention: 'below' expects T∞ < every reading (cooling), 'above' expects
 * T∞ > every reading (heating). Returns null when the side is infeasible for these points (a reading on the
 * wrong side of T∞) or the series doesn't actually decay toward T∞ (regression slope not negative) — so the
 * correct side is the one that yields a result, and the wrong side self-rejects.
 */
const fitForAsymptote = (xs: number[], ts: number[], tInf: number, side: 'below' | 'above'): SideFit | null => {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = side === 'below' ? ts[i] - tInf : tInf - ts[i];
    if (d <= 1e-9) return null; // a reading on/past the asymptote → this side can't hold these points
    const y = Math.log(d);
    const x = xs[i];
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom < 1e-12) return null; // no spread in time → slope undefined
  const m = (n * sxy - sx * sy) / denom;
  const b = (sy - m * sx) / n;
  if (m >= -1e-12) return null; // not decaying toward T∞ (would be growth) → not this side's model
  const k = -m;
  const mag = Math.exp(b); // |A|
  const a = side === 'below' ? mag : -mag;
  let ssr = 0;
  for (let i = 0; i < xs.length; i++) {
    const tHat = tInf + a * Math.exp(-k * xs[i]);
    ssr += (ts[i] - tHat) ** 2;
  }
  return { tInf, a, k, ssr };
};

// Golden-section search for the asymptote minimising SSR within [lo, hi] on one side. Returns the best
// feasible fit, or null when the whole bracket is infeasible for this side.
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

/** Minimum points for a meaningful three-parameter (T∞, A, k) exponential fit. */
export const MIN_FIT_POINTS = 4;

/**
 * Fit T(t) = T∞ + A·e^(−k·(t − t0)) to (time-seconds, temperature) points by searching the asymptote on both
 * sides and keeping the lower-residual one. Returns null when there are fewer than MIN_FIT_POINTS finite
 * points, the readings are essentially flat (no exponential to fit), or neither side yields a decaying fit.
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
  if (span < 1e-6) return null; // flat within the window → no exponential

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

/** Sample the fitted model at `n` evenly-spaced times across [tStart, tEnd] — the points for the overlay curve. */
export const sampleExpFit = (fit: ExpFit, tStart: number, tEnd: number, n = 64): { t: number; T: number }[] => {
  const out: { t: number; T: number }[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? tStart : tStart + ((tEnd - tStart) * i) / (n - 1);
    out[i] = { t, T: fit.tInf + fit.a * Math.exp(-fit.k * (t - fit.t0)) };
  }
  return out;
};
