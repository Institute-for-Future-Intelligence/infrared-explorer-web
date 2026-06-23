import { Button } from 'antd';

interface Props {
  trimMode: boolean;
  onToggle: () => void;
  currentFrame: number;
  markStart: number | null;
  markEnd: number | null;
  onSetStart: () => void;
  onSetEnd: () => void;
  onSave: () => void;
  saving: boolean;
  canSave: boolean;
}

/** Single-segment trim controls: mark a start and end frame, then save a new clip (refs only). */
const TrimBar = ({
  trimMode,
  onToggle,
  currentFrame,
  markStart,
  markEnd,
  onSetStart,
  onSetEnd,
  onSave,
  saving,
  canSave,
}: Props) => {
  return (
    <div
      className="trim-bar"
      style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', color: 'white' }}
    >
      <Button size="small" type={trimMode ? 'primary' : 'default'} onClick={onToggle}>
        {trimMode ? 'Trimming…' : 'Trim'}
      </Button>
      {trimMode && (
        <>
          <Button size="small" onClick={onSetStart}>
            Set start
          </Button>
          <Button size="small" onClick={onSetEnd}>
            Set end
          </Button>
          <span style={{ fontSize: 12 }}>
            start: {markStart ?? '—'} · end: {markEnd ?? '—'} · now: {currentFrame}
          </span>
          <Button size="small" type="primary" loading={saving} disabled={!canSave} onClick={onSave}>
            Save as clip
          </Button>
        </>
      )}
    </div>
  );
};

export default TrimBar;
