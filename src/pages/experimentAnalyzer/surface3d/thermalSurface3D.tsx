import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from 'antd';
import { getTempFromArrayBuffer } from '../../../utils/temperatureReader';
import { temp01ToCss } from '../../../utils/colormap';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';
import { downloadDataURL, timestampedName } from '../../../utils/exporters';
import useCommonStore from '../../../stores/common';

// three.js lives in this lazily-loaded chunk — it only downloads on first modal open.
const Surface3DScene = lazy(() => import('./surface3dScene'));

interface Props {
  open: boolean;
  onClose: () => void;
  // The live current-frame thermal buffer (used when the modal isn't self-playing).
  buffer?: ArrayBuffer;
  // Full frame sequence for in-modal playback (video sources keep all frames in memory).
  frames?: ArrayBuffer[];
  fps?: number;
  currentIndex?: number;
  // Parent-driven playback (recordings stream frames lazily, so the player owns the loop).
  playing?: boolean;
  onTogglePlay?: () => void;
}

const overlayBtn: React.CSSProperties = {
  background: 'rgba(255,255,255,0.12)',
  color: 'white',
  border: '1px solid rgba(255,255,255,0.25)',
  borderRadius: 6,
  padding: '4px 12px',
  fontSize: 13,
  cursor: 'pointer',
};

const overlayBtnActive: React.CSSProperties = {
  background: 'rgba(125,155,189,0.45)',
  borderColor: 'rgba(180,205,235,0.7)',
};

const centered: React.CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  height: '100%',
  color: 'rgba(255,255,255,0.6)',
};

/** Renders the current thermal frame as an interactive 3D surface (height = temperature). */
const ThermalSurface3D = ({ open, onClose, buffer, frames, fps, currentIndex, playing, onTogglePlay }: Props) => {
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  // Mount the WebGL canvas only once the modal has finished opening, so react-three-fiber
  // measures the container at its final size (otherwise it renders tiny in a corner).
  const [ready, setReady] = useState(false);
  const glRef = useRef<{ domElement: HTMLCanvasElement } | null>(null);

  const [showGrid, setShowGrid] = useState(true);
  const [showIsotherms, setShowIsotherms] = useState(true);

  const selfPlayable = !!frames && frames.length > 1;
  const [selfIdx, setSelfIdx] = useState(0);
  const [selfPlaying, setSelfPlaying] = useState(false);

  // Sync the in-modal playhead to the player on open; reset transient state on close.
  useEffect(() => {
    if (open) {
      setSelfIdx(currentIndex ?? 0);
    } else {
      setReady(false);
      setSelfPlaying(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // In-modal playback (video): advance through the in-memory frames. Capped at 15fps so the
  // per-frame decode + geometry rebuild stays smooth.
  useEffect(() => {
    if (!open || !selfPlaying || !selfPlayable || !frames) return;
    const ms = 1000 / Math.min(Math.max(fps ?? 5, 1), 15);
    const id = setInterval(() => setSelfIdx((i) => (i + 1) % frames.length), ms);
    return () => clearInterval(id);
  }, [open, selfPlaying, selfPlayable, fps, frames]);

  const activeBuffer = selfPlayable && frames ? frames[Math.min(selfIdx, frames.length - 1)] : buffer;

  const data = useMemo(() => {
    if (!open || !activeBuffer) return null;
    try {
      const grid = getTempFromArrayBuffer(activeBuffer); // per-pixel Celsius for the frame
      let min = Infinity;
      let max = -Infinity;
      for (const v of grid) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (!isFinite(min) || !isFinite(max)) return null;
      return { grid, min, max };
    } catch (e) {
      console.error('failed to decode frame for 3D surface', e);
      return null;
    }
  }, [open, activeBuffer]);

  const sym = temperatureSymbol(temperatureUnit);
  const isPlaying = selfPlayable ? selfPlaying : !!playing;
  const canPlay = selfPlayable || !!onTogglePlay;
  const togglePlay = () => {
    if (selfPlayable) setSelfPlaying((p) => !p);
    else onTogglePlay?.();
  };

  const exportPng = () => {
    const canvas = glRef.current?.domElement;
    if (!canvas) return;
    try {
      downloadDataURL(timestampedName('thermal-3d', 'png'), canvas.toDataURL('image/png'));
    } catch (e) {
      console.error('failed to export 3D surface', e);
    }
  };

  return (
    <Modal
      title="3D thermal surface"
      open={open}
      onCancel={onClose}
      afterOpenChange={setReady}
      footer={null}
      width="92vw"
      style={{ top: 24, maxWidth: 1180, paddingBottom: 0 }}
      destroyOnClose
      styles={{ body: { padding: 0 } }}
    >
      <div style={{ position: 'relative', width: '100%', height: '78vh', background: '#0b0d12' }}>
        {data && ready ? (
          <>
            <Suspense fallback={<div style={centered}>Loading 3D…</div>}>
              <Surface3DScene
                grid={data.grid}
                min={data.min}
                max={data.max}
                unit={temperatureUnit}
                showGrid={showGrid}
                showIsotherms={showIsotherms}
                glRef={glRef}
              />
            </Suspense>

            {/* Controls */}
            <div style={{ position: 'absolute', left: 12, top: 12, display: 'flex', gap: 8 }}>
              {canPlay && (
                <button style={overlayBtn} onClick={togglePlay}>
                  {isPlaying ? '⏸ Pause' : '▶ Play'}
                </button>
              )}
              <button
                style={showGrid ? { ...overlayBtn, ...overlayBtnActive } : overlayBtn}
                onClick={() => setShowGrid((g) => !g)}
              >
                ▦ Grid
              </button>
              <button
                style={showIsotherms ? { ...overlayBtn, ...overlayBtnActive } : overlayBtn}
                onClick={() => setShowIsotherms((s) => !s)}
              >
                ≋ Isotherms
              </button>
              <button style={overlayBtn} onClick={exportPng}>
                ⬇ PNG
              </button>
            </div>

            {/* Color scale legend (in the user's display unit). */}
            <div
              style={{
                position: 'absolute',
                right: 12,
                top: 12,
                padding: '8px 10px',
                borderRadius: 6,
                background: 'rgba(0,0,0,0.55)',
                color: 'white',
                fontSize: 11,
                lineHeight: 1.4,
                pointerEvents: 'none',
              }}
            >
              <div style={{ marginBottom: 4 }}>
                {displayTemp(data.max, temperatureUnit).toFixed(1)} {sym}
              </div>
              <div
                style={{
                  width: 12,
                  height: 120,
                  borderRadius: 3,
                  background: `linear-gradient(to top, ${temp01ToCss(0)}, ${temp01ToCss(0.5)}, ${temp01ToCss(1)})`,
                }}
              />
              <div style={{ marginTop: 4 }}>
                {displayTemp(data.min, temperatureUnit).toFixed(1)} {sym}
              </div>
            </div>

            <div
              style={{
                position: 'absolute',
                left: 12,
                bottom: 10,
                color: 'rgba(255,255,255,0.6)',
                fontSize: 11,
                pointerEvents: 'none',
              }}
            >
              Drag to rotate · scroll to zoom · height = temperature
            </div>
          </>
        ) : !data ? (
          <div style={centered}>No thermal data for this frame.</div>
        ) : null}
      </div>
    </Modal>
  );
};

export default ThermalSurface3D;
