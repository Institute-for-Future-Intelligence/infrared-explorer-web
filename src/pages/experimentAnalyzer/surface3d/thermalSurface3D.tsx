import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal, Slider } from 'antd';
import Draggable, { DraggableProps } from 'react-draggable';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { temp01ToCss } from '../../../utils/colormap';
import { displayTemp, formatDuration, temperatureSymbol } from '../../../utils/helpers';
import { downloadDataURL, timestampedName } from '../../../utils/exporters';
import useCommonStore from '../../../stores/common';

// three.js lives in this lazily-loaded chunk — it only downloads on first open.
const Surface3DScene = lazy(() => import('./surface3dScene'));

// react-draggable is a class component whose props are all flagged required under its typings.
const DraggableBox = Draggable as unknown as React.ComponentType<Partial<DraggableProps>>;

// How many upcoming frames the playback loop warms ahead of the playhead. Keeps Storage-backed
// recordings pipelined (several concurrent fetches) so the first pass doesn't crawl frame-by-frame.
const PREFETCH_AHEAD = 3;

interface Props {
  open: boolean;
  onClose: () => void;
  frameCount: number;
  // Returns the thermal buffer for a frame: in-memory for video, cached/fetched for recordings.
  loadFrame: (index: number) => Promise<ArrayBuffer | undefined>;
  fps?: number;
  initialIndex?: number;
  // External playhead sync. When the host passes these, the surface mirrors the experiment page's
  // current frame (currentIndex) and play state (playing) instead of running its own clock, and
  // reports the user's transport back up via onSeek / onTogglePlay — so the 3D view and the
  // experiment page share one timeline. Omit them to drive an independent playhead (standalone use).
  currentIndex?: number;
  playing?: boolean;
  onSeek?: (index: number) => void;
  onTogglePlay?: () => void;
  // Seek live on every drag tick (cheap in-memory video) vs only on release (Storage-backed recordings).
  liveSeek?: boolean;
  // Render as a small draggable floating window instead of a centered modal.
  floating?: boolean;
  // Switch between modal and floating-window presentation (pop out / expand).
  onSwap?: () => void;
}

const overlayBtn: React.CSSProperties = {
  background: 'rgba(255,255,255,0.12)',
  color: 'white',
  border: '1px solid rgba(255,255,255,0.25)',
  borderRadius: 6,
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

const iconStyle: React.CSSProperties = { width: 15, height: 15, display: 'block' };

// "Pop out to a corner miniplayer" glyph.
const MiniplayerIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={iconStyle}
  >
    <path d="M4 4 L10 10" />
    <path d="M10 6 V10 H6" />
    <rect x="12" y="12" width="8" height="6" rx="1.5" fill="currentColor" stroke="currentColor" />
  </svg>
);

// "Expand back to full window" glyph.
const ExpandIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={iconStyle}
  >
    <path d="M9 4 H4 V9" />
    <path d="M20 15 V20 H15" />
    <path d="M4 4 L9 9" />
    <path d="M20 20 L15 15" />
  </svg>
);

const playIconStyle: React.CSSProperties = { width: 18, height: 18, display: 'block' };

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={playIconStyle}>
    <circle cx="12" cy="12" r="9" />
    <path d="M10 8 L16 12 L10 16 Z" fill="currentColor" stroke="none" />
  </svg>
);

const PauseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={playIconStyle}>
    <circle cx="12" cy="12" r="9" />
    <rect x="9" y="8.3" width="2.2" height="7.4" rx="0.6" fill="currentColor" stroke="none" />
    <rect x="12.8" y="8.3" width="2.2" height="7.4" rx="0.6" fill="currentColor" stroke="none" />
  </svg>
);

