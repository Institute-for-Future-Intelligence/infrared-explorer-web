/**
 * Score the AI lab reports that have already been generated, so a change to the prompt, the grounding or
 * the model can be compared against the previous one instead of judged by reading a few and forming an
 * impression.
 *
 *   npx tsx scripts/evalReports.ts [--limit=N] [--match=<substring>] [--json] [--verbose]
 *     --limit=N            score at most N reports (default 100)
 *     --match=<substring>  only experiments whose title contains it (case-insensitive)
 *     --json               emit the raw per-report rows as JSON instead of a table
 *     --verbose            list every unsupported figure and every missing section
 *
 * Two things are measured, both objective:
 *
 *  1. GROUNDING — the fraction of the figures a report states (temperatures, times, rates) that actually
 *     appear in the data it was given, or are a difference of two values that do. This is the same
 *     verifyReportNumbers the generator runs; running it here over the whole corpus is what turns a
 *     per-report trust signal into a metric.
 *  2. STRUCTURE — whether the required sections are present, and whether the Limitations section really
 *     states the sampling, which is the part a model most often quietly drops.
 *
 * Grounding is scored against the CACHED derived analysis (experiments/{id}/derived/analysis), so it
 * costs one Firestore read per report and no Storage traffic at all. A report whose experiment has no
 * cache entry — or whose data has changed since it was written — is reported as unscorable rather than
 * scored against numbers it never saw; regenerate it (or open it once) to warm the cache.
 *
 * Reads production data. Credentials come from ./serviceAccount.json exactly as scripts/stitchAll.mjs
 * does. Read-only: this script never writes to Firestore or Storage.
 */
import { readFileSync } from 'node:fs';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyReportNumbers, type AnalysisDigest, type VerifiableSummary } from '../functions/src/analysis';

const arg = (name: string): string | undefined =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const LIMIT = Number(arg('limit') ?? 100);
const MATCH = (arg('match') ?? '').toLowerCase();
const AS_JSON = flag('json');
const VERBOSE = flag('verbose');

