import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatDelta, referenceColumn, referenceCsvRows, relativeToReference } from './referenceSeries';
import { fitNewtonCooling } from './curveFit';

describe('relativeToReference', () => {
  const rows = [
    { time: 0, T1: 19.8, T2: 19.9, T3: 19.9 },
    { time: 30, T1: 19.39, T2: 18.62, T3: 18.71 },
    { time: 60, T1: 19.85, T2: 19.48, T3: 19.5 },
  ];
  const keys = ['T1', 'T2', 'T3'];

  it('plots every series as its difference from the reference at the same row', () => {
    const out = relativeToReference(rows, keys, 'T1');
    assert.deepEqual(out, [
      { time: 0, T1: 0, T2: 0.1, T3: 0.1 },
      { time: 30, T1: 0, T2: -0.77, T3: -0.68 },
      { time: 60, T1: 0, T2: -0.37, T3: -0.35 },
    ]);
  });

  it('leaves the measured rows as they were', () => {
    const before = JSON.stringify(rows);
    relativeToReference(rows, keys, 'T1', true);
    assert.equal(JSON.stringify(rows), before);
  });

  it('takes out a drift every probe shares, steps included', () => {
    // A slow dip in T2 under a drift that ramps and then jumps by 0.4 — the same for both probes.
    const drift = [0, 0.1, 0.2, 0.6, 0.7, 0.3];
    const signal = [0, -0.5, -0.8, -0.6, -0.4, -0.2];
    const measured = drift.map((d, i) => ({ time: i, T1: 20 + d, T2: 20 + d + signal[i] }));
    const out = relativeToReference(measured, ['T1', 'T2'], 'T1');
    assert.deepEqual(
      out.map((r) => r.T2),
      signal,
    );
    assert.ok(out.every((r) => r.T1 === 0));
  });

  it('with zero, starts every curve at 0 by dropping its difference at the first sample', () => {
    const out = relativeToReference(rows, keys, 'T1', true);
    assert.deepEqual(
      out.map((r) => [r.T1, r.T2, r.T3]),
      [
        [0, 0, 0],
        [0, -0.87, -0.78],
        [0, -0.47, -0.45],
      ],
    );
  });

  it('zeroes on the first row where both the series and the reference were read', () => {
    const gappy = [
      { time: 0, T1: null, T2: 21 },
      { time: 1, T1: 20, T2: null },
      { time: 2, T1: 20, T2: 20.5 },
      { time: 3, T1: 20.2, T2: 20.1 },
    ];
    const out = relativeToReference(gappy, ['T1', 'T2'], 'T1', true);
    assert.deepEqual(
      out.map((r) => r.T2),
      [null, null, 0, -0.6],
    );
  });

  it('leaves a gap where the series or the reference has no reading', () => {
    const gappy = [
      { time: 0, T1: 20, T2: 21, frameMax: null },
      { time: 1, T1: null, T2: 21, frameMax: 30 },
      { time: 2, T1: 20, T2: NaN, frameMax: 30 },
    ];
    const out = relativeToReference(gappy, ['T1', 'T2', 'frameMax'], 'T1');
    assert.deepEqual(out, [
      { time: 0, T1: 0, T2: 1, frameMax: null },
      { time: 1, T1: null, T2: null, frameMax: null },
      { time: 2, T1: 0, T2: null, frameMax: 10 },
    ]);
  });

  it('gives all gaps for a reference key the rows do not carry', () => {
    const out = relativeToReference(rows, ['T2'], 'T9');
    assert.deepEqual(
      out.map((r) => r.T2),
      [null, null, null],
    );
  });

  it('is the same difference in °F: the +32 cancels', () => {
    const f = (c: number) => c * 1.8 + 32;
    const inF = rows.map((r) => ({ time: r.time, T1: f(r.T1), T2: f(r.T2) }));
    const out = relativeToReference(inF, ['T1', 'T2'], 'T1');
    assert.deepEqual(
      out.map((r) => r.T2),
      [0.18, -1.386, -0.666],
    );
  });

  it('makes a recovery the cooling fit can read, where the measured curve was not one', () => {
    // T2 dips 1° below the control and recovers with τ = 300 s; both ride a drift with a step in it.
    const measured = Array.from({ length: 40 }, (_, i) => {
      const t = i * 30;
      const drift = 0.3 * Math.sin(t / 200) + (t > 600 ? 0.4 : 0);
      return { time: t, T1: 20 + drift, T2: 20 + drift - Math.exp(-t / 300) };
    });
    const out = relativeToReference(measured, ['T1', 'T2'], 'T1');
    const fit = fitNewtonCooling(out.map((r) => ({ t: r.time, T: r.T2 as number })));
    assert.ok(fit);
    assert.ok(Math.abs(fit.tau - 300) < 3, `tau ${fit.tau}`);
    assert.ok(Math.abs(fit.tInf) < 0.01, `tInf ${fit.tInf}`);
    assert.equal(fit.direction, 'heating');
    assert.ok(fit.r2 > 0.999);
  });
});

describe('referenceCsvRows', () => {
  it('keeps the measured columns and adds one difference column per other series', () => {
    const raw = [
      { time: 0, T1: 19.8, T2: 19.9 },
      { time: 30, T1: 19.39, T2: 18.62 },
    ];
    const rel = relativeToReference(raw, ['T1', 'T2'], 'T1');
    assert.deepEqual(referenceCsvRows(raw, rel, ['T1', 'T2'], 'T1'), [
      { time: 0, T1: 19.8, T2: 19.9, 'T2 - T1': 0.1 },
      { time: 30, T1: 19.39, T2: 18.62, 'T2 - T1': -0.77 },
    ]);
  });

  it('says so in the column name when the differences are zeroed', () => {
    assert.equal(referenceColumn('T2', 'T1'), 'T2 - T1');
    assert.equal(referenceColumn('frameMax', 'T3', true), 'frameMax - T3 (zeroed at start)');
    const raw = [{ time: 0, T1: 20, T2: 21 }];
    const rel = relativeToReference(raw, ['T1', 'T2'], 'T1', true);
    assert.deepEqual(Object.keys(referenceCsvRows(raw, rel, ['T1', 'T2'], 'T1', true)[0]), [
      'time',
      'T1',
      'T2',
      'T2 - T1 (zeroed at start)',
    ]);
  });
});

describe('formatDelta', () => {
  it('signs a difference and never writes a negative zero', () => {
    assert.equal(formatDelta(0.123), '+0.12');
    assert.equal(formatDelta(-0.77), '-0.77');
    assert.equal(formatDelta(0), '0.00');
    assert.equal(formatDelta(-0.001), '0.00');
    assert.equal(formatDelta(0.004), '0.00');
    assert.equal(formatDelta(-1.26, 1), '-1.3');
  });
});
