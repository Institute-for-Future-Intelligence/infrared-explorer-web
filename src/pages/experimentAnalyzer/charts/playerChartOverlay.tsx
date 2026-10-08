import { ReactNode } from 'react';
import { ExperimentGraphOption } from '../../../types';
import useCommonStore, { chartsOnPlayer } from '../../../stores/common';
import LinePlot from './linePlot';
import ScatterPlot from './scatterPlot';
import ProfilePlot from './profilePlot';
import TempHistogram from './tempHistogram';
import { ChartPlaceholder } from './chartMenu';
import type { ChartManagerProps } from './chartManager';

interface Props extends ChartManagerProps {
  // The scale bar is drawn along the frame's top edge: start the charts under it rather than over it.
  belowScaleBar?: boolean;
}

// For a capture that must show the frame itself (the picture a Q&A moment hands the model): leave the
// charts out of it — see exporters' ignoreSelector.
export const PLAYER_CHART_OVERLAY_SELECTOR = '.player-chart-overlay';

// The charts sent to the player (each chart's "show on the player" button — chartSettings.onPlayer):
// up to MAX_OVERLAY_CHARTS, stacked top to bottom over the frame, each taking half of it — drawn straight
// onto the frame with no panel behind (white chrome, see chartChrome). They are the same live charts as
// in the Charts tab, moved rather than copied (ChartManager leaves them out of its grid), and they stay
// up whatever tab the workspace shows — which is the point: the plot stays beside the frame while the
// panel is on Info / Ask AI, and a screenshot of the player carries it. A chart maximized here
// (maximizedPlayerChart) fills the whole frame, the other one stepping aside until it's restored. Rendered
// inside the frame box by both players, with the props they give ChartManager.
const PlayerChartOverlay = ({
  expId,
  thermometersId,
  thermalData,
  currFrameIndex,
  graphsOptions,
  updateFrame,
  buffer,
  hideTime = false,
  belowScaleBar = false,
}: Props) => {
  // The list is part of the experiment's chart setup (saved with it, so it's back after a reload).
  const savedOnPlayer = useCommonStore((state) => state.experimentMap.get(expId)?.chartSettings?.onPlayer);
  const maximizedChart = useCommonStore((state) => state.maximizedPlayerChart);

  // Only charts that are still enabled — and never T(t) on a photo set, which has no time axis.
  const shown = chartsOnPlayer(graphsOptions, savedOnPlayer).filter(
    (o) => !(hideTime && o === ExperimentGraphOption.time),
  );
  if (shown.length === 0) return null;
  // Honoured only while that chart is actually up here (the store clears it on the way out; this guards the
  // render in between).
  const maximized = maximizedChart !== null && shown.includes(maximizedChart) ? maximizedChart : null;

  const chartFor = (option: ExperimentGraphOption): ReactNode => {
    switch (option) {
      case ExperimentGraphOption.time:
        // The time plot builds its series from the sampled frames; hold its slot while they load.
        return thermalData ? (
          <LinePlot
            expId={expId}
            thermometersId={thermometersId}
            thermalData={thermalData}
            currFrameIndex={currFrameIndex}
            updateFrame={updateFrame}
          />
        ) : (
          <ChartPlaceholder expId={expId} option={ExperimentGraphOption.time} kind="loading">
            loading plot…
          </ChartPlaceholder>
        );
      case ExperimentGraphOption.spaceX:
        return <ScatterPlot expId={expId} thermometersId={thermometersId} type="X" thermalData={thermalData} />;
      case ExperimentGraphOption.spaceY:
        return <ScatterPlot expId={expId} thermometersId={thermometersId} type="Y" thermalData={thermalData} />;
      case ExperimentGraphOption.lineProfile:
        return <ProfilePlot expId={expId} buffer={buffer} thermalData={thermalData} />;
      case ExperimentGraphOption.histogram:
        return <TempHistogram expId={expId} buffer={buffer} thermalData={thermalData} />;
      default:
        return null;
    }
  };

  return (
    <div className={belowScaleBar ? 'player-chart-overlay below-scale-bar' : 'player-chart-overlay'}>
      {/* Keyed per chart, so maximizing one keeps it mounted rather than rebuilding it. */}
      {(maximized === null ? shown : [maximized]).map((option) => (
        <div key={option} className={maximized === null ? 'player-chart-slot' : 'player-chart-slot is-maximized'}>
          {chartFor(option)}
        </div>
      ))}
    </div>
  );
};

export default PlayerChartOverlay;
