import styled from 'styled-components';
import { Annotation, MeasuringAreaType, TemperatureUnit } from '../../../types';
import { PRESET_COLORS } from '../../../utils/constants';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';
import { FrameProbeReading } from './useFrameReadings';

/**
 * The probes and notes of an experiment, drawn over a still of one of its frames.
 *
 * A report figure is a picture of an INSTANT the report is arguing about, so it has to show what the
 * argument refers to: the probes it cites by name, reading what they read at that instant, and the notes
 * left on the scene. Without them a figure is a coloured rectangle the reader has to take on trust.
 *
 * Positions are percentages of the frame, so the same markup works at thumbnail and lightbox size — the
 * host only has to be `position: relative` and the same aspect as the image. `compact` drops the text
 * (a 150px-wide figure has no room for it) and keeps the dots, which still show WHERE each probe sits;
 * the readings themselves go in the figure's caption at that size.
 */

const Layer = styled.div`
  position: absolute;
  inset: 0;
  pointer-events: none;
  /* Above the image, below anything the host puts on top (a loading spinner). */
  z-index: 1;

  .fo-probe,
  .fo-note {
    position: absolute;
    transform: translate(-50%, -50%);
    display: flex;
    align-items: center;
    gap: 3px;
    white-space: nowrap;
  }
  /* The dot itself: the probe's series colour (as on the player and in the charts), ringed in white so
     it stays visible on any part of the palette. */
  .fo-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.95);
    flex: none;
  }
  .fo-label {
    font-size: 10px;
    line-height: 1.35;
    padding: 0 4px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.62);
    color: #fff;
    font-variant-numeric: tabular-nums;
  }
  /* A measuring-area probe reads the average over its box, so the box is drawn: a reading attributed to
     a point the probe does not actually measure would misrepresent it. */
  .fo-area {
    position: absolute;
    transform: translate(-50%, -50%);
    border: 1px solid rgba(255, 255, 255, 0.9);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
  }
  .fo-note .fo-pin {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #ffc53d;
    box-shadow: 0 0 0 1.5px rgba(0, 0, 0, 0.45);
    flex: none;
  }
  /* A note can be a sentence; cap it so one long note cannot cover the frame. */
  .fo-note .fo-label {
    max-width: 42%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
`;

interface Props {
  probes: FrameProbeReading[];
  annotations: Annotation[];
  unit: TemperatureUnit;
  /** Thumbnail size: dots only, no text. */
  compact?: boolean;
}

const FrameOverlay = ({ probes, annotations, unit, compact = false }: Props) => (
  <Layer>
    {probes.map((p) => {
      const area =
        p.measuringAreaType === MeasuringAreaType.Rectangle || p.measuringAreaType === MeasuringAreaType.Ellipse;
      return (
        <span key={p.id}>
          {area && (
            <span
              className="fo-area"
              style={{
                left: `${p.x * 100}%`,
                top: `${p.y * 100}%`,
                width: `${(p.measuringAreaWidth ?? 0) * 100}%`,
                height: `${(p.measuringAreaHeight ?? 0) * 100}%`,
                borderRadius: p.measuringAreaType === MeasuringAreaType.Ellipse ? '50%' : 0,
              }}
            />
          )}
          <span
            className="fo-probe"
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            title={`${p.label}${p.value != null ? `: ${displayTemp(p.value, unit).toFixed(1)} ${temperatureSymbol(unit)}` : ''}`}
          >
            <span className="fo-dot" style={{ background: PRESET_COLORS[p.index % PRESET_COLORS.length] }} />
            {!compact && (
              <span className="fo-label">
                {p.aiPlaced ? '✨ ' : ''}
                {p.label}
                {p.value != null ? ` ${displayTemp(p.value, unit).toFixed(1)} ${temperatureSymbol(unit)}` : ''}
              </span>
            )}
          </span>
        </span>
      );
    })}
    {annotations.map((a) => (
      <span key={a.id} className="fo-note" style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }} title={a.note}>
        <span className="fo-pin" />
        {!compact && <span className="fo-label">{a.note}</span>}
      </span>
    ))}
  </Layer>
);

export default FrameOverlay;
