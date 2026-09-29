import { useRef, useState } from 'react';
import dayjs from 'dayjs';
import { ConfigProvider, Slider } from 'antd';
import playButton from '../../../assets/play-button.svg';
import pauseButton from '../../../assets/pause-button.svg';
import { FPS } from '../../../utils/constants';

interface Props {
  isPlaying: boolean;
  currFrameIndex: number;
  lastFrameIndex: number;
  onClickPlayButton: () => void;
  onSlide: (n: number) => void;
  // Step one frame back (-1) or forward (+1); pauses playback and paints the neighbouring frame.
  onStep: (delta: number) => void;
  // Playback speed multiplier (0.5 / 1 / 2 / 4). The button shows the current value and cycles it.
  playbackSpeed: number;
  onCycleSpeed: () => void;
  // clip-edit mode: the edit slider is a multi-thumb range over editedSegments (flat pairs),
  // stacked above the always-present playhead slider (telelab dual-slider layout). The Clip /
  // Add / Undo / Reset / Save triggers live on the right-side toolbar.
  editMode: boolean;
  editedSegments: number[];
  onEditRangeChange: (v: number[]) => void;
  // Seconds of recording time per frame index (utils/frameTime): 1/FPS for an ordinary recording, a
  // time-lapse's interval. Only the clock readout uses it — the slider stays in frames.
  secondsPerFrame?: number;
  // Epoch ms of frame 0 when the readout may also show the time of day (a time-lapse whose start is
  // known and that was never paused — the web has no per-frame capture times, so a paused take's
  // wall clock would drift by the pause). Null hides the toggle.
  wallClockStartMs?: number | null;
}

// Inline transport glyphs (white on the dark bar) — no icon package in the project (parity with the
// toolbar's inline SVGs). A bar + triangle: "step to previous / next frame".
const StepBackSVG = () => (
  <svg viewBox="0 0 24 24" fill="#fff" width="100%" height="100%">
    <rect x="6" y="6" width="2.6" height="12" rx="0.6" />
    <path d="M18.5 6.2v11.6L10 12z" />
  </svg>
);
const StepForwardSVG = () => (
  <svg viewBox="0 0 24 24" fill="#fff" width="100%" height="100%">
    <path d="M5.5 6.2v11.6L14 12z" />
    <rect x="15.4" y="6" width="2.6" height="12" rx="0.6" />
  </svg>
);

const ControlBar = ({
  isPlaying,
  currFrameIndex,
  lastFrameIndex,
  onClickPlayButton,
  onSlide,
  onStep,
  playbackSpeed,
  onCycleSpeed,
  editMode,
  editedSegments,
  onEditRangeChange,
  secondsPerFrame = 1 / FPS,
  wallClockStartMs = null,
}: Props) => {
  // The clock's second face (scientific-viewer convention): a click on the readout shows the frame's
  // time of day, dated once the take crossed midnight; another click returns to elapsed time.
  const [wallClock, setWallClock] = useState(false);
  const canWallClock = wallClockStartMs != null;
  const toWall = (n: number) => {
    const t = dayjs((wallClockStartMs ?? 0) + n * secondsPerFrame * 1000);
    return t.format(t.isSame(dayjs(wallClockStartMs ?? 0), 'day') ? 'HH:mm:ss' : 'MMM D HH:mm:ss');
  };
  // mm:ss, with an hours field in front once a take is an hour or longer (a time-lapse).
  const toTime = (n: number | undefined) => {
    if (n === undefined) return '00:00/00:00';
    const time = Math.round(n * secondsPerFrame);
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const secondes = Math.floor(time % 60);
    const mmss = `${minutes < 10 ? 0 : ''}${minutes}:${secondes < 10 ? 0 : ''}${secondes}`;
    return hours > 0 ? `${hours}:${mmss}` : mmss;
  };

  const atStart = currFrameIndex <= 0;
  const atEnd = currFrameIndex >= lastFrameIndex;

  // Scrubber hover preview: as the mouse moves over the playhead track, show the time at that x-position
  // (video-player style), independent of antd's handle-only tooltip. hover.left is px from the track's left.
  const playSliderRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ left: number; frame: number } | null>(null);

  const onScrubHover = (e: React.MouseEvent<HTMLDivElement>) => {
    const rail = playSliderRef.current?.querySelector('.ant-slider-rail');
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover({
      left: rect.left - (playSliderRef.current?.getBoundingClientRect().left ?? 0) + ratio * rect.width,
      frame: Math.round(ratio * lastFrameIndex),
    });
  };

  return (
    <div className="control-bar">
      <span
        className={`step-button${atStart ? ' step-button-disabled' : ''}`}
        title="Previous frame (←)"
        onClick={() => !atStart && onStep(-1)}
      >
        <StepBackSVG />
      </span>

      <div className="button-wrapper" onClick={onClickPlayButton}>
        {isPlaying ? <img src={pauseButton} /> : <img src={playButton} />}
      </div>

      <span
        className={`step-button${atEnd ? ' step-button-disabled' : ''}`}
        title="Next frame (→)"
        onClick={() => !atEnd && onStep(1)}
      >
        <StepForwardSVG />
      </span>

      <span
        style={{ color: 'white', margin: '0 8px', cursor: canWallClock ? 'pointer' : undefined }}
        title={
          canWallClock
            ? wallClock
              ? 'Time of day — click for elapsed time'
              : 'Elapsed time — click for time of day'
            : undefined
        }
        onClick={() => canWallClock && setWallClock((w) => !w)}
      >
        {canWallClock && wallClock ? toWall(currFrameIndex) : `${toTime(currFrameIndex)}/${toTime(lastFrameIndex)}`}
      </span>

      <span className="speed-button" title="Playback speed" onClick={onCycleSpeed}>
        {playbackSpeed % 1 === 0 ? playbackSpeed : playbackSpeed.toString()}×
      </span>

      <div className="slider-stack">
        {editMode && (
          // EDIT slider (top): two-thumb range per kept pair; blue track = kept, grey rail = gap/outside.
          <ConfigProvider
            theme={{
              components: {
                Slider: { trackBg: '#0059b3', trackHoverBg: '#0059b3', railBg: '#595959', railHoverBg: '#595959' },
              },
            }}
          >
            <Slider
              range
              className="edit-slider"
              value={editedSegments}
              max={lastFrameIndex}
              onChange={(v) => onEditRangeChange(v as number[])}
              tooltip={{ formatter: toTime }}
            />
          </ConfigProvider>
        )}

        {/* PLAY slider (always): the playhead. The wrapper tracks mouse-x to show a scrubber time preview. */}
        <div
          className="play-slider-wrapper"
          ref={playSliderRef}
          onMouseMove={onScrubHover}
          onMouseLeave={() => setHover(null)}
        >
          {hover && (
            <span className="scrub-preview" style={{ left: hover.left }}>
              {toTime(hover.frame)}
            </span>
          )}
          <ConfigProvider theme={{ components: { Slider: { railBg: 'grey', railHoverBg: 'white' } } }}>
            <Slider value={currFrameIndex} max={lastFrameIndex} onChange={onSlide} tooltip={{ formatter: toTime }} />
          </ConfigProvider>
        </div>
      </div>
    </div>
  );
};

export default ControlBar;
