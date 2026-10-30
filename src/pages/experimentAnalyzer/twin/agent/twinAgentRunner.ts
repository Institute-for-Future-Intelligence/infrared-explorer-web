/**
 * A recording's twin build on the client (docs/digital-twin-plan.md §43.5, the one build since §44):
 * the camera-motion check first (cameraMotionGate.ts) — a camera that moved gets no twin — then the
 * same loop as the recording AI's (ai/recordingAiRunner.ts drive): one callable request per leg, the
 * browser tools run between legs, over the twinAgentTurn callable and the twin's tools
 * (twinAgentTools.ts). The conversation opens with what the website knows about the recording (its
 * length, how still the camera was, the player's thermometers, the owner's request) and a round ends
 * when the finish tool has written the twin, which arrives as a `twin` chunk and goes straight to the
 * store, where the viewer picks it up. The owner may then write again (sendTwinAgentMessage, §44.8):
 * the same conversation goes on, and the next finish replaces the twin.
 *
 * A build outlives the panel: switching tabs must not cancel a run of minutes, so the view lives in a
 * store keyed by experiment and the panel just subscribes while it is mounted.
 */
import { create } from 'zustand';
import type { Experiment, QaModel, TwinBuildingRecord } from '../../../../types';
import useCommonStore from '../../../../stores/common';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from '../../../../utils/constants';
import { formatFilmTime, lastFrameIndexOf } from '../../../../utils/frameTime';
import {
  type RecImage,
  type RecTurn,
  RecTurnError,
  type RecTurnInput,
  type RecTurnRequest,
} from '../../../../services/recordingAi';
import { type TwinAgentChunk, streamTwinAgentTurn } from '../../../../services/twinAgent';
import type { TwinSelectionItem } from '../../../../types';
import { recordingTake } from '../../ai/recordingAiRunner';
import { type CameraMotion, cameraMovedMessage, checkCameraMotion } from '../cameraMotionGate';
import { clearTwinBuildDraft, twinBuildDraftStamp } from '../twinModels';
import { storeTwinRecord } from '../twinRun';
import { TWIN_AGENT_BROWSER_TOOLS, closeTwinAgentTools, resetTwinAgentTools, runTwinAgentTool } from './twinAgentTools';

export interface TwinAgentView {
  running: boolean;
  /** A build has been started in this session (its conversation is on screen, or its outcome). */
  started: boolean;
  model: QaModel;
  /** The request the running (or last) build was given. */
  instructions: string;
  turns: RecTurn[];
  images: RecImage[];
  /** The owner's message on its way, until the server's copy of it arrives as a turn. */
  outgoing: { text: string } | null;
  liveText: string;
  status: string | null;
  /** The camera-motion check's line, while it runs. */
  progress: string | null;
  /** What the check found, once it has. */
  motion: CameraMotion | null;
  error: string | null;
  /** The owner stopped it, and nothing was written after. */
  stopped: boolean;
  finished: boolean;
  /** The seqs of the model's turns in rounds that saved a twin: the thread does not show them — what the
   *  model did and assumed is About's text (user, 2026-10-30: one account, not two). */
  hiddenSeqs: number[];
}

const EMPTY: TwinAgentView = {
  running: false,
  started: false,
  model: 'gpt6luna',
  instructions: '',
  turns: [],
  images: [],
  outgoing: null,
  liveText: '',
  status: null,
  progress: null,
  motion: null,
  error: null,
  stopped: false,
  finished: false,
  hiddenSeqs: [],
};

interface State {
  views: Record<string, TwinAgentView>;
}
const useStore = create<State>(() => ({ views: {} }));
const viewOf = (expId: string): TwinAgentView => useStore.getState().views[expId] ?? EMPTY;
const patch = (expId: string, p: Partial<TwinAgentView>) =>
  useStore.setState((s) => ({ views: { ...s.views, [expId]: { ...(s.views[expId] ?? EMPTY), ...p } } }));
export const useTwinAgentView = (expId: string): TwinAgentView => useStore((s) => s.views[expId] ?? EMPTY);
/** The outcome notices (stopped, error, finished) go when the owner closes them. */
export const dismissTwinAgentOutcome = (expId: string): void =>
  patch(expId, { error: null, stopped: false, finished: false });

