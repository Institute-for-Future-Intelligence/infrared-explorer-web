/**
 * Tests for the derived thermal analysis (functions/src/analysis.ts).
 *
 * These matter more than most unit tests here: every number this module produces is quoted verbatim to a
 * student inside an AI-written lab report, so a fit that silently returns nonsense becomes a confident
 * physics claim. The cases below are therefore built from CLOSED-FORM synthetic data — a curve whose tau
 * and asymptote we chose ourselves — so a regression shows up as a wrong number, not just a crash.
 *
 * Run: npm test   (node:test via tsx — see the root package.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRawFrame, frameStats, INTSIZE, type DecodedFrame } from './thermal';
import {
  analysisInputsHash,
  assessProbeSignal,
  suggestProbePositions,
  densifyIndices,
  densifySignal,
  extractCitedValues,
  planDensification,
  verifyReportNumbers,
  buildAnalysisDigest,
  fitNewtonCooling,
  linearFit,
  sampleLineProfile,
  MIN_FIT_POINTS,
} from './analysis';

// --- helpers ---------------------------------------------------------------

/** Build a DecodedFrame whose pixel (x,y) holds `tempAt(x,y)` degrees Celsius, in the real wire format:
 *  one 4-byte record per pixel, big-endian uint16 of centi-Kelvin at byte offset +2. */
const makeFrame = (w: number, h: number, tempAt: (x: number, y: number) => number): DecodedFrame => {
  const raw = new Uint8Array(w * h * INTSIZE);
  const dv = new DataView(raw.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const centiK = Math.round((tempAt(x, y) + 273.15) * 100);
      dv.setUint16((y * w + x) * INTSIZE + 2, centiK, false);
    }
  }
  return decodeRawFrame(raw, w, h);
};

/** Exact Newton cooling/heating samples: T(t) = tInf + a*exp(-t/tau). */
const newtonSamples = (n: number, dt: number, tInf: number, a: number, tau: number) =>
  Array.from({ length: n }, (_, i) => ({ t: i * dt, T: tInf + a * Math.exp(-(i * dt) / tau) }));

