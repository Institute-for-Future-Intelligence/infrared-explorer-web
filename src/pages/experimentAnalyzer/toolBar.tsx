import TimeGraphSVG from '../../assets/time_graph.svg?react';
import XGraphSVG from '../../assets/x_graph.svg?react';
import YGraphSVG from '../../assets/y_graph.svg?react';
import { SaveOutlined, ScissorOutlined } from '@ant-design/icons';
import useCommonStore from '../../stores/common';
import { ExperimentGraphOption, ControlBarButtons } from '../../types';

interface Props {
  expId: string;
  graphsOptions?: ExperimentGraphOption[];
  // clip controls (image player only; absent for the video player)
  canTrim?: boolean;
  clipMode?: boolean;
  onToggleClip?: () => void;
  onSaveClip?: () => void;
  savingClip?: boolean;
}

const ToolBar = ({ expId, graphsOptions, canTrim, clipMode, onToggleClip, onSaveClip, savingClip }: Props) => {
  const buttons = [
    {
      Img: TimeGraphSVG,
      title: 'T(t)',
      value: ControlBarButtons.graphT,
      active: !!graphsOptions?.includes(ExperimentGraphOption.time),
      tooltip: 'Show T(t) graph',
    },
    {
      Img: XGraphSVG,
      title: 'T(x)',
      value: ControlBarButtons.graphX,
      active: !!graphsOptions?.includes(ExperimentGraphOption.spaceX),
      tooltip: 'Show T(x) graph',
    },
    {
      Img: YGraphSVG,
      title: 'T(y)',
      value: ControlBarButtons.graphY,
      active: !!graphsOptions?.includes(ExperimentGraphOption.spaceY),
      tooltip: 'Show T(y) graph',
    },
  ];

  const setGraphOption = (expId: string, option: ExperimentGraphOption) => {
    useCommonStore.getState().setStore((state) => {
      const experiment = state.experimentMap.get(expId);
      if (experiment) {
        const options = experiment.graphsOptions;
        if (options) {
          const idx = options.findIndex((v) => v === option);
          if (idx === -1) {
            options.push(option);
          } else {
            options.splice(idx, 1);
          }
          state.experimentMap.set(expId, { ...experiment, graphsOptions: [...options] });
        } else {
          state.experimentMap.set(expId, { ...experiment, graphsOptions: [option] });
        }
      }
    });
  };

  const onClick = (value: ControlBarButtons) => {
    switch (value) {
      case ControlBarButtons.graphT: {
        setGraphOption(expId, ExperimentGraphOption.time);
        break;
      }
      case ControlBarButtons.graphX: {
        setGraphOption(expId, ExperimentGraphOption.spaceX);
        break;
      }
      case ControlBarButtons.graphY: {
        setGraphOption(expId, ExperimentGraphOption.spaceY);
        break;
      }
      case ControlBarButtons.isotherms: {
        setGraphOption(expId, ExperimentGraphOption.isotherm);
        break;
      }
    }
  };

  return (
    <div>
      {buttons.map((button) => {
        return (
          <ToolBarButton
            key={button.value}
            value={button.value}
            Img={button.Img}
            active={button.active}
            onClick={onClick}
          />
        );
      })}

      {canTrim && (
        <>
          <ScissorOutlined
            className="tool-bar-icon"
            title={clipMode ? 'Cancel clip' : 'Clip a segment'}
            style={{ color: clipMode ? 'red' : 'white' }}
            onClick={onToggleClip}
          />
          {clipMode && (
            <SaveOutlined
              className="tool-bar-icon"
              title="Save clip"
              style={{ opacity: savingClip ? 0.5 : 1 }}
              onClick={onSaveClip}
            />
          )}
        </>
      )}
    </div>
  );
};

interface ToolBarButtonProps {
  value: ControlBarButtons;
  active: boolean;
  Img: React.FunctionComponent<
    React.SVGProps<SVGSVGElement> & {
      title?: string;
    }
  >;
  onClick: (value: ControlBarButtons) => void;
}

const ToolBarButton = ({ Img, active, value, onClick }: ToolBarButtonProps) => {
  const color = active ? 'red' : 'white';
  return <Img className="tool-bar-button-SVG" onClick={() => onClick(value)} style={{ stroke: color, fill: color }} />;
};

export default ToolBar;
