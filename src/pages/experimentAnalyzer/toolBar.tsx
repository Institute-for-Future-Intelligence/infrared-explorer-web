import ThermometerSVG from '../../assets/thermometer.svg?react';
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
import { ExperimentGraphOption, TemperatureUnit, ToolPage, ViewMode } from '../../types';

type IconSVG = React.FunctionComponent<React.SVGProps<SVGSVGElement> & { title?: string }>;

// Inline "thermal relief" glyph for the 3D-surface button (no asset file needed).
const Surface3DSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path d="M2 20 L9 8 L13 14 L16 10 L22 20 Z" />
  </svg>
);

// Inline glyph for the temperature scale-bar toggle: a horizontal bar with tick marks.
const ScaleBarSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <rect x="3" y="10" width="18" height="5" rx="1.5" stroke="none" />
    <path d="M6 8.5 V6 M12 8.5 V6 M18 8.5 V6" fill="none" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

// Inline glyph for the hot/cold-spot markers toggle: two target rings (hottest & coldest pixels). Each
// shape opts in/out of fill so ToolBarIcon's fill+stroke paint reads as ring-with-centre.
const HotspotsSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <circle cx="8.5" cy="8.5" r="4" fill="none" strokeWidth="2" />
    <circle cx="8.5" cy="8.5" r="1.3" stroke="none" />
    <circle cx="16" cy="16" r="3.2" fill="none" strokeWidth="2" />
    <circle cx="16" cy="16" r="1.1" stroke="none" />
  </svg>
);

// Isotherm button glyphs — one per cycle state (like the view-mode button shows its current mode), so the
// icon itself distinguishes off / legend / on-line, not just the active tint. All share the wavy contour
// lines; the on-states add a mark for how temperatures are shown.

// Off: plain contour waves.
const IsothermsOffSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path d="M3 7q3-3 6 0t6 0 6 0" fill="none" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M3 12q3-3 6 0t6 0 6 0" fill="none" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M3 17q3-3 6 0t6 0 6 0" fill="none" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

// Legend mode: waves (left) + a small legend list box (right).
const IsothermsLegendSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path d="M2 7q2.2-2.4 4.4 0t4.4 0" fill="none" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M2 12q2.2-2.4 4.4 0t4.4 0" fill="none" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M2 17q2.2-2.4 4.4 0t4.4 0" fill="none" strokeWidth="1.5" strokeLinecap="round" />
    <rect x="14.5" y="6.5" width="7.5" height="11" rx="1.2" fill="none" strokeWidth="1.3" />
    <path d="M16.2 9.5h4.1M16.2 12h4.1M16.2 14.5h3" fill="none" strokeWidth="1" strokeLinecap="round" />
  </svg>
);

// On-line mode: waves with a filled tag riding the middle contour (temperature printed on the line).
const IsothermsLineSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path d="M2 7q3-3 6 0t6 0 6 0" fill="none" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M2 17q3-3 6 0t6 0 6 0" fill="none" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M2 12q3-3 6 0t3 -0.6" fill="none" strokeWidth="1.5" strokeLinecap="round" />
    <rect x="12.5" y="9.3" width="9.5" height="5.4" rx="2.7" stroke="none" />
  </svg>
);

// Inline glyph for the Δ frame-difference overlay toggle: a delta (triangle) outline.
const DiffSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path d="M12 4 L21 20 L3 20 Z" fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
  </svg>
);

// Inline glyph for the "add line profile" button: a diagonal transect with its two endpoints.
const AddLineSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <line x1="5" y1="19" x2="19" y2="5" fill="none" strokeWidth="2" strokeLinecap="round" />
    <circle cx="5" cy="19" r="2.4" stroke="none" />
    <circle cx="19" cy="5" r="2.4" stroke="none" />
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
  // Greyed + inert (e.g. an absolute-image overlay while the Δ view owns the image). Click/drag do nothing.
  disabled?: boolean;
  onClick?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
}