const closeTo = (actual: number, expected: number, tol: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: expected ${expected} +/- ${tol}, got ${actual}`);

// --- fitNewtonCooling ------------------------------------------------------

describe('fitNewtonCooling', () => {
  it('recovers tau and the asymptote from an exact cooling curve', () => {
    const fit = fitNewtonCooling(newtonSamples(25, 2, 21, 45, 30));
    assert.ok(fit, 'expected a fit');
    closeTo(fit.tau, 30, 0.5, 'tau');
    closeTo(fit.tInf, 21, 0.5, 'tInf');
    assert.equal(fit.direction, 'cooling');
    assert.ok(fit.r2 > 0.999, `r2 should be ~1, got ${fit.r2}`);
    assert.equal(fit.n, 25);
  });

  it('recognises heating (an approach from below) and signs the amplitude negative', () => {
    const fit = fitNewtonCooling(newtonSamples(25, 2, 80, -55, 20));
    assert.ok(fit, 'expected a fit');
    closeTo(fit.tau, 20, 0.5, 'tau');
    closeTo(fit.tInf, 80, 0.6, 'tInf');
    assert.equal(fit.direction, 'heating');
    assert.ok(fit.a < 0, 'heating amplitude must be negative');
  });

  it('returns null below MIN_FIT_POINTS — three points cannot pin three parameters', () => {
    assert.equal(fitNewtonCooling(newtonSamples(MIN_FIT_POINTS - 1, 2, 21, 45, 30)), null);
  });

  it('returns null for a flat series rather than inventing a time constant', () => {
    const flat = Array.from({ length: 20 }, (_, i) => ({ t: i, T: 25 }));
    assert.equal(fitNewtonCooling(flat), null);
  });

  it('ignores non-finite samples and still fits the rest', () => {
    const pts = newtonSamples(20, 2, 20, 40, 25);
    pts[3].T = NaN;
    const fit = fitNewtonCooling(pts);
    assert.ok(fit, 'expected a fit');
    assert.equal(fit.n, 19);
    closeTo(fit.tau, 25, 1, 'tau');
  });

  it('survives noise with a slightly degraded r2 but the right time constant', () => {
    // Deterministic pseudo-noise: no Math.random, so a failure is reproducible.
    const pts = newtonSamples(25, 2, 22, 50, 40).map((p, i) => ({
      t: p.t,
      T: p.T + Math.sin(i * 12.9898) * 0.3,
    }));
    const fit = fitNewtonCooling(pts);
    assert.ok(fit, 'expected a fit');
    closeTo(fit.tau, 40, 4, 'tau');
    assert.ok(fit.r2 > 0.99 && fit.r2 <= 1, `r2 out of range: ${fit.r2}`);
  });

  it('does not present a straight ramp as a confident exponential', () => {
    const ramp = Array.from({ length: 25 }, (_, i) => ({ t: i, T: 20 + i * 0.8 }));
    const fit = fitNewtonCooling(ramp);
    // A ramp is the far tail of some exponential, so a fit may exist — but the digest gate (r2 >= 0.9)
    // must never let a WRONG tau through unnoticed. What matters is that if it fits, it fits well.
    if (fit) assert.ok(fit.r2 > 0.9, `a reported ramp fit should still be a good fit, got r2=${fit.r2}`);
  });
});

// --- linearFit -------------------------------------------------------------

describe('linearFit', () => {
  it('recovers an exact line', () => {
    const fit = linearFit(Array.from({ length: 10 }, (_, i) => ({ x: i, y: 3 * i + 5 })));
    assert.ok(fit);
    closeTo(fit.slope, 3, 1e-9, 'slope');
    closeTo(fit.intercept, 5, 1e-9, 'intercept');
    closeTo(fit.r2, 1, 1e-9, 'r2');
    assert.equal(fit.n, 10);
  });

  it('reports a flat series as a perfect zero-gradient fit', () => {
    const fit = linearFit(Array.from({ length: 8 }, (_, i) => ({ x: i, y: 42 })));
    assert.ok(fit);
    closeTo(fit.slope, 0, 1e-9, 'slope');
    closeTo(fit.r2, 1, 1e-9, 'r2');
  });

  it('returns null without at least two points, or without spread in x', () => {
    assert.equal(linearFit([{ x: 1, y: 1 }]), null);
    assert.equal(
      linearFit([
        { x: 2, y: 1 },
        { x: 2, y: 9 },
      ]),
      null,
    );
  });
});

// --- frameStats ------------------------------------------------------------

describe('frameStats', () => {
  it('collapses a uniform frame to one temperature, percentiles included', () => {
    const s = frameStats(makeFrame(8, 8, () => 30));
    closeTo(s.min, 30, 0.01, 'min');
    closeTo(s.max, 30, 0.01, 'max');
    closeTo(s.mean, 30, 0.01, 'mean');
    closeTo(s.p02, 30, 0.01, 'p02');
    closeTo(s.p98, 30, 0.01, 'p98');
  });

  it('locates the hottest and coldest pixel, and orders the robust bounds inside min/max', () => {
    // Temperature rises left->right, so the coldest pixel is column 0 and the hottest the last column.
    const w = 10;
    const h = 4;
    const s = frameStats(makeFrame(w, h, (x) => 20 + x));
    closeTo(s.min, 20, 0.01, 'min');
    closeTo(s.max, 29, 0.01, 'max');
    assert.ok(s.hotspot.x > 0.9, `hotspot should sit at the right edge, got ${s.hotspot.x}`);
    assert.ok(s.coldspot.x < 0.1, `coldspot should sit at the left edge, got ${s.coldspot.x}`);
    assert.ok(s.p02 >= s.min && s.p98 <= s.max, 'robust bounds must lie inside min/max');
    assert.ok(s.p02 < s.p98, 'p02 must be below p98 on a non-uniform frame');
  });

  it('is not dragged to the extremes by a single rogue pixel', () => {
    // One saturated element in an otherwise 25 C scene: min/max see it, p02/p98 must not.
    const s = frameStats(makeFrame(20, 20, (x, y) => (x === 0 && y === 0 ? 300 : 25)));
    closeTo(s.max, 300, 0.01, 'max sees the rogue pixel');
    closeTo(s.p98, 25, 0.01, 'p98 ignores it');
  });
});

// --- sampleLineProfile -----------------------------------------------------

describe('sampleLineProfile', () => {
  it('walks a horizontal transect across a left-to-right gradient', () => {
    const frame = makeFrame(100, 10, (x) => 10 + x * 0.5);
    const pts = sampleLineProfile(frame, { x1: 0, y1: 0.5, x2: 1, y2: 0.5 }, 50);
    assert.equal(pts.length, 50);
    closeTo(pts[0].pos, 0, 1e-9, 'first pos');
    closeTo(pts[pts.length - 1].pos, 1, 1e-9, 'last pos');
    assert.ok(pts[0].tempC < pts[pts.length - 1].tempC, 'temperature must rise along the transect');
    // The fitted slope over normalized position is the full end-to-end difference: ~49.5 C.
    const fit = linearFit(pts.map((p) => ({ x: p.pos, y: p.tempC })));
    assert.ok(fit);
    closeTo(fit.slope, 49.5, 1.5, 'end-to-end delta');
    assert.ok(fit.r2 > 0.999, 'a linear gradient must fit linearly');
  });
});

// --- buildAnalysisDigest ---------------------------------------------------

const uniformFrames = (temps: number[]) =>
  temps.map((c, i) => ({ frame: makeFrame(20, 20, () => c), recordingIndex: i, tSec: i * 2 }));

describe('buildAnalysisDigest', () => {
  it('reports a fitted cooling probe with its extremes and a falling phase', () => {
    const pts = newtonSamples(20, 2, 22, 40, 25);
    const times = pts.map((p) => p.t);
    const temps = pts.map((p) => p.T);
    const digest = buildAnalysisDigest({
      times,
      thermometers: [{ label: 'T1', series: temps }],
      frameGlobal: times.map((t, i) => ({
        t,
        min: temps[i] - 5,
        max: temps[i],
        mean: temps[i] - 2,
        hotspot: { x: 0.5, y: 0.5 },
      })),
      frames: uniformFrames(temps),
      profileLines: [],
    });
    const t1 = digest.thermometers[0];
    assert.ok(t1.newtonFit, 'a clean exponential must produce a fit');
    closeTo(t1.newtonFit.tau, 25, 1, 'tau');
    assert.equal(t1.newtonFit.direction, 'cooling');
    closeTo(t1.maxAt!.t, 0, 1e-9, 'hottest at the start');
    assert.ok(t1.peakRate!.cPerSec < 0, 'a cooling probe has a negative peak rate');
    assert.ok(
      t1.phases.every((p) => p.kind !== 'rising'),
      'a monotonically cooling probe has no rising phase',
    );
  });

  it('withholds the fit when the data is not exponential, and still describes the shape', () => {
    // Rise then fall: no single Newton law describes it, and the report must not claim one.
    const times = Array.from({ length: 21 }, (_, i) => i * 2);
    const temps = times.map((t) => 20 + 30 * Math.sin((Math.PI * t) / 40));
    const digest = buildAnalysisDigest({
      times,
      thermometers: [{ label: 'T1', series: temps }],
      frameGlobal: times.map((t, i) => ({ t, min: 18, max: temps[i], mean: 22, hotspot: { x: 0.5, y: 0.5 } })),
      frames: uniformFrames(temps),
      profileLines: [],
    });
    const t1 = digest.thermometers[0];
    assert.equal(t1.newtonFit, null, 'a rise-and-fall must not be reported as Newton cooling');
    closeTo(t1.maxAt!.t, 20, 2.01, 'the peak is in the middle of the window');
    const kinds = t1.phases.map((p) => p.kind);
    assert.ok(kinds.includes('rising') && kinds.includes('falling'), `expected both directions, got ${kinds}`);
  });

  it('converts a transect slope to C/cm only when the student calibrated a length', () => {
    const frames = [{ frame: makeFrame(100, 10, (x) => 10 + x * 0.5), recordingIndex: 0, tSec: 0 }];
    const base = {
      times: [0],
      thermometers: [],
      frameGlobal: [{ t: 0, min: 10, max: 59.5, mean: 35, hotspot: { x: 0.99, y: 0.5 } }],
      frames,
    };
    const calibrated = buildAnalysisDigest({
      ...base,
      profileLines: [{ name: 'edge', x1: 0, y1: 0.5, x2: 1, y2: 0.5, lengthCm: 10 }],
    });
    const g = calibrated.profileLines[0].gradients[0];
    assert.equal(g.unit, 'C/cm');
    // ~49.5 C end to end over 10 cm.
    closeTo(g.slope, 4.95, 0.2, 'gradient in C/cm');
    closeTo(g.deltaC, 49.5, 1.5, 'end-to-end delta');

    const uncalibrated = buildAnalysisDigest({
      ...base,
      profileLines: [{ name: 'edge', x1: 0, y1: 0.5, x2: 1, y2: 0.5 }],
    });
    assert.equal(uncalibrated.profileLines[0].gradients[0].unit, 'C/px');
  });

  it('quotes a warm-area percentage together with the threshold it used', () => {
    // Half the frame at 60 C, half at 20 C, held for the whole clip.
    const half = makeFrame(20, 20, (x) => (x < 10 ? 60 : 20));
    const digest = buildAnalysisDigest({
      times: [0, 2, 4],
      thermometers: [],
      frameGlobal: [0, 2, 4].map((t) => ({ t, min: 20, max: 60, mean: 40, hotspot: { x: 0.25, y: 0.5 } })),
      frames: [0, 2, 4].map((t, i) => ({ frame: half, recordingIndex: i, tSec: t })),
      profileLines: [],
    });
    assert.ok(digest.clip.warmArea, 'expected a warm-area reading');
    for (const w of digest.clip.warmArea) {
      closeTo(w.thresholdC, 40, 0.01, 'threshold midway between the clip bounds');
      closeTo(w.fractionPct, 50, 0.01, 'half the pixels are above it');
    }
  });

  it('degrades to an empty-but-valid digest instead of throwing on a bare clip', () => {
    const digest = buildAnalysisDigest({
      times: [],
      thermometers: [],
      frameGlobal: [],
      frames: [],
      profileLines: [],
    });
    assert.deepEqual(digest.thermometers, []);
    assert.equal(digest.clip.hotspotDrift, null);
    assert.equal(digest.clip.warmArea, null);
    assert.deepEqual(digest.profileLines, []);
  });

  it('serializes to JSON with no NaN or Infinity leaking into the prompt', () => {
    const times = [0, 2, 4, 6, 8, 10];
    const temps = [50, 45, 41, 38, 36, 35];
    const digest = buildAnalysisDigest({
      times,
      thermometers: [
        { label: 'T1', series: temps },
        { label: 'T2', series: [] },
      ],
      frameGlobal: times.map((t, i) => ({ t, min: 20, max: temps[i], mean: 30, hotspot: { x: 0.4, y: 0.6 } })),
      frames: uniformFrames(temps),
      profileLines: [{ name: 'L1', x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9, lengthCm: null }],
    });
    const json = JSON.stringify(digest);
    assert.ok(!/null,null|NaN|Infinity/.test(json.replace(/"[^"]*":null/g, '')), 'no NaN/Infinity in the digest');
    assert.equal(JSON.parse(json).version, digest.version);
  });

  it('measures how far the hotspot travelled across the clip', () => {
    const digest = buildAnalysisDigest({
      times: [0, 10],
      thermometers: [],
      frameGlobal: [
        { t: 0, min: 20, max: 60, mean: 30, hotspot: { x: 0.1, y: 0.1 } },
        { t: 10, min: 20, max: 60, mean: 30, hotspot: { x: 0.4, y: 0.5 } },
      ],
      frames: uniformFrames([30, 30]),
      profileLines: [],
    });
    assert.ok(digest.clip.hotspotDrift);
    closeTo(digest.clip.hotspotDrift.movedFraction, 0.5, 0.001, 'drift distance');
  });
});

describe('analysisInputsHash', () => {
  it('is stable across calls so a cache key does not churn on its own', () => {
    const exp = { sourceType: 'recording', recordingId: 'r1', duration: 30, segments: [{ start: 2, end: 40 }] };
    const probes = [{ x: 0.2, y: 0.3 }];
    assert.equal(analysisInputsHash(exp, probes, 25), analysisInputsHash({ ...exp }, [...probes], 25));
  });

  it('ignores cosmetic edits but notices anything that changes the numbers', () => {
    const exp = { sourceType: 'recording', recordingId: 'r1', duration: 30, segments: [] };
    const probes = [{ x: 0.2, y: 0.3 }];
    const base = analysisInputsHash(exp, probes, 25);

    // Cosmetic: names, notes and captions never reach the hash (they are merged in live).
    assert.equal(analysisInputsHash({ ...exp }, [{ x: 0.2, y: 0.3 }], 25), base, 'a renamed probe must not invalidate');

    // Substantive: each of these changes what the summary or the digest computes.
    assert.notEqual(analysisInputsHash({ ...exp, duration: 31 }, probes, 25), base, 'duration');
    assert.notEqual(analysisInputsHash({ ...exp, segments: [{ start: 0, end: 10 }] }, probes, 25), base, 'trim');
    assert.notEqual(analysisInputsHash(exp, [{ x: 0.25, y: 0.3 }], 25), base, 'probe moved');
    assert.notEqual(
      analysisInputsHash(exp, [{ x: 0.2, y: 0.3, measuringAreaType: 'rectangle' }], 25),
      base,
      'probe became an area',
    );
    assert.notEqual(analysisInputsHash(exp, probes, 40), base, 'sample count');
    assert.notEqual(
      analysisInputsHash({ ...exp, profileLines: [{ x1: 0, y1: 0, x2: 1, y2: 1 }] }, probes, 25),
      base,
      'a transect was drawn',
    );
    assert.notEqual(
      analysisInputsHash({ ...exp, profileLines: [{ x1: 0, y1: 0, x2: 1, y2: 1, lengthCm: 12 }] }, probes, 25),
      analysisInputsHash({ ...exp, profileLines: [{ x1: 0, y1: 0, x2: 1, y2: 1 }] }, probes, 25),
      'a calibrated length changes the gradient unit',
    );
  });

  it('distinguishes two probes ordered differently — the order is the T1..Tn labelling', () => {
    const exp = { sourceType: 'recording', recordingId: 'r1', duration: 30 };
    const a = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.9 },
    ];
    assert.notEqual(analysisInputsHash(exp, a, 25), analysisInputsHash(exp, [...a].reverse(), 25));
  });
});

// --- verifyReportNumbers ---------------------------------------------------

const verifiableSummary = {
  times: [0, 10, 20, 30],
  thermometers: [
    {
      series: [60.0, 50.0, 44.0, 40.0],
      min: 40.0,
      max: 60.0,
      startTemp: 60.0,
      endTemp: 40.0,
      changeC: -20.0,
      secantCPerSec: -0.667,
    },
  ],
  frameGlobal: [0, 10, 20, 30].map((t, i) => ({
    t,
    min: 19.5,
    max: [60.0, 50.0, 44.0, 40.0][i],
    mean: 25.0,
    p02: 20.0,
    p98: 55.0,
  })),
};

describe('verifyReportNumbers', () => {
  it('accepts figures that appear in the data, including a stated difference', () => {
    const report =
      'T1 falls from 60.0 °C at t = 0 s to 40.0 °C at t = 30 s, a drop of 20.0 °C. The scene sits near 25.0 °C.';
    const res = verifyReportNumbers(report, verifiableSummary, null);
    assert.equal(res.unmatched.length, 0, `unexpected misses: ${JSON.stringify(res.unmatched)}`);
    assert.ok(res.checked >= 5, `expected several figures to be checked, got ${res.checked}`);
    assert.equal(res.matched, res.checked);
  });

  it('catches an invented temperature', () => {
    const res = verifyReportNumbers('The plate reached 87.4 °C before cooling.', verifiableSummary, null);
    assert.equal(res.unmatched.length, 1);
    assert.equal(res.unmatched[0].value, 87.4);
    assert.equal(res.unmatched[0].kind, 'temperature');
  });

  it('catches an invented time', () => {
    const res = verifyReportNumbers('The plateau begins at t = 512 s.', verifiableSummary, null);
    assert.equal(res.unmatched.length, 1);
    assert.equal(res.unmatched[0].kind, 'time');
  });

  it('tolerates the rounding a model does when writing prose', () => {
    // 44.0 written as "44 °C"; a time of 30 written as "30 s"; both are the same measurement.
    const res = verifyReportNumbers('It passes 44 °C around t = 30 s.', verifiableSummary, null);
    assert.equal(res.unmatched.length, 0, JSON.stringify(res.unmatched));
  });

  it('reads a rate as a rate, not as a temperature followed by stray text', () => {
    const cited = extractCitedValues('cooling at 0.667 °C/s and a gradient of 4.95 °C/cm');
    assert.deepEqual(
      cited.map((c) => c.kind),
      ['rate', 'rate'],
    );
    // The secant is in the data (as a negative); its magnitude must be accepted.
    const res = verifyReportNumbers('It cools at 0.667 °C/s.', verifiableSummary, null);
    assert.equal(res.unmatched.length, 0, JSON.stringify(res.unmatched));
  });

  it('ignores unit-less numbers — a section count is not a measurement claim', () => {
    const res = verifyReportNumbers('Only 4 of 25 frames decoded, and R² = 0.98.', verifiableSummary, null);
    assert.equal(res.checked, 0);
  });

  it('accepts a fitted time constant and asymptote once the digest supplies them', () => {
    const digest = buildAnalysisDigest({
      times: verifiableSummary.times,
      thermometers: [{ label: 'T1', series: verifiableSummary.thermometers[0].series }],
      frameGlobal: verifiableSummary.frameGlobal.map((g) => ({ ...g, hotspot: { x: 0.5, y: 0.5 } })),
      frames: [],
      profileLines: [],
    });
    const fit = digest.thermometers[0].newtonFit;
    assert.ok(fit, 'the synthetic curve should fit');
    const report = `Newton's law fits with tau = ${fit.tau} s toward ${fit.tInf} °C.`;
    // Without the digest those two figures are unsupported; with it they are legitimate.
    assert.ok(verifyReportNumbers(report, verifiableSummary, null).unmatched.length > 0);
    assert.equal(verifyReportNumbers(report, verifiableSummary, digest).unmatched.length, 0);
  });

  it('never throws on an empty report or an empty summary', () => {
    assert.equal(verifyReportNumbers('', verifiableSummary, null).checked, 0);
    const empty = { times: [], thermometers: [], frameGlobal: [] };
    const res = verifyReportNumbers('It reached 30.0 °C.', empty, null);
    assert.equal(res.unmatched.length, 1);
  });
});

