/*
 * One request of a recording conversation (recordingAiTurn) — the app's functions/src/turn.ts for one
 * recording. The request carries one input: a user message (with the moments they attached and, the
 * first time, the recording's overview), the results of tools the browser ran, the Generate / Revise /
 * Rewrite request of a report run, or a resume. Then the model runs: it may answer, call server tools (run
 * here) and call browser tools (handed back). The request ends when the model answers without tools,
 * when it needs the browser, or after MAX_MODEL_CALLS_PER_INVOCATION calls. Everything is persisted as it
 * happens, so a dropped connection loses nothing: the page reloads the turns and, if browser tools are
 * pending, runs them and continues.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import type { ChatModelSpec } from '../labCore/config';
import { callChatWithFallback, summarize, type ChatResult, type ToolSchema } from '../labCore/llm';
import { partialJsonString } from '../labCore/partialJson';
import type { ImageDoc, StoredToolCall } from '../labCore/store';
import { PHONE_TOOLS, declaredPhoneTools, normalizeToolArgs, toolSchemas } from '../labCore/toolSchemas';
import type { TwinNoteSelection } from '../twinBuilding';
import {
  CONTEXT_BUDGET_TOKENS,
  KEEP_RECENT_TURNS,
  MAX_IMAGES_PER_INPUT,
  MAX_IMAGE_B64,
  MAX_MODEL_CALLS_PER_INVOCATION,
  MIN_IMAGE_B64,
  MAX_MOMENTS,
  MAX_OVERVIEW_TEXT,
  MAX_RESULT_TEXT,
  MAX_TEXT,
  REPORT_NOTES_MAX,
  RUN_SERVER_TOOLS,
  THREAD_SERVER_TOOLS,
} from './config';
import { buildMessages, estimateTokens, transcriptOf, type Setting } from './context';
import {
  addUsage,
  appendTurn,
  loadImages,
  loadTurns,
  primeImageBytes,
  saveImage,
  updateConvo,
  type Convo,
  type ConvoDoc,
  type RecTurnDoc,
} from './store';
import { runServerTool, type Emit, type ReportTarget, type ServerToolContext, type ToolOutcome } from './tools';

export interface InImage {
  mime: string;
  b64: string;
  caption: string;
}

export interface BrowserToolResultIn {
  callId: string;
  ok: boolean;
  text: string;
  images?: InImage[];
}

/** The recording's overview as the browser computed it (src/labProjects/overview.ts takeOverview). */
export interface OverviewIn {
  text: string;
  images: InImage[];
}

export type TurnInput =
  | {
      kind: 'message';
      text: string;
      /** The moments the user attached: their captures of the player at those instants. */
      moments: InImage[];
      /** With the thread's first message: the recording's overview. */
      overview: OverviewIn | null;
      /** A twin build's message: what the owner selected in the twin's view, checked against the twin's
       *  parts by the caller (twinAgent/, §44.10); parseInput leaves it out. */
      selection?: TwinNoteSelection[];
    }
  | { kind: 'toolResults'; results: BrowserToolResultIn[] }
  | { kind: 'report'; mode: 'revise' | 'rewrite'; notes: string; overview: OverviewIn | null }
  | { kind: 'resume' };

export interface PendingCall {
  id: string;
  name: string;
  args: string;
}

export interface TurnOutcome {
  status: 'done' | 'awaitingBrowser' | 'busy' | 'limit';
  pending: PendingCall[];
}

const SUMMARY_SYSTEM =
  'You condense the earlier part of a conversation between a user and their lab partner about one thermal-imaging recording. Keep every decision, every number that was measured, what was tried and why, open questions, and the user’s stated constraints. Plain prose or short bullet points, in the language of the conversation.';

function asImages(raw: unknown, max = MAX_IMAGES_PER_INPUT): InImage[] {
  if (!Array.isArray(raw)) return [];
  const out: InImage[] = [];
  for (const r of raw.slice(0, max)) {
    const mime = typeof r?.mime === 'string' ? r.mime : 'image/jpeg';
    const b64 = typeof r?.b64 === 'string' ? r.b64 : '';
    // Base64 and big enough to be a picture: a stray "data:," (an empty canvas) or a few bytes, once stored
    // and replayed to the model, would fail every later call of the conversation with an invalid image.
    if (!b64 || b64.length < MIN_IMAGE_B64 || b64.length > MAX_IMAGE_B64) continue;
    if (!/^[A-Za-z0-9+/]+=*$/.test(b64) || !/^image\/(jpeg|png|webp)$/.test(mime)) continue;
    out.push({ mime, b64, caption: typeof r?.caption === 'string' ? r.caption.slice(0, 300) : '' });
  }
  return out;
}

