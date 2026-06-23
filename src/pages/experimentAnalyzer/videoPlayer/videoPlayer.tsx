import { useEffect, useRef, useState } from 'react';
import { firebaseStorage } from '../../../services/firebase';
import { getBytes, getDownloadURL, ref } from 'firebase/storage';
import ReactPlayer from 'react-player';
import ToolBar from '../toolBar';
import { Experiment, LineplotData } from '../../../types';
import ChartManager from '../charts/chartManager';
import Thermometers from '../thermometers/thermometers';
import Annotations from '../annotations/annotations';
import useCommonStore from '../../../stores/common';
import { parseRawThermalData } from '../../../utils/virReader';
import { getTemperatureAtPosition } from '../../../utils/temperatureReader';
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

  /** x,y is [0,1] */
  const updateThermoemterByPosition = (id: string, x: number, y: number) => {
    useCommonStore.getState().setStore((state) => {
      if (!thermalData) return;
      const thermometer = state.thermometerMap.get(id);
      if (thermometer) {
        thermometer.x = x;
        thermometer.y = y;
        const arrayBuffer = thermalData[currFrameIndex];
        thermometer.value = getTemperatureAtPosition(arrayBuffer, x, y);
      }
    });
  };

  const updateThermometersByFrame = (thermalData: ArrayBuffer[], index: number) => {
    useCommonStore.getState().setStore((state) => {
      if (!thermalData) return;
      for (const thermometerId of thermometersId) {
        const thermometer = state.thermometerMap.get(thermometerId);
        if (thermometer) {
          const arrayBuffer = thermalData[index];
          thermometer.value = getTemperatureAtPosition(arrayBuffer, thermometer.x, thermometer.y);
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
        <div className="video-player">
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
              <Thermometers thermometersId={thermometersId} onUpdate={updateThermoemterByPosition} />
            </div>
          )}
          <Annotations expId={experiment.id} ownerId={experiment.ownerId} visibility={experiment.visibility} />
        </div>

        <div className="tool-bar">
          <ToolBar expId={experiment.id} graphsOptions={graphsOptions} />
        </div>
      </div>
    </>
  );
};

export default VideoPlayer;
