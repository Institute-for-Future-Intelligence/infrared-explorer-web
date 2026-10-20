/*
 * The analyzer's recording AI at work, kept at MODULE level (a zustand store) so a run outlives the tab
 * that started it: workspacePanel unmounts a tab when the user looks at another, and both the Ask AI
 * answer and the report keep arriving meanwhile. The app's lab-project runner (src/labProjects/runner.ts)
 * is the model: one input through to the end — stream, the browser tools the model asked for (look and
 * run_code over the recording's frames, src/labProjects/browserTools.ts), stream again, … — with Stop,
 * Try Again, the AI data agreement, and a resume of calls a dropped connection left pending.
 *
 * Two conversations per recording: the user's Ask AI THREAD and, for the owner, the report RUN in
 * progress (one at a time; a finished run's record is kept until the next starts).
 */
import { create } from 'zustand';
import { ExperimentType, type Experiment, type QaModel, type QaMoment } from '../../../types';
import useCommonStore from '../../../stores/common';
import { firebaseAuth } from '../../../services/firebase';
import {
  isConsentRequired,
  loadRun,
  loadThread,
  streamRecordingTurn,
  type InImage,
  type RecImage,
  type RecStreamChunk,
  type RecTurn,
  type RecTurnError,
  type RecTurnInput,
  type RecTurnRequest,
  type SavedReport,
} from '../../../services/recordingAi';
import { BROWSER_TOOLS, runBrowserTool } from '../../../labProjects/browserTools';
import { forgetCloudTake } from '../../../labProjects/cloudTake';
import { takeOverview } from '../../../labProjects/overview';
import type { PendingCall, Take } from '../../../labProjects/core/types';
import { formatDuration } from '../../../utils/helpers';

// ------------------------------------------------------------------ views

/** What both conversations show while the AI works (the app's RunView). */
interface Working {
  running: boolean;
  /** The reply being written right now. */
  liveText: string;
  /** What the AI is doing between words (src/labProjects/core/runStatus.ts words it). */
  status: string | null;
  /** The report as the model writes it (the write_report argument so far). */
  preview: string | null;
  error: string | null;
  /** The last input failed and can be retried with resume. */
  canRetry: boolean;
  /** The server wants the AI data agreement before it takes this input; the input is kept. */
  needsConsent: boolean;
}

export interface ThreadView extends Working {
  loaded: boolean;
  turns: RecTurn[];
  images: RecImage[];
  /** The model the thread runs on: fixed by its first message (decision C), the picker's choice before that. */
  model: QaModel;
  /** The message on its way, shown until the server has it. */
  outgoing: { text: string; moments: QaMoment[] } | null;
  /** The words of a message that never reached the server, for the page to put back in the box. */
  unsent: string | null;
}

export interface RunView extends Working {
  runId: string | null;
  mode: 'revise' | 'rewrite';
  model: QaModel;
  turns: RecTurn[];
  images: RecImage[];
  /** The run ended (the report was written, or the model stopped without one). */
  finished: boolean;
  /** The report this run saved, when it has. */
  report: SavedReport | null;
}

const IDLE: Working = {
  running: false,
  liveText: '',
  status: null,
  preview: null,
  error: null,
  canRetry: false,
  needsConsent: false,
};

const emptyThread = (model: QaModel): ThreadView => ({
  ...IDLE,
  loaded: false,
  turns: [],
  images: [],
  model,
  outgoing: null,
  unsent: null,
});
const emptyRun = (model: QaModel, mode: RunView['mode']): RunView => ({
  ...IDLE,
  runId: null,
  mode,
  model,
  turns: [],
  images: [],
  finished: false,
  report: null,
});

interface RecordingAiState {
  threads: Record<string, ThreadView>;
  runs: Record<string, RunView>;
}

export const useRecordingAiStore = create<RecordingAiState>(() => ({ threads: {}, runs: {} }));

const pickerModel = (): QaModel => useCommonStore.getState().qaModel;

