/*
 * A project's conversation in motion: one request at a time to
 * labProjectTurn, its stream folded into the project's bundle (store.ts) as
 * it arrives, and the tools the AI asks the browser for (browserTools.ts:
 * look and run_code over the captures' cloud copies) run here and answered
 * in the next request, until the server says done. The website's version of
 * the app's lib/labProjects/runner.ts, with the same RunView and the same
 * words; what differs is the transport (api.ts streamTurn over
 * httpsCallable.stream) and the tools (the browser's, not the phone's).
 *
 * Module state, so leaving the project page does not kill a run; the page
 * subscribes with useProjectRun.
 */

import { firebaseAuth } from '../services/firebase';
import { streamTurn, TurnError, type TurnRequest } from './api';
import { runBrowserTool } from './browserTools';
import { forgetProjectConsent, isConsentRequired } from './consent';
import type { OutImage, PendingCall, ProjectBundle, QuotaLeft, StreamChunk, Take, TurnInput } from './core/types';
import { takeOverview } from './overview';
import { announceTakes, bundleOf, refreshBundle, updateBundle, upsertImage, upsertTurn, useLabStore } from './store';

export interface RunView {
  running: boolean;
  /** The reply being written right now. */
  liveText: string;
  /** What the AI is doing between words (core/runStatus.ts words it). */
  status: string | null;
  /** A plan or report being written, as it grows. */
  preview: { tool: string; text: string } | null;
  error: string | null;
  /** The last input failed and can be retried with resume. */
  canRetry: boolean;
  /** The user's message on its way, shown until the server has it. */
  outgoing: { text: string; takeIds: string[] } | null;
  /** The words of a message that never reached the server, for the page to put back in the box. */
  unsent: string | null;
  /**
   * The server wants the AI data agreement before it takes this input
   * (consent.ts). The input is kept; the page asks, then calls
   * resendAfterConsent or dismissConsent.
   */
  needsConsent: boolean;
  /** What the account had left after its last request here; undefined until the server has said. */
  quota?: QuotaLeft | null;
}

const IDLE: RunView = {
  running: false,
  liveText: '',
  status: null,
  preview: null,
  error: null,
  canRetry: false,
  outgoing: null,
  unsent: null,
  needsConsent: false,
};

/** The input held back for the agreement, by project (RunView.needsConsent). */
const heldForConsent = new Map<string, { input: TurnInput; outgoing: RunView['outgoing'] }>();

const views = new Map<string, RunView>();
const requests = new Map<string, TurnRequest>();
/** Stop was pressed while nothing was on the wire (captures being prepared, a browser tool running). */
const stopped = new Set<string>();

// The reply streams in a few words at a time. The page hears of new words at
// most this often rather than redrawing per word.
const STREAM_NOTIFY_MS = 100;
let streamTimer: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  if (streamTimer) {
    clearTimeout(streamTimer);
    streamTimer = null;
  }
  useLabStore.setState({ runs: Object.fromEntries(views) });
}

function set(projectId: string, patch: Partial<RunView>): void {
  views.set(projectId, { ...(views.get(projectId) ?? IDLE), ...patch });
  notify();
}

/** Like set, for what streams (the reply, a plan or report as it is written): the page hears of it shortly. */
function setStreaming(projectId: string, patch: Partial<RunView>): void {
  views.set(projectId, { ...(views.get(projectId) ?? IDLE), ...patch });
  if (!streamTimer) {
    streamTimer = setTimeout(notify, STREAM_NOTIFY_MS);
  }
}

export function runView(projectId: string): RunView {
  return views.get(projectId) ?? IDLE;
}

export function useProjectRun(projectId: string): RunView {
  return useLabStore((s) => s.runs[projectId] ?? IDLE);
}

export function isRunning(projectId: string): boolean {
  return runView(projectId).running;
}

const activeUid = (): string => firebaseAuth.currentUser?.uid ?? '';

// ---------------------------------------------------------------- chunks

function applyChunk(projectId: string, chunk: StreamChunk): void {
  switch (chunk.t) {
    case 'text': {
      const v = runView(projectId);
      setStreaming(projectId, { liveText: v.liveText + chunk.d, status: null });
      return;
    }
    case 'turn':
      updateBundle(projectId, (b) => announceTakes(upsertTurn(b, chunk.turn), chunk.turn));
      if (chunk.turn.role === 'assistant') {
        set(projectId, { liveText: '', preview: null });
      } else if (chunk.turn.role === 'user') {
        set(projectId, { outgoing: null });
      }
      return;
    case 'project':
      updateBundle(projectId, (b) => ({ ...b, project: chunk.project }));
      return;
    case 'image':
      updateBundle(projectId, (b) => upsertImage(b, chunk.image));
      return;
    case 'status':
      if (chunk.s === 'retrying') {
        // the model's stream was cut and the server is calling it again: the
        // half the page shows would otherwise be followed by the whole again
        set(projectId, { status: 'retrying', liveText: '', preview: null });
        return;
      }
      set(projectId, {
        status:
          chunk.s === 'tool' && chunk.tool
            ? `tool:${chunk.tool}`
            : chunk.s === 'drawing'
              ? `drawing:${chunk.caption ?? ''}`
              : chunk.s,
      });
      return;
    case 'preview':
      setStreaming(projectId, { preview: { tool: chunk.tool, text: chunk.text } });
      return;
    default:
      return;
  }
}

