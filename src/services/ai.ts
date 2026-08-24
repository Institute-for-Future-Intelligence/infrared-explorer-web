import { httpsCallable } from 'firebase/functions';
import { collection, deleteDoc, getDocs, query, where } from 'firebase/firestore';
import { firebaseFunctions, firebaseDatabase } from './firebase';
import { AgentModel, QaModel, DEFAULT_MODEL, isModelKey } from '../types';

/**
 * Generate a physics-grounded lab-report DRAFT for an experiment via the generateLabReport callable.
 * The function reads the experiment's real thermal data server-side (the API key never reaches the
 * client) and returns Markdown the caller shows in the report tab. `model` selects any supported model
 * (the report is text-only, so every provider works). Currently supports recording-based experiments;
 * throws (failed-precondition) for video showcases.
 */
export async function generateLabReport(expId: string, model: QaModel): Promise<string> {
  const fn = httpsCallable<{ expId: string; model: QaModel }, { report: string; model: QaModel }>(
    firebaseFunctions,
    'generateLabReport',
  );
  const res = await fn({ expId, model });
  return res.data.report;
}

/**
 * Answer a free-form question about an experiment via the answerExperimentQuestion streaming callable.
 * The function grounds the model on the real thermal data server-side (whole-clip summary + existing
 * report + each attached moment's frame/readings) and streams a Markdown answer back token by token:
 * `onText` is called with the full accumulated text on every delta so the UI can render as it grows.
 * Resolves with the final answer. `moments` are optional (time-agnostic by default), capped at 3
 * server-side; `recordingIndex` is a recording-frame number for a recording, or the .vir frame index
 * for a video. `model` selects one of the offered models (see MODEL_KEYS — OpenAI/Gemini/Grok/DeepSeek);
 * the server defaults to gpt52 if omitted. Any staff, on recording OR video experiments. The owner's
 * turns are persisted (Firestore); a non-owner's thread stays in their browser.
 */
export async function answerExperimentQuestionStream(
  expId: string,
  question: string,
  moments: { recordingIndex: number; tSeconds: number }[],
  model: QaModel,
  onText: (fullText: string) => void,
): Promise<string> {
  const fn = httpsCallable<
    { expId: string; question: string; moments: { recordingIndex: number; tSeconds: number }[]; model: QaModel },
    { answer: string },
    { text: string }
  >(firebaseFunctions, 'answerExperimentQuestion');
  const { stream, data } = await fn.stream({ expId, question, moments, model });
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
 */
export async function getExperimentData(expId: string): Promise<{ summary: unknown; title: string | null }> {
  const fn = httpsCallable<{ expId: string }, { summary: unknown; title: string | null }>(
    firebaseFunctions,
    'getExperimentData',
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
