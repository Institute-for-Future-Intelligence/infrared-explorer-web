import { ReactNode } from 'react';
import { ExperimentGraphOption, LineplotData } from '../../../types';
import useCommonStore from '../../../stores/common';
import LinePlot from './linePlot';
import ScatterPlot from './scatterPlot';
import ProfilePlot from './profilePlot';
import TempHistogram from './tempHistogram';
import ChartToggles from './chartToggles';
import ChartColorKey from './chartColorKey';

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
  // Leave the T(t) chart (and its chip) out: a photo set has no time axis — its frames are separate
  // shots — so "temperature over time" would plot unrelated instants 0.2 s apart. The per-frame
  // charts (T(x) / T(y) / T(l) / N(T)) stay. A saved `time` option is ignored, not cleared.
  hideTime?: boolean;
}

// The Charts tab body: a chip row to pick which graphs to plot, then the plots themselves. Always
// rendered (even with nothing enabled) so the toggles are the empty state — the panel no longer points
// users at the far-off toolbar. A maximized chart takes the whole plot area; otherwise the plots tile a
// 2-column grid — and whenever both spatial scatters are on, T(x)/T(y) are kept together in one row.
const ChartManager = ({
  expId,
  thermometersId,
  thermalData,
  currFrameIndex,
  graphsOptions,
  updateFrame,
  buffer,
  hideTime = false,
}: Props) => {
  const maximizedChart = useCommonStore((state) => state.maximizedChart);

  const options = graphsOptions ?? [];
  const wantsTime = !hideTime && options.includes(ExperimentGraphOption.time);
  // The time plot needs thermal data to build its series; the scatters derive from the store and tolerate null.
  const hasTime = wantsTime && !!thermalData;
  const hasX = options.includes(ExperimentGraphOption.spaceX);
  const hasY = options.includes(ExperimentGraphOption.spaceY);
  const wantsProfile = options.includes(ExperimentGraphOption.lineProfile);
  const wantsHistogram = options.includes(ExperimentGraphOption.histogram);
  const anyChart = wantsTime || hasX || hasY || wantsProfile || wantsHistogram;

  // Keys are stable per graph type (not positional) so that reordering the slots — e.g. when both scatters
  // turn on and T(x)/T(y) move to the trailing pair — moves the mounted charts instead of remounting them.
  const timeChart = hasTime ? (
    <LinePlot
      key="time"
      expId={expId}
      thermometersId={thermometersId}
      thermalData={thermalData}
      currFrameIndex={currFrameIndex}
      updateFrame={updateFrame}
    />
  ) : null;
  const xChart = hasX ? (
    <ScatterPlot key="x" expId={expId} thermometersId={thermometersId} type="X" thermalData={thermalData} />
  ) : null;
  const yChart = hasY ? (
    <ScatterPlot key="y" expId={expId} thermometersId={thermometersId} type="Y" thermalData={thermalData} />
  ) : null;
  // Mounted whenever T(l) is on; ProfilePlot renders its own empty ("add a line") / loading states so the
  // slot stays put and the manager row above it is reachable even before a line exists or the frame lands.
  const profileChart = wantsProfile ? (
    <ProfilePlot key="line" expId={expId} buffer={buffer} thermalData={thermalData} />
  ) : null;
  // Mounted whenever N(T) is on; TempHistogram renders its own loading state (undefined buffer) so the slot
  // stays put and the manager row above it is reachable even before the frame's thermal data lands.
  const histogramChart = wantsHistogram ? (
    <TempHistogram key="hist" expId={expId} buffer={buffer} thermalData={thermalData} />
  ) : null;

  // Show one chart full-panel while it's maximized — but only while it's actually enabled (toggling it
  // off clears the flag in the store; this guards the render in the gap between those two updates).
  const maximized: ReactNode =
    (maximizedChart === ExperimentGraphOption.time && timeChart) ||
    (maximizedChart === ExperimentGraphOption.spaceX && xChart) ||
    (maximizedChart === ExperimentGraphOption.spaceY && yChart) ||
    (maximizedChart === ExperimentGraphOption.lineProfile && profileChart) ||
    (maximizedChart === ExperimentGraphOption.histogram && histogramChart) ||
    null;

  // Ordered chart slots. Product rule: when both spatial scatters are on, T(x) and T(y) must share a row —
  // so render them as the trailing pair after the other plots and let the 2-column grid land them side by
  // side. With 1 or 3 other plots present the odd-count rule floats a single plot full-width on top while
  // X/Y still pair below; with 0 or 2 others they fill their own row. Otherwise keep the natural
  // T(t),T(x),T(y),T(l),N(T) order (time on top). A wanted plot still loading its data keeps its slot as a
  // placeholder, so the grid's parity doesn't shift while it loads.
  const loadingPlot = () => (
    <div key="time" className="chart-container chart-loading">
      loading plot…
    </div>
  );
  const timeSlot = wantsTime ? (timeChart ?? loadingPlot()) : null;
  const orderedSlots = (
    hasX && hasY
      ? [timeSlot, profileChart, histogramChart, xChart, yChart]
      : [timeSlot, xChart, yChart, profileChart, histogramChart]
  ).filter(Boolean);
  const slotCount = orderedSlots.length;

  let body: ReactNode;
  if (maximized) {
    body = maximized;
  } else if (anyChart) {
    // Two-column grid: with an odd count the first plot spans the full width (top) and the rest pair up —
    // so 1 fills the panel, 2 sit side by side, and 3 float one plot on top with two below. orderedSlots
    // above guarantees T(x)/T(y) land as a same-row pair whenever both are shown.
    body = <div className={`chart-grid${slotCount % 2 === 1 ? ' chart-grid-odd' : ''}`}>{orderedSlots}</div>;
  } else {
    body = (
      <div className="chart-hint">
        {thermometersId.length === 0
          ? 'Add a thermometer to the image, then pick a graph above to plot it.'
          : 'Pick a graph above to plot your thermometers.'}
      </div>
    );
  }

  // The colour key maps T1…T7 → thermometer for the colour-coded plots (T(t)/T(x)/T(y)); show it once
  // above the grid whenever one of those is visible (in the grid, or as the maximized chart) and there's
  // at least one thermometer to key. T(l)/N(T) aren't thermometer-coloured, so it's hidden for those.
  const colorKeyRelevant = maximized
    ? maximizedChart === ExperimentGraphOption.time ||
      maximizedChart === ExperimentGraphOption.spaceX ||
      maximizedChart === ExperimentGraphOption.spaceY
    : wantsTime || hasX || hasY;
  const showColorKey = thermometersId.length > 0 && colorKeyRelevant;

  return (
    <>
      <ChartToggles expId={expId} graphsOptions={graphsOptions} hideTime={hideTime} />
      {showColorKey && <ChartColorKey thermometersId={thermometersId} />}
      {body}
    </>
  );
};

export default ChartManager;
