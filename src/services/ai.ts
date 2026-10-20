/*
 * The website's own AI, over its Cloud Functions: the Lab Assistant (agentChat, the site-wide chat widget;
 * components/aiChat/) and the Digital Twin (analyzeTwinBuilding and its neighbours). The analyzer's Ask AI
 * and AI Report are NOT here since 2026-10-19: they run on the app's AI flow through services/recordingAi.ts
 * (docs/analyzer-ai-app-flow-plan.md).
 */
import { httpsCallable } from 'firebase/functions';
import { Timestamp } from 'firebase/firestore';
import { firebaseFunctions } from './firebase';
import { AgentModel, TwinBuildingRecord, TwinSelectionItem } from '../types';

/**
 * What a twin Function streams while it works (docs/digital-twin-plan.md §28.5; the Functions' TwinProgressChunk):
 * a phase — the pictures being read, the model writing the scene (`modelKey`, and how many pictures it was
 * sent), the measured surfaces being traced (`done` of `total` photos), the record being saved — and, while
 * the model writes, its answer as it comes (`text`, the raw JSON of the record) and its reasoning where the
 * provider streams that (`thought`). `reset` throws away what was streamed so far: the model is starting
 * again in another response mode.
 */
export interface TwinProgressChunk {
  phase?: 'photos' | 'scene' | 'surfaces' | 'saving';
  modelKey?: string;
  photos?: number;
  done?: number;
  total?: number;
  text?: string;
  thought?: string;
  reset?: boolean;
}

/**
 * Call one of the twin Functions over the callable's STREAMING channel: for its progress (`onChunk`, one
 * TwinProgressChunk at a time, §28.5) and because only a streamed call can be cancelled: aborting `signal`
 * (the owner's Stop) drops the connection, which the Function reads as its own cancellation
 * (response.signal) and so stops calling models and writes nothing. A streamed call has no client timeout
 * of its own, so one is set just outside the Function's budget — a Function killed at its limit closes the
 * stream without a result, which would otherwise leave the call waiting forever — and reads as a timeout,
 * not a Stop.
 */
