import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Popconfirm, Select, message } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';
import styled from 'styled-components';
import {
  Experiment,
  ExperimentType,
  MODEL_KEYS,
  MODEL_LABELS,
  QaModel,
  RetiredModelKey,
  isTextOnlyModel,
  modelLabel,
} from '../../../types';
import useCommonStore from '../../../stores/common';
import { useMappingIndex } from '../hooks';
import {
  answerExperimentQuestionStream,
  clearQaTurns,
  loadQaTurns,
  type QaHistoryTurn,
  type QaMomentPayload,
} from '../../../services/ai';
import { markdownToHtml } from '../../../utils/markdown';
import { displayTemp, formatDuration, temperatureSymbol } from '../../../utils/helpers';
import { isStaff } from '../../../utils/staff';
import { useRebuiltThumbnails } from './useRebuiltThumbnails';
import { useFrameReadings } from './useFrameReadings';
import FrameOverlay from './frameOverlay';
import MomentLightbox, { type PreviewItem } from './momentLightbox';

// Question keywords that suggest the user is asking about a specific moment — used to nudge them to
// attach the current frame (English + Chinese; kept targeted to avoid firing on generic wording).
const MOMENT_HINT_RE =
  /right now|this (moment|frame|instant|point)|at this (moment|point|time|frame)|the (spike|peak|jump|dip|drop)|happening now|现在|此刻|此时|这一?[帧刻]|这个?(时刻|尖峰|峰值|变化|时候)|这里|刚才/i;

const CIRCLED = ['①', '②', '③'];

// How many earlier exchanges ride along with a question so it reads as a conversation rather than a
// series of unrelated one-shots. Kept short on purpose: the whole thread would be re-sent (and re-billed)
// on every question, and the authoritative data belongs to the CURRENT turn. The server caps this again.
const QA_HISTORY_TURNS = 6;

// A moment as captured into a sent turn (where to seek back to; thumbnail present for this session's
// turns, absent for turns loaded from history — those render as a labelled pill instead).
interface TurnMoment {
  recordingIndex: number;
  tSeconds: number;
  thumbnail?: string;
}
interface QaTurn {
  // Identifies a turn while its answer streams in, so the run can patch it without holding an index into
  // an array that may have grown (or been cleared) meanwhile. Session-lifetime only — never persisted.
  id: number;
  question: string;
  moments: TurnMoment[];
  answer: string; // grows as the answer streams in
  // The model that answered — a retired key on a turn answered before the DeepSeek merge (see modelLabel).
  model: QaModel | RetiredModelKey;
  streaming: boolean;
  error?: boolean;
  // The user pressed Stop: whatever text had arrived is kept, but the turn is marked so a half-written
  // answer isn't read as a finished one.
  stopped?: boolean;
}

// A persisted turn (owner → Firestore; non-owner → localStorage below). Same shape either way; moments
// carry only recordingIndex + tSeconds (no thumbnail), so both render as labelled pills on reload.
type StoredTurn = {
  question: string;
  answer: string;
  model: QaModel | RetiredModelKey;
  moments: { recordingIndex: number; tSeconds: number }[];
};

