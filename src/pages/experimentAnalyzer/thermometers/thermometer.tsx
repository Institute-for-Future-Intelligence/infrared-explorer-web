import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Draggable, { DraggableData, DraggableEvent, DraggableProps } from 'react-draggable';
import React from 'react';

// react-draggable is a class component whose props are all flagged required under the
// resolved @types/react; cast to partial so JSX defaults apply (runtime behavior unchanged).
const DraggableBox = Draggable as unknown as React.ComponentType<Partial<DraggableProps>>;
import { MeasuringAreaType, Thermometer } from '../../../types';
import useCommonStore from '../../../stores/common';
import { displayTemp, displayTempDelta, temperatureSymbol } from '../../../utils/helpers';
import { getThermometerValue } from '../../../utils/temperatureReader';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { PRESET_COLORS } from '../../../utils/constants';

const DEFAULT_AREA = 0.15; // fractional default size when switching to a measuring area
const HANDLE_SIZE = 8; // px – measuring-area resize handle
const MIN_AREA_PX = 24; // px – smallest measuring area while dragging a handle

// 8 selection handles: 4 corners (resize width+height) + 4 edge midpoints (resize one axis).
// dx/dy ∈ {-1,0,1} mark the handle's position on the box edge and which dimension(s) it drives.
// Thermometer glyph (28×36 viewBox): the capsule tube + bulb merged into ONE silhouette path — a
// single path, not stacked tube/bulb shapes, so the double-stroke outline shows no seam where they
// would intersect. The bulb centre (14, 26.5) is the probe's measured point (see the -22px anchor
// shift in App.css). Junction maths: tube half-width 2.6 meets the r=4.6 bulb at y = 26.5 − √(4.6² − 2.6²).
const GLYPH_BULB = { cx: 14, cy: 26.5, r: 4.6 };
const GLYPH_PATH = 'M 11.4 6 A 2.6 2.6 0 0 1 16.6 6 L 16.6 22.71 A 4.6 4.6 0 1 1 11.4 22.71 Z';

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
  // Δ frame-difference mode: when on, the label reads Δ<name> and the value shows this probe's reading
  // minus its reading on the reference frame (refBuffer). Off → the usual absolute temperature.
  showDiff?: boolean;
  refBuffer?: ArrayBuffer;
}

interface ComponentProps {
  index: number;
  thermometer: Thermometer;
  onUpdate: (id: string, x: number, y: number) => void;
  showDiff?: boolean;
  refBuffer?: ArrayBuffer;
}

const Wrapper = ({ id, index, onUpdate, showDiff, refBuffer }: WrapperProps) => {
  const thermometer = useCommonStore((state) => state.thermometerMap.get(id));
  if (!thermometer) return null;
  return (
    <ThermometerComponent
      index={index}
      thermometer={thermometer}
      onUpdate={onUpdate}
      showDiff={showDiff}
      refBuffer={refBuffer}
    />
  );
};