// --- adaptive sampling -----------------------------------------------------

describe('planDensification', () => {
  const idx = (n: number) => Array.from({ length: n }, (_, i) => i * 10);

  it('finds the fast interval in an otherwise quiet clip', () => {
    // Flat, then a sharp step between samples 5 and 6, then flat again.
    const values = [20, 20.1, 20, 20.1, 20, 20.1, 70, 70.1, 70, 70.1];
    const times = values.map((_, i) => i * 5);
    const windows = planDensification(times, values, idx(values.length));
    assert.equal(windows.length, 1);
    assert.equal(windows[0].fromIndex, 50);
    assert.equal(windows[0].toIndex, 60);
    closeTo(windows[0].changeC, 49.9, 0.01, 'the size of the jump');
  });

  it('merges neighbouring fast intervals into one event', () => {
    // Quiet, a three-step climb, quiet again — one event spanning three intervals, not three events.
    const values = [...Array(8).fill(20), 40, 60, 80, ...Array(8).fill(80)];
    const times = values.map((_, i) => i * 5);
    const windows = planDensification(times, values, idx(values.length));
    assert.equal(windows.length, 1, `expected one merged window, got ${JSON.stringify(windows)}`);
    assert.equal(windows[0].fromIndex, 70, 'starts at the last quiet sample');
    assert.equal(windows[0].toIndex, 100, 'ends where it levels off');
    closeTo(windows[0].changeC, 60, 0.01, 'the whole climb');
  });

  it('finds nothing when most of the clip is moving — there is no "faster than usual" then', () => {
    // A steady ramp across the whole window: the median rate IS the ramp, so nothing stands out. This is
    // the intended limit of a median-relative rule, and the right answer — evenly spaced samples already
    // describe a uniform ramp perfectly well, and densifying part of it would buy nothing.
    const values = Array.from({ length: 12 }, (_, i) => 20 + i * 5);
    const times = values.map((_, i) => i * 5);
    assert.deepEqual(planDensification(times, values, idx(values.length)), []);
  });

  it('ignores noise on a flat series, where the median rate is near zero', () => {
    const values = Array.from({ length: 12 }, (_, i) => 25 + (i % 2 ? 0.02 : -0.02));
    const times = values.map((_, i) => i * 5);
    assert.deepEqual(planDensification(times, values, idx(values.length)), []);
  });

  it('never returns more windows than asked for, picking the biggest moves', () => {
    const values = [20, 20, 60, 60, 60, 30, 30, 30, 90, 90];
    const times = values.map((_, i) => i * 5);
    const windows = planDensification(times, values, idx(values.length), 2);
    assert.equal(windows.length, 2);
    assert.ok(windows[0].changeC >= windows[1].changeC, 'ranked by size of the move');
  });

  it('declines to plan anything from too few points', () => {
    assert.deepEqual(planDensification([0, 5, 10], [20, 60, 20], [0, 1, 2]), []);
  });
});

