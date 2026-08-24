import { useEffect, useRef, useState } from 'react';
import { Button, Input, Popconfirm, Select, message } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';
import styled from 'styled-components';
import { Experiment, ExperimentType, MODEL_KEYS, MODEL_LABELS, QaModel, isTextOnlyModel } from '../../../types';
import useCommonStore from '../../../stores/common';
import { useMappingIndex } from '../hooks';
import { answerExperimentQuestionStream, clearQaTurns, loadQaTurns } from '../../../services/ai';
import { markdownToHtml } from '../../../utils/markdown';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';
import { isStaff } from '../../../utils/staff';
import { useRebuiltThumbnails } from './useRebuiltThumbnails';

// Question keywords that suggest the user is asking about a specific moment — used to nudge them to
// attach the current frame (English + Chinese; kept targeted to avoid firing on generic wording).
const MOMENT_HINT_RE =
  /right now|this (moment|frame|instant|point)|at this (moment|point|time|frame)|the (spike|peak|jump|dip|drop)|happening now|现在|此刻|此时|这一?[帧刻]|这个?(时刻|尖峰|峰值|变化|时候)|这里|刚才/i;

const CIRCLED = ['①', '②', '③'];

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
};

// A moment as captured into a sent turn (where to seek back to; thumbnail present for this session's
// turns, absent for turns loaded from history — those render as a labelled pill instead).
interface TurnMoment {
  recordingIndex: number;
  tSeconds: number;
  thumbnail?: string;
}
interface QaTurn {
  question: string;
  moments: TurnMoment[];
  answer: string; // grows as the answer streams in
  model: QaModel;
  streaming: boolean;
  error?: boolean;
}

