/**
 * Deep analysis — the opt-in mode where the report model can ask its own questions of the data.
 *
 * The standard path is a fixed pipeline: the server computes a digest and the model explains it. That
 * covers the common case well and costs one model call. What it cannot do is answer a question the model
 * raises while writing — "is T2's dip real, or a sampling artefact?", "how steep is the boundary at
 * t = 40 s?", "what does the distribution look like once the plate is hot?" — because nobody knew to
 * compute that in advance.
 *
 * So deep mode hands the model a small set of tools over the SAME frames the digest was built from, and
 * lets it drill in. Everything here is pure computation on data already in memory: no Storage reads, no
 * Firestore, no second decode. The only tool that costs anything is view_frames, which loads images —
 * and it is budgeted, because every image is re-sent on every subsequent round of the loop.
 *
 * Deliberately NOT the default. The digest answers the common case in one call; a tool loop is three to
 * five, with images multiplying each one, and a model that decides not to call anything produces a report
 * no better than the standard path for several times the cost.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { celsiusAtIndex, celsiusAtPoint, frameStats, type DecodedFrame } from './thermal';
import {
  arrivalStep,
  buildAnalysisDigest,
  fitNewtonCooling,
  linearFit,
  nextAiProbeNumber,
  reduceSeries,
  sampleLineProfile,
  type AnalysisAxis,
  type AnalysisDigest,
  type ExtraLegalValues,
  type KeptFrame,
  type ProfileLineLike,
} from './analysis';

/** A probe as the summary carries it; the virtual ones carry the same statistics so the verifier and
 *  the digest card read them like any other. */
export interface DeepProbe {
  label: string;
  position: { x: number; y: number };
  series: number[];
  min?: number | null;
  max?: number | null;
  startTemp?: number | null;
  endTemp?: number | null;
  changeC?: number | null;
  secantCPerSec?: number | null;
}

/** The measured context the tools read. Structural, so the caller can pass its summary straight in. */
export interface DeepSummary {
  times: number[];
  thermometers: DeepProbe[];
  /** The virtual probes the model placed with place_probe (AI1..) — addressable by fit_curve and read
   *  by sample_frames like any probe. Filled in by the tool as the run goes. */
  aiProbes?: DeepProbe[];
  frameGlobal: {
    t: number;
    min: number;
    max: number;
    mean: number;
    hotspot?: { x: number; y: number };
    p02?: number;
    p98?: number;
  }[];
  sampleIndex: { t: number; frame: number }[];
}

/**
 * A virtual probe the model placed for this report (place_probe). Never written to the experiment: it
 * lives with the report, which draws it on its figures, and the next report starts without it.
 */
export interface VirtualProbe {
  label: string;
  x: number;
  y: number;
  /** The model's own words for what the point is on and why — quoted in the report. */
  reason: string;
}

export interface DeepToolContext {
  summary: DeepSummary;
  digest: AnalysisDigest;
  frames: KeptFrame[];
  /** Loads frame images for the given instants; the caller owns the storage/rendering details. */
  loadImages: (times: number[]) => Promise<Anthropic.ContentBlockParam[]>;
  /** Images still allowed across the whole run. Mutated as view_frames spends it. */
  imagesLeft: number;
  /**
   * Reads NEW frames the sampling pass never decoded, at the requested instants — the caller owns the
   * budget, the Storage/vir access and the merge into `frames`, and returns the JSON text the model
   * sees. Absent when the caller cannot read more (no locator), and the tool says so instead of failing.
   */
  sampleFrames?: (tSecs: number[]) => Promise<string>;
  /** What every `tSec` means: seconds into a clip (the default), or a photo's number in a photo set. */
  axis?: AnalysisAxis;
  /** The virtual probes placed so far, in placement order — the tool appends, the caller persists them
   *  with the report. Absent ⇒ place_probe answers that it cannot place here (a photo set, a video). */
  placed?: VirtualProbe[];
}