/** The status code of a browser tool at work (core/runStatus.ts words it as the phone's). */
const describeCall = (call: PendingCall): string => `phone:${call.name}`;

// ----------------------------------------------------------------- turns

/** The line for a project another client holds right now. */
export const BUSY_ELSEWHERE = 'The AI is still working on this project (maybe from the app). Try again in a moment.';

/** Failures the user cannot retry their way out of: the message says what to do instead. */
const NO_RETRY = new Set(['resource-exhausted', 'unauthenticated', 'permission-denied', 'failed-precondition']);

/**
 * Run one input through to the end: stream, browser tools, stream again, …
 * An input that takes preparing (a message's captures need their overviews)
 * is given as a function, run under the same busy state; `outgoing` is the
 * user's message, shown until the server has it. A message the server never
 * got comes back to the box as `unsent`, while a report or resume request
 * that failed offers Try Again (resume) instead.
 */
export async function startTurn(
  projectId: string,
  input: TurnInput | (() => Promise<TurnInput>),
  outgoing: RunView['outgoing'] = null,
): Promise<void> {
  if (isRunning(projectId)) {
    return;
  }
  const preparing = typeof input === 'function';
  set(projectId, {
    running: true,
    liveText: '',
    status: preparing ? 'overview' : 'sending',
    preview: null,
    error: null,
    canRetry: false,
    outgoing,
    unsent: null,
    needsConsent: false,
  });
  stopped.delete(projectId);
  let next: TurnInput | null = null;
  try {
    next = preparing ? await input() : input;
    if (stopped.delete(projectId)) {
      // stopped while the captures were being prepared: nothing went out
      const lost = runView(projectId).outgoing;
      if (lost?.text) {
        set(projectId, { unsent: lost.text });
      }
      return;
    }
    if (preparing) {
      set(projectId, { status: 'sending' });
    }
    while (next) {
      const req = streamTurn({ projectId, input: next, onChunk: (c) => applyChunk(projectId, c) });
      requests.set(projectId, req);
      const outcome = await req.done;
      requests.delete(projectId);
      if (outcome?.project) {
        updateBundle(projectId, (b) => ({ ...b, project: outcome.project }));
      }
      if (outcome && 'quota' in outcome) {
        set(projectId, { quota: outcome.quota ?? null });
      }
      if (outcome?.status === 'awaitingPhone' && outcome.pending.length > 0) {
        // the model asked for something the browser does: run it and answer in the next request
        const takes: Take[] = bundleOf(projectId)?.project.takes ?? outcome.project.takes;
        const results = [];
        for (const call of outcome.pending) {
          set(projectId, { status: describeCall(call), liveText: '' });
          results.push(await runBrowserTool(call, takes, projectId));
          if (stopped.has(projectId)) {
            break;
          }
        }
        if (stopped.delete(projectId)) {
          // Stop while the tools ran: the answers are not sent; the calls stay pending (resumePending picks them up)
          next = null;
        } else {
          next = { kind: 'toolResults', results };
          set(projectId, { status: 'thinking' });
        }
      } else if (outcome?.status === 'busy') {
        // the server took nothing: a message's words go back to the box
        const lost = runView(projectId).outgoing;
        set(projectId, { error: BUSY_ELSEWHERE, canRetry: lost == null, ...(lost?.text ? { unsent: lost.text } : {}) });
        next = null;
      } else if (outcome?.status === 'limit') {
        // the server's cap on model calls in one request: the next request carries on
        set(projectId, {
          error: 'The AI stopped after many steps in a row. It can carry on from here.',
          canRetry: true,
        });
        next = null;
      } else {
        next = null;
      }
    }
  } catch (err) {
    requests.delete(projectId);
    const e = err as TurnError;
    const lost = runView(projectId).outgoing;
    if (!e.cancelled && e.code === 'failed-precondition' && isConsentRequired(e.message) && next) {
      // not a failure: the server wants the agreement first. The prepared
      // input waits for the page's answer; the local note was wrong.
      heldForConsent.set(projectId, { input: next, outgoing: lost });
      forgetProjectConsent(activeUid());
      set(projectId, { needsConsent: true });
      return;
    }
    // a message the server never got: its words go back to the box (its
    // captures never left it — they are still waiting)
    if (lost?.text) {
      set(projectId, { unsent: lost.text });
    }
    if (!e.cancelled) {
      set(projectId, {
        error: e.message || 'Something went wrong.',
        canRetry: lost == null && !(e.code != null && NO_RETRY.has(e.code)),
      });
    }
  } finally {
    stopped.delete(projectId);
    set(projectId, { running: false, liveText: '', status: null, preview: null, outgoing: null });
    // The stream carried every turn, but a dropped connection may have missed the end.
    refreshBundle(projectId).catch(() => undefined);
  }
}

