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
import { measuringAreaSubmenuItem } from '../thermometers/measuringAreaMenu';
import Annotations, { AnnotationsHandle } from '../annotations/annotations';
import Isotherms from '../isotherms/isotherms';
import useCommonStore from '../../../stores/common';
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
  const { lastFrameIndex, getRecordingIndex } = useMappingIndex(segments, duration);

  const navigate = useNavigate();
  const user = useCommonStore((state) => state.user);
  const selectedThermometerId = useCommonStore((state) => state.selectedThermometerId);
  // Subscribe to the selected thermometer object (not just its id) so the "Measuring Area"
  // submenu reflects its current type reactively.
  const selectedThermometer = useCommonStore((state) =>
    state.selectedThermometerId ? state.thermometerMap.get(state.selectedThermometerId) : undefined,
  );
  // Active toolbar page (telelab ControlBarState parity). The clip page is itself "edit clip" mode;
  // the annotate page makes notes editable. Capability gates which pages the arrows can reach.
  const [toolPage, setToolPage] = useState<ToolPage>('analyze');
  const [rewording, setRewording] = useState(false);
  const editMode = toolPage === 'clip';
  const annotating = toolPage === 'annotate';
  const annotationsRef = useRef<AnnotationsHandle>(null);
  const canTrim = !!user;
  const canAnnotate = !!user && user.id === experiment.ownerId;
  const availablePages: ToolPage[] = ['analyze'];
  if (canTrim) availablePages.push('clip');
  if (canAnnotate) availablePages.push('annotate');
  // Flat array of even length; consecutive pairs [s0,e0, s1,e1, ...] are kept ranges, inclusive,
  // in player-index space (0-based, 0..lastFrameIndex). One full segment = [0, lastFrameIndex].
  const [editedSegments, setEditedSegments] = useState<number[]>([0, 0]);
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

  const currFrameIdxRef = useRef(currentFrameNumber - 1);

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
    if (!selectedThermometer) return;
    const { id: tId, x, y, measuringAreaWidth, measuringAreaHeight } = selectedThermometer;
    useCommonStore.getState().updateThermometer(tId, {
      measuringAreaType: type,
      measuringAreaWidth: measuringAreaWidth ?? 0.15,
      measuringAreaHeight: measuringAreaHeight ?? 0.15,
    });
    updateThermoemterByPosition(tId, x, y);
  };

  // Right-click menu over the image: add / measuring area / delete selected / delete all (telelab parity).
  const contextMenuItems: MenuProps['items'] = [
    { key: 'add', label: 'Add a thermometer', onClick: () => addThermometerAt() },
    ...(selectedThermometer ? [measuringAreaSubmenuItem(selectedThermometer, onPickMeasuringArea)!] : []),
    {
      key: 'delete',
      label: 'Delete selected thermometer',
      disabled: !selectedThermometerId,
      onClick: () =>
        selectedThermometerId && useCommonStore.getState().removeThermometer(experiment.id, selectedThermometerId),
    },
    {
      key: 'deleteAll',
      label: 'Delete all thermometers',
      disabled: thermometersId.length === 0,
      onClick: () =>
        Modal.confirm({
          title: 'Delete all thermometers?',
          okText: 'Delete',
          okButtonProps: { danger: true },
          onOk: () => useCommonStore.getState().removeAllThermometers(experiment.id),
        }),
    },
  ];

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
    // has thermometer
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
    if (page === 'clip' && toolPage !== 'clip') setEditedSegments([0, lastFrameIndex]);
    if (page !== 'annotate') setRewording(false);
    setToolPage(page);
  };

  const onAddAnnotation = () => annotationsRef.current?.add();
  const onToggleReword = () => setRewording((v) => !v);

  // Append a new kept pair [lastEnd+1, end] in the tail (telelab onAddSegment).
  const onAddSegment = () => {
    const lastEnd = editedSegments[editedSegments.length - 1];
    if (lastEnd < lastFrameIndex - 1) {
      setEditedSegments([...editedSegments, lastEnd + 1, lastFrameIndex]);
    }
  };

  // Drop the last pair (telelab onUndoLastSegment); no-op when only one pair remains.
  const onUndoLastSegment = () => {
    if (editedSegments.length > 2) {
      setEditedSegments(editedSegments.slice(0, editedSegments.length - 2));
    }
  };

  // Collapse back to a single full-range pair (telelab onResetSegments).
  const onResetSegments = () => setEditedSegments([0, lastFrameIndex]);

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
          <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
            <div className="image-wrapper" ref={imageWrapperRef}>
              <img className="current-frame-image" src={currFrameImg} />

              {showIsotherms && <Isotherms buffer={cacheThermoArrayBufferRef.current[currFrameIdxRef.current]} />}

              <Thermometers
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
        destroyOnClose
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