async function callTwinFunction<Req, Res>(
  name: string,
  payload: Req,
  timeoutMs: number,
  signal?: AbortSignal,
  onChunk?: (chunk: TwinProgressChunk) => void,
): Promise<Res> {
  const fn = httpsCallable<Req, Res, TwinProgressChunk>(firebaseFunctions, name);
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', forward, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const { stream, data } = await fn.stream(payload, { signal: controller.signal });
    // The SDK rejects BOTH the iterator and this promise on cancel or a mid-stream error; the loop throws
    // first, so the promise's rejection is marked handled here (as streamLabReport does), and the
    // `await data` below still surfaces the real error.
    void data.catch(() => {});
    for await (const chunk of stream) {
      if (chunk && typeof chunk === 'object') onChunk?.(chunk);
    }
    return await data;
  } catch (e) {
    if (timedOut)
      throw new Error(
        `The analysis did not finish within ${Math.round(timeoutMs / 1000)} s. It may still have saved a twin — reload to check before trying again.`,
      );
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

/**
 * What the owner asks of a build (docs/digital-twin-plan.md §20): the model that builds it (a key of
 * twin/twinModels.ts; the server's default when absent) and their request — what the subject is, what
 * to leave out — which the server quotes to the model and keeps with the twin. Both optional.
 */
export interface TwinBuildOptions {
  model?: string;
  instructions?: string;
}

/** The build options as the callable takes them: a blank request is no request. */
const buildPayload = ({ model, instructions }: TwinBuildOptions) => ({
  ...(model ? { model } : {}),
  ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
});

/**
 * Ask the server to rebuild a subject as a scene program for the digital twin (owner + staff only; see the
 * analyzeTwinBuilding callable and docs/digital-twin-plan.md §17–§18): a PHOTO SET's photos, or — with
 * source 'orbit' — frames sampled from a walk-around RECORDING. The server picks the pictures, reads
 * them and their thermal frames itself and traces the measured surfaces; nothing rides along but the
 * id, the owner's choice of model and request (§20) and, when the owner picked a recording's frames
 * themselves, which ones (§40). Returns the record it persisted in the
 * experiment's twinScene field (kind 'building').
 *
 * With `{ note }`, the call REVISES the model as it stands instead (§19): the owner's words on what is
 * wrong go to an AI model — `model` when the owner picked one, else the one that wrote the program — with
 * the program, the same pictures and the request the twin was built to, and the record that comes back
 * carries the thread (`revisions`). The note may say what it is about — parts, meshes or faces the owner
 * selected in the viewer (`selection`, §28) — and carry `images`: pictures the owner attached (base64,
 * without the data-URL prefix), sent to the model after the photos. A revision the model got wrong is
 * refused and the stored model kept.
 *
 * With `{ retrace }` — some of the twin's measured photos, by stored number — the call only traces those
 * photos again (§32): the model, its thread and its request stay as they are, and the record that comes back
 * carries the new tracing in place of theirs. `signal` stops any of them (see callTwinFunction): nothing is
 * saved.
 */
export interface TwinNoteRequest {
  note: string;
  model?: string;
  selection?: TwinSelectionItem[];
  images?: { data: string; mediaType: string }[];
}

export interface TwinRetraceRequest {
  retrace: number[];
}

/** A scene program's build: with `frames` — a recording's frames the owner picked in the player (stored
 *  frame numbers, plan §40) — the model is shown those, instead of the ones the server samples itself. */
export interface TwinProgramBuildOptions extends TwinBuildOptions {
  frames?: number[];
}

export async function analyzeTwinBuilding(
  expId: string,
  source: 'photos' | 'orbit',
  request: TwinProgramBuildOptions | TwinNoteRequest | TwinRetraceRequest,
  signal?: AbortSignal,
  onChunk?: (chunk: TwinProgressChunk) => void,
): Promise<TwinBuildingRecord> {
  const payload =
    'note' in request
      ? {
          feedback: request.note,
          ...(request.model ? { model: request.model } : {}),
          ...(request.selection?.length
            ? {
                selection: request.selection.map(({ part, mesh, face, kind, round, center, size, label }) => ({
                  part,
                  mesh,
                  face,
                  ...(kind ? { kind } : {}),
                  ...(round !== undefined ? { round } : {}),
                  ...(center ? { center } : {}),
                  ...(size ? { size } : {}),
                  label,
                })),
              }
            : {}),
          ...(request.images?.length
            ? { images: request.images.map(({ data, mediaType }) => ({ data, mediaType })) }
            : {}),
        }
      : 'retrace' in request
        ? { retrace: request.retrace }
        : { ...buildPayload(request), ...(request.frames?.length ? { frames: request.frames } : {}) };
  const res = await callTwinFunction<
    {
      expId: string;
      source: 'photos' | 'orbit';
      feedback?: string;
      selection?: unknown[];
      images?: { data: string; mediaType: string }[];
      retrace?: number[];
      frames?: number[];
    } & TwinBuildOptions,
    { twinScene: Omit<TwinBuildingRecord, 'analyzedAt'> & { analyzedAt: number } }
  >('analyzeTwinBuilding', { expId, source, ...payload }, 370_000, signal, onChunk); // functions: timeoutSeconds 360
  const { analyzedAt, ...rest } = res.twinScene;
  return { ...rest, analyzedAt: Timestamp.fromMillis(analyzedAt) };
}

/** Remove an experiment's twin analysis (owner only) — see the clearTwinScene callable. */
export async function clearTwinScene(expId: string): Promise<void> {
  const fn = httpsCallable<{ expId: string }, { ok: boolean }>(firebaseFunctions, 'clearTwinScene');
  await fn({ expId });
}

/**
 * Carry the source's digital twin onto a freshly cloned copy (`expId`, whose `clonedFrom` is the
 * source). A callable because twinScene is barred from client writes: the server copies the stored
 * record verbatim, so a saved copy keeps the twin — and its provenance — instead of opening empty.
 * Resolves false when there was no twin to carry.
 */
export async function copyTwinScene(expId: string, sourceExpId: string): Promise<boolean> {
  const fn = httpsCallable<{ expId: string; sourceExpId: string }, { copied: boolean }>(
    firebaseFunctions,
    'copyTwinScene',
  );
  const res = await fn({ expId, sourceExpId });
  return res.data.copied === true;
}

// Anthropic content blocks the Lab Assistant transcript can carry: text (rendered), tool_use (the
// assistant asks the browser to run a client tool) and tool_result (the browser's answer, sent back).
export type AgentContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/** One turn in the Lab Assistant transcript (Anthropic-shaped): a plain string, or content blocks. */
export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string | AgentContentBlock[];
}