/** Renders the current thermal frame as an interactive 3D surface (height = temperature). */
const ThermalSurface3D = ({
  open,
  onClose,
  frameCount,
  loadFrame,
  fps,
  initialIndex,
  currentIndex,
  playing: externalPlaying,
  onSeek,
  onTogglePlay,
  liveSeek,
  floating,
  onSwap,
}: Props) => {
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  const compact = !!floating;
  const nodeRef = useRef(null);

  // Mount the WebGL canvas only once the container is at its final size, so react-three-fiber
  // measures it correctly (otherwise it renders tiny in a corner). Modal: after the open
  // animation; floating window: a tick after mount (the box is already a fixed size).
  const [ready, setReady] = useState(false);
  const glRef = useRef<{ domElement: HTMLCanvasElement } | null>(null);

  const [showGrid, setShowGrid] = useState(true);
  const [showIsotherms, setShowIsotherms] = useState(true);

  const [idx, setIdx] = useState(0);
  // Mirror of idx so the playback loop can read the current frame without re-arming every tick.
  const idxRef = useRef(0);
  idxRef.current = idx;
  const [localPlaying, setLocalPlaying] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [dragValue, setDragValue] = useState(0);
  const [frameBuffer, setFrameBuffer] = useState<ArrayBuffer | undefined>(undefined);
  const [emptyFrame, setEmptyFrame] = useState(false);

  // Keep loadFrame identity-stable for the loader effect (parents pass an inline arrow).
  const loadFrameRef = useRef(loadFrame);
  loadFrameRef.current = loadFrame;

  // External-sync mode (see Props): with onSeek the host owns the playhead, so we display its
  // currentIndex; with `playing` the host owns the clock, so we reflect its play state and the
  // internal playback loop below stays parked. Either prop missing → drive that aspect locally.
  const indexControlled = onSeek != null;
  const playControlled = externalPlaying !== undefined;
  const isPlaying = playControlled ? !!externalPlaying : localPlaying;
  const lastIdx = Math.max(frameCount - 1, 0);
  const effectiveIdx = indexControlled ? Math.min(Math.max(currentIndex ?? 0, 0), lastIdx) : idx;
  const togglePlay = () => (onTogglePlay ? onTogglePlay() : setLocalPlaying((p) => !p));

  // Floating-window readiness (the modal uses Modal.afterOpenChange instead).
  useEffect(() => {
    if (!floating) return;
    if (!open) {
      setReady(false);
      return;
    }
    const t = setTimeout(() => setReady(true), 0);
    return () => clearTimeout(t);
  }, [floating, open]);

  // Reset transient state on open/close.
  useEffect(() => {
    if (open) {
      setIdx(initialIndex ?? 0);
    } else {
      setLocalPlaying(false);
      setScrubbing(false);
      setFrameBuffer(undefined);
      setEmptyFrame(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Load the thermal buffer for the current frame into state (so it re-renders). Keeps the previous
  // frame visible while the next one loads (no blank flash); `active` discards out-of-order results.
  // When the host owns the clock (playControlled) this effect loads every frame the playhead lands
  // on; otherwise the load-paced loop below owns loading during local playback and this effect just
  // handles the initial frame, seeks, and scrubbing (including live-seek drags).
  useEffect(() => {
    if (!open || (!playControlled && isPlaying && !scrubbing)) return;
    let active = true;
    loadFrameRef.current(effectiveIdx).then(
      (buf) => {
        if (!active) return;
        if (buf) {
          setFrameBuffer(buf);
          setEmptyFrame(false);
        } else {
          setEmptyFrame(true);
        }
      },
      () => {
        if (active) setEmptyFrame(true);
      },
    );
    return () => {
      active = false;
    };
  }, [open, effectiveIdx, isPlaying, scrubbing, playControlled]);

  // Playback loop (capped at 15fps so the per-frame decode + geometry rebuild stays smooth).
  // Load-paced: it advances only after the next frame's buffer has loaded and committed, so a slow
  // source (Storage-backed recordings) plays slower instead of freezing. The old fixed-interval timer
  // bumped idx faster than frames could load, so in-flight loads were superseded before they
  // committed and playback got stuck cycling whichever few frames happened to be cached.
  useEffect(() => {
    if (!open || playControlled || !isPlaying || scrubbing || frameCount <= 1) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ms = 1000 / Math.min(Math.max(fps ?? 5, 1), 15);
    const step = async () => {
      const next = (idxRef.current + 1) % frameCount;
      const started = performance.now();
      let buf: ArrayBuffer | undefined;
      try {
        buf = await loadFrameRef.current(next);
      } catch {
        buf = undefined;
      }
      if (cancelled) return;
      idxRef.current = next;
      setIdx(next);
      if (buf) {
        setFrameBuffer(buf);
        setEmptyFrame(false);
      } else {
        setEmptyFrame(true);
      }
      // Warm a few upcoming frames (deduped at the source) so the loop rarely stalls on Storage.
      for (let k = 1; k <= PREFETCH_AHEAD && k < frameCount; k++) {
        void loadFrameRef.current((next + k) % frameCount).catch(() => undefined);
      }
      timer = setTimeout(step, Math.max(0, ms - (performance.now() - started)));
    };
    timer = setTimeout(step, ms);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // idxRef/loadFrameRef are refs; reading them must not re-arm the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, playControlled, isPlaying, scrubbing, frameCount, fps]);

  const data = useMemo(() => {
    if (!frameBuffer) return null;
    try {
      const { temps, min, max } = getDecodedFrame(frameBuffer); // per-pixel Celsius + frame stats, decoded once
      if (!isFinite(min) || !isFinite(max)) return null;
      return { grid: temps, min, max };
    } catch (e) {
      console.error('failed to decode frame for 3D surface', e);
      return null;
    }
  }, [frameBuffer]);

  const sym = temperatureSymbol(temperatureUnit);
  const canPlay = frameCount > 1;
  const hasBar = frameCount > 1;
  const sliderValue = scrubbing ? dragValue : effectiveIdx;
  const fmt = (i: number) => (fps ? formatDuration(i / fps) : String(i + 1));
  const timeText = `${fmt(sliderValue)} / ${fmt(frameCount - 1)}`;

  // Move the playhead — to the host when it owns the playhead, otherwise to our local index.
  const seekTo = (v: number) => (indexControlled ? onSeek?.(v) : setIdx(v));
  const onScrub = (v: number) => {
    setScrubbing(true);
    setDragValue(v);
    if (liveSeek) seekTo(v);
  };
  const onScrubEnd = (v: number) => {
    seekTo(v);
    setScrubbing(false);
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

  const pad = compact ? 8 : 12;
  const btnStyle: React.CSSProperties = { ...overlayBtn, padding: compact ? '2px 7px' : '4px 12px' };

  const body =
    ready && data ? (
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
        <div
          style={{ position: 'absolute', left: pad, top: pad, display: 'flex', gap: compact ? 6 : 8, flexWrap: 'wrap' }}
        >
          <button
            style={showGrid ? { ...btnStyle, ...overlayBtnActive } : btnStyle}
            onClick={() => setShowGrid((g) => !g)}
            title="Toggle grid"
          >
            ▦{compact ? '' : ' Grid'}
          </button>
          <button
            style={showIsotherms ? { ...btnStyle, ...overlayBtnActive } : btnStyle}
            onClick={() => setShowIsotherms((s) => !s)}
            title="Toggle isotherms"
          >
            ≋{compact ? '' : ' Isotherms'}
          </button>
          <button style={btnStyle} onClick={exportPng} title="Export PNG">
            ⬇{compact ? '' : ' PNG'}
          </button>
        </div>

        {/* Color scale legend (in the user's display unit). */}
        <div
          style={{
            position: 'absolute',
            right: pad,
            top: pad,
            padding: compact ? '6px 8px' : '8px 10px',
            borderRadius: 6,
            background: 'rgba(0,0,0,0.55)',
            color: 'white',
            fontSize: compact ? 10 : 11,
            lineHeight: 1.4,
            pointerEvents: 'none',
          }}
        >
          <div style={{ marginBottom: 4 }}>
            {displayTemp(data.max, temperatureUnit).toFixed(1)} {sym}
          </div>
          <div
            style={{
              width: compact ? 10 : 12,
              height: compact ? 70 : 120,
              borderRadius: 3,
              background: `linear-gradient(to top, ${temp01ToCss(0)}, ${temp01ToCss(0.5)}, ${temp01ToCss(1)})`,
            }}
          />
          <div style={{ marginTop: 4 }}>
            {displayTemp(data.min, temperatureUnit).toFixed(1)} {sym}
          </div>
        </div>

        {!compact && (
          <div
            style={{
              position: 'absolute',
              left: 12,
              bottom: hasBar || onSwap ? 52 : 10,
              color: 'rgba(255,255,255,0.6)',
              fontSize: 11,
              pointerEvents: 'none',
            }}
          >
            Drag to rotate · scroll to zoom · height = temperature
          </div>
        )}

        {(hasBar || onSwap) && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'center',
              gap: compact ? 8 : 12,
              padding: compact ? '4px 10px' : '6px 16px',
              background: 'rgba(0,0,0,0.5)',
            }}
          >
            {canPlay && (
              <button
                style={{
                  ...btnStyle,
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: compact ? '2px 5px' : '3px 7px',
                }}
                onClick={togglePlay}
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <PauseIcon /> : <PlayIcon />}
              </button>
            )}
            {hasBar && (
              <>
                <span
                  style={{
                    color: 'white',
                    fontSize: compact ? 11 : 12,
                    whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {timeText}
                </span>
                <Slider
                  className="s3d-slider"
                  style={{ flex: 1, margin: 0 }}
                  min={0}
                  max={frameCount - 1}
                  value={sliderValue}
                  onChange={(v) => onScrub(v as number)}
                  onChangeComplete={(v) => onScrubEnd(v as number)}
                  tooltip={{ formatter: (v) => fmt(v ?? 0) }}
                />
              </>
            )}
            {onSwap && (
              <button
                style={{
                  ...btnStyle,
                  marginLeft: hasBar ? 0 : 'auto',
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
                onClick={onSwap}
                title={floating ? 'Expand to full window' : 'Show in a miniplayer'}
              >
                {floating ? <ExpandIcon /> : <MiniplayerIcon />}
              </button>
            )}
          </div>
        )}
      </>
    ) : emptyFrame && !data ? (
      <div style={centered}>No thermal data for this frame.</div>
    ) : (
      <div style={centered}>Loading…</div>
    );

  // Floating draggable window (picture-in-picture).
  if (floating) {
    if (!open) return null;
    return createPortal(
      <DraggableBox handle=".s3d-win-handle" cancel=".s3d-win-close" nodeRef={nodeRef}>
        <div
          ref={nodeRef}
          style={{
            position: 'fixed',
            top: 90,
            left: 90,
            width: 380,
            height: 340,
            // Drag the bottom-right corner to resize (the canvas auto-fits via its ResizeObserver).
            resize: 'both',
            minWidth: 260,
            minHeight: 220,
            maxWidth: '95vw',
            maxHeight: '90vh',
            zIndex: 1100,
            background: '#0b0d12',
            border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: 8,
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <div
            className="s3d-win-handle"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 10px',
              background: 'rgba(255,255,255,0.06)',
              color: 'white',
              fontSize: 12,
              cursor: 'move',
              userSelect: 'none',
            }}
          >
            <span>3D thermal surface</span>
            <span
              className="s3d-win-close"
              onClick={onClose}
              onTouchEnd={(e) => {
                e.preventDefault();
                onClose();
              }}
              style={{ cursor: 'pointer', padding: '2px 8px', margin: '-2px -4px', fontSize: 16, lineHeight: 1 }}
              title="Close"
            >
              ✕
            </span>
          </div>
          <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>{body}</div>
        </div>
      </DraggableBox>,
      document.body,
    );
  }

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
      <div style={{ position: 'relative', width: '100%', height: '78vh', background: '#0b0d12' }}>{body}</div>
    </Modal>
  );
};

export default ThermalSurface3D;
