import { ReactNode } from 'react';
import { ExperimentGraphOption, LineplotData } from '../../../types';
import useCommonStore from '../../../stores/common';
import LinePlot from './linePlot';
import ScatterPlot from './scatterPlot';
import ChartToggles from './chartToggles';

interface Props {
  expId: string;
  thermometersId: string[];
  thermalData: LineplotData | null;
  updateFrame: (index: number) => void;
  currFrameIndex: number;
  graphsOptions: ExperimentGraphOption[] | undefined;
}

// The Charts tab body: a chip row to pick which graphs to plot, then the plots themselves. Always
// rendered (even with nothing enabled) so the toggles are the empty state — the panel no longer points
// users at the far-off toolbar. A maximized chart takes the whole plot area; otherwise T(t) keeps the
// top and the scatters share the bottom, matching the fixed layout the CSS expects.
const ChartManager = ({ expId, thermometersId, thermalData, currFrameIndex, graphsOptions, updateFrame }: Props) => {
  const maximizedChart = useCommonStore((state) => state.maximizedChart);

  const options = graphsOptions ?? [];
  const wantsTime = options.includes(ExperimentGraphOption.time);
  // The time plot needs thermal data to build its series; the scatters derive from the store and tolerate null.
  const hasTime = wantsTime && !!thermalData;
  const hasX = options.includes(ExperimentGraphOption.spaceX);
  const hasY = options.includes(ExperimentGraphOption.spaceY);
  const anyChart = wantsTime || hasX || hasY;

  const timeChart = hasTime ? (
    <LinePlot
      thermometersId={thermometersId}
      thermalData={thermalData}
      currFrameIndex={currFrameIndex}
      updateFrame={updateFrame}
    />
  ) : null;
  const xChart = hasX ? <ScatterPlot thermometersId={thermometersId} type="X" thermalData={thermalData} /> : null;
  const yChart = hasY ? <ScatterPlot thermometersId={thermometersId} type="Y" thermalData={thermalData} /> : null;

  // Show one chart full-panel while it's maximized — but only while it's actually enabled (toggling it
  // off clears the flag in the store; this guards the render in the gap between those two updates).
  const maximized: ReactNode =
    (maximizedChart === ExperimentGraphOption.time && timeChart) ||
    (maximizedChart === ExperimentGraphOption.spaceX && xChart) ||
    (maximizedChart === ExperimentGraphOption.spaceY && yChart) ||
    null;

  // When both spatial scatters (T(x) + T(y)) are on, pair them side by side in one row: the time plot
  // keeps the top half and X/Y split the bottom half (see .chart-scatter-row). With only one scatter
  // on, or on mobile (where the row collapses to a stack), everything stacks vertically.
  const scatters =
    hasX && hasY ? (
      <div className="chart-scatter-row">
        {xChart}
        {yChart}
      </div>
    ) : (
      <>
        {xChart}
        {yChart}
      </>
    );

  let body: ReactNode;
  if (maximized) {
    body = maximized;
  } else if (anyChart) {
    body = (
      <>
        {timeChart}
        {/* T(t) is on but its thermal data is still loading (video source) — hold the spot. */}
        {wantsTime && !thermalData && <div className="workspace-loading">loading plot…</div>}
        {scatters}
      </>
    );
  } else {
    body = (
      <div className="chart-hint">
        {thermometersId.length === 0
          ? 'Add a thermometer to the image, then pick a graph above to plot it.'
          : 'Pick a graph above to plot your thermometers.'}
      </div>
    );
  }

  return (
    <>
      <ChartToggles expId={expId} graphsOptions={graphsOptions} />
      {body}
    </>
  );
};

export default ChartManager;
