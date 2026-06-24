import TimeGraphSVG from '../../assets/time_graph.svg?react';
import XGraphSVG from '../../assets/x_graph.svg?react';
import YGraphSVG from '../../assets/y_graph.svg?react';
import ThermometerSVG from '../../assets/thermometer.svg?react';
import WaveSVG from '../../assets/wave.svg?react';
import ClipSVG from '../../assets/clip.svg?react';
import UndoSVG from '../../assets/undo.svg?react';
import ResetSVG from '../../assets/reset.svg?react';
import SaveSVG from '../../assets/save.svg?react';
import ImageSVG from '../../assets/image.svg?react';
import CelsiusSVG from '../../assets/celsius.svg?react';
import FahrenheitSVG from '../../assets/fahrenheit.svg?react';
import { DND_ADD_THERMOMETER } from './thermometers/thermometers';
import useCommonStore from '../../stores/common';
import { ExperimentGraphOption, ControlBarButtons, TemperatureUnit } from '../../types';

type IconSVG = React.FunctionComponent<React.SVGProps<SVGSVGElement> & { title?: string }>;

interface ToolBarIconProps {
  Img: IconSVG;
  title: string;
  active?: boolean;
  onClick?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
}

// A single uniformly-sized toolbar button (telelab parity).
const ToolBarIcon = ({ Img, title, active, onClick, draggable, onDragStart }: ToolBarIconProps) => {
  const color = active ? '#ca472e' : '#fff';
  return (
    <span className="tool-bar-icon" title={title} draggable={draggable} onClick={onClick} onDragStart={onDragStart}>
      <Img style={{ stroke: color, fill: color }} />
    </span>
  );
};

interface Props {
  expId: string;
  graphsOptions?: ExperimentGraphOption[];
  // Add a thermometer at the image centre (the button is also draggable onto the image).
  onAddThermometer?: () => void;
  // Composite the current frame + overlays into a PNG.
  onScreenshot?: () => void;
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
  onScreenshot,
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

  const graphButtons = [
    {
      Img: TimeGraphSVG,
      value: ControlBarButtons.graphT,
      active: !!graphsOptions?.includes(ExperimentGraphOption.time),
      tooltip: 'Show T(t) graph',
    },
    {
      Img: XGraphSVG,
      value: ControlBarButtons.graphX,
      active: !!graphsOptions?.includes(ExperimentGraphOption.spaceX),
      tooltip: 'Show T(x) graph',
    },
    {
      Img: YGraphSVG,
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
        <ToolBarIcon
          Img={ThermometerSVG}
          title="Add a thermometer (click to add at centre, or drag onto the image)"
          onClick={onAddThermometer}
          draggable
          onDragStart={(e) => e.dataTransfer.setData(DND_ADD_THERMOMETER, '1')}
        />
      )}

      <ToolBarIcon
        Img={temperatureUnit === TemperatureUnit.fahrenheit ? FahrenheitSVG : CelsiusSVG}
        title="Toggle °C / °F"
        onClick={toggleTemperatureUnit}
      />

      {graphButtons.map((button) => (
        <ToolBarIcon
          key={button.value}
          Img={button.Img}
          title={button.tooltip}
          active={button.active}
          onClick={() => onClick(button.value)}
        />
      ))}

      <ToolBarIcon
        Img={WaveSVG}
        title="Toggle isotherms"
        active={!!graphsOptions?.includes(ExperimentGraphOption.isotherm)}
        onClick={() => onClick(ControlBarButtons.isotherms)}
      />

      {canTrim && (
        <>
          <ToolBarIcon
            Img={ClipSVG}
            title={clipMode ? 'Cancel clip' : 'Clip a segment'}
            active={clipMode}
            onClick={onToggleClip}
          />
          {clipMode && (
            <>
              <ToolBarIcon Img={ClipSVG} title="Add a segment" onClick={onAddSegment} />
              <ToolBarIcon Img={UndoSVG} title="Undo last segment" onClick={onUndoClip} />
              <ToolBarIcon Img={ResetSVG} title="Reset" onClick={onResetClip} />
              <ToolBarIcon Img={SaveSVG} title="Save as a new clip" active={savingClip} onClick={onSaveClip} />
            </>
          )}
        </>
      )}

      {onScreenshot && (
        <ToolBarIcon
          Img={ImageSVG}
          title="Save a screenshot (frame + thermometers, annotations & isotherms) as PNG"
          onClick={onScreenshot}
        />
      )}
    </div>
  );
};

export default ToolBar;
