/*
 * StreetViewViewer — the look-around panorama, the web counterpart of the app's
 * PlaybackScreen street-view mode. Three render modes (preference order):
 *   1. pano   — a wide equirectangular panorama (sv.panoUrl, stitchAll.mjs) shown
 *      through a viewport window; dragging PANS horizontally around the full 360°
 *      (Google-Street-View feel). Widest FOV, cheapest runtime (no video seeking).
 *   2. video  — a frame-seek panorama over sv.streamUrl (all-intra) or the legacy
 *      sv.virUrl→.mp4 fallback; dragging scrubs the frame index → a seek time. An
 *      upload gets its streams from the onStreetViewCreated bake (functions/src/
 *      streetViewBake.ts): one per view it was captured with (blended / thermal /
 *      visible), switchable from the ⋮ menu — so it looks around like the seeded map.
 *   3. frames — app-native per-frame data_N.png in Storage (no video): an upload the
 *      bake has not reached yet (it runs within a minute of the doc landing).
 *
 * The FRAME-based video merger mirrors the app's pumpSeek: track the pending frame,
 * seek one at a time, and on each `seeked` clear the in-flight flag then pump the
 * newest pending frame — never chase achieved currentTime (which can clamp near EOS
 * and loop). The compass HUD is sized to where the image actually paints (the
 * contain-fit rect for video/frames; the full stage for pano) so its bearing/pitch
 * lines and neighbour markers line up.
 *
 * Frames mode LOOKS AROUND like the panorama rather than scrubbing: the drag moves a
 * continuous heading 1:1 with the picture, the frame is derived from it, and a canvas
 * paints whichever frame is nearest in memory shifted by the angle between the two
 * (useStreetViewFrames). Pointing an <img> at one 400 KB uncacheable frame per pointer
 * move is what used to make an upload lag a second behind the hand.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Dropdown, InputNumber } from 'antd';
import { MoreOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { STREET_VIEW_HFOV, closestFrameToAzimuth, normalizeDeg, panToFrameSeek } from '../../utils/streetViewPano';
import { autoLevels, computePanoIsotherms, isothermColor } from '../../utils/panoIsotherms';
import { normalizePaletteName, paletteGradientCss } from '../../utils/palette';
import { usePanoTemperature } from '../../hooks/usePanoTemperature';
import { useStreetViewFrameTemperature } from '../../hooks/useStreetViewFrameTemperature';
import { useStreetViewFrames } from '../../hooks/useStreetViewFrames';
import StreetViewCompass from './streetViewCompass';
import StreetViewHistogram from './streetViewHistogram';
import type { StreetView, StreetViewTrack } from '../../types';

// matplotlib "inferno" (the palette the seeded map was BAKED with) as a vertical CSS ramp
// for the scale bar. An app upload is rendered on the camera instead, with one of the FLIR
// palettes named in its doc — usually iron — so the bar reads that (see scaleGradient).
const INFERNO_CSS = 'linear-gradient(to top, #000004, #280b54, #65156e, #9f2a63, #d44842, #f57d15, #fac228, #fcffa4)';

/** How far (CSS px) the pointer must move before a press becomes a look-around drag.
 *  Below this we DON'T capture the pointer, so a tap still reaches the neighbour buttons. */
const DRAG_THRESHOLD_PX = 3;

// Material fullscreen enter/exit glyphs (24×24).
const FS_ENTER = 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z';
const FS_EXIT = 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z';

