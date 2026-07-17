import { useEffect, useState } from 'react';
import { Input, message } from 'antd';
import {
  AimOutlined,
  CaretRightOutlined,
  CloseOutlined,
  EditOutlined,
  PauseOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import styled from 'styled-components';
import { Experiment, ExperimentType } from '../../../types';
import useCommonStore, { MAX_KEY_MOMENTS } from '../../../stores/common';
import { useMappingIndex } from '../hooks';
import { formatDuration } from '../../../utils/helpers';
import { fetchRecordingFrameDataUrl } from '../../../utils/recordingFrame';

// Key moments = the owner's captioned timeline. Sitting in the Info tab under the description, each entry
// is a card — a thumbnail (a recording frame, or a labelled block for a video, which has no CORS-safe
// frame image) with its time underneath — plus the owner's note beside it. Clicking a thumbnail seeks the
// player to its (start) frame; a span additionally has a play button (bottom-left of the thumbnail) that
// plays start→end and toggles pause. The owner marks the current frame ("Mark this frame") or a range
// ("Mark a range" → play to the end → "End here"); re-points a frame two ways — typing its time under the
// thumbnail, or the "Set frame / Set start / Set end" buttons that snap it to the current player frame;
// and captions / removes each. A viewer of an empty timeline sees nothing; the owner always sees it.
const Section = styled.div`
  margin-top: 20px;
`;
const Header = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin-bottom: 10px;

  .km-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--ifi-ink);
  }
  .km-action {
    appearance: none;
    border: none;
    background: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: 4px;
    font: inherit;
    font-size: 13px;
    color: var(--ifi-teal-dark);
    cursor: pointer;
  }
  .km-action:hover {
    background: rgba(0, 140, 140, 0.08);
  }
  .km-action:disabled {
    color: var(--ifi-text-tertiary);
    cursor: default;
    background: none;
  }
  .km-pending {
    font-size: 13px;
    color: var(--ifi-text-secondary);
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .km-pending b {
    color: var(--ifi-ink);
  }
`;
const Empty = styled.p`
  margin: 0;
  font-size: 13px;
  color: var(--ifi-text-tertiary);
`;
// A responsive grid of hoverable entries. Each column grows to ~half the container (the 45% floor makes
// exactly two columns fit and 1fr stretches them to fill the width), so the pair spans the panel rather
// than hugging the left. Below ~660px the 330px floor wins and it drops to a single column; max-width
// caps how wide the columns can get on a very wide panel. auto-fit keys off the CONTAINER (the workspace
// panel), not the viewport.
const List = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(max(330px, 45%), 1fr));
  gap: 2px 18px;
  max-width: 1600px;

  .km-row {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 8px;
    border-radius: 8px;
    transition: background 0.15s ease;
  }
  .km-row:hover {
    background: rgba(0, 0, 0, 0.035);
  }
  /* The card: thumbnail on top, time label underneath, a hairline round it. */
  .km-media {
    flex: 0 0 auto;
    width: 120px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 8px;
    overflow: hidden;
    background: var(--ifi-surface);
  }
  /* Only the image area is the positioning context, so the overlay play button sits on the frame — not
     over the time label below it. */
  .km-thumb-area {
    position: relative;
  }
  /* The seek target — clicking the thumbnail jumps to the entry's (start) frame. */
  .km-jump {
    appearance: none;
    border: none;
    background: none;
    padding: 0;
    display: block;
    width: 120px;
    cursor: pointer;
  }
  .km-thumb,
  .km-pill {
    display: block;
    width: 120px;
    height: 74px;
    object-fit: cover;
  }
  /* A video (no frame image) or a not-yet-rebuilt recording frame shows a flat teal-tinted block. */
  .km-pill {
    background: linear-gradient(135deg, rgba(0, 140, 140, 0.14), rgba(0, 140, 140, 0.06));
  }
  /* Play (bottom-left, spans only) plays the range and toggles pause. */
  .km-play {
    position: absolute;
    bottom: 4px;
    left: 4px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    font-size: 15px;
    appearance: none;
    border: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    cursor: pointer;
  }
  .km-play:hover {
    background: rgba(0, 0, 0, 0.8);
  }
  /* Time under the thumbnail; the owner clicks a part to type a new time (start / end). */
  .km-time {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 4px 6px 5px;
    font-size: 12px;
    font-weight: 600;
    color: var(--ifi-ink);
  }
  .km-time-btn {
    appearance: none;
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .km-time-btn:hover {
    color: var(--ifi-teal-dark);
    text-decoration: underline;
  }
  .km-time-input {
    width: 44px;
    font: inherit;
    padding: 0 2px;
    border: 1px solid var(--ifi-teal);
    border-radius: 3px;
    outline: none;
  }
  .km-body {
    flex: 1;
    min-width: 0;
  }
  .km-caption {
    font-size: 14px;
    line-height: 1.45;
    color: #262626;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  /* Owner: quiet inline actions — edit / add a note, and snap the frame (or a range's ends) to the
     current player frame. */
  .km-note-btn,
  .km-set {
    appearance: none;
    border: none;
    background: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px;
    margin-left: -4px;
    border-radius: 4px;
    font: inherit;
    font-size: 13px;
    color: var(--ifi-text-tertiary);
    cursor: pointer;
  }
  .km-note-btn:hover,
  .km-set:hover {
    color: var(--ifi-teal-dark);
    background: rgba(0, 0, 0, 0.04);
  }
  .km-setrow {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin-top: 6px;
  }
  /* Remove sits at the row's right edge, quiet until the row is hovered. */
  .km-remove {
    appearance: none;
    border: none;
    background: none;
    padding: 2px;
    color: var(--ifi-text-tertiary);
    cursor: pointer;
    flex: 0 0 auto;
    line-height: 1;
    opacity: 0.4;
    transition:
      opacity 0.15s ease,
      color 0.15s ease;
  }
  .km-row:hover .km-remove {
    opacity: 1;
  }
  .km-remove:hover {
    color: #cf1322;
  }
`;

// "1:05" / "65" / "65.4" → seconds; null if unparseable.
const parseTime = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  if (t.includes(':')) {
    const parts = t.split(':');
    if (parts.length !== 2) return null;
    const mm = Number(parts[0]);
    const ss = Number(parts[1]);
    return Number.isFinite(mm) && Number.isFinite(ss) ? mm * 60 + ss : null;
  }
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

const KeyMoments = ({ experiment }: { experiment: Experiment }) => {
  const user = useCommonStore((state) => state.user);
  const isOwner = !!user && experiment.ownerId === user.id;
  const storeKeyMoments = useCommonStore((state) => state.keyMoments);
  const keyMomentsExpId = useCommonStore((state) => state.keyMomentsExpId);
  // Only render this experiment's moments: a navigation leaves the previous experiment's in the store
  // until hydration reseeds them, so ignore them until the store is tagged with our id.
  const keyMoments = keyMomentsExpId === experiment.id ? storeKeyMoments : [];
  const pendingSpanStart = useCommonStore((state) => state.pendingSpanStart);
  const setPendingSpanStart = useCommonStore((state) => state.setPendingSpanStart);
  const requestSnapshotMoment = useCommonStore((state) => state.requestSnapshotMoment);
  const requestKeyframeSeek = useCommonStore((state) => state.requestKeyframeSeek);
  const requestPlaySpan = useCommonStore((state) => state.requestPlaySpan);
  const requestPause = useCommonStore((state) => state.requestPause);
  const playerPlaying = useCommonStore((state) => state.playerPlaying);
  const activeSpanStart = useCommonStore((state) => state.activeSpanStart);
  const setActiveSpanStart = useCommonStore((state) => state.setActiveSpanStart);
  const playerFrameRate = useCommonStore((state) => state.playerFrameRate);
  const removeKeyMoment = useCommonStore((state) => state.removeKeyMoment);
  const setKeyMomentText = useCommonStore((state) => state.setKeyMomentText);
  const reanchorKeyMoment = useCommonStore((state) => state.reanchorKeyMoment);
  const reanchorKeyMomentEnd = useCommonStore((state) => state.reanchorKeyMomentEnd);

  const isVideo = experiment.sourceType === ExperimentType.Video;
  const { getPlayerIndex, getRecordingIndex } = useMappingIndex(experiment.segments, experiment.duration);

  // The entry currently being captioned (by recordingIndex) and its draft text.
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  // The time field currently being typed (which end of which entry) and its draft string.
  const [editingTime, setEditingTime] = useState<{ recordingIndex: number; which: 'start' | 'end' } | null>(null);
  const [timeDraft, setTimeDraft] = useState('');

  // Rebuilt thumbnails for persisted recording moments (which hydrate without an image — only the frame
  // index is stored). Keyed by recordingIndex; '' means the fetch was tried and failed (keep the pill).
  const recordingId = experiment.recordingId;
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const needThumbs =
    isVideo || !recordingId
      ? []
      : keyMoments.filter((m) => !m.thumbnail && thumbs[m.recordingIndex] === undefined).map((m) => m.recordingIndex);
  const needKey = needThumbs.join(',');
  useEffect(() => {
    if (!recordingId || needThumbs.length === 0) return;
    let cancelled = false;
    needThumbs.forEach((ri) => {
      fetchRecordingFrameDataUrl(recordingId, ri)
        .then((url) => !cancelled && setThumbs((t) => ({ ...t, [ri]: url })))
        .catch(() => !cancelled && setThumbs((t) => ({ ...t, [ri]: '' })));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needKey, recordingId]);

  // Recording indices map back to player-frame space to seek; a video's are already player frames.
  const toPlayer = (recordingIndex: number) => (isVideo ? recordingIndex : getPlayerIndex(recordingIndex));
  const seekToStart = (m: (typeof keyMoments)[number]) => requestKeyframeSeek(toPlayer(m.recordingIndex));
  // Span play button: toggle. If this span is the one playing, pause; else start it (and mark it active
  // so its button — and only its — shows pause).
  const togglePlaySpan = (m: (typeof keyMoments)[number]) => {
    if (m.endRecordingIndex === undefined) return;
    if (playerPlaying && activeSpanStart === m.recordingIndex) {
      requestPause();
    } else {
      setActiveSpanStart(m.recordingIndex);
      requestPlaySpan(toPlayer(m.recordingIndex), toPlayer(m.endRecordingIndex));
    }
  };

  const startEditTime = (recordingIndex: number, which: 'start' | 'end', seconds: number) => {
    setEditingTime({ recordingIndex, which });
    setTimeDraft(formatDuration(seconds));
  };
  // Commit a typed time: parse → nearest player frame (via the player's published rate) → update the
  // entry's start / end, keeping its caption. A recording's thumbnail is dropped so it re-fetches the new
  // frame; a video keeps its (empty) pill.
  const commitTime = (m: (typeof keyMoments)[number], which: 'start' | 'end') => {
    const draft = timeDraft.trim();
    setEditingTime(null);
    // The field is pre-filled with the (rounded) current time; leaving it unchanged must be a no-op, not
    // a re-round that could nudge the frame. Only a genuinely different typed value converts.
    const origLabel = formatDuration(which === 'start' ? m.tSeconds : (m.endTSeconds ?? m.tSeconds));
    if (draft === origLabel) return;
    const secs = parseTime(draft);
    if (secs === null || !playerFrameRate || playerFrameRate.secondsPerFrame <= 0) return;
    const playerFrame = Math.max(
      0,
      Math.min(Math.round(secs / playerFrameRate.secondsPerFrame), playerFrameRate.lastFrame),
    );
    const recIdx = isVideo ? playerFrame : getRecordingIndex(playerFrame);
    const tSec = Number((playerFrame * playerFrameRate.secondsPerFrame).toFixed(1));
    if (which === 'start') {
      if (recIdx === m.recordingIndex) return; // unchanged
      if (keyMoments.some((k) => k.recordingIndex !== m.recordingIndex && k.recordingIndex === recIdx)) {
        message.info('There’s already a key moment on this frame.');
        return;
      }
      if (m.endRecordingIndex !== undefined && recIdx >= m.endRecordingIndex) {
        message.info('The start must come before the end.');
        return;
      }
      reanchorKeyMoment(m.recordingIndex, { recordingIndex: recIdx, tSeconds: tSec, thumbnail: '', readings: [] });
    } else {
      if (recIdx === m.endRecordingIndex) return; // unchanged
      if (recIdx <= m.recordingIndex) {
        message.info('The end must come after the start.');
        return;
      }
      reanchorKeyMomentEnd(m.recordingIndex, recIdx, tSec);
    }
  };

  // Hide an entry a later re-trim (or a clone of a clip) left outside the kept segments — its frame no
  // longer maps to a real player position. A span needs both ends inside.
  const segs = experiment.segments;
  const reachable = (frame: number) =>
    isVideo || !segs || segs.length === 0 || segs.some((s) => frame >= s.start && frame <= s.end);
  const isVisible = (m: (typeof keyMoments)[number]) =>
    reachable(m.recordingIndex) && (m.endRecordingIndex === undefined || reachable(m.endRecordingIndex));
  const visible = keyMoments.filter(isVisible);

  const startEdit = (recordingIndex: number, text?: string) => {
    setEditing(recordingIndex);
    setDraft(text ?? '');
  };
  const commitEdit = () => {
    if (editing !== null) setKeyMomentText(editing, draft.trim());
    setEditing(null);
    setDraft('');
  };

  const atCap = keyMoments.length >= MAX_KEY_MOMENTS;

  // Renders a time as either static text (viewer) or a click-to-type field (owner).
  const renderTime = (m: (typeof keyMoments)[number], which: 'start' | 'end', seconds: number) => {
    if (!isOwner) return <>{formatDuration(seconds)}</>;
    if (editingTime?.recordingIndex === m.recordingIndex && editingTime.which === which) {
      return (
        <input
          className="km-time-input"
          autoFocus
          value={timeDraft}
          onChange={(e) => setTimeDraft(e.target.value)}
          onBlur={() => commitTime(m, which)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') setEditingTime(null);
          }}
        />
      );
    }
    return (
      <button
        type="button"
        className="km-time-btn"
        title="Click to type a time"
        onClick={() => startEditTime(m.recordingIndex, which, seconds)}
      >
        {formatDuration(seconds)}
      </button>
    );
  };

  // Viewers of an empty timeline see nothing; the owner always gets it (to start one).
  if (visible.length === 0 && !isOwner) return null;

  return (
    <Section>
      <Header>
        <span className="km-title">Key moments</span>
        {isOwner &&
          (pendingSpanStart ? (
            <span className="km-pending">
              Range starts at <b>{formatDuration(pendingSpanStart.tSeconds)}</b> — move the player to where it ends,
              then
              <button type="button" className="km-action" onClick={() => requestSnapshotMoment('spanEnd')}>
                End here
              </button>
              <button type="button" className="km-action" onClick={() => setPendingSpanStart(null)}>
                Cancel
              </button>
            </span>
          ) : (
            <>
              <button
                type="button"
                className="km-action"
                disabled={atCap}
                onClick={() => requestSnapshotMoment('keyMoment')}
              >
                <PlusOutlined /> Mark this frame
              </button>
              <button
                type="button"
                className="km-action"
                disabled={atCap}
                onClick={() => requestSnapshotMoment('spanStart')}
              >
                <PlusOutlined /> Mark a range
              </button>
            </>
          ))}
      </Header>

      {visible.length === 0 ? (
        <Empty>Pause on a telling frame and mark it — viewers can jump straight to it.</Empty>
      ) : (
        <List>
          {visible.map((m) => {
            const isSpan = m.endRecordingIndex !== undefined;
            const readingsTitle = m.readings.map((r) => `${r.label}: ${r.value.toFixed(1)}°`).join('  ') || undefined;
            const thumb = m.thumbnail || thumbs[m.recordingIndex];
            const isThisPlaying = playerPlaying && activeSpanStart === m.recordingIndex;
            return (
              <div className="km-row" key={m.recordingIndex}>
                <div className="km-media">
                  <div className="km-thumb-area">
                    <button
                      type="button"
                      className="km-jump"
                      title={isSpan ? `Jump to ${formatDuration(m.tSeconds)}` : readingsTitle}
                      onClick={() => seekToStart(m)}
                    >
                      {thumb ? <img src={thumb} alt="" className="km-thumb" /> : <span className="km-pill" />}
                    </button>
                    {isSpan && (
                      <button
                        type="button"
                        className="km-play"
                        title={isThisPlaying ? 'Pause' : 'Play range'}
                        onClick={() => togglePlaySpan(m)}
                      >
                        {isThisPlaying ? <PauseOutlined /> : <CaretRightOutlined />}
                      </button>
                    )}
                  </div>
                  <span className="km-time">
                    {renderTime(m, 'start', m.tSeconds)}
                    {isSpan && (
                      <>
                        <span>–</span>
                        {renderTime(m, 'end', m.endTSeconds ?? m.tSeconds)}
                      </>
                    )}
                  </span>
                </div>

                <div className="km-body">
                  {editing === m.recordingIndex ? (
                    <Input.TextArea
                      autoFocus
                      autoSize={{ minRows: 1, maxRows: 6 }}
                      value={draft}
                      placeholder="Describe this moment"
                      maxLength={500}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={commitEdit}
                    />
                  ) : m.text ? (
                    <div className="km-caption">
                      {m.text}
                      {isOwner && (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="km-note-btn"
                            onClick={() => startEdit(m.recordingIndex, m.text)}
                          >
                            <EditOutlined /> Edit
                          </button>
                        </>
                      )}
                    </div>
                  ) : (
                    isOwner && (
                      <button type="button" className="km-note-btn" onClick={() => startEdit(m.recordingIndex, m.text)}>
                        <PlusOutlined /> Add a note
                      </button>
                    )
                  )}

                  {/* Owner: snap the frame (or a range's two ends) to the current player frame — same
                      labelled style for a single frame and a range. */}
                  {isOwner &&
                    (isSpan ? (
                      <div className="km-setrow">
                        <button
                          type="button"
                          className="km-set"
                          title="Set the range's start to where the player is now"
                          onClick={() => requestSnapshotMoment('reanchor', m.recordingIndex)}
                        >
                          <AimOutlined /> Set start
                        </button>
                        <button
                          type="button"
                          className="km-set"
                          title="Set the range's end to where the player is now"
                          onClick={() => requestSnapshotMoment('reanchorEnd', m.recordingIndex)}
                        >
                          <AimOutlined /> Set end
                        </button>
                      </div>
                    ) : (
                      <div className="km-setrow">
                        <button
                          type="button"
                          className="km-set"
                          title="Set this key moment to where the player is now"
                          onClick={() => requestSnapshotMoment('reanchor', m.recordingIndex)}
                        >
                          <AimOutlined /> Set frame
                        </button>
                      </div>
                    ))}
                </div>

                {isOwner && (
                  <button
                    type="button"
                    className="km-remove"
                    title="Remove"
                    onClick={() => removeKeyMoment(m.recordingIndex)}
                  >
                    <CloseOutlined />
                  </button>
                )}
              </div>
            );
          })}
        </List>
      )}
    </Section>
  );
};

export default KeyMoments;
