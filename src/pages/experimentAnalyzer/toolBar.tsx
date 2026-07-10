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
import UpArrowSVG from '../../assets/up_arrow.svg?react';
import DownArrowSVG from '../../assets/down_arrow.svg?react';
import AddAnnotationSVG from '../../assets/addAnnotation.svg?react';
import RewordAnnotationSVG from '../../assets/rewordAnnotation.svg?react';
import { DND_ADD_THERMOMETER } from './thermometers/thermometers';
import useCommonStore from '../../stores/common';
import { ExperimentGraphOption, ControlBarButtons, TemperatureUnit, ToolPage, ViewMode } from '../../types';

type IconSVG = React.FunctionComponent<React.SVGProps<SVGSVGElement> & { title?: string }>;

// Inline "thermal relief" glyph for the 3D-surface button (no asset file needed).
const Surface3DSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path d="M2 20 L9 8 L13 14 L16 10 L22 20 Z" />
  </svg>
);

// Inline glyphs for the view-mode cycle button — one per mode, so the button shows
// the CURRENT view (same convention as the °C/°F toggle). ToolBarIcon paints the
// root svg's fill+stroke; each shape opts out of the one it doesn't want.

// Infrared: hot spot radiating heat.
const InfraredViewSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <circle cx="12" cy="12" r="3.2" stroke="none" />
    <path d="M7 7.8a6 6 0 0 0 0 8.4" fill="none" strokeWidth="2" strokeLinecap="round" />
    <path d="M17 7.8a6 6 0 0 1 0 8.4" fill="none" strokeWidth="2" strokeLinecap="round" />
    <path d="M4.2 5a10 10 0 0 0 0 14" fill="none" strokeWidth="2" strokeLinecap="round" />
    <path d="M19.8 5a10 10 0 0 1 0 14" fill="none" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

// Visible light: an eye.
const VisibleViewSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path
      stroke="none"
      fillRule="evenodd"
      d="M12 5.5C7.3 5.5 3.4 8.4 1.5 12c1.9 3.6 5.8 6.5 10.5 6.5s8.6-2.9 10.5-6.5C20.6 8.4 16.7 5.5 12 5.5zm0 10.7a4.2 4.2 0 1 1 0-8.4 4.2 4.2 0 0 1 0 8.4z"
    />
    <circle cx="12" cy="12" r="2.1" stroke="none" />
  </svg>
);

// Blended (MSX): two overlapping circles with the shared lens filled.
const BlendedViewSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <circle cx="9" cy="12" r="6" fill="none" strokeWidth="2" />
    <circle cx="15" cy="12" r="6" fill="none" strokeWidth="2" />
    <path stroke="none" d="M12 6.8a6 6 0 0 1 0 10.4 6 6 0 0 1 0-10.4z" />
  </svg>
);

const VIEW_MODE_META: Record<ViewMode, { Img: IconSVG; label: string }> = {
  ir: { Img: InfraredViewSVG, label: 'Infrared' },
  visible: { Img: VisibleViewSVG, label: 'Visible' },
  blended: { Img: BlendedViewSVG, label: 'Blended' },
};

interface ToolBarIconProps {
  Img: IconSVG;
  title: string;
  active?: boolean;
  // Arrow buttons are half-height (telelab parity).
  compact?: boolean;
  onClick?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
}

// A single uniformly-sized toolbar button (telelab parity).
const ToolBarIcon = ({ Img, title, active, compact, onClick, draggable, onDragStart }: ToolBarIconProps) => {
  const color = active ? '#ca472e' : '#fff';
  return (
    <span
      className={compact ? 'tool-bar-icon tool-bar-arrow' : 'tool-bar-icon'}
      title={title}
      draggable={draggable}
      onClick={onClick}
      onDragStart={onDragStart}
    >
      <Img style={{ stroke: color, fill: color }} />
    </span>
  );
};

