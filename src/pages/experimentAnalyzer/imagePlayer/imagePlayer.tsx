import { getBlob, getBytes, getMetadata, ref } from 'firebase/storage';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dropdown, Input, Modal, message } from 'antd';
import type { MenuProps } from 'antd';
import { firebaseStorage } from '../../../services/firebase';
import ControlBar from './controlBar';
import { throttle } from 'lodash';
import {
  Experiment,
  ExperimentGraphOption,
  LineplotData,
  MeasuringAreaType,
  Segment,
  TemperatureUnit,
  ToolPage,
  ViewMode,
} from '../../../types';
import { useMappingIndex } from '../hooks';
import { getThermometerValue } from '../../../utils/temperatureReader';
import Thermometers from '../thermometers/thermometers';
import { buildPlayerContextMenu, clickFraction, sameMenuTarget } from '../thermometers/playerContextMenu';
import Annotations, { AnnotationsHandle } from '../annotations/annotations';
import Isotherms from '../isotherms/isotherms';
import ScaleHotspots from '../scaleHotspots/scaleHotspots';
import DiffView from '../diffView/diffView';
import Spotmeter from '../spotmeter/spotmeter';
import ProfileLineOverlay from '../profileLine/profileLine';
import ThermalSurface3D, { type Surface3DView } from '../surface3d/thermalSurface3D';
import useCommonStore, { SnapshotPurpose, MAX_KEY_MOMENTS } from '../../../stores/common';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import ChartManager from '../charts/chartManager';
import WorkspacePanel from '../workspace/workspacePanel';
import ToolBar from '../toolBar';
import { FPS, LINEPLOT_POINTS_RECORDING } from '../../../utils/constants';
import { sampleFrameIndices } from '../../../utils/sampleFrames';
import { useNavigate } from 'react-router-dom';
import { cloneExperiment } from '../../../services/experiments';
import { useAnalysisPersistence } from '../useAnalysisPersistence';
import { useAnalyzerHistory } from '../useAnalyzerHistory';
import { captureElementImage, exportElementToPNG, timestampedName } from '../../../utils/exporters';
import { detectPaletteFromImageSource } from '../../../utils/paletteDetect';
import { useLongPressContextMenu } from '../../../hooks/useLongPressContextMenu';
import { isStaff } from '../../../utils/staff';
import { playerRegistry, PlayerController } from '../../../components/aiChat/playerRegistry';

type ImageSrc = string | undefined;

// Storage file for each ViewMode render: data_N.png is the classic palette render
// (every recording has it); app-captured recordings additionally upload vis_N.jpg
// (visible-light still) and mix_N.jpg (true MSX blend), mirroring the capture app's
// own three view modes. Temperatures always come from data_N.dat regardless.
const VIEW_MODE_FILE: Record<ViewMode, (n: number) => string> = {
  ir: (n) => `data_${n}.png`,
  visible: (n) => `vis_${n}.jpg`,
  blended: (n) => `mix_${n}.jpg`,
};

// Cycle order for the toolbar button: ir → visible → blended → ir.
const VIEW_MODE_CYCLE: ViewMode[] = ['ir', 'visible', 'blended'];

// How long a Q&A moment's capture waits for its frame to finish decoding, and how often it looks. One
// Storage fetch of a single frame, so this is generous on purpose — it only ever costs the wait when the
// frame really is still coming, and the alternative is a capture with no overlays on it.
const CAPTURE_WAIT_MS = 3000;
const CAPTURE_POLL_MS = 60;

// Playback-speed multipliers the control-bar button cycles through.
const PLAYBACK_SPEEDS = [0.5, 1, 2, 4];

interface Props {
  experiment: Experiment;
  // Toolbar "Reset" (non-owner only): discard local sandbox edits and reload from source. Owned by the
  // analyzer page (it re-fetches + remounts this player); we just surface it on the toolbar.
  onReset?: () => void;
}

