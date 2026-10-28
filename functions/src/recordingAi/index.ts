/*
 * The analyzer's Ask AI and AI Report on the app's AI flow (docs/analyzer-ai-app-flow-plan.md): the
 * callables. `recordingAiTurn` is one request of a conversation about one recording — an Ask AI thread
 * (one per user and recording) or a report run (one per Generate / Revise / Rewrite) — streamed like the
 * app's labProjectTurn; `editLabReport` is the owner's hand edit of the report (the client rules keep the
 * aiReport* fields and labReports server-written); `clearRecordingAiThread` deletes a user's own thread.
 *
 * The experiment, the report and the quotas are the website's (aiAccess.ts, index.ts); what the model is
 * told and how it is called is the app's (labCore/). Built as a factory, like aiReportFlagFunctions, so
 * index.ts hands in its Firestore and its gates without a module cycle.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue, type DocumentData } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { requireAiAccess, type AiRateSlot, type AiTier } from '../aiAccess';
import { DEFAULT_MODEL_KEY, QA_MODELS, offeredModelKey, type QaModelKey } from '../aiModels';
import { CHAT_SECRETS } from '../aiSecrets';
import type { ChatModelSpec } from '../labCore/config';
import { lineDiff } from '../labCore/textDiff';
import { REPORT_MARKDOWN_MAX } from './config';
import type { ReportInContext } from './context';
import {
  acquireLock,
  deleteConvo,
  emptyConvo,
  isValidId,
  loadConvo,
  newId,
  newReportId,
  releaseLock,
  runConvo,
  threadConvo,
  updateConvo,
  type Convo,
  type ConvoDoc,
} from './store';
import type { CurrentReport, ReportImage, ReportTarget } from './tools';
import { isChargedInput, parseInput, runTurn, type TurnOutcome } from './turn';

export interface RecordingAiDeps {
  db: Firestore;
  /** The caller's account id (the custom claim), or the HttpsError for a caller without one. */
  requireMongoId(auth: CallableRequest['auth']): string;
  /** One AI call charged to the caller's counters, or the refusal (index.ts enforceAiRateLimit). */
  enforceAiRateLimit(mongoId: string, tier: AiTier): Promise<AiRateSlot>;
  refundAiRateLimit(slot: AiRateSlot): Promise<void>;
}

const STAFF_EMAIL_SUFFIX = '@intofuture.org';

function isStaffToken(token: Record<string, unknown>): boolean {
  const email = typeof token.email === 'string' ? token.email.toLowerCase() : '';
  return token.email_verified === true && email.endsWith(STAFF_EMAIL_SUFFIX);
}

/** The Firestore read rule for an experiment (firestore.rules), as the server applies it to a caller. */
function canReadExperiment(exp: DocumentData, mongoId: string, token: Record<string, unknown>): boolean {
  if (exp.ownerId === mongoId || isStaffToken(token)) return true;
  return (exp.visibility === 'public' || exp.visibility === 'unlisted') && exp.trash !== true;
}

function recordingKind(exp: DocumentData): 'recording' | 'time-lapse recording' | 'photo set' {
  if (exp.sourceType === 'photos') return 'photo set';
  return exp.timelapse ? 'time-lapse recording' : 'recording';
}

function recordingTitle(exp: DocumentData): string {
  return typeof exp.displayName === 'string' && exp.displayName.trim() ? exp.displayName.trim() : 'Recording';
}

/** The one model a conversation runs on. Only the offered keys reach here; the wired-but-unoffered Claude keys are refused. */
function specFor(key: QaModelKey): ChatModelSpec {
  const m = QA_MODELS[key];
  if (m.provider === 'anthropic') throw new HttpsError('failed-precondition', 'This model is not offered here.');
  return { provider: m.provider, model: m.model };
}

/** A labReports document's images field, as this engine writes it; a report of the previous engine has none. */
function reportImagesOf(raw: unknown): ReportImage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.path !== 'string' || typeof o.url !== 'string') return [];
    return [
      {
        id: o.id,
        caption: typeof o.caption === 'string' ? o.caption : '',
        mime: typeof o.mime === 'string' ? o.mime : 'image/jpeg',
        path: o.path,
        url: o.url,
        kind: typeof o.kind === 'string' ? o.kind : 'look',
        ...(typeof o.takeId === 'string' ? { takeId: o.takeId } : {}),
      },
    ];
  });
}

