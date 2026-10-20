/*
 * The server tools of a recording conversation, run inside the request: `view` (pictures of this
 * conversation, and of the current report when it is being revised) and `write_report` (the report, saved
 * as the experiment's: labReports/{id} and the aiReport* fields on the experiment document that every
 * reader follows). What the model is told about them is the app's declaration (labCore/toolSchemas.ts);
 * what they do is the app's functions/src/tools.ts, for one recording.
 */
import { FieldValue, getFirestore, type DocumentData } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { reportImageIds } from '../labCore/toolSchemas';
import type { ImageDoc } from '../labCore/store';
import { REPORT_FIGURES_BACK, REPORT_MARKDOWN_MAX } from './config';
import { copyImage, extFor, imageBytes, type Convo } from './store';

export interface OutImage {
  doc: Pick<ImageDoc, 'id' | 'path' | 'mime' | 'caption'>;
  b64: string;
}

export interface ToolOutcome {
  ok: boolean;
  text: string;
  /** Images the model should see in its next call. */
  images: OutImage[];
}

/** A picture a saved report embeds, as labReports.images[] keeps it: the id the Markdown names, where its bytes are. */
export interface ReportImage {
  id: string;
  caption: string;
  mime: string;
  path: string;
  url: string;
  kind: string;
  takeId?: string;
}

/** The report the experiment has now (labReports/{id}), as a run reads it. */
export interface CurrentReport {
  id: string;
  title: string;
  text: string;
  images: ReportImage[];
}

/** What a report run writes to, and from. */
export interface ReportTarget {
  expId: string;
  exp: DocumentData;
  mongoId: string;
  /** The labReports document this run writes. */
  reportId: string;
  modelKey: string;
  notes: string | null;
  mode: 'revise' | 'rewrite';
  current: CurrentReport | null;
}

export type Emit = (chunk: Record<string, unknown>) => void;

