import { ReactNode } from 'react';
import { ExperimentGraphOption, LineplotData } from '../../../types';
import useCommonStore from '../../../stores/common';
import LinePlot from './linePlot';
import ScatterPlot from './scatterPlot';
import ProfilePlot from './profilePlot';
import ChartToggles from './chartToggles';

interface Props {
  expId: string;
  thermometersId: string[];
  thermalData: LineplotData | null;
  updateFrame: (index: number) => void;
  currFrameIndex: number;
  graphsOptions: ExperimentGraphOption[] | undefined;
  // The displayed frame's decoded-thermal buffer, for the live T(l) profile plot (undefined until a
  // recording's frame lands; always present for videos). Re-passed each frame so the curve animates.
  buffer?: ArrayBuffer;
}

// The Charts tab body: a chip row to pick which graphs to plot, then the plots themselves. Always
// rendered (even with nothing enabled) so the toggles are the empty state — the panel no longer points
// users at the far-off toolbar. A maximized chart takes the whole plot area; otherwise T(t) keeps the
// top and the scatters share the bottom, matching the fixed layout the CSS expects.
const ChartManager = ({
  expId,
  thermometersId,
  thermalData,
  currFrameIndex,
  graphsOptions,
  updateFrame,
  buffer,
}: Props) => {
  const maximizedChart = useCommonStore((state) => state.maximizedChart);

  const options = graphsOptions ?? [];
  const wantsTime = options.includes(ExperimentGraphOption.time);
  // The time plot needs thermal data to build its series; the scatters derive from the store and tolerate null.
  const hasTime = wantsTime && !!thermalData;
  const hasX = options.includes(ExperimentGraphOption.spaceX);
  const hasY = options.includes(ExperimentGraphOption.spaceY);
  const wantsProfile = options.includes(ExperimentGraphOption.lineProfile);
  const anyChart = wantsTime || hasX || hasY || wantsProfile;

  const timeChart = hasTime ? (
    <LinePlot
      expId={expId}
      thermometersId={thermometersId}
      thermalData={thermalData}
      currFrameIndex={currFrameIndex}
      updateFrame={updateFrame}
    />
  ) : null;
  const xChart = hasX ? (
    <ScatterPlot expId={expId} thermometersId={thermometersId} type="X" thermalData={thermalData} />
  ) : null;
  const yChart = hasY ? (
    <ScatterPlot expId={expId} thermometersId={thermometersId} type="Y" thermalData={thermalData} />
  ) : null;
  // Mounted whenever T(l) is on; ProfilePlot renders its own empty ("add a line") / loading states so the
  // slot stays put and the manager row above it is reachable even before a line exists or the frame lands.
  const profileChart = wantsProfile ? <ProfilePlot expId={expId} buffer={buffer} thermalData={thermalData} /> : null;

  // Show one chart full-panel while it's maximized — but only while it's actually enabled (toggling it
  // off clears the flag in the store; this guards the render in the gap between those two updates).
  const maximized: ReactNode =
    (maximizedChart === ExperimentGraphOption.time && timeChart) ||
    (maximizedChart === ExperimentGraphOption.spaceX && xChart) ||
    (maximizedChart === ExperimentGraphOption.spaceY && yChart) ||
    (maximizedChart === ExperimentGraphOption.lineProfile && profileChart) ||
    null;

  // Ordered chart slots (time, then the X/Y scatters, then T(l)). A wanted plot that's still loading its
  // data keeps its slot as a placeholder, so the grid's parity doesn't shift while the data loads.
  const loadingPlot = () => <div className="chart-container chart-loading">loading plot…</div>;
  const timeSlot = wantsTime ? (timeChart ?? loadingPlot()) : null;
  const slotCount = [timeSlot, xChart, yChart, profileChart].filter(Boolean).length;

  let body: ReactNode;
  if (maximized) {
    body = maximized;
  } else if (anyChart) {
    // Two-column grid: with an odd count the first plot spans the full width (top) and the rest pair up —
    // so 1 fills the panel, 2 sit side by side, and 3 keep "time on top / scatters split below".
    body = (
      <div className={`chart-grid${slotCount % 2 === 1 ? ' chart-grid-odd' : ''}`}>
        {timeSlot}
        {xChart}
        {yChart}
        {profileChart}
      </div>
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
