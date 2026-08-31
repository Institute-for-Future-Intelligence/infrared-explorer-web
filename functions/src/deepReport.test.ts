/**
 * Tests for the deep-analysis tools.
 *
 * These run mid-generation and their answers are quoted in the report, so the properties that matter are
 * that a tool never throws (a failed lookup must not abort a half-written report), that it never invents
 * an answer when it cannot give one, and that the image budget is actually enforced — every image is
 * re-sent on every later round, so an unbounded view_frames is unbounded cost.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRawFrame, INTSIZE, type DecodedFrame } from './thermal';
import { buildAnalysisDigest, type KeptFrame } from './analysis';
import { binFrame, executeDeepTool, DEEP_REPORT_TOOLS, type DeepToolContext } from './deepReport';

const makeFrame = (w: number, h: number, tempAt: (x: number, y: number) => number): DecodedFrame => {
  const raw = new Uint8Array(w * h * INTSIZE);
  const dv = new DataView(raw.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      dv.setUint16((y * w + x) * INTSIZE + 2, Math.round((tempAt(x, y) + 273.15) * 100), false);
    }
  }
  return decodeRawFrame(raw, w, h);
};

const TIMES = [0, 10, 20, 30, 40, 50];
const SERIES = TIMES.map((t) => 20 + 40 * Math.exp(-t / 20));

const frames: KeptFrame[] = TIMES.map((t, i) => ({
  frame: makeFrame(40, 40, (x) => (x < 20 ? 20 : SERIES[i])),
  recordingIndex: i,
  tSec: t,
}));

const summary = {
  times: TIMES,
  thermometers: [{ label: 'T1', position: { x: 0.75, y: 0.5 }, series: SERIES }],
  frameGlobal: TIMES.map((t, i) => ({
    t,
    min: 20,
    max: SERIES[i],
    mean: (20 + SERIES[i]) / 2,
    p02: 20,
    p98: SERIES[i],
  })),
  sampleIndex: TIMES.map((t, i) => ({ t, frame: i })),
};

const digest = buildAnalysisDigest({
  times: TIMES,
  thermometers: [{ label: 'T1', series: SERIES }],
  frameGlobal: summary.frameGlobal.map((g) => ({ ...g, hotspot: { x: 0.75, y: 0.5 } })),
  frames,
  profileLines: [],
});

const makeCtx = (over: Partial<DeepToolContext> = {}): DeepToolContext => ({
  summary,
  digest,
  frames,
  imagesLeft: 4,
  loadImages: async (times) =>
    times.flatMap((t) => [
      { type: 'text' as const, text: `frame ${t}` },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: 'AA==' } },
    ]),
  ...over,
});

const json = (text: string) => JSON.parse(text) as Record<string, unknown>;

describe('DEEP_REPORT_TOOLS', () => {
  it('declares every tool the executor implements, and nothing it does not', async () => {
    const ctx = makeCtx();
    for (const tool of DEEP_REPORT_TOOLS) {
      const res = await executeDeepTool(tool.name, {}, ctx);
      assert.ok(!res.text.startsWith('Unknown tool'), `${tool.name} is declared but not implemented`);
    }
    const unknown = await executeDeepTool('not_a_tool', {}, ctx);
    assert.match(unknown.text, /^Unknown tool/);
  });
});

describe('executeDeepTool', () => {
  it('find_events returns the turning points and the phases behind them', async () => {
    const out = json((await executeDeepTool('find_events', {}, makeCtx())).text);
    assert.ok(Array.isArray(out.events));
    assert.ok(Array.isArray(out.phases));
  });

  it('get_frame_stats snaps to the nearest sample and says which one it used', async () => {
    const out = json((await executeDeepTool('get_frame_stats', { tSec: 23 }, makeCtx())).text);
    assert.equal(out.askedForT, 23);
    assert.equal(out.nearestSampleT, 20, 'should snap to the sample at t=20');
    assert.deepEqual((out.probes as { label: string }[])[0].label, 'T1');
  });

  it('fit_curve recovers the synthetic time constant over the whole clip', async () => {
    const out = json((await executeDeepTool('fit_curve', { thermometer: 'T1' }, makeCtx())).text);
    assert.ok(Math.abs((out.tau as number) - 20) < 2, `tau should be ~20, got ${out.tau}`);
    assert.equal(out.direction, 'cooling');
  });

  it('fit_curve names the probes that exist rather than guessing', async () => {
    const out = await executeDeepTool('fit_curve', { thermometer: 'T9' }, makeCtx());
    assert.match(out.text, /No probe called "T9"/);
    assert.match(out.text, /T1/);
  });

  it('fit_curve reports a null fit explicitly instead of returning nothing', async () => {
    const flat = makeCtx({
      summary: { ...summary, thermometers: [{ label: 'T1', position: { x: 0, y: 0 }, series: TIMES.map(() => 25) }] },
    });
    const out = json((await executeDeepTool('fit_curve', { thermometer: 'T1' }, flat)).text);
    assert.equal(out.fit, null);
    assert.match(String(out.note), /do not claim Newton cooling/i);
  });

  it('get_line_profile measures across the frame and reports how linear it is', async () => {
    const out = json(
      (await executeDeepTool('get_line_profile', { x1: 0, y1: 0.5, x2: 1, y2: 0.5, tSec: 0 }, makeCtx())).text,
    );
    const ends = out.endpoints as { a: number; b: number };
    assert.ok(ends.b > ends.a + 10, 'the hot half must read hotter');
    assert.equal(out.nearestSampleT, 0);
  });

  it('get_histogram splits the frame into the requested number of bins', async () => {
    const out = json((await executeDeepTool('get_histogram', { tSec: 0, bins: 8 }, makeCtx())).text);
    const bins = out.bins as { pct: number }[];
    assert.equal(bins.length, 8);
    closeToPct(
      bins.reduce((s, b) => s + b.pct, 0),
      100,
    );
  });

  it('get_histogram clamps an absurd bin count instead of failing', async () => {
    const tiny = json((await executeDeepTool('get_histogram', { tSec: 0, bins: 1 }, makeCtx())).text);
    assert.equal((tiny.bins as unknown[]).length, 4, 'clamped up to the minimum');
    const huge = json((await executeDeepTool('get_histogram', { tSec: 0, bins: 5000 }, makeCtx())).text);
    assert.equal((huge.bins as unknown[]).length, 40, 'clamped down to the maximum');
  });

  it('view_frames spends the image budget and then refuses politely', async () => {
    const ctx = makeCtx({ imagesLeft: 2 });
    const first = await executeDeepTool('view_frames', { tSecs: [0, 20] }, ctx);
    assert.equal(first.images.filter((b) => b.type === 'image').length, 2);
    assert.equal(ctx.imagesLeft, 0);
    const second = await executeDeepTool('view_frames', { tSecs: [30] }, ctx);
    assert.equal(second.images.length, 0);
    assert.match(second.text, /budget/i);
  });

  it('view_frames looks at no more than three instants at once', async () => {
    const ctx = makeCtx({ imagesLeft: 99 });
    const out = await executeDeepTool('view_frames', { tSecs: [0, 10, 20, 30, 40, 50] }, ctx);
    assert.equal(out.images.filter((b) => b.type === 'image').length, 3);
  });

  it('turns a thrown loader into an answer, not an aborted report', async () => {
    const ctx = makeCtx({
      loadImages: async () => {
        throw new Error('storage exploded');
      },
    });
    const out = await executeDeepTool('view_frames', { tSecs: [0] }, ctx);
    assert.match(out.text, /failed/i);
    assert.equal(out.images.length, 0);
  });

  it('rejects malformed arguments without throwing', async () => {
    const ctx = makeCtx();
    for (const [name, args] of [
      ['get_frame_stats', {}],
      ['get_line_profile', { x1: 0 }],
      ['get_histogram', { tSec: 'soon' }],
      ['view_frames', { tSecs: [] }],
    ] as const) {
      const out = await executeDeepTool(name, args, ctx);
      assert.ok(out.text.length > 0, `${name} must explain itself`);
    }
  });

  it('says so plainly when there are no frames to read', async () => {
    const empty = makeCtx({ frames: [] });
    const out = await executeDeepTool('get_frame_stats', { tSec: 0 }, empty);
    assert.match(out.text, /No decoded frames/);
  });
});

describe('binFrame', () => {
  it('puts every pixel in exactly one bin', () => {
    const bins = binFrame(
      makeFrame(20, 20, (x) => 20 + x),
      20,
      40,
      10,
    );
    closeToPct(
      bins.reduce((s, b) => s + b.pct, 0),
      100,
    );
  });

  it('clamps pixels outside the stated range into the edge bins', () => {
    // 380 °C, not something wilder: the wire format is a uint16 of centi-Kelvin, so it tops out around
    // 382 °C and a hotter fixture would silently wrap to a NEGATIVE temperature.
    const hot = binFrame(
      makeFrame(10, 10, () => 380),
      20,
      40,
      5,
    );
    assert.equal(hot[hot.length - 1].pct, 100, 'everything above the range lands in the top bin');
    const cold = binFrame(
      makeFrame(10, 10, () => 5),
      20,
      40,
      5,
    );
    assert.equal(cold[0].pct, 100, 'everything below the range lands in the bottom bin');
  });
});

function closeToPct(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 0.5, `expected ~${expected}%, got ${actual}%`);
}

describe('sample_frames', () => {
  it('says plainly when resampling is unavailable rather than failing', async () => {
    const out = await executeDeepTool('sample_frames', { tSecs: [5] }, makeCtx());
    assert.match(out.text, /cannot be resampled/);
  });

  it('parses the requested instants, caps them at ten, and delegates to the caller', async () => {
    let got: number[] = [];
    const ctx = makeCtx({
      sampleFrames: async (ts) => {
        got = ts;
        return 'sampled';
      },
    });
    const out = await executeDeepTool(
      'sample_frames',
      { tSecs: [...Array.from({ length: 14 }, (_, i) => i), 'soon'] },
      ctx,
    );
    assert.equal(out.text, 'sampled');
    assert.equal(got.length, 10, 'at most ten per call');
  });

  it('rejects a call with no usable times', async () => {
    const ctx = makeCtx({ sampleFrames: async () => 'sampled' });
    const out = await executeDeepTool('sample_frames', { tSecs: ['later'] }, ctx);
    assert.match(out.text, /at least one time/);
  });
});

describe('fit_curve on AI virtual probes', () => {
  it('fits an AI probe by its label, and lists it among the available ones', async () => {
    const ctx = makeCtx({
      summary: { ...summary, aiProbes: [{ label: 'AI1', position: { x: 0.2, y: 0.2 }, series: SERIES }] },
    });
    const out = json((await executeDeepTool('fit_curve', { thermometer: 'ai1' }, ctx)).text);
    assert.ok(Math.abs((out.tau as number) - 20) < 2, `tau should be ~20, got ${out.tau}`);
    const missing = await executeDeepTool('fit_curve', { thermometer: 'T9' }, ctx);
    assert.match(missing.text, /AI1/);
  });
});

describe('deep tools on freshly sampled instants', () => {
  // A frame that exists in ctx.frames but NOT in the summary arrays — the state sample_frames used to
  // leave behind. The tools must answer from the pixels rather than returning nulls or binning a 25 °C
  // scene over a made-up 0-1 °C domain.
  const strayFrame: KeptFrame = { frame: makeFrame(40, 40, (x) => (x < 20 ? 22 : 30)), recordingIndex: 99, tSec: 7.5 };

  it('get_frame_stats computes from the pixels when the summary lookup misses', async () => {
    const ctx = makeCtx({ frames: [...frames, strayFrame] });
    const out = json((await executeDeepTool('get_frame_stats', { tSec: 7.5 }, ctx)).text);
    assert.equal(out.nearestSampleT, 7.5);
    const whole = out.whole as { min: number; max: number };
    assert.ok(whole && Math.abs(whole.min - 22) < 0.1, `whole-frame stats must be real, got ${JSON.stringify(whole)}`);
    const probes = out.probes as { label: string; tempC: number | null }[];
    assert.ok(
      probes.every((p) => typeof p.tempC === 'number'),
      'no probe may read null on a frame in hand',
    );
  });

  it('get_frame_stats reports the AI virtual probes too', async () => {
    const ctx = makeCtx({
      summary: { ...summary, aiProbes: [{ label: 'AI1', position: { x: 0.1, y: 0.1 }, series: SERIES }] },
    });
    const out = json((await executeDeepTool('get_frame_stats', { tSec: 0 }, ctx)).text);
    assert.ok(
      (out.probes as { label: string }[]).some((p) => p.label === 'AI1'),
      'AI1 must appear among the probe readings',
    );
  });

  it("get_histogram bins over the frame's real range when the summary lookup misses", async () => {
    const ctx = makeCtx({ frames: [...frames, strayFrame] });
    const out = json((await executeDeepTool('get_histogram', { tSec: 7.5, bins: 8 }, ctx)).text);
    assert.ok((out.minC as number) > 15, `domain must come from the pixels, got minC=${out.minC}`);
    const bins = out.bins as { pct: number }[];
    closeToPct(
      bins.reduce((s, b) => s + b.pct, 0),
      100,
    );
  });
});

describe('tool results feed the verifier', () => {
  it('fit_curve reports its tau (and small multiples) and asymptote as legal values', async () => {
    const out = await executeDeepTool('fit_curve', { thermometer: 'T1' }, makeCtx());
    const body = json(out.text);
    assert.ok(out.legal, 'a successful fit must declare its numbers');
    assert.ok(out.legal.times?.includes(body.tau as number), 'tau is a citable time');
    assert.ok(out.legal.times?.includes(3 * (body.tau as number)), '3*tau too — the prompt asks for it');
    assert.ok(out.legal.temps?.includes(body.tInf as number), 'the asymptote is a citable temperature');
  });

  it('get_line_profile declares its endpoints, extremes, delta and samples', async () => {
    const out = await executeDeepTool('get_line_profile', { x1: 0, y1: 0.5, x2: 1, y2: 0.5, tSec: 0 }, makeCtx());
    const body = json(out.text);
    const ends = body.endpoints as { a: number; b: number };
    for (const v of [ends.a, ends.b, body.minC as number, body.maxC as number]) {
      assert.ok(out.legal?.temps?.includes(v), `${v} must be legal to cite`);
    }
  });

  it('get_frame_stats and get_histogram declare theirs too', async () => {
    const stats = await executeDeepTool('get_frame_stats', { tSec: 0 }, makeCtx());
    assert.ok((stats.legal?.temps?.length ?? 0) > 0, 'frame stats carry citable temperatures');
    const hist = await executeDeepTool('get_histogram', { tSec: 0, bins: 6 }, makeCtx());
    const body = json(hist.text);
    assert.ok(hist.legal?.temps?.includes(body.minC as number), 'the histogram domain is citable');
  });

  it('a failed lookup carries no legal values', async () => {
    const out = await executeDeepTool('fit_curve', { thermometer: 'T9' }, makeCtx());
    assert.equal(out.legal, undefined);
  });
});
