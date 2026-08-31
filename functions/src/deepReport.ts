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
import { celsiusAtIndex, type DecodedFrame } from './thermal';
import {
  fitNewtonCooling,
  linearFit,
  sampleLineProfile,
  type AnalysisDigest,
  type KeptFrame,
  type ProfileLineLike,
} from './analysis';

/** The measured context the tools read. Structural, so the caller can pass its summary straight in. */
export interface DeepSummary {
  times: number[];
  thermometers: { label: string; position: { x: number; y: number }; series: number[] }[];
  /** Virtual probes the analysis placed itself (AI1..) — addressable by fit_curve like any probe. */
  aiProbes?: { label: string; position: { x: number; y: number }; series: number[] }[];
  frameGlobal: { t: number; min: number; max: number; mean: number; p02?: number; p98?: number }[];
  sampleIndex: { t: number; frame: number }[];
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
}

/** Most instants the model may ask to see at once. */
const VIEW_FRAMES_MAX = 3;

export const DEEP_REPORT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'find_events',
    description:
      "List the clip's turning points in time order (onset / peak / trough / steady) with the probe and temperature at each. Start here to decide what is worth drilling into.",
    input_schema: { type: 'object', properties: {} },
  },
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
    name: 'view_frames',
    description:
      'Look at up to 3 instants as images — the thermal render and, when one exists, the visible-light photo. Use it to identify what the objects are. Temperatures still come only from the numbers.',
    input_schema: {
      type: 'object',
      properties: {
        tSecs: { type: 'array', items: { type: 'number' }, description: 'Times in seconds, at most 3.' },
      },
      required: ['tSecs'],
    },
  },
];

/** The kept frame nearest a requested instant. The model asks in clip time; the data exists at samples. */
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
    switch (name) {
      case 'find_events':
        return none(
          JSON.stringify({
            events: ctx.digest.events,
            phases: ctx.digest.thermometers.map((t) => ({ label: t.label, phases: t.phases })),
          }),
        );

      case 'get_frame_stats': {
        const t = num(args.tSec);
        if (t === null) return none('get_frame_stats needs a numeric tSec.');
        const kept = nearestFrame(ctx.frames, t);
        if (!kept) return none('No decoded frames are available.');
        const g = ctx.summary.frameGlobal.find((x) => x.t === kept.tSec);
        const i = ctx.summary.times.indexOf(kept.tSec);
        return none(
          JSON.stringify({
            askedForT: t,
            nearestSampleT: kept.tSec,
            whole: g ?? null,
            probes: ctx.summary.thermometers.map((p) => ({
              label: p.label,
              tempC: i >= 0 ? (p.series[i] ?? null) : null,
            })),
          }),
        );
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
        return none(
          JSON.stringify({
            thermometer: probe.label,
            window: { tStart: pts[0].t, tEnd: pts[pts.length - 1].t, points: fit.n },
            tau: Number(fit.tau.toFixed(2)),
            tInf: Number(fit.tInf.toFixed(2)),
            r2: Number(fit.r2.toFixed(3)),
            direction: fit.direction,
          }),
        );
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
        return none(
          JSON.stringify({
            nearestSampleT: kept.tSec,
            endpoints: { a: Number(pts[0].tempC.toFixed(2)), b: Number(pts[pts.length - 1].tempC.toFixed(2)) },
            minC: Number(Math.min(...pts.map((p) => p.tempC)).toFixed(2)),
            maxC: Number(Math.max(...pts.map((p) => p.tempC)).toFixed(2)),
            // Slope is per unit of normalized position, i.e. the whole end-to-end difference. Without a
            // calibrated real length there is no physical per-centimetre gradient to report.
            deltaCEndToEnd: fit ? Number(fit.slope.toFixed(2)) : null,
            linearityR2: fit ? Number(fit.r2.toFixed(3)) : null,
            samples: pts.filter((_, i) => i % 12 === 0).map((p) => Number(p.tempC.toFixed(2))),
          }),
        );
      }

      case 'get_histogram': {
        const t = num(args.tSec);
        if (t === null) return none('get_histogram needs a numeric tSec.');
        const kept = nearestFrame(ctx.frames, t);
        if (!kept) return none('No decoded frames are available.');
        const bins = Math.max(4, Math.min(40, Math.round(num(args.bins) ?? 12)));
        const g = ctx.summary.frameGlobal.find((x) => x.t === kept.tSec);
        const lo = g?.min ?? 0;
        const hi = g?.max ?? lo + 1;
        return none(
          JSON.stringify({ nearestSampleT: kept.tSec, minC: lo, maxC: hi, bins: binFrame(kept.frame, lo, hi, bins) }),
        );
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
        return {
          text: `Showing ${count} image(s) for t = ${snapped.join(', ')} s. They follow this result. Temperatures still come only from the numbers.`,
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