/**
 * Stop listening. The server finishes the step it is on and keeps it. While
 * a message's captures are still being prepared, nothing has gone out yet:
 * the message is not sent at all. While a browser tool runs, its answer is
 * not sent; the call stays pending for resumePending.
 */
export function cancelTurn(projectId: string): void {
  const req = requests.get(projectId);
  if (req) {
    req.abort();
  } else if (isRunning(projectId)) {
    stopped.add(projectId);
  }
}

/** The captures waiting beside the message box: filed under the project, not yet sent to the AI. */
export function waitingTakes(b: ProjectBundle | null): Take[] {
  return (b?.project.takes ?? []).filter((t) => !t.announced).sort((x, y) => x.at - y.at);
}

/**
 * Send what the user wrote together with the captures waiting beside the
 * box (added from My Experiments since the last message), each with the
 * website's overview of it (overview.ts). Either may be missing, not both.
 */
export async function sendMessage(projectId: string, text: string, waiting: Take[] = []): Promise<void> {
  if (isRunning(projectId) || (!text.trim() && waiting.length === 0)) {
    return;
  }
  const outgoing = { text, takeIds: waiting.map((t) => t.takeId) };
  if (waiting.length === 0) {
    await startTurn(projectId, { kind: 'message', text }, outgoing);
    return;
  }
  await startTurn(
    projectId,
    async () => {
      const takes: { takeId: string; overview: string }[] = [];
      const images: OutImage[] = [];
      for (const t of waiting) {
        if (stopped.has(projectId)) {
          break;
        }
        const o = await takeOverview(t);
        takes.push({ takeId: t.takeId, overview: o.text });
        images.push(...o.images);
      }
      return { kind: 'message', text, takes, images };
    },
    outgoing,
  );
}

/** Generate Report: the AI writes the report from the conversation and the captures. */
export const requestReport = (projectId: string): Promise<void> => startTurn(projectId, { kind: 'report' });

/** Try Again: carry on from where the last request stopped. */
export const resume = (projectId: string): Promise<void> => startTurn(projectId, { kind: 'resume' });

/** The agreement is on file now: send the input that waited for it. */
export async function resendAfterConsent(projectId: string): Promise<void> {
  const held = heldForConsent.get(projectId);
  heldForConsent.delete(projectId);
  set(projectId, { needsConsent: false });
  if (held) {
    await startTurn(projectId, held.input, held.outgoing);
  }
}

/** The agreement was not given: the words go back to the box. */
export function dismissConsent(projectId: string): void {
  const held = heldForConsent.get(projectId);
  heldForConsent.delete(projectId);
  set(projectId, { needsConsent: false, ...(held?.outgoing?.text ? { unsent: held.outgoing.text } : {}) });
}

/** Hand the page back the words of a message that never got through. */
export function clearUnsent(projectId: string): void {
  if (runView(projectId).unsent != null) {
    set(projectId, { unsent: null });
  }
}

/**
 * Calls the AI asked a client for that nobody answered: the last assistant
 * turn's `side: 'phone'` calls with no tool turn after them, unless the user
 * has since moved on (the app's runner.ts and the server's turn.ts
 * pendingCalls read the thread the same way). The app may have left them
 * (closed mid-run), or this page (a reload).
 */
export function pendingPhoneCalls(b: ProjectBundle | null): PendingCall[] {
  if (!b) {
    return [];
  }
  for (let i = b.turns.length - 1; i >= 0; i--) {
    const t = b.turns[i];
    if (t.role === 'user' || t.role === 'event') {
      return [];
    }
    if (t.role === 'assistant') {
      const done = new Set(
        b.turns
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
 * Finish an interrupted run: answer the waiting calls — the ones the
 * browser can run (look, run_code on captures with a cloud copy) with their
 * results, the others with why not (browserTools.ts) — and continue. Only
 * the owner's page calls this.
 */
export async function resumePending(projectId: string): Promise<boolean> {
  const b = bundleOf(projectId);
  if (!b || isRunning(projectId) || b.project.busy) {
    return false;
  }
  const pending = pendingPhoneCalls(b);
  if (pending.length === 0) {
    return false;
  }
  set(projectId, { running: true, status: describeCall(pending[0]), error: null, canRetry: false });
  stopped.delete(projectId);
  const results = [];
  for (const call of pending) {
    set(projectId, { status: describeCall(call) });
    results.push(await runBrowserTool(call, b.project.takes, projectId));
    if (stopped.has(projectId)) {
      break;
    }
  }
  set(projectId, { running: false, status: null });
  if (stopped.delete(projectId)) {
    return false;
  }
  await startTurn(projectId, { kind: 'toolResults', results });
  return true;
}