const requests = new Map<string, RecTurnRequest>();
/** The opening message a build was started with, by experiment: the website's words about the recording,
 *  which the thread does not show — the owner's own request stands in for them (user, 2026-10-29). */
const openings = new Map<string, string>();
const gates = new Map<string, AbortController>();
const stopped = new Set<string>();
/** The build form's draft as it stood when the build started: the twin written carries the request, so
 *  the draft goes then — unless the owner has changed it meanwhile (twinModels.clearTwinBuildDraft). */
const draftStamps = new Map<string, string | null>();

function upsertTurn(turns: RecTurn[], turn: RecTurn): RecTurn[] {
  const i = turns.findIndex((t) => t.seq === turn.seq);
  if (i < 0) return [...turns, turn];
  const next = turns.slice();
  next[i] = turn;
  return next;
}
function upsertImage(images: RecImage[], image: RecImage): RecImage[] {
  const i = images.findIndex((im) => im.id === image.id);
  if (i < 0) return [...images, image];
  const next = images.slice();
  next[i] = image;
  return next;
}

function applyChunk(expId: string, chunk: TwinAgentChunk): void {
  const v = viewOf(expId);
  switch (chunk.t) {
    case 'text':
      patch(expId, { liveText: v.liveText + chunk.d, status: null });
      return;
    case 'turn': {
      // The server's copy of the opening message: shown as the owner's request alone, which is the only
      // part of it they wrote (the rest is what the website told the model about the recording).
      const turn =
        chunk.turn.role === 'user' && chunk.turn.text === openings.get(expId)
          ? { ...chunk.turn, text: v.instructions }
          : chunk.turn;
      patch(expId, {
        turns: upsertTurn(v.turns, turn),
        // The model's closing words after the twin is saved go with the rest of the round's turns.
        ...(v.finished && turn.role !== 'user' && !v.hiddenSeqs.includes(turn.seq)
          ? { hiddenSeqs: [...v.hiddenSeqs, turn.seq] }
          : {}),
        ...(turn.role === 'assistant' ? { liveText: '' } : {}),
        ...(turn.role === 'user' ? { outgoing: null } : {}),
      });
      return;
    }
    case 'image':
      patch(expId, { images: upsertImage(v.images, chunk.image) });
      return;
    case 'status':
      patch(expId, {
        status: chunk.s === 'tool' && chunk.tool ? `tool:${chunk.tool}` : chunk.s,
        ...(chunk.s === 'retrying' ? { liveText: '' } : {}),
      });
      return;
    case 'twin': {
      storeTwinRecord(expId, chunk.record as TwinBuildingRecord);
      clearTwinBuildDraft(expId, draftStamps.get(expId));
      // The round's model turns so far (from the owner's message on) leave the thread: the twin and About
      // are what they did.
      let from = v.turns.length;
      while (from > 0 && v.turns[from - 1].role !== 'user') from -= 1;
      const seqs = v.turns.slice(from).map((t) => t.seq);
      patch(expId, { finished: true, hiddenSeqs: [...v.hiddenSeqs, ...seqs.filter((s) => !v.hiddenSeqs.includes(s))] });
      return;
    }
    default:
      return;
  }
}

/** What the website knows, as the conversation's first message: the recording, how still its camera
 *  was (measured, not assumed), the player's thermometers, and what the owner asked for. */