// Non-owner threads never leave the browser: kept in localStorage, keyed by experiment + user.
const localThreadKey = (expId: string, userId: string) => `qa-thread:${expId}:${userId}`;
const loadLocalTurns = (expId: string, userId: string): StoredTurn[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(localThreadKey(expId, userId)) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
const saveLocalTurns = (expId: string, userId: string, turns: StoredTurn[]) => {
  try {
    localStorage.setItem(localThreadKey(expId, userId), JSON.stringify(turns));
  } catch (e) {
    console.error('failed to save local qa thread', e);
  }
};
const clearLocalTurns = (expId: string, userId: string) => {
  try {
    localStorage.removeItem(localThreadKey(expId, userId));
  } catch (e) {
    console.error('failed to clear local qa thread', e);
  }
};

/**
 * One experiment's Q&A thread for this browser session, held at MODULE level — mirroring the report tab's
 * `inFlight` map, and for the same reason: workspacePanel renders the tabs conditionally, so switching to
 * Charts (or Info, or the report) UNMOUNTS this panel. With the thread in component state, a tab switch
 * mid-question threw the streaming answer away: the run itself kept going and the server still saved the
 * owner's turn, but the panel came back empty (and a non-owner's answer surfaced only after a reload).
 * Keeping the thread here means the answer keeps arriving while nothing is mounted, and a remount simply
 * re-attaches to it.
 *
 * It also spares the history re-read — the saved thread is fetched once per experiment instead of once per
 * tab switch — and carries the draft question, which a tab switch used to wipe just as thoroughly.
 */
interface QaSession {
  /** The saved history plus everything asked since, oldest first. */
  turns: QaTurn[];
  /** What is typed in the question box but not sent yet. */
  question: string;
  /** Whether the saved history has been fetched for this experiment. Claimed BEFORE the await, so two
   *  mounts in quick succession can't both fetch it. */
  loaded: boolean;
  /** The run in flight, if any — the Stop button aborts this controller. Lives on the session, not in
   *  the panel, so Stop still works on a run started before the last tab switch. */
  running?: { turnId: number; controller: AbortController };
  /** The mounted panel's subscriber, re-attached on every mount (one panel is mounted at a time). */
  onTurns?: (turns: QaTurn[]) => void;
}

const sessions = new Map<string, QaSession>();

/** This experiment's session, created on first use. Sessions for OTHER experiments are dropped as soon as
 *  they are idle: a thread holds its moments' captured frames as data URLs, which is real memory, and the
 *  analyzer only ever shows one experiment. A thread still streaming is kept — its answer is still on its
 *  way, and coming back to that experiment should show it arrive. */
const sessionFor = (expId: string): QaSession => {
  const existing = sessions.get(expId);
  if (existing) return existing;
  for (const [id, s] of sessions) {
    if (id !== expId && !s.turns.some((t) => t.streaming)) sessions.delete(id);
  }
  const created: QaSession = { turns: [], question: '', loaded: false };
  sessions.set(expId, created);
  return created;
};

/** Mutate a session and push its thread to the mounted panel, if one is mounted. Deliberately does NOT
 *  create the session: a run whose thread has been dropped (the user moved on) finishes quietly. */
const updateSession = (expId: string, mutate: (session: QaSession) => void) => {
  const session = sessions.get(expId);
  if (!session) return;
  mutate(session);
  session.onTurns?.(session.turns);
};

const patchTurn = (expId: string, id: number, patch: Partial<QaTurn>) =>
  updateSession(expId, (s) => {
    s.turns = s.turns.map((t) => (t.id === id ? { ...t, ...patch } : t));
  });

let nextTurnId = 1;

/**
 * Ask one question and stream the answer into the session. A module-level function on purpose: this is
 * the part that has to outlive the panel, so it touches only the session (and, for a non-owner, their
 * localStorage copy of the thread — the owner's is persisted server-side by the callable itself).
 * Resolves, never rejects: nobody awaits it.
 */
const runQuestion = async (
  expId: string,
  turnId: number,
  question: string,
  moments: QaMomentPayload[],
  history: QaHistoryTurn[],
  model: QaModel,
  onAnswer: ((answer: string) => void) | null,
) => {
  const controller = new AbortController();
  updateSession(expId, (s) => {
    s.running = { turnId, controller };
  });
  try {
    const answer = await answerExperimentQuestionStream(
      expId,
      question,
      moments,
      history,
      model,
      (full) => patchTurn(expId, turnId, { answer: full }),
      controller.signal,
    );
    onAnswer?.(answer);
  } catch (err) {
    if (controller.signal.aborted) {
      // The user pressed Stop. Not a failure — they know — so no toast: keep whatever text arrived and
      // mark the turn, which is also what stops the answer from reading as complete.
      patchTurn(expId, turnId, { stopped: true });
    } else {
      const code = (err as { code?: string })?.code;
      const msg =
        code === 'functions/resource-exhausted'
          ? 'Usage limit reached. Please try again later.'
          : code === 'functions/failed-precondition'
            ? (err as { message?: string }).message || 'This experiment is not supported yet.'
            : (err as { message?: string })?.message || 'Failed to answer. Please try again.';
      // Global toast, so a question that fails while the user is on another tab still says so.
      message.error(msg);
      patchTurn(expId, turnId, { error: true });
    }
  } finally {
    patchTurn(expId, turnId, { streaming: false });
    updateSession(expId, (s) => {
      if (s.running?.turnId === turnId) s.running = undefined;
    });
    // Drop the cross-tab "answering" marker — unless a newer question (on another experiment) owns it now.
    const store = useCommonStore.getState();
    if (store.qaStreamingExpId === expId) store.setQaStreaming(null);
  }
};

/** The thread so far, as the server wants it: complete exchanges only (a question whose answer failed or
 *  was stopped before any text has nothing to follow up on), newest last, capped. Text only — an earlier
 *  turn's frames are not re-sent, so each one carries the times of the moments it had attached. */
const historyOf = (turns: QaTurn[]): QaHistoryTurn[] =>
  turns
    .filter((t) => !t.streaming && t.question.trim() && t.answer.trim())
    .slice(-QA_HISTORY_TURNS)
    .map((t) => ({
      question: t.question,
      // A stopped answer breaks off mid-thought; say so, or the model reads its own half-sentence as a
      // finished point and builds the follow-up on it.
      answer: t.stopped ? `${t.answer} [the student stopped this answer before it finished]` : t.answer,
      momentTimes: t.moments.map((m) => m.tSeconds),
    }));

/** Stop the answer in flight for this experiment. Aborting the stream disconnects the caller, which the
 *  function reads as a cancellation — so the model stops mid-answer instead of billing the rest, and the
 *  turn is never persisted. Works from a remount too: the controller lives on the session. */
const stopQuestion = (expId: string) => sessions.get(expId)?.running?.controller.abort();

// The free-form AI Q&A box fills the workspace panel: the thread grows and scrolls internally while the
// chips + input row stay pinned to the bottom (the workspace gives it a full-height, definite-height box).
const Wrap = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  font-size: 14px;
  color: black;

  .qa-thread {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-right: 4px;
  }
  .qa-empty {
    color: #999;
    font-size: 12px;
    margin: 2px 0 6px;
  }
  .qa-turn {
    margin-bottom: 12px;
  }
  .qa-q {
    background: #f0f5ff;
    border-radius: 8px;
    padding: 6px 10px;
    white-space: pre-wrap;
  }
  /* The moments the user attached to this question, shown under the question bubble. */
  .qa-q-moments {
    display: flex;
    gap: 4px;
    margin: 4px 0 2px;
  }
  .qa-q-moments .qa-qm {
    position: relative;
    cursor: pointer;
  }
  .qa-q-moments img {
    width: 44px;
    height: 34px;
    object-fit: cover;
    border-radius: 4px;
    display: block;
    background: #f5f5f5;
  }
  .qa-q-moments .qa-qm-t {
    position: absolute;
    left: 1px;
    bottom: 1px;
    font-size: 9px;
    line-height: 1;
    padding: 1px 2px;
    border-radius: 2px;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-variant-numeric: tabular-nums;
  }
  .qa-model {
    font-size: 11px;
    color: #999;
  }
  .qa-error {
    font-size: 12px;
    color: #ff4d4f;
    margin: 2px 0;
  }
  /* Stopped by the user — a statement of fact, not a failure, so it stays in the muted grey the model
     label uses rather than the error red. */
  .qa-stopped {
    font-size: 12px;
    color: #999;
    margin: 2px 0;
  }
  /* Markdown answer body — tightened like the AI report so it reads cleanly in the narrow column. */
  .qa-a {
    padding: 2px 2px 0;
  }
  .qa-a h4 {
    font-size: 16px;
    margin: 10px 0 4px;
  }
  .qa-a h5 {
    font-size: 15px;
    margin: 8px 0 4px;
  }
  /* markdownToHtml maps ###+ here; without this rule it would fall back to the browser's tiny default,
     and every heading must stay at least as large as the 14px body it introduces. */
  .qa-a h6 {
    font-size: 14px;
    margin: 8px 0 4px;
  }
  .qa-a p {
    margin: 4px 0;
  }
  .qa-a ul,
  .qa-a ol {
    margin: 4px 0;
    padding-left: 20px;
  }
  .qa-a li {
    margin: 2px 0;
  }
  /* GFM tables: scroll horizontally instead of clipping/squishing in the narrow column. */
  .qa-a .md-table {
    overflow-x: auto;
    margin: 8px 0;
  }
  .qa-a table {
    border-collapse: collapse;
    font-size: 12px;
  }
  .qa-a th,
  .qa-a td {
    border: 1px solid #e0e0e0;
    padding: 3px 7px;
    text-align: left;
    white-space: nowrap;
  }
  .qa-a th {
    background: #fafafa;
    font-weight: 600;
  }
  .qa-thinking {
    color: #999;
    font-size: 12px;
    margin: 4px 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  /* Blinking caret shown at the end of an answer while it is still streaming. */
  .qa-cursor {
    display: inline-block;
    width: 6px;
    margin-left: 1px;
    animation: qa-blink 1s step-start infinite;
  }
  @keyframes qa-blink {
    50% {
      opacity: 0;
    }
  }

  .qa-chips {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding: 6px 0 2px;
  }
  .qa-chip {
    position: relative;
    flex: 0 0 auto;
    width: 58px;
    border: 1px solid #e8e8e8;
    border-radius: 8px;
    padding: 2px;
    cursor: pointer;
    text-align: center;
  }
  .qa-chip:hover {
    border-color: #bbb;
  }
  .qa-chip img {
    width: 52px;
    height: 40px;
    object-fit: cover;
    border-radius: 4px;
    display: block;
    margin: 0 auto;
    background: #f5f5f5;
  }
  .qa-chip-label {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    line-height: 1.4;
  }
  .qa-chip-x {
    position: absolute;
    top: -7px;
    right: -7px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    border: 1px solid #ddd;
    color: #666;
    font-size: 11px;
    line-height: 14px;
    text-align: center;
  }
  .qa-chip-x:hover {
    color: #ff4d4f;
    border-color: #ff4d4f;
  }

  .qa-input-row {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    margin-top: 6px;
  }
  /* The tools row (Add moment + model picker) wraps on a narrow panel so the fixed-width picker drops
     under the button instead of overflowing. The composer row below keeps one line (the textarea is
     width:100%, so wrapping there would always push Send under it). */
  .qa-tools-row {
    flex-wrap: wrap;
  }

  .qa-header {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 2px;
  }
  .qa-clear {
    padding: 0;
    height: auto;
    font-size: 12px;
  }
  /* A history-loaded moment (no thumbnail): a compact click-to-seek pill instead of the frame image. */
  .qa-qm-pill {
    display: inline-flex;
    align-items: center;
    height: 24px;
    padding: 0 8px;
    border: 1px solid #e8e8e8;
    border-radius: 12px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: #333;
    cursor: pointer;
  }
  .qa-qm-pill:hover {
    border-color: #1677ff;
    color: #1677ff;
  }
  .qa-hint {
    font-size: 12px;
    color: #888;
    margin-top: 6px;
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .qa-hint-btn {
    padding: 0 4px;
    height: auto;
    font-size: 12px;
  }
`;

interface Props {
  experiment: Experiment;
}

/**
 * Free-form AI Q&A for a recording experiment (the "pull" complement to the AI report). Any staff may
 * ask; up to 3 curated "moments" (frozen frame snapshots) can be attached for comparison. On send the
 * question + moments appear immediately and the answer streams in (answerExperimentQuestionStream). The
 * thread is persisted so it's restored on return: the OWNER's to Firestore (shareable across devices),
 * a NON-owner's only to this browser's localStorage (never uploaded). Staff-gated.
 */
const QaPanel = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const isOwner = !!user && user.id === experiment.ownerId;
  // Q&A supports both media types (the server reads data_N.dat for recordings, the .vir for videos).
  const isVideo = experiment.sourceType === ExperimentType.Video;
  const canUse = isStaff(user) && (experiment.sourceType === ExperimentType.Recording || isVideo);

  const attachedMoments = useCommonStore((state) => state.attachedMoments);
  const removeAttachedMoment = useCommonStore((state) => state.removeAttachedMoment);
  const clearAttachedMoments = useCommonStore((state) => state.clearAttachedMoments);
  const requestSnapshotMoment = useCommonStore((state) => state.requestSnapshotMoment);
  const requestKeyframeSeek = useCommonStore((state) => state.requestKeyframeSeek);
  const setQaStreaming = useCommonStore((state) => state.setQaStreaming);
  const { getPlayerIndex } = useMappingIndex(experiment.segments, experiment.duration);

  // Question box + thread both live in the module-level session (see QaSession): this panel is unmounted
  // whenever the user looks at another tab, and neither a half-typed question nor a streaming answer
  // should die with it. The component state below is a mirror the session pushes into.
  const [question, setQuestionState] = useState(() => sessionFor(experiment.id).question);
  const setQuestion = (value: string) => {
    setQuestionState(value);
    updateSession(experiment.id, (s) => {
      s.question = value;
    });
  };
  // The selected model lives in the store (not local state) so the player's right-click menu can react
  // to it — a text-only model can't see frames, so moment-attach is disabled everywhere while it's picked.
  const model = useCommonStore((state) => state.qaModel);
  const setQaModel = useCommonStore((state) => state.setQaModel);
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  const [turns, setTurns] = useState<QaTurn[]>(() => sessionFor(experiment.id).turns);
  // Derived, not stored: the send button is blocked exactly while some turn is still streaming — which
  // stays true across a tab switch, since the turn lives in the session rather than in this component.
  const loading = turns.some((t) => t.streaming);
  // The moment lightbox (null = closed). Clicking a thumbnail opens this instead of seeking — the frames
  // are thumbnail-sized on the panel, so looking at one is the likelier intent; the seek moved into the
  // lightbox as an explicit button. It holds the whole GROUP the thumbnail belongs to (the chip tray, or
  // one sent turn) so the arrows page through that group's frames without closing.
  const [preview, setPreview] = useState<{ items: PreviewItem[]; index: number } | null>(null);
  // Page the lightbox, wrapping at both ends (a group is at most 3 frames, so wrapping beats dead arrows).
  const stepPreview = useCallback(
    (delta: number) =>
      setPreview((p) => (p ? { ...p, index: (p.index + delta + p.items.length) % p.items.length } : p)),
    [],
  );

  // Keep the newest turn (and its streaming answer) in view as it grows.
  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Re-attach to this experiment's session on every mount. A tab switch unmounts this panel while the
  // answer keeps streaming into the session, so catch up on whatever landed meanwhile, then take over as
  // the session's subscriber for as long as we're mounted.
  useEffect(() => {
    const session = sessionFor(experiment.id);
    setTurns(session.turns);
    setQuestionState(session.question);
    session.onTurns = setTurns;
    return () => {
      // Stop feeding a component that is going away; the run keeps writing to the session (so the next
      // mount picks up where this one left off). Guarded so a remount's subscriber is never cleared by
      // the outgoing one.
      if (session.onTurns === setTurns) session.onTurns = undefined;
    };
  }, [experiment.id]);

  // Load this user's saved thread ONCE per experiment (not once per mount — the panel remounts on every
  // tab switch). Owner → Firestore; non-owner → this browser's localStorage. Persisted turns have no
  // thumbnail, so their moments render as labelled pills.
  useEffect(() => {
    if (!canUse || !user) return;
    const session = sessionFor(experiment.id);
    if (session.loaded) return;
    session.loaded = true; // claimed before the await, so a quick unmount/remount can't fetch twice
    (async () => {
      try {
        const saved = isOwner ? await loadQaTurns(experiment.id, user.id) : loadLocalTurns(experiment.id, user.id);
        if (!saved.length) return;
        updateSession(experiment.id, (s) => {
          // History first, then anything asked in this session — a question sent before the fetch landed
          // is the newest turn, not the oldest.
          s.turns = [
            ...saved.map((t) => ({
              id: nextTurnId++,
              question: t.question,
              answer: t.answer,
              model: t.model,
              moments: t.moments,
              streaming: false,
            })),
            ...s.turns,
          ];
        });
      } catch (e) {
        console.error('failed to load qa history', e);
        sessionFor(experiment.id).loaded = false; // let a later mount try again
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // History turns hydrate without a thumbnail (only recordingIndex + tSeconds persist). Rebuild them —
  // recordings fetch data_N.png, videos colourise the cached .vir frame — so a reloaded moment shows a
  // frame image instead of a bare seek pill. Must run before the early return below (rules of hooks).
  const rebuiltThumbs = useRebuiltThumbnails(
    turns.flatMap((t) => t.moments),
    experiment,
  );

  // Markers for the ENLARGED moment, drawn live rather than relied on from the snapshot — the lightbox
  // re-fetches a clean render whenever the recording has IR/visible/blended companions, and a moment
  // restored from history has no snapshot of its own at all. Same treatment the report's figures get.
  // Computed only for the open group, so nothing is fetched until a moment is actually blown up.
  const previewFrames = useMemo(() => preview?.items.map((i) => i.recordingIndex) ?? [], [preview]);
  const previewReadings = useFrameReadings(previewFrames, experiment);
  // The notes the player would be showing at that instant: no time window = always on the scene, a window
  // = only inside it (the rule the annotation layer itself plays by).
  const storeAnnotations = useCommonStore((s) => s.analyzerAnnotations.get(experiment.id));
  const annotationsAt = useCallback(
    (tSeconds: number) =>
      (storeAnnotations ?? []).filter((a) => !a.time || (tSeconds >= a.time.start && tSeconds <= a.time.end)),
    [storeAnnotations],
  );

  if (!canUse || !user) return null;
  const userId = user.id;

  // Turn one group of moments (the chip tray, or one sent turn) into lightbox pages: every moment that
  // has an image becomes a page, labelled by its position in the full group.
  const previewGroup = <T extends { recordingIndex: number; tSeconds: number }>(
    moments: T[],
    srcOf: (m: T) => string | undefined,
  ): PreviewItem[] =>
    moments
      .map((m, i) => ({
        src: srcOf(m),
        recordingIndex: m.recordingIndex,
        tSeconds: m.tSeconds,
        label: CIRCLED[i] ?? String(i + 1),
      }))
      .filter((m): m is PreviewItem => !!m.src);

  // Open the lightbox on one moment of a group. A moment with no image (a rebuild that failed or is still
  // in flight) has nothing to blow up, so it falls back to the seek rather than being a dead click.
  const openPreview = (items: PreviewItem[], recordingIndex: number) => {
    const index = items.findIndex((it) => it.recordingIndex === recordingIndex);
    if (index >= 0) setPreview({ items, index });
    else seekTo(recordingIndex);
  };

  const onClearHistory = async () => {
    try {
      if (isOwner) await clearQaTurns(experiment.id, userId);
      else clearLocalTurns(experiment.id, userId);
      updateSession(experiment.id, (s) => {
        s.turns = [];
      });
    } catch (e) {
      console.error('failed to clear qa history', e);
      message.error('Failed to clear history.');
    }
  };

  // A recording moment's recordingIndex is in recording-frame space (mapped back to a player index to
  // seek); a video moment's recordingIndex is already the .vir frame index the VideoPlayer seeks to.
  const seekTo = (recordingIndex: number) =>
    requestKeyframeSeek(isVideo ? recordingIndex : getPlayerIndex(recordingIndex));

  const onSend = () => {
    const text = question.trim();
    if (!text || loading) return;
    // Snapshot the attached moments into this turn, then show the question immediately, clear the input,
    // and clear the tray (the moments now belong to the sent message).
    const used: TurnMoment[] = attachedMoments.map((m) => ({
      recordingIndex: m.recordingIndex,
      tSeconds: m.tSeconds,
      thumbnail: m.thumbnail,
    }));
    // What the server is handed: the frame numbers, plus each moment's capture of the player as the user
    // saw it — the frame with its probe markers, annotation callouts and transect lines on it — so the
    // model looks at the same picture they do. A text-only model drops every image server-side, so its
    // questions don't carry the captures at all rather than uploading megabytes to be discarded.
    const sent: QaMomentPayload[] = attachedMoments.map((m) => ({
      recordingIndex: m.recordingIndex,
      tSeconds: m.tSeconds,
      ...(m.overlay && !isTextOnlyModel(model) ? { overlay: m.overlay, overlayView: m.overlayView } : {}),
    }));
    // Persisted / replayed form: indices and times only — a capture is a session-sized data URL.
    const usedRi = used.map((m) => ({ recordingIndex: m.recordingIndex, tSeconds: m.tSeconds }));
    // The thread as it stands BEFORE this question joins it — that is what the question is a follow-up to.
    const history = historyOf(sessionFor(experiment.id).turns);
    const turnId = nextTurnId++;
    updateSession(experiment.id, (s) => {
      s.turns = [...s.turns, { id: turnId, question: text, moments: used, answer: '', model, streaming: true }];
      s.question = '';
    });
    setQuestionState('');
    clearAttachedMoments();
    // Flags the tab strip while the answer is on its way, so the dot on "Ask AI" says an answer is still
    // arriving after the user has moved to another tab.
    setQaStreaming(experiment.id);
    // Deliberately NOT awaited, and deliberately not a closure over this component: the run belongs to the
    // session, so switching tabs (which unmounts this panel) leaves it streaming instead of cutting it off.
    // The owner's turn is persisted server-side; a non-owner keeps their thread only in this browser, so
    // that copy is appended here when the answer lands.
    runQuestion(
      experiment.id,
      turnId,
      text,
      sent,
      history,
      model,
      isOwner
        ? null
        : (answer) =>
            saveLocalTurns(experiment.id, userId, [
              ...loadLocalTurns(experiment.id, userId),
              { question: text, answer, model, moments: usedRi },
            ]),
    );
  };

  // A text-only model (none is offered today) never receives the attached frame IMAGES — but a moment is
  // more than its picture: the server still sends that frame's probe readings and whole-frame stats as
  // numbers. So moment-attach stays enabled for every model; the banner below spells out what a text-only
  // model does and doesn't get instead of blocking the button.
  const isTextOnly = isTextOnlyModel(model);
  // Nudge to attach the current frame when the question reads like it's about a specific moment.
  const showMomentHint = attachedMoments.length === 0 && !loading && MOMENT_HINT_RE.test(question);

  return (
    <Wrap>
      {turns.length > 0 && (
        <div className="qa-header">
          <Popconfirm
            title="Clear this experiment's Q&A history?"
            okText="Clear"
            okButtonProps={{ danger: true }}
            onConfirm={onClearHistory}
          >
            <Button type="link" size="small" danger className="qa-clear">
              Clear history
            </Button>
          </Popconfirm>
        </div>
      )}
      <div className="qa-thread" ref={threadRef}>
        {turns.length === 0 && (
          <div className="qa-empty">
            Ask anything about this experiment. Attach up to 3 moments (right-click a frame, or “+ Add moment”) to
            compare them.{' '}
            {isOwner
              ? 'Your thread is saved and restored when you come back.'
              : 'Your thread is saved on this device only (not uploaded).'}
          </div>
        )}
        {turns.map((t) => (
          <div className="qa-turn" key={t.id}>
            <div className="qa-q">{t.question}</div>
            {t.moments.length > 0 && (
              <div className="qa-q-moments">
                {t.moments.map((m, j) => {
                  // This session's turns carry a thumbnail; history turns hydrate without one and get a
                  // rebuilt frame image (or a seek pill if the rebuild hasn't landed / failed).
                  const thumb = m.thumbnail || rebuiltThumbs[m.recordingIndex];
                  return thumb ? (
                    <span
                      className="qa-qm"
                      key={m.recordingIndex}
                      title="Click to enlarge"
                      onClick={() =>
                        openPreview(
                          previewGroup(t.moments, (mm) => mm.thumbnail || rebuiltThumbs[mm.recordingIndex]),
                          m.recordingIndex,
                        )
                      }
                    >
                      <img src={thumb} alt="" />
                      <span className="qa-qm-t">
                        {CIRCLED[j] ?? j + 1} {formatDuration(m.tSeconds)}
                      </span>
                    </span>
                  ) : (
                    // No image to enlarge (the rebuild failed or is still in flight) — this variant keeps
                    // the seek, so the moment is never a dead click.
                    <span
                      className="qa-qm-pill"
                      key={m.recordingIndex}
                      title="Jump to this moment"
                      onClick={() => seekTo(m.recordingIndex)}
                    >
                      {CIRCLED[j] ?? j + 1} {formatDuration(m.tSeconds)}
                    </span>
                  );
                })}
              </div>
            )}
            {t.answer && (
              <div className="qa-a">
                <span dangerouslySetInnerHTML={{ __html: markdownToHtml(t.answer) }} />
                {t.streaming && <span className="qa-cursor">▍</span>}
              </div>
            )}
            {t.streaming && !t.answer && (
              <div className="qa-thinking">
                <LoadingOutlined spin />
                Thinking…
              </div>
            )}
            {t.error && <div className="qa-error">Couldn’t answer — please try again.</div>}
            {t.stopped && (
              <div className="qa-stopped">{t.answer ? 'Stopped — this answer is unfinished.' : 'Stopped.'}</div>
            )}
            {!t.streaming && !t.error && <span className="qa-model">{modelLabel(t.model)}</span>}
          </div>
        ))}
      </div>

      {attachedMoments.length > 0 && (
        <div className="qa-chips">
          {attachedMoments.map((m, i) => (
            <div
              className="qa-chip"
              key={m.recordingIndex}
              title={[
                m.thumbnail ? 'Click to enlarge' : 'Jump to this moment',
                ...m.readings.map(
                  (r) =>
                    `${r.label}: ${displayTemp(r.value, temperatureUnit).toFixed(1)} ${temperatureSymbol(temperatureUnit)}`,
                ),
              ].join('\n')}
              onClick={() =>
                openPreview(
                  previewGroup(attachedMoments, (mm) => mm.thumbnail),
                  m.recordingIndex,
                )
              }
            >
              {m.thumbnail ? <img src={m.thumbnail} alt="" /> : <div style={{ width: 52, height: 40 }} />}
              <div className="qa-chip-label">
                {CIRCLED[i] ?? i + 1} {formatDuration(m.tSeconds)}
              </div>
              <span
                className="qa-chip-x"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAttachedMoment(m.recordingIndex);
                }}
              >
                ×
              </span>
            </div>
          ))}
        </div>
      )}

      {showMomentHint && (
        <div className="qa-hint">
          💡 Asking about a specific moment?
          <Button type="link" size="small" className="qa-hint-btn" onClick={() => requestSnapshotMoment()}>
            {isTextOnly ? 'Attach this moment’s data' : 'Attach the current frame'}
          </Button>
        </div>
      )}

      <div className="qa-input-row qa-tools-row">
        <Button
          size="small"
          onClick={() => requestSnapshotMoment()}
          disabled={attachedMoments.length >= 3}
          title={
            isTextOnly
              ? `Attach the frame the player is on — ${MODEL_LABELS[model]} can’t see the picture, but it gets that moment’s readings and frame stats`
              : 'Attach the frame the player is on, with your probes and notes drawn on it'
          }
        >
          + Add moment ({attachedMoments.length}/3)
        </Button>
        <Select
          size="small"
          value={model}
          onChange={setQaModel}
          style={{ width: 172 }}
          options={MODEL_KEYS.map((k) => ({ value: k, label: MODEL_LABELS[k] }))}
        />
      </div>
      {isTextOnly && (
        // Kept to one line at a normal panel width — the full "what it actually gets" wording lives in the
        // hover title, so the banner states the rule without eating three rows above the input.
        <div
          className="qa-hint"
          title={`${MODEL_LABELS[model]} is text-only: an attached moment reaches it as that frame's probe readings and whole-frame min/max/mean, never the image.`}
        >
          ⚠️ {MODEL_LABELS[model]} can’t see frames — moments attach as numbers, not pictures.
        </div>
      )}
      {!isTextOnly && (
        // Says where the pictures come from when the student attached none, so an answer that describes
        // the scene doesn't read as the model having seen something it was never given.
        <div
          className="qa-hint"
          title="With no moment attached, the first frame and the hottest frame are sent so the model can see the scene. Attach a moment to ask about a specific instant instead."
        >
          💡 With no moment attached, {MODEL_LABELS[model]} is shown the first and hottest frames.
        </div>
      )}

      <div className="qa-input-row">
        <Input.TextArea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about this experiment…"
          autoSize={{ minRows: 1, maxRows: 4 }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. Ignore Enter mid-IME-composition (e.g. Chinese).
            if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as { isComposing?: boolean }).isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        {/* While an answer is on its way, Send becomes Stop — the run outlives this panel, so this is the
            way out of a slow (or wedged) backend without reloading the page. */}
        {loading ? (
          <Button
            danger
            size="small"
            onClick={() => stopQuestion(experiment.id)}
            title="Stop this answer — the model stops generating too"
          >
            Stop
          </Button>
        ) : (
          <Button type="primary" size="small" disabled={!question.trim()} onClick={onSend}>
            Send
          </Button>
        )}
      </div>

      {/* The enlarged frame (shared with the AI report's figures — see momentLightbox). Kept mounted so
          its per-mode render cache and companion probe survive open/close cycles. */}
      <MomentLightbox
        experiment={experiment}
        preview={preview}
        onStep={stepPreview}
        onClose={() => setPreview(null)}
        onSeek={seekTo}
        renderOverlay={(item) => (
          <FrameOverlay
            probes={previewReadings[item.recordingIndex] ?? []}
            annotations={annotationsAt(item.tSeconds)}
            unit={temperatureUnit}
          />
        )}
      />
    </Wrap>
  );
};

export default QaPanel;
