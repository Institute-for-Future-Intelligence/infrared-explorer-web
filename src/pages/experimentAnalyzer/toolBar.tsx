import TimeGraphSVG from '../../assets/time_graph.svg?react';
import XGraphSVG from '../../assets/x_graph.svg?react';
import YGraphSVG from '../../assets/y_graph.svg?react';
import ThermometerSVG from '../../assets/thermometer.svg?react';
import { DND_ADD_THERMOMETER } from './thermometers/thermometers';
import {
  PlusOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  SaveOutlined,
  ScissorOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import useCommonStore from '../../stores/common';
import { ExperimentGraphOption, ControlBarButtons } from '../../types';
import { temperatureSymbol } from '../../utils/helpers';

interface Props {
  expId: string;
  graphsOptions?: ExperimentGraphOption[];
  // Add a thermometer at the image centre (the button is also draggable onto the image).
  onAddThermometer?: () => void;
  // clip controls (image player only; absent for the video player)
  canTrim?: boolean;
  clipMode?: boolean;
  onToggleClip?: () => void;
  onAddSegment?: () => void;
  onUndoClip?: () => void;
  onResetClip?: () => void;
  onSaveClip?: () => void;
  savingClip?: boolean;
}

const ToolBar = ({
  expId,
  graphsOptions,
  onAddThermometer,
  canTrim,
  clipMode,
  onToggleClip,
  onAddSegment,
  onUndoClip,
  onResetClip,
  onSaveClip,
  savingClip,
}: Props) => {
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  const toggleTemperatureUnit = useCommonStore((state) => state.toggleTemperatureUnit);

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
      {onAddThermometer && (
        <span
          className="tool-bar-icon"
          title="Add a thermometer (click to add at centre, or drag onto the image)"
          draggable
          onClick={onAddThermometer}
          onDragStart={(e) => e.dataTransfer.setData(DND_ADD_THERMOMETER, '1')}
          style={{ cursor: 'pointer' }}
        >
          <ThermometerSVG style={{ width: 22, height: 22, fill: 'white' }} />
        </span>
      )}

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

      <span
        className="tool-bar-icon"
        title="Toggle °C / °F"
        style={{ color: 'white', cursor: 'pointer', userSelect: 'none' }}
        onClick={toggleTemperatureUnit}
      >
        {temperatureSymbol(temperatureUnit)}
      </span>

      <RadarChartOutlined
        className="tool-bar-icon"
        title="Toggle isotherms"
        style={{ color: graphsOptions?.includes(ExperimentGraphOption.isotherm) ? 'red' : 'white' }}
        onClick={() => onClick(ControlBarButtons.isotherms)}
      />

      {canTrim && (
        <>
          <ScissorOutlined
            className="tool-bar-icon"
            title={clipMode ? 'Cancel clip' : 'Clip a segment'}
            style={{ color: clipMode ? 'red' : 'white' }}
            onClick={onToggleClip}
          />
          {clipMode && (
            <>
              <PlusOutlined className="tool-bar-icon" title="Add a segment" onClick={onAddSegment} />
              <UndoOutlined className="tool-bar-icon" title="Undo last segment" onClick={onUndoClip} />
              <ReloadOutlined className="tool-bar-icon" title="Reset" onClick={onResetClip} />
              <SaveOutlined
                className="tool-bar-icon"
                title="Save as a new clip"
                style={{ opacity: savingClip ? 0.5 : 1 }}
                onClick={onSaveClip}
              />
            </>
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
