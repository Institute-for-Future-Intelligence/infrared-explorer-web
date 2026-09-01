import { httpsCallable } from 'firebase/functions';
import { collection, deleteDoc, getDocs, query, where } from 'firebase/firestore';
import { firebaseFunctions, firebaseDatabase } from './firebase';
import {
  AgentModel,
  QaModel,
  DEFAULT_MODEL,
  ReportInputsDescriptor,
  ReportSampling,
  ReportVerification,
  ViewMode,
  isModelKey,
} from '../types';

/**
 * One attached moment as it travels to the server: which frame it is, when it is — and, for a
 * vision-capable model, `overlay`: the capture of the player exactly as the user saw it (the frame with
 * its probe markers, annotation callouts and transect lines drawn on). `overlayView` names the view that
 * capture is of, so the server drops the bare stored render it stands in for and still sends the other one.
 */
export interface QaMomentPayload {
  recordingIndex: number;
  tSeconds: number;
  overlay?: string;
  overlayView?: ViewMode;
}

/**
 * One earlier exchange, replayed with a follow-up so the model can answer "why?" or "what about the
 * second one?". Text only: an earlier turn's frames are NOT re-sent (they would be re-billed on every
 * question), so `momentTimes` carries when they were and the server says as much in the prompt. The
 * server caps and clips all of this again — see functions/src/qaHistory.ts.
 */
export interface QaHistoryTurn {
  question: string;
  answer: string;
  momentTimes: number[];
}

/** A probe the report run just persisted into the thermometer subcollection (aiPlaced: true), returned
 *  so the open analyzer can show it immediately — the subcollection is fetched on load, not listened to. */
export interface PlacedAiProbe {
  id: string;
  name: string;
  x: number;
  y: number;
}

/**
 * Generate a physics-grounded lab-report DRAFT for an experiment via the generateLabReport callable.
 * The function reads the experiment's real thermal data server-side (the API key never reaches the
 * client) and returns Markdown the caller shows in the report tab. `model` selects any supported model
 * (the report is text-only, so every provider works). Both media types are supported: a video showcase's
 * single .vir decodes to the same summary shape a recording's per-frame files do.
 *
 * `instructions` are the owner's optional notes for this run — a focus/length request, or setup context
 * the thermal data cannot show. They are capped and framed server-side (never treated as measurements)
 * and persisted with the report, which is why the resolved value comes back in the response.
 *
 * Every run investigates before it writes: the model works the data over with its own tools (re-fitting
 * curves, reading profiles and histograms, pulling in frames the sampling skipped) and only then writes
 * the report. Several model calls instead of one, so a run takes minutes rather than seconds.
 *
 * Streams: `onText` receives the report as it is written, token by token — only the final write-up, as
 * the investigation rounds are tool calls, not report text. What it delivers is a LIVE
 * PREVIEW, not the result: the server still snaps figure markers to real instants and may rewrite the
 * draft once to fix unsupported figures, so the resolved `report` is authoritative and replaces it.
 * `signal` cancels — aborting the stream disconnects the callable, which the function sees as its own
 * cancellation signal and stops generating instead of billing the rest of the run.
 *
 * The timeout is raised past the callable default of 70s to sit just outside the function's own 180s
 * budget. This call routinely runs 20-60s and can exceed 70s; on the default the client threw
 * deadline-exceeded while the function ran on to completion and PERSISTED the report — the user saw
 * "generation failed", pressed Regenerate, and paid for a second report they already had.
 */