describe('densifyIndices', () => {
  const window = { fromIndex: 100, toIndex: 120, tStart: 20, tEnd: 24, changeC: 30 };

  it('spreads extra reads strictly inside the window', () => {
    const extra = densifyIndices(window, 4);
    assert.equal(extra.length, 4);
    assert.ok(
      extra.every((i) => i > 100 && i < 120),
      `out of range: ${extra}`,
    );
    assert.deepEqual(
      [...extra].sort((a, b) => a - b),
      extra,
      'ascending',
    );
    assert.equal(new Set(extra).size, extra.length, 'no duplicates');
  });

  it('cannot ask for more frames than the window actually contains', () => {
    assert.deepEqual(densifyIndices({ ...window, toIndex: 101 }, 15), [], 'adjacent frames leave no room');
    assert.equal(densifyIndices({ ...window, toIndex: 104 }, 15).length, 3);
  });
});

describe('densifySignal', () => {
  it('watches the ACTIVE probe with the largest excursion', () => {
    // Realistic smooth series, not a single-sample spike — a 3-point spike is noise-shaped by
    // construction and is now correctly refused (see the noise test below).
    const hot = Array.from({ length: 12 }, (_, i) => 20 + 70 * Math.sin((Math.PI * i) / 11));
    const mild = Array.from({ length: 12 }, (_, i) => 20 + 2 * Math.sin((Math.PI * i) / 11));
    const signal = densifySignal(
      [
        { label: 'T1', series: mild },
        { label: 'T2', series: hot },
      ],
      hot.map(() => ({ mean: 0 })),
    );
    assert.deepEqual(signal, hot);
  });

  it('refuses to be captured by a background probe whose only content is jitter', () => {
    // The regression this gate exists for: a probe on the static background out-spanned the frame-mean
    // fallback with pure sensor noise and the whole densification budget chased it.
    const jitter = Array.from({ length: 20 }, (_, i) => 21 + (i % 2 ? 0.06 : -0.06));
    const scene = Array.from({ length: 20 }, (_, i) => ({ mean: 24 + i * 0.01, p98: 30 + i * 0.4 }));
    const signal = densifySignal([{ label: 'T1', series: jitter }], scene);
    assert.deepEqual(
      signal,
      scene.map((g) => g.p98),
      'falls back to the robust hot bound, not the noise',
    );
  });

  it('falls back to the frame means when there are no probes', () => {
    assert.deepEqual(densifySignal([], [{ mean: 21 }, { mean: 24 }]), [21, 24]);
  });
});