function asOverview(raw: unknown): OverviewIn | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === 'string' ? o.text.slice(0, MAX_OVERVIEW_TEXT) : '';
  if (!text) return null;
  return { text, images: asImages(o.images) };
}

/** Validate the request's `input` into a TurnInput. */
export function parseInput(raw: unknown): TurnInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  switch (r.kind) {
    case 'message': {
      const text = typeof r.text === 'string' ? r.text.slice(0, MAX_TEXT) : '';
      const moments = asImages(r.moments, MAX_MOMENTS);
      if (!text.trim() && moments.length === 0) throw new HttpsError('invalid-argument', 'The message is empty.');
      return { kind: 'message', text, moments, overview: asOverview(r.overview) };
    }
    case 'toolResults': {
      const results = Array.isArray(r.results)
        ? r.results.map((x) => {
            const o = (x ?? {}) as Record<string, unknown>;
            return {
              callId: typeof o.callId === 'string' ? o.callId : '',
              ok: o.ok !== false,
              text: typeof o.text === 'string' ? o.text.slice(0, MAX_RESULT_TEXT) : '',
              images: asImages(o.images),
            };
          })
        : [];
      return { kind: 'toolResults', results: results.filter((x) => x.callId) };
    }
    case 'report':
      return {
        kind: 'report',
        mode: r.mode === 'revise' ? 'revise' : 'rewrite',
        notes: typeof r.notes === 'string' ? r.notes.trim().slice(0, REPORT_NOTES_MAX) : '',
        overview: asOverview(r.overview),
      };
    case 'resume':
      return { kind: 'resume' };
    default:
      throw new HttpsError('invalid-argument', 'Unknown input.');
  }
}

/** Whether an input starts a turn the account is charged for (the browser's tool results continue one). */
export const isChargedInput = (kind: TurnInput['kind']): boolean => kind === 'message' || kind === 'report';

/** The last assistant turn's calls that have no result, unless the user has since moved on. */
export function pendingCalls(turns: RecTurnDoc[]): StoredToolCall[] {
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
      return (t.toolCalls ?? []).filter((c) => !done.has(c.id));
    }
  }
  return [];
}

/** Whether the conversation is waiting for the model (the last word is not the model's; notes say nothing). */
export function needsModel(turns: RecTurnDoc[]): boolean {
  const said = turns.filter((t) => t.role !== 'note');
  const last = said[said.length - 1];
  if (!last || pendingCalls(said).length > 0) return false;
  if (last.role === 'assistant') return (last.toolCalls ?? []).length > 0 && pendingCalls(said).length === 0;
  return true;
}

const PREVIEW_TOOLS = new Set(['write_report']);

/**
 * Another conversation's tools and prompt over the same loop (the digital twin's agent build,
 * docs/digital-twin-plan.md §43.5): which browser tools it may use (the synced look / run_code and
 * its own), the schemas of its own tools, which synced server tools it declares, how its own server
 * tools run, and what the system prompt says. Left out, the loop is the recording AI's as before.
 */
export interface TurnToolset {
  /** The browser tools this conversation may use; the client must declare them too (browserTools). */
  phoneTools: readonly string[];
  /** Schemas beyond labCore/toolSchemas.ts (which is synced from the app and cannot carry them). */
  extraSchemas?: ToolSchema[];
  /** The synced server tools to declare, by name (view, write_report, …). */
  serverTools: readonly string[];
  /** Runs one of this conversation's own server tools; null for a name it does not own. */
  serverTool?: (ctx: ServerToolContext, name: string, args: string) => Promise<ToolOutcome | null>;
  systemPrompt?: (setting: Setting) => string;
}

