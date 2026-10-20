/*
 * The analyzer's Ask AI and AI Report on the app's AI flow (docs/analyzer-ai-app-flow-plan.md): the wire.
 * One streamed request of a conversation about a recording (recordingAiTurn: an Ask AI THREAD, one per
 * user and recording, or a report RUN, one per Generate / Revise / Rewrite), the reads of what the server
 * persisted (the thread's or run's turns and images, the report's own document), the owner's hand edit of
 * the report, the clearing of a thread or a report, and the AI data agreement a personal account records
 * before its first request (users/{mongoId}/consents/aiThirdParty — the document the app writes too).
 *
 * The shapes are the app's lab-project conversation shapes (src/labProjects/core/types.ts Turn,
 * ProjectImage, PendingCall), which is what lets the Projects page's readers draw these conversations.
 */
import { httpsCallable } from 'firebase/functions';
import { collection, doc, getDoc, getDocs, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';
import type { PendingCall, ProjectImage, Turn } from '../labProjects/core/types';
import type { QaModel } from '../types';
import { firebaseDatabase, firebaseFunctions } from './firebase';

/** A turn of a recording conversation: the app's, plus the moments a user message attached (their player captures), as image ids. */
export type RecTurn = Turn & { momentImageIds?: string[] };
export type RecImage = ProjectImage;

/** A picture a saved report embeds (labReports.images[]): the id its Markdown names, and where its bytes are. */
export interface ReportImageRef {
  id: string;
  caption: string;
  mime: string;
  path: string;
  url: string;
  kind: string;
  takeId?: string;
}

/** The report as write_report just saved it (the `report` chunk). */
export interface SavedReport {
  id: string;
  title: string;
  markdown: string;
  images: ReportImageRef[];
  model: string;
  instructions: string | null;
  at: number;
}

export type RecStreamChunk =
  | { t: 'text'; d: string }
  | { t: 'turn'; turn: RecTurn }
  | { t: 'image'; image: RecImage }
  | { t: 'status'; s: string; tool?: string }
  | { t: 'preview'; tool: string; text: string }
  /** The id of the report run just started, before anything else arrives. */
  | { t: 'run'; runId: string }
  | { t: 'report'; report: SavedReport };

export interface InImage {
  mime: string;
  b64: string;
  caption: string;
}

/** The recording's overview as the browser computed it (src/labProjects/overview.ts). */
export interface OverviewIn {
  text: string;
  images: InImage[];
}

export type RecTurnInput =
  | { kind: 'message'; text: string; moments: InImage[]; overview: OverviewIn | null }
  | { kind: 'toolResults'; results: { callId: string; ok: boolean; text: string; images?: InImage[] }[] }
  | { kind: 'report'; mode: 'revise' | 'rewrite'; notes: string; overview: OverviewIn | null }
  | { kind: 'resume' };

export interface RecTurnOutcome {
  status: 'done' | 'awaitingBrowser' | 'busy' | 'limit';
  pending: PendingCall[];
  /** The run's id (a report run). */
  runId?: string;
  /** The model the conversation runs on. */
  model?: string;
}

/** A request lasts at most the function's 540 s, plus slack. */
const TURN_TIMEOUT_MS = 570_000;

export class RecTurnError extends Error {
  constructor(
    message: string,
    /** The callable's code without its prefix, or null when the failure was not the server's. */
    readonly code: string | null,
    /** Stop was pressed: not a failure. */
    readonly cancelled = false,
  ) {
    super(message);
  }
}

/** The prefix the server puts on a refusal that wants the AI data agreement first (functions/src/aiAccess.ts). */
export const AI_CONSENT_REQUIRED = 'AI_CONSENT_REQUIRED';
export const isConsentRequired = (message: string | null | undefined): boolean =>
  typeof message === 'string' && message.includes(AI_CONSENT_REQUIRED);

const callableCode = (e: unknown): string | null => {
  const raw = (e as { code?: unknown })?.code;
  return typeof raw === 'string' ? raw.replace(/^functions\//, '') : null;
};

export interface RecTurnRequest {
  done: Promise<RecTurnOutcome>;
  /** Drops the connection. The server finishes the step it is on and persists it. */
  abort(): void;
}

/**
 * One request to recordingAiTurn, streamed: each chunk goes to `onChunk` as it arrives, `done` settles
 * with the outcome. The browser declares the tools it can run (look and run_code over the recording's
 * frames); a call for one of them comes back as `awaitingBrowser`, and the runner answers it with
 * `toolResults` in the next request.
 */
export function streamRecordingTurn(opts: {
  expId: string;
  thread: 'ask' | 'report';
  runId?: string;
  input: RecTurnInput;
  model: QaModel;
  browserTools: readonly string[];
  onChunk: (chunk: RecStreamChunk) => void;
}): RecTurnRequest {
  const controller = new AbortController();
  const done = (async (): Promise<RecTurnOutcome> => {
    const fn = httpsCallable<Record<string, unknown>, RecTurnOutcome, RecStreamChunk>(
      firebaseFunctions,
      'recordingAiTurn',
      {
        timeout: TURN_TIMEOUT_MS,
      },
    );
    try {
      const { stream, data } = await fn.stream(
        {
          expId: opts.expId,
          thread: opts.thread,
          ...(opts.runId ? { runId: opts.runId } : {}),
          input: opts.input,
          model: opts.model,
          browserTools: [...opts.browserTools],
        },
        { signal: controller.signal },
      );
      // The SDK rejects both the iterator and this promise on a mid-stream error; the loop throws first,
      // so this rejection is marked handled and `await data` below still surfaces it.
      void data.catch(() => {});
      for await (const chunk of stream) {
        if (chunk && typeof chunk === 'object' && 't' in chunk) {
          try {
            opts.onChunk(chunk);
          } catch {
            // a rendering problem must not kill the stream
          }
        }
      }
      return await data;
    } catch (e) {
      if (controller.signal.aborted) throw new RecTurnError('Cancelled.', null, true);
      const code = callableCode(e);
      const raw = (e as Error)?.message ?? '';
      throw new RecTurnError(raw || 'Something went wrong.', code);
    }
  })();
  return { done, abort: () => controller.abort() };
}

export interface LoadedConvo {
  turns: RecTurn[];
  images: RecImage[];
  /** The model key the conversation runs on, fixed by its first turn; null before there is one. */
  model: string | null;
  seq: number;
  /** A run only. */
  status?: 'running' | 'done' | 'failed';
  mode?: 'revise' | 'rewrite';
  notes?: string | null;
}

async function loadConvo(path: string): Promise<LoadedConvo | null> {
  const head = await getDoc(doc(firebaseDatabase, path));
  if (!head.exists()) return null;
  const data = head.data();
  const [turnSnap, imageSnap] = await Promise.all([
    getDocs(query(collection(firebaseDatabase, `${path}/turns`), orderBy('seq', 'asc'))),
    getDocs(collection(firebaseDatabase, `${path}/images`)),
  ]);
  return {
    turns: turnSnap.docs.map((d) => d.data() as RecTurn),
    images: imageSnap.docs.map((d) => d.data() as RecImage).sort((a, b) => a.at - b.at),
    model: typeof data.model === 'string' ? data.model : null,
    seq: typeof data.seq === 'number' ? data.seq : 0,
    ...(data.status ? { status: data.status as LoadedConvo['status'] } : {}),
    ...(data.mode ? { mode: data.mode as LoadedConvo['mode'] } : {}),
    ...('notes' in data ? { notes: (data.notes as string | null) ?? null } : {}),
  };
}

/** The caller's own Ask AI thread on a recording, as the server persisted it; null when they have none. */
export const loadThread = (expId: string, uid: string): Promise<LoadedConvo | null> =>
  loadConvo(`experiments/${expId}/aiThreads/${uid}`);

/** A report run the owner started, as the server persisted it; null when it is gone (a week's TTL). */
export const loadRun = (expId: string, runId: string): Promise<LoadedConvo | null> =>
  loadConvo(`experiments/${expId}/aiReportRuns/${runId}`);

/** Delete the caller's own Ask AI thread on a recording (turns, images and pictures). */
export async function clearThread(expId: string): Promise<void> {
  const fn = httpsCallable<{ expId: string }, { ok: boolean }>(firebaseFunctions, 'clearRecordingAiThread');
  await fn({ expId });
}

/** The owner's hand edit of the report (editLabReport). Resolves with whether anything changed. */
export async function editLabReport(expId: string, title: string, markdown: string): Promise<boolean> {
  const fn = httpsCallable<{ expId: string; title: string; markdown: string }, { changed: boolean }>(
    firebaseFunctions,
    'editLabReport',
  );
  const res = await fn({ expId, title, markdown });
  return res.data.changed;
}

/** Delete the experiment's saved AI report (owner only; clearLabReport). */
export async function clearLabReport(expId: string): Promise<void> {
  const fn = httpsCallable<{ expId: string }, unknown>(firebaseFunctions, 'clearLabReport');
  await fn({ expId });
}

/** What the report's own document adds to the text the experiment carries: its title, pictures and edit state. */
export interface LabReportMeta {
  title: string;
  images: ReportImageRef[];
  editedBy: 'user' | null;
  /** Written by the previous engine (generateLabReport): its [figure] markers name instants, not pictures. */
  legacy: boolean;
}

export async function fetchLabReport(labReportId: string): Promise<LabReportMeta | null> {
  try {
    const snap = await getDoc(doc(firebaseDatabase, `labReports/${labReportId}`));
    if (!snap.exists()) return null;
    const d = snap.data();
    const images = Array.isArray(d.images)
      ? (d.images as ReportImageRef[]).filter((i) => i && typeof i.id === 'string')
      : [];
    return {
      title: typeof d.title === 'string' ? d.title : '',
      images,
      editedBy: d.editedBy === 'user' ? 'user' : null,
      legacy: d.engine !== 'recordingAi',
    };
  } catch {
    return null;
  }
}

/** Keep in step with functions/src/aiAccess.ts AI_CONSENT_VERSION and the app's src/lib/aiConsent.ts. */
export const AI_CONSENT_VERSION = 1;

/**
 * Record the AI data agreement for a personal account — the document the server's requireAiAccess reads
 * (users/{mongoId}/consents/aiThirdParty), in the shape the rules allow a client to write. Staff never
 * needs it; the server says when it is wanted (AI_CONSENT_REQUIRED).
 */
export async function recordAiConsent(mongoId: string): Promise<void> {
  await setDoc(
    doc(firebaseDatabase, `users/${mongoId}/consents/aiThirdParty`),
    {
      version: AI_CONSENT_VERSION,
      acceptedAt: serverTimestamp(),
      platform: 'web',
      appVersion: __BUILD_TIME__.slice(0, 32),
    },
    { merge: true },
  );
}