const ThermometerComponent = ({ thermometer, index, onUpdate, showDiff, refBuffer }: ComponentProps) => {
  const {
    id,
    name,
    x,
    y,
    value = 0,
    measuringAreaType,
    measuringAreaWidth = DEFAULT_AREA,
    measuringAreaHeight = DEFAULT_AREA,
  } = thermometer;
  // User-given name, or the positional default "T1", "T2", … shared with the line chart.
  const label = name?.trim() || `T${index + 1}`;
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);

  // Δ mode: read this probe on the reference frame and show (current − reference). getThermometerValue
  // decodes off the cached frame (cheap), returns Celsius. Falls back to the absolute reading until the
  // reference frame's buffer is available. `diffActive` gates the Δ prefix + delta formatting.
  let refValueC: number | null = null;
  if (showDiff && refBuffer) {
    try {
      refValueC = getThermometerValue(refBuffer, thermometer);
    } catch {
      refValueC = null;
    }
  }
  const diffActive = refValueC !== null;
  const displayLabel = diffActive ? `Δ${label}` : label;
  const shownValue = diffActive
    ? displayTempDelta(value - (refValueC as number), temperatureUnit)
    : displayTemp(value, temperatureUnit);
  const sign = diffActive && shownValue > 0 ? '+' : '';
  // Bigger resize handles on touch so the measuring-area corners/edges are grabbable with a finger.
  const isMobile = useIsMobile();
  const handleSize = isMobile ? 20 : HANDLE_SIZE;

  const selected = useCommonStore((state) => state.selectedThermometerId === id);
  // Shared hover state (also dims the other series in the charts), not just this icon's colour.
  const hovered = useCommonStore((state) => state.hoveredThermometerId === id);
  // Live pixel size of #thermometers-wrapper, kept current by a ResizeObserver. Drives both the px
  // projection of the probe's [0,1] coords and the measuring-area box. The observer fires once the
  // wrapper first has a box and again on every size change (image load, window resize, chart/rail
  // toggles, clip-aspect switches), so we never guess with a fixed delay and the probe can't drift
  // off-frame — replacing the old 500ms timer + window-resize-only re-projection + remount hack.
  const [wrapperSize, setWrapperSize] = useState<{ w: number; h: number } | null>(null);

  // bypass warning: https://github.com/react-grid-layout/react-draggable/issues/749
  const nodeRef = React.useRef(null);

  const wrapperRef = useRef<HTMLElement | null>(null);
  // Active document listeners during a handle drag; torn down on mouseup or on unmount.
  const resizeCleanup = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const wrapper = document.getElementById('thermometers-wrapper');
    if (!wrapper) return;
    wrapperRef.current = wrapper;
    const measure = () => setWrapperSize({ w: wrapper.clientWidth, h: wrapper.clientHeight });
    measure(); // synchronous first read; the observer re-fires the moment the image lays out
    const ro = new ResizeObserver(measure);
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, []);

  // Tear down any in-flight handle-drag listeners if the thermometer unmounts mid-resize.
  useEffect(() => () => resizeCleanup.current?.(), []);

  if (!wrapperSize || wrapperSize.w === 0) return null;
  // Controlled position: react-draggable re-renders here whenever wrapperSize changes (no remount). It
  // uses its own drag state while dragging and snaps back to this on stop, where onDragStop has just
  // written the new fraction to the store — so `position` recomputes to the same spot and there's no jump.
  const position = { x: x * wrapperSize.w, y: y * wrapperSize.h };

  // State accent for the glyph outline + measuring-area border: hover teal (--ifi-teal-dk) wins over
  // the selected amber. Concrete values, not var()/CSS classes: html2canvas rasterizes the inline SVG
  // standalone, so the colour is safest resolved from the svg's own inline style in exports.
  const accent = hovered ? '#1fb6a6' : selected ? '#ffc53d' : '#ffffff';
  // Mercury colour = this probe's series colour in the T(t)/T(x)/T(y) charts (see chartColorKey).
  const seriesColor = PRESET_COLORS[index % PRESET_COLORS.length];

  const onPointerEnter = () => useCommonStore.getState().hoverThermometer(id);
  const onPointerLeave = () => useCommonStore.getState().hoverThermometer(null);

  const onDragStop = (e: DraggableEvent, data: DraggableData) => {
    if (wrapperRef.current) {
      const wrapper = wrapperRef.current;
      const x = data.x / wrapper.clientWidth;
      const y = data.y / wrapper.clientHeight;
      onUpdate(id, x, y);
    }
  };

  const showArea = measuringAreaType === MeasuringAreaType.Rectangle || measuringAreaType === MeasuringAreaType.Ellipse;
  const areaW = (measuringAreaWidth ?? DEFAULT_AREA) * wrapperSize.w;
  const areaH = (measuringAreaHeight ?? DEFAULT_AREA) * wrapperSize.h;

  // Drag a selection handle to resize the measuring area. The box stays centred on the
  // thermometer, so the new size = twice the cursor's distance from the centre, clamped to a
  // minimum and to the wrapper bounds, then stored as [0,1] fractions. Works for both mouse and
  // touch (the handles are grabbable with a finger on phones).
  const startResize = (e: React.MouseEvent | React.TouchEvent, dx: number, dy: number) => {
    const isTouch = 'touches' in e;
    if (!isTouch && (e as React.MouseEvent).button !== 0) return; // ignore right/middle click so the menu still opens
    e.stopPropagation(); // don't let react-draggable start a mouse move (the `cancel` prop covers touch)
    // On touch, preventDefault is a no-op here (React's touchstart listener is passive) and would warn;
    // scroll suppression on touch comes from touch-action:none + the non-passive touchmove listener below.
    if (!isTouch) e.preventDefault();
    useCommonStore.getState().selectThermometer(id);

    const wrapper = wrapperRef.current ?? document.getElementById('thermometers-wrapper');
    const node = nodeRef.current as HTMLElement | null;
    if (!wrapper || !node) return;

    // Re-read the wrapper + node rects on EVERY move (not once at drag start): the analyzer page now
    // scrolls, so a wheel mid-resize would otherwise compare live cursor coords against stale rects and
    // jump the measuring area. (Mirrors annotations.tsx's per-move getBoundingClientRect.)
    const apply = (clientX: number, clientY: number) => {
      const wrapRect = wrapper.getBoundingClientRect();
      const c = node.getBoundingClientRect(); // 1px node → its centre is the thermometer point
      const centerX = c.left + c.width / 2;
      const centerY = c.top + c.height / 2;
      const fields: Partial<Thermometer> = {};
      if (dx !== 0) {
        const wPx = Math.min(
          Math.max(2 * Math.abs(clientX - centerX), MIN_AREA_PX),
          2 * Math.min(centerX - wrapRect.left, wrapRect.right - centerX),
        );
        fields.measuringAreaWidth = wPx / wrapRect.width;
      }
      if (dy !== 0) {
        const hPx = Math.min(
          Math.max(2 * Math.abs(clientY - centerY), MIN_AREA_PX),
          2 * Math.min(centerY - wrapRect.top, wrapRect.bottom - centerY),
        );
        fields.measuringAreaHeight = hPx / wrapRect.height;
      }
      useCommonStore.getState().updateThermometer(id, fields);
    };

    const onMouseMove = (ev: MouseEvent) => apply(ev.clientX, ev.clientY);
    const onTouchMove = (ev: TouchEvent) => {
      if (!ev.touches[0]) return;
      ev.preventDefault(); // stop the page from scrolling while resizing
      apply(ev.touches[0].clientX, ev.touches[0].clientY);
    };

    const cleanup = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onUp);
      document.removeEventListener('touchcancel', onUp);
      resizeCleanup.current = null;
    };
    const onUp = () => {
      cleanup();
      onUpdate(id, x, y); // refresh the reading from the current frame at the unchanged position
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onUp);
    document.addEventListener('touchcancel', onUp);
    resizeCleanup.current = cleanup;
  };

  return (
    <DraggableBox
      nodeRef={nodeRef}
      position={position}
      bounds={'parent'}
      // Don't start a whole-thermometer drag when the gesture begins on a resize handle. This is the
      // only thing that stops it on touch: react-draggable binds its touchstart listener natively in
      // the capture phase, so a handle's synthetic stopPropagation can't reach it — `cancel` (checked
      // inside react-draggable for both mouse and touch) is what makes it bail.
      cancel=".resize-handle"
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
                border: `1.5px dashed ${accent}`,
                // Square corners on purpose: rawAreaAverageCelsius samples the full square grid
                // (only the ellipse is shape-masked), so rounding the drawn corners would exclude
                // pixels visually that the average still includes.
                borderRadius: measuringAreaType === MeasuringAreaType.Ellipse ? '50%' : 0,
                backgroundColor: 'rgba(255, 255, 255, 0.1)', // faint fill so the area reads against the image
                boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.28)', // dark rim so the white dashes read on bright areas
                pointerEvents: 'none',
              }}
            >
              {selected &&
                HANDLES.map((h) => (
                  <div
                    key={`${h.dx},${h.dy}`}
                    className="resize-handle"
                    onMouseDown={(e) => startResize(e, h.dx, h.dy)}
                    onTouchStart={(e) => startResize(e, h.dx, h.dy)}
                    style={{
                      position: 'absolute',
                      width: handleSize,
                      height: handleSize,
                      left: (h.dx < 0 ? 0 : h.dx > 0 ? areaW : areaW / 2) - handleSize / 2,
                      top: (h.dy < 0 ? 0 : h.dy > 0 ? areaH : areaH / 2) - handleSize / 2,
                      background: '#fff',
                      border: '1px solid rgba(0, 0, 0, 0.35)',
                      borderRadius: '50%',
                      boxShadow: '0 1px 3px rgba(0, 0, 0, 0.35)',
                      pointerEvents: 'auto',
                      touchAction: 'none',
                      cursor: h.cursor,
                      zIndex: 101,
                    }}
                  />
                ))}
            </div>
          )}
          <div
            className={`thermometer-component${selected ? ' thermometer-component--selected' : ''}${
              hovered ? ' thermometer-component--hovered' : ''
            }`}
          >
            {/* Modern thermometer glyph, bulb centred on the measured pixel: frosted-white body over
                a dark rim (legible on any palette), mercury in this probe's chart series colour. */}
            <svg className="thermometer-glyph" viewBox="0 0 28 36" aria-hidden="true" style={{ color: accent }}>
              {/* Halo only when selected; the inline opacity is the prefers-reduced-motion static
                  fallback that the CSS breathing animation overrides while running. (Exports never
                  contain it: the press that reaches any export control clears the selection first.) */}
              {selected && (
                <circle
                  className="thermometer-glyph-halo"
                  cx={GLYPH_BULB.cx}
                  cy={GLYPH_BULB.cy}
                  r={6.6}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.2}
                  style={{ opacity: 0.35 }}
                />
              )}
              {/* dark rim under the frosted body; the accent outline rides the body's edge on top */}
              <path d={GLYPH_PATH} fill="none" stroke="rgba(0, 0, 0, 0.5)" strokeWidth={3.2} strokeLinejoin="round" />
              <path
                d={GLYPH_PATH}
                fill="rgba(255, 255, 255, 0.92)"
                stroke="currentColor"
                strokeWidth={1.4}
                strokeLinejoin="round"
              />
              {/* mercury: same colour this probe's series has in the T(t)/T(x)/T(y) charts */}
              <line
                x1={GLYPH_BULB.cx}
                y1={12}
                x2={GLYPH_BULB.cx}
                y2={GLYPH_BULB.cy}
                stroke={seriesColor}
                strokeWidth={2.2}
                strokeLinecap="round"
              />
              <circle cx={GLYPH_BULB.cx} cy={GLYPH_BULB.cy} r={2.9} fill={seriesColor} />
            </svg>
            <div className="thermometer-pill">
              <span className="thermometer-pill-name">{displayLabel}</span>
              <span className="thermometer-pill-value">
                {`${sign}${shownValue.toFixed(2)}`}
                <span className="thermometer-pill-unit">&nbsp;{temperatureSymbol(temperatureUnit)}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </DraggableBox>
  );
};

export default Wrapper;
