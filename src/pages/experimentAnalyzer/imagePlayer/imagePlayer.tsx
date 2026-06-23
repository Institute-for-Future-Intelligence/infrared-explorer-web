import { getBlob, getBytes, ref } from 'firebase/storage';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dropdown, Input, Modal, message } from 'antd';
import type { MenuProps } from 'antd';
import { firebaseStorage } from '../../../services/firebase';
import ControlBar from './controlBar';
import { throttle } from 'lodash';
import { Experiment, ExperimentGraphOption, LineplotData, Segment, TemperatureUnit } from '../../../types';
import { useMappingIndex } from '../hooks';
import { getThermometerValue } from '../../../utils/temperatureReader';
import Thermometers from '../thermometers/thermometers';
import Annotations from '../annotations/annotations';
import Isotherms from '../isotherms/isotherms';
import useCommonStore from '../../../stores/common';
import ChartManager from '../charts/chartManager';
import ToolBar from '../toolBar';
import { FPS, LINTPLOT_DATAPOINT_LIMIT } from '../../../utils/constants';
import { useNavigate } from 'react-router-dom';
import { cloneExperiment } from '../../../services/experiments';
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
  const [editMode, setEditMode] = useState(false);
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

  // Right-click menu over the image: add / delete selected / delete all thermometers (telelab parity).
  const contextMenuItems: MenuProps['items'] = [
    { key: 'add', label: 'Add a thermometer', onClick: () => addThermometerAt() },
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

  // Enter/leave clip mode; entering inits the selection to the whole timeline (telelab parity).
  const onToggleEdit = () => {
    setEditMode((v) => {
      if (!v) setEditedSegments([0, lastFrameIndex]);
      return !v;
    });
  };

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
              <Annotations expId={experiment.id} ownerId={experiment.ownerId} visibility={experiment.visibility} />
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
            onAddThermometer={() => addThermometerAt()}
            canTrim={!!user}
            clipMode={editMode}
            onToggleClip={onToggleEdit}
            onAddSegment={onAddSegment}
            onUndoClip={onUndoLastSegment}
            onResetClip={onResetSegments}
            onSaveClip={openSaveModal}
            savingClip={savingClip}
          />
          <button
            className="tool-bar-icon"
            title="Save a screenshot (frame + thermometers, annotations & isotherms) as PNG"
            onClick={saveScreenshot}
            style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: 12 }}
          >
            ⤓ PNG
          </button>
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
