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

  return (
    <>
      {graphsOptions.map((option, idx) => {
        switch (option) {
          case ExperimentGraphOption.time: {
            if (!thermalData) return null;

            return (
              <LinePlot
                thermometersId={thermometersId}
                thermalData={thermalData}
                currFrameIndex={currFrameIndex}
                updateFrame={updateFrame}
                key={idx}
              />
            );
          }
          case ExperimentGraphOption.spaceX: {
            return <ScatterPlot key={idx} thermometersId={thermometersId} type="X" thermalData={thermalData} />;
          }
          case ExperimentGraphOption.spaceY: {
            return <ScatterPlot key={idx} thermometersId={thermometersId} type="Y" thermalData={thermalData} />;
          }
        }
      })}
    </>
  );
};

export default ChartManager;
