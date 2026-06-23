import { useEffect, useRef, useState } from 'react';
import ThermometerSVG from '../../../assets/thermometer.svg?react';
import Draggable, { ControlPosition, DraggableData, DraggableEvent, DraggableProps } from 'react-draggable';
import React from 'react';

// react-draggable is a class component whose props are all flagged required under the
// resolved @types/react; cast to partial so JSX defaults apply (runtime behavior unchanged).
const DraggableBox = Draggable as unknown as React.ComponentType<Partial<DraggableProps>>;
import { MeasuringAreaType, Thermometer } from '../../../types';
import useCommonStore from '../../../stores/common';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';

const DEFAULT_AREA = 0.15; // fractional default size when switching to a measuring area

interface WrapperProps {
  id: string;
  index: number;
  onUpdate: (id: string, x: number, y: number) => void;
}

interface ComponentProps {
  index: number;
  thermometer: Thermometer;
  onUpdate: (id: string, x: number, y: number) => void;
}

const Wrapper = ({ id, index, onUpdate }: WrapperProps) => {
  const thermometer = useCommonStore((state) => state.thermometerMap.get(id));
  if (!thermometer) return null;
  return <ThermometerComponent index={index} thermometer={thermometer} onUpdate={onUpdate} />;
};

const ThermometerComponent = ({ thermometer, index, onUpdate }: ComponentProps) => {
  const {
    id,
    x,
    y,
    value = 0,
    measuringAreaType,
    measuringAreaWidth = DEFAULT_AREA,
    measuringAreaHeight = DEFAULT_AREA,
  } = thermometer;
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);

  const cycleArea = () => {
    const next =
      measuringAreaType === MeasuringAreaType.Rectangle
        ? MeasuringAreaType.Ellipse
        : measuringAreaType === MeasuringAreaType.Ellipse
          ? MeasuringAreaType.Point
          : MeasuringAreaType.Rectangle;
    useCommonStore.getState().updateThermometer(id, {
      measuringAreaType: next,
      measuringAreaWidth: measuringAreaWidth ?? DEFAULT_AREA,
      measuringAreaHeight: measuringAreaHeight ?? DEFAULT_AREA,
    });
  };

  const resizeArea = (delta: number) => {
    const clamp = (v: number) => Math.min(0.9, Math.max(0.03, v));
    useCommonStore.getState().updateThermometer(id, {
      measuringAreaWidth: clamp((measuringAreaWidth ?? DEFAULT_AREA) + delta),
      measuringAreaHeight: clamp((measuringAreaHeight ?? DEFAULT_AREA) + delta),
    });
  };

  const selected = useCommonStore((state) => state.selectedThermometerId === id);
  const [hovered, setHovered] = useState(false);
  const [defaultPosition, setDefaultPosition] = useState<ControlPosition | null>(null);
  // Bumped on window resize to remount the draggable at the re-projected pixel position.
  const [remountKey, setRemountKey] = useState(0);

  // bypass warning: https://github.com/react-grid-layout/react-draggable/issues/749
  const nodeRef = React.useRef(null);

  const wrapperRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // wait for layout finsh
    setTimeout(() => {
      wrapperRef.current = document.getElementById('thermometers-wrapper');
      if (wrapperRef.current) {
        setDefaultPosition({ x: x * wrapperRef.current.clientWidth, y: y * wrapperRef.current.clientHeight });
      }
    }, 500);
  }, []);

  // Re-project to the stored [0,1] ratio when the window resizes (so thermometers don't drift).
  useEffect(() => {
    const onResize = () => {
      const wrapper = document.getElementById('thermometers-wrapper');
      if (!wrapper) return;
      wrapperRef.current = wrapper;
      setDefaultPosition({ x: x * wrapper.clientWidth, y: y * wrapper.clientHeight });
      setRemountKey((k) => k + 1);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [x, y]);

  if (!defaultPosition) return null;

  const getColor = () => {
    if (hovered) {
      return 'rgba(0,140,140,1)';
    } else if (selected) {
      return 'yellow';
    } else {
      return 'white';
    }
  };

  const onPointerEnter = () => setHovered(true);
  const onPointerLeave = () => setHovered(false);

  const onDragStop = (e: DraggableEvent, data: DraggableData) => {
    if (wrapperRef.current) {
      const wrapper = wrapperRef.current;
      const x = data.x / wrapper.clientWidth;
      const y = data.y / wrapper.clientHeight;
      onUpdate(id, x, y);
    }
  };

  const showArea = measuringAreaType === MeasuringAreaType.Rectangle || measuringAreaType === MeasuringAreaType.Ellipse;
  const areaW = (measuringAreaWidth ?? DEFAULT_AREA) * (wrapperRef.current?.clientWidth ?? 0);
  const areaH = (measuringAreaHeight ?? DEFAULT_AREA) * (wrapperRef.current?.clientHeight ?? 0);
  const areaGlyph =
    measuringAreaType === MeasuringAreaType.Ellipse
      ? '◯'
      : measuringAreaType === MeasuringAreaType.Rectangle
        ? '▢'
        : '•';

  return (
    <DraggableBox
      key={remountKey}
      nodeRef={nodeRef}
      defaultPosition={defaultPosition}
      bounds={'parent'}
      onStart={() => useCommonStore.getState().selectThermometer(id)}
      onStop={onDragStop}
    >
      <div ref={nodeRef} className="draggable-div" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
        <div style={{ position: 'relative' }}>
          {showArea && (
            <div
              style={{
                position: 'absolute',
                left: -areaW / 2,
                top: -areaH / 2,
                width: areaW,
                height: areaH,
                border: `1px solid ${getColor()}`,
                borderRadius: measuringAreaType === MeasuringAreaType.Ellipse ? '50%' : 0,
                pointerEvents: 'none',
              }}
            />
          )}
          <div className="thermometer-component">
            <ThermometerSVG className="thermometer-svg" style={{ fill: getColor() }} />
            <span
              className="thermometer-text"
              style={{ color: getColor() }}
            >{`T${index + 1}: ${displayTemp(value, temperatureUnit).toFixed(2)} ${temperatureSymbol(temperatureUnit)}`}</span>
            <span
              title="Cycle measuring area (point / rectangle / ellipse)"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={cycleArea}
              style={{ cursor: 'pointer', color: getColor(), marginLeft: 4, fontSize: 11 }}
            >
              {areaGlyph}
            </span>
            {showArea && (
              <>
                <span
                  title="Shrink area"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => resizeArea(-0.03)}
                  style={{ cursor: 'pointer', color: getColor(), marginLeft: 4, fontSize: 11 }}
                >
                  −
                </span>
                <span
                  title="Grow area"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => resizeArea(0.03)}
                  style={{ cursor: 'pointer', color: getColor(), marginLeft: 2, fontSize: 11 }}
                >
                  ＋
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </DraggableBox>
  );
};

export default Wrapper;