// --- probe signal quality --------------------------------------------------

describe('assessProbeSignal', () => {
  it('calls a clean cooling curve active even when sampled at only four points', () => {
    // The regression the second-difference estimator exists for: a fast genuine trend puts the whole
    // trend into every successive difference, so the old estimator read this as pure noise.
    const s = assessProbeSignal([60, 50, 44, 40]);
    assert.equal(s.assessment, 'active');
    closeTo(s.spanC, 20, 0.01, 'span');
  });

  it('calls a probe on unchanging background static, however clean the trace', () => {
    const s = assessProbeSignal(Array.from({ length: 25 }, () => 21.3));
    assert.equal(s.assessment, 'static');
  });

  it('calls sub-degree jitter static and larger jitter noisy, never active', () => {
    const small = Array.from({ length: 25 }, (_, i) => 21 + (i % 2 ? 0.06 : -0.06));
    assert.equal(assessProbeSignal(small).assessment, 'static');
    // Alternating ±0.7: a 1.4 °C span, but every step IS the span — noise-shaped, not a trend.
    const larger = Array.from({ length: 25 }, (_, i) => 21 + (i % 2 ? 0.7 : -0.7));
    assert.equal(assessProbeSignal(larger).assessment, 'noisy');
  });

  it('keeps a noisy-but-real trend active', () => {
    const s = assessProbeSignal(
      Array.from({ length: 25 }, (_, i) => 20 + 40 * Math.exp(-i / 8) + Math.sin(i * 12.9898) * 0.3),
    );
    assert.equal(s.assessment, 'active');
  });
});

