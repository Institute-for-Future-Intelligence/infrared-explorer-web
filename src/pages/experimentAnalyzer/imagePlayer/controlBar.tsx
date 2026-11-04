import { useEffect, useRef, useState } from 'react';
import { ConfigProvider, Slider } from 'antd';
import dayjs from 'dayjs';
import playButton from '../../../assets/play-button.svg';
import pauseButton from '../../../assets/pause-button.svg';
import { FPS } from '../../../utils/constants';
import { formatTransportTime, nextTransportClock, TransportClock } from '../../../utils/frameTime';
import useCommonStore from '../../../stores/common';

/**
 * A time-lapse's other clocks, offered by a click on the readout (docs/time-lapse-experiments.md). Absent
 * on an ordinary recording, whose film time IS its real time: the readout then stays put.
 */
export interface TimelapseClocks {
  /** Seconds of recording time between consecutive frames (the take's interval). */
  secondsPerFrame: number;
  /** Epoch ms a PLAYER index was taken (through the clip mapping and the take's pauses); absent when the start is unknown. */
  captureTimeOf?: (playerIndex: number) => number | null;
}

const CLOCK_TAG: Record<TransportClock, string> = { film: 'film', recording: 'real', capture: 'clock' };
const CLOCK_NAME: Record<TransportClock, string> = {
  film: 'Film time (frames at 5 fps)',
  recording: 'Real elapsed time of the take',
  capture: 'Time of day each frame was taken',
};

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
  // A time-lapse: the readout is a button that switches the bar's clock (film / real / time of day).
  timelapseClocks?: TimelapseClocks;
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
  timelapseClocks,
}: Props) => {
  // The bar's clock — the readout, the scrub preview and the slider tooltips all count in it. Every
  // recording opens on the FILM's time (frames at FPS), so scrubbing a 24 h take feels like any other
  // clip; a time-lapse can be switched by clicking the readout to its REAL elapsed time (frames an
  // interval apart) or, when the take's start is known, the frames' TIME OF DAY — the same answer as the
  // toolbar's capture-time overlay, here on the slider so one can scrub to "3 pm". An ordinary recording
  // has only the one clock (its film time is its real time), so its readout isn't a button. The choice is
  // this browser's, held in the store (transportClock, backed by viewerPrefs) because the T(t) chart's
  // axis follows it onto the time of day; key moments stay in recording seconds
  // (docs/time-lapse-experiments.md).
  const captureAvailable = !!timelapseClocks?.captureTimeOf;
  const clockPref = useCommonStore((state) => state.transportClock);
  const setTransportClock = useCommonStore((state) => state.setTransportClock);
  // A kept 'capture' on a take without a start reads as 'recording' here, and stays kept for the next take.
  const clock: TransportClock = !timelapseClocks
    ? 'film'
    : clockPref === 'capture' && !captureAvailable
      ? 'recording'
      : clockPref;
  const cycleClock = () => {
    if (!timelapseClocks) return;
    setTransportClock(nextTransportClock(clock, captureAvailable));
  };
  // The label of a player index on the current clock. A frame with no capture time (the mapping's
  // out-of-clip fallback) falls back to its real elapsed time rather than a blank.
  const toTime = (n: number | undefined) => {
    const i = n ?? 0;
    if (clock === 'film') return formatTransportTime(i / FPS);
    if (clock === 'capture') {
      const ms = timelapseClocks?.captureTimeOf?.(i);
      if (ms != null) return dayjs(ms).format('HH:mm:ss');
    }
    return formatTransportTime(i * (timelapseClocks?.secondsPerFrame ?? 1 / FPS));
  };

  // Where the bar was just moved to, until the player catches up. The player renders only when a frame's
  // picture goes up — in the Δ view not before its data too — and until then the controlled slider would
  // snap back to the old spot the moment the mouse let go. `from` is the playhead the move started from:
  // once the player renders a different one, that's the newer word (and the effect drops the move).
  const [seek, setSeek] = useState<{ to: number; from: number } | null>(null);
  useEffect(() => setSeek(null), [currFrameIndex]);
  const shownIndex = seek && seek.from === currFrameIndex ? seek.to : currFrameIndex;
  // The readout's tooltip: what it counts in and, on a time-lapse, that a click turns it. On the time of
  // day, the shown frame's date too — a take can run past midnight.
  const readoutTitle = (() => {
    if (!timelapseClocks) return CLOCK_NAME.film;
    const ms = clock === 'capture' ? timelapseClocks.captureTimeOf?.(shownIndex) : null;
    const date = ms != null ? ` — ${dayjs(ms).format('MMM D, YYYY')}` : '';
    return `${CLOCK_NAME[clock]}${date}. Click for: ${CLOCK_NAME[
      nextTransportClock(clock, captureAvailable)
    ].toLowerCase()}`;
  })();
  const slide = (n: number) => {
    setSeek({ to: n, from: currFrameIndex });
    onSlide(n);
  };

  const atStart = shownIndex <= 0;
  const atEnd = shownIndex >= lastFrameIndex;

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

      {timelapseClocks ? (
        <button
          type="button"
          className="time-readout time-readout-switch"
          title={readoutTitle}
          aria-label={`${toTime(shownIndex)} of ${toTime(lastFrameIndex)}, ${CLOCK_NAME[clock]}. Switch clock`}
          onClick={cycleClock}
        >
          {`${toTime(shownIndex)}/${toTime(lastFrameIndex)}`}
          <span className="time-readout-tag">{CLOCK_TAG[clock]}</span>
        </button>
      ) : (
        <span className="time-readout" title={readoutTitle}>
          {`${toTime(shownIndex)}/${toTime(lastFrameIndex)}`}
        </span>
      )}

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
            <Slider value={shownIndex} max={lastFrameIndex} onChange={slide} tooltip={{ formatter: toTime }} />
          </ConfigProvider>
        </div>
      </div>
    </div>
  );
};

export default ControlBar;
