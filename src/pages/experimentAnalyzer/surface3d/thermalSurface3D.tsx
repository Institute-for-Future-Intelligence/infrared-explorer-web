import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Slider } from 'antd';
import Draggable, { DraggableProps } from 'react-draggable';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { temp01ToCss } from '../../../utils/colormap';
import { displayTemp, formatDuration, temperatureSymbol } from '../../../utils/helpers';
import { downloadDataURL, timestampedName } from '../../../utils/exporters';
import useCommonStore from '../../../stores/common';
import { readViewerPref, writeViewerPref } from '../../../utils/viewerPrefs';

// The miniplayer's resting corner (its fixed top-left before any drag), and where its drag offset and
// size are remembered in this browser (viewerPrefs).
const MINIPLAYER_TOP = 90;
const MINIPLAYER_LEFT = 90;
const MINIPLAYER_POS_KEY = 'surface3dWindow.position';
const MINIPLAYER_SIZE_KEY = 'surface3dWindow.size';

// three.js lives in this lazily-loaded chunk — it only downloads on first open.
const Surface3DScene = lazy(() => import('./surface3dScene'));

// react-draggable is a class component whose props are all flagged required under its typings.
const DraggableBox = Draggable as unknown as React.ComponentType<Partial<DraggableProps>>;

// How many upcoming frames the playback loop warms ahead of the playhead. Keeps Storage-backed
// recordings pipelined (several concurrent fetches) so the first pass doesn't crawl frame-by-frame.
const PREFETCH_AHEAD = 3;

// Below this width the in-place surface drops its button captions and shrinks its legend, like the
// miniplayer always does: a phone-wide or a narrow portrait player box has no room for "▦ Grid".
const COMPACT_BELOW_PX = 480;

/**
 * The in-place surface's root. The player's capture paths (screenshot, thumbnail, the Ask AI moment) see
 * the player box with this layer over the frame: a screenshot and a thumbnail keep it (the surface IS what
 * is displayed), while the Ask AI moment leaves it out so the model is handed the frame with its probes.
 */
export const SURFACE3D_INLINE_CLASS = 's3d-inline';
export const SURFACE3D_INLINE_SELECTOR = `.${SURFACE3D_INLINE_CLASS}`;

// Which presentation the 3D surface shows in. A host keeps one of these plus a single is-it-open flag —
// never a flag per presentation — so (a) a popped-out view can never be shadowed by a second in-place
// copy, (b) the toolbar button has one "is it on?" answer to light up on, and (c) the presentation
// survives a close: pop the surface out and it reopens as the miniplayer.
//   'modal'  — in place: the surface takes the player's frame area (the video / image and the 2D overlays
//              sit under it, untouched, and come back when it closes). The stored value keeps its old name
//              from when this presentation was a centred modal, so no saved view needs rewriting.
//   'window' — the small draggable miniplayer, beside the frame.
export type Surface3DView = 'modal' | 'window';

interface Props {
  open: boolean;
  onClose: () => void;
  frameCount: number;
  // Returns the thermal buffer for a frame: in-memory for video, cached/fetched for recordings.
  loadFrame: (index: number) => Promise<ArrayBuffer | undefined>;
  // Playback pacing (frames per second of the play loop; absent → frames are labelled by number).
  fps?: number;
  // Seconds of recording time per frame for the clock labels, when it differs from 1/fps — a time-lapse
  // plays at fps but its frames are minutes apart (utils/frameTime). Pacing is untouched.
  secondsPerFrame?: number;
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
  // Render as a small draggable floating window (the miniplayer) instead of in place over the frame. In
  // place, the host renders this component INSIDE its player box (position: relative): the surface fills
  // the box and covers the frame and its overlays.
  floating?: boolean;
  // Switch between the in-place and the miniplayer presentation (pop out / back into the player).
  onSwap?: () => void;
  // The host keeps its own transport (play button + scrubber) on screen under the in-place surface — the
  // recording player's control bar, a photo set's strip — so the surface doesn't draw a second one. Its own
  // comes back in full screen, where the host's is off screen. A video's native controls are under the
  // surface, so a video host leaves this unset.
  hostTransport?: boolean;
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

// "Back into the player" glyph (the miniplayer's swap button): the player's frame, with an arrow heading
// into it from the corner the miniplayer sits in — the reverse of MiniplayerIcon, and unlike the
// four-corner "expand" arrows it can't be read as "make this bigger".
const DockIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={iconStyle}
  >
    <rect x="3" y="3" width="12" height="9" rx="1.5" />
    <path d="M20 20 L11 11" />
    <path d="M11 15 V11 H15" />
  </svg>
);

