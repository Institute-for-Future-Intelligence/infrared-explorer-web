/**
 * Bring a report's heading levels to the shape the panel styles.
 *
 * The prompt now asks for the report's own title as a level-1 heading and each section as level 2
 * (functions/src/index.ts, "Required structure"), which is what ReportBody's type scale is built for.
 * Two things still arrive in other shapes and are fixed here rather than left to look broken:
 *
 *  - REPORTS SAVED BEFORE THAT CHANGE open with a literal `### Suggested title` heading followed by the
 *    title on the next line, and use `###` for every section. They are stored on the experiment doc and
 *    are read far more often than they are regenerated, so the label is dropped, the line under it is
 *    promoted to the title, and the sections are lifted to level 2.
 *  - A MODEL THAT IGNORES THE LEVELS (writes every heading at one depth) gets the same lift, so the
 *    report still reads as title-then-sections instead of one flat run of same-sized lines.
 *
 * Everything that is not a heading passes through byte-identical, so figure markers, tables and prose
 * are untouched (this runs before splitReportFigures).
 */

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** A first heading that labels the report instead of naming it — the old "### Suggested title" shape. */
const TITLE_LABEL_RE = /^(suggested\s+)?title\b|^report\s+title\b/i;

export function normalizeReportHeadings(report: string): string {
  const lines = report.split('\n');
  const headingAt: { i: number; level: number; text: string }[] = [];
  lines.forEach((line, i) => {
    const m = HEADING_RE.exec(line);
    if (m) headingAt.push({ i, level: m[1].length, text: m[2].trim() });
  });
  if (headingAt.length === 0) return report;

  const out = [...lines];
  const first = headingAt[0];
  // Lines that are no longer section headings after this pass: the title (whatever form it took) and a
  // dropped label line. Everything else gets lifted together.
  const exempt = new Set<number>();
  let titleIndex: number | null = null;

  if (TITLE_LABEL_RE.test(first.text)) {
    // Old shape: the first heading LABELS the report ("### Suggested title") and the title itself is the
    // line under it. Drop the label, promote the line.
    let j = first.i + 1;
    while (j < out.length && !out[j].trim()) j++;
    const candidate = out[j]?.trim();
    if (candidate && !HEADING_RE.test(candidate)) {
      // Strip any bold the model wrapped the title line in — a heading carries its own weight, and
      // `# **Title**` would render the asterisks.
      out[j] = `# ${candidate.replace(/^\*\*(.*)\*\*$/, '$1')}`;
      titleIndex = j;
    }
    out[first.i] = ''; // the label itself never renders
    exempt.add(first.i);
  } else if (first.level === 1) {
    titleIndex = first.i; // already the new shape
  }
  if (titleIndex !== null) exempt.add(titleIndex);

  // Lift the section headings so the shallowest sits at level 2: a report already in the new shape is
  // left alone, an all-`###` one moves up by one. Relative depth between sections is preserved.
  const sectionLevels = headingAt.filter((h) => !exempt.has(h.i)).map((h) => h.level);
  const shift = sectionLevels.length ? 2 - Math.min(...sectionLevels) : 0;
  if (shift !== 0) {
    for (const h of headingAt) {
      if (exempt.has(h.i)) continue;
      out[h.i] = `${'#'.repeat(Math.min(6, Math.max(2, h.level + shift)))} ${h.text}`;
    }
  }
  return out.join('\n');
}
