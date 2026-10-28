/**
 * The twin agent's conversation on the client (docs/digital-twin-plan.md §43.5): the same loop as the
 * recording AI's (ai/recordingAiRunner.ts drive) — one callable request per leg, the browser tools run
 * between legs — over the twinAgentTurn callable and the twin's tools (twinAgentTools.ts). The
 * conversation opens with what the website knows about the recording (its length, the player's
 * thermometers, that the camera stood still) and ends when the finish tool has written the twin, which
 * arrives as a `twin` chunk and goes straight to the store, where the viewer picks it up.
 */
import { create } from 'zustand';
import type { Experiment, QaModel, TwinBuildingRecord } from '../../../../types';
import useCommonStore from '../../../../stores/common';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from '../../../../utils/constants';
import { lastFrameIndexOf } from '../../../../utils/frameTime';
import {
  type RecImage,
  type RecTurn,
  RecTurnError,
  type RecTurnInput,
  type RecTurnRequest,
} from '../../../../services/recordingAi';
import { type TwinAgentChunk, streamTwinAgentTurn } from '../../../../services/twinAgent';
import { recordingTake } from '../../ai/recordingAiRunner';
import { storeTwinRecord } from '../twinRun';
import { TWIN_AGENT_BROWSER_TOOLS, closeTwinAgentTools, resetTwinAgentTools, runTwinAgentTool } from './twinAgentTools';

export interface TwinAgentView {
  running: boolean;
  started: boolean;
  model: QaModel;
  turns: RecTurn[];
  images: RecImage[];
  liveText: string;
  status: string | null;
  error: string | null;
  finished: boolean;
}

const EMPTY: TwinAgentView = {
  running: false,
  started: false,
  model: 'gpt6luna',
  turns: [],
  images: [],
  liveText: '',
  status: null,
  error: null,
  finished: false,
};

interface State {
  views: Record<string, TwinAgentView>;
}
const useStore = create<State>(() => ({ views: {} }));
const viewOf = (expId: string): TwinAgentView => useStore.getState().views[expId] ?? EMPTY;
const patch = (expId: string, p: Partial<TwinAgentView>) =>
  useStore.setState((s) => ({ views: { ...s.views, [expId]: { ...(s.views[expId] ?? EMPTY), ...p } } }));
export const useTwinAgentView = (expId: string): TwinAgentView => useStore((s) => s.views[expId] ?? EMPTY);
export const setTwinAgentModel = (expId: string, model: QaModel): void => patch(expId, { model });

const requests = new Map<string, RecTurnRequest>();
const stopped = new Set<string>();

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
    case 'turn':
      patch(expId, {
        turns: upsertTurn(v.turns, chunk.turn),
        ...(chunk.turn.role === 'assistant' ? { liveText: '' } : {}),
      });
      return;
    case 'image':
      patch(expId, { images: upsertImage(v.images, chunk.image) });
      return;
    case 'status':
      patch(expId, {
        status: chunk.s === 'tool' && chunk.tool ? `tool:${chunk.tool}` : chunk.s,
        ...(chunk.s === 'retrying' ? { liveText: '' } : {}),
      });
      return;
    case 'twin':
      storeTwinRecord(expId, chunk.record as TwinBuildingRecord);
      patch(expId, { finished: true });
      return;
    default:
      return;
  }
}

/** What the website knows, as the conversation's first message. */
function opening(exp: Experiment): string {
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
    'The owner says the camera stood still above the bench for the whole recording.',
    probes.length ? `The player's thermometers: ${probes.join('; ')}.` : 'The player has no thermometers on it.',
    exp.description?.trim() ? `The owner's description: ${exp.description.trim().slice(0, 500)}` : null,
    'Measure first, then build, then finish.',
  ];
  return lines.filter(Boolean).join('\n');
}

export async function startTwinAgent(exp: Experiment): Promise<void> {
  const expId = exp.id;
  const recordingId = exp.recordingId;
  if (!recordingId || viewOf(expId).running) return;
  resetTwinAgentTools(expId);
  patch(expId, {
    running: true,
    started: true,
    turns: [],
    images: [],
    liveText: '',
    status: 'sending',
    error: null,
    finished: false,
  });
  stopped.delete(expId);
  const take = recordingTake(exp);
  let next: RecTurnInput | null = { kind: 'message', text: opening(exp), moments: [], overview: null };
  let fresh = true;
  try {
    while (next) {
      const req = streamTwinAgentTurn({
        expId,
        input: next,
        model: viewOf(expId).model,
        browserTools: TWIN_AGENT_BROWSER_TOOLS,
        fresh,
        onChunk: (c) => applyChunk(expId, c),
      });
      fresh = false;
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
        if (stopped.delete(expId)) next = null;
        else {
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
    if (!e.cancelled) patch(expId, { error: e.message || 'Something went wrong.' });
  } finally {
    stopped.delete(expId);
    closeTwinAgentTools(expId);
    patch(expId, { running: false, liveText: '', status: null });
  }
}

export function stopTwinAgent(expId: string): void {
  stopped.add(expId);
  requests.get(expId)?.abort();
}
