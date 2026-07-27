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
}: Props) => {
  const toTime = (n: number | undefined) => {
    if (n === undefined) return '00:00/00:00';
    const time = Math.round(n / FPS);
    const minutes = Math.floor(time / 60);
    const secondes = Math.floor(time % 60);
    return `${minutes < 10 ? 0 : ''}${minutes}:${secondes < 10 ? 0 : ''}${secondes}`;
  };

  const atStart = currFrameIndex <= 0;
  const atEnd = currFrameIndex >= lastFrameIndex;

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

      <span style={{ color: 'white', margin: '0 8px' }}>
        {toTime(currFrameIndex)}/{toTime(lastFrameIndex)}
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

        {/* PLAY slider (always): the playhead. */}
        <ConfigProvider theme={{ components: { Slider: { railBg: 'grey', railHoverBg: 'white' } } }}>
          <Slider value={currFrameIndex} max={lastFrameIndex} onChange={onSlide} tooltip={{ formatter: toTime }} />
        </ConfigProvider>
      </div>
    </div>
  );
};

export default ControlBar;