/** Most virtual probes one report may place. Four: a reference and a comparison or two is a method;
 *  more is a survey, and every one costs a row of the table and a paragraph. */
const PLACE_PROBE_MAX = 4;
/** The model reads its coordinates off a thumbnail, and a ruler is 0.08 of the frame wide: the reading
 *  is taken at the most informative pixel within this (normalized) radius of the point it named. */
const PLACE_SNAP_RADIUS = 0.05;
/** A pixel has to swing at least this much (above the scene's floor) for the snap to prefer it over the
 *  point the model named; below it the frame is flat there and the named point is as good as any. */
const PLACE_SNAP_MIN_RANGE_C = 0.5;

/** Most instants the model may ask to see at once. Eight (from three): the prompt asks for everything
 *  worth seeing in ONE round, and a round costs a model turn whatever it carries. */
const VIEW_FRAMES_MAX = 8;

/** The tools that only make sense on a clock — a photo set's shots are not a series in time. A virtual
 *  probe is a series too: on separate shots it would read a different object on every photo. */
const TIME_ONLY_TOOLS = new Set(['fit_curve', 'place_probe']);

/**
 * The tool set for one run, worded for its axis. On the photo axis the time-only tools are left out
 * entirely (offering fit_curve over photo numbers invites a "time constant" of 1.4 photos), and every
 * remaining `tSec` is described as the photo number it now is — a model reads the schema, not the
 * system prompt, when it fills in an argument.
 */
export function deepReportTools(axis: AnalysisAxis = 'time'): Anthropic.Tool[] {
  if (axis !== 'photo') return DEEP_REPORT_TOOLS;
  const reword = (s: string) =>
    s
      .replace(
        /Time in seconds; the nearest sampled frame is used\./g,
        'The PHOTO NUMBER (1 = the first photo in the set).',
      )
      .replace(/Times in seconds to read, at most 10\./g, 'Photo numbers to read, at most 10.')
      .replace(/Times in seconds, at most 8./g, 'Photo numbers, at most 8.')
      .replace(/at one instant/g, 'on one photo')
      .replace(/in one frame/g, 'in one photo')
      .replace(/a specific moment/g, 'a specific photo')
      .replace(/Look at up to 8 instants as images/g, 'Look at up to 8 photos as images')
      .replace(
        /Read NEW frames the analysis has not sampled yet, at the instants you choose \(up to 10 per call\)\./g,
        'Read photos of the set the analysis has not decoded yet, by photo number (up to 10 per call).',
      )
      .replace(/so the other tools can use those instants too/g, 'so the other tools can use those photos too')
      .replace(
        /Use it when something interesting falls between the existing samples — a suspected fast transient, or a gap you want resolved\./g,
        'Use it when the summary lists a photo it did not decode.',
      );
  return DEEP_REPORT_TOOLS.filter((t) => !TIME_ONLY_TOOLS.has(t.name)).map((t) => ({
    ...t,
    description: t.description ? reword(t.description) : t.description,
    input_schema: JSON.parse(reword(JSON.stringify(t.input_schema))) as Anthropic.Tool['input_schema'],
  }));
}

