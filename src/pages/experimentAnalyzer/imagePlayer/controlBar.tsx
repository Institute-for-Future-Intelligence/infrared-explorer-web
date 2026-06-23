import { Button, ConfigProvider, Slider } from 'antd';
import playButton from '../../../assets/play-button.svg';
import pauseButton from '../../../assets/pause-button.svg';

interface Props {
  isPlaying: boolean;
  currFrameIndex: number;
  lastFrameIndex: number;
  onClickPlayButton: () => void;
  onSlide: (n: number) => void;
  // clip / trim
  canTrim?: boolean;
  editMode: boolean;
  onToggleEdit: () => void;
  editRange: [number, number];
  onEditRangeChange: (range: [number, number]) => void;
  onSaveClip: () => void;
  savingClip: boolean;
}

const ControlBar = ({
  isPlaying,
  currFrameIndex,
  lastFrameIndex,
  onClickPlayButton,
  onSlide,
  canTrim,
  editMode,
  onToggleEdit,
  editRange,
  onEditRangeChange,
  onSaveClip,
  savingClip,
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
          // clip-edit mode: a two-thumb range selects the segment to save (telelab-style clipper)
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

      {canTrim && (
        <div style={{ display: 'flex', gap: 8, marginLeft: 8 }}>
          {editMode && (
            <Button size="small" type="primary" loading={savingClip} onClick={onSaveClip}>
              Save clip
            </Button>
          )}
          <Button size="small" onClick={onToggleEdit}>
            {editMode ? 'Cancel' : 'Clip'}
          </Button>
        </div>
      )}
    </div>
  );
};

export default ControlBar;