const sa = JSON.parse(readFileSync('./serviceAccount.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

/** The sections the report prompt requires, in order. Matched on the heading text, case-insensitively,
 *  so a model that writes "## Experimental Setup" or "### Experimental setup" both count. The title is
 *  NOT in this list: it is the report's own words as a level-1 heading, so there is no fixed text to
 *  match — hasTitle below checks that one exists instead. */
const REQUIRED_SECTIONS = [
  'experimental setup',
  'observations',
  'quantitative analysis',
  'physics explanation',
  'limitations',
  'conclusion',
  'follow-up',
];

const headings = (report: string): string[] =>
  report
    .split('\n')
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) =>
      l
        .replace(/^#{1,6}\s*/, '')
        .trim()
        .toLowerCase(),
    );

const missingSections = (report: string): string[] => {
  const found = headings(report);
  return REQUIRED_SECTIONS.filter((s) => !found.some((h) => h.includes(s)));
};

/** Does the report open with a real title — a first heading that names the experiment rather than
 *  labelling itself ("Suggested title", the old format) or being a section heading? */
const hasTitle = (report: string): boolean => {
  const first = headings(report)[0] ?? '';
  if (!first) return false;
  if (/^(suggested\s+)?title\b|^report\b/.test(first)) return false;
  return !REQUIRED_SECTIONS.some((s) => first.includes(s));
};

/** Does the Limitations section actually state the sampling, or is it a section heading over generic
 *  hedging? The prompt requires the frame counts by name, so their absence is a real miss. */
const limitationsStatesSampling = (report: string): boolean => {
  const idx = report.toLowerCase().indexOf('limitations');
  if (idx < 0) return false;
  const section = report.slice(idx, idx + 1200).toLowerCase();
  const mentionsFrames = /frame/.test(section);
  const mentionsCount = /\d/.test(section);
  const mentionsCorrection = /emissivit|reflect|uncorrect|raw (camera )?reading/.test(section);
  return mentionsFrames && mentionsCount && mentionsCorrection;
};

interface Row {
  id: string;
  title: string;
  model: string;
  chars: number;
  scorable: boolean;
  reason?: string;
  checked: number;
  matched: number;
  groundingPct: number | null;
  unmatched: string[];
  missingSections: string[];
  hasTitle: boolean;
  limitationsOk: boolean;
}

async function main() {
  const snap = await db
    .collection('experiments')
    .where('aiReport', '!=', '')
    .limit(Math.max(LIMIT * 3, LIMIT))
    .get();
  const rows: Row[] = [];

  for (const doc of snap.docs) {
    if (rows.length >= LIMIT) break;
    const exp = doc.data();
    const report = String(exp.aiReport ?? '');
    if (!report) continue;
    const title = String(exp.displayName ?? '');
    if (MATCH && !title.toLowerCase().includes(MATCH)) continue;

    const row: Row = {
      id: doc.id,
      title,
      model: String(exp.aiReportModel ?? '?'),
      chars: report.length,
      scorable: false,
      checked: 0,
      matched: 0,
      groundingPct: null,
      unmatched: [],
      missingSections: missingSections(report),
      hasTitle: hasTitle(report),
      limitationsOk: limitationsStatesSampling(report),
    };

    // Structure is scorable from the report alone; grounding needs the numbers it was written from.
    const cache = (await db.doc(`experiments/${doc.id}/derived/analysis`).get()).data();
    if (!cache?.summaryCore) {
      row.reason = 'no cached analysis (regenerate or open the experiment once)';
    } else if (exp.aiReportInputsHash && cache.inputsHash && exp.aiReportInputsHash !== cache.inputsHash) {
      row.reason = 'data changed since the report was written';
    } else {
      const res = verifyReportNumbers(
        report,
        cache.summaryCore as VerifiableSummary,
        (cache.digest ?? null) as AnalysisDigest | null,
      );
      row.scorable = true;
      row.checked = res.checked;
      row.matched = res.matched;
      row.groundingPct = res.checked ? Number(((res.matched / res.checked) * 100).toFixed(1)) : null;
      row.unmatched = res.unmatched.map((u) => u.text);
    }
    rows.push(row);
  }

  if (AS_JSON) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('No reports matched.');
    return;
  }

  console.log(`\nScored ${rows.length} report(s).\n`);
  for (const r of rows) {
    const grounding = r.scorable ? `${r.matched}/${r.checked} figures` : `unscorable — ${r.reason}`;
    const structure = r.missingSections.length ? `missing: ${r.missingSections.join(', ')}` : 'all sections';
    const titleFlag = r.hasTitle ? '' : 'no title  ';
    console.log(
      `${r.id.padEnd(22)} ${String(r.groundingPct ?? '—').padStart(6)}%  ${grounding.padEnd(34)} ` +
        `${structure.padEnd(44)} ${titleFlag}${r.limitationsOk ? '' : 'limitations weak  '}${r.title.slice(0, 40)}`,
    );
    if (VERBOSE && r.unmatched.length) console.log(`    unsupported: ${r.unmatched.join(', ')}`);
  }

  const scorable = rows.filter((r) => r.scorable && r.checked > 0);
  const totalChecked = scorable.reduce((s, r) => s + r.checked, 0);
  const totalMatched = scorable.reduce((s, r) => s + r.matched, 0);
  const cleanReports = scorable.filter((r) => r.matched === r.checked).length;
  const completeStructure = rows.filter((r) => r.missingSections.length === 0).length;
  const limitationsOk = rows.filter((r) => r.limitationsOk).length;

  console.log(`\n--- aggregate ---`);
  console.log(`scorable for grounding : ${scorable.length}/${rows.length}`);
  if (totalChecked > 0) {
    console.log(
      `figure grounding       : ${totalMatched}/${totalChecked} ` +
        `(${((totalMatched / totalChecked) * 100).toFixed(1)}%)`,
    );
    console.log(`reports with 0 misses  : ${cleanReports}/${scorable.length}`);
  }
  console.log(`all sections present   : ${completeStructure}/${rows.length}`);
  console.log(`limitations stated     : ${limitationsOk}/${rows.length}`);
  console.log(
    `median length          : ${
      [...rows].sort((a, b) => a.chars - b.chars)[Math.floor(rows.length / 2)].chars
    } chars\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