export async function generateLabReport(
  expId: string,
  model: QaModel,
  instructions?: string,
  onText?: (fullText: string) => void,
  signal?: AbortSignal,
  onStreamEnd?: () => void,
): Promise<{
  report: string;
  instructions: string | null;
  inputsHash: string;
  verified: ReportVerification | null;
  inputs: ReportInputsDescriptor | null;
  vision: boolean;
  sampling: ReportSampling | null;
  generatedAt: number;
  aiProbesPlaced: PlacedAiProbe[];
  customThermometersSet: boolean;
}> {
  const fn = httpsCallable<
    { expId: string; model: QaModel; instructions?: string },
    {
      report: string;
      model: QaModel;
      instructions: string | null;
      inputsHash: string;
      verified: ReportVerification | null;
      inputs: ReportInputsDescriptor | null;
      vision: boolean;
      sampling: ReportSampling | null;
      generatedAt: number;
      aiProbesPlaced?: PlacedAiProbe[];
      customThermometersSet?: boolean;
    },
    // One streamed chunk. `reset` means "discard everything received so far": the server restarted the
    // write-up (its deep pass failed part-way and fell back to a single pass), so appending would glue a
    // truncated report onto a complete one.
    { text: string; reset?: boolean }
  >(
    firebaseFunctions,
    'generateLabReport',
    // Just outside the function's own 300s budget: the tool loop runs several model calls, and a client
    // that gave up first would throw deadline-exceeded while the function ran on and PERSISTED the
    // report — the exact double-generation bug this margin exists to prevent.
    { timeout: 310_000 }, // functions/src/index.ts generateLabReport: timeoutSeconds 300
  );
  const payload = { expId, model, ...(instructions ? { instructions } : {}) };
  // Non-streaming call when nobody is watching the text and nothing can cancel it — keeps a caller that
  // only wants the finished report on the simpler path.
  const res =
    onText || signal || onStreamEnd
      ? await streamLabReport(fn, payload, onText, signal, onStreamEnd)
      : await fn(payload);
  return {
    report: res.data.report,
    instructions: res.data.instructions ?? null,
    inputsHash: res.data.inputsHash ?? '',
    verified: res.data.verified ?? null,
    inputs: res.data.inputs ?? null,
    vision: !!res.data.vision,
    sampling: res.data.sampling ?? null,
    generatedAt: Number(res.data.generatedAt) || Date.now(),
    aiProbesPlaced: res.data.aiProbesPlaced ?? [],
    customThermometersSet: !!res.data.customThermometersSet,
  };
}

/**
 * Delete an experiment's saved lab report (owner only), along with the probes that report placed —
 * see the clearLabReport callable. Returns the ids of the probes removed, so the open analyzer can drop
 * them from its store instead of showing markers whose documents are gone.
 *
 * A callable, not a client write: the aiReport* fields are barred from client updates by the security
 * rules, which is what stops a report's provenance from being forged or quietly edited.
 */
export async function clearLabReport(expId: string): Promise<{ clearedProbeIds: string[] }> {
  const fn = httpsCallable<{ expId: string }, { clearedProbeIds?: string[] }>(firebaseFunctions, 'clearLabReport');
  const res = await fn({ expId });
  return { clearedProbeIds: res.data.clearedProbeIds ?? [] };
}

/** Run generateLabReport over its streaming channel, forwarding each accumulated delta to `onText`.
 *  Split out so the plain call above stays a one-liner. The final `data` promise is what the caller
 *  returns: the streamed text is a preview of the draft, the resolved report is the persisted one. */
async function streamLabReport<Req, Res>(
  fn: {
    (data: Req): Promise<{ data: Res }>;
    stream: (
      data: Req,
      options?: { signal?: AbortSignal },
    ) => Promise<{ stream: AsyncIterable<{ text: string; reset?: boolean }>; data: Promise<Res> }>;
  },
  payload: Req,
  onText?: (fullText: string) => void,
  signal?: AbortSignal,
  onStreamEnd?: () => void,
): Promise<{ data: Res }> {
  const { stream, data } = await fn.stream(payload, signal ? { signal } : undefined);
  // The SDK rejects BOTH the iterator and this promise on cancel or a mid-stream error. The loop below
  // throws first, so without a handler here the rejection is unowned and every Cancel logs an uncaught
  // "FirebaseError: cancelled" — attaching a no-op catch marks it handled; the `await data` further
  // down still surfaces the real error to the caller.
  void data.catch(() => {});
  let acc = '';
  for await (const chunk of stream) {
    // The server restarted the write-up (see the chunk type): throw away the partial report rather than
    // appending a whole new one to it.
    if (chunk?.reset) acc = '';
    if (chunk?.text) acc += chunk.text;
    if (chunk?.reset || chunk?.text) onText?.(acc);
  }
  // The text is complete, but the call is not: the server still cross-checks the figures and may spend
  // another (deliberately un-streamed) model call rewriting them. Told apart so the UI can stop implying
  // text is still arriving.
  onStreamEnd?.();
  return { data: await data };
}

