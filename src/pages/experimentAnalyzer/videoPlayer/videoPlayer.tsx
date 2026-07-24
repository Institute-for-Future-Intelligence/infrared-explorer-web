import { CSSProperties, useEffect, useRef, useState } from 'react';
import { Dropdown, message } from 'antd';
import type { MenuProps } from 'antd';
import { firebaseStorage } from '../../../services/firebase';
import { exportElementToPNG, timestampedName } from '../../../utils/exporters';
import { getBytes, getDownloadURL, ref } from 'firebase/storage';
import ReactPlayer from 'react-player';
import ToolBar from '../toolBar';
import {
  Experiment,
  ExperimentGraphOption,
  LineplotData,
  MeasuringAreaType,
  TemperatureUnit,
  ToolPage,
  isTextOnlyModel,
} from '../../../types';
import ChartManager from '../charts/chartManager';
import WorkspacePanel from '../workspace/workspacePanel';
import Thermometers from '../thermometers/thermometers';
import { buildPlayerContextMenu, clickFraction, sameMenuTarget } from '../thermometers/playerContextMenu';
import Annotations, { AnnotationsHandle } from '../annotations/annotations';
import Isotherms from '../isotherms/isotherms';
import ScaleHotspots from '../scaleHotspots/scaleHotspots';
import Spotmeter from '../spotmeter/spotmeter';
import ProfileLineOverlay from '../profileLine/profileLine';
import ThermalSurface3D from '../surface3d/thermalSurface3D';
import useCommonStore, {
  SnapshotPurpose,
  MAX_KEY_MOMENTS,
  MAX_VISIBLE_CHARTS,
  visibleChartCount,
} from '../../../stores/common';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { useLongPressContextMenu } from '../../../hooks/useLongPressContextMenu';
import { parseRawThermalData } from '../../../utils/virReader';
import { getThermometerValue } from '../../../utils/temperatureReader';
import { LINTPLOT_DATAPOINT_LIMIT, VIDEO_PIXEL_CORS_READY } from '../../../utils/constants';
import { detectPaletteFromVideo } from '../../../utils/paletteDetect';
import { OnProgressProps } from 'react-player/base';
import { isStaff } from '../../../utils/staff';
import { useAnalysisPersistence } from '../useAnalysisPersistence';

interface Props {
  experiment: Experiment;
  // Toolbar "Reset" (non-owner only): discard local sandbox edits and reload from source. Owned by the
  // analyzer page (it re-fetches + remounts this player); we just surface it on the toolbar.
  onReset?: () => void;
}

const useVideoURL = (expName: string) => {
  const [videoURL, setVideoURL] = useState<string | null>(null);

  // get video URL
  useEffect(() => {
    getDownloadURL(ref(firebaseStorage, `videostore/${expName}.mp4`)).then((url) => {
      setVideoURL(url);
    });
  }, [expName]);

  return videoURL;
};