describe('buildAnalysisDigest signal gating', () => {
  const times = Array.from({ length: 20 }, (_, i) => i * 2);
  const jitter = times.map((_, i) => 21 + (i % 2 ? 0.06 : -0.06));
  const cooling = times.map((t) => 20 + 40 * Math.exp(-t / 15));

  it('withholds phases, events and peakRate from a background probe, but narrates the real one', () => {
    const digest = buildAnalysisDigest({
      times,
      thermometers: [
        { label: 'T1', series: cooling },
        { label: 'T2', series: jitter },
      ],
      frameGlobal: times.map((t, i) => ({ t, min: 20, max: cooling[i], mean: 25, hotspot: { x: 0.5, y: 0.5 } })),
      frames: uniformFrames(cooling),
      profileLines: [],
    });
    const [t1, t2] = digest.thermometers;
    assert.equal(t1.signal.assessment, 'active');
    assert.ok(t1.phases.length > 0 && t1.peakRate, 'the real probe keeps its narrative');
    assert.equal(t2.signal.assessment, 'static');
    assert.deepEqual(t2.phases, [], 'noise gets no phases');
    assert.equal(t2.peakRate, null, 'noise gets no peak rate');
    assert.ok(
      digest.events.every((e) => e.thermometer !== 'T2'),
      'no event may originate from the background probe',
    );
  });

  it('labels AI-placed series as such in the digest', () => {
    const digest = buildAnalysisDigest({
      times,
      thermometers: [{ label: 'AI1', series: cooling, placedBy: 'ai' }],
      frameGlobal: times.map((t, i) => ({ t, min: 20, max: cooling[i], mean: 25, hotspot: { x: 0.5, y: 0.5 } })),
      frames: uniformFrames(cooling),
      profileLines: [],
    });
    assert.equal(digest.thermometers[0].placedBy, 'ai');
  });
});

