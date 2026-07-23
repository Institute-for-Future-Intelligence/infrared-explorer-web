import { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { Input, message } from 'antd';
import {
  AimOutlined,
  CaretRightOutlined,
  CloseOutlined,
  EditOutlined,
  PauseOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import styled from 'styled-components';
import { Experiment, ExperimentType, Thermometer } from '../../../types';
import useCommonStore, { MAX_KEY_MOMENTS } from '../../../stores/common';
import { useMappingIndex } from '../hooks';
import { displayTemp, formatDuration, temperatureSymbol } from '../../../utils/helpers';
import { fetchRecordingFrameBuffer, fetchRecordingFrameDataUrl } from '../../../utils/recordingFrame';
import { renderThermalFrameThumbnail } from '../../../utils/thermalThumbnail';
import { getThermometerValue } from '../../../utils/temperatureReader';

// Key moments = the owner's captioned timeline. Sitting in the Info tab under the description, each entry
// is a card — a thumbnail (a recording frame, or a false-colour render of the video's .vir frame, since a
// video has no CORS-safe frame image to fetch) with its time underneath — then, right beside it, the
// thermometer readings at that frame, and then the owner's note. Readings are recomputed from the frame's
// thermal data (never persisted), so they always reflect where the probes sit now; a range shows
// start → end so the temperature change over the span reads at a glance. A frame still loading, or one
// that can't be decoded, falls back to a flat teal block (and no readings). Clicking a thumbnail seeks the
// player to its (start) frame; a span additionally has a play button (bottom-left of the thumbnail) that
// plays start→end and toggles pause. The owner marks the current frame ("Mark this frame") or a range
// ("Mark a range" → play to the end → "End here"); re-points a frame two ways — typing its time under the
// thumbnail, or the "Set frame / Set start / Set end" buttons that snap it to the current player frame;
// and captions / removes each. A viewer of an empty timeline sees nothing; the owner always sees it.
const Section = styled.div`
  margin-top: 20px;
`;
const Header = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin-bottom: 10px;

  .km-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--ifi-ink);
  }
  .km-action {
    appearance: none;
    border: none;
    background: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: 4px;
    font: inherit;
    font-size: 13px;
    color: var(--ifi-teal-dark);
    cursor: pointer;
  }
  .km-action:hover {
    background: rgba(0, 140, 140, 0.08);
  }
  .km-action:disabled {
    color: var(--ifi-text-tertiary);
    cursor: default;
    background: none;
  }
  .km-pending {
    font-size: 13px;
    color: var(--ifi-text-secondary);
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .km-pending b {
    color: var(--ifi-ink);
  }
`;
const Empty = styled.p`
  margin: 0;
  font-size: 13px;
  color: var(--ifi-text-tertiary);
`;
// A responsive grid of hoverable entries. Each column grows to ~half the container (the 45% floor makes
// exactly two columns fit and 1fr stretches them to fill the width), so the pair spans the panel rather
// than hugging the left. The 440px floor is the width one entry (thumbnail + readings + note + actions)
// needs to lay out on a single line without the note wrapping; below ~900px that floor wins and it drops
// to a single full-width column rather than two cramped ones. max-width caps how wide the columns can get
// on a very wide panel. auto-fit keys off the CONTAINER (the workspace panel), not the viewport.
const List = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(max(440px, 45%), 1fr));
  gap: 2px 18px;
  max-width: 1600px;

  .km-row {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 8px;
    border-radius: 8px;
    transition: background 0.15s ease;
  }
  .km-row:hover {
    background: rgba(0, 0, 0, 0.035);
  }
  /* The card: thumbnail on top, time label underneath, a hairline round it. The thumbnail keeps the
     frame's real orientation (portrait / landscape) to match the main player: --km-thumb-w/h are set on
     the List from the loaded frame's aspect, fitted inside a 120px box (so a portrait clip is a portrait
     card, a landscape clip a landscape one). */
  .km-media {
    flex: 0 0 auto;
    width: var(--km-thumb-w, 120px);
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 8px;
    overflow: hidden;
    background: var(--ifi-surface);
  }
  /* Only the image area is the positioning context, so the overlay play button sits on the frame — not
     over the time label below it. */
  .km-thumb-area {
    position: relative;
  }
  /* The seek target — clicking the thumbnail jumps to the entry's (start) frame. */
  .km-jump {
    appearance: none;
    border: none;
    background: none;
    padding: 0;
    display: block;
    width: var(--km-thumb-w, 120px);
    cursor: pointer;
  }
  .km-thumb,
  .km-pill {
    display: block;
    width: var(--km-thumb-w, 120px);
    height: var(--km-thumb-h, 74px);
    object-fit: cover;
  }
  /* A not-yet-rebuilt (or undecodable) recording / video frame shows a flat teal-tinted block. */
  .km-pill {
    background: linear-gradient(135deg, rgba(0, 140, 140, 0.14), rgba(0, 140, 140, 0.06));
  }
  /* Play (bottom-left, spans only) plays the range and toggles pause. */
  .km-play {
    position: absolute;
    bottom: 4px;
    left: 4px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    font-size: 15px;
    appearance: none;
    border: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    cursor: pointer;
  }
  .km-play:hover {
    background: rgba(0, 0, 0, 0.8);
  }
  /* Time under the thumbnail; the owner clicks a part to type a new time (start / end). */
  .km-time {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 4px 6px 5px;
    font-size: 12px;
    font-weight: 600;
    color: var(--ifi-ink);
  }
  .km-time-btn {
    appearance: none;
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .km-time-btn:hover {
    color: var(--ifi-teal-dark);
    text-decoration: underline;
  }
  .km-time-input {
    width: 44px;
    font: inherit;
    padding: 0 2px;
    border: 1px solid var(--ifi-teal);
    border-radius: 3px;
    outline: none;
  }
  /* The frame's thermometer readings, a tidy column sitting right beside the thumbnail (before the note),
     one probe per line — values right-aligned so a stack of them reads like a little table. Content-sized
     but capped, so a long probe name ellipsises instead of crowding the note out; the value never shrinks
     (tabular figures stay aligned). */
  .km-readings {
    flex: 0 0 auto;
    align-self: flex-start;
    max-width: 200px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-top: 2px;
    font-size: 12px;
    line-height: 1.35;
  }
  .km-reading {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .km-reading-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ifi-text-secondary);
  }
  .km-reading-value {
    margin-left: auto;
    white-space: nowrap;
    color: var(--ifi-ink);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .km-body {
    flex: 1;
    min-width: 0;
  }
  .km-caption {
    font-size: 14px;
    line-height: 1.45;
    color: #262626;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  /* Owner: quiet inline actions — edit / add a note, and snap the frame (or a range's ends) to the
     current player frame. */
  .km-note-btn,
  .km-set {
    appearance: none;
    border: none;
    background: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px;
    margin-left: -4px;
    border-radius: 4px;
    font: inherit;
    font-size: 13px;
    color: var(--ifi-text-tertiary);
    cursor: pointer;
  }
  .km-note-btn:hover,
  .km-set:hover {
    color: var(--ifi-teal-dark);
    background: rgba(0, 0, 0, 0.04);
  }
  .km-setrow {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin-top: 6px;
  }
  /* Remove sits at the row's right edge, quiet until the row is hovered. */
  .km-remove {
    appearance: none;
    border: none;
    background: none;
    padding: 2px;
    color: var(--ifi-text-tertiary);
    cursor: pointer;
    flex: 0 0 auto;
    line-height: 1;
    opacity: 0.4;
    transition:
      opacity 0.15s ease,
      color 0.15s ease;
  }
  .km-row:hover .km-remove {
    opacity: 1;
  }
  .km-remove:hover {
    color: #cf1322;
  }
`;

// "1:05" / "65" / "65.4" → seconds; null if unparseable.
const parseTime = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  if (t.includes(':')) {
    const parts = t.split(':');
    if (parts.length !== 2) return null;
    const mm = Number(parts[0]);
    const ss = Number(parts[1]);
    return Number.isFinite(mm) && Number.isFinite(ss) ? mm * 60 + ss : null;
  }
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

const KeyMoments = ({ experiment }: { experiment: Experiment }) => {
  const user = useCommonStore((state) => state.user);
  const isOwner = !!user && experiment.ownerId === user.id;
  const storeKeyMoments = useCommonStore((state) => state.keyMoments);
  const keyMomentsExpId = useCommonStore((state) => state.keyMomentsExpId);
  // Only render this experiment's moments: a navigation leaves the previous experiment's in the store
  // until hydration reseeds them, so ignore them until the store is tagged with our id.
  const keyMoments = keyMomentsExpId === experiment.id ? storeKeyMoments : [];
  const pendingSpanStart = useCommonStore((state) => state.pendingSpanStart);
  const setPendingSpanStart = useCommonStore((state) => state.setPendingSpanStart);
  const requestSnapshotMoment = useCommonStore((state) => state.requestSnapshotMoment);
  const requestKeyframeSeek = useCommonStore((state) => state.requestKeyframeSeek);
  const requestPlaySpan = useCommonStore((state) => state.requestPlaySpan);
  const requestPause = useCommonStore((state) => state.requestPause);
  const playerPlaying = useCommonStore((state) => state.playerPlaying);
  const activeSpanStart = useCommonStore((state) => state.activeSpanStart);
  const setActiveSpanStart = useCommonStore((state) => state.setActiveSpanStart);
  const playerFrameRate = useCommonStore((state) => state.playerFrameRate);
  const removeKeyMoment = useCommonStore((state) => state.removeKeyMoment);
  const setKeyMomentText = useCommonStore((state) => state.setKeyMomentText);
  const reanchorKeyMoment = useCommonStore((state) => state.reanchorKeyMoment);
  const reanchorKeyMomentEnd = useCommonStore((state) => state.reanchorKeyMomentEnd);

  const isVideo = experiment.sourceType === ExperimentType.Video;
  const { getPlayerIndex, getRecordingIndex } = useMappingIndex(experiment.segments, experiment.duration);

  // The entry currently being captioned (by recordingIndex) and its draft text.
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  // The time field currently being typed (which end of which entry) and its draft string.
  const [editingTime, setEditingTime] = useState<{ recordingIndex: number; which: 'start' | 'end' } | null>(null);
  const [timeDraft, setTimeDraft] = useState('');

  // Rebuilt thumbnails for persisted moments (which hydrate without an image — only the frame index is
  // stored). Keyed by recordingIndex; '' means the rebuild was tried and failed (keep the pill).
  //  - Recordings fetch the server-rendered data_N.png through the Storage SDK (CORS-safe).
  //  - Videos have no per-frame image, but their .vir thermal frames are already in the player's cache,
  //    so the frame is colourised into a thumbnail instead (see renderThermalFrameThumbnail).
  const recordingId = experiment.recordingId;
  const videoThermal = useCommonStore((s) => (isVideo ? s.showcaseThermalCache.get(experiment.id) : undefined));
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  // The frame's real aspect ratio (w/h), read from the first thumbnail that loads — all of an
  // experiment's frames share it. Drives the card's portrait/landscape shape to match the main player.
  const [frameAspect, setFrameAspect] = useState<number | null>(null);
  const needThumbs =
    isVideo || !recordingId
      ? []
      : keyMoments.filter((m) => !m.thumbnail && thumbs[m.recordingIndex] === undefined).map((m) => m.recordingIndex);
  const needKey = needThumbs.join(',');
  useEffect(() => {
    if (!recordingId || needThumbs.length === 0) return;
    let cancelled = false;
    needThumbs.forEach((ri) => {
      fetchRecordingFrameDataUrl(recordingId, ri)
        .then((url) => !cancelled && setThumbs((t) => ({ ...t, [ri]: url })))
        .catch(() => !cancelled && setThumbs((t) => ({ ...t, [ri]: '' })));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needKey, recordingId]);

  // Video moments: colourise each moment's .vir frame once the thermal data has loaded into the player's
  // cache. Synchronous (a 120×160 canvas), so no cancellation needed; a frame index out of range is
  // skipped (kept as the pill). recordingIndex is the .vir frame index for a video.
  const needVideoThumbs =
    isVideo && videoThermal
      ? keyMoments
          .filter((m) => !m.thumbnail && thumbs[m.recordingIndex] === undefined && !!videoThermal[m.recordingIndex])
          .map((m) => m.recordingIndex)
      : [];
  const needVideoKey = needVideoThumbs.join(',');
  useEffect(() => {
    if (!videoThermal || needVideoThumbs.length === 0) return;
    const rendered: Record<number, string> = {};
    needVideoThumbs.forEach((ri) => {
      rendered[ri] = renderThermalFrameThumbnail(videoThermal[ri]);
    });
    setThumbs((t) => ({ ...t, ...rendered }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needVideoKey, videoThermal]);

  // Recording indices map back to player-frame space to seek; a video's are already player frames.
  const toPlayer = (recordingIndex: number) => (isVideo ? recordingIndex : getPlayerIndex(recordingIndex));
  const seekToStart = (m: (typeof keyMoments)[number]) => requestKeyframeSeek(toPlayer(m.recordingIndex));
  // Span play button: toggle. If this span is the one playing, pause; else start it (and mark it active
  // so its button — and only its — shows pause).
  const togglePlaySpan = (m: (typeof keyMoments)[number]) => {
    if (m.endRecordingIndex === undefined) return;
    if (playerPlaying && activeSpanStart === m.recordingIndex) {
      requestPause();
    } else {
      setActiveSpanStart(m.recordingIndex);
      requestPlaySpan(toPlayer(m.recordingIndex), toPlayer(m.endRecordingIndex));
    }
  };

  const startEditTime = (recordingIndex: number, which: 'start' | 'end', seconds: number) => {
    setEditingTime({ recordingIndex, which });
    setTimeDraft(formatDuration(seconds));
  };
  // Commit a typed time: parse → nearest player frame (via the player's published rate) → update the
  // entry's start / end, keeping its caption. A recording's thumbnail is dropped so it re-fetches the new
  // frame; a video keeps its (empty) pill.
  const commitTime = (m: (typeof keyMoments)[number], which: 'start' | 'end') => {
    const draft = timeDraft.trim();
    setEditingTime(null);
    // The field is pre-filled with the (rounded) current time; leaving it unchanged must be a no-op, not
    // a re-round that could nudge the frame. Only a genuinely different typed value converts.
    const origLabel = formatDuration(which === 'start' ? m.tSeconds : (m.endTSeconds ?? m.tSeconds));
    if (draft === origLabel) return;
    const secs = parseTime(draft);
    if (secs === null || !playerFrameRate || playerFrameRate.secondsPerFrame <= 0) return;
    const playerFrame = Math.max(
      0,
      Math.min(Math.round(secs / playerFrameRate.secondsPerFrame), playerFrameRate.lastFrame),
    );
    const recIdx = isVideo ? playerFrame : getRecordingIndex(playerFrame);
    const tSec = Number((playerFrame * playerFrameRate.secondsPerFrame).toFixed(1));
    if (which === 'start') {
      if (recIdx === m.recordingIndex) return; // unchanged
      if (keyMoments.some((k) => k.recordingIndex !== m.recordingIndex && k.recordingIndex === recIdx)) {
        message.info('There’s already a key moment on this frame.');
        return;
      }
      if (m.endRecordingIndex !== undefined && recIdx >= m.endRecordingIndex) {
        message.info('The start must come before the end.');
        return;
      }
      reanchorKeyMoment(m.recordingIndex, { recordingIndex: recIdx, tSeconds: tSec, thumbnail: '', readings: [] });
    } else {
      if (recIdx === m.endRecordingIndex) return; // unchanged
      if (recIdx <= m.recordingIndex) {
        message.info('The end must come after the start.');
        return;
      }
      reanchorKeyMomentEnd(m.recordingIndex, recIdx, tSec);
    }
  };

  // Hide an entry a later re-trim (or a clone of a clip) left outside the kept segments — its frame no
  // longer maps to a real player position. A span needs both ends inside.
  const segs = experiment.segments;
  const reachable = (frame: number) =>
    isVideo || !segs || segs.length === 0 || segs.some((s) => frame >= s.start && frame <= s.end);
  const isVisible = (m: (typeof keyMoments)[number]) =>
    reachable(m.recordingIndex) && (m.endRecordingIndex === undefined || reachable(m.endRecordingIndex));
  const visible = keyMoments.filter(isVisible);

  // Thermometer readings for each marked frame, recomputed from the frame's thermal data rather than
  // read from the moment (a moment's captured readings are session-only and go stale the instant a
  // probe is moved). The string selector only re-renders when a probe is added / removed / moved /
  // renamed / resized — not on the 10 Hz value updates the map gets during playback.
  const temperatureUnit = useCommonStore((s) => s.temperatureUnit);
  // Coordinates are quantised so a sub-pixel resize drag (which streams a store write per pointer move)
  // doesn't churn a new signature — and thus a re-render / recompute — on every event; 4/3 decimals is far
  // finer than the 120×160 grid, and the recompute reads full-precision state at fire time anyway.
  const probeSig = useCommonStore((s) =>
    (experiment.thermometersId ?? [])
      .map((id) => {
        const t = s.thermometerMap.get(id);
        if (!t) return id;
        return [
          id,
          t.name ?? '',
          t.x.toFixed(4),
          t.y.toFixed(4),
          t.measuringAreaType ?? '',
          t.measuringAreaWidth?.toFixed(3) ?? '',
          t.measuringAreaHeight?.toFixed(3) ?? '',
        ].join('|');
      })
      .join(';'),
  );
  const probeCount = useCommonStore(
    (s) => (experiment.thermometersId ?? []).filter((id) => s.thermometerMap.has(id)).length,
  );
  // Current probe labels in T-order — used to reserve the readings rows (so they don't pop in and shift
  // the layout) and label them even before the recompute lands. Memoised on probeSig so it isn't a fresh
  // array each render (which would defeat the store's reference equality and re-render on every tick).
  const probeLabels = useMemo(() => {
    const { thermometerMap } = useCommonStore.getState();
    return (experiment.thermometersId ?? [])
      .map((id, i) => {
        const t = thermometerMap.get(id);
        return t ? t.name?.trim() || `T${i + 1}` : null;
      })
      .filter((l): l is string => l !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeSig, experiment.thermometersId]);
  // The frames whose readings the visible moments need: every start, plus a range's end.
  const neededFrames = [
    ...new Set(
      visible.flatMap((m) =>
        m.endRecordingIndex !== undefined ? [m.recordingIndex, m.endRecordingIndex] : [m.recordingIndex],
      ),
    ),
  ];
  const framesKey = neededFrames.join(',');

  // A recording's raw frames are fetched once per marked frame (a video's whole clip is already in the
  // showcase thermal cache, shared with the thumbnails above). null in frameBufs = fetch failed.
  const [frameBufs, setFrameBufs] = useState<Record<number, ArrayBuffer | null>>({});
  // Frames already requested this mount. A resolving fetch changes needBufsKey and re-runs the effect;
  // without this guard that re-run would re-issue a fresh download for every still-in-flight frame (an
  // O(n²) cascade). With it, each frame is fetched exactly once and all requests run in one parallel batch.
  const requestedBufs = useRef<Set<number>>(new Set());
  const needBufs =
    isVideo || !recordingId || probeCount === 0 ? [] : neededFrames.filter((fi) => frameBufs[fi] === undefined);
  const needBufsKey = needBufs.join(',');
  useEffect(() => {
    if (!recordingId) return;
    needBufs.forEach((fi) => {
      if (requestedBufs.current.has(fi)) return;
      requestedBufs.current.add(fi);
      fetchRecordingFrameBuffer(recordingId, fi)
        .then((buf) => setFrameBufs((b) => ({ ...b, [fi]: buf })))
        .catch(() => setFrameBufs((b) => ({ ...b, [fi]: null })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needBufsKey, recordingId]);

  // A probe edit is exactly when the mark-time fallback starts to lie, so forget any frame whose fetch
  // FAILED and let it retry — a transient blip mustn't pin stale readings for the mount's life. Debounced
  // like the recompute (a measuring-area resize streams a probeSig change per pointer move).
  useEffect(() => {
    const timer = setTimeout(() => {
      setFrameBufs((b) => {
        const failed = Object.keys(b)
          .map(Number)
          .filter((k) => b[k] === null);
        if (failed.length === 0) return b;
        const next = { ...b };
        failed.forEach((k) => {
          delete next[k];
          requestedBufs.current.delete(k);
        });
        return next;
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [probeSig]);

  // Recompute readings when the marked frames, the probes, or the available frame data change. Debounced:
  // resizing a measuring area streams a store update per pointer move, and each recompute decodes every
  // marked frame (once each, via the shared frame cache).
  const [readingsByFrame, setReadingsByFrame] = useState<Record<number, { label: string; value: number }[]>>({});
  useEffect(() => {
    const timer = setTimeout(() => {
      const { thermometerMap } = useCommonStore.getState();
      const probes = (experiment.thermometersId ?? [])
        .map((id, i) => {
          const t = thermometerMap.get(id);
          return t ? { label: t.name?.trim() || `T${i + 1}`, t } : null;
        })
        .filter((p): p is { label: string; t: Thermometer } => p !== null);
      const frames = framesKey ? framesKey.split(',').map(Number) : [];
      const out: Record<number, { label: string; value: number }[]> = {};
      if (probes.length > 0) {
        frames.forEach((fi) => {
          const raw = isVideo ? videoThermal?.[fi] : frameBufs[fi];
          if (!raw) return;
          try {
            // The shared frame cache (utils/thermalFrame.ts) decodes this frame once, so every probe reads
            // off one inflate + walk rather than re-inflating per probe.
            out[fi] = probes.map((p) => ({ label: p.label, value: getThermometerValue(raw, p.t) }));
          } catch {
            // an undecodable frame just shows no readings
          }
        });
      }
      setReadingsByFrame(out);
    }, 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framesKey, probeSig, videoThermal, frameBufs, isVideo]);

  // A navigation to another experiment must not carry this one's cached frames / aspect over — they are
  // keyed by frame index, which another clip reuses. keyMoments is gated to [] until the new experiment
  // hydrates, so nothing renders against the cleared caches in the meantime.
  useEffect(() => {
    setFrameAspect(null);
    setThumbs({});
    setFrameBufs({});
    setReadingsByFrame({});
    requestedBufs.current = new Set();
  }, [experiment.id]);

  const startEdit = (recordingIndex: number, text?: string) => {
    setEditing(recordingIndex);
    setDraft(text ?? '');
  };
  const commitEdit = () => {
    if (editing !== null) setKeyMomentText(editing, draft.trim());
    setEditing(null);
    setDraft('');
  };

  const atCap = keyMoments.length >= MAX_KEY_MOMENTS;

  // Fit the frame's aspect inside a 120px box so the card keeps the main player's orientation: a portrait
  // clip shrinks the width, a landscape clip the height. 0.75 (the .vir's native 120×160) is the pre-load
  // guess; the real ratio arrives from the first thumbnail's onLoad.
  const aspect = frameAspect ?? 0.75;
  const thumbW = Math.round(120 * Math.min(1, aspect));
  const thumbH = Math.round(120 / Math.max(1, aspect));
  const thumbVars = { '--km-thumb-w': `${thumbW}px`, '--km-thumb-h': `${thumbH}px` } as CSSProperties;
  const captureAspect = (img: HTMLImageElement) => {
    if (frameAspect === null && img.naturalWidth > 0 && img.naturalHeight > 0) {
      setFrameAspect(img.naturalWidth / img.naturalHeight);
    }
  };

  // Renders a time as either static text (viewer) or a click-to-type field (owner).
  const renderTime = (m: (typeof keyMoments)[number], which: 'start' | 'end', seconds: number) => {
    if (!isOwner) return <>{formatDuration(seconds)}</>;
    if (editingTime?.recordingIndex === m.recordingIndex && editingTime.which === which) {
      return (
        <input
          className="km-time-input"
          autoFocus
          value={timeDraft}
          onChange={(e) => setTimeDraft(e.target.value)}
          onBlur={() => commitTime(m, which)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') setEditingTime(null);
          }}
        />
      );
    }
    return (
      <button
        type="button"
        className="km-time-btn"
        title="Click to type a time"
        onClick={() => startEditTime(m.recordingIndex, which, seconds)}
      >
        {formatDuration(seconds)}
      </button>
    );
  };

  // Viewers of an empty timeline see nothing; the owner always gets it (to start one).
  if (visible.length === 0 && !isOwner) return null;

  return (
    <Section>
      <Header>
        <span className="km-title">Key moments</span>
        {isOwner &&
          (pendingSpanStart ? (
            <span className="km-pending">
              Range starts at <b>{formatDuration(pendingSpanStart.tSeconds)}</b> — move the player to where it ends,
              then
              <button type="button" className="km-action" onClick={() => requestSnapshotMoment('spanEnd')}>
                End here
              </button>
              <button type="button" className="km-action" onClick={() => setPendingSpanStart(null)}>
                Cancel
              </button>
            </span>
          ) : (
            <>
              <button
                type="button"
                className="km-action"
                disabled={atCap}
                onClick={() => requestSnapshotMoment('keyMoment')}
              >
                <PlusOutlined /> Mark this frame
              </button>
              <button
                type="button"
                className="km-action"
                disabled={atCap}
                onClick={() => requestSnapshotMoment('spanStart')}
              >
                <PlusOutlined /> Mark a range
              </button>
            </>
          ))}
      </Header>

      {visible.length === 0 ? (
        <Empty>Pause on a telling frame and mark it — viewers can jump straight to it.</Empty>
      ) : (
        <List style={thumbVars}>
          {visible.map((m) => {
            const isSpan = m.endRecordingIndex !== undefined;
            const thumb = m.thumbnail || thumbs[m.recordingIndex];
            const isThisPlaying = playerPlaying && activeSpanStart === m.recordingIndex;
            // Readings shown beside the thumbnail, recomputed from the frame. The rows are reserved by the
            // current probe count (so they don't pop in and shove the note), filling with values as the
            // frame data lands; before that a fresh in-session mark falls back to its mark-time capture so
            // something shows instantly. A range's → end value only pairs with a recomputed start, so both
            // ends come from the same probe list and line i is the same probe on both.
            const startRows = readingsByFrame[m.recordingIndex];
            const fallbackRows = !startRows && m.readings.length > 0 ? m.readings : undefined;
            const endRows = isSpan && startRows ? readingsByFrame[m.endRecordingIndex!] : undefined;
            const fmt = (celsius: number) => displayTemp(celsius, temperatureUnit).toFixed(1);
            return (
              <div className="km-row" key={m.recordingIndex}>
                <div className="km-media">
                  <div className="km-thumb-area">
                    <button
                      type="button"
                      className="km-jump"
                      title={`Jump to ${formatDuration(m.tSeconds)}`}
                      onClick={() => seekToStart(m)}
                    >
                      {thumb ? (
                        <img src={thumb} alt="" className="km-thumb" onLoad={(e) => captureAspect(e.currentTarget)} />
                      ) : (
                        <span className="km-pill" />
                      )}
                    </button>
                    {isSpan && (
                      <button
                        type="button"
                        className="km-play"
                        title={isThisPlaying ? 'Pause' : 'Play range'}
                        onClick={() => togglePlaySpan(m)}
                      >
                        {isThisPlaying ? <PauseOutlined /> : <CaretRightOutlined />}
                      </button>
                    )}
                  </div>
                  <span className="km-time">
                    {renderTime(m, 'start', m.tSeconds)}
                    {isSpan && (
                      <>
                        <span>–</span>
                        {renderTime(m, 'end', m.endTSeconds ?? m.tSeconds)}
                      </>
                    )}
                  </span>
                </div>

                {probeCount > 0 && (
                  <div className="km-readings">
                    {probeLabels.map((label, i) => {
                      const startVal = startRows?.[i]?.value ?? fallbackRows?.[i]?.value;
                      const endVal = endRows?.[i]?.value;
                      return (
                        <span className="km-reading" key={i}>
                          <span className="km-reading-label">{label}</span>
                          <span className="km-reading-value">
                            {startVal === undefined ? '—' : fmt(startVal)}
                            {isSpan ? ` → ${endVal === undefined ? '…' : fmt(endVal)}` : ''}{' '}
                            {temperatureSymbol(temperatureUnit)}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                )}

                <div className="km-body">
                  {editing === m.recordingIndex ? (
                    <Input.TextArea
                      autoFocus
                      autoSize={{ minRows: 1, maxRows: 6 }}
                      value={draft}
                      placeholder="Describe this moment"
                      maxLength={500}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={commitEdit}
                    />
                  ) : m.text ? (
                    <div className="km-caption">
                      {m.text}
                      {isOwner && (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="km-note-btn"
                            onClick={() => startEdit(m.recordingIndex, m.text)}
                          >
                            <EditOutlined /> Edit
                          </button>
                        </>
                      )}
                    </div>
                  ) : (
                    isOwner && (
                      <button type="button" className="km-note-btn" onClick={() => startEdit(m.recordingIndex, m.text)}>
                        <PlusOutlined /> Add a note
                      </button>
                    )
                  )}

                  {/* Owner: snap the frame (or a range's two ends) to the current player frame — same
                      labelled style for a single frame and a range. */}
                  {isOwner &&
                    (isSpan ? (
                      <div className="km-setrow">
                        <button
                          type="button"
                          className="km-set"
                          title="Set the range's start to where the player is now"
                          onClick={() => requestSnapshotMoment('reanchor', m.recordingIndex)}
                        >
                          <AimOutlined /> Set start
                        </button>
                        <button
                          type="button"
                          className="km-set"
                          title="Set the range's end to where the player is now"
                          onClick={() => requestSnapshotMoment('reanchorEnd', m.recordingIndex)}
                        >
                          <AimOutlined /> Set end
                        </button>
                      </div>
                    ) : (
                      <div className="km-setrow">
                        <button
                          type="button"
                          className="km-set"
                          title="Set this key moment to where the player is now"
                          onClick={() => requestSnapshotMoment('reanchor', m.recordingIndex)}
                        >
                          <AimOutlined /> Set frame
                        </button>
                      </div>
                    ))}
                </div>

                {isOwner && (
                  <button
                    type="button"
                    className="km-remove"
                    title="Remove"
                    onClick={() => removeKeyMoment(m.recordingIndex)}
                  >
                    <CloseOutlined />
                  </button>
                )}
              </div>
            );
          })}
        </List>
      )}
    </Section>
  );
};

export default KeyMoments;