const ImagePlayer = ({ experiment, onReset }: Props) => {
  const { recordingId, currentFrameNumber = 1, duration, segments, graphsOptions, thermometersId } = experiment;
  // Playback speed multiplier (session-only, not persisted). The frame interval is 1/(FPS·speed) so 2×
  // shows twice as many frames per second. Recordings fetch each frame over the network, so a fast speed
  // on a cold cache may not keep up — we don't drop frames, playback just paces to what's loaded.
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const delay = useMemo(() => {
    return (1 / (FPS * playbackSpeed)) * 1000;
  }, [playbackSpeed]);

  // only map to recording index when fetch from firebase.
  const { lastFrameIndex, getRecordingIndex, getPlayerIndex } = useMappingIndex(segments, duration);

  const navigate = useNavigate();
  const user = useCommonStore((state) => state.user);
  // Gate the owner-hidden Reset button on this: `user` is null until auth hydrates, so without it an owner
  // opening their OWN public clip would briefly see the button (isOwner false) until the session resolves.
  const authReady = useCommonStore((state) => state.authReady);
  // The AI Q&A "Ask about this moment" / "+ Add moment" is open to ANY staff — the panel and the server
  // are (a non-owner's thread just stays in their browser). Owner-gating the snapshot would silently
  // no-op "+ Add moment" for a non-owner staffer, who still sees the button.
  const canAskMoment = isStaff(user);
  // Key moments (chapters) are the OWNER's to curate — independent of the staff Q&A gate above.
  const isOwner = !!user && experiment.ownerId === user.id;
  // The player right-click menu is controlled so we can (a) force it shut when the annotation layer
  // takes over an interaction — rc-dropdown only auto-hides a contextMenu menu on a left click, which
  // a right-click on a callout never produces — and (b) freeze its target while it's open.
  const [menuOpen, setMenuOpen] = useState(false);
  // The 3D surface is one view with two presentations, so it's one open flag + which presentation —
  // never a flag each, which is what used to let the toolbar button stack a full window on top of an
  // already-minimised one. The presentation is sticky: minimise the surface, close it, and the button
  // brings back the miniplayer. In memory for this experiment only — deliberately not saved anywhere.
  const [surface3DOpen, setSurface3DOpen] = useState(false);
  const [surface3DView, setSurface3DView] = useState<Surface3DView>('modal');
  // The thermometer the menu targets, snapshotted when the menu opens (on right-click). Building the
  // menu off the *live* selection instead would let it morph to the background variant the instant a
  // stray click clears the selection while the menu is still closing — a visible flash. Subscribing
  // by id keeps the "Measuring Area" submenu reflecting that thermometer's type reactively.
  const [menuTargetId, setMenuTargetId] = useState<string | null>(null);
  const menuTarget = useStoreWithEqualityFn(
    useCommonStore,
    (state) => (menuTargetId ? state.thermometerMap.get(menuTargetId) : undefined),
    sameMenuTarget,
  );
  // Same freeze for the right-clicked profile line (has no per-frame churn, so a plain selector is stable).
  const [menuProfileLineId, setMenuProfileLineId] = useState<string | null>(null);
  const menuProfileLine = useCommonStore((state) =>
    menuProfileLineId
      ? state.experimentMap.get(experiment.id)?.profileLines?.find((l) => l.id === menuProfileLineId)
      : undefined,
  );
  // True once every thermometer for this experiment is present in the store. Thermometers load
  // asynchronously, and the experiment can be served from the (never-cleared) experimentMap cache
  // before they arrive — e.g. revisiting one whose thermometers were cleared on leaving the
  // analyzer — so reading-seeding must wait for them rather than run once at mount. Returns a
  // boolean so per-frame value writes don't re-render the player.
  const thermometersReady = useCommonStore(
    (state) => thermometersId.length > 0 && thermometersId.every((id) => state.thermometerMap.has(id)),
  );
  // Whether the store already reflects this clip's saved analysis: nothing to load, or every
  // thermometer present. Gates the owner auto-save below so the async (re)load of thermometers on a
  // cached revisit isn't mistaken for a user edit (which would bump `updatedAt` and reshuffle the list).
  const analysisLoaded = thermometersId.length === 0 || thermometersReady;
  // Active toolbar page. Only "analyze" and (for signed-in users) "clip"; the clip page is itself "edit
  // clip" mode. Note tools live on the Analyze page — annotation is no longer its own page.
  const [toolPage, setToolPage] = useState<ToolPage>('analyze');
  const editMode = toolPage === 'clip';
  const annotationsRef = useRef<AnnotationsHandle>(null);
  // Count of deletable annotations, reported up by <Annotations>, so the background right-click menu
  // only shows "Delete all annotations" when there are some.
  const [annotationCount, setAnnotationCount] = useState(0);
  const onDeleteAllAnnotations = () => annotationsRef.current?.deleteAll();
  // Last right-click position (client coords), captured on the wrapper's onContextMenu, so a menu
  // "Add …" drops the thermometer / annotation at the cursor rather than at the centre.
  const lastContextPos = useRef<{ x: number; y: number } | null>(null);
  const canTrim = !!user;
  // The analyzer is a local sandbox: anyone (signed-out included) can place thermometers and
  // annotations on any experiment; signed-in users keep their work by cloning it (add clips / Save to
  // My Experiments). Edits to the source itself persist only for the owner (auto-save + the Firestore
  // rules are owner-gated).
  const canAnnotate = true;
  const availablePages: ToolPage[] = ['analyze'];
  if (canTrim) availablePages.push('clip');
  // Flat array of even length; consecutive pairs [s0,e0, s1,e1, ...] are kept ranges, inclusive,
  // in player-index space (0-based, 0..lastFrameIndex). One full segment = [0, lastFrameIndex].
  // Kept sorted by start so the range slider + save stay ordered.
  const [editedSegments, setEditedSegments] = useState<number[]>([0, 0]);
  // Per-pair add-order ids, aligned 1:1 with the sorted pairs above (ids[k] tags pair k). Each add
  // mints a larger id, so the pair with the max id is the most recently added — that's what undo
  // drops first, even when the pair was inserted mid-timeline rather than at the tail.
  const nextSegmentId = useRef(1);
  const segmentIds = useRef<number[]>([0]);
  const freshSegmentId = () => nextSegmentId.current++;
  const [savingClip, setSavingClip] = useState(false);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [clipTitle, setClipTitle] = useState('');

  // Frame-image caches, one per view mode (a frame index means a different
  // image in each mode). The thermal-buffer cache below is mode-independent.
  const cacheImageRef = useRef<Record<ViewMode, ImageSrc[]>>({
    ir: [],
    visible: [],
    blended: [],
  });
  // Current view mode. The state drives the toggle UI; the ref is what the
  // fetch/play closures read (they outlive renders — same pattern as
  // currFrameIdxRef), so switching mid-playback takes effect on the next tick.
  const [viewMode, setViewMode] = useState<ViewMode>('ir');
  const viewModeRef = useRef<ViewMode>('ir');
  // Whether this recording has the vis/mix companions (probed once below); legacy
  // telelab recordings don't, and then the toolbar's view-mode button never shows.
  // null = probe still pending; first paint waits for it (below) so the button never
  // pops into the toolbar after the fact and shifts its neighbours mid-click.
  const [viewModesAvailable, setViewModesAvailable] = useState<boolean | null>(null);
  const cacheThermoArrayBufferRef = useRef<ArrayBuffer[]>([]);
  // In-flight thermal-data fetches, keyed by frame index, so overlapping requests for the same frame
  // (e.g. the 3D playback prefetch + the 2D preloader) share one Storage download instead of racing.
  const pendingThermoRef = useRef<Map<number, Promise<ArrayBuffer>>>(new Map());
  // Bumped when the displayed frame's thermal buffer lands in the ref cache. The cache fill is
  // invisible to React, but the isotherm overlay reads that ref at render — without this bump a
  // fresh open (image wins the race against the .dat) paints the overlay empty and nothing ever
  // repaints it until playback happens to re-render the player.
  const [, setThermoFrameTick] = useState(0);
  const imageWrapperRef = useRef<HTMLDivElement>(null);

  // Composited PNG screenshot of the frame + thermometer / annotation / isotherm overlays.
  const saveScreenshot = async () => {
    if (!imageWrapperRef.current) return;
    try {
      await exportElementToPNG(imageWrapperRef.current, timestampedName('frame', 'png'));
    } catch (e) {
      console.error('failed to export screenshot', e);
      message.error('Failed to export screenshot');
    }
  };

  // currentFrameNumber is a recording-frame number (the stored thumbnail frame), so map it back into
  // player-index space before seeding the playhead. Treating it directly as a player index breaks
  // segmented clips whose thumbnail frame sits at a high recording number: the index lands outside
  // every segment and getRecordingIndex falls through to 0, fetching a non-existent data_0.png.
  const currFrameIdxRef = useRef(getPlayerIndex(currentFrameNumber));
  // Index of the frame whose IMAGE is actually on screen. Lags currFrameIdxRef while a seeked-to
  // frame's image is still decoding — and that gap is exactly when pairing the isotherm overlay to
  // the playhead would draw the NEW frame's contours over the OLD frame's still-displayed image, so
  // the overlay (and the arrival bump in loadThermalDataOnFrame) key off this instead.
  const imgFrameIdxRef = useRef(currFrameIdxRef.current);

  /**
   * This is the only one true state for Player.
   * Only image change would cause rerender, not even frame index.
   * We need index to fetch image first, and render the sence after we got the image. Nothing else can cause rerender.
   * So everything is updated together with image change, no other intermiddle state.
   * Try use ref for other valus if possible
   */
  const [currFrameImg, setCurrFrameImg] = useState<ImageSrc>();
  // Mobile: a long press on the player synthesises a contextmenu so the right-click menu opens. The
  // wrapper only mounts once the first frame loads, so re-bind then (currFrameImg flips truthy once).
  useLongPressContextMenu(imageWrapperRef, !!currFrameImg);

  const [lineplotThermoData, setLineplotThermoData] = useState<LineplotData | null>(null);

  // The T(t) plot (and its optional whole-frame min/max/mean overlay) builds its series from the
  // ≤25-frame sample, so enabling it turns the sampled loader on.
  const showLineplotThremoData = graphsOptions?.includes(ExperimentGraphOption.time);
  const showIsotherms = graphsOptions?.includes(ExperimentGraphOption.isotherm);
  // The scale-bar / hot-cold-marker overlay reads the current frame's decoded grid, so it needs the
  // frame's .dat fetched just like isotherms do.
  // The scale bar and the hot/cold markers are independent toggles; either one reads the current frame's
  // decoded grid, so gate the .dat fetch on either being on.
  const showScaleBar = graphsOptions?.includes(ExperimentGraphOption.scaleBar);
  const showHotspots = graphsOptions?.includes(ExperimentGraphOption.hotspots);
  const showScaleHotspots = !!showScaleBar || !!showHotspots;
  // The T(l) profile plot samples the current frame's decoded grid, so it needs the .dat fetched too, and
  // its chart must repaint when a seeked-to frame's buffer arrives (same as the isotherm overlay).
  const showProfile = graphsOptions?.includes(ExperimentGraphOption.lineProfile);
  // The on-image line overlay is independent of the T(l) chart: it draws (and reads the current frame's
  // .dat for its endpoint temperatures) whenever ANY transect exists — even with the chart off or the
  // Charts grid full. So the frame-data plumbing below keys off "a line exists", not the chart toggle.
  const hasProfileLines = !!experiment.profileLines?.length;
  // The N(T) histogram bins the current frame's decoded grid, so it needs the .dat fetched too, and its
  // bars must repaint when a seeked-to frame's buffer arrives (same as the isotherm overlay / profile plot).
  const showHistogram = graphsOptions?.includes(ExperimentGraphOption.histogram);
  // Δ frame-difference overlay: reads the current frame's grid (same as isotherms) AND a reference frame's
  // grid (fetched separately below). Its reference-frame player index is session-local (default 0).
  const showDiff = graphsOptions?.includes(ExperimentGraphOption.diff);
  const [diffRefIndex, setDiffRefIndex] = useState(0);
  const needCurrFrameThermoData =
    thermometersId.length > 0 ||
    !!showIsotherms ||
    showScaleHotspots ||
    hasProfileLines ||
    !!showHistogram ||
    !!showDiff;
  // Latest-ref mirrors for the arrival bump: the load closures outlive renders (same pattern as
  // viewModeRef), and these overlays are the cache's only render-time readers — with both off
  // (thermometer-only sessions also fetch .dat), a bump would re-render the whole tree for nothing.
  const showIsothermsRef = useRef(showIsotherms);
  showIsothermsRef.current = showIsotherms;
  const showScaleHotspotsRef = useRef(showScaleHotspots);
  showScaleHotspotsRef.current = showScaleHotspots;
  const hasProfileLinesRef = useRef(hasProfileLines);
  hasProfileLinesRef.current = hasProfileLines;
  const showHistogramRef = useRef(showHistogram);
  showHistogramRef.current = showHistogram;
  const showDiffRef = useRef(showDiff);
  showDiffRef.current = showDiff;

  // Palette detection: when the scale bar / hot-cold markers are shown for an experiment with no stored
  // palette, infer the FLIR palette once from the IR render's pixels vs the frame temperatures
  // (utils/paletteDetect). Session-only (the player remounts per experiment); the resolved key feeds
  // ScaleHotspots so its ramp matches the baked image instead of the approximate fallback.
  const [detectedPalette, setDetectedPalette] = useState<string | null>(null);
  const paletteDetectDoneRef = useRef(false);
  const paletteDetectingRef = useRef(false);

  // Hand the AI the frame the way the student sees it. A Q&A moment carries a capture of the player box —
  // the frame PLUS the probe markers, annotation callouts and transect lines drawn over it — so the model
  // reads the picture the question is about instead of the bare stored render it would otherwise load.
  // Fired after the moment is attached rather than before: html2canvas takes a beat and the chip must not
  // wait on it (the store swaps the capture in when it lands).
  //
  // It WAITS for the displayed frame to be the moment's frame instead of giving up on it, because the two
  // frames a student most wants to attach are exactly the two least likely to be decoded already: nothing
  // preloads backwards, and preloadFrame stops one short of the last frame — so attaching at 0:00 or at
  // the end used to race the download and silently produce an overlay-less capture. Nothing is blocked on
  // the wait; the chip is already up.
  const captureMomentOverlay = async (recordingIndex: number, playerIndex: number) => {
    const el = imageWrapperRef.current;
    if (!el) return;
    const mode = viewModeRef.current;
    for (
      let waited = 0;
      imgFrameIdxRef.current !== playerIndex && waited < CAPTURE_WAIT_MS;
      waited += CAPTURE_POLL_MS
    ) {
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_POLL_MS));
    }
    // Still not this frame (a failed fetch, or the playhead moved on): a composite of some other instant
    // would be worse than none, since the moment's numbers come from THIS frame.
    if (imgFrameIdxRef.current !== playerIndex || viewModeRef.current !== mode) return;
    try {
      const overlay = await captureElementImage(el);
      if (imgFrameIdxRef.current !== playerIndex || viewModeRef.current !== mode) return;
      useCommonStore.getState().setAttachedMomentOverlay(recordingIndex, overlay, mode);
    } catch (e) {
      // Not worth telling the user about: the moment still works, the server just falls back to the bare
      // stored render, and the lightbox draws the markers live anyway.
      console.error('failed to capture the attached moment with its overlays', e);
    }
  };

  // Snapshot the current playhead into the store — a Q&A "moment" (purpose 'qa', staff, capped at 3), a
  // single-frame key moment ('keyMoment', owner), the start / end of a key-moment span ('spanStart' /
  // 'spanEnd', owner), or re-anchoring an existing moment ('reanchor', owner; `target` is its old
  // recordingIndex). Only the player can build this: it owns the frame index, the on-screen image, and
  // the live probe readings. Frozen at call time so later playback doesn't drift it.
  const snapshotCurrentMoment = (purpose: SnapshotPurpose = 'qa', target?: number) => {
    if (purpose === 'qa') {
      // Attaching is allowed whatever the selected Q&A model is: a text-only model can't see the frame,
      // but the server still feeds it that moment's readings + frame stats (the panel says so).
      if (!canAskMoment) return;
    } else if (!isOwner) {
      return; // key moments / spans are the owner's to curate
    }
    const playerIndex = currFrameIdxRef.current;
    const recordingIndex = getRecordingIndex(playerIndex);
    const tSeconds = Number((playerIndex / FPS).toFixed(1));
    const store = useCommonStore.getState();
    const readings = thermometersId
      .map((id, i) => {
        const t = store.thermometerMap.get(id);
        return t ? { label: t.name?.trim() || `T${i + 1}`, value: t.value } : null;
      })
      .filter((r): r is { label: string; value: number } => r !== null);

    // Finalize a span: pair the current frame (the end) with the pending start marked earlier.
    if (purpose === 'spanEnd') {
      const start = store.pendingSpanStart;
      if (!start) return;
      if (recordingIndex <= start.recordingIndex) {
        message.info('The end of a range must come after its start.');
        return;
      }
      store.addKeyMoment({ ...start, endRecordingIndex: recordingIndex, endTSeconds: tSeconds });
      store.setPendingSpanStart(null);
      return;
    }

    // Re-anchor an existing moment's start to the current frame (keeps its caption / span end).
    if (purpose === 'reanchor') {
      if (target === undefined) return;
      const marked = store.keyMoments;
      const m = marked.find((k) => k.recordingIndex === target);
      if (!m) return;
      if (marked.some((k) => k.recordingIndex !== target && k.recordingIndex === recordingIndex)) {
        message.info('There’s already a key moment on this frame.');
        return;
      }
      if (m.endRecordingIndex !== undefined && recordingIndex >= m.endRecordingIndex) {
        message.info('Move the start before the end of the range.');
        return;
      }
      store.reanchorKeyMoment(target, { recordingIndex, tSeconds, thumbnail: currFrameImg ?? '', readings });
      return;
    }

    // Move a span's end to the current frame (start unchanged).
    if (purpose === 'reanchorEnd') {
      if (target === undefined) return;
      const m = store.keyMoments.find((k) => k.recordingIndex === target);
      if (!m) return;
      if (recordingIndex <= m.recordingIndex) {
        message.info('The end of a range must come after its start.');
        return;
      }
      store.reanchorKeyMomentEnd(target, recordingIndex, tSeconds);
      return;
    }

    // qa / keyMoment / spanStart all snapshot the current frame; check the destination's cap first.
    if (purpose === 'qa') {
      const attached = store.attachedMoments;
      if (attached.length >= 3 && !attached.some((m) => m.recordingIndex === recordingIndex)) {
        message.info('You can attach up to 3 moments — remove one first.');
        return;
      }
    } else {
      const marked = store.keyMoments;
      if (marked.length >= MAX_KEY_MOMENTS && !marked.some((m) => m.recordingIndex === recordingIndex)) {
        message.info(`You can mark up to ${MAX_KEY_MOMENTS} key moments — remove one first.`);
        return;
      }
    }
    const moment = { recordingIndex, tSeconds, thumbnail: currFrameImg ?? '', readings };
    if (purpose === 'qa') {
      store.addAttachedMoment(moment);
      // The bare frame is on the chip now; the composite (frame + probes + notes) replaces it when the
      // capture lands, and is what the question carries to the model. Key moments keep the bare frame:
      // their thumbnail is rebuilt from the stored render on every reload, and would not match.
      captureMomentOverlay(recordingIndex, playerIndex);
    } else if (purpose === 'spanStart') store.setPendingSpanStart(moment);
    else store.addKeyMoment(moment);
  };
  const snapshotRef = useRef(snapshotCurrentMoment);
  snapshotRef.current = snapshotCurrentMoment;

  const fetchThermalData = async (index: number): Promise<ArrayBuffer> => {
    const cached = cacheThermoArrayBufferRef.current[index];
    if (cached) return cached;
    // In-flight dedupe: concurrent callers for the same frame (the line-plot loader, the current-frame
    // isotherm load, a prefetch) share one getBytes and one resulting buffer — so the identity-keyed
    // decode cache never sees two distinct objects for the same frame.
    const inFlight = pendingThermoRef.current.get(index);
    if (inFlight) return inFlight;
    const mappedIndex = getRecordingIndex(index);
    const load = getBytes(ref(firebaseStorage, `recordings/${recordingId}/data_${mappedIndex}.dat`))
      .then((buf) => {
        cacheThermoArrayBufferRef.current[index] = buf;
        return buf;
      })
      .finally(() => pendingThermoRef.current.delete(index));
    pendingThermoRef.current.set(index, load);
    return load;
  };

  const loadThermoDataForPlot = async () => {
    const { indices, step } = sampleFrameIndices(lastFrameIndex + 1, LINEPLOT_POINTS_RECORDING);
    // Each sample is a Storage getBytes (fetchThermalData dedupes + caches). Bound concurrency so we don't
    // open ~50 requests at once, and so early samples aren't gated on the slowest of the whole batch.
    const CONCURRENCY = 8;
    const arrayBuffer: ArrayBuffer[] = new Array(indices.length);
    let next = 0;
    const worker = async () => {
      let i = next++;
      while (i < indices.length) {
        arrayBuffer[i] = await fetchThermalData(indices[i]);
        i = next++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, indices.length) }, worker));

    // fetchThermalData already caches each sampled frame under its player index, so no extra cache-set here.
    setLineplotThermoData({ arrayBuffer, step, secondPerFrame: 1 / FPS });
  };

  const loadThermalDataOnFrame = async (index: number): Promise<void> => {
    // Early-out on a cache hit WITHOUT ticking: a hit means the overlay already has this frame, and an
    // extra tick would double-render every frame during isotherm playback. Fetch dedupe + caching now
    // live in fetchThermalData.
    if (cacheThermoArrayBufferRef.current[index]) return;
    await fetchThermalData(index);
    // Checked at arrival, not at request: a prefetch issued for a future frame may land after the
    // playhead has moved onto it. Matched against the DISPLAYED frame (not the playhead) so a
    // buffer for a seeked-to frame whose image is still decoding doesn't repaint the overlay
    // against the old image — the image's own arrival render pairs them up instead.
    if (
      (showIsothermsRef.current ||
        showScaleHotspotsRef.current ||
        hasProfileLinesRef.current ||
        showHistogramRef.current ||
        showDiffRef.current) &&
      index === imgFrameIdxRef.current
    )
      setThermoFrameTick((v) => v + 1);
  };

  const updateThermometersByFrame = (index: number) => {
    // This frame's thermal buffer may not be cached (yet): a seek mid-download, a failed .dat fetch, or
    // the thermo-refresh nonce firing asynchronously (undo/redo, a finished AI report injecting probes)
    // while the playhead moves. Keep the previous readings rather than decode undefined and crash — the
    // next frame tick recomputes them anyway.
    const arrayBuffer = cacheThermoArrayBufferRef.current[index];
    if (!arrayBuffer) return;
    useCommonStore.getState().setStore((state) => {
      for (const thermometerId of thermometersId) {
        const thermometer = state.thermometerMap.get(thermometerId);
        if (thermometer) {
          thermometer.value = getThermometerValue(arrayBuffer, thermometer);
        }
      }
    });
  };

  /** x,y is [0,1] */
  const updateThermoemterByPosition = (id: string, x: number, y: number) => {
    useCommonStore.getState().setStore((state) => {
      const thermometer = state.thermometerMap.get(id);
      if (thermometer) {
        thermometer.x = x;
        thermometer.y = y;
        const arrayBuffer = cacheThermoArrayBufferRef.current[currFrameIdxRef.current];
        thermometer.value = getThermometerValue(arrayBuffer, thermometer);
      }
    });
  };

  /** Add a thermometer at [0,1] image coords (default centre), reading its value from the current frame.
   *  `aiPlaced` marks a probe the Lab Assistant dropped, so it displays distinctly from the user's own. */
  const addThermometerAt = async (x = 0.5, y = 0.5, aiPlaced = false) => {
    const id = crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}-${Math.round(performance.now())}`;
    await loadThermalDataOnFrame(currFrameIdxRef.current);
    const arrayBuffer = cacheThermoArrayBufferRef.current[currFrameIdxRef.current];
    const value = arrayBuffer ? getThermometerValue(arrayBuffer, { x, y }) : 0;
    const store = useCommonStore.getState();
    store.addThermometer(experiment.id, { id, x, y, value, unit: TemperatureUnit.celsius, aiPlaced });
    store.selectThermometer(id);
  };

  // Set the selected thermometer's measuring-area type, then refresh its reading from the current
  // frame (the player holds the thermal buffer that updateThermoemterByPosition reads).
  const onPickMeasuringArea = (type: MeasuringAreaType) => {
    if (!menuTarget) return;
    const { id: tId, x, y, measuringAreaWidth, measuringAreaHeight } = menuTarget;
    useCommonStore.getState().updateThermometer(tId, {
      measuringAreaType: type,
      measuringAreaWidth: measuringAreaWidth ?? 0.15,
      measuringAreaHeight: measuringAreaHeight ?? 0.15,
    });
    updateThermoemterByPosition(tId, x, y);
  };

  // Menu "Add …": drop at the recorded right-click position (falling back to the centre).
  const onAddThermometerFromMenu = () => {
    const p =
      lastContextPos.current &&
      clickFraction('thermometers-wrapper', lastContextPos.current.x, lastContextPos.current.y);
    if (p) addThermometerAt(p.x, p.y);
    else addThermometerAt();
  };
  const onAddAnnotationFromMenu = () => {
    const p =
      lastContextPos.current &&
      clickFraction('annotations-wrapper', lastContextPos.current.x, lastContextPos.current.y);
    annotationsRef.current?.add(p ?? undefined);
  };

  // Every right-click that can open the player menu (blank or a thermometer — annotation callouts
  // stop propagation) records the cursor (for "Add … here") and freezes the menu's target.
  const onWrapperContextMenu = (e: React.MouseEvent) => {
    lastContextPos.current = { x: e.clientX, y: e.clientY };
    setMenuTargetId(useCommonStore.getState().selectedThermometerId);
    setMenuProfileLineId(useCommonStore.getState().selectedProfileLineId);
  };

  // "Add a line" from the right-click menu — same as the toolbar button: drop a transect on the frame and
  // nothing else. The overlay is independent of the T(l) chart, so this works even when the grid is full.
  const onAddProfileLineFromMenu = () => useCommonStore.getState().addProfileLine(experiment.id);

  // Right-click menu: a selected thermometer gets Measuring Area + delete it; the empty image gets
  // add thermometer / add annotation / delete all. Every delete confirms first.
  const contextMenuItems: MenuProps['items'] = buildPlayerContextMenu({
    expId: experiment.id,
    selectedThermometer: menuTarget,
    thermometersId,
    annotationCount,
    selectedProfileLine: menuProfileLine,
    profileLines: experiment.profileLines,
    onAddProfileLine: onAddProfileLineFromMenu,
    canAddAnnotation: canAnnotate,
    onAdd: onAddThermometerFromMenu,
    onAddAnnotation: onAddAnnotationFromMenu,
    onPickMeasuringArea,
    onDeleteAllAnnotations,
    // Only offered while the Δ overlay is on: make the displayed frame the difference reference.
    onSetDiffReference: showDiff ? () => setDiffRefIndex(imgFrameIdxRef.current) : undefined,
    canAskMoment,
    onAskMoment: () => {
      snapshotCurrentMoment('qa');
      // Surface the freshly attached chip: jump to the Analysis tab where the Q&A panel lives.
      useCommonStore.getState().requestOpenAnalysisTab();
    },
  });

  const fetchImage = async (index: number, mode: ViewMode) => {
    const mappedIndex = getRecordingIndex(index);
    const blob = await getBlob(ref(firebaseStorage, `recordings/${recordingId}/${VIEW_MODE_FILE[mode](mappedIndex)}`));
    return blob;
  };

  const loadImage = async (index: number, onloadend?: () => void) => {
    // Capture the mode at request time: a fetch that resolves after a mode
    // switch must cache under the mode it belongs to, not the new one.
    const mode = viewModeRef.current;
    let blob: Blob;
    try {
      blob = await fetchImage(index, mode);
    } catch (e) {
      // vis/mix can be missing per-frame (the app skips a still its recorder
      // failed to write). Degrade that frame to the IR render so playback
      // never sticks; a truly missing IR frame keeps the old behavior (throw).
      if (mode === 'ir') throw e;
      blob = await fetchImage(index, 'ir');
    }
    const fileReader = new FileReader();
    fileReader.onloadend = () => {
      const res = fileReader.result;
      if (res) {
        cacheImageRef.current[mode][index] = res as string;
        onloadend && onloadend();
      }
    };
    fileReader.readAsDataURL(blob);
  };

  const preloadFrame = async (start: number, length = 5) => {
    for (let i = start; i < start + length && i < lastFrameIndex; i++) {
      if (!cacheImageRef.current[viewModeRef.current][i]) {
        loadImage(i);
      }
      if (needCurrFrameThermoData) {
        loadThermalDataOnFrame(i);
      }
    }
  };

  const updateImage = (index: number) => {
    const src = cacheImageRef.current[viewModeRef.current][index];
    if (src) {
      imgFrameIdxRef.current = index;
      setCurrFrameImg(src);
    }
  };

  const updateFrame = async (index: number) => {
    currFrameIdxRef.current = index;
    // Publish the playhead in recording-frame space for the 3D twin (a no-op write when unchanged).
    useCommonStore.getState().setPlayerRecordingIndex(getRecordingIndex(index));
    if (cacheImageRef.current[viewModeRef.current][index]) {
      updateImage(index);
    } else {
      loadImage(index, () => updateImage(index));
    }
    // has thermometer
    if (needCurrFrameThermoData) {
      await loadThermalDataOnFrame(index);
      updateThermometersByFrame(index);
    }
  };

  // Switch the per-frame render. The current frame re-renders immediately
  // (cache hit is instant; otherwise the old-mode image stays up until the
  // new one decodes — no flash); during playback the interval's next tick
  // reads viewModeRef and continues in the new mode.
  const changeViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    viewModeRef.current = mode;
    updateFrame(currFrameIdxRef.current);
    preloadFrame(currFrameIdxRef.current + 1);
  };

  const cycleViewMode = () => {
    const idx = VIEW_MODE_CYCLE.indexOf(viewModeRef.current);
    changeViewMode(VIEW_MODE_CYCLE[(idx + 1) % VIEW_MODE_CYCLE.length]);
  };

  const init = async () => {
    loadImage(currFrameIdxRef.current, () => updateImage(currFrameIdxRef.current));
    // has thermometer (seeding the readings is handled by the thermometersReady effect below, which
    // also covers thermometers that load into the store after this runs)
    if (needCurrFrameThermoData) {
      await loadThermalDataOnFrame(currFrameIdxRef.current);
    }
    // The line-plot data is loaded by the [showLineplotThremoData] effect (which fires on mount and on
    // toggle-on); loading it here too would double-fetch the ~25 sampled frames at mount.
    preloadFrame(currFrameIdxRef.current + 1);
  };

  // init
  useEffect(() => {
    if (!recordingId) return;
    init();
  }, [recordingId]);

  // One-shot probe for the vis/mix companions (frame numbers are recording
  // indices, so use the clip's first mapped frame). Metadata read is public
  // on recordings/**; a 404 means a legacy recording — the toggle stays off.
  useEffect(() => {
    if (!recordingId) {
      setViewModesAvailable(false);
      return;
    }
    let cancelled = false;
    const firstFrame = getRecordingIndex(0);
    getMetadata(ref(firebaseStorage, `recordings/${recordingId}/vis_${firstFrame}.jpg`))
      .then(() => !cancelled && setViewModesAvailable(true))
      .catch(() => !cancelled && setViewModesAvailable(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId]);

  // Seed each thermometer's reading from the current frame once the thermometers are in the store.
  // init() can run before they finish loading (a cached experiment renders the player before
  // fetchExperiment repopulates the thermometerMap), so a one-shot seed there isn't enough — without
  // this the overlays and X/Y plots sit at the default 0 until the playhead first moves.
  useEffect(() => {
    if (!thermometersReady) return;
    let cancelled = false;
    (async () => {
      await loadThermalDataOnFrame(currFrameIdxRef.current);
      if (!cancelled) updateThermometersByFrame(currFrameIdxRef.current);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thermometersReady]);

  // toggle plot. The ≤25-frame downsample feeds T(t)'s series AND the fixed temperature axis of the T(l)
  // profile and the N(T) histogram (both use it to keep their axes from rescaling every frame), so load it
  // when ANY is on — otherwise those charts leave their axes jumping frame-to-frame. Fetches are deduped/cached.
  useEffect(() => {
    if (showLineplotThremoData || showProfile || showHistogram) {
      loadThermoDataForPlot();
    }
  }, [showLineplotThremoData, showProfile, showHistogram]);

  // A frame overlay (isotherms / scale-bar / hot-cold markers) toggled on mid-session: init() only
  // fetched the current frame's .dat when a thermometer (or the saved option) already demanded it at
  // mount, so a later toggle-on must fetch it now — otherwise the overlay stays empty until playback
  // pulls the frame. Already-cached hit is a no-op (the toggle itself re-rendered, and the render reads
  // the cache directly); on a miss the arrival bump in loadThermalDataOnFrame repaints the overlay.
  useEffect(() => {
    if (showIsotherms || showScaleHotspots || hasProfileLines || showHistogram || showDiff)
      loadThermalDataOnFrame(currFrameIdxRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showIsotherms, showScaleHotspots, hasProfileLines, showHistogram, showDiff]);

  // Toggling the Δ overlay ON defaults its reference to the CURRENT frame (not frame 0) — you almost always
  // want "how has it changed from here on". A right-click can still repoint it; toggling off→on re-defaults
  // to wherever the playhead is then. (On a reload with Δ already saved on, this pins to the mount frame.)
  useEffect(() => {
    if (showDiff) setDiffRefIndex(currFrameIdxRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDiff]);

  // The Δ overlay also needs its REFERENCE frame's .dat (a different frame from the playhead). Fetch it
  // when the overlay turns on or the reference changes; a tick bump repaints the overlay once it lands.
  // Already-cached is a no-op. The current frame is handled by the effect above / normal playback.
  useEffect(() => {
    if (!showDiff) return;
    if (cacheThermoArrayBufferRef.current[diffRefIndex]) return;
    let cancelled = false;
    fetchThermalData(diffRefIndex)
      .then(() => {
        if (!cancelled) setThermoFrameTick((v) => v + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDiff, diffRefIndex]);

  // One-shot palette detection off the IR render (see the detectedPalette state above). Runs when the bar
  // is shown, no palette is stored, and the current frame's .dat is loaded; retries on later frames if a
  // frame can't be matched (e.g. a flat all-one-temperature frame), never concurrently, stops after the
  // first success. Detection MUST use the IR (palette) render, not the displayed Visible/Blended image — it
  // prefers the cached IR image but fetches data_N.png directly when it isn't cached (so it works in any
  // view mode, not just while the IR frame happens to be cached). `currFrameImg` re-fires it as frames land.
  useEffect(() => {
    if (paletteDetectDoneRef.current || paletteDetectingRef.current) return;
    if (experiment.palette || !showScaleHotspots) return;
    const idx = imgFrameIdxRef.current;
    const buffer = cacheThermoArrayBufferRef.current[idx];
    if (!buffer) return; // need the frame's thermal data to pair with the render
    paletteDetectingRef.current = true;
    let cancelled = false;
    (async () => {
      let irSrc = cacheImageRef.current.ir[idx];
      let objectUrl: string | null = null;
      if (!irSrc) {
        try {
          objectUrl = URL.createObjectURL(await fetchImage(idx, 'ir'));
          irSrc = objectUrl;
        } catch {
          return; // couldn't fetch the IR render; a later frame retries
        }
      }
      const key = await detectPaletteFromImageSource(irSrc, buffer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (!cancelled && key) {
        paletteDetectDoneRef.current = true;
        setDetectedPalette(key);
      }
    })().finally(() => {
      paletteDetectingRef.current = false;
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showScaleHotspots, currFrameImg, experiment.palette]);

  // Owner edits auto-persist (debounced, flushed on leave); a non-owner / signed-out viewer's edits
  // stay in the local sandbox and instead raise `sandboxDirty` so the workspace can offer to save a
  // copy. `analysisLoaded` gates the baseline so a cached revisit's async thermometer reload isn't
  // mistaken for an edit. Recordings persist to the subcollection unconditionally (no customThermometers
  // flag needed). See useAnalysisPersistence.
  const sandboxDirty = useAnalysisPersistence(experiment, analysisLoaded);

  // Ctrl+Z undo / redo for the spatial edits (thermometers / profile lines / annotations). Gated on the
  // same `analysisLoaded` baseline as the persistence hook.
  useAnalyzerHistory(experiment, analysisLoaded);

  // Undo/redo moves thermometers without re-reading the frame, so re-derive their readings at the
  // restored positions from the current frame whenever the history layer bumps this nonce. The ref skips
  // the mount run (nothing restored yet) so we never read a frame before the thermal cache has loaded.
  const thermoRefreshNonce = useCommonStore((s) => s.thermoRefreshNonce);
  // Armed hand-draw for a transect: mount the profile-line overlay (which hosts the crosshair capture
  // surface) even before the first line exists, so the user can draw the very first one.
  const profileLineDrawMode = useCommonStore((s) => s.profileLineDrawMode);
  const lastThermoRefreshRef = useRef(thermoRefreshNonce);
  useEffect(() => {
    if (lastThermoRefreshRef.current === thermoRefreshNonce) return;
    lastThermoRefreshRef.current = thermoRefreshNonce;
    updateThermometersByFrame(currFrameIdxRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thermoRefreshNonce]);

  const intervalIdRef = useRef<NodeJS.Timeout | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // Latest isPlaying for effects/handlers that must read it without re-subscribing (the speed-restart
  // effect keys only on `delay`, and would otherwise recreate the interval play() just started).
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  // When set (a key-moment span is playing), the frame loop pauses once the playhead passes this frame.
  // Cleared by any manual play / seek so ordinary playback is never bounded.
  const spanEndRef = useRef<number | null>(null);

  // One frame tick, extracted so both play() and the speed-restart effect drive the SAME loop body. Kept
  // in a ref (refreshed every render) so the interval always runs the latest closures without re-arming.
  const advanceFrame = () => {
    if (currFrameIdxRef.current > lastFrameIndex) {
      currFrameIdxRef.current = 0;
      stop();
      return;
    }
    // Span playback: stop once the end frame has been shown (it plays inclusive, then pauses).
    if (spanEndRef.current !== null && currFrameIdxRef.current > spanEndRef.current) {
      spanEndRef.current = null;
      stop();
      return;
    }

    updateFrame(currFrameIdxRef.current);
    if (cacheImageRef.current) {
      preloadFrame(currFrameIdxRef.current + 5, 1);
      currFrameIdxRef.current++;
    } else {
      preloadFrame(currFrameIdxRef.current + 1);
    }
  };
  const advanceFrameRef = useRef(advanceFrame);
  advanceFrameRef.current = advanceFrame;

  const play = () => {
    setIsPlaying(true);
    useCommonStore.getState().setPlayerPlaying(true);
    intervalIdRef.current = setInterval(() => advanceFrameRef.current(), delay);
  };

  const stop = () => {
    setIsPlaying(false);
    useCommonStore.getState().setPlayerPlaying(false);
    if (intervalIdRef.current) {
      clearInterval(intervalIdRef.current);
      intervalIdRef.current = null;
    }
  };

  // A speed change mid-play must swap the running interval to the new period. Keys on `delay` only and
  // reads isPlaying via the ref — depending on isPlaying would refire when play() flips it and spawn a
  // second timer. No-op unless a timer is currently running.
  useEffect(() => {
    if (!isPlayingRef.current || !intervalIdRef.current) return;
    clearInterval(intervalIdRef.current);
    intervalIdRef.current = setInterval(() => advanceFrameRef.current(), delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delay]);

  // Step one frame without playing: pause, drop any span bound, and paint the neighbour directly
  // (handleSlide would skip the paint since isPlaying is still true in this render tick).
  const stepFrame = (deltaFrames: number) => {
    spanEndRef.current = null;
    if (intervalIdRef.current) {
      clearInterval(intervalIdRef.current);
      intervalIdRef.current = null;
    }
    if (isPlaying) {
      setIsPlaying(false);
      useCommonStore.getState().setPlayerPlaying(false);
    }
    const next = Math.max(0, Math.min(currFrameIdxRef.current + deltaFrames, lastFrameIndex));
    currFrameIdxRef.current = next;
    updateFrame(next);
    preloadFrame(next + 1);
  };
  const stepFrameRef = useRef(stepFrame);
  stepFrameRef.current = stepFrame;

  const cycleSpeed = () => {
    setPlaybackSpeed((prev) => PLAYBACK_SPEEDS[(PLAYBACK_SPEEDS.indexOf(prev) + 1) % PLAYBACK_SPEEDS.length] ?? 1);
  };

  // ← / → step one frame. Defers to a selected annotation's arrow-nudge (its overlay is a child, so its
  // keydown runs first and preventDefault()s the arrow) and to a focused slider/input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (el && el.closest('.ant-slider')) return; // a focused slider handles its own arrow keys
      e.preventDefault();
      stepFrameRef.current(e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // stop when close
  useEffect(() => {
    return () => {
      stop();
    };
  }, []);

  const handleClickPlayButton = () => {
    if (isPlaying) {
      stop();
    } else {
      spanEndRef.current = null; // a manual play is unbounded
      play();
    }
  };

  // Play a key-moment span: jump to the start frame and play until the end frame, then pause. Reuses the
  // frame interval; spanEndRef bounds it (checked each tick). Both indices are player-frame space.
  const playSpan = (startPlayerIndex: number, endPlayerIndex: number) => {
    if (intervalIdRef.current) clearInterval(intervalIdRef.current);
    currFrameIdxRef.current = startPlayerIndex;
    updateFrame(startPlayerIndex);
    spanEndRef.current = endPlayerIndex;
    play();
  };
  const playSpanRef = useRef(playSpan);
  playSpanRef.current = playSpan;

  const handleSlide = (n: number) => {
    currFrameIdxRef.current = n;
    if (!isPlaying) {
      updateFrame(n);
      preloadFrame(n + 1);
    }
  };

  // Switch toolbar pages via the mode switcher. Entering the clip page (re)inits the selection to the
  // whole timeline (telelab parity).
  const goToPage = (page: ToolPage) => {
    if (page === 'clip' && toolPage !== 'clip') {
      segmentIds.current = [freshSegmentId()];
      setEditedSegments([0, lastFrameIndex]);
    }
    setToolPage(page);
  };

  const onAddAnnotation = () => annotationsRef.current?.add();

  // Add a kept pair in the free space at/ahead of the playhead (telelab couples the new edit thumb
  // to the playhead). Unlike telelab's tail-only append, this fills any gap — so a clip whose last
  // segment already reaches the end can still gain a segment in a hole earlier in the timeline.
  const onAddSegment = () => {
    // Current pairs tagged with their add-order id (sorted alongside editedSegments by start).
    const tagged = [];
    for (let i = 0; i + 1 < editedSegments.length; i += 2) {
      tagged.push({
        start: editedSegments[i],
        end: editedSegments[i + 1],
        id: segmentIds.current[i / 2] ?? freshSegmentId(),
      });
    }
    tagged.sort((a, b) => a.start - b.start);

    // Complement within [0, lastFrameIndex] -> free gaps; keep only gaps wide enough for two thumbs.
    const gaps: number[][] = [];
    let cursor = 0;
    for (const { start, end } of tagged) {
      if (start - 1 > cursor) gaps.push([cursor, start - 1]);
      cursor = Math.max(cursor, end + 1);
    }
    if (lastFrameIndex > cursor) gaps.push([cursor, lastFrameIndex]);

    // Prefer the gap that holds free space ahead of the playhead (start the new pair there); if the
    // playhead sits past every gap, fall back to the nearest gap behind it and fill it whole.
    const playhead = currFrameIdxRef.current;
    const aheadGap = gaps.find(([, e]) => e > playhead);
    const gap = aheadGap ?? gaps[gaps.length - 1];
    if (!gap) {
      message.info({
        content: 'No space to add a segment',
        style: { marginTop: '20vh' },
        onClick: () => message.destroy(),
      });
      return;
    }

    // Mint a fresh (largest) id for the new pair so undo removes it first; re-sort so the slider
    // stays ordered while the id list keeps tracking add-order alongside it.
    const start = aheadGap ? Math.max(gap[0], playhead) : gap[0];
    tagged.push({ start, end: gap[1], id: freshSegmentId() });
    tagged.sort((a, b) => a.start - b.start);
    segmentIds.current = tagged.map((t) => t.id);
    setEditedSegments(tagged.flatMap((t) => [t.start, t.end]));
  };

  // Drop the most recently added pair — the one carrying the largest add-order id. (telelab dropped
  // the tail pair, which only coincides with "last added" when pairs are appended at the end; ours
  // can be inserted mid-timeline.) No-op when a single pair remains.
  const onUndoLastSegment = () => {
    const pairCount = editedSegments.length / 2;
    if (pairCount <= 1) return;
    const ids = segmentIds.current;
    let removeIdx = pairCount - 1;
    let maxId = -Infinity;
    for (let k = 0; k < pairCount; k++) {
      if (ids[k] > maxId) {
        maxId = ids[k];
        removeIdx = k;
      }
    }
    segmentIds.current = ids.filter((_, k) => k !== removeIdx);
    const next = [...editedSegments];
    next.splice(removeIdx * 2, 2);
    setEditedSegments(next);
  };

  // Collapse back to a single full-range pair (telelab onResetSegments).
  const onResetSegments = () => {
    segmentIds.current = [freshSegmentId()];
    setEditedSegments([0, lastFrameIndex]);
  };

  // Edit-slider change: clamp each pair to start < end (telelab minDistance={1}) and preview the
  // moved boundary on the playhead (telelab's edit-thumb-follows-playhead coupling).
  const handleEditRangeChange = (next: number[]) => {
    const clamped = [...next];
    for (let i = 0; i + 1 < clamped.length; i += 2) {
      if (clamped[i + 1] <= clamped[i]) clamped[i + 1] = clamped[i] + 1;
    }
    const changedIdx = clamped.findIndex((v, i) => v !== editedSegments[i]);
    if (changedIdx >= 0) handleSlide(clamped[changedIdx]);
    setEditedSegments(clamped);
  };

  // Save button opens the "Save as" dialog to name the new clip (telelab parity).
  const openSaveModal = () => {
    setClipTitle('');
    setSaveModalOpen(true);
  };

  // Expand every kept pair into player indices, map each to a recording frame number, then
  // re-coalesce contiguous recording frames into Segment[] (telelab "expand -> map -> split gap>1"),
  // and save a new clip under the entered title.
  const doSaveClip = async () => {
    if (!user || savingClip) return;

    const recFrames: number[] = [];
    for (let i = 0; i + 1 < editedSegments.length; i += 2) {
      for (let p = editedSegments[i]; p <= editedSegments[i + 1]; p++) {
        recFrames.push(getRecordingIndex(p));
      }
    }
    if (recFrames.length === 0) return;

    const segments: Segment[] = [];
    let startF = recFrames[0];
    if (recFrames.length === 1) {
      segments.push({ start: startF, end: startF });
    } else {
      for (let i = 1; i < recFrames.length; i++) {
        if (recFrames[i] - recFrames[i - 1] > 1) {
          segments.push({ start: startF, end: recFrames[i - 1] });
          startF = recFrames[i];
        }
        if (i === recFrames.length - 1) segments.push({ start: startF, end: recFrames[i] });
      }
    }

    setSavingClip(true);
    try {
      const newId = await cloneExperiment(experiment, user, segments, clipTitle);
      setSaveModalOpen(false);
      navigate(`/experiments/${newId}`);
    } catch (e) {
      console.error('failed to save clip', e);
    } finally {
      setSavingClip(false);
    }
  };

  // Seek the playhead to a frame (Q&A moment-chip clicks post a store seek request the player consumes).
  const seekToPlayer = (playerIndex: number) => {
    if (intervalIdRef.current) clearInterval(intervalIdRef.current);
    spanEndRef.current = null; // a direct seek cancels any span in progress
    setIsPlaying(false);
    useCommonStore.getState().setPlayerPlaying(false);
    currFrameIdxRef.current = playerIndex;
    updateFrame(playerIndex);
    preloadFrame(playerIndex + 1);
  };
  const seekToPlayerRef = useRef(seekToPlayer);
  seekToPlayerRef.current = seekToPlayer;

  // Publish an imperative controller for the Lab Assistant (the global AI widget) so its tools can place
  // a thermometer (needs the current frame's thermal buffer to seed the reading) and drive playback (the
  // playhead is a local ref, not in the store). Route through a latest-ref — like seekToPlayerRef above —
  // so the once-registered controller always calls the current closures; clear it on unmount.
  const playerOpsRef = useRef({
    addThermometerAt,
    updateThermoemterByPosition,
    seekToPlayer,
    play,
    stop,
    lastFrameIndex,
  });
  playerOpsRef.current = { addThermometerAt, updateThermoemterByPosition, seekToPlayer, play, stop, lastFrameIndex };
  useEffect(() => {
    const controller: PlayerController = {
      addThermometer: async (x, y, areaType) => {
        // addThermometerAt reads the current frame for the value and selects the new probe, so its id is
        // the selection right after it resolves. Apply the optional measuring area on top. This path is
        // only ever driven by the Lab Assistant, so the probe is marked AI-placed.
        await playerOpsRef.current.addThermometerAt(x, y, true);
        const store = useCommonStore.getState();
        const id = store.selectedThermometerId ?? '';
        if (id && areaType && areaType !== 'point') {
          store.updateThermometer(id, {
            measuringAreaType: areaType as MeasuringAreaType,
            measuringAreaWidth: 0.15,
            measuringAreaHeight: 0.15,
          });
          playerOpsRef.current.updateThermoemterByPosition(id, x, y);
        }
        return id;
      },
      seekToTime: (seconds) => {
        const idx = Math.max(0, Math.min(Math.round(seconds * FPS), playerOpsRef.current.lastFrameIndex));
        playerOpsRef.current.seekToPlayer(idx);
      },
      setPlaying: (playing) => {
        if (playing) {
          if (!intervalIdRef.current) playerOpsRef.current.play();
        } else {
          playerOpsRef.current.stop();
        }
      },
      getPlayhead: () => ({
        playerIndex: currFrameIdxRef.current,
        seconds: Number((currFrameIdxRef.current / FPS).toFixed(2)),
        lastFrameIndex: playerOpsRef.current.lastFrameIndex,
        totalSeconds: Number((playerOpsRef.current.lastFrameIndex / FPS).toFixed(2)),
      }),
    };
    playerRegistry.controller = controller;
    return () => {
      if (playerRegistry.controller === controller) playerRegistry.controller = null;
    };
    // Registered once; the controller reads the latest closures through playerOpsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Player <- panel bridges. We subscribe imperatively (outside render) and route through refs so the
  // Publish the frame timing so the key-moment time editor can convert a typed time to a frame. A
  // recording is a fixed FPS; lastFrameIndex bounds the clip.
  useEffect(() => {
    useCommonStore.getState().setPlayerFrameRate({ secondsPerFrame: 1 / FPS, lastFrame: lastFrameIndex });
  }, [lastFrameIndex]);

  // per-frame store churn never triggers these, and so the mount-time subscription always runs the
  // latest handler. The nonce on each request makes a repeat for the same target still fire.
  useEffect(() => {
    let prevSeek = useCommonStore.getState().keyframeSeek;
    let prevSnapshot = useCommonStore.getState().snapshotMomentRequest;
    let prevPlaySpan = useCommonStore.getState().playSpanRequest;
    let prevPause = useCommonStore.getState().pauseRequest;
    return useCommonStore.subscribe((state) => {
      if (state.keyframeSeek !== prevSeek) {
        prevSeek = state.keyframeSeek;
        if (prevSeek) seekToPlayerRef.current(prevSeek.playerIndex);
      }
      if (state.playSpanRequest !== prevPlaySpan) {
        prevPlaySpan = state.playSpanRequest;
        if (prevPlaySpan) playSpanRef.current(prevPlaySpan.startPlayerIndex, prevPlaySpan.endPlayerIndex);
      }
      if (state.pauseRequest !== prevPause) {
        prevPause = state.pauseRequest;
        if (prevPause) playerOpsRef.current.stop();
      }
      if (state.snapshotMomentRequest !== prevSnapshot) {
        prevSnapshot = state.snapshotMomentRequest;
        if (prevSnapshot) snapshotRef.current(prevSnapshot.purpose, prevSnapshot.target);
      }
    });
  }, []);

  // Close the right-click menu if the page scrolls under it: the analyzer now scrolls, and the menu's
  // recorded cursor position (lastContextPos, consumed on "Add … here") would otherwise go stale.
  useEffect(() => {
    if (!menuOpen) return;
    const content = document.querySelector('.content');
    if (!content) return;
    const onScroll = () => setMenuOpen(false);
    content.addEventListener('scroll', onScroll, { passive: true });
    return () => content.removeEventListener('scroll', onScroll);
  }, [menuOpen]);

  // The vis/mix probe is a tiny metadata GET racing the (much heavier) first-frame
  // download, so waiting for it too is imperceptible — and the toolbar renders with
  // its final set of buttons from the start.
  if (!currFrameImg || viewModesAvailable === null) return null;
  return (
    <>
      <div className="chart-manager-wrapper">
        <WorkspacePanel
          experiment={experiment}
          sandboxDirty={sandboxDirty}
          chart={
            <ChartManager
              expId={experiment.id}
              thermometersId={thermometersId}
              thermalData={lineplotThermoData}
              currFrameIndex={currFrameIdxRef.current}
              updateFrame={updateFrame}
              graphsOptions={graphsOptions}
              buffer={cacheThermoArrayBufferRef.current[imgFrameIdxRef.current]}
            />
          }
        />
      </div>

      <div className="image-player-wrapper">
        <div className="image-player">
          <Dropdown
            menu={{ items: contextMenuItems }}
            trigger={['contextMenu']}
            rootClassName="player-context-menu"
            open={menuOpen}
            onOpenChange={setMenuOpen}
          >
            <div className="image-wrapper" ref={imageWrapperRef} onContextMenu={onWrapperContextMenu}>
              <img className="current-frame-image" src={currFrameImg} />

              {showDiff && (
                <DiffView
                  buffer={cacheThermoArrayBufferRef.current[imgFrameIdxRef.current]}
                  refBuffer={cacheThermoArrayBufferRef.current[diffRefIndex]}
                  refLabel={`${(diffRefIndex / FPS).toFixed(1)}s`}
                  onSetReference={() => setDiffRefIndex(imgFrameIdxRef.current)}
                />
              )}

              {/* Isotherms / scale bar / hot-cold markers describe the ABSOLUTE image; the Δ view replaces
                  it with a difference image, so they're suppressed while Δ is on (their saved toggles are
                  untouched — they reappear when Δ is turned off). The toolbar greys these buttons too. */}
              {showIsotherms && !showDiff && (
                <Isotherms buffer={cacheThermoArrayBufferRef.current[imgFrameIdxRef.current]} expId={experiment.id} />
              )}

              {showScaleHotspots && !showDiff && (
                <ScaleHotspots
                  buffer={cacheThermoArrayBufferRef.current[imgFrameIdxRef.current]}
                  showBar={showScaleBar}
                  showMarkers={showHotspots}
                  paletteName={experiment.palette ?? detectedPalette}
                />
              )}

              <Spotmeter
                containerRef={imageWrapperRef}
                getBuffer={() => cacheThermoArrayBufferRef.current[imgFrameIdxRef.current]}
                // In Δ mode the spotmeter reads the reference frame too and shows the difference.
                showDiff={showDiff}
                getRefBuffer={() => cacheThermoArrayBufferRef.current[diffRefIndex]}
                // Swallow a failed .dat fetch: the spotmeter fires this on hover-move, and a frame whose
                // data_N.dat 404s would otherwise raise one unhandled rejection per move (the in-flight
                // dedupe already caps the actual network requests).
                ensureBuffer={() => {
                  loadThermalDataOnFrame(imgFrameIdxRef.current).catch(() => {});
                }}
              />

              <Thermometers
                expId={experiment.id}
                thermometersId={thermometersId}
                onUpdate={updateThermoemterByPosition}
                onAdd={addThermometerAt}
                showDiff={showDiff}
                refBuffer={cacheThermoArrayBufferRef.current[diffRefIndex]}
              />
              <Annotations
                ref={annotationsRef}
                expId={experiment.id}
                ownerId={experiment.ownerId}
                visibility={experiment.visibility}
                currentTime={currFrameIdxRef.current / FPS}
                duration={lastFrameIndex / FPS}
                onCountChange={setAnnotationCount}
                onCloseContextMenu={() => setMenuOpen(false)}
              />

              {/* Topmost so its endpoint/line hit-shapes win over the full-frame #thermometers-wrapper (a
                  desktop pointer-events:auto drop target). The rest of the layer is pointer-events:none, so
                  clicks fall through to the thermometers/annotations below except on the handles. */}
              {(hasProfileLines || profileLineDrawMode) && (
                <ProfileLineOverlay
                  expId={experiment.id}
                  buffer={cacheThermoArrayBufferRef.current[imgFrameIdxRef.current]}
                />
              )}
            </div>
          </Dropdown>

          <ControlBar
            isPlaying={isPlaying}
            currFrameIndex={currFrameIdxRef.current}
            lastFrameIndex={lastFrameIndex}
            onClickPlayButton={handleClickPlayButton}
            onSlide={throttle(handleSlide, 100)}
            onStep={stepFrame}
            playbackSpeed={playbackSpeed}
            onCycleSpeed={cycleSpeed}
            editMode={editMode}
            editedSegments={editedSegments}
            onEditRangeChange={handleEditRangeChange}
          />
        </div>

        <div className="tool-bar">
          <ToolBar
            expId={experiment.id}
            graphsOptions={graphsOptions}
            page={toolPage}
            availablePages={availablePages}
            onChangePage={goToPage}
            onAddThermometer={() => addThermometerAt()}
            viewMode={viewModesAvailable ? viewMode : undefined}
            onCycleViewMode={cycleViewMode}
            onScreenshot={saveScreenshot}
            // A toggle, like the other overlay buttons: while a 3D view is up — full window OR minimised
            // miniplayer — the button is lit and clicking it closes that view instead of opening another.
            onShow3D={() => setSurface3DOpen((o) => !o)}
            surface3DOpen={surface3DOpen}
            // Owner edits persist to the source, so there's nothing local to reset — non-owners only.
            // Wait for authReady so the owner never flashes the button during auth hydration.
            onResetView={authReady && !isOwner ? onReset : undefined}
            onAddSegment={onAddSegment}
            onUndoClip={onUndoLastSegment}
            onResetClip={onResetSegments}
            onSaveClip={openSaveModal}
            savingClip={savingClip}
            onAddAnnotation={onAddAnnotation}
          />
        </div>
      </div>

      <ThermalSurface3D
        open={surface3DOpen && surface3DView === 'modal'}
        onClose={() => setSurface3DOpen(false)}
        frameCount={lastFrameIndex + 1}
        loadFrame={async (i) => {
          await loadThermalDataOnFrame(i);
          return cacheThermoArrayBufferRef.current[i];
        }}
        fps={FPS}
        currentIndex={currFrameIdxRef.current}
        playing={isPlaying}
        onSeek={handleSlide}
        onTogglePlay={handleClickPlayButton}
        onSwap={() => setSurface3DView('window')}
      />

      <ThermalSurface3D
        floating
        open={surface3DOpen && surface3DView === 'window'}
        onClose={() => setSurface3DOpen(false)}
        frameCount={lastFrameIndex + 1}
        loadFrame={async (i) => {
          await loadThermalDataOnFrame(i);
          return cacheThermoArrayBufferRef.current[i];
        }}
        fps={FPS}
        currentIndex={currFrameIdxRef.current}
        playing={isPlaying}
        onSeek={handleSlide}
        onTogglePlay={handleClickPlayButton}
        onSwap={() => setSurface3DView('modal')}
      />

      <Modal
        title="Save as"
        open={saveModalOpen}
        onOk={doSaveClip}
        onCancel={() => setSaveModalOpen(false)}
        okText="OK"
        confirmLoading={savingClip}
        destroyOnHidden
      >
        <Input
          placeholder="Title"
          value={clipTitle}
          onChange={(e) => setClipTitle(e.target.value)}
          onPressEnter={doSaveClip}
          autoFocus
        />
      </Modal>
    </>
  );
};

export default ImagePlayer;
