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
  isTextOnlyModel,
} from '../../../types';
import { useMappingIndex } from '../hooks';
import { getThermometerValue } from '../../../utils/temperatureReader';
import Thermometers from '../thermometers/thermometers';
import { buildPlayerContextMenu, clickFraction, sameMenuTarget } from '../thermometers/playerContextMenu';
import Annotations, { AnnotationsHandle } from '../annotations/annotations';
import Isotherms from '../isotherms/isotherms';
import ThermalSurface3D from '../surface3d/thermalSurface3D';
import useCommonStore, { SnapshotPurpose, MAX_KEY_MOMENTS } from '../../../stores/common';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import ChartManager from '../charts/chartManager';
import WorkspacePanel from '../workspace/workspacePanel';
import ToolBar from '../toolBar';
import { FPS, LINTPLOT_DATAPOINT_LIMIT } from '../../../utils/constants';
import { useNavigate } from 'react-router-dom';
import { cloneExperiment } from '../../../services/experiments';
import { useAnalysisPersistence } from '../useAnalysisPersistence';
import { exportElementToPNG, timestampedName } from '../../../utils/exporters';
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

interface Props {
  experiment: Experiment;
}

const ImagePlayer = ({ experiment }: Props) => {
  const { recordingId, currentFrameNumber = 1, duration, segments, graphsOptions, thermometersId } = experiment;
  const delay = useMemo(() => {
    return (1 / FPS) * 1000;
  }, []);

  // only map to recording index when fetch from firebase.
  const { lastFrameIndex, getRecordingIndex, getPlayerIndex } = useMappingIndex(segments, duration);

  const navigate = useNavigate();
  const user = useCommonStore((state) => state.user);
  // The AI Q&A "Ask about this moment" / "+ Add moment" is open to ANY staff — the panel and the server
  // are (a non-owner's thread just stays in their browser). Owner-gating the snapshot would silently
  // no-op "+ Add moment" for a non-owner staffer, who still sees the button.
  const canAskMoment = isStaff(user);
  // Key moments (chapters) are the OWNER's to curate — independent of the staff Q&A gate above.
  const isOwner = !!user && experiment.ownerId === user.id;
  // A text-only model (no vision) never sees the attached frame, so moment-attach is disabled while it's
  // the selected Q&A model. Reason string is shown inline in the disabled right-click entry.
  const momentBlockedReason = useCommonStore((state) =>
    isTextOnlyModel(state.qaModel)
      ? 'This model can’t see frames — switch to a GPT, Gemini or Grok model to attach a moment'
      : undefined,
  );
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
  // Active toolbar page (telelab ControlBarState parity). The clip page is itself "edit clip" mode;
  // the annotate page makes notes editable. Capability gates which pages the arrows can reach.
  const [toolPage, setToolPage] = useState<ToolPage>('analyze');
  const [rewording, setRewording] = useState(false);
  const editMode = toolPage === 'clip';
  const annotating = toolPage === 'annotate';
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
  if (canAnnotate) availablePages.push('annotate');
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
  const pendingThermoRef = useRef<Map<number, Promise<void>>>(new Map());
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

  const showLineplotThremoData = graphsOptions?.includes(ExperimentGraphOption.time);
  const showIsotherms = graphsOptions?.includes(ExperimentGraphOption.isotherm);
  const needCurrFrameThermoData = thermometersId.length > 0 || !!showIsotherms;
  // Latest-ref mirror for the arrival bump: the load closures outlive renders (same pattern as
  // viewModeRef), and the overlay is the cache's only render-time reader — when isotherms are off
  // (thermometer-only sessions also fetch .dat), a bump would re-render the whole tree for nothing.
  const showIsothermsRef = useRef(showIsotherms);
  showIsothermsRef.current = showIsotherms;

  // Snapshot the current playhead into the store — a Q&A "moment" (purpose 'qa', staff, capped at 3), a
  // single-frame key moment ('keyMoment', owner), or the start / end of a key-moment span ('spanStart' /
  // 'spanEnd', owner). Only the player can build this: it owns the frame index, the on-screen image, and
  // the live probe readings. Frozen at call time so later playback doesn't drift it.
  const snapshotCurrentMoment = (purpose: SnapshotPurpose = 'qa') => {
    if (purpose === 'qa') {
      if (!canAskMoment) return;
      // Defensive: the panel button and menu entry are already disabled for a text-only model, but the
      // store bridge could still route a request here — don't attach a frame the model can't use.
      if (momentBlockedReason) {
        message.info('This model can’t see frames — switch to a GPT, Gemini or Grok model to attach a moment.');
        return;
      }
    } else if (!isOwner) {
      return; // key moments / spans are the owner's to curate
    }
    const playerIndex = currFrameIdxRef.current;
    const recordingIndex = getRecordingIndex(playerIndex);
    const tSeconds = Number((playerIndex / FPS).toFixed(1));
    const store = useCommonStore.getState();

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
    const readings = thermometersId
      .map((id, i) => {
        const t = store.thermometerMap.get(id);
        return t ? { label: t.name?.trim() || `T${i + 1}`, value: t.value } : null;
      })
      .filter((r): r is { label: string; value: number } => r !== null);
    const moment = { recordingIndex, tSeconds, thumbnail: currFrameImg ?? '', readings };
    if (purpose === 'qa') store.addAttachedMoment(moment);
    else if (purpose === 'spanStart') store.setPendingSpanStart(moment);
    else store.addKeyMoment(moment);
  };
  const snapshotRef = useRef(snapshotCurrentMoment);
  snapshotRef.current = snapshotCurrentMoment;

  const fetchThermalData = async (index: number) => {
    if (cacheThermoArrayBufferRef.current[index]) return cacheThermoArrayBufferRef.current[index];
    const mappedIndex = getRecordingIndex(index);
    return await getBytes(ref(firebaseStorage, `recordings/${recordingId}/data_${mappedIndex}.dat`));
  };

  // todo: sample function
  const loadThermoDataForPlot = async () => {
    const maxPoints = Math.min(LINTPLOT_DATAPOINT_LIMIT, lastFrameIndex + 1);
    const step = Math.floor((lastFrameIndex + 1) / maxPoints);

    const arrayBuffer = await Promise.all(
      Array(maxPoints)
        .fill(0)
        .map(async (v, i) => fetchThermalData(Math.min(lastFrameIndex, i * step))),
    );

    setLineplotThermoData({ arrayBuffer, step, secondPerFrame: 1 / FPS });
    arrayBuffer.forEach((data, i) => {
      cacheThermoArrayBufferRef.current[Math.min(lastFrameIndex, i * step)] = data;
    });
  };

  const loadThermalDataOnFrame = async (index: number): Promise<void> => {
    if (cacheThermoArrayBufferRef.current[index]) return;
    const inFlight = pendingThermoRef.current.get(index);
    if (inFlight) return inFlight;
    const load = (async () => {
      const arrayBuffer = await fetchThermalData(index);
      cacheThermoArrayBufferRef.current[index] = arrayBuffer;
      // Checked at arrival, not at request: a prefetch issued for a future frame may land after the
      // playhead has moved onto it. Matched against the DISPLAYED frame (not the playhead) so a
      // buffer for a seeked-to frame whose image is still decoding doesn't repaint the overlay
      // against the old image — the image's own arrival render pairs them up instead.
      if (showIsothermsRef.current && index === imgFrameIdxRef.current) setThermoFrameTick((v) => v + 1);
    })().finally(() => pendingThermoRef.current.delete(index));
    pendingThermoRef.current.set(index, load);
    return load;
  };

  const updateThermometersByFrame = (index: number) => {
    useCommonStore.getState().setStore((state) => {
      for (const thermometerId of thermometersId) {
        const thermometer = state.thermometerMap.get(thermometerId);
        if (thermometer) {
          const arrayBuffer = cacheThermoArrayBufferRef.current[index];
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

  /** Add a thermometer at [0,1] image coords (default centre), reading its value from the current frame. */
  const addThermometerAt = async (x = 0.5, y = 0.5) => {
    const id = crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}-${Math.round(performance.now())}`;
    await loadThermalDataOnFrame(currFrameIdxRef.current);
    const arrayBuffer = cacheThermoArrayBufferRef.current[currFrameIdxRef.current];
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
  };

  // Right-click menu: a selected thermometer gets Measuring Area + delete it; the empty image gets
  // add thermometer / add annotation / delete all. Every delete confirms first.
  const contextMenuItems: MenuProps['items'] = buildPlayerContextMenu({
    expId: experiment.id,
    selectedThermometer: menuTarget,
    thermometersId,
    annotationCount,
    canAddAnnotation: canAnnotate,
    onAdd: onAddThermometerFromMenu,
    onAddAnnotation: onAddAnnotationFromMenu,
    onPickMeasuringArea,
    onDeleteAllAnnotations,
    canAskMoment,
    askMomentDisabledReason: momentBlockedReason,
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
    // has line plot
    if (showLineplotThremoData) {
      await loadThermoDataForPlot();
    }
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

  // toggle plot
  useEffect(() => {
    if (showLineplotThremoData) {
      loadThermoDataForPlot();
    }
  }, [showLineplotThremoData]);

  // Isotherms toggled on mid-session: init() only fetched the current frame's .dat when a
  // thermometer (or the saved option) already demanded it at mount, so a later toggle-on must fetch
  // it now — otherwise the overlay stays empty until playback pulls the frame. Already-cached hit
  // is a no-op (the toggle itself re-rendered, and the render reads the cache directly); on a miss
  // the arrival bump in loadThermalDataOnFrame repaints the overlay.
  useEffect(() => {
    if (showIsotherms) loadThermalDataOnFrame(currFrameIdxRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showIsotherms]);

  // Owner edits auto-persist (debounced, flushed on leave); a non-owner / signed-out viewer's edits
  // stay in the local sandbox and instead raise `sandboxDirty` so the workspace can offer to save a
  // copy. `analysisLoaded` gates the baseline so a cached revisit's async thermometer reload isn't
  // mistaken for an edit. Recordings persist to the subcollection unconditionally (no customThermometers
  // flag needed). See useAnalysisPersistence.
  const sandboxDirty = useAnalysisPersistence(experiment, analysisLoaded);

  const intervalIdRef = useRef<NodeJS.Timeout | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // When set (a key-moment span is playing), the frame loop pauses once the playhead passes this frame.
  // Cleared by any manual play / seek so ordinary playback is never bounded.
  const spanEndRef = useRef<number | null>(null);

  const play = () => {
    setIsPlaying(true);
    intervalIdRef.current = setInterval(() => {
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
    }, delay);
  };

  const stop = () => {
    setIsPlaying(false);
    if (intervalIdRef.current) {
      clearInterval(intervalIdRef.current);
    }
  };

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

  // Switch toolbar pages via the up/down arrows. Entering the clip page (re)inits the selection to
  // the whole timeline (telelab parity); leaving the annotate page also clears the reword toggle.
  const goToPage = (page: ToolPage) => {
    if (page === 'clip' && toolPage !== 'clip') {
      segmentIds.current = [freshSegmentId()];
      setEditedSegments([0, lastFrameIndex]);
    }
    if (page !== 'annotate') setRewording(false);
    setToolPage(page);
  };

  const onAddAnnotation = () => annotationsRef.current?.add();
  const onToggleReword = () => setRewording((v) => !v);

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
        // the selection right after it resolves. Apply the optional measuring area on top.
        await playerOpsRef.current.addThermometerAt(x, y);
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
  // per-frame store churn never triggers these, and so the mount-time subscription always runs the
  // latest handler. The nonce on each request makes a repeat for the same target still fire.
  useEffect(() => {
    let prevSeek = useCommonStore.getState().keyframeSeek;
    let prevSnapshot = useCommonStore.getState().snapshotMomentRequest;
    let prevPlaySpan = useCommonStore.getState().playSpanRequest;
    return useCommonStore.subscribe((state) => {
      if (state.keyframeSeek !== prevSeek) {
        prevSeek = state.keyframeSeek;
        if (prevSeek) seekToPlayerRef.current(prevSeek.playerIndex);
      }
      if (state.playSpanRequest !== prevPlaySpan) {
        prevPlaySpan = state.playSpanRequest;
        if (prevPlaySpan) playSpanRef.current(prevPlaySpan.startPlayerIndex, prevPlaySpan.endPlayerIndex);
      }
      if (state.snapshotMomentRequest !== prevSnapshot) {
        prevSnapshot = state.snapshotMomentRequest;
        if (prevSnapshot) snapshotRef.current(prevSnapshot.purpose);
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
          chartsEnabled={
            !!graphsOptions?.some((o) =>
              [ExperimentGraphOption.time, ExperimentGraphOption.spaceX, ExperimentGraphOption.spaceY].includes(o),
            )
          }
          chart={
            <ChartManager
              thermometersId={thermometersId}
              thermalData={lineplotThermoData}
              currFrameIndex={currFrameIdxRef.current}
              updateFrame={updateFrame}
              graphsOptions={graphsOptions}
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

              {showIsotherms && <Isotherms buffer={cacheThermoArrayBufferRef.current[imgFrameIdxRef.current]} />}

              <Thermometers
                expId={experiment.id}
                thermometersId={thermometersId}
                onUpdate={updateThermoemterByPosition}
                onAdd={addThermometerAt}
              />
              <Annotations
                ref={annotationsRef}
                expId={experiment.id}
                ownerId={experiment.ownerId}
                visibility={experiment.visibility}
                annotating={annotating}
                rewording={rewording}
                currentTime={currFrameIdxRef.current / FPS}
                duration={lastFrameIndex / FPS}
                onCountChange={setAnnotationCount}
                onCloseContextMenu={() => setMenuOpen(false)}
              />
            </div>
          </Dropdown>

          <ControlBar
            isPlaying={isPlaying}
            currFrameIndex={currFrameIdxRef.current}
            lastFrameIndex={lastFrameIndex}
            onClickPlayButton={handleClickPlayButton}
            onSlide={throttle(handleSlide, 100)}
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
            onShow3D={() => setSurface3DOpen(true)}
            onAddSegment={onAddSegment}
            onUndoClip={onUndoLastSegment}
            onResetClip={onResetSegments}
            onSaveClip={openSaveModal}
            savingClip={savingClip}
            onAddAnnotation={onAddAnnotation}
            onToggleReword={onToggleReword}
            rewording={rewording}
          />
        </div>
      </div>

      <ThermalSurface3D
        open={surface3DOpen}
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
        onSwap={() => {
          setSurface3DOpen(false);
          setSurfaceWindowOpen(true);
        }}
      />

      <ThermalSurface3D
        floating
        open={surfaceWindowOpen}
        onClose={() => setSurfaceWindowOpen(false)}
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
        onSwap={() => {
          setSurfaceWindowOpen(false);
          setSurface3DOpen(true);
        }}
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