/** The views a baked upload can be switched between, in the app's own menu order. */
const TRACK_VIEWS: readonly StreetViewTrack[] = ['blended', 'ir', 'visible'];
const TRACK_LABEL: Record<StreetViewTrack, string> = {
  blended: 'Blended (MSX)',
  ir: 'Thermal',
  visible: 'Visible light',
};

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

  // The views a baked upload offers, and the one being looked at: null = the doc's default
  // stream (streamUrl), which is what a seeded panorama (one clip, no choice) always shows.
  const trackUrls = useMemo<Record<StreetViewTrack, string | undefined>>(
    () => ({ blended: sv.streamMixUrl, ir: sv.streamIrUrl, visible: sv.streamVisUrl }),
    [sv.streamMixUrl, sv.streamIrUrl, sv.streamVisUrl],
  );
  const availableViews = useMemo(() => TRACK_VIEWS.filter((v) => !!trackUrls[v]), [trackUrls]);
  const [view, setView] = useState<StreetViewTrack | null>(null);
  const currentView: StreetViewTrack | null = view ?? sv.streamView ?? null;

  const videoSrc = useMemo(() => {
    const picked = view ? trackUrls[view] : undefined;
    if (picked) return picked;
    if (sv.streamUrl) return sv.streamUrl;
    if (sv.virUrl) return sv.virUrl.replace(/\.vir$/i, '.mp4');
    return null;
  }, [view, trackUrls, sv.streamUrl, sv.virUrl]);

  // Default = the compact single-frame look-around (as before); the wide stitched
  // panorama is shown only after the user expands to full screen (and only when a pano
  // has been baked). So the pano is the "expanded" experience, not the default.
  const [expanded, setExpanded] = useState(false);
  const mode: 'pano' | 'video' | 'frames' = expanded && sv.panoUrl ? 'pano' : videoSrc ? 'video' : 'frames';
  const isVideo = mode === 'video';

  // Frame index the VIDEO is seeked to. Face the arrival heading on open, else frame 1.
  const [frame, setFrame] = useState(() =>
    initialAzimuth != null && sv.azimuthDeg.length ? closestFrameToAzimuth(sv.azimuthDeg, initialAzimuth) : 1,
  );
  // Look direction in degrees (pano + frames). Face the arrival heading, else the first frame's.
  const [viewAz, setViewAz] = useState(() => initialAzimuth ?? sv.azimuthDeg[0] ?? 0);

  // In the panorama and in a frame sweep the heading is continuous and the frame is derived
  // from it; only the video keeps a frame index of its own, because there a drag scrubs a
  // seek rather than turning a head.
  const targetFrame = useMemo(
    () => (mode === 'frames' && sv.azimuthDeg.length ? closestFrameToAzimuth(sv.azimuthDeg, viewAz) : frame),
    [mode, sv.azimuthDeg, viewAz, frame],
  );
  const frames = useStreetViewFrames(sv.svId, frameCount, targetFrame, mode === 'frames');
  // What actually gets painted: the nearest frame ALREADY decoded, shifted by the angle
  // between it and where the viewer is facing (imgDx below). That is what keeps the picture
  // under the pointer — the exact frame lands a moment later and the shift falls to ~0.
  const shownFrame = mode === 'frames' ? (frames.nearest(targetFrame) ?? targetFrame) : targetFrame;

  // Thermal tools: °C comes from the baked temperature panorama where there is one (the
  // seeded map, in both the small window and full screen), and otherwise — on every app
  // upload, whose bake is streams only, no temperature panorama — from the shown frame's own
  // data_N.dat, whether that frame is painted from the frame cache or sought in the video.
  // Both answer a point in °C; what differs is the space, 360° of azimuth against one
  // frame's width.
  // The scale bar has to show the ramp the pictures were actually rendered with, or a colour
  // on the bar means nothing on the image: the bake is inferno, an upload names its own FLIR
  // palette (AGC puts the frame's coldest pixel at one end of it and the hottest at the other).
  const scaleGradient = useMemo(() => {
    const key = normalizePaletteName(sv.palette);
    return (key && paletteGradientCss(key, 24, 'to top')) || INFERNO_CSS;
  }, [sv.palette]);

  const usingFrameTemp = mode !== 'pano' && !sv.panoTempUrl;
  const panoTemp = usePanoTemperature(sv.panoTempUrl, sv.tMin, sv.tMax);
  const frameTemp = useStreetViewFrameTemperature(sv.svId, shownFrame, usingFrameTemp);
  const temp = usingFrameTemp ? frameTemp : panoTemp;
  const hasThermal = !!sv.panoTempUrl || (usingFrameTemp && !frameTemp.error);
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
  // the viewer lays it over the pano (pans for free) or the current frame's slice. Only
  // the BAKED source goes through a raster: a frame source changes grid on every frame
  // dragged past, and re-encoding a PNG that often would stutter the drag, so those
  // contours are stroked straight onto the frame canvas instead (see the draw below).
  const isoUrl = useMemo(() => {
    if (!isoOn || usingFrameTemp || !temp.data || !isoLevels || isoLevels.length === 0) return null;
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
  }, [isoOn, usingFrameTemp, temp.data, isoLevels]);

  // The same contours for a frame source, kept as line geometry in [0,1] for the canvas.
  const frameIsoLines = useMemo(
    () =>
      isoOn && usingFrameTemp && temp.data && isoLevels?.length
        ? computePanoIsotherms(temp.data.grid, temp.data.w, temp.data.h, isoLevels)
        : null,
    [isoOn, usingFrameTemp, temp.data, isoLevels],
  );

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

  // How big the picture is: a video reports its own on loadedmetadata, and the frame cache
  // knows it as soon as the first bitmap decodes (they are all one size).
  const media = mode === 'frames' ? frames.natural : mediaSize;

  // Where the image paints inside the stage. Pano fills the whole stage; video/frames
  // letterbox (object-fit: contain), so the HUD must use the contain-fit rect there.
  const fit = useMemo(() => {
    if (mode === 'pano') return { left: 0, top: 0, w: size.w, h: size.h };
    const { w, h } = size;
    if (!w || !h || !media?.w || !media?.h) return { left: 0, top: 0, w, h };
    const scale = Math.min(w / media.w, h / media.h);
    const fw = media.w * scale;
    const fh = media.h * scale;
    return { left: (w - fw) / 2, top: (h - fh) / 2, w: fw, h: fh };
  }, [mode, size, media]);

  // A frame picture spans one camera FOV, so the whole of its width is 43° — the scale the
  // drag turns at and the shift the painted frame is drawn with.
  const framePxPerDeg = fit.w / STREET_VIEW_HFOV;
  const shownFrameAz = sv.azimuthDeg[shownFrame - 1];
  const imgDx =
    mode === 'frames' && typeof shownFrameAz === 'number' ? normalizeDeg(shownFrameAz - viewAz) * framePxPerDeg : 0;

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
      let xFrac: number;
      let yFrac: number;
      let inside = true;
      if (mode === 'pano' && panoPxPerDeg > 0) {
        az = viewAz + (mx - size.w / 2) / panoPxPerDeg;
        yFrac = my / size.h;
        xFrac = 0; // unused: a baked source is addressed by azimuth, not by picture position
      } else {
        // video/frames: map within the contain-fit image rect (shifted by imgDx when the
        // painted frame isn't the one being faced); the picture spans one HFOV.
        xFrac = (mx - fit.left - imgDx) / fit.w;
        yFrac = (my - fit.top) / fit.h;
        inside = xFrac >= 0 && xFrac <= 1 && yFrac >= 0 && yFrac <= 1;
        const centerAz = typeof shownFrameAz === 'number' ? shownFrameAz : NaN;
        az = centerAz + (xFrac - 0.5) * STREET_VIEW_HFOV;
      }
      // The baked source is addressed by azimuth across 360°, a frame's own by where the
      // point falls across that frame.
      const readable = inside && (usingFrameTemp || Number.isFinite(az));
      setProbe(readable ? { x: mx, y: my, t: temp.sampleAt(usingFrameTemp ? xFrac : az / 360, yFrac) } : null);
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
    } else if (mode === 'frames' && sv.azimuthDeg.length && framePxPerDeg > 0) {
      // Same 1:1 grab as the panorama — the picture stays under the pointer — except the
      // scale is the camera's 43°, since that is all one frame covers. A sweep with no
      // recorded bearings has no heading to turn, so it falls through to the frame scrub.
      setViewAz(d.startAz - dxCss / framePxPerDeg);
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

  // A view switch swaps the <video> source: the new element starts at 0 and knows nothing
  // of the frame being faced, so forget what was sought and let its own loadedmetadata
  // re-seek to the current frame (otherwise the merger sees "already there" and never moves).
  useEffect(() => {
    metaReadyRef.current = false;
    seekingRef.current = false;
    soughtFrameRef.current = null;
    pendingFrameRef.current = null;
  }, [videoSrc]);

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

  // ── Frames mode paint ── one canvas, drawn before the browser paints (a layout effect,
  // so the picture moves in the same frame as the pointer). The shown frame is placed at
  // the angle it was taken at relative to where the viewer is facing, so a drag slides it
  // continuously and a newly-arrived exact frame drops into place without a jump. The
  // isotherms are stroked straight on afterwards, in the same shifted rect. In video mode
  // the same canvas lies OVER the <video> and carries only the contours (the picture is
  // the video's own), so an upload's isotherms survive its bake.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const cv = canvasRef.current;
    if (!cv || mode === 'pano' || size.w <= 0 || size.h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.round(size.w * dpr);
    const pxH = Math.round(size.h * dpr);
    if (cv.width !== pxW || cv.height !== pxH) {
      cv.width = pxW;
      cv.height = pxH;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (mode === 'frames') {
      const bmp = frames.get(shownFrame);
      if (!bmp) return;
      ctx.drawImage(bmp, fit.left + imgDx, fit.top, fit.w, fit.h);
    }
    if (!frameIsoLines) return;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    frameIsoLines.forEach((line, li) => {
      ctx.strokeStyle = isothermColor(li, frameIsoLines.length);
      ctx.beginPath();
      for (const s of line.segments) {
        ctx.moveTo(fit.left + imgDx + s[0] * fit.w, fit.top + s[1] * fit.h);
        ctx.lineTo(fit.left + imgDx + s[2] * fit.w, fit.top + s[3] * fit.h);
      }
      ctx.stroke();
    });
  }, [mode, size, fit, imgDx, shownFrame, frames, frameIsoLines]);

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

  // Compass inputs depend on the mode: pano and frames track the free look angle (frames
  // over the camera's FOV, since the picture is shifted to match); the video reads the
  // sought frame's own azimuth. The pitch line always belongs to the picture on screen,
  // which in frames mode is the frame painted rather than the one faced.
  const compassAz =
    mode === 'video' ? (typeof sv.azimuthDeg[frame - 1] === 'number' ? sv.azimuthDeg[frame - 1] : NaN) : viewAz;
  const pitchFrame = mode === 'video' ? frame : shownFrame;
  const compassPitch =
    mode === 'pano' ? 0 : typeof sv.pitchDeg[pitchFrame - 1] === 'number' ? sv.pitchDeg[pitchFrame - 1] : NaN;
  const compassHfov = mode === 'pano' ? windowFovDeg : undefined; // undefined → the 43° camera FOV

  // The temp-grid columns currently on screen — so the histogram reflects the CURRENT
  // view (the frame's 43° in the small window, the ~90–120° window in the panorama),
  // not the whole 360°. A frame source is ALREADY only what is on screen, so it is read
  // whole.
  const histCols = useMemo(() => {
    const gw = temp.data?.w ?? 0;
    if (!gw) return { start: 0, count: 0 };
    if (usingFrameTemp) return { start: 0, count: gw };
    const azSpan = mode === 'pano' ? Math.min(360, windowFovDeg || 90) : STREET_VIEW_HFOV;
    const azCenter = mode === 'pano' ? viewAz : typeof shownFrameAz === 'number' ? shownFrameAz : 0;
    const count = Math.max(1, Math.min(gw, Math.round((azSpan / 360) * gw)));
    const start = ((Math.round(((azCenter - azSpan / 2) / 360) * gw) % gw) + gw) % gw;
    return { start, count };
  }, [temp.data, usingFrameTemp, mode, windowFovDeg, viewAz, shownFrameAz]);

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
  // The views a baked upload was captured with — the same three the app's player offers for
  // the capture itself. One view (or a seeded clip) is no choice, so no menu.
  const menuItems: MenuProps['items'] = [];
  if (availableViews.length > 1) {
    menuItems.push({
      type: 'group',
      key: 'view',
      label: 'View',
      children: availableViews.map((v) => ({
        key: `view-${v}`,
        label: `${v === currentView ? '✓ ' : '   '}${TRACK_LABEL[v]}`,
        onClick: () => setView(v),
      })),
    });
    if (moderationItems.length > 0) menuItems.push({ type: 'divider', key: 'view-divider' });
  }
  menuItems.push(...moderationItems);

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
            <>
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
              {/* The frame's isotherms, stroked over the video (see the draw effect). */}
              <canvas ref={canvasRef} className="sv-viewer-canvas sv-iso-canvas" aria-hidden="true" />
            </>
          ) : (
            // The frames are painted (see the draw effect): one canvas the whole stage
            // wide, with the picture placed inside it at the angle it belongs at.
            <canvas ref={canvasRef} className="sv-viewer-media sv-viewer-canvas" role="img" aria-label={sv.title} />
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
                    const centerAz = typeof shownFrameAz === 'number' ? shownFrameAz : 0;
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
              <div className="sv-scale-grad" style={{ backgroundImage: scaleGradient }} />
              <span>{Math.round(temp.tMin)}°</span>
            </div>
          )}
        </div>

        {/* Thermal tools — probe reads °C under the cursor; scale shows the ramp. Shown
            in both the small window and full screen whenever temperatures can be read:
            from the baked temperature panorama, or from an upload's per-frame data_N.dat. */}
        {hasThermal && (
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
                {mode === 'video' ? 'Drag to look around' : `Drag to look around · ${normalizeDeg(viewAz).toFixed(0)}°`}
              </span>
            )}
            {menuItems.length > 0 && (
              <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="topRight">
                <button type="button" className="sv-viewer-more" aria-label="More" title="More">
                  <MoreOutlined />
                </button>
              </Dropdown>
            )}
          </span>
        </div>
        {/* Full screen: the stitched panorama where there is one, and otherwise just a
            bigger window on the same picture — which an upload, frames or stream, has as
            much use for. */}
        {(sv.panoUrl || mode !== 'pano') && (
          <button
            className="sv-viewer-expand"
            type="button"
            aria-label={expanded ? 'Exit full screen' : 'Full screen'}
            title={expanded ? 'Exit full screen' : 'Full screen'}
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