export const threadView = (expId: string): ThreadView =>
  useRecordingAiStore.getState().threads[expId] ?? emptyThread(pickerModel());
export const runView = (expId: string): RunView | null => useRecordingAiStore.getState().runs[expId] ?? null;
export const useThreadView = (expId: string): ThreadView =>
  useRecordingAiStore((s) => s.threads[expId]) ?? emptyThread(pickerModel());
export const useRunView = (expId: string): RunView | null => useRecordingAiStore((s) => s.runs[expId] ?? null);

// The reply streams in a few words at a time; the page hears of new words at most this often.
const STREAM_NOTIFY_MS = 100;
let pendingThreads: Record<string, ThreadView> | null = null;
let pendingRuns: Record<string, RunView> | null = null;
let streamTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  if (streamTimer) {
    clearTimeout(streamTimer);
    streamTimer = null;
  }
  const patch: Partial<RecordingAiState> = {};
  if (pendingThreads) patch.threads = pendingThreads;
  if (pendingRuns) patch.runs = pendingRuns;
  pendingThreads = null;
  pendingRuns = null;
  if (Object.keys(patch).length > 0) useRecordingAiStore.setState(patch);
}

function setThread(expId: string, patch: Partial<ThreadView>, streaming = false): void {
  const threads = pendingThreads ?? useRecordingAiStore.getState().threads;
  pendingThreads = { ...threads, [expId]: { ...(threads[expId] ?? emptyThread(pickerModel())), ...patch } };
  if (streaming) {
    if (!streamTimer) streamTimer = setTimeout(flush, STREAM_NOTIFY_MS);
  } else flush();
}

function setRun(expId: string, patch: Partial<RunView>, streaming = false): void {
  const runs = pendingRuns ?? useRecordingAiStore.getState().runs;
  const current = runs[expId] ?? emptyRun(pickerModel(), 'rewrite');
  pendingRuns = { ...runs, [expId]: { ...current, ...patch } };
  if (streaming) {
    if (!streamTimer) streamTimer = setTimeout(flush, STREAM_NOTIFY_MS);
  } else flush();
}

const currentThread = (expId: string): ThreadView =>
  (pendingThreads ?? useRecordingAiStore.getState().threads)[expId] ?? emptyThread(pickerModel());
const currentRun = (expId: string): RunView =>
  (pendingRuns ?? useRecordingAiStore.getState().runs)[expId] ?? emptyRun(pickerModel(), 'rewrite');

function upsertTurn(turns: RecTurn[], t: RecTurn): RecTurn[] {
  const i = turns.findIndex((x) => x.seq === t.seq);
  if (i < 0) return [...turns, t].sort((a, b) => a.seq - b.seq);
  const next = turns.slice();
  next[i] = t;
  return next;
}

function upsertImage(images: RecImage[], img: RecImage): RecImage[] {
  return images.some((i) => i.id === img.id) ? images.map((i) => (i.id === img.id ? img : i)) : [...images, img];
}

// ------------------------------------------------------------------ the recording as a take

/** The recording as the browser tools see it: the one take of this conversation, read through its cloud copy (cloudTake.ts). */
export function recordingTake(exp: Experiment): Take {
  return {
    takeId: exp.id,
    localPath: '',
    source: exp.sourceType === ExperimentType.Photos ? 'photos' : 'recording',
    timelapse: !!exp.timelapse,
    name: exp.displayName || 'Recording',
    announced: true,
    at: exp.createdAt?.toMillis?.() ?? 0,
    cloud: { expId: exp.id, at: 0 },
  };
}

/** Whether the recording's frames are readable by the browser tools (the showcase .vir clips are not; decision F). */
export const aiSupports = (exp: Pick<Experiment, 'sourceType'>): boolean =>
  exp.sourceType === ExperimentType.Recording || exp.sourceType === ExperimentType.Photos;

/** The owner moved a probe or a line: the next look / run_code must read the new positions. */
export const forgetRecording = (expId: string): void => forgetCloudTake(expId);

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/;