interface CurrentReportFull extends CurrentReport {
  by: 'ai' | 'user';
  at: number;
  lastUserEdit: { diff: string; title?: string } | null;
}

/** The report the experiment has now, from its own document (labReports/{labReportId}); null when there is none. */
async function loadCurrentReport(db: Firestore, exp: DocumentData): Promise<CurrentReportFull | null> {
  const id = typeof exp.labReportId === 'string' && exp.labReportId ? exp.labReportId : null;
  if (!id) return null;
  const snap = await db.doc(`labReports/${id}`).get();
  const rep = snap.data();
  if (!rep) return null;
  const text = typeof rep.text === 'string' ? rep.text : typeof exp.aiReport === 'string' ? exp.aiReport : '';
  if (!text) return null;
  const toMs = (v: unknown): number | null =>
    v && typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function'
      ? (v as { toMillis: () => number }).toMillis()
      : typeof v === 'number'
        ? v
        : null;
  const edited = rep.editedBy === 'user';
  const lue = rep.lastUserEdit as { diff?: unknown; title?: unknown } | undefined;
  return {
    id,
    title: typeof rep.title === 'string' && rep.title.trim() ? rep.title : recordingTitle(exp),
    text,
    images: reportImagesOf(rep.images),
    by: edited ? 'user' : 'ai',
    at:
      (edited ? toMs(rep.editedAt) : null) ??
      toMs(rep.generatedAt) ??
      toMs(rep.at) ??
      toMs(exp.aiReportAt) ??
      Date.now(),
    lastUserEdit:
      edited && lue && typeof lue.diff === 'string'
        ? { diff: lue.diff, ...(typeof lue.title === 'string' ? { title: lue.title } : {}) }
        : null,
  };
}

