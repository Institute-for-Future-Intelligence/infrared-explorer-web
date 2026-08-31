/**
 * Figure markers in the AI lab report.
 *
 * The report prompt (functions/src/index.ts, REPORT_SYSTEM_PROMPT "FIGURES") lets the model put
 * `[figure: t = 48 s | one-line caption]` on a line of its own; the client replaces that line with the
 * rendered thermal frame of that instant. Parsing happens OUTSIDE markdownToHtml — the report is split
 * into markdown stretches and figure entries, and the figures are interleaved as real React components
 * (they need async thumbnails and click handlers, which innerHTML can't carry). A marker the model got
 * wrong — not alone on its line, malformed, or beyond the render cap — is left in the markdown untouched
 * and renders as its literal text: readable, never a dead hole in the report.
 */

export interface ReportFigureSegment {
  kind: 'figure';
  /** Player-time instant, seconds — the same time axis the report's citations and the seek bridge use. */
  tSeconds: number;
  /** May be empty — the marker's caption half is optional. */
  caption: string;
}

export type ReportSegment = { kind: 'md'; text: string } | ReportFigureSegment;

/** Client-side render cap, a little above the prompt's REPORT_FIGURE_MAX (4) so a model that miscounts
 *  by one or two degrades to an extra figure rather than a raw marker line in the middle of the report. */
export const REPORT_FIGURE_RENDER_MAX = 6;

// One whole line: [figure: t = 48 s | caption]. Tolerant about whitespace and case, strict about shape —
// anything else is not a marker. The caption may not contain ']' (the model is told one line, one clause).
// The caption group is a single greedy run with NO adjacent whitespace quantifiers on purpose: stacking
// `\s*` around a lazy `[^\]]*?` made three quantifiers compete for the same spaces, and one unclosed
// marker followed by a whitespace run took tens of seconds of backtracking on the render path of every
// viewer. Leading/trailing caption whitespace is trimmed in code instead. Mirrored by the server's
// sanitizer (functions/src/analysis.ts FIGURE_MARKER_RE) — keep the two in step.
const FIGURE_LINE_RE = /^\s*\[\s*figure\s*:\s*t\s*=\s*(\d+(?:\.\d+)?)\s*s\s*(?:\|([^\]]*))?\]\s*$/i;

/** Lines longer than this cannot be a sane marker (a caption is one clause); skipped before the regex
 *  ever runs, as a second line of defense for pathological model output. */
const FIGURE_LINE_MAX = 400;

/** Split a report into markdown stretches and the figures between them, in document order. */
export function splitReportFigures(report: string): ReportSegment[] {
  const segments: ReportSegment[] = [];
  let buf: string[] = [];
  let figures = 0;
  const flush = () => {
    if (buf.length) {
      segments.push({ kind: 'md', text: buf.join('\n') });
      buf = [];
    }
  };
  for (const line of report.split('\n')) {
    const m = figures < REPORT_FIGURE_RENDER_MAX && line.length <= FIGURE_LINE_MAX ? FIGURE_LINE_RE.exec(line) : null;
    if (m) {
      flush();
      figures += 1;
      segments.push({ kind: 'figure', tSeconds: Number(m[1]), caption: (m[2] ?? '').trim() });
    } else {
      buf.push(line);
    }
  }
  flush();
  return segments;
}