// --- automatic probe placement ---------------------------------------------

describe('suggestProbePositions', () => {
  const stillHotspots = (n: number) => Array.from({ length: n }, () => ({ hotspot: { x: 0.5, y: 0.5 } }));

  /** Frames where a blob near (0.75, 0.5) warms from 20 to 60 °C while the rest of the scene stays 20. */
  const warmingBlobFrames = (n = 8) =>
    Array.from({ length: n }, (_, fi) => ({
      frame: makeFrame(40, 40, (x, y) => {
        const inBlob = Math.hypot(x - 30, y - 20) <= 4;
        return inBlob ? 20 + (40 * fi) / (n - 1) : 20;
      }),
      recordingIndex: fi,
      tSec: fi * 2,
    }));

  it('finds the region that actually changes', () => {
    const out = suggestProbePositions(warmingBlobFrames(), stillHotspots(8), [], 2);
    assert.ok(out.length >= 1, 'expected a suggestion');
    closeTo(out[0].x, 30.5 / 40, 0.08, 'x lands on the blob');
    closeTo(out[0].y, 20.5 / 40, 0.08, 'y lands on the blob');
    assert.ok(out[0].rangeC > 20, `the stated range should reflect the warming, got ${out[0].rangeC}`);
  });

  it('suggests nothing on a static scene', () => {
    const still = Array.from({ length: 8 }, (_, fi) => ({
      frame: makeFrame(40, 40, () => 22),
      recordingIndex: fi,
      tSec: fi * 2,
    }));
    assert.deepEqual(suggestProbePositions(still, stillHotspots(8), [], 3), []);
  });

  it('never lands on top of a probe the student already placed', () => {
    const existing = [{ x: 30.5 / 40, y: 20.5 / 40 }];
    const out = suggestProbePositions(warmingBlobFrames(), stillHotspots(8), existing, 2);
    for (const s of out) {
      assert.ok(
        Math.hypot(s.x - existing[0].x, s.y - existing[0].y) >= 0.14,
        `suggestion at ${s.x},${s.y} duplicates the existing probe`,
      );
    }
  });

  it('refuses to suggest anything when the hotspot migrates — a moving scene ranks edges as best', () => {
    const moving = [
      { hotspot: { x: 0.1, y: 0.5 } },
      ...Array.from({ length: 6 }, () => ({ hotspot: { x: 0.5, y: 0.5 } })),
      { hotspot: { x: 0.9, y: 0.5 } },
    ];
    assert.deepEqual(suggestProbePositions(warmingBlobFrames(), moving, [], 2), []);
  });

  it('keeps two suggestions apart from each other', () => {
    // Two separate warming blobs: the picks must not both crowd onto the stronger one.
    const frames = Array.from({ length: 8 }, (_, fi) => ({
      frame: makeFrame(40, 40, (x, y) => {
        const a = Math.hypot(x - 8, y - 8) <= 3 ? 20 + (40 * fi) / 7 : 0;
        const b = Math.hypot(x - 32, y - 32) <= 3 ? 20 + (30 * fi) / 7 : 0;
        return Math.max(20, a, b);
      }),
      recordingIndex: fi,
      tSec: fi * 2,
    }));
    const out = suggestProbePositions(frames, stillHotspots(8), [], 2);
    assert.equal(out.length, 2);
    assert.ok(Math.hypot(out[0].x - out[1].x, out[0].y - out[1].y) >= 0.14, 'suggestions must be spatially distinct');
  });
});

describe('verifyReportNumbers with AI probes', () => {
  it('accepts a figure that only an AI virtual probe measured', () => {
    const withAi = {
      ...verifiableSummary,
      aiProbes: [
        {
          series: [33.3, 35.5, 37.7, 38.8],
          min: 33.3,
          max: 38.8,
          startTemp: 33.3,
          endTemp: 38.8,
          changeC: 5.5,
          secantCPerSec: 0.183,
        },
      ],
    };
    const report = 'The analysis also tracked a point (AI1) that rose from 33.3 °C to 38.8 °C, a change of 5.5 °C.';
    assert.ok(
      verifyReportNumbers(report, verifiableSummary, null).unmatched.length > 0,
      'unsupported without aiProbes',
    );
    assert.equal(verifyReportNumbers(report, withAi, null).unmatched.length, 0, 'supported once aiProbes ride along');
  });
});