// find_events was retired on 2026-10-06: it returned the digest's own `events` and `phases`, which the
// seed already carries, and measured runs spent their first round on it every time.
export const DEEP_REPORT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_frame_stats',
    description:
      'Whole-frame statistics and every probe reading at one instant. Use it to check a specific moment rather than inferring it from the series.',
    input_schema: {
      type: 'object',
      properties: { tSec: { type: 'number', description: 'Time in seconds; the nearest sampled frame is used.' } },
      required: ['tSec'],
    },
  },
  {
    name: 'fit_curve',
    description:
      "Fit Newton's law of cooling/heating to one probe over a time window, returning tau, the asymptote and R². Use it to test whether a stretch really is exponential, or to fit a phase separately from the whole clip.",
    input_schema: {
      type: 'object',
      properties: {
        thermometer: {
          type: 'string',
          description: 'Probe label — a student probe ("T1") or an AI virtual probe ("AI1").',
        },
        tStart: { type: 'number', description: 'Window start in seconds (optional; defaults to the clip start).' },
        tEnd: { type: 'number', description: 'Window end in seconds (optional; defaults to the clip end).' },
      },
      required: ['thermometer'],
    },
  },
  {
    name: 'get_line_profile',
    description:
      'Sample temperature along a straight line across the image at one instant and fit its gradient. Coordinates are normalized [0,1] with y=0 at the top. Use it to measure a boundary or a spatial gradient.',
    input_schema: {
      type: 'object',
      properties: {
        x1: { type: 'number' },
        y1: { type: 'number' },
        x2: { type: 'number' },
        y2: { type: 'number' },
        tSec: { type: 'number', description: 'Time in seconds; the nearest sampled frame is used.' },
      },
      required: ['x1', 'y1', 'x2', 'y2', 'tSec'],
    },
  },
  {
    name: 'get_histogram',
    description:
      'The distribution of pixel temperatures in one frame, as equal-width bins. Use it to tell "one hot object in a cool room" from "everything warmed a little".',
    input_schema: {
      type: 'object',
      properties: {
        tSec: { type: 'number', description: 'Time in seconds; the nearest sampled frame is used.' },
        bins: { type: 'number', description: 'Number of bins (4-40, default 12).' },
      },
      required: ['tSec'],
    },
  },
  {
    name: 'sample_frames',
    description:
      "Read NEW frames the analysis has not sampled yet, at the instants you choose (up to 10 per call). Returns each new frame's whole-frame statistics and every probe reading, and folds the frames into the working set so the other tools can use those instants too. Use it when something interesting falls between the existing samples — a suspected fast transient, or a gap you want resolved.",
    input_schema: {
      type: 'object',
      properties: {
        tSecs: { type: 'array', items: { type: 'number' }, description: 'Times in seconds to read, at most 10.' },
      },
      required: ['tSecs'],
    },
  },
  {
    name: 'place_probe',
    description:
      'Place a VIRTUAL temperature probe for this report at a point of the image and get its temperature-vs-time ' +
      "readings and analysis back, in the same form as the experiment's own probes. Use it when the story needs a " +
      'reading nothing measures: the object itself when no probe sits on it, a background or reference surface, the ' +
      'other half of a comparison (the second mug, the far end of the rod, the wooden ruler beside the metal one). ' +
      'Decide the point from the photos and the thermal frames (x left→right, y top→bottom, both in [0,1]). The ' +
      'reading is taken at the most informative pixel within 0.05 of the point you name, and the result says ' +
      'exactly where it landed and what it read — read that before citing it. If the result carries a "step", ' +
      'something ARRIVED at that point (a hand, a moved object): the readings after the step are of that thing, ' +
      'not of the surface you meant — say so, or place the probe elsewhere. The probes are labelled AI1, AI2… in ' +
      'the order placed, are drawn on every figure of the report, and are NOT saved to the experiment. At most ' +
      '4 per report; place them all in one round where you can.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Normalized x in [0,1] (left→right).' },
        y: { type: 'number', description: 'Normalized y in [0,1] (top→bottom, 0 = top).' },
        reason: {
          type: 'string',
          description:
            'What the point is on and why it matters, in a few words ("the wooden ruler at mid-length, to compare with T1 on the metal one"). Quoted in the report.',
        },
      },
      required: ['x', 'y', 'reason'],
    },
  },
  {
    name: 'view_frames',
    description:
      'Look at up to 8 instants as images — the thermal render and, when one exists, the visible-light photo. Use it to identify what the objects are, and ask for every instant you want to see in ONE call. Temperatures still come only from the numbers.',
    input_schema: {
      type: 'object',
      properties: {
        tSecs: { type: 'array', items: { type: 'number' }, description: 'Times in seconds, at most 8.' },
      },
      required: ['tSecs'],
    },
  },
];

