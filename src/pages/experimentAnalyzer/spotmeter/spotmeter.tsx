import { CSSProperties, RefObject, useEffect, useState } from 'react';
import { TemperatureUnit } from '../../../types';
import useCommonStore from '../../../stores/common';
import { getTemperatureAtPosition } from '../../../utils/temperatureReader';
import { displayTemp, displayTempDelta, temperatureSymbol } from '../../../utils/helpers';

interface Props {
  // The box the thermal frame is drawn in (image-wrapper / video-player). Pointer coordinates map to
  // [0,1) against this box — the same coordinate system the thermometers and isotherms use, so the
  // reading names the pixel under the cursor.
  containerRef: RefObject<HTMLElement | null>;
  // Latest decoded-frame buffer for the DISPLAYED frame, read fresh on each render (so a ref-held buffer
  // that swaps without its own re-render is still picked up). Undefined until the frame's thermal data lands.
  getBuffer: () => ArrayBuffer | undefined;
  // Ask the host to fetch the current frame's thermal data (recordings fetch .dat lazily). Fire-and-forget;
  // the value is computed at render once it lands. Omit when frames are always in memory (video).
  ensureBuffer?: () => void;
  // Δ frame-difference mode: show "Δ … : (current − reference)" under the cursor instead of the absolute
  // reading (parity with the thermometers). getRefBuffer supplies the reference frame's decoded buffer.
  showDiff?: boolean;
  getRefBuffer?: () => ArrayBuffer | undefined;
}

interface CursorPos {
  xPx: number;
  yPx: number;
  fx: number;
  fy: number;
  flipX: boolean;
  flipY: boolean;
}

const crosshair: CSSProperties = {
  position: 'absolute',
  width: 10,
  height: 10,
  transform: 'translate(-50%, -50%)',
  border: '1.5px solid rgba(255,255,255,0.9)',
  borderRadius: '50%',
  boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
};

const label: CSSProperties = {
  position: 'absolute',
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
  color: '#fff',
  background: 'rgba(0,0,0,0.65)',
  borderRadius: 4,
  padding: '2px 5px',
  whiteSpace: 'nowrap',
};

// Live spot temperature under the cursor (a FLIR-style spotmeter). Always on: the frame's per-pixel
// temperatures are already decoded for the overlays/probes, so hovering just reads one pixel. Passive —
// a pointer-events:none label that never blocks a probe drag or the right-click menu, and it stays quiet
// while the cursor is over a thermometer or annotation (those carry their own readings). Only the cursor
// POSITION is stored; the reading is computed at render from the current frame + unit, so it tracks
// playback and flips on a °C/°F toggle like the sibling overlays (which store Celsius, convert at render).
const Spotmeter = ({ containerRef, getBuffer, ensureBuffer, showDiff, getRefBuffer }: Props) => {
  const unit = useCommonStore((s) => s.temperatureUnit);
  const [pos, setPos] = useState<CursorPos | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onMove = (e: PointerEvent) => {
      // Mouse / pen only. A touch synthesises a single pointermove on tap but no leave on finger-lift, so
      // a reading set here would stick; on touch the spotmeter is simply inert.
      if (e.pointerType === 'touch') {
        setPos(null);
        return;
      }
      const target = e.target as Element | null;
      // Defer to a probe / annotation the cursor is over — they show their own reading.
      if (target?.closest?.('.draggable-div') || target?.closest?.('#annotations-wrapper')) {
        setPos(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      // Valid domain is [0,1): fx/fy at exactly 1 index one pixel past the grid (the -273.15 sentinel),
      // matching the area reader's `>= 1` exclusion.
      if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) {
        setPos(null);
        return;
      }
      if (!getBuffer()) ensureBuffer?.(); // fetch now; the value is computed at render once it lands
      setPos({
        xPx: e.clientX - rect.left,
        yPx: e.clientY - rect.top,
        fx,
        fy,
        flipX: fx > 0.8, // keep the label inside the frame near the right edge
        flipY: fy < 0.12, // and below the cursor near the top edge
      });
    };
    const onLeave = () => setPos(null);

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [containerRef, getBuffer, ensureBuffer]);

  if (!pos) return null;

  const buffer = getBuffer();
  const refBuffer = showDiff ? getRefBuffer?.() : undefined;
  // Δ mode shows (current − reference) with a Δ prefix; otherwise the absolute reading. Both branches read
  // in Celsius and convert at the end so °C/°F flips correctly (a delta scales without the +32 offset).
  let value: number | null = null;
  let text: string | null = null;
  const sym = temperatureSymbol(unit);
  if (buffer) {
    try {
      if (showDiff && refBuffer) {
        const curC = getTemperatureAtPosition(buffer, pos.fx, pos.fy, TemperatureUnit.celsius);
        const refC = getTemperatureAtPosition(refBuffer, pos.fx, pos.fy, TemperatureUnit.celsius);
        value = displayTempDelta(curC - refC, unit);
        text = `Δ ${value > 0 ? '+' : ''}${value.toFixed(1)} ${sym}`;
      } else {
        value = getTemperatureAtPosition(buffer, pos.fx, pos.fy, TemperatureUnit.celsius);
        text = `${displayTemp(value, unit).toFixed(1)} ${sym}`;
      }
    } catch {
      value = null;
      text = null;
    }
  }

  const { xPx, yPx, flipX, flipY } = pos;
  return (
    // data-html2canvas-ignore: a transient cursor readout, excluded from the frame screenshot.
    <div data-html2canvas-ignore style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      <div style={{ ...crosshair, left: xPx, top: yPx }} />
      {text != null && (
        <div
          style={{
            ...label,
            left: xPx + (flipX ? -8 : 8),
            top: yPx + (flipY ? 14 : -8),
            transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '0' : '-100%'})`,
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
};

export default Spotmeter;
