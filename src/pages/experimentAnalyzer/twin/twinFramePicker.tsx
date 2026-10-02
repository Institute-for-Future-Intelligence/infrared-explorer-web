/**
 * The frames a recording's twin is built from when the owner picks them (docs/digital-twin-plan.md §40),
 * instead of leaving the choice to the build. The player beside the panel is the browser: the owner moves
 * it to a frame that shows the subject well and adds it here. The picked frames stand in time order — the
 * order the AI model is shown them in — as a wrapping strip of their visible photos (the picture the
 * model reads), each named by its time on the player's clock, removable, and enlarged by a click: the
 * lightbox the Q&A moments use, which pages through the picked frames, flips one between its renders and
 * jumps the player back to it. Never a sideways scroll (workspace red line).
 */
import { useEffect, useState } from 'react';
import { Button, Tooltip } from 'antd';
import { CloseOutlined, PlusOutlined } from '@ant-design/icons';
import type { Experiment } from '../../../types';
import useCommonStore from '../../../stores/common';
import { fetchRecordingFrameDataUrl } from '../../../utils/recordingFrame';
import { formatFilmTime, frameTimeSec } from '../../../utils/frameTime';
import { useMappingIndex } from '../hooks';
import MomentLightbox, { type PreviewItem } from '../infoSection/momentLightbox';
import { TWIN_FRAMES_MAX, tidyTwinFrames } from './twinModels';

/** The visible photos already fetched for a thumbnail, by recording and frame: a tab switch remounts the
 *  form, and must not fetch the strip again. Bounded: the oldest goes first. */
const THUMB_CACHE_MAX = 64;
const thumbCache = new Map<string, Promise<string>>();

function frameThumb(recordingId: string, frame: number): Promise<string> {
  const key = `${recordingId}/${frame}`;
  const hit = thumbCache.get(key);
  if (hit) return hit;
  const p = fetchRecordingFrameDataUrl(recordingId, frame, 'visible').catch((e) => {
    thumbCache.delete(key);
    throw e;
  });
  thumbCache.set(key, p);
  while (thumbCache.size > THUMB_CACHE_MAX) {
    const oldest = thumbCache.keys().next().value;
    if (oldest === undefined) break;
    thumbCache.delete(oldest);
  }
  return p;
}

interface Props {
  experiment: Experiment;
  recordingId: string;
  /** How many frames the recording has: the player's frame is offered only when it is one of them. */
  frameCount: number;
  /** The frames picked so far (stored frame numbers), in time order. */
  frames: number[];
  disabled: boolean;
  onChange: (frames: number[]) => void;
}

const TwinFramePicker = ({ experiment, recordingId, frameCount, frames, disabled, onChange }: Props) => {
  // The frame the player is on, as a stored frame number; null for no player (or a video's).
  const playerIndex = useCommonStore((state) => state.playerRecordingIndex);
  const current = playerIndex && playerIndex >= 1 && playerIndex <= frameCount ? playerIndex : null;
  // A frame is named by its time on the player's clock, never by its number: the time is what the owner
  // sees under the picture they are picking. A trimmed clip's frames map through its segments.
  const { getPlayerIndex } = useMappingIndex(experiment.segments, experiment);
  const timeOf = (frame: number) => formatFilmTime(getPlayerIndex(frame));

  // The strip's pictures, by frame: fetched once each, shown as they arrive. A frame without a visible
  // photo keeps its blank box, and the build says so.
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  useEffect(() => {
    let cancelled = false;
    for (const frame of frames) {
      frameThumb(recordingId, frame)
        .then((url) => !cancelled && setThumbs((t) => (t[frame] === url ? t : { ...t, [frame]: url })))
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [recordingId, frames]);

  // The enlarged frame: the picked frames whose picture has arrived form the group it pages through.
  const [opened, setOpened] = useState<number | null>(null);
  const pages: PreviewItem[] = frames
    .map((frame, i) => ({ frame, label: String(i + 1) }))
    .filter(({ frame }) => !!thumbs[frame])
    .map(({ frame, label }) => ({
      src: thumbs[frame],
      recordingIndex: frame,
      tSeconds: frameTimeSec(experiment, getPlayerIndex(frame)),
      label,
    }));
  const page = opened === null ? -1 : pages.findIndex((p) => p.recordingIndex === opened);
  const step = (delta: number) => {
    if (page < 0 || !pages.length) return;
    setOpened(pages[(page + delta + pages.length) % pages.length].recordingIndex);
  };

  const full = frames.length >= TWIN_FRAMES_MAX;
  const added = current !== null && frames.includes(current);
  const why =
    current === null
      ? 'Open the recording in the player to pick its frames'
      : added
        ? 'This frame is already picked — move the player to another one'
        : full
          ? `A twin is built from at most ${TWIN_FRAMES_MAX} frames — remove one to add another`
          : 'Add the frame the player is showing';
  return (
    <div className="twin-frame-picker">
      <div className="twin-frame-picker-bar">
        <Tooltip title={why}>
          {/* The span keeps the tooltip alive over a disabled button. */}
          <span>
            <Button
              size="small"
              icon={<PlusOutlined />}
              disabled={disabled || current === null || added || full}
              onClick={() => current !== null && onChange(tidyTwinFrames([...frames, current]))}
            >
              {current === null ? 'Add frame' : `Add frame at ${timeOf(current)}`}
            </Button>
          </span>
        </Tooltip>
        <span className="twin-muted">
          {frames.length} of up to {TWIN_FRAMES_MAX} picked
        </span>
      </div>
      {frames.length > 0 && (
        <div className="twin-frame-strip">
          {frames.map((frame) => {
            const at = timeOf(frame);
            const url = thumbs[frame];
            return (
              <div key={frame} className="twin-frame-thumb">
                {url ? (
                  <button
                    type="button"
                    className="twin-frame-thumb-open"
                    title="Enlarge"
                    aria-label={`Enlarge the frame at ${at}`}
                    onClick={() => setOpened(frame)}
                  >
                    <img src={url} alt={`Frame at ${at}`} />
                  </button>
                ) : (
                  <div className="twin-frame-thumb-blank" />
                )}
                <button
                  type="button"
                  className="twin-frame-thumb-remove"
                  aria-label={`Remove the frame at ${at}`}
                  title="Remove this frame"
                  disabled={disabled}
                  onClick={() => onChange(frames.filter((f) => f !== frame))}
                >
                  <CloseOutlined />
                </button>
                <div className="twin-frame-thumb-label">{at}</div>
              </div>
            );
          })}
        </div>
      )}
      {/* Kept mounted: its per-render cache and its one-shot probe for the visible / blended renders are
          meant to outlive an open and a close (momentLightbox). It opens on the visible photo, the picture
          the strip shows and the model reads. */}
      <MomentLightbox
        experiment={experiment}
        preview={page >= 0 ? { items: pages, index: page } : null}
        onStep={step}
        onClose={() => setOpened(null)}
        onSeek={(frame) => useCommonStore.getState().requestKeyframeSeek(getPlayerIndex(frame))}
        kindLabel="Frame"
        formatAt={(item) => timeOf(item.recordingIndex)}
        initialMode="visible"
      />
    </div>
  );
};

export default TwinFramePicker;
