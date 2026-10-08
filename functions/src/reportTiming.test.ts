/**
 * Tests for the report timing recorder.
 *
 * The record is what the latency proposal (app repo docs/proposals/ai-report-latency.md §7.0) will be
 * argued from, so the properties that matter are: every stage lands under its own name, rounds are
 * classified the way the proposal counts them (a view round is one whose every tool is view_frames),
 * an unstreamed write-up is told apart from a streamed one, the first-token mark comes from the first
 * NON-EMPTY text chunk only, the outcome follows the thrown error, the record is written even when the
 * handler throws, a sink that fails never fails the report, and nothing the summary emits is a nested
 * array (Firestore refuses those).
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpsError, type CallableRequest, type CallableResponse } from 'firebase-functions/v2/https';
import {
  countFigureMarkers,
  ReportTimingRecorder,
  reportTiming,
  withReportTiming,
  type ReportTimingSummary,
} from './reportTiming';

/** A recorder on a fake clock, so durations are exact. */
function clocked(start = 1_000) {
  let now = start;
  const rec = new ReportTimingRecorder(start, () => now);
  return { rec, tick: (ms: number) => (now += ms) };
}

const request = { data: {}, auth: null, rawRequest: {} } as unknown as CallableRequest;

describe('ReportTimingRecorder', () => {
  it('records each stage under its own name and the total', () => {
    const { rec, tick } = clocked();
    rec.stage('access', 1200);
    rec.stage('load', 2500.4);
    rec.stage('seed', 800);
    rec.stage('verify', 3);
    rec.stage('persist', 400);
    tick(10_000);
    rec.finish('ok');
    const s = rec.summary();
    assert.deepEqual(s.timing, {
      accessMs: 1200,
      loadMs: 2500,
      seedMs: 800,
      writeTtftMs: null,
      writeMs: null,
      verifyMs: 3,
      persistMs: 400,
      totalMs: 10_000,
    });
    assert.equal(s.outcome, 'ok');
    assert.equal(s.event, 'ai_report_timing');
  });

  it('classifies rounds: all-view_frames is a view round, anything else numeric', () => {
    const { rec } = clocked();
    rec.round({ ms: 2100, tools: ['find_events'], images: 0 });
    rec.round({ ms: 3000, tools: ['view_frames'], images: 3 });
    rec.round({ ms: 2500, tools: ['fit_curve', 'view_frames'], images: 2 });
    rec.round({ ms: 100, tools: [], images: 0 });
    const s = rec.summary();
    assert.deepEqual(s.rounds, { numeric: 3, view: 1 });
    assert.deepEqual(s.roundMs, [2100, 3000, 2500, 100]);
    assert.deepEqual(s.roundTools, ['find_events', 'view_frames', 'fit_curve,view_frames', '']);
    assert.deepEqual(s.toolCalls, { find_events: 1, view_frames: 2, fit_curve: 1 });
    assert.equal(s.imagesViewed, 5);
  });

  it('tells an unstreamed write-up (inside a tool round) from a streamed one', () => {
    const a = clocked();
    a.rec.writeUnstreamed(17_000);
    let s = a.rec.summary();
    assert.equal(s.writeStreamed, false);
    assert.equal(s.timing.writeMs, 17_000);
    assert.equal(s.timing.writeTtftMs, null);

    const b = clocked();
    b.rec.writeStarted();
    b.tick(4_000);
    b.rec.firstText();
    b.tick(16_000);
    b.rec.writeDone();
    s = b.rec.summary();
    assert.equal(s.writeStreamed, true);
    assert.equal(s.timing.writeTtftMs, 4_000);
    assert.equal(s.timing.writeMs, 20_000);
  });

  it('marks the first token on the first non-empty text chunk only, through the stream proxy', async () => {
    const { rec, tick } = clocked();
    const sent: unknown[] = [];
    const response = {
      sendChunk: async (chunk: unknown) => {
        sent.push(chunk);
        return true;
      },
      acceptsStreaming: true,
      signal: new AbortController().signal,
    } as unknown as CallableResponse;
    const watched = rec.watchStream(response)!;
    rec.writeStarted();
    tick(1_000);
    await watched.sendChunk({ text: '' }); // the reset chunk the fallback sends — not report text
    tick(2_000);
    await watched.sendChunk({ text: '# Cooling' });
    tick(5_000);
    await watched.sendChunk({ text: ' of water' });
    rec.writeDone();
    const s = rec.summary();
    assert.equal(s.timing.writeTtftMs, 3_000);
    assert.equal(s.timing.writeMs, 8_000);
    assert.equal(sent.length, 3, 'every chunk still reaches the real response');
    assert.equal(watched.acceptsStreaming, true, 'the proxy passes the other members through');
    assert.equal(rec.watchStream(undefined), undefined);
  });

  it('a fallback after a half-streamed deep write-up measures its own first token', () => {
    const { rec, tick } = clocked();
    rec.writeStarted();
    tick(2_000);
    rec.firstText();
    rec.fallback();
    rec.writeStarted(); // the fallback's call
    tick(6_000);
    rec.firstText();
    tick(1_000);
    rec.writeDone();
    const s = rec.summary();
    assert.equal(s.fallback, true);
    assert.equal(s.timing.writeTtftMs, 6_000);
    assert.equal(s.timing.writeMs, 7_000);
  });

  it('summarises the verification, the correction and the report', () => {
    const { rec } = clocked();
    rec.verification({
      checked: 40,
      matched: 38,
      unmatched: [
        { text: 'T1 = 23.4 °C', kind: 'temperature' },
        { text: 't = 48 s', kind: 'time' },
      ],
    });
    rec.correction({ ms: 12_000.6, before: 3, after: 2, applied: true });
    rec.report('# Title\n\n[figure: t = 4 s | start]\ntext\n  [Figure: t = 48 s | peak]\n');
    const s = rec.summary();
    assert.equal(s.checked, 40);
    assert.equal(s.matched, 38);
    assert.deepEqual(s.unmatchedByKind, { temperature: 1, time: 1, rate: 0 });
    assert.deepEqual(s.unmatched, [
      { text: 'T1 = 23.4 °C', kind: 'temperature' },
      { text: 't = 48 s', kind: 'time' },
    ]);
    assert.deepEqual(s.correction, { ms: 12_001, before: 3, after: 2, applied: true });
    assert.equal(s.figures, 2);
    assert.equal(s.reportChars, 68);
  });

  it('caps the unmatched list at 12, like the persisted record', () => {
    const { rec } = clocked();
    rec.verification({
      checked: 30,
      matched: 10,
      unmatched: Array.from({ length: 20 }, (_, i) => ({ text: `v${i}`, kind: 'rate' as const })),
    });
    const s = rec.summary();
    assert.equal(s.unmatched.length, 12);
    assert.equal(s.unmatchedByKind.rate, 20, 'the per-kind counts cover all of them');
  });

  it('keeps the owner off the summary and truncates a failure message', () => {
    const { rec } = clocked();
    rec.ownerId = 'owner-1';
    rec.finish('failed', new Error('x'.repeat(500)));
    const s = rec.summary();
    assert.equal((s as unknown as Record<string, unknown>).ownerId, undefined);
    assert.equal(s.outcome, 'failed');
    assert.equal(s.error?.length, 200);
    const ok = clocked().rec;
    ok.finish('ok');
    assert.equal('error' in ok.summary(), false, 'no error key on a success (Firestore rejects undefined)');
  });

  it('emits nothing Firestore refuses: no nested arrays, no undefined values', () => {
    const { rec } = clocked();
    rec.round({ ms: 1, tools: ['fit_curve', 'get_histogram'], images: 0 });
    rec.finish('ok');
    const walk = (v: unknown, path: string, inArray: boolean): void => {
      assert.notEqual(v, undefined, `undefined at ${path}`);
      if (Array.isArray(v)) {
        assert.equal(inArray, false, `nested array at ${path}`);
        v.forEach((x, i) => walk(x, `${path}[${i}]`, true));
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, false);
      }
    };
    walk(rec.summary(), '$', false);
  });
});

