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
  // clip-edit mode: the edit slider is a multi-thumb range over editedSegments (flat pairs),
  // stacked above the always-present playhead slider (telelab dual-slider layout). The Clip /
  // Add / Undo / Reset / Save triggers live on the right-side toolbar.
  editMode: boolean;
  editedSegments: number[];
  onEditRangeChange: (v: number[]) => void;
}

const ControlBar = ({
  isPlaying,
  currFrameIndex,
  lastFrameIndex,
  onClickPlayButton,
  onSlide,
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

  return (
    <div className="control-bar">
      <div className="button-wrapper" onClick={onClickPlayButton}>
        {isPlaying ? <img src={pauseButton} /> : <img src={playButton} />}
      </div>

      <span style={{ color: 'white', margin: '0 8px' }}>
        {toTime(currFrameIndex)}/{toTime(lastFrameIndex)}
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