/** The kept frame nearest a requested instant. The model asks in clip time; the data exists at samples. */
/**
 * Place one virtual probe: snap the model's point to the most informative pixel near it, read the series
 * over the working frames, analyse it as the digest analyses any probe, and fold it into the context so
 * every later tool (fit_curve, sample_frames, the verifier, the digest card) knows it.
 *
 * The snap prefers, within PLACE_SNAP_RADIUS, the pixel whose excursion above the scene's floor is
 * largest WITHOUT a single-frame jump (an arrival): on a ruler pressed by a finger that is the ruler, not
 * the fingertip beside it. When nothing near the point swings by PLACE_SNAP_MIN_RANGE_C the named point
 * itself is read — the model asked for a reference surface, and a flat one is what it gets.
 */
function placeVirtualProbe(ctx: DeepToolContext, x: number, y: number, reason: string): DeepToolResult | null {
  const times = ctx.summary.times;
  if (times.length < 2 || ctx.frames.length < 2) return null;
  const byTime = new Map(ctx.frames.map((f) => [f.tSec, f.frame]));
  const first = ctx.frames[0].frame;
  const w = first.w;
  const h = first.h;
  if (w <= 0 || h <= 0) return null;
  // The frames in series order, with the scene floor of each (null where a time has no frame).
  const ordered = times.map((t, i) => ({
    frame: byTime.get(t) ?? null,
    floor: typeof ctx.summary.frameGlobal[i]?.p02 === 'number' ? (ctx.summary.frameGlobal[i].p02 as number) : 0,
  }));
  const readAt = (idx: number): number[] =>
    ordered.map(({ frame }) => (frame && frame.w === w && frame.h === h ? celsiusAtIndex(frame, idx) : NaN));
  const px0 = Math.min(w - 1, Math.max(0, Math.floor(x * w)));
  const py0 = Math.min(h - 1, Math.max(0, Math.floor(y * h)));
  const rx = Math.round(PLACE_SNAP_RADIUS * w);
  const ry = Math.round(PLACE_SNAP_RADIUS * h);
  let bestIdx = py0 * w + px0;
  let bestRange = -Infinity;
  for (let py = Math.max(0, py0 - ry); py <= Math.min(h - 1, py0 + ry); py++) {
    for (let px = Math.max(0, px0 - rx); px <= Math.min(w - 1, px0 + rx); px++) {
      if (Math.hypot((px - px0) / w, (py - py0) / h) > PLACE_SNAP_RADIUS) continue;
      const idx = py * w + px;
      const series = readAt(idx);
      let lo = Infinity;
      let hi = -Infinity;
      series.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        const rel = v - ordered[i].floor;
        if (rel < lo) lo = rel;
        if (rel > hi) hi = rel;
      });
      const range = hi - lo;
      if (!(range >= PLACE_SNAP_MIN_RANGE_C) || range <= bestRange) continue;
      if (arrivalStep(times, series)) continue;
      bestRange = range;
      bestIdx = idx;
    }
  }
  const series = readAt(bestIdx);
  const sx = Number((((bestIdx % w) + 0.5) / w).toFixed(3));
  const sy = Number(((Math.floor(bestIdx / w) + 0.5) / h).toFixed(3));
  const label = `AI${nextAiProbeNumber([
    ...ctx.placed!.map((p) => p.label),
    ...ctx.summary.thermometers.map((t) => t.label),
    ...(ctx.summary.aiProbes ?? []).map((p) => p.label),
  ])}`;
  const analysed = buildAnalysisDigest({
    times,
    thermometers: [{ label, series, placedBy: 'ai' }],
    frameGlobal: ctx.summary.frameGlobal.map((g) => ({ ...g, hotspot: g.hotspot ?? { x: 0.5, y: 0.5 } })),
    frames: [],
    profileLines: [],
    axis: ctx.axis,
  });
  const entry = analysed.thermometers[0];
  const finite = series.filter((v) => Number.isFinite(v));
  const start = finite.length ? finite[0] : null;
  const end = finite.length ? finite[finite.length - 1] : null;
  const spanned = times[times.length - 1] - times[0];
  const probe: DeepProbe = {
    label,
    position: { x: sx, y: sy },
    series,
    min: finite.length ? Math.min(...finite) : null,
    max: finite.length ? Math.max(...finite) : null,
    startTemp: start,
    endTemp: end,
    changeC: start != null && end != null ? Number((end - start).toFixed(2)) : null,
    secantCPerSec: start != null && end != null && spanned > 0 ? Number(((end - start) / spanned).toFixed(3)) : null,
  };
  (ctx.summary.aiProbes ??= []).push(probe);
  ctx.digest.thermometers.push(entry);
  ctx.digest.events.push(...analysed.events);
  ctx.digest.events.sort((a, b) => a.t - b.t);
  ctx.placed!.push({ label, x: sx, y: sy, reason });
  const keepTimes = [
    ...(entry.maxAt ? [entry.maxAt.t] : []),
    ...(entry.minAt ? [entry.minAt.t] : []),
    ...(entry.peakRate ? [entry.peakRate.t] : []),
    ...entry.phases.flatMap((p) => [p.tStart, p.tEnd]),
  ];
  const moved = Math.hypot(sx - x, sy - y) > 0.004;
  const legalTemps = [...finite, ...(probe.changeC != null ? [probe.changeC] : [])];
  const legalTimes = [...times];
  const legalRates: number[] = [];
  if (entry.maxAt) legalTemps.push(entry.maxAt.tempC);
  if (entry.minAt) legalTemps.push(entry.minAt.tempC);
  for (const p of entry.phases) legalTemps.push(p.tempStart, p.tempEnd, Math.abs(p.tempEnd - p.tempStart));
  if (entry.step) legalTemps.push(Math.abs(entry.step.deltaC));
  if (entry.vsBackground)
    legalTemps.push(entry.vsBackground.startC, entry.vsBackground.endC, Math.abs(entry.vsBackground.changeC));
  if (entry.newtonFit) {
    legalTemps.push(entry.newtonFit.tInf);
    legalTimes.push(entry.newtonFit.tau, 2 * entry.newtonFit.tau, 3 * entry.newtonFit.tau, 5 * entry.newtonFit.tau);
  }
  if (entry.peakRate) legalRates.push(entry.peakRate.cPerSec);
  if (probe.secantCPerSec != null) legalRates.push(probe.secantCPerSec);
  return {
    text: JSON.stringify({
      label,
      reason,
      position: { x: sx, y: sy },
      ...(moved ? { note: `Read at (${sx}, ${sy}), the most informative pixel near (${x}, ${y}).` } : {}),
      points: reduceSeries(times, series, { keepTimes }),
      min: probe.min,
      max: probe.max,
      startTemp: start,
      endTemp: end,
      changeC: probe.changeC,
      analysis: entry,
      ...(entry.step
        ? {
            warning: `Something arrived at or left this point at t = ${entry.step.t} s (a jump of ${entry.step.deltaC} °C between two frames): the readings on either side are of different things.`,
          }
        : {}),
    }),
    images: [],
    legal: { temps: legalTemps, times: legalTimes, rates: legalRates },
  };
}