describe('countFigureMarkers', () => {
  it('counts marker lines only', () => {
    assert.equal(countFigureMarkers('no markers'), 0);
    assert.equal(
      countFigureMarkers('[figure: t = 1 s | a]\nx [figure: t = 2 s | inline, not a line]\n[figure: t = 3 s | b]'),
      2,
    );
  });
});

describe('withReportTiming', () => {
  it('scopes a recorder, writes the record on success and hands the owner to the sink', async () => {
    const logged: ReportTimingSummary[] = [];
    const persisted: { summary: ReportTimingSummary; owner: string | null }[] = [];
    const handler = withReportTiming(
      async () => {
        const t = reportTiming();
        t.ownerId = 'u1';
        t.set({ ref: 'exp1', model: 'gpt56', tier: 'staff' });
        t.modelStarted();
        return 'done';
      },
      {
        log: (s) => logged.push(s),
        persist: async (s, rec) => {
          persisted.push({ summary: s, owner: rec.ownerId });
        },
      },
    );
    assert.equal(await handler(request), 'done');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].outcome, 'ok');
    assert.equal(logged[0].ref, 'exp1');
    assert.equal(logged[0].modelStarted, true);
    assert.deepEqual(
      persisted.map((p) => p.owner),
      ['u1'],
    );
  });

  it('a cancelled HttpsError is a cancel, any other throw a failure, and both are logged and rethrown', async () => {
    const outcomes: string[] = [];
    const sink = { log: (s: ReportTimingSummary) => outcomes.push(s.outcome) };
    const cancelled = withReportTiming(async () => {
      throw new HttpsError('cancelled', 'Report generation was cancelled.');
    }, sink);
    await assert.rejects(cancelled(request), (e: unknown) => e instanceof HttpsError && e.code === 'cancelled');
    const failed = withReportTiming(async () => {
      throw new Error('provider down');
    }, sink);
    await assert.rejects(failed(request), /provider down/);
    assert.deepEqual(outcomes, ['cancelled', 'failed']);
  });

  it('a sink that throws never fails the report', async () => {
    const warnings: string[] = [];
    const handler = withReportTiming(
      async () => 42,
      {
        log: () => {
          throw new Error('stdout closed');
        },
        persist: async () => {
          throw new Error('firestore down');
        },
      },
      (message) => warnings.push(message),
    );
    assert.equal(await handler(request), 42);
    // Each half is guarded on its own: a failed log line does not cost the audit copy, and vice versa.
    assert.deepEqual(warnings, ['ai_report_timing log failed', 'aiReportAudit write failed']);
  });

  it('outside a scope, reportTiming() is a detached recorder that never throws', () => {
    const t = reportTiming();
    t.round({ ms: 1, tools: [], images: 0 });
    t.writeStarted();
    t.firstText();
    t.writeDone();
    assert.equal(t.summary().rounds.numeric, 1);
    assert.notEqual(reportTiming(), t, 'each call outside a scope is its own throwaway');
  });

  it('nested async work sees the same recorder', async () => {
    let inner: ReportTimingRecorder | null = null;
    let outer: ReportTimingRecorder | null = null;
    const handler = withReportTiming(
      async () => {
        outer = reportTiming();
        await new Promise((r) => setTimeout(r, 1));
        await (async () => {
          inner = reportTiming();
        })();
      },
      { log: () => {} },
    );
    await handler(request);
    assert.ok(outer && inner && outer === inner);
  });
});

describe('ReportTimingRecorder write-up marks', () => {
  it('a provisional write-up that turns out to be a tool round leaves no marks', () => {
    const { rec, tick } = clocked();
    rec.writeStarted();
    tick(3_000);
    rec.firstText();
    rec.writeAbandoned();
    rec.round({ ms: 3_000, tools: ['fit_curve'], images: 0 });
    const s = rec.summary();
    assert.equal(s.writeStreamed, null);
    assert.equal(s.timing.writeTtftMs, null);
    assert.equal(s.timing.writeMs, null);
    assert.deepEqual(s.rounds, { numeric: 1, view: 0 });
  });
});