/** A moment the user attached, as the message carries it: the player as they saw it (or, failing that capture, the bare frame). */
function momentImage(m: QaMoment): InImage | null {
  const src = m.overlay || m.thumbnail;
  const match = src ? DATA_URL.exec(src) : null;
  if (!match) return null;
  const what = m.overlay
    ? 'the player as the user saw it, with their sensors, notes and lines drawn on'
    : 'the thermal frame';
  return { mime: match[1], b64: match[2], caption: `t = ${formatDuration(m.tSeconds)} (${m.tSeconds} s): ${what}` };
}

// ------------------------------------------------------------------ the loop

type Kind = 'ask' | 'report';

interface Driver {
  kind: Kind;
  get(): Working & { turns: RecTurn[]; images: RecImage[]; model: QaModel };
  set(patch: Partial<Working & { turns: RecTurn[]; images: RecImage[]; model: QaModel }>, streaming?: boolean): void;
  runId(): string | undefined;
  onRunId(id: string): void;
  onReport(report: SavedReport): void;
}

const requests = new Map<string, RecTurnRequest>();
/** Stop was pressed while nothing was on the wire (the overview being prepared, a browser tool running). */
const stopped = new Set<string>();
/** The input held back for the agreement, by conversation. */
const heldForConsent = new Map<string, { exp: Experiment; input: RecTurnInput }>();

const keyOf = (expId: string, kind: Kind) => `${kind}:${expId}`;

function threadDriver(expId: string): Driver {
  return {
    kind: 'ask',
    get: () => currentThread(expId),
    set: (patch, streaming) => setThread(expId, patch, streaming),
    runId: () => undefined,
    onRunId: () => undefined,
    onReport: () => undefined,
  };
}

function runDriver(expId: string): Driver {
  return {
    kind: 'report',
    get: () => currentRun(expId),
    set: (patch, streaming) => setRun(expId, patch, streaming),
    runId: () => currentRun(expId).runId ?? undefined,
    onRunId: (id) => setRun(expId, { runId: id }),
    onReport: (report) => {
      setRun(expId, { report });
      // the analyzer reads the report from the experiment document; mirror what the server just wrote
      const store = useCommonStore.getState();
      const exp = store.experimentMap.get(expId);
      if (exp) {
        store.setExperiment(expId, {
          ...exp,
          aiReport: report.markdown,
          aiReportModel: report.model as Experiment['aiReportModel'],
          aiReportInstructions: report.instructions,
          labReportId: report.id,
        });
      }
    },
  };
}

function applyChunk(expId: string, d: Driver, chunk: RecStreamChunk): void {
  switch (chunk.t) {
    case 'text':
      d.set({ liveText: d.get().liveText + chunk.d, status: null }, true);
      return;
    case 'turn': {
      const v = d.get();
      const patch: Partial<ThreadView> = { turns: upsertTurn(v.turns, chunk.turn) };
      if (chunk.turn.role === 'assistant') Object.assign(patch, { liveText: '', preview: null });
      if (chunk.turn.role === 'user' && d.kind === 'ask') (patch as Partial<ThreadView>).outgoing = null;
      d.set(patch);
      return;
    }
    case 'image':
      d.set({ images: upsertImage(d.get().images, chunk.image) });
      return;
    case 'status':
      if (chunk.s === 'retrying') {
        d.set({ status: 'retrying', liveText: '', preview: null });
        return;
      }
      d.set({ status: chunk.s === 'tool' && chunk.tool ? `tool:${chunk.tool}` : chunk.s });
      return;
    case 'preview':
      d.set({ preview: chunk.text }, true);
      return;
    case 'run':
      d.onRunId(chunk.runId);
      return;
    case 'report':
      d.onReport(chunk.report);
      return;
    default:
      return;
  }
}