// A persisted turn (owner → Firestore; non-owner → localStorage below). Same shape either way; moments
// carry only recordingIndex + tSeconds (no thumbnail), so both render as labelled pills on reload.
type StoredTurn = {
  question: string;
  answer: string;
  model: QaModel;
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
  /* Markdown answer body — tightened like the AI report so it reads cleanly in the narrow column. */
  .qa-a {
    padding: 2px 2px 0;
  }
  .qa-a h4 {
    font-size: 15px;
    margin: 10px 0 4px;
  }
  .qa-a h5 {
    font-size: 13px;
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
  const { getPlayerIndex } = useMappingIndex(experiment.segments, experiment.duration);

  const [question, setQuestion] = useState('');
  // The selected model lives in the store (not local state) so the player's right-click menu can react
  // to it — a text-only model can't see frames, so moment-attach is disabled everywhere while it's picked.
  const model = useCommonStore((state) => state.qaModel);
  const setQaModel = useCommonStore((state) => state.setQaModel);
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  const [turns, setTurns] = useState<QaTurn[]>([]);
  const [loading, setLoading] = useState(false);

  // Keep the newest turn (and its streaming answer) in view as it grows.
  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Load this user's saved thread once on mount (InfoSection keys the panel by experiment, so a mount
  // is a fresh experiment). Owner → Firestore; non-owner → this browser's localStorage. Persisted turns
  // have no thumbnail — their moments render as labelled pills.
  useEffect(() => {
    if (!canUse || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const saved = isOwner ? await loadQaTurns(experiment.id, user.id) : loadLocalTurns(experiment.id, user.id);
        if (!cancelled && saved.length) {
          setTurns(
            saved.map((t) => ({
              question: t.question,
              answer: t.answer,
              model: t.model,
              moments: t.moments,
              streaming: false,
            })),
          );
        }
      } catch (e) {
        console.error('failed to load qa history', e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // History turns hydrate without a thumbnail (only recordingIndex + tSeconds persist). Rebuild them —
  // recordings fetch data_N.png, videos colourise the cached .vir frame — so a reloaded moment shows a
  // frame image instead of a bare seek pill. Must run before the early return below (rules of hooks).
  const rebuiltThumbs = useRebuiltThumbnails(
    turns.flatMap((t) => t.moments),
    experiment,
  );

  if (!canUse || !user) return null;
  const userId = user.id;

  const onClearHistory = async () => {
    try {
      if (isOwner) await clearQaTurns(experiment.id, userId);
      else clearLocalTurns(experiment.id, userId);
      setTurns([]);
    } catch (e) {
      console.error('failed to clear qa history', e);
      message.error('Failed to clear history.');
    }
  };

  // A recording moment's recordingIndex is in recording-frame space (mapped back to a player index to
  // seek); a video moment's recordingIndex is already the .vir frame index the VideoPlayer seeks to.
  const seekTo = (recordingIndex: number) =>
    requestKeyframeSeek(isVideo ? recordingIndex : getPlayerIndex(recordingIndex));

  const patchTurn = (idx: number, patch: Partial<QaTurn>) =>
    setTurns((t) => t.map((turn, i) => (i === idx ? { ...turn, ...patch } : turn)));

  const onSend = async () => {
    const text = question.trim();
    if (!text || loading) return;
    // Snapshot the attached moments into this turn, then show the question immediately, clear the input,
    // and clear the tray (the moments now belong to the sent message).
    const used: TurnMoment[] = attachedMoments.map((m) => ({
      recordingIndex: m.recordingIndex,
      tSeconds: m.tSeconds,
      thumbnail: m.thumbnail,
    }));
    const idx = turns.length;
    setTurns((t) => [...t, { question: text, moments: used, answer: '', model, streaming: true }]);
    setQuestion('');
    clearAttachedMoments();
    setLoading(true);
    const usedRi = used.map((m) => ({ recordingIndex: m.recordingIndex, tSeconds: m.tSeconds }));
    try {
      const answer = await answerExperimentQuestionStream(experiment.id, text, usedRi, model, (full) =>
        patchTurn(idx, { answer: full }),
      );
      // The owner's turn is persisted server-side (Firestore); a non-owner keeps their thread only in
      // this browser, so append it to localStorage here.
      if (!isOwner) {
        saveLocalTurns(experiment.id, userId, [
          ...loadLocalTurns(experiment.id, userId),
          { question: text, answer, model, moments: usedRi },
        ]);
      }
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const msg =
        code === 'functions/resource-exhausted'
          ? 'Usage limit reached. Please try again later.'
          : code === 'functions/failed-precondition'
            ? (err as { message?: string }).message || 'This experiment is not supported yet.'
            : (err as { message?: string })?.message || 'Failed to answer. Please try again.';
      message.error(msg);
      patchTurn(idx, { error: true });
    } finally {
      patchTurn(idx, { streaming: false });
      setLoading(false);
    }
  };

  // A text-only model (DeepSeek / Grok) never receives the attached frame images, so attaching a "moment"
  // (a visual frame) doesn't make sense — disable it and explain instead of nudging.
  const isTextOnly = isTextOnlyModel(model);
  // Nudge to attach the current frame when the question reads like it's about a specific moment.
  const showMomentHint = attachedMoments.length === 0 && !loading && !isTextOnly && MOMENT_HINT_RE.test(question);

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
        {turns.map((t, i) => (
          <div className="qa-turn" key={i}>
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
                      title="Jump to this moment"
                      onClick={() => seekTo(m.recordingIndex)}
                    >
                      <img src={thumb} alt="" />
                      <span className="qa-qm-t">
                        {CIRCLED[j] ?? j + 1} {fmtTime(m.tSeconds)}
                      </span>
                    </span>
                  ) : (
                    <span
                      className="qa-qm-pill"
                      key={m.recordingIndex}
                      title="Jump to this moment"
                      onClick={() => seekTo(m.recordingIndex)}
                    >
                      {CIRCLED[j] ?? j + 1} {fmtTime(m.tSeconds)}
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
            {!t.streaming && !t.error && <span className="qa-model">{MODEL_LABELS[t.model] ?? t.model}</span>}
          </div>
        ))}
      </div>

      {attachedMoments.length > 0 && (
        <div className="qa-chips">
          {attachedMoments.map((m, i) => (
            <div
              className="qa-chip"
              key={m.recordingIndex}
              title={m.readings
                .map(
                  (r) =>
                    `${r.label}: ${displayTemp(r.value, temperatureUnit).toFixed(1)} ${temperatureSymbol(temperatureUnit)}`,
                )
                .join('  ')}
              onClick={() => seekTo(m.recordingIndex)}
            >
              {m.thumbnail ? <img src={m.thumbnail} alt="" /> : <div style={{ width: 52, height: 40 }} />}
              <div className="qa-chip-label">
                {CIRCLED[i] ?? i + 1} {fmtTime(m.tSeconds)}
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
            Attach the current frame
          </Button>
        </div>
      )}

      <div className="qa-input-row qa-tools-row">
        <Button
          size="small"
          onClick={() => requestSnapshotMoment()}
          disabled={isTextOnly || attachedMoments.length >= 3}
          title={
            isTextOnly
              ? 'This model can’t see frames — switch to a GPT, Gemini or Grok model to attach a moment'
              : 'Attach the frame the player is on'
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
        <div className="qa-hint">
          ⚠️ {MODEL_LABELS[model]} is text-only — it can’t see frames. It answers from the numeric data and the
          experiment description; attaching moments is disabled.
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
        <Button type="primary" size="small" loading={loading} disabled={!question.trim()} onClick={onSend}>
          Send
        </Button>
      </div>
    </Wrap>
  );
};

export default QaPanel;
