import { getBlob, getBytes, ref } from 'firebase/storage';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dropdown, Input, Modal, message } from 'antd';
import type { MenuProps } from 'antd';
import { firebaseStorage } from '../../../services/firebase';
import ControlBar from './controlBar';
import { debounce, throttle } from 'lodash';
import {
  Experiment,
  ExperimentGraphOption,
  LineplotData,
  MeasuringAreaType,
  Segment,
  TemperatureUnit,
  Thermometer,
  ToolPage,
} from '../../../types';
import { useMappingIndex } from '../hooks';
import { getThermometerValue } from '../../../utils/temperatureReader';
import Thermometers from '../thermometers/thermometers';
import { buildPlayerContextMenu, clickFraction, sameMenuTarget } from '../thermometers/playerContextMenu';
import Annotations, { AnnotationsHandle } from '../annotations/annotations';
import Isotherms from '../isotherms/isotherms';
import useCommonStore from '../../../stores/common';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import ChartManager from '../charts/chartManager';
import ToolBar from '../toolBar';
import { FPS, LINTPLOT_DATAPOINT_LIMIT } from '../../../utils/constants';
import { useNavigate } from 'react-router-dom';
import { cloneExperiment, saveAnalysis } from '../../../services/experiments';
import { exportElementToPNG, timestampedName } from '../../../utils/exporters';

type ImageSrc = string | undefined;

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
  // The player right-click menu is controlled so we can (a) force it shut when the annotation layer
  // takes over an interaction — rc-dropdown only auto-hides a contextMenu menu on a left click, which
  // a right-click on a callout never produces — and (b) freeze its target while it's open.
  const [menuOpen, setMenuOpen] = useState(false);
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

  const cacheImageRef = useRef<ImageSrc[]>([]);
  const cacheThermoArrayBufferRef = useRef<ArrayBuffer[]>([]);
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

  /**
   * This is the only one true state for Player.
   * Only image change would cause rerender, not even frame index.
   * We need index to fetch image first, and render the sence after we got the image. Nothing else can cause rerender.
   * So everything is updated together with image change, no other intermiddle state.
   * Try use ref for other valus if possible
   */
  const [currFrameImg, setCurrFrameImg] = useState<ImageSrc>();

  const [lineplotThermoData, setLineplotThermoData] = useState<LineplotData | null>(null);

  const showLineplotThremoData = graphsOptions?.includes(ExperimentGraphOption.time);
  const showIsotherms = graphsOptions?.includes(ExperimentGraphOption.isotherm);
  const needCurrFrameThermoData = thermometersId.length > 0 || !!showIsotherms;

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

  const loadThermalDataOnFrame = async (index: number) => {
    if (cacheThermoArrayBufferRef.current[index]) return;
    const arrayBuffer = await fetchThermalData(index);
    cacheThermoArrayBufferRef.current[index] = arrayBuffer;
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
  });

  const fetchImage = async (index: number) => {
    const mappedIndex = getRecordingIndex(index);
    const blob = await getBlob(ref(firebaseStorage, `recordings/${recordingId}/data_${mappedIndex}.png`));
    return blob;
  };

  const loadImage = async (index: number, onloadend?: () => void) => {
    const blob = await fetchImage(index);
    const fileReader = new FileReader();
    fileReader.onloadend = () => {
      const res = fileReader.result;
      if (res) {
        cacheImageRef.current[index] = res as string;
        onloadend && onloadend();
      }
    };
    fileReader.readAsDataURL(blob);
  };

  const preloadFrame = async (start: number, length = 5) => {
    for (let i = start; i < start + length && i < lastFrameIndex; i++) {
      if (!cacheImageRef.current[i]) {
        loadImage(i);
      }
      if (needCurrFrameThermoData) {
        loadThermalDataOnFrame(i);
      }
    }
  };

  const updateImage = (index: number) => {
    if (cacheImageRef.current[index]) {
      setCurrFrameImg(cacheImageRef.current[index]);
    }
  };

  const updateFrame = async (index: number) => {
    currFrameIdxRef.current = index;
    if (cacheImageRef.current[index]) {
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

  // Auto-persist analysis edits (thermometer placement / measuring area + graph options) for an
  // experiment the signed-in user owns, debounced so a drag or burst of toggles collapses to one
  // write. We subscribe to the store imperatively (outside React render) so the per-frame `value`
  // updates that drive the readout don't re-render the player; the save signature deliberately
  // excludes `value`. Thermometers removed in-memory are diffed against the previous id set and
  // reconciled away from Firestore (otherwise a deleted thermometer reappears on reload).
  useEffect(() => {
    if (!user || user.id !== experiment.ownerId) return;

    const sigOf = (t: Thermometer) => [
      t.id,
      t.x,
      t.y,
      t.unit,
      t.measuringAreaType ?? null,
      t.measuringAreaWidth ?? null,
      t.measuringAreaHeight ?? null,
    ];
    const snapshot = (state = useCommonStore.getState()) => {
      const exp = state.experimentMap.get(experiment.id);
      const ids = exp?.thermometersId ?? [];
      const thermometers = ids.map((id) => state.thermometerMap.get(id)).filter(Boolean) as Thermometer[];
      return { ids, thermometers, graphsOptions: exp?.graphsOptions ?? [] };
    };
    const sigString = (s: ReturnType<typeof snapshot>) =>
      JSON.stringify({ g: s.graphsOptions, t: s.thermometers.map(sigOf) });

    const initial = snapshot();
    let prevIds = new Set(initial.ids);
    let prevSig = sigString(initial);
    const pendingDeletes = new Set<string>();

    const scheduleSave = debounce(() => {
      const s = snapshot();
      const deleted = [...pendingDeletes];
      pendingDeletes.clear();
      saveAnalysis(experiment.id, user, s.thermometers, s.graphsOptions, experiment.visibility, deleted).catch((e) =>
        console.error('failed to auto-save analysis', e),
      );
    }, 800);

    const unsubscribe = useCommonStore.subscribe((state) => {
      const s = snapshot(state);
      const sig = sigString(s);
      if (sig === prevSig) return; // value-only (per-frame) change — nothing persistable moved
      const nextIds = new Set(s.ids);
      prevIds.forEach((id) => !nextIds.has(id) && pendingDeletes.add(id));
      prevIds = nextIds;
      prevSig = sig;
      scheduleSave();
    });

    return () => {
      unsubscribe();
      scheduleSave.flush(); // persist a just-made edit before leaving (no-op if nothing pending)
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, experiment.id, experiment.ownerId, experiment.visibility]);

  const intervalIdRef = useRef<NodeJS.Timeout | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const play = () => {
    setIsPlaying(true);
    intervalIdRef.current = setInterval(() => {
      if (currFrameIdxRef.current > lastFrameIndex) {
        currFrameIdxRef.current = 0;
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
    isPlaying ? stop() : play();
  };

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

  if (!currFrameImg) return null;
  return (
    <>
      <div className="chart-manager-wrapper">
        <ChartManager
          thermometersId={thermometersId}
          thermalData={lineplotThermoData}
          currFrameIndex={currFrameIdxRef.current}
          updateFrame={updateFrame}
          graphsOptions={graphsOptions}
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

              {showIsotherms && <Isotherms buffer={cacheThermoArrayBufferRef.current[currFrameIdxRef.current]} />}

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
            onScreenshot={saveScreenshot}
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