/** The result of one agent turn: the assistant's content blocks + why it stopped ('tool_use' => it
 *  wants the browser to run the tool_use blocks and call back with tool_result before continuing). */
export interface AgentTurn {
  content: AgentContentBlock[];
  stopReason: string | null;
}

/**
 * One turn of the Lab Assistant (the site-wide chat widget). Sends the running transcript + the current
 * app-state `context` (injected into the model) + the tool names usable on this page, and returns the
 * assistant turn (which may contain tool_use blocks the browser must execute). `model` selects which
 * model answers (see AgentModel/MODEL_KEYS; the widget has no picker and always sends
 * DEFAULT_AGENT_MODEL); the server defaults to GPT-6 Luna if omitted. The
 * answer text STREAMS: `onText` is called with the full accumulated text on every delta so the UI can
 * render it as it grows (tool_use blocks don't stream — they arrive whole in the returned content). The
 * provider API key never reaches the client (agentChat Cloud Function); staff-gated + rate-limited server-side. The
 * browser drives the loop: execute tools -> send tool_result -> call again until no tool_use remains.
 */
export async function agentChat(
  messages: AgentMessage[],
  context: unknown,
  enabledTools: string[],
  model: AgentModel,
  onText?: (fullText: string) => void,
): Promise<AgentTurn> {
  const fn = httpsCallable<
    { messages: AgentMessage[]; context: unknown; enabledTools: string[]; model: AgentModel },
    { content: AgentContentBlock[]; stopReason: string | null },
    { text: string }
  >(firebaseFunctions, 'agentChat');
  const { stream, data } = await fn.stream({ messages, context, enabledTools, model });
  let acc = '';
  for await (const chunk of stream) {
    if (chunk?.text) {
      acc += chunk.text;
      onText?.(acc);
    }
  }
  const res = await data;
  return { content: res?.content ?? [], stopReason: res?.stopReason ?? null };
}

/** What getExperimentData returns: the measured summary and the derived analysis digest the report and
 *  the Q&A see (the shapes are documented in the Lab Assistant's prompt, functions/src/index.ts), plus
 *  the kind — a photo set's times are photo numbers, and photoCount says how many there are. */
export interface ExperimentDataResult {
  summary: unknown;
  analysis: unknown;
  title: string | null;
  sourceType: string;
  photoCount?: number | null;
}

/**
 * Read an experiment's measured thermal summary + derived analysis — the server-side half of the
 * read_experiment_data tool (heavy Firestore + Storage read via loadThermalAnalysis), for every kind:
 * recording, video and photo set. Staff-gated. Timeout raised past the 70s callable default for the same
 * reason as generateLabReport — the function budgets 120s for its frame fan-out (a video's .vir download).
 */
export async function getExperimentData(expId: string): Promise<ExperimentDataResult> {
  const fn = httpsCallable<{ expId: string }, ExperimentDataResult>(
    firebaseFunctions,
    'getExperimentData',
    { timeout: 130_000 }, // functions/src/index.ts getExperimentData: timeoutSeconds 120
  );
  const res = await fn({ expId });
  return res.data;
}