// A single uniformly-sized toolbar button (telelab parity).
const ToolBarIcon = ({ Img, title, active, compact, disabled, onClick, draggable, onDragStart }: ToolBarIconProps) => {
  const color = disabled ? '#777' : active ? '#ca472e' : '#fff';
  return (
    <span
      className={compact ? 'tool-bar-icon tool-bar-arrow' : 'tool-bar-icon'}
      title={title}
      draggable={draggable && !disabled}
      onClick={disabled ? undefined : onClick}
      onDragStart={disabled ? undefined : onDragStart}
      style={disabled ? { cursor: 'default', opacity: 0.5 } : undefined}
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
  // Discard the viewer's local sandbox edits (thermometers, annotations, isotherm/chart toggles, view
  // mode, playhead) and restore the author's published view. Only wired for a non-owner — the owner's
  // edits persist to the source, so there's nothing local to reset. Omit it to hide the button.
  onResetView?: () => void;
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
  onResetView,
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
  const toggleGraphOption = useCommonStore((state) => state.toggleGraphOption);
  const setIsothermSetting = useCommonStore((state) => state.setIsothermSetting);
  const isothermLabelMode = useCommonStore(
    (s) => s.experimentMap.get(expId)?.chartSettings?.isotherm?.labelMode ?? 'legend',
  );
  const addProfileLine = useCommonStore((state) => state.addProfileLine);

  // The isotherm button is a 3-state cycle: off → on with the corner legend → on with the temperatures
  // printed on the contour lines (no legend) → off. On/off lives in graphsOptions; the legend-vs-line
  // sub-mode lives in chartSettings.isotherm.labelMode (persisted like the other display prefs).
  const isothermsOn = !!graphsOptions?.includes(ExperimentGraphOption.isotherm);
  const cycleIsotherms = () => {
    if (!isothermsOn) {
      setIsothermSetting(expId, { labelMode: 'legend' });
      toggleGraphOption(expId, ExperimentGraphOption.isotherm);
    } else if (isothermLabelMode === 'legend') {
      setIsothermSetting(expId, { labelMode: 'line' });
    } else {
      toggleGraphOption(expId, ExperimentGraphOption.isotherm);
    }
  };
  const isothermTitle = !isothermsOn
    ? 'Show isotherms (with legend)'
    : isothermLabelMode === 'legend'
      ? 'Isotherms: label temperatures on the lines'
      : 'Hide isotherms';
  const IsothermIcon = !isothermsOn
    ? IsothermsOffSVG
    : isothermLabelMode === 'legend'
      ? IsothermsLegendSVG
      : IsothermsLineSVG;

  // The Δ frame-difference view REPLACES the false-colour image with a diff image, so the overlays that
  // describe the ABSOLUTE image — isotherms, the colour scale bar (its palette no longer matches the
  // pixels), the hot/cold-spot markers — are contradictory while it's on. Grey them out (kept off, not
  // toggled, so they return as they were when Δ is turned off). The Δ button itself stays live to exit.
  const diffOn = !!graphsOptions?.includes(ExperimentGraphOption.diff);
  const diffTip = 'Unavailable while the Δ view is on';

  // "Add line" mirrors "add thermometer": it drops an on-image analysis object (a transect) and nothing
  // more. The line's overlay lives on the frame, independent of the T(l) chart — so a line can be added
  // even when the Charts grid is already full, and adding one never opens, steals, or reshuffles the chart
  // panel. The T(l) plot is turned on separately from the Charts tab whenever the user wants to see it.
  const onAddLine = () => addProfileLine(expId);

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
            Img={AddLineSVG}
            title="Add a line profile — temperature along a line you draw on the image"
            onClick={onAddLine}
          />

          <ToolBarIcon
            Img={temperatureUnit === TemperatureUnit.fahrenheit ? FahrenheitSVG : CelsiusSVG}
            title="Toggle °C / °F"
            onClick={toggleTemperatureUnit}
          />

          {viewMode && onCycleViewMode && (
            <ToolBarIcon
              Img={VIEW_MODE_META[viewMode].Img}
              title={`Switch view: Infrared / Visible / Blended (now ${VIEW_MODE_META[viewMode].label})`}
              onClick={onCycleViewMode}
            />
          )}

          <ToolBarIcon
            Img={IsothermIcon}
            title={diffOn ? diffTip : isothermTitle}
            active={isothermsOn}
            disabled={diffOn}
            onClick={cycleIsotherms}
          />

          <ToolBarIcon
            Img={ScaleBarSVG}
            title={diffOn ? diffTip : 'Toggle temperature scale bar'}
            active={!!graphsOptions?.includes(ExperimentGraphOption.scaleBar)}
            disabled={diffOn}
            onClick={() => toggleGraphOption(expId, ExperimentGraphOption.scaleBar)}
          />

          <ToolBarIcon
            Img={HotspotsSVG}
            title={diffOn ? diffTip : 'Toggle hot/cold-spot markers'}
            active={!!graphsOptions?.includes(ExperimentGraphOption.hotspots)}
            disabled={diffOn}
            onClick={() => toggleGraphOption(expId, ExperimentGraphOption.hotspots)}
          />

          <ToolBarIcon
            Img={DiffSVG}
            title="Toggle Δ frame-difference view (current − reference; right-click to set the reference)"
            active={!!graphsOptions?.includes(ExperimentGraphOption.diff)}
            onClick={() => toggleGraphOption(expId, ExperimentGraphOption.diff)}
          />

          {onShow3D && <ToolBarIcon Img={Surface3DSVG} title="View 3D thermal surface" onClick={onShow3D} />}

          {onScreenshot && (
            <ToolBarIcon
              Img={ImageSVG}
              title="Save a screenshot (frame + thermometers, annotations & isotherms) as PNG"
              onClick={onScreenshot}
            />
          )}

          {onResetView && (
            <ToolBarIcon
              Img={ResetSVG}
              title="Reset — discard your changes (thermometers, annotations, isotherms & view) and restore the original"
              onClick={onResetView}
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