// "Fill the screen" / "leave full screen" glyphs (in place only).
const FullscreenIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={iconStyle}
  >
    <path d="M4 9 V4 H9" />
    <path d="M15 4 H20 V9" />
    <path d="M20 15 V20 H15" />
    <path d="M9 20 H4 V15" />
  </svg>
);

const ExitFullscreenIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={iconStyle}
  >
    <path d="M9 4 V9 H4" />
    <path d="M15 4 V9 H20" />
    <path d="M15 20 V15 H20" />
    <path d="M9 20 V15 H4" />
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
  secondsPerFrame,
  initialIndex,
  currentIndex,
  playing: externalPlaying,
  onSeek,
  onTogglePlay,
  liveSeek,
  floating,
  onSwap,
  hostTransport,
}: Props) => {
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  const nodeRef = useRef<HTMLDivElement>(null);

  // The miniplayer is always compact; in place it depends on how wide the player box is (measured below).
  const [narrow, setNarrow] = useState(false);
  const compact = !!floating || narrow;

  // Where the miniplayer was left, so reopening it — or reloading the page, or coming back later — doesn't
  // send it back to the default corner. Remembered in this browser (viewerPrefs, one place for every
  // experiment, like a window's), and pulled back into the viewport on the way in, so a spot left on a
  // bigger window can't strand it off-screen. Drag offset is state (react-draggable seeds itself from it
  // on mount); the size is a ref because the CSS resize handle writes width/height straight onto the
  // element — reading and restoring through that same element.style channel keeps React from fighting
  // it, and skips any box-model conversion (the CSS max-width / max-height still cap a remembered size).
  const [winPos, setWinPos] = useState(() => {
    const saved = readViewerPref<{ x?: number; y?: number } | null>(MINIPLAYER_POS_KEY, null);
    if (typeof saved?.x !== 'number' || typeof saved?.y !== 'number') return { x: 0, y: 0 };
    // The box sits at (MINIPLAYER_LEFT, MINIPLAYER_TOP) + this offset: keep its title bar on screen.
    const x = Math.min(Math.max(saved.x, -MINIPLAYER_LEFT), window.innerWidth - MINIPLAYER_LEFT - 120);
    const y = Math.min(Math.max(saved.y, -MINIPLAYER_TOP), window.innerHeight - MINIPLAYER_TOP - 40);
    return { x, y };
  });
  const winSizeRef = useRef<{ width: string; height: string } | null>(
    readViewerPref<{ width: string; height: string } | null>(MINIPLAYER_SIZE_KEY, null),
  );

  // Mount the WebGL canvas only once the container is at its final size, so react-three-fiber
  // measures it correctly (otherwise it renders tiny in a corner): a tick after the box mounts — in
  // place it fills the already-laid-out player box, and the miniplayer is a fixed size.
  const [ready, setReady] = useState(false);
  const glRef = useRef<{ domElement: HTMLCanvasElement } | null>(null);

  const [showGrid, setShowGrid] = useState(true);
  const [showIsotherms, setShowIsotherms] = useState(true);

  // Full screen (in place only): the surface's own root goes full screen, so nothing of the page's layout
  // has to be undone — the box the surface fills is the screen for the while. Tracked off the document's
  // fullscreenchange so Esc (the browser's own exit) flips the button back too.
  const [fullscreen, setFullscreen] = useState(false);
  const canFullscreen = !floating && typeof document !== 'undefined' && !!document.fullscreenEnabled;

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

  // Readiness: a tick after the box is up (both presentations).
  useEffect(() => {
    if (!open) {
      setReady(false);
      return;
    }
    const t = setTimeout(() => setReady(true), 0);
    return () => clearTimeout(t);
  }, [open]);

  // In place: follow the player box's width into and out of the compact layout. (The miniplayer is
  // always compact, so it doesn't measure.)
  useEffect(() => {
    const el = nodeRef.current;
    if (floating || !open || !el) return;
    const measure = () => setNarrow(el.clientWidth > 0 && el.clientWidth < COMPACT_BELOW_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [floating, open]);

  // Full-screen bookkeeping: mirror the document's state. Closing or popping out the surface unmounts its
  // root, and a full-screen element leaving the document ends full screen on its own — nothing to undo.
  useEffect(() => {
    if (!canFullscreen) return;
    const onChange = () => setFullscreen(!!nodeRef.current && document.fullscreenElement === nodeRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [canFullscreen]);
  const toggleFullscreen = () => {
    const el = nodeRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen().catch(() => undefined);
  };

  // Restore the miniplayer's remembered size on open, then keep it up to date while the user drags the
  // corner. (The observer also fires once on mount, which just re-records the size we set.)
  useEffect(() => {
    const el = nodeRef.current;
    if (!floating || !open || !el) return;
    const saved = winSizeRef.current;
    if (saved) {
      el.style.width = saved.width;
      el.style.height = saved.height;
    }
    const observer = new ResizeObserver(() => {
      if (!el.style.width || !el.style.height) return;
      const prev = winSizeRef.current;
      if (prev?.width === el.style.width && prev?.height === el.style.height) return;
      winSizeRef.current = { width: el.style.width, height: el.style.height };
      writeViewerPref(MINIPLAYER_SIZE_KEY, winSizeRef.current);
    });
    observer.observe(el);
    return () => observer.disconnect();
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
  // The surface's own transport: whenever the host's isn't on screen (see Props.hostTransport).
  const ownTransport = !hostTransport || fullscreen;
  const canPlay = frameCount > 1 && ownTransport;
  const hasBar = frameCount > 1 && ownTransport;
  const sliderValue = scrubbing ? dragValue : effectiveIdx;
  const fmt = (i: number) =>
    secondsPerFrame ? formatDuration(i * secondsPerFrame) : fps ? formatDuration(i / fps) : String(i + 1);
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
  const barBtnStyle: React.CSSProperties = {
    ...btnStyle,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  };
  const showBar = hasBar || onSwap || canFullscreen;

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
              bottom: showBar ? 52 : 10,
              color: 'rgba(255,255,255,0.6)',
              fontSize: 11,
              pointerEvents: 'none',
            }}
          >
            Drag to rotate · scroll to zoom · height = temperature
          </div>
        )}

        {showBar && (
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
                style={{ ...barBtnStyle, gap: 0, padding: compact ? '2px 5px' : '3px 7px' }}
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
                  // Into the surface's own root, so the readout still shows while that root is full screen
                  // (a popup on <body> is not part of the full-screen element and stays hidden).
                  tooltip={{ formatter: (v) => fmt(v ?? 0), getPopupContainer: () => nodeRef.current ?? document.body }}
                />
              </>
            )}
            {onSwap && (
              <button
                style={{ ...barBtnStyle, marginLeft: hasBar ? 0 : 'auto' }}
                onClick={onSwap}
                title={floating ? 'Show in the player' : 'Show in a miniplayer'}
              >
                {floating ? <DockIcon /> : <MiniplayerIcon />}
              </button>
            )}
            {canFullscreen && (
              <button
                style={{ ...barBtnStyle, marginLeft: hasBar || onSwap ? 0 : 'auto' }}
                onClick={toggleFullscreen}
                title={fullscreen ? 'Exit full screen' : 'Full screen'}
              >
                {fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
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
      <DraggableBox
        handle=".s3d-win-handle"
        cancel=".s3d-win-close"
        nodeRef={nodeRef}
        defaultPosition={winPos}
        onStop={(_e, data) => {
          setWinPos({ x: data.x, y: data.y });
          writeViewerPref(MINIPLAYER_POS_KEY, { x: Math.round(data.x), y: Math.round(data.y) });
        }}
      >
        <div
          ref={nodeRef}
          style={{
            position: 'fixed',
            top: MINIPLAYER_TOP,
            left: MINIPLAYER_LEFT,
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

  // In place: a layer filling the host's player box, over the frame and every 2D overlay (their z-indexes
  // top out at the chart overlay's 7 and the clip slider's 8). Opaque, so the frame under it never shows
  // through; the toolbar's 3D button is the way back (onClose), so there is no close control of its own.
  if (!open) return null;
  return (
    <div
      ref={nodeRef}
      className={SURFACE3D_INLINE_CLASS}
      style={{ position: 'absolute', inset: 0, zIndex: 9, background: '#0b0d12', overflow: 'hidden' }}
    >
      {body}
    </div>
  );
};

export default ThermalSurface3D;
