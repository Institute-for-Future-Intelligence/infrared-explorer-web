import { useEffect, useRef, useState } from 'react';
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
} from '../../../types';
import ChartManager from '../charts/chartManager';
import Thermometers, { clearSelectionOnBackgroundPointerDown } from '../thermometers/thermometers';
import { buildPlayerContextMenu, clickFraction, sameMenuTarget } from '../thermometers/playerContextMenu';
import Annotations, { AnnotationsHandle } from '../annotations/annotations';
import Isotherms from '../isotherms/isotherms';
import useCommonStore from '../../../stores/common';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { useLongPressContextMenu } from '../../../hooks/useLongPressContextMenu';
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
  // Intrinsic video aspect ratio (w/h), read once metadata loads. On mobile the player box is sized to
  // it so the frame fills the box with no letterboxing — otherwise the native (iOS) video controls,
  // which anchor to the actual frame, sit in the wrong place. These thermal clips are often portrait.
  const isMobile = useIsMobile();
  const [videoAspect, setVideoAspect] = useState<number | null>(null);

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
  // asynchronously and the experiment can be served from the (never-cleared) experimentMap cache
  // before they arrive, so reading-seeding must wait for them. Boolean output keeps per-frame value
  // writes from re-rendering the player.
  const thermometersReady = useCommonStore(
    (state) => thermometersId.length > 0 && thermometersId.every((id) => state.thermometerMap.has(id)),
  );

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
  };

  // Right-click menu: a selected thermometer gets Measuring Area + delete it; the empty video gets
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
  // Mobile: a long press on the player synthesises a contextmenu so the right-click menu opens.
  useLongPressContextMenu(videoContainerRef);

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
            onPointerDown={clearSelectionOnBackgroundPointerDown}
            // Mobile only: a DEFINITE height matching the real frame ratio. iOS Safari treats an
            // aspect-ratio box as indefinite for the percentage-height <video>, so the video balloons
            // and its native play button fills the screen — a vw-derived height avoids that. The
            // player width is (100vw - 16px) from .content's 8px side padding. Desktop keeps flex sizing.
            style={isMobile && videoAspect ? { height: `calc((100vw - 16px) / ${videoAspect})` } : undefined}
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
