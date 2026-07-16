import { useState } from 'react';
import { Input } from 'antd';
import { CloseOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import styled from 'styled-components';
import { Experiment, ExperimentType } from '../../../types';
import useCommonStore from '../../../stores/common';
import { useMappingIndex } from '../hooks';
import { formatDuration } from '../../../utils/helpers';

// Key moments = the owner's chapters. Sitting in the Info tab under the description, each chip is a
// frozen frame (thumbnail for a recording, a labelled pill for a video, which has no CORS-safe frame
// image) the owner marked; anyone can click one to seek the player to it. The owner marks the current
// frame with "Mark this frame" (which asks the still-mounted player to snapshot — see the store's
// snapshotMomentRequest with purpose 'keyMoment'), and can rename or remove each. A viewer of a
// chapter-less experiment sees nothing; the owner always sees the strip so they can start one.
const Section = styled.div`
  margin-top: 20px;
`;
const Header = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;

  .km-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--ifi-ink);
  }
  .km-add {
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
  .km-add:hover {
    background: rgba(0, 140, 140, 0.08);
  }
`;
const Empty = styled.p`
  margin: 0;
  font-size: 13px;
  color: var(--ifi-text-tertiary);
`;
// Horizontal, wrap-free strip: chapters read left-to-right in time order and scroll if they overflow.
const Strip = styled.div`
  display: flex;
  gap: 10px;
  overflow-x: auto;
  padding-bottom: 4px;

  .km-chip {
    position: relative;
    flex: 0 0 auto;
  }
  /* The seek target — thumbnail/pill on top, time + label under it. A button so it's keyboard-reachable. */
  .km-seek {
    appearance: none;
    border: 1px solid rgba(0, 0, 0, 0.1);
    background: var(--ifi-surface);
    padding: 0;
    width: 108px;
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    text-align: left;
    display: block;
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease;
  }
  .km-seek:hover {
    border-color: var(--ifi-teal);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  }
  .km-thumb,
  .km-pill {
    display: block;
    width: 108px;
    height: 68px;
    object-fit: cover;
  }
  /* Video chapters have no frame image — a flat teal-tinted panel stands in for the thumbnail. */
  .km-pill {
    background: linear-gradient(135deg, rgba(0, 140, 140, 0.14), rgba(0, 140, 140, 0.06));
  }
  .km-meta {
    padding: 4px 6px 6px;
  }
  .km-time {
    font-size: 12px;
    font-weight: 600;
    color: var(--ifi-ink);
  }
  .km-label {
    display: block;
    font-size: 12px;
    line-height: 1.3;
    color: var(--ifi-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Owner controls float over the top-right of the thumbnail so they don't grow the chip. */
  .km-controls {
    position: absolute;
    top: 4px;
    right: 4px;
    display: flex;
    gap: 4px;
  }
  .km-ctrl {
    appearance: none;
    border: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-size: 12px;
    cursor: pointer;
  }
  .km-ctrl:hover {
    background: rgba(0, 0, 0, 0.78);
  }
  .km-rename {
    padding: 6px;
  }
`;

const KeyMoments = ({ experiment }: { experiment: Experiment }) => {
  const user = useCommonStore((state) => state.user);
  const isOwner = !!user && experiment.ownerId === user.id;
  const keyMoments = useCommonStore((state) => state.keyMoments);
  const requestSnapshotMoment = useCommonStore((state) => state.requestSnapshotMoment);
  const requestKeyframeSeek = useCommonStore((state) => state.requestKeyframeSeek);
  const removeKeyMoment = useCommonStore((state) => state.removeKeyMoment);
  const relabelKeyMoment = useCommonStore((state) => state.relabelKeyMoment);

  const isVideo = experiment.sourceType === ExperimentType.Video;
  const { getPlayerIndex } = useMappingIndex(experiment.segments, experiment.duration);

  // The chapter currently being renamed (by recordingIndex) and its draft label.
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  // A recording moment's recordingIndex is in recording-frame space (mapped back to a player index);
  // a video moment's recordingIndex is already the .vir frame index the player seeks to (mirrors QaPanel).
  const seekTo = (recordingIndex: number) =>
    requestKeyframeSeek(isVideo ? recordingIndex : getPlayerIndex(recordingIndex));

  // Hide a chapter that a later re-trim (or a clone of a clip) left outside the kept segments — its
  // recordingIndex no longer maps to a real player frame, so seeking it would jump to the clip start.
  const segs = experiment.segments;
  const reachable = (recordingIndex: number) =>
    isVideo || !segs || segs.length === 0 || segs.some((s) => recordingIndex >= s.start && recordingIndex <= s.end);
  const visible = keyMoments.filter((m) => reachable(m.recordingIndex));

  const startRename = (recordingIndex: number, label?: string) => {
    setEditing(recordingIndex);
    setDraft(label ?? '');
  };
  const commitRename = () => {
    if (editing !== null) relabelKeyMoment(editing, draft.trim());
    setEditing(null);
    setDraft('');
  };

  // Viewers of a chapter-less experiment see nothing; the owner always gets the strip (to start one).
  if (visible.length === 0 && !isOwner) return null;

  return (
    <Section>
      <Header>
        <span className="km-title">Key moments</span>
        {isOwner && (
          <button type="button" className="km-add" onClick={() => requestSnapshotMoment('keyMoment')}>
            <PlusOutlined /> Mark this frame
          </button>
        )}
      </Header>

      {visible.length === 0 ? (
        <Empty>Pause on a telling frame and mark it — viewers can jump straight to it.</Empty>
      ) : (
        <Strip>
          {visible.map((m) => (
            <div className="km-chip" key={m.recordingIndex}>
              <button
                type="button"
                className="km-seek"
                title={m.readings.map((r) => `${r.label}: ${r.value.toFixed(1)}°`).join('  ') || undefined}
                onClick={() => seekTo(m.recordingIndex)}
              >
                {m.thumbnail ? <img src={m.thumbnail} alt="" className="km-thumb" /> : <span className="km-pill" />}
                <span className="km-meta">
                  <span className="km-time">{formatDuration(m.tSeconds)}</span>
                  {m.label && <span className="km-label">{m.label}</span>}
                </span>
              </button>

              {isOwner &&
                (editing === m.recordingIndex ? (
                  <Input
                    className="km-rename"
                    size="small"
                    autoFocus
                    value={draft}
                    placeholder="Label"
                    maxLength={60}
                    onChange={(e) => setDraft(e.target.value)}
                    onPressEnter={commitRename}
                    onBlur={commitRename}
                  />
                ) : (
                  <span className="km-controls">
                    <button
                      type="button"
                      className="km-ctrl"
                      title="Rename"
                      onClick={() => startRename(m.recordingIndex, m.label)}
                    >
                      <EditOutlined />
                    </button>
                    <button
                      type="button"
                      className="km-ctrl"
                      title="Remove"
                      onClick={() => removeKeyMoment(m.recordingIndex)}
                    >
                      <CloseOutlined />
                    </button>
                  </span>
                ))}
            </div>
          ))}
        </Strip>
      )}
    </Section>
  );
};

export default KeyMoments;
