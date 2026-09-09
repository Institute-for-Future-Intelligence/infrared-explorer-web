/*
 * StreetViewViewer — the look-around panorama, the web counterpart of the app's
 * PlaybackScreen street-view mode. Three render modes (preference order):
 *   1. pano   — a wide equirectangular panorama (sv.panoUrl, stitchAll.mjs) shown
 *      through a viewport window; dragging PANS horizontally around the full 360°
 *      (Google-Street-View feel). Widest FOV, cheapest runtime (no video seeking).
 *   2. video  — a frame-seek panorama over sv.streamUrl (all-intra) or the legacy
 *      sv.virUrl→.mp4 fallback; dragging scrubs the frame index → a seek time.
 *   3. frames — app-native per-frame data_N.png in Storage (no video).
 *
 * The FRAME-based video merger mirrors the app's pumpSeek: track the pending frame,
 * seek one at a time, and on each `seeked` clear the in-flight flag then pump the
 * newest pending frame — never chase achieved currentTime (which can clamp near EOS
 * and loop). The compass HUD is sized to where the image actually paints (the
 * contain-fit rect for video/frames; the full stage for pano) so its bearing/pitch
 * lines and neighbour markers line up.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Dropdown, InputNumber } from 'antd';
import { MoreOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { STREET_VIEW_HFOV, closestFrameToAzimuth, normalizeDeg, panToFrameSeek } from '../../utils/streetViewPano';
import { autoLevels, computePanoIsotherms, isothermColor } from '../../utils/panoIsotherms';
import { usePanoTemperature } from '../../hooks/usePanoTemperature';
import StreetViewCompass from './streetViewCompass';
import StreetViewHistogram from './streetViewHistogram';
import type { StreetView } from '../../types';

const BUCKET = 'infrared-explorer.appspot.com';

// matplotlib "inferno" (the baked palette) as a vertical CSS ramp for the scale bar.
const INFERNO_CSS = 'linear-gradient(to top, #000004, #280b54, #65156e, #9f2a63, #d44842, #f57d15, #fac228, #fcffa4)';

/** How far (CSS px) the pointer must move before a press becomes a look-around drag.
 *  Below this we DON'T capture the pointer, so a tap still reaches the neighbour buttons. */
const DRAG_THRESHOLD_PX = 3;