const nearestFrame = (frames: KeptFrame[], tSec: number): KeptFrame | null => {
  if (frames.length === 0) return null;
  let best = frames[0];
  for (const f of frames) if (Math.abs(f.tSec - tSec) < Math.abs(best.tSec - tSec)) best = f;
  return best;
};

/** Equal-width binning of a frame's pixels — the server port of the analyzer's N(T) histogram
 *  (binFrame in src/pages/experimentAnalyzer/charts/tempHistogram.tsx). KEEP IN SYNC: the two must bin
 *  identically, or the model and the chart beside it would describe different distributions. */
export const binFrame = (frame: DecodedFrame, minC: number, maxC: number, bins: number) => {
  const width = (maxC - minC) / bins || 1;
  const counts = new Array<number>(bins).fill(0);
  const n = frame.w * frame.h;
  for (let i = 0; i < n; i++) {
    let b = Math.floor((celsiusAtIndex(frame, i) - minC) / width);
    if (b < 0) b = 0;
    else if (b >= bins) b = bins - 1;
    counts[b] += 1;
  }
  return counts.map((count, i) => ({
    fromC: Number((minC + i * width).toFixed(2)),
    toC: Number((minC + (i + 1) * width).toFixed(2)),
    pct: Number(((count / n) * 100).toFixed(2)),
  }));
};