/** Failures the user cannot retry their way out of: the message says what to do instead. */
const NO_RETRY = new Set([
  'resource-exhausted',
  'unauthenticated',
  'permission-denied',
  'failed-precondition',
  'not-found',
]);

const BUSY = 'The AI is still working on this from another tab. Try again in a moment.';

function markBusy(expId: string, kind: Kind, on: boolean): void {
  const store = useCommonStore.getState();
  if (kind === 'ask') {
    if (on) store.setQaStreaming(expId);
    else if (store.qaStreamingExpId === expId) store.setQaStreaming(null);
  } else {
    if (on) store.setReportStreaming(expId);
    else if (store.reportStreamingExpId === expId) store.setReportStreaming(null);
  }
}

/**
 * Run one input through to the end: stream, browser tools, stream again, … An input that takes
 * preparing (the first message's overview) is given as a function, run under the same busy state.
 */
async function drive(exp: Experiment, d: Driver, input: RecTurnInput | (() => Promise<RecTurnInput>)): Promise<void> {
  const expId = exp.id;
  const key = keyOf(expId, d.kind);
  if (d.get().running) return;
  const preparing = typeof input === 'function';
  d.set({
    running: true,
    liveText: '',
    status: preparing ? 'overview' : 'sending',
    preview: null,
    error: null,
    canRetry: false,
    needsConsent: false,
  });
  markBusy(expId, d.kind, true);
  stopped.delete(key);
  let next: RecTurnInput | null = null;
  const take = recordingTake(exp);
  try {
    next = preparing ? await input() : input;
    if (stopped.delete(key)) {
      // stopped while the overview was being prepared: nothing went out
      if (d.kind === 'ask' && next.kind === 'message') setThread(expId, { unsent: next.text, outgoing: null });
      return;
    }
    if (preparing) d.set({ status: 'sending' });
    while (next) {
      const req = streamRecordingTurn({
        expId,
        thread: d.kind,
        runId: d.runId(),
        input: next,
        model: d.get().model,
        browserTools: BROWSER_TOOLS,
        onChunk: (c) => applyChunk(expId, d, c),
      });
      requests.set(key, req);
      const outcome = await req.done;
      requests.delete(key);
      if (outcome.model) d.set({ model: outcome.model as QaModel });
      if (outcome.runId) d.onRunId(outcome.runId);
      if (outcome.status === 'awaitingBrowser' && outcome.pending.length > 0) {
        // the model asked for something the browser does: run it and answer in the next request
        const results = [];
        for (const call of outcome.pending) {
          d.set({ status: `phone:${call.name}`, liveText: '' });
          results.push(await runBrowserTool(call, [take], `exp:${expId}`));
          if (stopped.has(key)) break;
        }
        if (stopped.delete(key)) {
          // Stop while the tools ran: the answers are not sent; the calls stay pending (resumePending picks them up)
          next = null;
        } else {
          next = { kind: 'toolResults', results };
          d.set({ status: 'thinking' });
        }
      } else if (outcome.status === 'busy') {
        const lost = d.kind === 'ask' ? currentThread(expId).outgoing : null;
        d.set({ error: BUSY, canRetry: lost == null });
        if (lost?.text) setThread(expId, { unsent: lost.text });
        next = null;
      } else if (outcome.status === 'limit') {
        d.set({ error: 'The AI stopped after many steps in a row. It can carry on from here.', canRetry: true });
        next = null;
      } else {
        next = null;
      }
    }
  } catch (err) {
    requests.delete(key);
    const e = err as RecTurnError;
    const lost = d.kind === 'ask' ? currentThread(expId).outgoing : null;
    if (!e.cancelled && e.code === 'failed-precondition' && isConsentRequired(e.message) && next) {
      // not a failure: the server wants the agreement first; the input waits for the page's answer
      heldForConsent.set(key, { exp, input: next });
      d.set({ needsConsent: true });
      return;
    }
    if (lost?.text) setThread(expId, { unsent: lost.text });
    if (!e.cancelled) {
      d.set({
        error: e.message || 'Something went wrong.',
        canRetry: lost == null && !(e.code != null && NO_RETRY.has(e.code)),
      });
    }
  } finally {
    stopped.delete(key);
    d.set({ running: false, liveText: '', status: null, preview: null });
    if (d.kind === 'ask') {
      setThread(expId, { outgoing: null });
    } else {
      // the run is over when nothing is left to do: no failure to retry, no agreement to give, no browser
      // call still pending (Stop while the tools ran leaves those for Continue)
      const r = currentRun(expId);
      const over = r.error == null && !r.needsConsent && pendingBrowserCalls(r.turns).length === 0;
      if (over !== r.finished) setRun(expId, { finished: over });
    }
    markBusy(expId, d.kind, false);
  }
}