/** Public download URL for a Storage object (streetviews/** is anonymously readable). */
function storageUrl(path: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/` + encodeURIComponent(path) + '?alt=media';
}

// Material fullscreen enter/exit glyphs (24×24).
const FS_ENTER = 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z';
const FS_EXIT = 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z';

interface Props {
  sv: StreetView;
  onClose: () => void;
  /** Jump to a neighbour; the page resolves svId against the loaded set. */
  onNeighbor: (svId: string, fromAzimuth: number) => void;
  /** Heading to face on open (from the street view we arrived from), if any. */
  initialAzimuth?: number;
  // Moderation, offered from the ⋮ in the bar. Each one is absent when it doesn't apply —
  // there is no reporting your own panorama, no blocking yourself, and no takedown unless the
  // viewer is staff — and the menu disappears entirely when none of them is left.
  onReport?: (kind: 'streetview' | 'author') => void;
  onBlockAuthor?: () => void;
  onTakeDown?: () => void;
}

export default function StreetViewViewer({
  sv,
  onClose,
  onNeighbor,
  initialAzimuth,
  onReport,
  onBlockAuthor,
  onTakeDown,
}: Props) {
  const frameCount = Math.max(1, sv.frameCount || sv.azimuthDeg.length || 1);

  const videoSrc = useMemo(() => {
    if (sv.streamUrl) return sv.streamUrl;
    if (sv.virUrl) return sv.virUrl.replace(/\.vir$/i, '.mp4');
    return null;
  }, [sv.streamUrl, sv.virUrl]);

  // Default = the compact single-frame look-around (as before); the wide stitched
  // panorama is shown only after the user expands to full screen (and only when a pano
  // has been baked). So the pano is the "expanded" experience, not the default.
  const [expanded, setExpanded] = useState(false);
  const mode: 'pano' | 'video' | 'frames' = expanded && sv.panoUrl ? 'pano' : videoSrc ? 'video' : 'frames';
  const isVideo = mode === 'video';

  // Frame index (video/frames modes). Face the arrival heading on open, else frame 1.
  const [frame, setFrame] = useState(() =>
    initialAzimuth != null && sv.azimuthDeg.length ? closestFrameToAzimuth(sv.azimuthDeg, initialAzimuth) : 1,
  );
  // Look direction in degrees (pano mode). Face the arrival heading, else the first frame's.
  const [viewAz, setViewAz] = useState(() => initialAzimuth ?? sv.azimuthDeg[0] ?? 0);

  // Thermal tools: the temperature panorama + probe/scale toggles. Loaded whenever a
  // temp pano exists, so the tools work in BOTH the small single-frame window and the
  // full-screen panorama.
  const temp = usePanoTemperature(sv.panoTempUrl, sv.tMin, sv.tMax);
  const [probeOn, setProbeOn] = useState(false);
  const [scaleOn, setScaleOn] = useState(false);
  const [probe, setProbe] = useState<{ x: number; y: number; t: number | null } | null>(null);
  const [histOn, setHistOn] = useState(false);
  const [isoOn, setIsoOn] = useState(false);
  // Contour temperatures (°C), kept sorted ascending. null → derive evenly-spaced defaults.
  const [isoLevels, setIsoLevels] = useState<number[] | null>(null);

  // Materialise auto (evenly-spaced) levels once temp loads; "Auto" resets to null → here.
  useEffect(() => {
    if (temp.ready && isoLevels === null) setIsoLevels(autoLevels(temp.pLow, temp.pHigh, 5));
  }, [temp.ready, temp.pLow, temp.pHigh, isoLevels]);

  // Isotherm overlay: marching-squares contour LINES at each level (analyzer-style),
  // drawn to a grid-resolution PNG (blue→red by level). Rebuilt only when levels change;
  // the viewer lays it over the pano (pans for free) or the current frame's slice.
  const isoUrl = useMemo(() => {
    if (!isoOn || !temp.data || !isoLevels || isoLevels.length === 0) return null;
    const { grid, w, h } = temp.data;
    const lines = computePanoIsotherms(grid, w, h, isoLevels);
    // Render at ~visual-pano resolution (SCALE× the coarse temp grid) so the upscaled
    // overlay stays CRISP and the lines can be thin — instead of a blurry ~4× stretch
    // of a grid-resolution raster. Contour detail is still grid-limited (that's fine).
    const SCALE = 4;
    const cw = w * SCALE;
    const ch = h * SCALE;
    const cv = document.createElement('canvas');
    cv.width = cw;
    cv.height = ch;
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    lines.forEach((line, li) => {
      ctx.strokeStyle = isothermColor(li, lines.length);
      ctx.beginPath();
      for (const s of line.segments) {
        ctx.moveTo(s[0] * (cw - 1), s[1] * (ch - 1));
        ctx.lineTo(s[2] * (cw - 1), s[3] * (ch - 1));
      }
      ctx.stroke();
    });
    return cv.toDataURL('image/png');
  }, [isoOn, temp.data, isoLevels]);

  const editLevel = (i: number, nv: number | null) => {
    if (nv == null || !isoLevels) return;
    const next = [...isoLevels];
    next[i] = nv;
    setIsoLevels(next.sort((a, b) => a - b));
  };
  const removeLevel = (i: number) => {
    if (!isoLevels || isoLevels.length <= 1) return;
    setIsoLevels(isoLevels.filter((_, idx) => idx !== i));
  };
  const addLevel = () => {
    if (!isoLevels || isoLevels.length >= 8) return;
    const mid = Math.round(((temp.pLow + temp.pHigh) / 2) * 10) / 10;
    setIsoLevels([...isoLevels, mid].sort((a, b) => a - b));
  };

  // Stage box + media natural size → contain-fit rect (video/frames) / pano geometry.
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [mediaSize, setMediaSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pano natural size (measured off-DOM so we needn't render the full-width image).
  const [panoNat, setPanoNat] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!sv.panoUrl) return;
    const img = new Image();
    img.onload = () => setPanoNat({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = sv.panoUrl;
  }, [sv.panoUrl]);

  // Pano display geometry: fit the panorama's full height (its vfov) to the stage, so
  // the visible horizontal window is however many degrees fill the width (~90–120°).
  const panoDisplayScale = panoNat.h ? size.h / panoNat.h : 0;
  const panoDisplayW = panoNat.w * panoDisplayScale; // full 360° width, on screen
  const panoPxPerDeg = panoDisplayW / 360;
  const windowFovDeg = panoPxPerDeg > 0 ? size.w / panoPxPerDeg : 90;
  const panoBgPosX = size.w / 2 - (((viewAz % 360) + 360) % 360) * panoPxPerDeg;

  // Where the image paints inside the stage. Pano fills the whole stage; video/frames
  // letterbox (object-fit: contain), so the HUD must use the contain-fit rect there.
  const fit = useMemo(() => {
    if (mode === 'pano') return { left: 0, top: 0, w: size.w, h: size.h };
    const { w, h } = size;
    if (!w || !h || !mediaSize.w || !mediaSize.h) return { left: 0, top: 0, w, h };
    const scale = Math.min(w / mediaSize.w, h / mediaSize.h);
    const fw = mediaSize.w * scale;
    const fh = mediaSize.h * scale;
    return { left: (w - fw) / 2, top: (h - fh) / 2, w: fw, h: fh };
  }, [mode, size, mediaSize]);

  // ── Look-around drag ── capture is DEFERRED until the move crosses the threshold,
  // so a tap on a neighbour button is never stolen by the stage's pointer capture.
  const draggable = mode === 'pano' || frameCount > 1;
  const dragRef = useRef<{ startX: number; startFrame: number; startAz: number; captured: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggable) return;
    if ((e.target as HTMLElement).closest('.sv-neighbor')) return; // let the button handle its click
    dragRef.current = { startX: e.clientX, startFrame: frame, startAz: viewAz, captured: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // Temperature probe: read °C under the cursor (works while hovering AND dragging,
    // in both the panorama and the single-frame window — the temp pano covers 360°).
    if (probeOn && temp.ready && stageRef.current) {
      const rect = stageRef.current.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      let az: number;
      let yFrac: number;
      let inside = true;
      if (mode === 'pano' && panoPxPerDeg > 0) {
        az = viewAz + (mx - size.w / 2) / panoPxPerDeg;
        yFrac = my / size.h;
      } else {
        // video/frames: map within the contain-fit image rect; the frame spans one HFOV.
        const xf = (mx - fit.left) / fit.w;
        yFrac = (my - fit.top) / fit.h;
        inside = xf >= 0 && xf <= 1 && yFrac >= 0 && yFrac <= 1;
        const centerAz = typeof sv.azimuthDeg[frame - 1] === 'number' ? sv.azimuthDeg[frame - 1] : NaN;
        az = centerAz + (xf - 0.5) * STREET_VIEW_HFOV;
      }
      setProbe(inside && Number.isFinite(az) ? { x: mx, y: my, t: temp.sampleAt(az / 360, yFrac) } : null);
    }
    const d = dragRef.current;
    if (!d) return;
    const dxCss = e.clientX - d.startX;
    if (!d.captured) {
      if (Math.abs(dxCss) < DRAG_THRESHOLD_PX) return; // still a potential tap
      d.captured = true;
      try {
        stageRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported — dragging still works via move events */
      }
    }
    if (mode === 'pano') {
      // Drag RIGHT → scene follows the finger → look toward an earlier bearing.
      if (panoPxPerDeg > 0) setViewAz(d.startAz - dxCss / panoPxPerDeg);
    } else {
      const dxPx = dxCss * (window.devicePixelRatio || 1);
      setFrame(panToFrameSeek(d.startFrame, dxPx, frameCount));
    }
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.captured) {
      try {
        stageRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    }
  };

  // ── Frame-based single-flight video seek merger (app pumpSeek parity) ──
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekingRef = useRef(false);
  const pendingFrameRef = useRef<number | null>(null);
  const soughtFrameRef = useRef<number | null>(null);
  const metaReadyRef = useRef(false);

  const frameToTime = useCallback(
    (f: number, v: HTMLVideoElement) => {
      const dur = sv.videoDurationSec ?? (Number.isFinite(v.duration) ? v.duration : 0);
      if (dur <= 0) return 0;
      const t = ((f - 0.5) / frameCount) * dur;
      // Clamp against what the player can actually honour (real duration / seekable
      // end), so a near-EOS target can't sit forever short of the request.
      let end = Number.isFinite(v.duration) ? v.duration : dur;
      if (v.seekable && v.seekable.length > 0) {
        end = Math.min(end, v.seekable.end(v.seekable.length - 1));
      }
      const hi = Number.isFinite(end) && end > 0 ? end - 0.05 : Infinity;
      return Math.max(0, Math.min(t, hi));
    },
    [sv.videoDurationSec, frameCount],
  );

  const pumpSeek = useCallback(() => {
    const v = videoRef.current;
    if (!v || !metaReadyRef.current || seekingRef.current) return;
    const target = pendingFrameRef.current;
    if (target == null || target === soughtFrameRef.current) return;
    soughtFrameRef.current = target;
    seekingRef.current = true;
    try {
      v.currentTime = frameToTime(target, v);
    } catch {
      seekingRef.current = false;
    }
  }, [frameToTime]);

  const requestFrame = useCallback(
    (f: number) => {
      pendingFrameRef.current = f;
      pumpSeek();
    },
    [pumpSeek],
  );

  const onSeeked = () => {
    seekingRef.current = false;
    pumpSeek(); // pump the newest pending frame if the target moved during the seek
  };

  const onLoadedMetadata = () => {
    const v = videoRef.current;
    if (v) setMediaSize({ w: v.videoWidth, h: v.videoHeight });
    metaReadyRef.current = true;
    // Prime the decoder (harmless muted play/pause) so paused seeks paint reliably,
    // notably on iOS Safari; then seek to the current frame.
    v
      ?.play()
      .then(() => v.pause())
      .catch(() => {});
    requestFrame(frame);
  };

  useEffect(() => {
    if (isVideo) requestFrame(frame);
  }, [frame, isVideo, requestFrame]);

  // Expand/collapse, carrying the look direction across the mode switch: entering the
  // pano faces the current frame's bearing; returning picks the frame nearest the look.
  const applyExpand = useCallback(
    (next: boolean) => {
      if (next && sv.panoUrl) {
        const az = sv.azimuthDeg[frame - 1];
        if (typeof az === 'number') setViewAz(az);
      } else if (!next && sv.azimuthDeg.length) {
        setFrame(closestFrameToAzimuth(sv.azimuthDeg, viewAz));
      }
      setExpanded(next);
    },
    [sv.panoUrl, sv.azimuthDeg, frame, viewAz],
  );

  // Escape collapses first (exit full screen), then closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (expanded) applyExpand(false);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, applyExpand, onClose]);

  // Compass inputs depend on the mode: pano tracks the free look angle over the whole
  // window FOV; video/frames read the current frame's azimuth/pitch over the camera FOV.
  const compassAz =
    mode === 'pano' ? viewAz : typeof sv.azimuthDeg[frame - 1] === 'number' ? sv.azimuthDeg[frame - 1] : NaN;
  const compassPitch = mode === 'pano' ? 0 : typeof sv.pitchDeg[frame - 1] === 'number' ? sv.pitchDeg[frame - 1] : NaN;
  const compassHfov = mode === 'pano' ? windowFovDeg : undefined; // undefined → the 43° camera FOV
  const frameSrc = mode === 'frames' ? storageUrl(`streetviews/${sv.svId}/data_${frame}.png`) : null;

  // The temp-grid columns currently on screen — so the histogram reflects the CURRENT
  // view (the frame's 43° in the small window, the ~90–120° window in the panorama),
  // not the whole 360°.
  const histCols = useMemo(() => {
    const gw = temp.data?.w ?? 0;
    if (!gw) return { start: 0, count: 0 };
    const azSpan = mode === 'pano' ? Math.min(360, windowFovDeg || 90) : STREET_VIEW_HFOV;
    const azCenter =
      mode === 'pano' ? viewAz : typeof sv.azimuthDeg[frame - 1] === 'number' ? sv.azimuthDeg[frame - 1] : 0;
    const count = Math.max(1, Math.min(gw, Math.round((azSpan / 360) * gw)));
    const start = ((Math.round(((azCenter - azSpan / 2) / 360) * gw) % gw) + gw) % gw;
    return { start, count };
  }, [temp.data, mode, windowFovDeg, viewAz, sv.azimuthDeg, frame]);

  // Reporting is offered to everyone, signed in or not: whoever recognises a problem on this
  // map is usually a passer-by, not an account holder. Hiding an author needs an account,
  // because the list of who you have hidden is stored against one.
  const moderationItems: MenuProps['items'] = [];
  if (onReport) {
    moderationItems.push({ key: 'report-sv', label: 'Report this street view', onClick: () => onReport('streetview') });
    moderationItems.push({ key: 'report-author', label: 'Report this author', onClick: () => onReport('author') });
  }
  if (onBlockAuthor) {
    moderationItems.push({ key: 'block', label: 'Hide this author', onClick: onBlockAuthor });
  }
  if (onTakeDown) {
    moderationItems.push({ type: 'divider', key: 'staff-divider' });
    moderationItems.push({ key: 'takedown', danger: true, label: 'Take down (staff)', onClick: onTakeDown });
  }

  return (
    <div className="sv-viewer" role="dialog" aria-label={sv.title}>
      <div className="sv-viewer-backdrop" onClick={onClose} />
      <div className={`sv-viewer-frame${expanded ? ' sv-viewer-frame-expanded' : ''}`}>
        <div
          className="sv-viewer-stage"
          ref={stageRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => setProbe(null)}
          style={{ cursor: probeOn ? 'crosshair' : draggable ? 'grab' : 'default' }}
        >
          {mode === 'pano' ? (
            <div
              className="sv-viewer-media sv-pano"
              style={{
                backgroundImage: `url(${sv.panoUrl})`,
                backgroundRepeat: 'repeat-x',
                backgroundSize: `auto ${size.h}px`,
                backgroundPositionX: `${panoBgPosX}px`,
                backgroundPositionY: 'center',
              }}
            />
          ) : mode === 'video' ? (
            <video
              ref={videoRef}
              className="sv-viewer-media"
              src={videoSrc ?? undefined}
              muted
              playsInline
              preload="auto"
              onLoadedMetadata={onLoadedMetadata}
              onSeeked={onSeeked}
              draggable={false}
            />
          ) : (
            <img
              className="sv-viewer-media"
              src={frameSrc ?? undefined}
              alt={sv.title}
              draggable={false}
              onLoad={(e) => setMediaSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            />
          )}
          {/* Isotherm overlay — highlights the selected °C band, aligned to the pano
              (pans with it) or to the current frame's slice in the small window. */}
          {isoOn &&
            isoUrl &&
            (mode === 'pano' ? (
              <div
                className="sv-iso-layer"
                style={{
                  left: 0,
                  top: 0,
                  width: size.w,
                  height: size.h,
                  backgroundImage: `url(${isoUrl})`,
                  backgroundRepeat: 'repeat-x',
                  backgroundSize: `auto ${size.h}px`,
                  backgroundPositionX: `${panoBgPosX}px`,
                  backgroundPositionY: 'center',
                }}
              />
            ) : (
              fit.w > 0 && (
                <div
                  className="sv-iso-layer"
                  style={(() => {
                    const centerAz = typeof sv.azimuthDeg[frame - 1] === 'number' ? sv.azimuthDeg[frame - 1] : 0;
                    const fullW = (fit.w * 360) / STREET_VIEW_HFOV;
                    const leftAz = ((((centerAz - STREET_VIEW_HFOV / 2) % 360) + 360) % 360) / 360;
                    return {
                      left: fit.left,
                      top: fit.top,
                      width: fit.w,
                      height: fit.h,
                      backgroundImage: `url(${isoUrl})`,
                      backgroundRepeat: 'repeat-x',
                      backgroundSize: `${fullW}px ${fit.h}px`,
                      backgroundPositionX: `${-leftAz * fullW}px`,
                      backgroundPositionY: 'top',
                    };
                  })()}
                />
              )
            ))}

          {/* HUD sized+positioned to where the image paints (pano: full stage). */}
          <div
            className="sv-compass-fit"
            style={{ position: 'absolute', left: fit.left, top: fit.top, width: fit.w, height: fit.h }}
          >
            <StreetViewCompass
              width={fit.w}
              height={fit.h}
              azimuthDeg={compassAz}
              pitchDeg={compassPitch}
              neighbors={sv.neighbors}
              onNeighbor={(id) => onNeighbor(id, compassAz)}
              timestampMs={sv.capturedAt}
              hfov={compassHfov}
            />
          </div>

          {/* Temperature probe read-out following the cursor. */}
          {probeOn && probe && (
            <div className="sv-probe" style={{ left: probe.x, top: probe.y }}>
              {probe.t == null ? '—' : `${probe.t.toFixed(1)}°C`}
            </div>
          )}

          {/* Heatmap scale bar (palette ramp + °C range). */}
          {scaleOn && temp.ready && (
            <div className="sv-scalebar">
              <span>{Math.round(temp.tMax)}°</span>
              <div className="sv-scale-grad" style={{ backgroundImage: INFERNO_CSS }} />
              <span>{Math.round(temp.tMin)}°</span>
            </div>
          )}
        </div>

        {/* Thermal tools — probe reads °C under the cursor; scale shows the ramp. Shown
            in both the small window and full screen whenever a temp pano exists. */}
        {sv.panoTempUrl && (
          <div className="sv-tools">
            <button
              type="button"
              className={`sv-tool${probeOn ? ' active' : ''}`}
              onClick={() => setProbeOn((v) => !v)}
              disabled={!temp.ready}
              title={temp.error ? 'Temperature unavailable' : 'Temperature probe (read °C under the cursor)'}
            >
              Probe
            </button>
            <button
              type="button"
              className={`sv-tool${scaleOn ? ' active' : ''}`}
              onClick={() => setScaleOn((v) => !v)}
              disabled={!temp.ready}
              title="Heatmap scale bar"
            >
              Scale
            </button>
            <button
              type="button"
              className={`sv-tool${histOn ? ' active' : ''}`}
              onClick={() => setHistOn((v) => !v)}
              disabled={!temp.ready}
              title="Temperature histogram"
            >
              Hist
            </button>
            <button
              type="button"
              className={`sv-tool${isoOn ? ' active' : ''}`}
              onClick={() => setIsoOn((v) => !v)}
              disabled={!temp.ready}
              title="Isotherms (highlight a °C band)"
            >
              Iso
            </button>
          </div>
        )}

        {/* Analysis panels (histogram + isotherm band slider), bottom-centre. */}
        {(histOn || isoOn) && temp.ready && (
          <div className="sv-analysis">
            {histOn && temp.data && (
              <StreetViewHistogram
                grid={temp.data.grid}
                valid={temp.data.valid}
                w={temp.data.w}
                h={temp.data.h}
                colStart={histCols.start}
                colCount={histCols.count}
                lo={temp.pLow}
                hi={temp.pHigh}
              />
            )}
            {isoOn && isoLevels && (
              <div className="sv-iso-legend" onPointerDown={(e) => e.stopPropagation()}>
                <div className="sv-iso-head">
                  <span>Isotherms (°C)</span>
                  <button
                    type="button"
                    className="sv-iso-btn"
                    title="Reset to evenly-spaced levels"
                    onClick={() => setIsoLevels(null)}
                  >
                    Auto
                  </button>
                </div>
                {isoLevels
                  .map((v, i) => ({ v, i }))
                  .sort((a, b) => b.v - a.v)
                  .map(({ v, i }) => (
                    <div key={i} className="sv-iso-row">
                      <span className="sv-iso-swatch" style={{ background: isothermColor(i, isoLevels.length) }} />
                      <InputNumber
                        size="small"
                        value={Number(v.toFixed(1))}
                        step={0.5}
                        controls={false}
                        onChange={(nv) => editLevel(i, nv)}
                        style={{ width: 60 }}
                      />
                      {isoLevels.length > 1 && (
                        <button
                          type="button"
                          className="sv-iso-btn"
                          title="Remove this level"
                          onClick={() => removeLevel(i)}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                {isoLevels.length < 8 && (
                  <button type="button" className="sv-iso-btn sv-iso-add" onClick={addLevel}>
                    + Add level
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div className="sv-viewer-bar">
          <span className="sv-viewer-title">
            {sv.title}
            {sv.author ? ` — ${sv.author}` : ''}
          </span>
          <span className="sv-viewer-bar-right">
            {draggable && (
              <span className="sv-viewer-hint">
                {mode === 'pano' ? `Drag to look around · ${normalizeDeg(viewAz).toFixed(0)}°` : 'Drag to look around'}
              </span>
            )}
            {moderationItems.length > 0 && (
              <Dropdown menu={{ items: moderationItems }} trigger={['click']} placement="topRight">
                <button type="button" className="sv-viewer-more" aria-label="More" title="More">
                  <MoreOutlined />
                </button>
              </Dropdown>
            )}
          </span>
        </div>
        {sv.panoUrl && (
          <button
            className="sv-viewer-expand"
            type="button"
            aria-label={expanded ? 'Exit full screen' : 'Full screen panorama'}
            title={expanded ? 'Exit full screen' : 'Full screen panorama'}
            onClick={() => applyExpand(!expanded)}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
              <path d={expanded ? FS_EXIT : FS_ENTER} />
            </svg>
          </button>
        )}
        <button className="sv-viewer-close" type="button" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  );
}