export async function runTurn(opts: {
  convo: Convo;
  /** The conversation as the lock found it (acquireLock). */
  doc: ConvoDoc;
  input: TurnInput;
  /** The model the conversation runs on: one spec, no fallback to another vendor (decision C). */
  spec: ChatModelSpec;
  /** The tools the browser said it can run. */
  browserTools: string[];
  /** Where things stand, for the system prompt; `summary` is filled in from the document here. */
  setting: Omit<Setting, 'summary'>;
  /** A report run's target; null in a thread. */
  report: ReportTarget | null;
  /** The owner's edit of the current report since the last run, told to the model as a note (revise). */
  editNote: { diff: string; title?: string } | null;
  tier: string;
  emit: Emit;
  /** Called once per model call that answered — a request with none is refunded. */
  onModelCall?: () => void;
  toolset?: TurnToolset;
}): Promise<TurnOutcome> {
  const { convo, input, emit, toolset } = opts;
  let doc = opts.doc;
  // The browser tools in play: those the client declared that this conversation allows.
  const allowedPhone: readonly string[] = toolset ? toolset.phoneTools : PHONE_TOOLS;
  const browserTools: readonly string[] = opts.browserTools.filter((n) => allowedPhone.includes(n));
  const serverTools = toolset ? toolset.serverTools : convo.kind === 'run' ? RUN_SERVER_TOOLS : THREAD_SERVER_TOOLS;
  const tools: ToolSchema[] = [
    ...toolSchemas(declaredPhoneTools(browserTools), { serverTools }),
    ...(toolset?.extraSchemas ?? []).filter((s) => browserTools.includes(s.name) || !allowedPhone.includes(s.name)),
  ];
  const specs = [opts.spec];
  const images: ImageDoc[] = await loadImages(convo);
  let turns: RecTurnDoc[] = await loadTurns(convo, doc.summary?.throughSeq ?? 0);

  const push = async (turn: Omit<RecTurnDoc, 'seq' | 'at'>): Promise<RecTurnDoc> => {
    const full = await appendTurn(convo, turn);
    turns.push(full);
    emit({ t: 'turn', turn: full });
    return full;
  };

  const storeImages = async (list: InImage[], kind: ImageDoc['kind'], fallbackCaption: string): Promise<string[]> => {
    const ids: string[] = [];
    for (const im of list) {
      const saved = await saveImage(convo, im, { kind, caption: im.caption || fallbackCaption, takeId: convo.expId });
      primeImageBytes(saved, im.b64);
      images.push(saved);
      emit({ t: 'image', image: saved });
      ids.push(saved.id);
    }
    return ids;
  };

  const overviewEvent = async (overview: OverviewIn | null): Promise<RecTurnDoc['event'] | undefined> => {
    if (!overview) return undefined;
    const imageIds = await storeImages(overview.images, 'overview', 'Overview');
    return { type: 'takesAdded', takes: [{ takeId: convo.expId, overview: overview.text }], imageIds };
  };

  // ---- the input
  if (input.kind === 'message') {
    const event = await overviewEvent(input.overview);
    const momentImageIds = await storeImages(input.moments, 'look', 'The player at a moment the user attached');
    await push({
      role: 'user',
      text: input.text,
      ...(event ? { event } : {}),
      ...(momentImageIds.length ? { momentImageIds } : {}),
      ...(input.selection?.length ? { selection: input.selection } : {}),
    });
  } else if (input.kind === 'report') {
    if (opts.editNote) {
      await push({
        role: 'note',
        note: { type: 'reportEdited', diff: opts.editNote.diff, title: opts.editNote.title },
      });
    }
    const event = await overviewEvent(input.overview);
    await push({
      role: 'user',
      request: 'report',
      ...(input.notes ? { text: input.notes } : {}),
      ...(event ? { event } : {}),
    });
  } else if (input.kind === 'toolResults') {
    const waiting = new Map(pendingCalls(turns).map((c) => [c.id, c]));
    for (const r of input.results) {
      const call = waiting.get(r.callId);
      if (!call || call.side !== 'phone') continue;
      const imageIds = await storeImages(r.images ?? [], 'look', 'Frame');
      await push({ role: 'tool', callId: call.id, name: call.name, ok: r.ok, result: { text: r.text, imageIds } });
      waiting.delete(call.id);
    }
  }

  const toolCtx: ServerToolContext = { convo, images, emit, report: opts.report };

  const runServerCalls = async (calls: StoredToolCall[]) => {
    for (const c of calls) {
      emit({ t: 'status', s: 'tool', tool: c.name });
      const own = toolset?.serverTool ? await toolset.serverTool(toolCtx, c.name, c.args) : null;
      const out = own ?? (await runServerTool(toolCtx, c.name, c.args));
      await push({
        role: 'tool',
        callId: c.id,
        name: c.name,
        ok: out.ok,
        result: { text: out.text, imageIds: out.images.map((i) => i.doc.id) },
      });
    }
  };

  const setting = (): Setting => ({ ...opts.setting, summary: doc.summary?.text ?? null });

  for (let calls = 0; calls < MAX_MODEL_CALLS_PER_INVOCATION; ) {
    // Finish what an earlier request left: server calls run here, browser calls go back.
    const pending = pendingCalls(turns);
    const pendingServer = pending.filter((c) => c.side === 'server');
    if (pendingServer.length > 0) {
      await runServerCalls(pendingServer);
      continue;
    }
    const pendingBrowser = pending.filter((c) => c.side === 'phone');
    if (pendingBrowser.length > 0) {
      return {
        status: 'awaitingBrowser',
        pending: pendingBrowser.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      };
    }
    if (!needsModel(turns)) return { status: 'done', pending: [] };

    const system = toolset?.systemPrompt ? toolset.systemPrompt(setting()) : undefined;
    let messages = await buildMessages(setting(), turns, images, new Map(), system);
    if (estimateTokens(messages) > CONTEXT_BUDGET_TOKENS && turns.length > KEEP_RECENT_TURNS + 10) {
      // Fold the older part of the conversation into a summary, cutting at a user message so no assistant
      // call is separated from its results.
      let cut = turns.length - KEEP_RECENT_TURNS;
      while (cut < turns.length && turns[cut].role !== 'user') cut += 1;
      if (cut > 0 && cut < turns.length) {
        emit({ t: 'status', s: 'summarizing' });
        const old = turns.slice(0, cut);
        const text = await summarize(
          specs,
          SUMMARY_SYSTEM,
          `${doc.summary?.text ? `Earlier summary:\n${doc.summary.text}\n\n` : ''}Conversation:\n${transcriptOf(old)}`,
        );
        const summary = { text, throughSeq: old[old.length - 1].seq };
        await updateConvo(convo, { summary });
        doc = { ...doc, summary };
        turns = turns.slice(cut);
        messages = await buildMessages(setting(), turns, images, new Map(), system);
      }
    }

    emit({ t: 'status', s: 'thinking' });
    const previewAt = new Map<number, number>();
    let result: ChatResult;
    try {
      result = await callChatWithFallback(specs, messages, tools, {
        onText: (d) => emit({ t: 'text', d }),
        // the page drops the half-written reply and preview it shows
        onRetry: () => {
          previewAt.clear();
          emit({ t: 'status', s: 'retrying' });
        },
        onWebSearch: (searching) =>
          emit(searching ? { t: 'status', s: 'tool', tool: 'web_search' } : { t: 'status', s: 'thinking' }),
        onToolArgs: (index, name, argsSoFar) => {
          if (!PREVIEW_TOOLS.has(name)) return;
          const text = partialJsonString(argsSoFar, 'markdown');
          if (text == null) return;
          const last = previewAt.get(index) ?? 0;
          if (text.length - last >= 160) {
            previewAt.set(index, text.length);
            emit({ t: 'preview', tool: name, text });
          }
        },
      });
    } catch (err) {
      console.error('recordingAi: the model did not answer', convo.ref.path, err);
      throw new HttpsError('unavailable', 'The AI could not answer just now. Try again in a moment.');
    }
    calls += 1;
    opts.onModelCall?.();
    console.log(
      JSON.stringify({
        event: 'recordingAi_model',
        convo: convo.ref.path,
        kind: convo.kind,
        tier: opts.tier,
        provider: result.provider,
        model: result.model,
        ms: result.ms,
        input: result.usage?.input ?? null,
        output: result.usage?.output ?? null,
        reasoning: result.usage?.reasoning ?? null,
        finish: result.finishReason,
        toolCalls: result.toolCalls.map((c) => c.name),
        ...(result.webSearches ? { webSearches: result.webSearches.map((w) => w.queries ?? [w.url ?? w.action]) } : {}),
      }),
    );
    await addUsage(convo, { calls: 1, input: result.usage?.input, output: result.usage?.output });

    // A call to a tool the model was not given (it made the name up) stays on the server, where it is
    // answered as a tool that does not exist: it never reaches the browser, and the model hears it failed.
    const toolCalls: StoredToolCall[] = result.toolCalls.map((c) => ({
      id: c.id,
      name: c.name,
      args: normalizeToolArgs(c.name, c.args),
      side: browserTools.includes(c.name) ? 'phone' : 'server',
      ...(c.signature ? { signature: c.signature } : {}),
    }));
    await push({
      role: 'assistant',
      text: result.text,
      model: `${result.provider}/${result.model}`,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(result.webSearches ? { webSearches: result.webSearches } : {}),
    });
    if (toolCalls.length === 0) return { status: 'done', pending: [] };
    await runServerCalls(toolCalls.filter((c) => c.side === 'server'));
  }
  return { status: 'limit', pending: [] };
}
