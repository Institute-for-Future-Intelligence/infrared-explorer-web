import { useEffect, useRef, useState } from 'react';
import { Dropdown, Modal, message } from 'antd';
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
} from '../../../types';
import ChartManager from '../charts/chartManager';
import Thermometers from '../thermometers/thermometers';
import { measuringAreaSubmenuItem } from '../thermometers/measuringAreaMenu';
import Annotations, { AnnotationsHandle } from '../annotations/annotations';
import Isotherms from '../isotherms/isotherms';
import useCommonStore from '../../../stores/common';
import { parseRawThermalData } from '../../../utils/virReader';
import { getThermometerValue } from '../../../utils/temperatureReader';
import { LINTPLOT_DATAPOINT_LIMIT } from '../../../utils/constants';
import { OnProgressProps } from 'react-player/base';

interface Props {
  experiment: Experiment;
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

const VideoPlayer = ({ experiment }: Props) => {
  const { id, name, thermometersId, graphsOptions } = experiment;

  const videoURL = useVideoURL(name);

  const [thermalData, setThermalData] = useState<ArrayBuffer[] | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null); // seconds
  const [lineplotData, setLineplotData] = useState<LineplotData | null>(null);

  const [currFrameIndex, setCurrFrameIndex] = useState(0);

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

  const user = useCommonStore((state) => state.user);
  const selectedThermometerId = useCommonStore((state) => state.selectedThermometerId);
  // Subscribe to the selected thermometer object (not just its id) so the "Measuring Area"
  // submenu reflects its current type reactively.
  const selectedThermometer = useCommonStore((state) =>
    state.selectedThermometerId ? state.thermometerMap.get(state.selectedThermometerId) : undefined,
  );

  // Active toolbar page (telelab ControlBarState parity). Videos have no clip page; the annotate
  // page (owner only) makes notes editable.
  const [toolPage, setToolPage] = useState<ToolPage>('analyze');
  const [rewording, setRewording] = useState(false);
  const annotating = toolPage === 'annotate';
  const annotationsRef = useRef<AnnotationsHandle>(null);
  const canAnnotate = !!user && user.id === experiment.ownerId;
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
    if (!selectedThermometer) return;
    const { id: tId, x, y, measuringAreaWidth, measuringAreaHeight } = selectedThermometer;
    useCommonStore.getState().updateThermometer(tId, {
      measuringAreaType: type,
      measuringAreaWidth: measuringAreaWidth ?? 0.15,
      measuringAreaHeight: measuringAreaHeight ?? 0.15,
    });
    updateThermoemterByPosition(tId, x, y);
  };

  // Right-click menu over the video: add / measuring area / delete selected / delete all (telelab parity).
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

  // init lineplot
  useEffect(() => {
    if (thermalData == null || videoDuration === null) return;
    loadLineplotData(thermalData, videoDuration);
  }, [videoDuration, thermalData]);

  const handlePlayerProgress = (progress: OnProgressProps) => {
    if (thermalData === null) return;
    const totalFrameCount = thermalData.length;
    const index = Math.max(0, Math.floor(progress.played * (totalFrameCount - 1)));
    setCurrFrameIndex(index);
    updateThermometersByFrame(thermalData, index);
  };

  const updateFrameIndexByPlot = (index: number) => {
    if (thermalData === null || videoDuration === null) return;
    if (playerRef.current && thermalData) {
      // work aroung a bug: if seek to the end of the video by this mothod, then we can't not seek for other time anymore.
      playerRef.current.seekTo(Math.min((index / thermalData.length) * videoDuration, Math.floor(videoDuration - 1)));
    }
  };

  const playerRef = useRef<ReactPlayer>(null!);
  const videoContainerRef = useRef<HTMLDivElement>(null);

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

  return (
    <>
      <div className="chart-manager-wrapper">
        {lineplotData ? (
          <ChartManager
            thermometersId={thermometersId}
            thermalData={lineplotData}
            currFrameIndex={currFrameIndex}
            updateFrame={updateFrameIndexByPlot}
            graphsOptions={graphsOptions}
          />
        ) : (
          <>loading plot...</>
        )}
      </div>

      <div className="video-player-wrapper">
        <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
          <div className="video-player" ref={videoContainerRef}>
            {videoURL && (
              <ReactPlayer
                ref={playerRef}
                className={'react-player'}
                width={'100%'}
                height={'100%'}
                url={videoURL}
                controls
                onProgress={handlePlayerProgress}
                onReady={(reactPlayer) => {
                  setVideoDuration(reactPlayer.getDuration());
                }}
              />
            )}
            {thermalData && (
              <div className="video-player-thermometers">
                <Thermometers
                  thermometersId={thermometersId}
                  onUpdate={updateThermoemterByPosition}
                  onAdd={addThermometerAt}
                />
              </div>
            )}
            {thermalData && graphsOptions?.includes(ExperimentGraphOption.isotherm) && (
              <Isotherms buffer={thermalData[currFrameIndex]} />
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
            />
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
            onAddAnnotation={onAddAnnotation}
            onToggleReword={onToggleReword}
            rewording={rewording}
          />
        </div>
      </div>
    </>
  );
};

export default VideoPlayer;
