/**
 * Is the saved AI report still describing the experiment as it stands?
 *
 * A report is written from one snapshot of the thermal data and then persisted, shown to every viewer,
 * and fed back as context to the Q&A. Re-trimming the clip or redrawing a transect changes the numbers
 * underneath it, and nothing said so: the report kept its model badge and read as current.
 *
 * The generateLabReport Function stamps `aiReportInputs` — a description of the inputs it used — onto the
 * experiment alongside the report. This module rebuilds the same description from the experiment as it is
 * NOW and compares the two.
 *
 * MIRROR of reportInputsDescriptor in functions/src/analysis.ts. The two are compared across the wire, so
 * they must serialize identically; the parity test in reportFreshness.test.ts asserts exactly that against
 * a shared fixture. Every field is read verbatim from the same experiment document on both sides, which
 * is what makes that possible — see the note in the server copy for why probe geometry is deliberately
 * absent (the browser reads the thermometers subcollection through a rules-shaped query and cannot see
 * the same set the server does, so comparing it would pin a permanent "outdated" badge on current
 * reports). The consequence is stated in the UI: this catches re-trims and transect edits, not a probe
 * that was nudged.
 */

/** Kept in step with functions/src/analysis.ts ANALYSIS_ALGO_VERSION. */
export const ANALYSIS_ALGO_VERSION = 1;
/** Kept in step with functions/src/index.ts REPORT_FRAME_SAMPLES (and src/utils/constants AI_FRAME_SAMPLES). */
export const REPORT_FRAME_SAMPLES = 25;

export interface ReportInputsDescriptor {
  v: number;
  samples: number;
  source: string | null;
  recordingId: string | null;
  name: string | null;
  duration: number;
  segments: [number, number][];
  profileLines: [number, number, number, number, number | null][];
}

/** The experiment fields the descriptor reads. Loose on purpose — it is built from a Firestore document
 *  on the server and from the store's Experiment here, and a missing field must describe the same way. */
export interface ReportInputsSource {
  sourceType?: unknown;
  recordingId?: unknown;
  name?: unknown;
  duration?: unknown;
  segments?: { start: number; end: number }[] | null;
  profileLines?: { x1: number; y1: number; x2: number; y2: number; lengthCm?: number | null }[] | null;
}

export function reportInputsDescriptor(exp: ReportInputsSource, frameSamples = REPORT_FRAME_SAMPLES) {
  const segments = Array.isArray(exp.segments) ? exp.segments : [];
  const lines = Array.isArray(exp.profileLines) ? exp.profileLines : [];
  const out: ReportInputsDescriptor = {
    v: ANALYSIS_ALGO_VERSION,
    samples: frameSamples,
    source: typeof exp.sourceType === 'string' ? exp.sourceType : null,
    recordingId: typeof exp.recordingId === 'string' ? exp.recordingId : null,
    name: typeof exp.name === 'string' ? exp.name : null,
    duration: Number(exp.duration) || 0,
    segments: segments.map((s) => [s.start, s.end]),
    profileLines: lines.map((l) => [l.x1, l.y1, l.x2, l.y2, l.lengthCm ?? null]),
  };
  return out;
}

/**
 * Has the data moved on since the report was written?
 *
 * Returns false whenever the answer is not knowable — a report saved before this stamp existed carries no
 * descriptor, and calling that "outdated" would nag every owner of an older report into regenerating
 * something that may be perfectly good. Unknown is shown as the saved date alone, never as a warning.
 */
export function isReportStale(exp: ReportInputsSource & { aiReportInputs?: unknown }): boolean {
  const saved = exp.aiReportInputs;
  if (!saved || typeof saved !== 'object') return false;
  return JSON.stringify(reportInputsDescriptor(exp)) !== JSON.stringify(saved);
}