/** Stop listening. The server finishes the step it is on and keeps it; a browser tool's answer is not sent. */
function stop(expId: string, kind: Kind): void {
  const key = keyOf(expId, kind);
  const req = requests.get(key);
  if (req) req.abort();
  else if ((kind === 'ask' ? currentThread(expId) : currentRun(expId)).running) stopped.add(key);
}

// ------------------------------------------------------------------ the thread

/** Load the caller's saved thread once per recording (the panel remounts on every tab switch). */
export async function ensureThread(expId: string): Promise<void> {
  const v = currentThread(expId);
  if (v.loaded) return;
  setThread(expId, { loaded: true });
  const uid = firebaseAuth.currentUser?.uid;
  if (!uid) {
    setThread(expId, { loaded: false });
    return;
  }
  try {
    const saved = await loadThread(expId, uid);
    if (saved) {
      const cur = currentThread(expId);
      setThread(expId, {
        turns: saved.turns.length > 0 ? saved.turns : cur.turns,
        images: saved.images.length > 0 ? saved.images : cur.images,
        model: saved.seq > 0 && saved.model ? (saved.model as QaModel) : cur.model,
      });
    }
  } catch (e) {
    console.error('failed to load the Ask AI thread', e);
    setThread(expId, { loaded: false });
  }
}

export const setThreadModel = (expId: string, model: QaModel): void => setThread(expId, { model });
export const setThreadUnsent = (expId: string, unsent: string | null): void => setThread(expId, { unsent });

/**
 * Send a message: its words and the moments attached (their captures), and — the first time — the
 * recording's overview, computed here from its frames (what the app sends with a capture).
 */
export async function sendThreadMessage(exp: Experiment, text: string, moments: QaMoment[]): Promise<void> {
  const expId = exp.id;
  const v = currentThread(expId);
  if (v.running) return;
  setThread(expId, { outgoing: { text, moments }, unsent: null });
  const first = v.turns.length === 0;
  const input = async (): Promise<RecTurnInput> => {
    const overview = first
      ? await takeOverview(recordingTake(exp), (line) => setThread(expId, { status: line ? 'overview' : 'overview' }))
      : null;
    return {
      kind: 'message',
      text,
      moments: moments.map(momentImage).filter((m): m is InImage => m != null),
      overview: overview ? { text: overview.text, images: overview.images } : null,
    };
  };
  await drive(exp, threadDriver(expId), input);
}

export const stopThread = (expId: string): void => stop(expId, 'ask');

/** Try Again after a failed request: the server carries on from what it has. */
export const retryThread = (exp: Experiment): Promise<void> => drive(exp, threadDriver(exp.id), { kind: 'resume' });

/** The thread was cleared on the server: forget it here too. */
export function resetThread(expId: string): void {
  setThread(expId, { ...emptyThread(pickerModel()), loaded: true });
}

// ------------------------------------------------------------------ the report run