export function recordingAiFunctions(deps: RecordingAiDeps) {
  const { db } = deps;

  /** One request of a recording conversation; streams when the caller asks for it. */
  const recordingAiTurn = onCall(
    { secrets: CHAT_SECRETS, timeoutSeconds: 540, memory: '1GiB' },
    async (request, response) => {
      const mongoId = deps.requireMongoId(request.auth);
      const uid = request.auth!.uid;
      const token = request.auth!.token as Record<string, unknown>;
      const d = (request.data ?? {}) as Record<string, unknown>;
      const expId = typeof d.expId === 'string' ? d.expId.trim() : '';
      if (!expId || expId.includes('/') || expId.length > 200) throw new HttpsError('invalid-argument', 'Bad expId.');
      const target: 'ask' | 'report' = d.thread === 'report' ? 'report' : 'ask';
      const input = parseInput(d.input);
      const browserTools = Array.isArray(d.browserTools)
        ? d.browserTools.filter((x): x is string => typeof x === 'string')
        : [];
      const emit = (chunk: Record<string, unknown>) => {
        if (request.acceptsStreaming && response) {
          try {
            void response.sendChunk(chunk);
          } catch {
            // The client went away; the request still finishes and is persisted.
          }
        }
      };

      const exp = (await db.doc(`experiments/${expId}`).get()).data();
      if (!exp) throw new HttpsError('not-found', 'Recording not found.');
      if (exp.sourceType !== 'recording' && exp.sourceType !== 'photos') {
        // the showcase clips (.vir) have no frames the browser's tools can read; the page says so (decision F)
        throw new HttpsError('failed-precondition', 'AI analysis is not available for this kind of clip.');
      }
      if (!canReadExperiment(exp, mongoId, token))
        throw new HttpsError('permission-denied', 'You cannot view this recording.');
      if (target === 'report' && exp.ownerId !== mongoId) {
        throw new HttpsError('permission-denied', 'Only the recording owner can write its report.');
      }
      if (target === 'report' && input.kind === 'message')
        throw new HttpsError('invalid-argument', 'A report run takes no messages.');
      if (target === 'ask' && input.kind === 'report')
        throw new HttpsError('invalid-argument', 'Ask for the report in the AI Report tab.');

      // Who may ask, in the order the checks cost: the token, then the account's consent and suspension, then
      // the counters' transaction — only for an input that starts a turn (the browser's tool results and a
      // resume continue one already paid for; aiAccess.ts).
      const { tier } = await requireAiAccess(db, token, mongoId);
      const charged = isChargedInput(input.kind) ? await deps.enforceAiRateLimit(mongoId, tier) : null;
      let modelCalls = 0;
      try {
        const now = Date.now();
        let convo: Convo;
        let create: ConvoDoc | null = null;
        let modelKey: QaModelKey;
        if (target === 'ask') {
          convo = threadConvo(expId, uid);
          const existing = await loadConvo(convo);
          // the model is fixed by the first message (decision C); before it the picker's choice stands
          modelKey =
            existing && existing.seq > 0
              ? (offeredModelKey(existing.model) ?? DEFAULT_MODEL_KEY)
              : (offeredModelKey(d.model) ?? DEFAULT_MODEL_KEY);
          if (!existing) create = emptyConvo('thread', { uid, mongoId, expId, model: modelKey }, now);
          else if (existing.model !== modelKey) await updateConvo(convo, { model: modelKey });
        } else if (input.kind === 'report') {
          const runId = newId('run');
          convo = runConvo(expId, runId);
          modelKey = offeredModelKey(d.model) ?? DEFAULT_MODEL_KEY;
          create = {
            ...emptyConvo('run', { uid, mongoId, expId, model: modelKey }, now),
            mode: input.mode,
            notes: input.notes || null,
            reportId: newReportId(mongoId),
          };
          // the page learns where to send the browser's tool results before anything else arrives
          emit({ t: 'run', runId });
        } else {
          if (!isValidId(d.runId)) throw new HttpsError('invalid-argument', 'Bad runId.');
          convo = runConvo(expId, d.runId);
          const existing = await loadConvo(convo);
          if (!existing || existing.uid !== uid) throw new HttpsError('not-found', 'This report run no longer exists.');
          modelKey = offeredModelKey(existing.model) ?? DEFAULT_MODEL_KEY;
        }
        const spec = specFor(modelKey);

        const lockId = newId('lock');
        const locked = await acquireLock(convo, lockId, create);
        const runId = convo.kind === 'run' ? convo.id : undefined;
        if (!locked)
          return { status: 'busy', pending: [], runId, model: modelKey } satisfies TurnOutcome &
            Record<string, unknown>;
        try {
          const current = await loadCurrentReport(db, exp);
          let report: ReportTarget | null = null;
          let editNote: { diff: string; title?: string } | null = null;
          if (convo.kind === 'run') {
            const mode = locked.mode ?? 'rewrite';
            report = {
              expId,
              exp,
              mongoId,
              reportId: locked.reportId ?? newReportId(mongoId),
              modelKey,
              notes: locked.notes ?? null,
              mode,
              current:
                mode === 'revise' && current
                  ? { id: current.id, title: current.title, text: current.text, images: current.images }
                  : null,
            };
            // the owner's edit since the AI last wrote, as a note at the start of a revise run
            if (input.kind === 'report' && mode === 'revise' && current?.lastUserEdit) editNote = current.lastUserEdit;
          }
          const reportCtx: ReportInContext | null = current
            ? {
                title: current.title,
                text: current.text,
                by: current.by,
                at: current.at,
                images: current.images.map((i) => ({ id: i.id, caption: i.caption })),
              }
            : null;
          let outcome: TurnOutcome;
          try {
            outcome = await runTurn({
              convo,
              doc: locked,
              input,
              spec,
              browserTools,
              setting: {
                kind: convo.kind === 'run' ? 'run' : 'thread',
                mode: locked.mode,
                recording: { expId, title: recordingTitle(exp), kind: recordingKind(exp) },
                report: reportCtx,
              },
              report,
              editNote,
              tier,
              emit,
              onModelCall: () => (modelCalls += 1),
            });
          } catch (err) {
            if (convo.kind === 'run') await updateConvo(convo, { status: 'failed' }).catch(() => undefined);
            throw err;
          }
          if (convo.kind === 'run' && outcome.status === 'done') await updateConvo(convo, { status: 'done' });
          return { ...outcome, runId, model: modelKey };
        } finally {
          await releaseLock(convo, lockId);
        }
      } finally {
        // the conversation was busy, or the model never answered: nothing was spent
        if (charged && modelCalls === 0) await deps.refundAiRateLimit(charged);
      }
    },
  );

  /**
   * The owner's hand edit of the report (decision G): the text with its title, saved as the report now
   * reads, marked as edited by the user, with a line diff from the AI's last wording for the next revise
   * run to read as a note (the app's labProjectEdit reportMarkdown). No consent, quota or suspension check:
   * nothing goes to a provider.
   */
  const editLabReport = onCall(async (request) => {
    const mongoId = deps.requireMongoId(request.auth);
    const d = (request.data ?? {}) as Record<string, unknown>;
    const expId = typeof d.expId === 'string' ? d.expId.trim() : '';
    if (!expId || expId.includes('/') || expId.length > 200) throw new HttpsError('invalid-argument', 'Bad expId.');
    const markdown = typeof d.markdown === 'string' ? d.markdown.slice(0, REPORT_MARKDOWN_MAX) : '';
    if (!markdown.trim()) throw new HttpsError('invalid-argument', 'The report is empty.');
    const ref = db.doc(`experiments/${expId}`);
    const exp = (await ref.get()).data();
    if (!exp) throw new HttpsError('not-found', 'Recording not found.');
    if (exp.ownerId !== mongoId)
      throw new HttpsError('permission-denied', 'Only the recording owner can edit the report.');
    const reportId = typeof exp.labReportId === 'string' && exp.labReportId ? exp.labReportId : null;
    if (!reportId) throw new HttpsError('failed-precondition', 'There is no report to edit yet.');
    const repRef = db.doc(`labReports/${reportId}`);
    const rep = (await repRef.get()).data();
    if (!rep) throw new HttpsError('not-found', 'Report not found.');
    const beforeText = typeof rep.text === 'string' ? rep.text : typeof exp.aiReport === 'string' ? exp.aiReport : '';
    const beforeTitle = typeof rep.title === 'string' ? rep.title : '';
    const title = (typeof d.title === 'string' && d.title.trim() ? d.title : beforeTitle).trim().slice(0, 200);
    if (markdown === beforeText && title === beforeTitle) return { changed: false };
    // The diff the next revise run reads is from the AI's LAST wording, not from the owner's previous edit:
    // that wording is kept with the first edit and carried along by the ones after it.
    const previous = rep.lastUserEdit as { aiText?: unknown } | undefined;
    const aiText = rep.editedBy === 'user' && typeof previous?.aiText === 'string' ? previous.aiText : beforeText;
    const lastUserEdit = {
      aiText,
      diff: lineDiff(aiText, markdown),
      at: Date.now(),
      ...(title !== beforeTitle ? { title } : {}),
    };
    const batch = db.batch();
    batch.set(
      repRef,
      { text: markdown, title, editedBy: 'user', editedAt: FieldValue.serverTimestamp(), lastUserEdit },
      { merge: true },
    );
    batch.set(ref, { aiReport: markdown, aiReportEditedAt: FieldValue.serverTimestamp() }, { merge: true });
    await batch.commit();
    return { changed: true };
  });

  /** Delete the caller's own Ask AI thread on a recording: its turns, images and pictures. */
  const clearRecordingAiThread = onCall(async (request) => {
    deps.requireMongoId(request.auth);
    const d = (request.data ?? {}) as Record<string, unknown>;
    const expId = typeof d.expId === 'string' ? d.expId.trim() : '';
    if (!expId || expId.includes('/') || expId.length > 200) throw new HttpsError('invalid-argument', 'Bad expId.');
    const convo = threadConvo(expId, request.auth!.uid);
    const existing = await loadConvo(convo);
    if (existing && existing.lock && Date.now() - existing.lock.at < 9 * 60 * 1000) {
      throw new HttpsError('failed-precondition', 'The AI is still answering here. Stop it first.');
    }
    await deleteConvo(convo);
    return { ok: true };
  });

  return { recordingAiTurn, editLabReport, clearRecordingAiThread };
}
