import { useEffect, useState } from 'react';
import { Input } from 'antd';
import { CloseOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import styled from 'styled-components';
import { Experiment, ExperimentType } from '../../../types';
import useCommonStore, { MAX_KEY_MOMENTS } from '../../../stores/common';
import { useMappingIndex } from '../hooks';
import { formatDuration } from '../../../utils/helpers';
import { fetchRecordingFrameDataUrl } from '../../../utils/recordingFrame';

// Key moments = the owner's captioned timeline. Sitting in the Info tab under the description, each entry
// is a frame (thumbnail for a recording, a labelled block for a video, which has no CORS-safe frame
// image) or a time SPAN, plus the owner's note. Anyone can click an entry to jump there — a single frame
// seeks; a span plays start→end and pauses. The owner marks the current frame ("Mark this frame") or a
// range ("Mark a range" → play to the end → "End here"), and can caption / remove each. A viewer of an
// empty timeline sees nothing; the owner always sees it so they can start one. Marking asks the
// still-mounted player to snapshot (see the store's snapshotMomentRequest purposes).
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
// A vertical timeline: a rail down the left, each entry a thumbnail + time + caption in time order.
const List = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 14px;

  .km-row {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  /* The seek / play target — thumbnail on top of the time. A button so it's keyboard-reachable. */
  .km-jump {
    appearance: none;
    border: 1px solid rgba(0, 0, 0, 0.1);
    background: var(--ifi-surface);
    padding: 0;
    width: 120px;
    flex: 0 0 auto;
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    text-align: left;
    display: block;
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease;
  }
  .km-jump:hover {
    border-color: var(--ifi-teal);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
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
  .km-time {
    display: block;
    padding: 4px 6px 5px;
    font-size: 12px;
    font-weight: 600;
    color: var(--ifi-ink);
  }
  .km-body {
    flex: 1;
    min-width: 0;
    padding-top: 2px;
  }
  .km-caption {
    font-size: 14px;
    line-height: 1.45;
    color: #262626;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  /* Owner affordances: a quiet inline "edit / add a note" and a remove button. */
  .km-note-btn {
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
  .km-note-btn:hover {
    color: var(--ifi-teal-dark);
    background: rgba(0, 0, 0, 0.04);
  }
  .km-remove {
    appearance: none;
    border: none;
    background: none;
    padding: 2px;
    color: var(--ifi-text-tertiary);
    cursor: pointer;
    flex: 0 0 auto;
  }
  .km-remove:hover {
    color: #cf1322;
  }
`;

const KeyMoments = ({ experiment }: { experiment: Experiment }) => {
  const user = useCommonStore((state) => state.user);
  const isOwner = !!user && experiment.ownerId === user.id;
  const keyMoments = useCommonStore((state) => state.keyMoments);
  const pendingSpanStart = useCommonStore((state) => state.pendingSpanStart);
  const setPendingSpanStart = useCommonStore((state) => state.setPendingSpanStart);
  const requestSnapshotMoment = useCommonStore((state) => state.requestSnapshotMoment);
  const requestKeyframeSeek = useCommonStore((state) => state.requestKeyframeSeek);
  const requestPlaySpan = useCommonStore((state) => state.requestPlaySpan);
  const removeKeyMoment = useCommonStore((state) => state.removeKeyMoment);
  const setKeyMomentText = useCommonStore((state) => state.setKeyMomentText);

  const isVideo = experiment.sourceType === ExperimentType.Video;
  const { getPlayerIndex } = useMappingIndex(experiment.segments, experiment.duration);

  // The entry currently being captioned (by recordingIndex) and its draft text.
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

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
  const activate = (m: (typeof keyMoments)[number]) => {
    if (m.endRecordingIndex !== undefined) {
      requestPlaySpan(toPlayer(m.recordingIndex), toPlayer(m.endRecordingIndex));
    } else {
      requestKeyframeSeek(toPlayer(m.recordingIndex));
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

  // Viewers of an empty timeline see nothing; the owner always gets it (to start one).
  if (visible.length === 0 && !isOwner) return null;

  return (
    <Section>
      <Header>
        <span className="km-title">Key moments</span>
        {isOwner &&
          (pendingSpanStart ? (
            <span className="km-pending">
              Marking a range from <b>{formatDuration(pendingSpanStart.tSeconds)}</b> — play to the end, then
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
            const timeLabel = isSpan
              ? `${formatDuration(m.tSeconds)} – ${formatDuration(m.endTSeconds ?? m.tSeconds)}`
              : formatDuration(m.tSeconds);
            const readingsTitle = m.readings.map((r) => `${r.label}: ${r.value.toFixed(1)}°`).join('  ') || undefined;
            const thumb = m.thumbnail || thumbs[m.recordingIndex];
            return (
              <div className="km-row" key={m.recordingIndex}>
                <button
                  type="button"
                  className="km-jump"
                  title={isSpan ? `Play ${timeLabel}` : readingsTitle}
                  onClick={() => activate(m)}
                >
                  {thumb ? <img src={thumb} alt="" className="km-thumb" /> : <span className="km-pill" />}
                  <span className="km-time">
                    {isSpan ? '▶ ' : ''}
                    {timeLabel}
                  </span>
                </button>

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