/** Start a report run (Generate / Revise / Rewrite): the overview first, then the request with the owner's notes. */
export async function startReportRun(
  exp: Experiment,
  mode: 'revise' | 'rewrite',
  notes: string,
  model: QaModel,
): Promise<void> {
  const expId = exp.id;
  if (currentRun(expId).running) return;
  setRun(expId, { ...emptyRun(model, mode), running: false });
  const input = async (): Promise<RecTurnInput> => {
    const overview = await takeOverview(recordingTake(exp), () => setRun(expId, { status: 'overview' }));
    return { kind: 'report', mode, notes, overview: { text: overview.text, images: overview.images } };
  };
  await drive(exp, runDriver(expId), input);
}

export const stopReportRun = (expId: string): void => stop(expId, 'report');

/** Try Again after a failed request of the run in progress. */
export const retryReportRun = (exp: Experiment): Promise<void> => drive(exp, runDriver(exp.id), { kind: 'resume' });

/** Reload the run in progress from the server (a refreshed page): its turns, and whether the model is waiting for the browser. */
export async function reloadRun(exp: Experiment, runId: string): Promise<void> {
  const saved = await loadRun(exp.id, runId);
  if (!saved) return;
  setRun(exp.id, {
    runId,
    turns: saved.turns,
    images: saved.images,
    mode: saved.mode ?? 'rewrite',
    model: (saved.model as QaModel) ?? pickerModel(),
    finished: saved.status === 'done' || saved.status === 'failed',
  });
}

// ------------------------------------------------------------------ pending browser calls, consent

/** The last assistant turn's browser calls without a result, unless the user has since moved on. */
export function pendingBrowserCalls(turns: RecTurn[]): PendingCall[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === 'user' || t.role === 'event') return [];
    if (t.role === 'assistant') {
      const done = new Set(
        turns
          .slice(i + 1)
          .filter((x) => x.role === 'tool')
          .map((x) => x.callId),
      );
      return (t.toolCalls ?? [])
        .filter((c) => c.side === 'phone' && !done.has(c.id))
        .map((c) => ({ id: c.id, name: c.name, args: c.args }));
    }
  }
  return [];
}

/**
 * Finish what a dropped connection left: run the browser calls still pending and hand their results
 * back, after which the server carries on. Resolves with whether there was anything to resume.
 */
export async function resumePending(exp: Experiment, kind: Kind): Promise<boolean> {
  const expId = exp.id;
  const d = kind === 'ask' ? threadDriver(expId) : runDriver(expId);
  const v = d.get();
  if (v.running) return false;
  const pending = pendingBrowserCalls(v.turns);
  if (pending.length === 0) return false;
  const key = keyOf(expId, kind);
  d.set({ running: true, status: `phone:${pending[0].name}`, error: null, canRetry: false });
  markBusy(expId, kind, true);
  stopped.delete(key);
  const take = recordingTake(exp);
  const results = [];
  for (const call of pending) {
    d.set({ status: `phone:${call.name}` });
    results.push(await runBrowserTool(call, [take], `exp:${expId}`));
    if (stopped.has(key)) break;
  }
  d.set({ running: false, status: null });
  markBusy(expId, kind, false);
  if (stopped.delete(key)) return true;
  await drive(exp, d, { kind: 'toolResults', results });
  return true;
}

/** The agreement is recorded: send the input that waited for it. */
export async function resendAfterConsent(expId: string, kind: Kind): Promise<void> {
  const key = keyOf(expId, kind);
  const held = heldForConsent.get(key);
  heldForConsent.delete(key);
  const d = kind === 'ask' ? threadDriver(expId) : runDriver(expId);
  d.set({ needsConsent: false });
  if (held) await drive(held.exp, d, held.input);
}

/** The user declined: the message goes back to the box; a report run is dropped. */
export function dismissConsent(expId: string, kind: Kind): void {
  const key = keyOf(expId, kind);
  const held = heldForConsent.get(key);
  heldForConsent.delete(key);
  if (kind === 'ask') {
    setThread(expId, {
      needsConsent: false,
      outgoing: null,
      unsent: held?.input.kind === 'message' ? held.input.text : null,
    });
  } else {
    setRun(expId, { needsConsent: false, finished: true });
  }
}