/**
 * Answer a free-form question about an experiment via the answerExperimentQuestion streaming callable.
 * The function grounds the model on the real thermal data server-side (whole-clip summary + existing
 * report + each attached moment's frame/readings) and streams a Markdown answer back token by token:
 * `onText` is called with the full accumulated text on every delta so the UI can render as it grows.
 * Resolves with the final answer. `moments` are optional (time-agnostic by default), capped at 3
 * server-side; `recordingIndex` is a recording-frame number for a recording, or the .vir frame index
 * for a video, and each may carry the player capture the user saw (see QaMomentPayload). `history` is the
 * thread so far, so a question can build on the last one instead of starting cold. `model` selects one of
 * the offered models (see MODEL_KEYS — OpenAI/Gemini/Grok/DeepSeek); the server defaults to gpt52 if
 * omitted. Any staff, on recording OR video experiments. The owner's turns are persisted (Firestore);
 * a non-owner's thread stays in their browser.
 *
 * `signal` is the Stop button: aborting it closes the stream, and the disconnect is what the function
 * reads as a cancellation — so the model stops mid-answer instead of billing the rest into a void.
 */
export async function answerExperimentQuestionStream(
  expId: string,
  question: string,
  moments: QaMomentPayload[],
  history: QaHistoryTurn[],
  model: QaModel,
  onText: (fullText: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const fn = httpsCallable<
    { expId: string; question: string; moments: QaMomentPayload[]; history: QaHistoryTurn[]; model: QaModel },
    { answer: string },
    { text: string }
  >(firebaseFunctions, 'answerExperimentQuestion');
  const { stream, data } = await fn.stream(
    { expId, question, moments, history, model },
    signal ? { signal } : undefined,
  );
  // The SDK rejects BOTH the iterator and this promise on cancel or a mid-stream error. The loop below
  // throws first, so without a handler here every Stop would log an uncaught "FirebaseError: cancelled";
  // the `await data` below still surfaces the real error to the caller.
  void data.catch(() => {});
  let acc = '';
  for await (const chunk of stream) {
    if (chunk?.text) {
      acc += chunk.text;
      onText(acc);
    }
  }
  const final = await data;
  return final?.answer ?? acc;
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
 * model answers (see AgentModel/MODEL_KEYS); the server defaults to GPT-5.6 Luna if omitted. The
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

/**
 * Read an experiment's measured thermal summary — the server-side half of the read_experiment_data tool
 * (heavy Firestore + Storage read via buildThermalSummary). Staff-gated, recording experiments only.
 * Timeout raised past the 70s callable default for the same reason as generateLabReport — the function
 * budgets 120s for its 25-frame Storage fan-out.
 */
export async function getExperimentData(expId: string): Promise<{ summary: unknown; title: string | null }> {
  const fn = httpsCallable<{ expId: string }, { summary: unknown; title: string | null }>(
    firebaseFunctions,
    'getExperimentData',
    { timeout: 130_000 }, // functions/src/index.ts getExperimentData: timeoutSeconds 120
  );
  const res = await fn({ expId });
  return res.data;
}

/** A persisted Q&A turn from experiments/{expId}/qaTurns (private to the asker). Moments carry only
 *  recordingIndex + tSeconds — the thumbnail isn't stored (rebuilt as a labelled chip on load). */
export interface StoredQaTurn {
  question: string;
  answer: string;
  model: QaModel;
  moments: { recordingIndex: number; tSeconds: number }[];
  createdAt: number;
}

/**
 * Load the caller's own saved Q&A turns for an experiment, oldest first. "Rules are not filters": the
 * qaTurns read rule is userId-scoped, so the query MUST filter userId == the viewer. Sorted
 * client-side to avoid a composite where+orderBy index.
 */
export async function loadQaTurns(expId: string, userId: string): Promise<StoredQaTurn[]> {
  const coll = collection(firebaseDatabase, `experiments/${expId}/qaTurns`);
  const snap = await getDocs(query(coll, where('userId', '==', userId)));
  const turns: StoredQaTurn[] = [];
  snap.forEach((d) => {
    const data = d.data();
    const moments = Array.isArray(data.moments) ? data.moments : [];
    turns.push({
      question: data.question ?? '',
      answer: data.answer ?? '',
      model: isModelKey(data.model) ? data.model : DEFAULT_MODEL,
      moments: moments.map((m: { recordingIndex?: number; tSeconds?: number }) => ({
        recordingIndex: Number(m.recordingIndex),
        tSeconds: Number(m.tSeconds),
      })),
      createdAt: (data.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0,
    });
  });
  return turns.sort((a, b) => a.createdAt - b.createdAt);
}

/** Delete all of the caller's saved Q&A turns for an experiment (the rules allow deleting own turns). */
export async function clearQaTurns(expId: string, userId: string): Promise<void> {
  const coll = collection(firebaseDatabase, `experiments/${expId}/qaTurns`);
  const snap = await getDocs(query(coll, where('userId', '==', userId)));
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
}