interface Props {
  expId: string;
  graphsOptions?: ExperimentGraphOption[];
  // Paging (telelab up/down arrows). The active page decides which tools are shown; the arrows
  // cycle through availablePages. Arrows are hidden when only one page is available.
  page: ToolPage;
  availablePages: ToolPage[];
  onChangePage: (page: ToolPage) => void;
  // Add a thermometer at the image centre (the button is also draggable onto the image).
  onAddThermometer?: () => void;
  // View-mode cycle button (app-captured recordings only): shows the current mode's
  // glyph; each click advances ir → visible → blended. Omit viewMode to hide it.
  viewMode?: ViewMode;
  onCycleViewMode?: () => void;
  // Composite the current frame + overlays into a PNG.
  onScreenshot?: () => void;
  // Open the interactive 3D thermal-surface view of the current frame.
  onShow3D?: () => void;
  // Clip page actions (image player only). Entering the clip page is itself edit mode.
  onAddSegment?: () => void;
  onUndoClip?: () => void;
  onResetClip?: () => void;
  onSaveClip?: () => void;
  savingClip?: boolean;
  // Annotate page actions (owner only).
  onAddAnnotation?: () => void;
  onToggleReword?: () => void;
  rewording?: boolean;
}

const ToolBar = ({
  expId,
  graphsOptions,
  page,
  availablePages,
  onChangePage,
  onAddThermometer,
  viewMode,
  onCycleViewMode,
  onScreenshot,
  onShow3D,
  onAddSegment,
  onUndoClip,
  onResetClip,
  onSaveClip,
  savingClip,
  onAddAnnotation,
  onToggleReword,
  rewording,
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

  // Cycle order follows availablePages; down arrow advances, up arrow goes back (telelab parity).
  const showArrows = availablePages.length > 1;
  const idx = availablePages.indexOf(page);
  const goPrev = () => onChangePage(availablePages[(idx - 1 + availablePages.length) % availablePages.length]);
  const goNext = () => onChangePage(availablePages[(idx + 1) % availablePages.length]);

  return (
    <div>
      {showArrows && <ToolBarIcon compact Img={UpArrowSVG} title="More tools" onClick={goPrev} />}

      {page === 'analyze' && (
        <>
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

          {viewMode && onCycleViewMode && (
            <ToolBarIcon
              Img={VIEW_MODE_META[viewMode].Img}
              title={`Switch view: Infrared / Visible / Blended (now ${VIEW_MODE_META[viewMode].label})`}
              onClick={onCycleViewMode}
            />
          )}

          <ToolBarIcon
            Img={WaveSVG}
            title="Toggle isotherms"
            active={!!graphsOptions?.includes(ExperimentGraphOption.isotherm)}
            onClick={() => onClick(ControlBarButtons.isotherms)}
          />

          {onShow3D && <ToolBarIcon Img={Surface3DSVG} title="View 3D thermal surface" onClick={onShow3D} />}

          {onScreenshot && (
            <ToolBarIcon
              Img={ImageSVG}
              title="Save a screenshot (frame + thermometers, annotations & isotherms) as PNG"
              onClick={onScreenshot}
            />
          )}
        </>
      )}

      {page === 'clip' && (
        <>
          <ToolBarIcon Img={ClipSVG} title="Add a segment" onClick={onAddSegment} />
          <ToolBarIcon Img={UndoSVG} title="Undo last segment" onClick={onUndoClip} />
          <ToolBarIcon Img={ResetSVG} title="Reset" onClick={onResetClip} />
          <ToolBarIcon Img={SaveSVG} title="Save as a new clip" active={savingClip} onClick={onSaveClip} />
        </>
      )}

      {page === 'annotate' && (
        <>
          <ToolBarIcon Img={AddAnnotationSVG} title="Add an annotation" onClick={onAddAnnotation} />
          <ToolBarIcon
            Img={RewordAnnotationSVG}
            title="Revise annotation"
            active={rewording}
            onClick={onToggleReword}
          />
        </>
      )}

      {showArrows && <ToolBarIcon compact Img={DownArrowSVG} title="More tools" onClick={goNext} />}
    </div>
  );
};

export default ToolBar;
