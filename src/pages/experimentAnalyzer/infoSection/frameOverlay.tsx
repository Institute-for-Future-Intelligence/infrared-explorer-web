import { useEffect, useRef, useState } from 'react';
import { Tooltip } from 'antd';
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
 * Positions are percentages of the frame, so the same markup works at thumbnail and lightbox size. The
 * layer measures the <img> beside it rather than trusting its own box to match: a container is sized by
 * CSS rules that do not always land on the image's rendered box — a percentage width inside a
 * shrink-to-fit box, or a `max-height` that scales a portrait frame down without narrowing its
 * container — and a layer even a few pixels wider than the picture puts every marker in the wrong place.
 * Drop it next to an <img> inside a positioned box and it lines up.
 *
 * `compact` drops the text (a 150px-wide figure has no room for it) and keeps the dots, which still show
 * WHERE each probe sits; the readings themselves go in the figure's caption at that size.
 */

const Layer = styled.div`
  position: absolute;
  inset: 0;
  /* The LAYER ignores the mouse so the picture underneath stays clickable (a figure opens the lightbox);
     the markers opt back in below, so hovering one can name it. A click on a marker still bubbles to the
     picture's own handler. */
  pointer-events: none;
  /* Above the image, below anything the host puts on top (a loading spinner). */
  z-index: 1;

  /* A marker IS its point: a zero-size box at the probe's coordinates, with the dot centred on it and
     the label hung beside it. Centring a box that CONTAINS the label instead puts the dot half a label's
     width to the LEFT of the thing it marks — invisible while the labels are hidden (the thumbnail) and
     an obvious offset the moment they appear (the lightbox). */
  .fo-probe,
  .fo-note {
    position: absolute;
    width: 0;
    height: 0;
  }
  .fo-dot,
  .fo-pin {
    position: absolute;
    left: 0;
    top: 0;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    transition: transform 0.12s ease;
    pointer-events: auto;
    cursor: help;
  }
  /* A dot is a small target: growing it on hover confirms which one the tooltip is describing. */
  .fo-probe:hover .fo-dot,
  .fo-note:hover .fo-pin {
    transform: translate(-50%, -50%) scale(1.45);
  }
  /* The probe's series colour (as on the player and in the charts), ringed in white so it stays visible
     on any part of the palette. */
  .fo-dot {
    box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.95);
  }
  /* Hung to the right of the dot and centred on its line, so the dot alone carries the position. */
  .fo-label {
    position: absolute;
    left: 8px;
    top: 0;
    transform: translateY(-50%);
    font-size: 10px;
    line-height: 1.35;
    padding: 0 4px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.62);
    color: #fff;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    pointer-events: auto;
    cursor: help;
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
    background: #ffc53d;
    box-shadow: 0 0 0 1.5px rgba(0, 0, 0, 0.45);
  }
  /* A note can be a sentence; cap it so one long note cannot cover the frame. */
  .fo-note .fo-label {
    max-width: 140px;
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

const FrameOverlay = ({ probes, annotations, unit, compact = false }: Props) => {
  // The image's box within the positioned ancestor this layer fills. null until measured (and whenever
  // there is no image to measure), where the layer falls back to its own box.
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useEffect(() => {
    const layer = ref.current;
    const host = layer?.offsetParent as HTMLElement | null;
    const img = host?.querySelector('img');
    if (!layer || !host || !img) return;
    const measure = () => {
      const next =
        img.clientWidth > 0 && img.clientHeight > 0
          ? { left: img.offsetLeft, top: img.offsetTop, width: img.clientWidth, height: img.clientHeight }
          : null;
      // Bail on an unchanged box. measure() builds a fresh object every call, so handing it to setBox
      // unconditionally would re-render on every observer callback — and the observer fires during
      // layout, which is exactly where a render loop would be most expensive.
      setBox((prev) =>
        prev === next ||
        (prev &&
          next &&
          prev.left === next.left &&
          prev.top === next.top &&
          prev.width === next.width &&
          prev.height === next.height)
          ? prev
          : next,
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    // The image resizes on load, on a viewport change, and when the lightbox pages to a frame of another
    // shape; the host is observed too, since a re-layout can move the image without resizing it.
    const ro = new ResizeObserver(measure);
    ro.observe(img);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  return (
    <Layer ref={ref} style={box ? { inset: 'auto', ...box } : undefined}>
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
            <Tooltip
              mouseEnterDelay={0}
              title={
                <span style={{ fontSize: 12 }}>
                  <b>
                    {p.aiPlaced ? '✨ ' : ''}
                    {p.label}
                  </b>
                  {p.value != null
                    ? ` — ${displayTemp(p.value, unit).toFixed(2)} ${temperatureSymbol(unit)}`
                    : ' — no reading for this frame'}
                  {p.aiPlaced && (
                    <>
                      <br />
                      Placed by the analysis, not part of the setup.
                    </>
                  )}
                </span>
              }
            >
              <span className="fo-probe" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>
                <span className="fo-dot" style={{ background: PRESET_COLORS[p.index % PRESET_COLORS.length] }} />
                {!compact && (
                  <span className="fo-label">
                    {p.aiPlaced ? '✨ ' : ''}
                    {p.label}
                    {p.value != null ? ` ${displayTemp(p.value, unit).toFixed(1)} ${temperatureSymbol(unit)}` : ''}
                  </span>
                )}
              </span>
            </Tooltip>
          </span>
        );
      })}
      {annotations.map((a) => (
        <Tooltip
          key={a.id}
          mouseEnterDelay={0}
          title={
            <span style={{ fontSize: 12 }}>
              {a.note}
              {a.time && (
                <>
                  <br />
                  Shown from {Math.round(a.time.start)} s to {Math.round(a.time.end)} s.
                </>
              )}
            </span>
          }
        >
          <span className="fo-note" style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }}>
            <span className="fo-pin" />
            {!compact && <span className="fo-label">{a.note}</span>}
          </span>
        </Tooltip>
      ))}
    </Layer>
  );
};

export default FrameOverlay;
