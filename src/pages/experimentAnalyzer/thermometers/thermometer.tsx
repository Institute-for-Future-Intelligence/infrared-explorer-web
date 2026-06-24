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
const HANDLE_SIZE = 8; // px – measuring-area resize handle
const MIN_AREA_PX = 24; // px – smallest measuring area while dragging a handle

// 8 selection handles: 4 corners (resize width+height) + 4 edge midpoints (resize one axis).
// dx/dy ∈ {-1,0,1} mark the handle's position on the box edge and which dimension(s) it drives.
const HANDLES: { dx: number; dy: number; cursor: string }[] = [
  { dx: -1, dy: -1, cursor: 'nwse-resize' },
  { dx: 0, dy: -1, cursor: 'ns-resize' },
  { dx: 1, dy: -1, cursor: 'nesw-resize' },
  { dx: 1, dy: 0, cursor: 'ew-resize' },
  { dx: 1, dy: 1, cursor: 'nwse-resize' },
  { dx: 0, dy: 1, cursor: 'ns-resize' },
  { dx: -1, dy: 1, cursor: 'nesw-resize' },
  { dx: -1, dy: 0, cursor: 'ew-resize' },
];

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

  const selected = useCommonStore((state) => state.selectedThermometerId === id);
  const [hovered, setHovered] = useState(false);
  const [defaultPosition, setDefaultPosition] = useState<ControlPosition | null>(null);
  // Bumped on window resize to remount the draggable at the re-projected pixel position.
  const [remountKey, setRemountKey] = useState(0);

  // bypass warning: https://github.com/react-grid-layout/react-draggable/issues/749
  const nodeRef = React.useRef(null);

  const wrapperRef = useRef<HTMLElement | null>(null);
  // Active document listeners during a handle drag; torn down on mouseup or on unmount.
  const resizeCleanup = useRef<(() => void) | null>(null);

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

  // Tear down any in-flight handle-drag listeners if the thermometer unmounts mid-resize.
  useEffect(() => () => resizeCleanup.current?.(), []);

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

  // Drag a selection handle to resize the measuring area. The box stays centred on the
  // thermometer, so the new size = twice the cursor's distance from the centre, clamped to a
  // minimum and to the wrapper bounds, then stored as [0,1] fractions.
  const startResize = (e: React.MouseEvent, dx: number, dy: number) => {
    if (e.button !== 0) return; // ignore right/middle click so the context menu still opens
    e.stopPropagation(); // don't let react-draggable start a move
    e.preventDefault();
    useCommonStore.getState().selectThermometer(id);

    const wrapper = wrapperRef.current ?? document.getElementById('thermometers-wrapper');
    const node = nodeRef.current as HTMLElement | null;
    if (!wrapper || !node) return;
    const wrapRect = wrapper.getBoundingClientRect();
    const c = node.getBoundingClientRect(); // 1px node → its centre is the thermometer point
    const centerX = c.left + c.width / 2;
    const centerY = c.top + c.height / 2;

    const onMove = (ev: MouseEvent) => {
      const fields: Partial<Thermometer> = {};
      if (dx !== 0) {
        const wPx = Math.min(
          Math.max(2 * Math.abs(ev.clientX - centerX), MIN_AREA_PX),
          2 * Math.min(centerX - wrapRect.left, wrapRect.right - centerX),
        );
        fields.measuringAreaWidth = wPx / wrapRect.width;
      }
      if (dy !== 0) {
        const hPx = Math.min(
          Math.max(2 * Math.abs(ev.clientY - centerY), MIN_AREA_PX),
          2 * Math.min(centerY - wrapRect.top, wrapRect.bottom - centerY),
        );
        fields.measuringAreaHeight = hPx / wrapRect.height;
      }
      useCommonStore.getState().updateThermometer(id, fields);
    };

    const cleanup = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      resizeCleanup.current = null;
    };
    const onUp = () => {
      cleanup();
      onUpdate(id, x, y); // refresh the reading from the current frame at the unchanged position
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    resizeCleanup.current = cleanup;
  };

  return (
    <DraggableBox
      key={remountKey}
      nodeRef={nodeRef}
      defaultPosition={defaultPosition}
      bounds={'parent'}
      onStart={() => useCommonStore.getState().selectThermometer(id)}
      onStop={onDragStop}
    >
      <div
        ref={nodeRef}
        className="draggable-div"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        // Right-click selects this thermometer (so the context menu targets it), then keeps
        // bubbling to the player's Dropdown which opens the menu.
        onContextMenu={() => useCommonStore.getState().selectThermometer(id)}
      >
        <div style={{ position: 'relative' }}>
          {showArea && (
            <div
              style={{
                position: 'absolute',
                left: -areaW / 2,
                top: -areaH / 2,
                width: areaW,
                height: areaH,
                border: `2px dashed ${getColor()}`,
                borderRadius: measuringAreaType === MeasuringAreaType.Ellipse ? '50%' : 0,
                backgroundColor: 'rgba(204, 204, 204, 0.2)', // faint fill so the area reads against the image
                pointerEvents: 'none',
              }}
            >
              {selected &&
                HANDLES.map((h) => (
                  <div
                    key={`${h.dx},${h.dy}`}
                    onMouseDown={(e) => startResize(e, h.dx, h.dy)}
                    style={{
                      position: 'absolute',
                      width: HANDLE_SIZE,
                      height: HANDLE_SIZE,
                      left: (h.dx < 0 ? 0 : h.dx > 0 ? areaW : areaW / 2) - HANDLE_SIZE / 2,
                      top: (h.dy < 0 ? 0 : h.dy > 0 ? areaH : areaH / 2) - HANDLE_SIZE / 2,
                      background: '#fff',
                      border: '1px solid #888',
                      pointerEvents: 'auto',
                      cursor: h.cursor,
                      zIndex: 101,
                    }}
                  />
                ))}
            </div>
          )}
          <div className="thermometer-component">
            <ThermometerSVG className="thermometer-svg" style={{ fill: getColor() }} />
            <span
              className="thermometer-text"
              style={{ color: getColor() }}
            >{`T${index + 1}: ${displayTemp(value, temperatureUnit).toFixed(2)} ${temperatureSymbol(temperatureUnit)}`}</span>
          </div>
        </div>
      </div>
    </DraggableBox>
  );
};

export default Wrapper;
