import { ConfigProvider, Slider } from 'antd';
import playButton from '../../../assets/play-button.svg';
import pauseButton from '../../../assets/pause-button.svg';

interface Props {
  isPlaying: boolean;
  currFrameIndex: number;
  lastFrameIndex: number;
  onClickPlayButton: () => void;
  onSlide: (n: number) => void;
  // clip-edit mode: the playhead slider becomes a two-thumb range selector.
  // The Clip / Save triggers live on the right-side toolbar (telelab-style).
  editMode: boolean;
  editRange: [number, number];
  onEditRangeChange: (range: [number, number]) => void;
}

const ControlBar = ({
  isPlaying,
  currFrameIndex,
  lastFrameIndex,
  onClickPlayButton,
  onSlide,
  editMode,
  editRange,
  onEditRangeChange,
}: Props) => {
  const toTime = (n: number | undefined) => {
    if (n === undefined) return '00:00/00:00';
    const time = Math.round(n * 0.2);
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
      <ConfigProvider
        theme={{
          components: {
            Slider: {
              railBg: 'grey',
              railHoverBg: 'white',
            },
          },
        }}
      >
        {editMode ? (
          <Slider
            range
            className="slider"
            value={editRange}
            max={lastFrameIndex}
            onChange={(v) => onEditRangeChange(v as [number, number])}
            tooltip={{ formatter: toTime }}
          />
        ) : (
          <Slider
            className="slider"
            value={currFrameIndex}
            max={lastFrameIndex}
            onChange={onSlide}
            tooltip={{ formatter: toTime }}
          />
        )}
      </ConfigProvider>
    </div>
  );
};

export default ControlBar;
