import { ExperimentGraphOption, LineplotData } from '../../../types';
import LinePlot from './linePlot';
import ScatterPlot from './scatterPlot';

interface Props {
  thermometersId: string[];
  thermalData: LineplotData | null;
  updateFrame: (index: number) => void;
  currFrameIndex: number;
  graphsOptions: ExperimentGraphOption[] | undefined;
}

const ChartManager = ({ thermometersId, thermalData, currFrameIndex, graphsOptions, updateFrame }: Props) => {
  if (!graphsOptions || graphsOptions.length === 0) return null;

  // The time plot needs thermal data to build its series; the scatters derive from the store and tolerate null.
  const hasTime = graphsOptions.includes(ExperimentGraphOption.time) && !!thermalData;
  const hasX = graphsOptions.includes(ExperimentGraphOption.spaceX);
  const hasY = graphsOptions.includes(ExperimentGraphOption.spaceY);

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

  // When both spatial scatters (T(x) + T(y)) are on, pair them side by side in one row: the time plot keeps
  // the top half and X/Y split the bottom half (see .chart-scatter-row). With only one scatter on, or on
  // mobile (where the row collapses to a stack), everything stacks vertically as before.
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

  return (
    <>
      {timeChart}
      {scatters}
    </>
  );
};

export default ChartManager;