export interface ServerToolContext {
  convo: Convo;
  images: ImageDoc[];
  emit: Emit;
  /** Null in an Ask AI thread: write_report is not declared there, and a call to it fails. */
  report: ReportTarget | null;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * `edits` (find/replace pairs) applied in order to `current`: the text as they leave it, and the 1-based
 * numbers of the edits whose `find` is empty or not in the text at its turn (the app's applyEdits).
 */
export function applyEdits(current: string, edits: unknown[]): { next: string; missing: number[] } {
  let next = current;
  const missing: number[] = [];
  edits.forEach((e, i) => {
    const find = str((e as { find?: unknown } | null)?.find);
    const replace = str((e as { replace?: unknown } | null)?.replace);
    if (!find || !next.includes(find)) {
      missing.push(i + 1);
      return;
    }
    next = next.replace(find, replace);
  });
  return { next, missing };
}

/** Every picture the model may name: the conversation's, and the current report's when revising. */
function knownImages(
  ctx: ServerToolContext,
): Map<string, Pick<ImageDoc, 'id' | 'path' | 'mime' | 'caption' | 'kind' | 'takeId'>> {
  const byId = new Map<string, Pick<ImageDoc, 'id' | 'path' | 'mime' | 'caption' | 'kind' | 'takeId'>>();
  for (const i of ctx.report?.current?.images ?? []) {
    byId.set(i.id, {
      id: i.id,
      path: i.path,
      mime: i.mime,
      caption: i.caption,
      kind: i.kind as ImageDoc['kind'],
      takeId: i.takeId,
    });
  }
  for (const i of ctx.images) byId.set(i.id, i);
  return byId;
}

async function view(ctx: ServerToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const ids = Array.isArray(args.imageIds) ? args.imageIds.map(str).filter(Boolean) : [];
  const byId = knownImages(ctx);
  const found = ids.map((id) => byId.get(id)).filter((d): d is NonNullable<typeof d> => d != null);
  const missing = ids.filter((id) => !byId.has(id));
  const images: OutImage[] = [];
  for (const doc of found.slice(0, 12)) images.push({ doc, b64: (await imageBytes(doc)).b64 });
  const parts = [`Here ${images.length === 1 ? 'is 1 image' : `are ${images.length} images`}.`];
  if (missing.length > 0) parts.push(`Not found: ${missing.join(', ')}.`);
  if (found.length > 12) parts.push('Only the first 12 are shown; ask for the rest separately.');
  return { ok: found.length > 0, text: parts.join(' '), images };
}

/**
 * Save the report: labReports/{reportId} (its text, title, model, notes, and the pictures it embeds,
 * copied under its own Storage prefix so they outlive this run), the pointer and the aiReport* fields on
 * the experiment (what the analyzer and every viewer read), and the previous report's document and
 * pictures gone. What comes back to the model is the report as saved with its figures, as the app's
 * writeReport answers.
 */
async function writeReport(ctx: ServerToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = ctx.report;
  if (!target)
    return {
      ok: false,
      text: 'The report is not written in this conversation; the user asks for it with Generate Report.',
      images: [],
    };
  const whole = str(args.markdown);
  const edits = Array.isArray(args.edits) ? args.edits : [];
  const current = target.mode === 'revise' ? target.current : null;
  let title: string;
  let markdown: string;
  if (whole.trim()) {
    title = str(args.title).trim().slice(0, 200) || current?.title || 'Report';
    markdown = whole;
  } else if (edits.length > 0) {
    if (!current) return { ok: false, text: 'There is no report to change here: pass `markdown`.', images: [] };
    const applied = applyEdits(current.text, edits);
    if (applied.missing.length > 0) {
      return {
        ok: false,
        text: `No change was made: the text of edit ${applied.missing.join(', ')} was not found in the current report.`,
        images: [],
      };
    }
    title = str(args.title).trim().slice(0, 200) || current.title;
    markdown = applied.next;
  } else {
    return { ok: false, text: 'The report is empty: pass `markdown` or `edits`.', images: [] };
  }
  if (markdown.length > REPORT_MARKDOWN_MAX) markdown = markdown.slice(0, REPORT_MARKDOWN_MAX);

  // The pictures it embeds, by id, copied to the report's own prefix (a conversation's prefix goes with
  // the conversation; the report stays). A reference that names no known picture is told to the model.
  const known = knownImages(ctx);
  const refs = reportImageIds(markdown);
  const reportImages: ReportImage[] = [];
  const missing: string[] = [];
  for (const id of refs) {
    const src = known.get(id);
    if (!src) {
      missing.push(id);
      continue;
    }
    try {
      const copied = await copyImage(src, `labReports/${target.reportId}/${id}.${extFor(src.mime)}`);
      reportImages.push({
        id,
        caption: src.caption,
        mime: src.mime,
        path: copied.path,
        url: copied.url,
        kind: src.kind,
        takeId: src.takeId,
      });
    } catch (err) {
      console.warn('recordingAi: report picture not copied', id, err);
    }
  }

  const db = getFirestore();
  const previousId = typeof target.exp.labReportId === 'string' ? target.exp.labReportId : null;
  await db.doc(`labReports/${target.reportId}`).set({
    ownerId: target.mongoId,
    expId: target.expId,
    source: 'expId',
    engine: 'recordingAi',
    runId: ctx.convo.id,
    text: markdown,
    title,
    model: target.modelKey,
    at: FieldValue.serverTimestamp(),
    generatedAt: Date.now(),
    instructions: target.notes,
    by: 'ai',
    images: reportImages,
    ...(previousId && previousId !== target.reportId && target.mode === 'revise' ? { revisedFrom: previousId } : {}),
  });
  await db.doc(`experiments/${target.expId}`).set(
    {
      labReportId: target.reportId,
      aiReport: markdown,
      aiReportModel: target.modelKey,
      aiReportAt: FieldValue.serverTimestamp(),
      aiReportInstructions: target.notes,
      // the previous engine's record of its own run, meaningless for this one
      aiReportInputsHash: FieldValue.delete(),
      aiReportInputs: FieldValue.delete(),
      aiReportVerified: FieldValue.delete(),
      aiReportVision: FieldValue.delete(),
      aiReportSampling: FieldValue.delete(),
    },
    { merge: true },
  );
  // the experiment now points at this run's document; the previous report's own document and pictures go
  if (previousId && previousId !== target.reportId) {
    await db
      .doc(`labReports/${previousId}`)
      .delete()
      .catch(() => undefined);
    await getStorage()
      .bucket()
      .deleteFiles({ prefix: `labReports/${previousId}/` })
      .catch((err) => console.warn('recordingAi: previous report pictures not deleted', previousId, err));
  }
  target.exp = { ...target.exp, labReportId: target.reportId, aiReport: markdown };
  target.current = { id: target.reportId, title, text: markdown, images: reportImages };
  ctx.emit({
    t: 'report',
    report: {
      id: target.reportId,
      title,
      markdown,
      images: reportImages,
      model: target.modelKey,
      instructions: target.notes,
      at: Date.now(),
    },
  });

  // The report comes back as saved, with its figures in their order, as the user reads it (the app's ㊹).
  const images: OutImage[] = [];
  for (const img of reportImages.slice(0, REPORT_FIGURES_BACK)) {
    images.push({ doc: img, b64: (await imageBytes(img)).b64 });
  }
  const parts = [
    'The report is saved and shown to the user. It opens under AI Report in the analyzer; this is what they read there.',
    `Title: “${title}”`,
    markdown,
  ];
  if (images.length > 0) {
    parts.push(
      `Its ${images.length === 1 ? 'figure follows' : `${images.length} figures follow, in the order they appear`}${
        reportImages.length > images.length ? ` (the first ${images.length} of ${reportImages.length})` : ''
      }.`,
    );
  } else {
    parts.push('It embeds no pictures.');
  }
  if (missing.length > 0) {
    parts.push(
      `${missing.length === 1 ? 'One reference matches' : `${missing.length} references match`} no picture in this conversation and ${
        missing.length === 1 ? 'shows' : 'show'
      } as a missing image: ${missing.map((id) => `image:${id}`).join(', ')}.`,
    );
  }
  return { ok: true, text: parts.join('\n\n'), images };
}

export async function runServerTool(ctx: ServerToolContext, name: string, rawArgs: string): Promise<ToolOutcome> {
  const args = parseArgs(rawArgs);
  try {
    switch (name) {
      case 'view':
        return await view(ctx, args);
      case 'write_report':
        return await writeReport(ctx, args);
      default:
        return { ok: false, text: `There is no tool called ${name}.`, images: [] };
    }
  } catch (err) {
    console.error('recordingAi: tool failed', name, err);
    return { ok: false, text: `The ${name} tool failed: ${(err as Error)?.message ?? err}`.slice(0, 600), images: [] };
  }
}
