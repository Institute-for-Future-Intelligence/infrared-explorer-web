/*
 * StreetViewViewer — the look-around panorama, the web counterpart of the app's
 * PlaybackScreen street-view mode. The pixels come from one of three sources (in
 * preference order):
 *   1. sv.streamUrl  — an all-intra, browser-seekable mp4 in Storage (streamAll.mjs).
 *   2. sv.virUrl→.mp4 — the legacy clip on intofuture.org (plays, but seeks are
 *      pricier since it isn't all-intra). A graceful fallback until streamAll runs.
 *   3. data_N.png    — app-native per-frame images in Storage (no video).
 *
 * "Looking around" scrubs the frame index: a horizontal drag maps to a frame via
 * panToFrameSeek (Java-parity, physical px), and for the video sources the frame
 * maps to a seek time ((frame−0.5)/frameCount × contentDuration). The seek merger
 * is FRAME-based (mirrors the app's pumpSeek): it tracks the pending frame, seeks
 * one at a time, and on each `seeked` unconditionally clears the in-flight flag
 * then pumps the newest pending frame — so it never chases achieved currentTime
 * (which could clamp near EOS and loop forever). The compass HUD (streetViewCompass)
 * is sized to the CONTAIN-FIT rect of the image (not the letterboxed stage) so its
 * bearing/pitch lines and neighbour markers line up with where the frame paints.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { closestFrameToAzimuth, panToFrameSeek } from '../../utils/streetViewPano';
import StreetViewCompass from './streetViewCompass';
import type { StreetView } from '../../types';

const BUCKET = 'infrared-explorer.appspot.com';

/** How far (CSS px) the pointer must move before a press becomes a look-around drag.
 *  Below this we DON'T capture the pointer, so a tap still reaches the neighbour buttons. */
const DRAG_THRESHOLD_PX = 3;

/** Public download URL for a Storage object (streetviews/** is anonymously readable). */
function storageUrl(path: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/` + encodeURIComponent(path) + '?alt=media';
}

interface Props {
  sv: StreetView;
  onClose: () => void;
  /** Jump to a neighbour; the page resolves svId against the loaded set. */
  onNeighbor: (svId: string, fromAzimuth: number) => void;
  /** Heading to face on open (from the street view we arrived from), if any. */
  initialAzimuth?: number;
}

export default function StreetViewViewer({ sv, onClose, onNeighbor, initialAzimuth }: Props) {
  const frameCount = Math.max(1, sv.frameCount || sv.azimuthDeg.length || 1);

  const videoSrc = useMemo(() => {
    if (sv.streamUrl) return sv.streamUrl;
    if (sv.virUrl) return sv.virUrl.replace(/\.vir$/i, '.mp4');
    return null;
  }, [sv.streamUrl, sv.virUrl]);
  const isVideo = videoSrc != null;

  // Face the arrival heading on open (neighbour jump), else frame 1. Re-runs on the
  // key-remount the page does when `sv` changes.
  const [frame, setFrame] = useState(() =>
    initialAzimuth != null && sv.azimuthDeg.length ? closestFrameToAzimuth(sv.azimuthDeg, initialAzimuth) : 1,
  );

  // Stage box (letterbox container) and the media's natural size → contain-fit rect.
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

  // Where the image actually paints inside the stage (object-fit: contain). The HUD
  // must use THIS rect, or its bearing/pitch lines land in the black bars.
  const fit = useMemo(() => {
    const { w, h } = size;
    if (!w || !h || !mediaSize.w || !mediaSize.h) return { left: 0, top: 0, w, h };
    const scale = Math.min(w / mediaSize.w, h / mediaSize.h);
    const fw = mediaSize.w * scale;
    const fh = mediaSize.h * scale;
    return { left: (w - fw) / 2, top: (h - fh) / 2, w: fw, h: fh };
  }, [size, mediaSize]);

  // ── Look-around drag ── capture is DEFERRED until the move crosses the threshold,
  // so a tap on a neighbour button is never stolen by the stage's pointer capture.
  const dragRef = useRef<{ startX: number; startFrame: number; captured: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (frameCount <= 1) return;
    if ((e.target as HTMLElement).closest('.sv-neighbor')) return; // let the button handle its click
    dragRef.current = { startX: e.clientX, startFrame: frame, captured: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
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
    const dxPx = dxCss * (window.devicePixelRatio || 1);
    setFrame(panToFrameSeek(d.startFrame, dxPx, frameCount));
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

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const compassAz = typeof sv.azimuthDeg[frame - 1] === 'number' ? sv.azimuthDeg[frame - 1] : NaN;
  const compassPitch = typeof sv.pitchDeg[frame - 1] === 'number' ? sv.pitchDeg[frame - 1] : NaN;
  const frameSrc = !isVideo ? storageUrl(`streetviews/${sv.svId}/data_${frame}.png`) : null;

  return (
    <div className="sv-viewer" role="dialog" aria-label={sv.title}>
      <div className="sv-viewer-backdrop" onClick={onClose} />
      <div className="sv-viewer-frame">
        <div
          className="sv-viewer-stage"
          ref={stageRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{ cursor: frameCount > 1 ? 'grab' : 'default' }}
        >
          {isVideo ? (
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
          {/* HUD sized+positioned to the contain-fit rect so it tracks the image, not the letterbox. */}
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
            />
          </div>
        </div>

        <div className="sv-viewer-bar">
          <span className="sv-viewer-title">
            {sv.title}
            {sv.author ? ` — ${sv.author}` : ''}
          </span>
          {frameCount > 1 && <span className="sv-viewer-hint">Drag to look around</span>}
        </div>
        <button className="sv-viewer-close" type="button" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  );
}