const VideoPlayer = ({ experiment, onReset }: Props) => {
  const { id, name, thermometersId, graphsOptions } = experiment;

  const videoURL = useVideoURL(name);

  // Staff-only: the Ask AI "+ Add moment" button snapshots the current frame (see the bridge below).
  const user = useCommonStore((state) => state.user);
  // Gate the owner-hidden Reset button on this: `user` is null until auth hydrates, so without it an owner
  // opening their OWN public clip would briefly see the button (isOwner false) until the session resolves.
  const authReady = useCommonStore((state) => state.authReady);
  // Key moments (chapters) are the owner's to curate — independent of the staff Q&A gate.
  const isOwner = !!user && experiment.ownerId === user.id;

  const [thermalData, setThermalData] = useState<ArrayBuffer[] | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null); // seconds
  const [lineplotData, setLineplotData] = useState<LineplotData | null>(null);
  // Intrinsic video aspect ratio (w/h), read once metadata loads. On mobile the player box is sized to
  // it so the frame fills the box with no letterboxing — otherwise the native (iOS) video controls,
  // which anchor to the actual frame, sit in the wrong place. These thermal clips are often portrait.
  const isMobile = useIsMobile();
  const [videoAspect, setVideoAspect] = useState<number | null>(null);

  const [currFrameIndex, setCurrFrameIndex] = useState(0);
  // Controlled play state for the <video>, kept in sync with the native controls (onPlay/onPause).
  // Lets the 3D surface modal — which covers the native controls — drive play/pause and reflect it.
  const [playing, setPlaying] = useState(false);

  // Palette auto-detected from a video frame — DORMANT until the videostore bucket serves CORS
  // (VIDEO_PIXEL_CORS_READY). Until then the mp4 canvas is tainted (unreadable) and a manual tag / the
  // approximate ramp cover videos. The resolved key feeds ScaleHotspots so its ramp matches the mp4.
  const [detectedPalette, setDetectedPalette] = useState<string | null>(null);
  const paletteDetectDoneRef = useRef(false);

  const loadLineplotData = async (thermalData: ArrayBuffer[], duration: number) => {
    const totalFrameCount = thermalData.length;
    const maxPoints = Math.min(LINTPLOT_DATAPOINT_LIMIT, totalFrameCount);
    const step = Math.floor(totalFrameCount / maxPoints);

    const arrayBuffer = Array(maxPoints)
      .fill(0)
      .map((v, i) => thermalData[Math.min(totalFrameCount - 1, i * step)]);

    setLineplotData({ arrayBuffer, step, secondPerFrame: duration / totalFrameCount });
  };

  const fetchShowcaseRawThermalData = (showcaseName: string) => {
    return getBytes(ref(firebaseStorage, `videostore/${showcaseName}.vir`));
  };

  // The player right-click menu is controlled so we can (a) force it shut when the annotation layer
  // takes over an interaction — rc-dropdown only auto-hides a contextMenu menu on a left click, which
  // a right-click on a callout never produces — and (b) freeze its target while it's open.
  const [menuOpen, setMenuOpen] = useState(false);
  const [surface3DOpen, setSurface3DOpen] = useState(false);
  const [surfaceWindowOpen, setSurfaceWindowOpen] = useState(false);
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
  const [menuProfileLineId, setMenuProfileLineId] = useState<string | null>(null);
  const menuProfileLine = useCommonStore((state) =>
    menuProfileLineId
      ? state.experimentMap.get(experiment.id)?.profileLines?.find((l) => l.id === menuProfileLineId)
      : undefined,
  );
  // True once every thermometer for this experiment is present in the store. Thermometers load
  // asynchronously and the experiment can be served from the (never-cleared) experimentMap cache
  // before they arrive, so reading-seeding must wait for them. Boolean output keeps per-frame value
  // writes from re-rendering the player.
  const thermometersReady = useCommonStore(
    (state) => thermometersId.length > 0 && thermometersId.every((id) => state.thermometerMap.has(id)),
  );
  // Whether the store already reflects this experiment's saved analysis: nothing to load, or every
  // thermometer present. `thermometersReady` requires length > 0 (its seeding job is moot with no
  // thermometers), but the persistence baseline must also treat an empty set as loaded — otherwise
  // deleting every thermometer would stall the save path. Gates the hook below.
  const analysisLoaded = thermometersId.length === 0 || thermometersReady;
  // Owner edits auto-persist (debounced, flushed on leave); a non-owner / signed-out viewer's edits
  // stay in the local sandbox and raise `sandboxDirty` so the workspace can offer to save a copy. Video
  // sources re-derive thermometers from the .wrk preset on load, so the owner's save flags the doc
  // (markCustomThermometers) to read the saved subcollection instead. See useAnalysisPersistence.
  const sandboxDirty = useAnalysisPersistence(experiment, analysisLoaded, { markCustomThermometers: true });

  // Active toolbar page (telelab ControlBarState parity). Videos have no clip page; the annotate
  // page surfaces the add / reword annotation tools (available to anyone — it's a local sandbox).
  const [toolPage, setToolPage] = useState<ToolPage>('analyze');
  const [rewording, setRewording] = useState(false);
  const annotating = toolPage === 'annotate';
  const annotationsRef = useRef<AnnotationsHandle>(null);
  // Count of deletable annotations, reported up by <Annotations>, so the background right-click menu
  // only shows "Delete all annotations" when there are some.
  const [annotationCount, setAnnotationCount] = useState(0);
  const onDeleteAllAnnotations = () => annotationsRef.current?.deleteAll();
  // Last right-click position (client coords), captured on the wrapper's onContextMenu, so a menu
  // "Add …" drops the thermometer / annotation at the cursor rather than at the centre.
  const lastContextPos = useRef<{ x: number; y: number } | null>(null);
  // The analyzer is a local sandbox: anyone (signed-out included) can place thermometers/annotations
  // on any experiment; signed-in users keep their work by cloning it (Save to My Experiments). Edits
  // to the source itself persist only for the owner (auto-save + the Firestore rules are owner-gated).
  const canAnnotate = true;
  const availablePages: ToolPage[] = canAnnotate ? ['analyze', 'annotate'] : ['analyze'];

  const goToPage = (page: ToolPage) => {
    if (page !== 'annotate') setRewording(false);
    setToolPage(page);
  };
  const onAddAnnotation = () => annotationsRef.current?.add();
  const onToggleReword = () => setRewording((v) => !v);

  /** x,y is [0,1] */
  const updateThermoemterByPosition = (id: string, x: number, y: number) => {
    useCommonStore.getState().setStore((state) => {
      if (!thermalData) return;
      const thermometer = state.thermometerMap.get(id);
      if (thermometer) {
        thermometer.x = x;
        thermometer.y = y;
        const arrayBuffer = thermalData[currFrameIndex];
        thermometer.value = getThermometerValue(arrayBuffer, thermometer);
      }
    });
  };

  /** Add a thermometer at [0,1] image coords (default centre), reading its value from the current frame. */
  const addThermometerAt = (x = 0.5, y = 0.5) => {
    const id = crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}-${Math.round(performance.now())}`;
    const arrayBuffer = thermalData?.[currFrameIndex];
    const value = arrayBuffer ? getThermometerValue(arrayBuffer, { x, y }) : 0;
    const store = useCommonStore.getState();
    store.addThermometer(experiment.id, { id, x, y, value, unit: TemperatureUnit.celsius });
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

  // "Add a line" from the right-click menu — same as the toolbar button (enable T(l) + add + reveal charts).
  const onAddProfileLineFromMenu = () => {
    const s = useCommonStore.getState();
    if (!graphsOptions?.includes(ExperimentGraphOption.lineProfile)) {
      // Needs a free chart slot to reveal the T(l) plot; at the cap, warn instead of adding an invisible line.
      if (visibleChartCount(graphsOptions) >= MAX_VISIBLE_CHARTS) {
        message.info(`You can show up to ${MAX_VISIBLE_CHARTS} graphs at once — turn one off to add a line profile.`);
        return;
      }
      s.toggleGraphOption(experiment.id, ExperimentGraphOption.lineProfile);
    }
    s.addProfileLine(experiment.id);
    s.setMaximizedChart(null);
    s.setWorkspaceMode('charts');
  };

  // Right-click menu: a selected thermometer gets Measuring Area + delete it; a selected line gets rename +
  // delete; the empty video gets add thermometer / line / annotation / delete all. Every delete confirms.
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
  });

  const updateThermometersByFrame = (thermalData: ArrayBuffer[], index: number) => {
    useCommonStore.getState().setStore((state) => {
      if (!thermalData) return;
      for (const thermometerId of thermometersId) {
        const thermometer = state.thermometerMap.get(thermometerId);
        if (thermometer) {
          const arrayBuffer = thermalData[index];
          thermometer.value = getThermometerValue(arrayBuffer, thermometer);
        }
      }
    });
  };

  const init = async () => {
    const cachedThermalArrayBuffer = useCommonStore.getState().showcaseThermalCache.get(id);
    if (cachedThermalArrayBuffer) {
      setThermalData(cachedThermalArrayBuffer);
      // Seed readings from the first frame here too; without it a cache hit leaves every
      // thermometer at its default 0 until playback first reports progress.
      updateThermometersByFrame(cachedThermalArrayBuffer, 0);
    } else {
      const rawThermalData = await fetchShowcaseRawThermalData(name);
      const thermalData = parseRawThermalData(rawThermalData);
      setThermalData(thermalData);
      useCommonStore.getState().setShowcaseThermalCache(id, thermalData);
      updateThermometersByFrame(thermalData, 0);
    }
  };

  // init
  useEffect(() => {
    init();
  }, []);

  // Seed readings once both the thermometers and the thermal data are available. The experiment can
  // render from cache before its thermometers reload into the store, so the one-shot seed in init()
  // isn't enough — without this the overlays and X/Y plots sit at the default 0 until playback.
  useEffect(() => {
    if (!thermometersReady || !thermalData) return;
    updateThermometersByFrame(thermalData, currFrameIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thermometersReady, thermalData]);

  // init lineplot
  useEffect(() => {
    if (thermalData == null || videoDuration === null) return;
    loadLineplotData(thermalData, videoDuration);
  }, [videoDuration, thermalData]);

  // Publish the frame timing so the key-moment time editor can convert a typed time to a .vir frame.
  useEffect(() => {
    if (!videoDuration || !thermalData || thermalData.length === 0) return;
    useCommonStore.getState().setPlayerFrameRate({
      secondsPerFrame: videoDuration / thermalData.length,
      lastFrame: thermalData.length - 1,
    });
  }, [videoDuration, thermalData]);

  // When set (a key-moment span is playing), pause once the playhead reaches this .vir frame. Cleared by
  // any manual pause / single-frame seek so ordinary playback is never bounded.
  const spanEndFrameRef = useRef<number | null>(null);

  const handlePlayerProgress = (progress: OnProgressProps) => {
    if (thermalData === null) return;
    const totalFrameCount = thermalData.length;
    const index = Math.max(0, Math.floor(progress.played * (totalFrameCount - 1)));
    setCurrFrameIndex(index);
    updateThermometersByFrame(thermalData, index);
    // Span playback: stop at the end frame, then seek back exactly onto it (progressInterval can overshoot).
    if (spanEndFrameRef.current !== null && index >= spanEndFrameRef.current) {
      const end = spanEndFrameRef.current;
      spanEndFrameRef.current = null;
      setPlaying(false);
      updateFrameIndexByPlot(end);
    }
  };

  const updateFrameIndexByPlot = (index: number) => {
    if (thermalData === null || videoDuration === null) return;
    if (playerRef.current && thermalData) {
      // work aroung a bug: if seek to the end of the video by this mothod, then we can't not seek for other time anymore.
      playerRef.current.seekTo(Math.min((index / thermalData.length) * videoDuration, Math.floor(videoDuration - 1)));
    }
  };

  // Play a key-moment span: seek to the start frame, play, and pause at the end frame (spanEndFrameRef
  // bounds it in handlePlayerProgress). Both indices are .vir frame indices (the video's player space).
  const playSpan = (startPlayerIndex: number, endPlayerIndex: number) => {
    updateFrameIndexByPlot(startPlayerIndex);
    spanEndFrameRef.current = endPlayerIndex;
    setPlaying(true);
  };
  const playSpanRef = useRef(playSpan);
  playSpanRef.current = playSpan;

  const playerRef = useRef<ReactPlayer>(null!);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  // Mobile: a long press on the player synthesises a contextmenu so the right-click menu opens.
  useLongPressContextMenu(videoContainerRef);

  // One-shot palette detection from a video frame — only once the bucket serves CORS (see detectedPalette
  // above); otherwise the canvas is tainted and this is skipped. Runs when the bar is shown for an
  // experiment with no stored palette; retries as the frame index advances until a frame decodes + matches.
  useEffect(() => {
    if (!VIDEO_PIXEL_CORS_READY || paletteDetectDoneRef.current || experiment.palette || !thermalData) return;
    const wantsBar =
      graphsOptions?.includes(ExperimentGraphOption.scaleBar) ||
      graphsOptions?.includes(ExperimentGraphOption.hotspots);
    if (!wantsBar) return;
    const video = playerRef.current?.getInternalPlayer() as HTMLVideoElement | undefined;
    const buffer = thermalData[currFrameIndex];
    if (!video || !video.videoWidth || !buffer) return;
    const key = detectPaletteFromVideo(video, buffer);
    if (key) {
      paletteDetectDoneRef.current = true;
      setDetectedPalette(key);
    }
  }, [currFrameIndex, thermalData, experiment.palette, graphsOptions]);

  // Composited PNG of the video frame + thermometer / annotation / isotherm overlays. The browser
  // may taint a cross-origin <video>, in which case html2canvas throws — surface that gracefully.
  const saveScreenshot = async () => {
    if (!videoContainerRef.current) return;
    try {
      await exportElementToPNG(videoContainerRef.current, timestampedName('frame', 'png'));
    } catch (e) {
      console.error('failed to export screenshot', e);
      message.error('Could not capture the video frame (cross-origin video).');
    }
  };

  // Snapshot the current playhead into the store — a Q&A "moment" (purpose 'qa', staff, capped at 3), a
  // single-frame key moment ('keyMoment', owner), the start / end of a key-moment span ('spanStart' /
  // 'spanEnd', owner), or re-anchoring an existing moment ('reanchor', owner; `target` is its old
  // recordingIndex). recordingIndex is the .vir frame index (the server decodes that frame); tSeconds is
  // derived from it. A video has no CORS-safe per-frame image, so the moment carries no thumbnail.
  const snapshotCurrentMoment = (purpose: SnapshotPurpose = 'qa', target?: number) => {
    if (thermalData === null) return;
    if (purpose === 'qa') {
      if (!isStaff(user)) return;
      // A text-only model can't use an attached frame — don't attach one (the panel button is already
      // disabled; this guards the store-bridge path too).
      if (isTextOnlyModel(useCommonStore.getState().qaModel)) {
        message.info('This model can’t see frames — switch to a GPT, Gemini or Grok model to attach a moment.');
        return;
      }
    } else if (!isOwner) {
      return; // key moments / spans are the owner's to curate
    }
    const frameIndex = currFrameIndex;
    const secondPerFrame = videoDuration && thermalData.length ? videoDuration / thermalData.length : 0;
    const tSeconds = Number((frameIndex * secondPerFrame).toFixed(1));
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
      if (frameIndex <= start.recordingIndex) {
        message.info('The end of a range must come after its start.');
        return;
      }
      store.addKeyMoment({ ...start, endRecordingIndex: frameIndex, endTSeconds: tSeconds });
      store.setPendingSpanStart(null);
      return;
    }

    // Re-anchor an existing moment's start to the current frame (keeps its caption / span end).
    if (purpose === 'reanchor') {
      if (target === undefined) return;
      const marked = store.keyMoments;
      const m = marked.find((k) => k.recordingIndex === target);
      if (!m) return;
      if (marked.some((k) => k.recordingIndex !== target && k.recordingIndex === frameIndex)) {
        message.info('There’s already a key moment on this frame.');
        return;
      }
      if (m.endRecordingIndex !== undefined && frameIndex >= m.endRecordingIndex) {
        message.info('Move the start before the end of the range.');
        return;
      }
      store.reanchorKeyMoment(target, { recordingIndex: frameIndex, tSeconds, thumbnail: '', readings });
      return;
    }

    // Move a span's end to the current frame (start unchanged).
    if (purpose === 'reanchorEnd') {
      if (target === undefined) return;
      const m = store.keyMoments.find((k) => k.recordingIndex === target);
      if (!m) return;
      if (frameIndex <= m.recordingIndex) {
        message.info('The end of a range must come after its start.');
        return;
      }
      store.reanchorKeyMomentEnd(target, frameIndex, tSeconds);
      return;
    }

    // qa / keyMoment / spanStart all snapshot the current frame; check the destination's cap first.
    if (purpose === 'qa') {
      const attached = store.attachedMoments;
      if (attached.length >= 3 && !attached.some((m) => m.recordingIndex === frameIndex)) {
        message.info('You can attach up to 3 moments — remove one first.');
        return;
      }
    } else {
      const marked = store.keyMoments;
      if (marked.length >= MAX_KEY_MOMENTS && !marked.some((m) => m.recordingIndex === frameIndex)) {
        message.info(`You can mark up to ${MAX_KEY_MOMENTS} key moments — remove one first.`);
        return;
      }
    }
    const moment = { recordingIndex: frameIndex, tSeconds, thumbnail: '', readings };
    if (purpose === 'qa') store.addAttachedMoment(moment);
    else if (purpose === 'spanStart') store.setPendingSpanStart(moment);
    else store.addKeyMoment(moment);
  };
  // Route the store bridges through refs so the mount-time subscription always runs the latest handler
  // (closing over the current frame / thermal data) without re-subscribing on every frame.
  const snapshotRef = useRef(snapshotCurrentMoment);
  snapshotRef.current = snapshotCurrentMoment;
  const seekToFrameRef = useRef(updateFrameIndexByPlot);
  seekToFrameRef.current = updateFrameIndexByPlot;

  // Ask AI panel <- -> player bridges (mirrors ImagePlayer). keyframeSeek carries the .vir frame index
  // for a video (the Q&A panel passes it through unmapped); snapshotMomentRequest fires "+ Add moment".
  // The nonce on each request makes a repeat for the same target still fire.
  useEffect(() => {
    let prevSeek = useCommonStore.getState().keyframeSeek;
    let prevSnapshot = useCommonStore.getState().snapshotMomentRequest;
    let prevPlaySpan = useCommonStore.getState().playSpanRequest;
    let prevPause = useCommonStore.getState().pauseRequest;
    return useCommonStore.subscribe((state) => {
      if (state.keyframeSeek !== prevSeek) {
        prevSeek = state.keyframeSeek;
        if (prevSeek) {
          spanEndFrameRef.current = null; // a single-frame seek cancels any span in progress
          seekToFrameRef.current(prevSeek.playerIndex);
        }
      }
      if (state.playSpanRequest !== prevPlaySpan) {
        prevPlaySpan = state.playSpanRequest;
        if (prevPlaySpan) playSpanRef.current(prevPlaySpan.startPlayerIndex, prevPlaySpan.endPlayerIndex);
      }
      if (state.pauseRequest !== prevPause) {
        prevPause = state.pauseRequest;
        if (prevPause) {
          spanEndFrameRef.current = null;
          setPlaying(false);
        }
      }
      if (state.snapshotMomentRequest !== prevSnapshot) {
        prevSnapshot = state.snapshotMomentRequest;
        if (prevSnapshot) snapshotRef.current(prevSnapshot.purpose, prevSnapshot.target);
      }
    });
  }, []);

  // Close the right-click menu if the page scrolls under it: the analyzer now scrolls, and a menu left
  // open over a moved player reads as detached. (Mirrors ImagePlayer.)
  useEffect(() => {
    if (!menuOpen) return;
    const content = document.querySelector('.content');
    if (!content) return;
    const onScroll = () => setMenuOpen(false);
    content.addEventListener('scroll', onScroll, { passive: true });
    return () => content.removeEventListener('scroll', onScroll);
  }, [menuOpen]);

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
              thermalData={lineplotData}
              currFrameIndex={currFrameIndex}
              updateFrame={updateFrameIndexByPlot}
              graphsOptions={graphsOptions}
              buffer={thermalData?.[currFrameIndex]}
            />
          }
        />
      </div>

      <div className="video-player-wrapper">
        <Dropdown
          menu={{ items: contextMenuItems }}
          trigger={['contextMenu']}
          rootClassName="player-context-menu"
          open={menuOpen}
          onOpenChange={setMenuOpen}
        >
          <div
            className="video-player"
            ref={videoContainerRef}
            onContextMenu={onWrapperContextMenu}
            // --frame-aspect drives the desktop width cap (App.css: the media box keeps this ratio so a
            // landscape clip can't crowd out the workspace, and the overlays stay glued to the frame).
            // Mobile also needs a DEFINITE height: iOS Safari treats an aspect-ratio box as indefinite for
            // the percentage-height <video>, so it balloons and the native play button fills the screen —
            // a vw-derived height avoids that. The player width is (100vw - 16px) from .content's padding.
            style={
              {
                ...(videoAspect ? { '--frame-aspect': `${videoAspect}` } : {}),
                ...(isMobile && videoAspect ? { height: `calc((100vw - 16px) / ${videoAspect})` } : {}),
              } as CSSProperties
            }
          >
            {videoURL && (
              <ReactPlayer
                ref={playerRef}
                className={'react-player'}
                width={'100%'}
                height={'100%'}
                url={videoURL}
                controls
                playsinline
                // crossOrigin only once the bucket serves CORS — setting it before that makes the video
                // fail to load. Enables reading a video frame to canvas for palette detection.
                config={VIDEO_PIXEL_CORS_READY ? { file: { attributes: { crossOrigin: 'anonymous' } } } : undefined}
                playing={playing}
                // Tighter than the 1000ms default so span playback pauses near the end frame (the handler
                // seeks back onto it) and the overlay tracks playback closely.
                progressInterval={100}
                onPlay={() => {
                  setPlaying(true);
                  useCommonStore.getState().setPlayerPlaying(true);
                }}
                onPause={() => {
                  spanEndFrameRef.current = null; // a manual pause cancels an in-progress span
                  setPlaying(false);
                  useCommonStore.getState().setPlayerPlaying(false);
                }}
                onEnded={() => {
                  setPlaying(false);
                  useCommonStore.getState().setPlayerPlaying(false);
                }}
                onProgress={handlePlayerProgress}
                onReady={(reactPlayer) => {
                  setVideoDuration(reactPlayer.getDuration());
                  // Size the player box to the clip's real aspect ratio (these are often portrait).
                  const el = reactPlayer.getInternalPlayer() as HTMLVideoElement | undefined;
                  if (el?.videoWidth && el?.videoHeight) setVideoAspect(el.videoWidth / el.videoHeight);
                }}
              />
            )}
            {thermalData && (
              <div className="video-player-thermometers">
                <Thermometers
                  expId={experiment.id}
                  thermometersId={thermometersId}
                  onUpdate={updateThermoemterByPosition}
                  onAdd={addThermometerAt}
                />
              </div>
            )}
            {thermalData && graphsOptions?.includes(ExperimentGraphOption.isotherm) && (
              <Isotherms buffer={thermalData[currFrameIndex]} />
            )}
            {thermalData &&
              (graphsOptions?.includes(ExperimentGraphOption.scaleBar) ||
                graphsOptions?.includes(ExperimentGraphOption.hotspots)) && (
                <ScaleHotspots
                  buffer={thermalData[currFrameIndex]}
                  showBar={graphsOptions?.includes(ExperimentGraphOption.scaleBar)}
                  showMarkers={graphsOptions?.includes(ExperimentGraphOption.hotspots)}
                  paletteName={experiment.palette ?? detectedPalette}
                />
              )}
            {thermalData && (
              <Spotmeter containerRef={videoContainerRef} getBuffer={() => thermalData[currFrameIndex]} />
            )}
            <Annotations
              ref={annotationsRef}
              expId={experiment.id}
              ownerId={experiment.ownerId}
              visibility={experiment.visibility}
              annotating={annotating}
              rewording={rewording}
              currentTime={
                thermalData && thermalData.length > 1
                  ? (currFrameIndex / (thermalData.length - 1)) * (videoDuration ?? 0)
                  : 0
              }
              duration={videoDuration ?? 0}
              onCountChange={setAnnotationCount}
              onCloseContextMenu={() => setMenuOpen(false)}
            />

            {/* Topmost so its hit-shapes win over the thermometer/annotation overlays (see imagePlayer). */}
            {thermalData && graphsOptions?.includes(ExperimentGraphOption.lineProfile) && (
              <ProfileLineOverlay expId={experiment.id} buffer={thermalData[currFrameIndex]} />
            )}
          </div>
        </Dropdown>

        <div className="tool-bar">
          <ToolBar
            expId={experiment.id}
            graphsOptions={graphsOptions}
            page={toolPage}
            availablePages={availablePages}
            onChangePage={goToPage}
            onAddThermometer={() => addThermometerAt()}
            onScreenshot={saveScreenshot}
            onShow3D={() => setSurface3DOpen(true)}
            // Owner edits persist to the source, so there's nothing local to reset — non-owners only.
            // Wait for authReady so the owner never flashes the button during auth hydration.
            onResetView={authReady && !isOwner ? onReset : undefined}
            onAddAnnotation={onAddAnnotation}
            onToggleReword={onToggleReword}
            rewording={rewording}
          />
        </div>
      </div>

      <ThermalSurface3D
        open={surface3DOpen}
        onClose={() => setSurface3DOpen(false)}
        frameCount={thermalData?.length ?? 0}
        loadFrame={async (i) => thermalData?.[i]}
        fps={thermalData && videoDuration ? thermalData.length / videoDuration : undefined}
        currentIndex={currFrameIndex}
        playing={playing}
        onSeek={updateFrameIndexByPlot}
        onTogglePlay={() => setPlaying((p) => !p)}
        liveSeek
        onSwap={() => {
          setSurface3DOpen(false);
          setSurfaceWindowOpen(true);
        }}
      />

      <ThermalSurface3D
        floating
        open={surfaceWindowOpen}
        onClose={() => setSurfaceWindowOpen(false)}
        frameCount={thermalData?.length ?? 0}
        loadFrame={async (i) => thermalData?.[i]}
        fps={thermalData && videoDuration ? thermalData.length / videoDuration : undefined}
        currentIndex={currFrameIndex}
        playing={playing}
        onSeek={updateFrameIndexByPlot}
        onTogglePlay={() => setPlaying((p) => !p)}
        liveSeek
        onSwap={() => {
          setSurfaceWindowOpen(false);
          setSurface3DOpen(true);
        }}
      />
    </>
  );
};

export default VideoPlayer;