export interface DeepToolResult {
  text: string;
  /** Image blocks to show the model alongside the result (view_frames only). */
  images: Anthropic.ContentBlockParam[];
  /** The numbers this result handed the model, by kind. The loop accumulates them so the post-generation
   *  verifier accepts what the tools said — the prompt promises tool results are citable data, and a
   *  verifier that only knew the original summary would flag a windowed re-fit's tau as invented. */
  legal?: ExtraLegalValues;
}

/**
 * Run one tool. Never throws: a tool that cannot answer returns text saying so, because a thrown error
 * would abort a report the model has already half-written for the sake of one failed lookup.
 */
export async function executeDeepTool(name: string, input: unknown, ctx: DeepToolContext): Promise<DeepToolResult> {
  const args = (input ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const none = (text: string): DeepToolResult => ({ text, images: [] });

  try {
    // Defensive: the photo axis never offers these, but a model may still name one it saw in the prompt.
    if (ctx.axis === 'photo' && TIME_ONLY_TOOLS.has(name)) {
      return none(
        `${name} is not available for a photo set: the photos are separate shots with no time axis, so there ` +
          'are no events to find and no curve to fit. Compare the photos through get_frame_stats, ' +
          'get_histogram and get_line_profile instead.',
      );
    }
    switch (name) {
      case 'get_frame_stats': {
        const t = num(args.tSec);
        if (t === null) return none('get_frame_stats needs a numeric tSec.');
        const kept = nearestFrame(ctx.frames, t);
        if (!kept) return none('No decoded frames are available.');
        // Belt and braces: the summary arrays normally hold every kept instant (sample_frames folds its
        // reads in), but this tool must never answer null for a frame it is literally holding — compute
        // straight off the pixels when a lookup misses. The pixel fallback is a point read at the probe's
        // position; the series value (an area average for area probes) is preferred when present.
        const g = ctx.summary.frameGlobal.find((x) => x.t === kept.tSec) ?? { t: kept.tSec, ...frameStats(kept.frame) };
        const i = ctx.summary.times.indexOf(kept.tSec);
        const allProbes = [...ctx.summary.thermometers, ...(ctx.summary.aiProbes ?? [])];
        const probeReadings = allProbes.map((p) => {
          const fromSeries = i >= 0 ? (p.series[i] ?? null) : null;
          return { label: p.label, tempC: fromSeries ?? celsiusAtPoint(kept.frame, p.position.x, p.position.y) };
        });
        return {
          text: JSON.stringify({ askedForT: t, nearestSampleT: kept.tSec, whole: g, probes: probeReadings }),
          images: [],
          legal: {
            temps: [g.min, g.max, g.mean, g.p02 ?? g.min, g.p98 ?? g.max, ...probeReadings.map((p) => p.tempC)],
            times: [kept.tSec],
          },
        };
      }

      case 'fit_curve': {
        const label = typeof args.thermometer === 'string' ? args.thermometer : '';
        // The AI's own virtual probes are as fittable as the student's — same frames, same reader.
        const probes = [...ctx.summary.thermometers, ...(ctx.summary.aiProbes ?? [])];
        const probe = probes.find((p) => p.label.toLowerCase() === label.toLowerCase());
        if (!probe)
          return none(`No probe called "${label}". Available: ${probes.map((p) => p.label).join(', ') || 'none'}.`);
        const tStart = num(args.tStart) ?? -Infinity;
        const tEnd = num(args.tEnd) ?? Infinity;
        const pts = ctx.summary.times
          .map((t, i) => ({ t, T: probe.series[i] }))
          .filter((p) => p.t >= tStart && p.t <= tEnd && typeof p.T === 'number');
        const fit = fitNewtonCooling(pts);
        if (!fit)
          return none(
            JSON.stringify({
              thermometer: probe.label,
              pointsInWindow: pts.length,
              fit: null,
              note: 'No exponential fit describes this window — do not claim Newton cooling for it.',
            }),
          );
        const tau = Number(fit.tau.toFixed(2));
        const tInf = Number(fit.tInf.toFixed(2));
        return {
          text: JSON.stringify({
            thermometer: probe.label,
            window: { tStart: pts[0].t, tEnd: pts[pts.length - 1].t, points: fit.n },
            tau,
            tInf,
            r2: Number(fit.r2.toFixed(3)),
            direction: fit.direction,
          }),
          images: [],
          // tau's small multiples too — "within a few per cent by 3*tau" is the standard reading of a
          // time constant, and the digest's own tau gets the same treatment in the verifier.
          legal: { times: [tau, 2 * tau, 3 * tau, 5 * tau], temps: [tInf] },
        };
      }

      case 'get_line_profile': {
        const x1 = num(args.x1);
        const y1 = num(args.y1);
        const x2 = num(args.x2);
        const y2 = num(args.y2);
        const t = num(args.tSec);
        if (x1 === null || y1 === null || x2 === null || y2 === null || t === null)
          return none('get_line_profile needs numeric x1, y1, x2, y2 and tSec.');
        const kept = nearestFrame(ctx.frames, t);
        if (!kept) return none('No decoded frames are available.');
        const line: ProfileLineLike = { x1, y1, x2, y2 };
        const pts = sampleLineProfile(kept.frame, line, 120);
        const fit = linearFit(pts.map((p) => ({ x: p.pos, y: p.tempC })));
        const endpoints = { a: Number(pts[0].tempC.toFixed(2)), b: Number(pts[pts.length - 1].tempC.toFixed(2)) };
        const minC = Number(Math.min(...pts.map((p) => p.tempC)).toFixed(2));
        const maxC = Number(Math.max(...pts.map((p) => p.tempC)).toFixed(2));
        const deltaCEndToEnd = fit ? Number(fit.slope.toFixed(2)) : null;
        const samples = pts.filter((_, i) => i % 12 === 0).map((p) => Number(p.tempC.toFixed(2)));
        return {
          text: JSON.stringify({
            nearestSampleT: kept.tSec,
            endpoints,
            minC,
            maxC,
            // Slope is per unit of normalized position, i.e. the whole end-to-end difference. Without a
            // calibrated real length there is no physical per-centimetre gradient to report.
            deltaCEndToEnd,
            linearityR2: fit ? Number(fit.r2.toFixed(3)) : null,
            samples,
          }),
          images: [],
          legal: {
            temps: [
              endpoints.a,
              endpoints.b,
              minC,
              maxC,
              ...(deltaCEndToEnd != null ? [deltaCEndToEnd] : []),
              ...samples,
            ],
            times: [kept.tSec],
          },
        };
      }

      case 'get_histogram': {
        const t = num(args.tSec);
        if (t === null) return none('get_histogram needs a numeric tSec.');
        const kept = nearestFrame(ctx.frames, t);
        if (!kept) return none('No decoded frames are available.');
        const bins = Math.max(4, Math.min(40, Math.round(num(args.bins) ?? 12)));
        // Same fallback as get_frame_stats: a frame in hand must never be binned over a made-up 0-1 °C
        // domain just because the summary lookup missed.
        const g = ctx.summary.frameGlobal.find((x) => x.t === kept.tSec) ?? frameStats(kept.frame);
        const lo = g.min;
        const hi = g.max > g.min ? g.max : g.min + 1;
        const binned = binFrame(kept.frame, lo, hi, bins);
        return {
          text: JSON.stringify({ nearestSampleT: kept.tSec, minC: lo, maxC: hi, bins: binned }),
          images: [],
          // Bin EDGES are citable temperatures ("most pixels sit between 22.4 and 24.1 °C"); the
          // percentages are unit-less and the verifier does not extract those.
          legal: { temps: [lo, hi, ...binned.flatMap((b) => [b.fromC, b.toC])], times: [kept.tSec] },
        };
      }

      case 'place_probe': {
        if (!ctx.placed) return none('Virtual probes cannot be placed on this experiment.');
        const x = num(args.x);
        const y = num(args.y);
        if (x === null || y === null || x < 0 || x > 1 || y < 0 || y > 1) {
          return none('place_probe needs x and y, both in [0,1].');
        }
        const reason = (typeof args.reason === 'string' ? args.reason : '').trim().slice(0, 200);
        if (ctx.placed.length >= PLACE_PROBE_MAX) {
          return none(
            `At most ${PLACE_PROBE_MAX} virtual probes per report; use the ones already placed: ${ctx.placed
              .map((p) => p.label)
              .join(', ')}.`,
          );
        }
        const out = placeVirtualProbe(ctx, x, y, reason);
        if (!out) return none('Too few frames to read a probe here.');
        return out;
      }

      case 'sample_frames': {
        if (!ctx.sampleFrames) return none('This experiment cannot be resampled here — use the frames already listed.');
        const raw = Array.isArray(args.tSecs) ? args.tSecs : [];
        const times = raw
          .map(num)
          .filter((v): v is number => v !== null)
          .slice(0, 10);
        if (times.length === 0) return none('sample_frames needs at least one time in tSecs.');
        return none(await ctx.sampleFrames(times));
      }

      case 'view_frames': {
        const raw = Array.isArray(args.tSecs) ? args.tSecs : [];
        const times = raw
          .map(num)
          .filter((v): v is number => v !== null)
          .slice(0, VIEW_FRAMES_MAX);
        if (times.length === 0) return none('view_frames needs at least one time in tSecs.');
        if (ctx.imagesLeft <= 0)
          return none(
            'The image budget for this report is spent. Continue from the numbers and the frames already shown.',
          );
        const snapped = times.map((t) => nearestFrame(ctx.frames, t)?.tSec).filter((t): t is number => t !== undefined);
        const images = await ctx.loadImages(Array.from(new Set(snapped)));
        const count = images.filter((b) => b.type === 'image').length;
        ctx.imagesLeft -= count;
        if (count === 0) return none('No images exist for those instants; this clip has no frame renders to show.');
        const at =
          ctx.axis === 'photo'
            ? `photo${snapped.length === 1 ? '' : 's'} ${snapped.map((t) => Math.round(t)).join(', ')}`
            : `t = ${snapped.join(', ')} s`;
        return {
          text: `Showing ${count} image(s) for ${at}. They follow this result. Temperatures still come only from the numbers.`,
          images,
        };
      }

      default:
        return none(`Unknown tool "${name}".`);
    }
  } catch (err) {
    return none(
      `That lookup failed: ${(err as { message?: string })?.message ?? 'unknown error'}. Continue without it.`,
    );
  }
}