function opening(exp: Experiment, motion: CameraMotion, instructions: string): string {
  const frames = lastFrameIndexOf(exp) + 1;
  const store = useCommonStore.getState();
  const probes = (exp.thermometersId ?? [])
    .map((id, i) => {
      const t = store.thermometerMap.get(id);
      if (!t) return null;
      const name = t.name?.trim() || `T${i + 1}`;
      const area =
        t.measuringAreaType && t.measuringAreaType !== 'point'
          ? ` (${t.measuringAreaType}, ${Math.round((t.measuringAreaWidth ?? 0) * IR_ARRAY_WIDTH)} × ${Math.round((t.measuringAreaHeight ?? 0) * IR_ARRAY_HEIGHT)} px)`
          : '';
      return `${name} at grid pixel (${(t.x * IR_ARRAY_WIDTH).toFixed(1)}, ${(t.y * IR_ARRAY_HEIGHT).toFixed(1)})${area}`;
    })
    .filter(Boolean);
  const lines = [
    `Build the digital twin of "${exp.displayName || 'this recording'}" (take ${exp.id}).`,
    `The recording has ${frames} frames at 5 frames per second (${Math.round(frames / 5)} s), 120 × 160 thermal pixels each, with a visible-light photo kept every 5th frame.`,
    `The camera stood still: the picture drifts at most ${motion.maxShiftPx} px from frame ${motion.referenceIndex} (at ${formatFilmTime(motion.referenceIndex - 1)}), the stillest.`,
    probes.length ? `The player's thermometers: ${probes.join('; ')}.` : 'The player has no thermometers on it.',
    exp.description?.trim()
      ? `The owner's description of the recording: ${exp.description.trim().slice(0, 500)}`
      : null,
    instructions ? `The owner asks: ${instructions}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

/** The conversation's loop: one request per leg, the browser tools between legs, until the model is
 *  done, the owner stops it, or it fails. `first` is this round's message, `selection` what the owner
 *  had selected in the view when they wrote it (§44.10, with the first request only); `fresh` starts
 *  the conversation over and carries the form's inputs. */
async function drive(
  exp: Experiment,
  first: RecTurnInput,
  fresh: { instructions: string; motion: CameraMotion } | null,
  selection: TwinSelectionItem[] = [],
): Promise<void> {
  const expId = exp.id;
  const recordingId = exp.recordingId!;
  const take = recordingTake(exp);
  let next: RecTurnInput | null = first;
  let opening = !!fresh;
  try {
    while (next) {
      const req = streamTwinAgentTurn({
        expId,
        input: next,
        model: viewOf(expId).model,
        browserTools: TWIN_AGENT_BROWSER_TOOLS,
        ...(opening && fresh ? { fresh: true, instructions: fresh.instructions, motion: fresh.motion } : {}),
        ...(next === first && selection.length ? { selection } : {}),
        onChunk: (c) => applyChunk(expId, c),
      });
      opening = false;
      requests.set(expId, req);
      const outcome = await req.done;
      requests.delete(expId);
      if (outcome.model) patch(expId, { model: outcome.model as QaModel });
      if (outcome.status === 'awaitingBrowser' && outcome.pending.length > 0) {
        const results = [];
        for (const call of outcome.pending) {
          patch(expId, { status: `phone:${call.name}`, liveText: '' });
          results.push(await runTwinAgentTool(call, take, recordingId, expId));
          if (stopped.has(expId)) break;
        }
        if (stopped.delete(expId)) {
          next = null;
          patch(expId, { stopped: !viewOf(expId).finished });
        } else {
          next = { kind: 'toolResults', results };
          patch(expId, { status: 'thinking' });
        }
      } else if (outcome.status === 'busy') {
        patch(expId, { error: 'Another build of this twin is still running. Try again in a moment.' });
        next = null;
      } else if (outcome.status === 'limit') {
        // ten model calls in one request: carry on in the next
        next = { kind: 'resume' };
      } else {
        next = null;
      }
    }
  } catch (err) {
    requests.delete(expId);
    const e = err as RecTurnError;
    if (e.cancelled) patch(expId, { stopped: !viewOf(expId).finished });
    else patch(expId, { error: e.message || 'Something went wrong.' });
  } finally {
    stopped.delete(expId);
    closeTwinAgentTools(expId);
    patch(expId, { running: false, liveText: '', status: null, outgoing: null });
  }
}

export interface TwinAgentStart {
  model: QaModel;
  /** Trimmed; '' when the owner asked for nothing in particular. */
  instructions: string;
  /** What the owner selected in the old twin's view when they wrote (§44.10); nothing from the form. */
  selection?: TwinSelectionItem[];
}

/** What is already known of the camera's motion, so the check need not run again (user, 2026-10-29:
 *  once a twin exists, the camera is not checked at every build): this session's finding, else the one
 *  the twin on the experiment was built with (the record's `agent.motion`, which the server kept from the
 *  check that admitted it — a camera found fixed). A recording does not change, so neither does the finding. */
function knownCameraMotion(exp: Experiment): CameraMotion | null {
  const seen = viewOf(exp.id).motion;
  if (seen) return seen;
  const scene = useCommonStore.getState().experimentMap.get(exp.id)?.twinScene ?? exp.twinScene;
  const agent = (scene as { agent?: Record<string, unknown> } | undefined)?.agent;
  const m = agent?.motion as Record<string, unknown> | undefined;
  if (!m || typeof m.maxShiftPx !== 'number' || typeof m.referenceIndex !== 'number') return null;
  return {
    kind: 'fixed',
    maxShiftPx: m.maxShiftPx,
    referenceIndex: m.referenceIndex,
    ...(typeof m.photosCompared === 'number' ? { photosCompared: m.photosCompared } : {}),
    ...(typeof m.photosMoved === 'number' ? { photosMoved: m.photosMoved } : {}),
  };
}

/** A new build: the conversation starts over. */
export async function startTwinAgent(exp: Experiment, start: TwinAgentStart): Promise<void> {
  const expId = exp.id;
  if (!exp.recordingId || viewOf(expId).running) return;
  resetTwinAgentTools(expId);
  draftStamps.set(expId, twinBuildDraftStamp(expId));
  patch(expId, {
    running: true,
    started: true,
    model: start.model,
    instructions: start.instructions,
    turns: [],
    images: [],
    outgoing: null,
    liveText: '',
    status: null,
    progress: null,
    motion: null,
    error: null,
    stopped: false,
    finished: false,
    hiddenSeqs: [],
  });
  stopped.delete(expId);

  // The camera-motion check (§44.3): a camera that moved gets no twin, and no request is made. It runs
  // once per recording: a finding already in hand is reused.
  let motion = knownCameraMotion(exp);
  if (!motion) {
    const gate = new AbortController();
    gates.set(expId, gate);
    try {
      motion = await checkCameraMotion(exp, gate.signal, (line) => patch(expId, { progress: line }));
    } catch (err) {
      gates.delete(expId);
      const aborted = gate.signal.aborted;
      patch(expId, {
        running: false,
        progress: null,
        ...(aborted ? { stopped: true } : { error: (err as Error)?.message || 'The recording could not be read.' }),
      });
      stopped.delete(expId);
      return;
    }
    gates.delete(expId);
  }
  patch(expId, { progress: null, motion });
  if (motion.kind === 'moved') {
    patch(expId, { running: false, error: cameraMovedMessage(motion) });
    return;
  }

  patch(expId, { status: 'sending' });
  const text = opening(exp, motion, start.instructions);
  openings.set(expId, text);
  await drive(
    exp,
    { kind: 'message', text, moments: [], overview: null },
    { instructions: start.instructions, motion },
    start.selection ?? [],
  );
}

/**
 * The owner writes to the agent about the twin on screen (§44.8). With the conversation in this session
 * it goes on from where it was — the model gets a fresh build budget for the round and finishes again,
 * replacing the twin. Without one (a reload, a twin built elsewhere) the message is the request of a
 * new build. `selection` is what the owner selected in the view (§44.10): it goes with the message,
 * which is about it.
 */
export async function sendTwinAgentMessage(
  exp: Experiment,
  text: string,
  selection: TwinSelectionItem[] = [],
): Promise<void> {
  const expId = exp.id;
  const v = viewOf(expId);
  const message = text.trim();
  if (!message || v.running || !exp.recordingId) return;
  if (!v.turns.length || !v.motion) return startTwinAgent(exp, { model: v.model, instructions: message, selection });
  resetTwinAgentTools(expId); // a fresh build budget for this round
  stopped.delete(expId);
  patch(expId, {
    running: true,
    outgoing: { text: message },
    liveText: '',
    status: 'sending',
    error: null,
    stopped: false,
    finished: false,
  });
  await drive(exp, { kind: 'message', text: message, moments: [], overview: null }, null, selection);
}

export function stopTwinAgent(expId: string): void {
  stopped.add(expId);
  gates.get(expId)?.abort();
  requests.get(expId)?.abort();
}

/** The twin is deleted: its conversation goes with it (user, 2026-10-30) — nothing of the build stays on
 *  screen, and the next build starts the conversation over (it does anyway: startTwinAgent sends `fresh`). */
export function forgetTwinAgent(expId: string): void {
  if (viewOf(expId).running) return;
  openings.delete(expId);
  useStore.setState((s) => {
    const { [expId]: _gone, ...views } = s.views;
    return { views };
  });
}
