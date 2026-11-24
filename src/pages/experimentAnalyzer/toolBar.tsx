import ThermometerSVG from '../../assets/thermometer.svg?react';
import ClipSVG from '../../assets/clip.svg?react';
import UndoSVG from '../../assets/undo.svg?react';
import ResetSVG from '../../assets/reset.svg?react';
import SaveSVG from '../../assets/save.svg?react';
import CelsiusSVG from '../../assets/celsius.svg?react';
import FahrenheitSVG from '../../assets/fahrenheit.svg?react';
import RewordAnnotationSVG from '../../assets/rewordAnnotation.svg?react';
import { Tooltip } from 'antd';
import { DND_ADD_THERMOMETER } from './thermometers/thermometers';
import { useIsMobile } from '../../hooks/useIsMobile';
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

// Inline glyph for a time-lapse's capture-time toggle: a clock face (ring + two hands).
const ClockSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <circle cx="12" cy="12" r="8.5" fill="none" strokeWidth="2" />
    <path d="M12 7.5V12l3.2 2.2" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Inline glyph for the Process key: three sliders, each with its knob somewhere else along it — the
// panel it opens (pictureAdjust/processPanel.tsx, the capture app's Process).
const ProcessedSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17" fill="none" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="9" cy="6.5" r="2.4" stroke="none" />
    <circle cx="15.5" cy="12" r="2.4" stroke="none" />
    <circle cx="7" cy="17.5" r="2.4" stroke="none" />
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

// Inline glyph for the "add line profile" button: the marker it draws — the app's thermoruler (a band with
// inward ticks on both edges and a row of holes down the middle, see profileLine.tsx) laid diagonally.
const AddLineSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <g transform="rotate(-45 12 12)">
      <rect x="2.5" y="8.75" width="19" height="6.5" rx="1" fill="none" strokeWidth="1.5" />
      <path
        d="M6.3 8.75v1.6M10.1 8.75v1.6M13.9 8.75v1.6M17.7 8.75v1.6M6.3 15.25v-1.6M10.1 15.25v-1.6M13.9 15.25v-1.6M17.7 15.25v-1.6"
        fill="none"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="6.3" cy="12" r="0.95" stroke="none" />
      <circle cx="10.1" cy="12" r="0.95" stroke="none" />
      <circle cx="13.9" cy="12" r="0.95" stroke="none" />
      <circle cx="17.7" cy="12" r="0.95" stroke="none" />
    </g>
  </svg>
);

// Inline glyphs for the view-mode cycle button — one per mode, so the button shows
// the CURRENT view (same convention as the °C/°F toggle). ToolBarIcon paints the
// root svg's fill+stroke; each shape opts out of the one it doesn't want.

// Infrared: heat shimmer — three wavy plumes rising off a hot surface (the ♨ sign), i.e. the warmth the
// thermal view shows. The plumes run vertically over a base bar, so it does not read as the isotherm
// button (horizontal contour lines, no bar).
const InfraredViewSVG: IconSVG = (props) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path d="M7 3.5c-2.2 2.4-2.2 4.6 0 7s2.2 4.6 0 7" fill="none" strokeWidth="2" strokeLinecap="round" />
    <path d="M12 3.5c-2.2 2.4-2.2 4.6 0 7s2.2 4.6 0 7" fill="none" strokeWidth="2" strokeLinecap="round" />
    <path d="M17 3.5c-2.2 2.4-2.2 4.6 0 7s2.2 4.6 0 7" fill="none" strokeWidth="2" strokeLinecap="round" />
    <path d="M4.5 21h15" fill="none" strokeWidth="2" strokeLinecap="round" />
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

// Label + hover text for the mode switcher. It replaced the two unlabelled paging arrows: every available
// page is shown as a named segment with the current one highlighted, so switching modes is a single
// deliberate click rather than blind cycling. Annotation lives on the Analyze page now (not its own mode),
// so the only extra page is Clip — the switcher shows only for owners who can trim.
const PAGE_META: Record<ToolPage, { label: string; title: string }> = {
  analyze: { label: 'Analyze', title: 'Analysis tools — thermometers, lines, isotherms, notes' },
  clip: { label: 'Clip', title: 'Trim a shorter clip from this recording' },
};

interface ToolBarIconProps {
  Img: IconSVG;
  // What the button is called: one or two words that never change with its state, so it can be asked for
  // by name ("the Thermoruler", "Isotherms"). Every button has one. On the desktop rail it is printed
  // under the icon (.tool-bar-label), so it has to fit the rail's width on one line (--tool-rail-w in
  // App.css, sized for "Thermometer"); the phone strip has no room for words, so there it heads the
  // tooltip instead. It is the accessible name on both.
  name: string;
  // The tooltip: what a click does now, or why the button is waiting.
  hint?: string;
  active?: boolean;
  // Greyed + inert (e.g. an absolute-image overlay while the Δ view owns the image). Click/drag do nothing.
  disabled?: boolean;
  onClick?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
}

// The size a tool's name is printed at under its icon. The rail is kept narrow, so the long names
// ("Thermometer", "Capture time") only fit at 8px, the label's size in App.css; a shorter name with room
// to spare is printed larger, the more room the larger, so the short ones are not needlessly small. Each
// step up has to leave that much air on each side of the word inside the rail's content box (the rail,
// --tool-rail-w, less the inner div's 2px padding each side). Measured in the page's own font, once per
// name; where it cannot be measured the label keeps its 8px.
const LABEL_STEPS = [
  { px: 10, air: 8 },
  { px: 9, air: 4 },
];
const labelPxCache = new Map<string, number | undefined>();
const labelFontPx = (name: string): number | undefined => {
  if (labelPxCache.has(name)) return labelPxCache.get(name);
  let px: number | undefined;
  try {
    const rail = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tool-rail-w'));
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx && rail > 0) {
      const family = getComputedStyle(document.body).fontFamily;
      px = LABEL_STEPS.find((step) => {
        ctx.font = `400 ${step.px}px ${family}`;
        return ctx.measureText(name).width + 2 * step.air <= rail - 4;
      })?.px;
    }
  } catch {
    px = undefined;
  }
  labelPxCache.set(name, px);
  return px;
};

// A single uniformly-sized toolbar button (telelab parity). The active tint is the brand teal (lifted for
// dark grounds) so it reads as "on" against the dark rail and matches the app's teal theme.
const ToolBarIcon = ({ Img, name, hint, active, disabled, onClick, draggable, onDragStart }: ToolBarIconProps) => {
  const color = disabled ? '#777' : active ? '#1fb6a6' : '#fff';
  // The bar is a vertical LEFT rail on desktop (tooltip opens to the right) and a horizontal strip above
  // the player on mobile (tooltip opens below). The antd tooltip replaces the native `title`: it reads
  // without the ~1s delay, can wrap, and — unlike `title` — is reachable on touch. On desktop the name is
  // already under the icon, so the tooltip is the hint alone; on mobile, where the label is hidden, it
  // reads name first, then the hint. aria-label keeps the accessible name now that `title` is gone.
  const mobile = useIsMobile();
  const tip = mobile ? (
    <>
      <div className="tool-tip-name">{name}</div>
      {hint && <div className="tool-tip-hint">{hint}</div>}
    </>
  ) : (
    hint
  );
  return (
    <Tooltip title={tip} placement={mobile ? 'bottom' : 'right'}>
      <span
        className="tool-bar-icon"
        role="button"
        aria-label={name}
        aria-disabled={disabled || undefined}
        draggable={draggable && !disabled}
        onClick={disabled ? undefined : onClick}
        onDragStart={disabled ? undefined : onDragStart}
        style={disabled ? { color, cursor: 'default', opacity: 0.5 } : { color }}
      >
        <Img style={{ stroke: color, fill: color }} />
        <span className="tool-bar-label" style={mobile ? undefined : { fontSize: labelFontPx(name) }}>
          {name}
        </span>
      </span>
    </Tooltip>
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
  // Process: opens the panel that adjusts the picture and puts effects on it (image player only); a
  // second click ends it and keeps what was done (the panel's Done). Lit while the view on screen is
  // processed ('on') — in the capture app or here — or the panel is open ('open'); 'unavailable' = this
  // browser cannot draw a processed picture (no WebGL), so the pictures are as made and the key says why.
  // While the panel is open the tools that take the frame away from it, or the page from under it, wait:
  // the Δ view, the 3D surface, Reset, and the Clip page (user's call, 2026-11-23). Omit onToggleProcess
  // to hide the key.
  process?: 'on' | 'off' | 'open' | 'unavailable';
  onToggleProcess?: () => void;
  // The scale bar is not drawn over a processed Infrared / Blended picture (its colours are no longer
  // the scale's — the app's rule): the button is greyed and says so.
  scaleBarHidden?: boolean;
  // A time-lapse whose start is known: offer the capture-time overlay toggle — the shown frame's real time
  // of day on the image. Hidden on every other experiment, where the film's clock already IS the real time.
  captureTimeAvailable?: boolean;
  // Toggle the interactive 3D thermal-surface view of the current frame. surface3DOpen covers BOTH
  // presentations (in place over the frame, and the miniplayer): while either is up the button is lit and
  // the click closes it, so it can never stack a second view on top of the one already showing.
  onShow3D?: () => void;
  surface3DOpen?: boolean;
  // The surface is up IN PLACE, covering the frame: the tools that draw on the frame or change the image
  // (probes, lines, notes, view mode, isotherms, scale bar, capture time, Δ) would act on something the
  // user can't see, so they're greyed out — kept as they are, not toggled — until the surface closes.
  // °C/°F stays live (the surface's legend reads in it), as do the 3D button itself and Reset.
  surface3DInPlace?: boolean;
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
  // Add a note (annotation) on the image — lives on the Analyze page.
  onAddAnnotation?: () => void;
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
  process,
  onToggleProcess,
  scaleBarHidden,
  captureTimeAvailable,
  onShow3D,
  surface3DOpen,
  surface3DInPlace,
  onResetView,
  onAddSegment,
  onUndoClip,
  onResetClip,
  onSaveClip,
  savingClip,
  onAddAnnotation,
}: Props) => {
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  const toggleTemperatureUnit = useCommonStore((state) => state.toggleTemperatureUnit);
  const toggleGraphOption = useCommonStore((state) => state.toggleGraphOption);
  const setIsothermSetting = useCommonStore((state) => state.setIsothermSetting);
  const isothermLabelMode = useCommonStore(
    (s) => s.experimentMap.get(expId)?.chartSettings?.isotherm?.labelMode ?? 'legend',
  );
  const profileLineDrawMode = useCommonStore((state) => state.profileLineDrawMode);
  const setProfileLineDrawMode = useCommonStore((state) => state.setProfileLineDrawMode);

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
  const isothermHint = !isothermsOn
    ? 'Show lines of equal temperature, with a legend'
    : isothermLabelMode === 'legend'
      ? 'Isotherms are shown with a legend — click to print the temperatures on the lines instead'
      : 'Isotherms are shown with their temperatures on the lines — click to hide them';
  const IsothermIcon = !isothermsOn
    ? IsothermsOffSVG
    : isothermLabelMode === 'legend'
      ? IsothermsLegendSVG
      : IsothermsLineSVG;

  // The Δ frame-difference view REPLACES the false-colour image with a diff image, so the overlays that
  // describe the ABSOLUTE image — isotherms, the colour scale bar (its palette no longer matches the
  // pixels) — are contradictory while it's on. Grey them out (kept off, not toggled, so they return as
  // they were when Δ is turned off). The Δ button itself stays live to exit.
  const diffOn = !!graphsOptions?.includes(ExperimentGraphOption.diff);
  const diffTip = 'Unavailable while Difference is on';
  // Likewise while the 3D surface covers the frame (see Props.surface3DInPlace).
  const in3D = !!surface3DInPlace;
  const tip3D = 'Unavailable while the 3D surface is shown';
  // And while the Process panel is open (see Props.process).
  const processOpen = process === 'open';
  const tipProcess = 'Unavailable while Process is open';
  const captureTimeOn = !!graphsOptions?.includes(ExperimentGraphOption.captureTime);

  // "Add line" arms a hand-draw gesture: the image shows a crosshair and the user presses-drags-releases to
  // draw the transect (see ProfileLineOverlay), rather than dropping a preset line. Clicking again disarms.
  // The line's overlay lives on the frame, independent of the T(r) chart — so a line can be added even when
  // the Charts grid is already full, and adding one never opens, steals, or reshuffles the chart panel. The
  // T(r) plot is turned on separately from the Charts tab whenever the user wants to see it.
  const onAddLine = () => setProfileLineDrawMode(!profileLineDrawMode);

  // Only owners who can trim get a second page (Clip); everyone else has just "analyze" and sees no
  // switcher. Tooltips open beside the rail on desktop, below the strip on mobile.
  const tooltipPlacement: 'right' | 'bottom' = useIsMobile() ? 'bottom' : 'right';

  return (
    <div>
      {availablePages.length > 1 && (
        <div className="tool-bar-modes" role="tablist" aria-label="Tool mode">
          {availablePages.map((p) => (
            <Tooltip
              key={p}
              title={processOpen && p !== page ? tipProcess : PAGE_META[p].title}
              placement={tooltipPlacement}
            >
              <button
                type="button"
                role="tab"
                aria-selected={p === page}
                className={p === page ? 'tool-bar-mode active' : 'tool-bar-mode'}
                disabled={processOpen && p !== page}
                onClick={() => onChangePage(p)}
              >
                {PAGE_META[p].label}
              </button>
            </Tooltip>
          ))}
        </div>
      )}

      {page === 'analyze' && (
        <>
          {onAddThermometer && (
            <ToolBarIcon
              Img={ThermometerSVG}
              name="Thermometer"
              hint={in3D ? tip3D : 'Click to add a thermometer at the centre, or drag it onto the image'}
              disabled={in3D}
              onClick={onAddThermometer}
              draggable
              onDragStart={(e) => e.dataTransfer.setData(DND_ADD_THERMOMETER, '1')}
            />
          )}

          <ToolBarIcon
            Img={AddLineSVG}
            name="Thermoruler"
            hint={
              in3D
                ? tip3D
                : profileLineDrawMode
                  ? 'Press and drag on the image to draw the thermoruler (Esc to cancel)'
                  : 'Temperature along a line you draw on the image'
            }
            active={profileLineDrawMode}
            disabled={in3D}
            onClick={onAddLine}
          />

          {onAddAnnotation && (
            <ToolBarIcon
              Img={RewordAnnotationSVG}
              name="Note"
              hint={in3D ? tip3D : 'Add a note on the image'}
              disabled={in3D}
              onClick={onAddAnnotation}
            />
          )}

          <ToolBarIcon
            Img={temperatureUnit === TemperatureUnit.fahrenheit ? FahrenheitSVG : CelsiusSVG}
            name="Unit"
            hint={
              temperatureUnit === TemperatureUnit.fahrenheit ? 'Showing °F — click for °C' : 'Showing °C — click for °F'
            }
            onClick={toggleTemperatureUnit}
          />

          {viewMode && onCycleViewMode && (
            <ToolBarIcon
              Img={VIEW_MODE_META[viewMode].Img}
              name="View"
              hint={
                in3D
                  ? tip3D
                  : `Showing ${VIEW_MODE_META[viewMode].label} — click to switch (Infrared / Visible / Blended)`
              }
              disabled={in3D}
              onClick={onCycleViewMode}
            />
          )}

          {process && onToggleProcess && (
            <ToolBarIcon
              Img={ProcessedSVG}
              name="Process"
              hint={
                processOpen
                  ? 'Close Process and keep the changes'
                  : in3D
                    ? tip3D
                    : diffOn
                      ? diffTip
                      : process === 'unavailable'
                        ? 'Not available: this browser cannot draw a processed picture'
                        : process === 'on'
                          ? 'This view is processed — adjust it, or compare it with the picture as made'
                          : 'Adjust the picture and add effects'
              }
              active={process === 'on' || processOpen}
              disabled={!processOpen && (in3D || diffOn || process === 'unavailable')}
              onClick={onToggleProcess}
            />
          )}

          <ToolBarIcon
            Img={IsothermIcon}
            name="Isotherms"
            hint={in3D ? tip3D : diffOn ? diffTip : isothermHint}
            active={isothermsOn}
            disabled={diffOn || in3D}
            onClick={cycleIsotherms}
          />

          <ToolBarIcon
            Img={ScaleBarSVG}
            name="Scale bar"
            hint={
              in3D
                ? tip3D
                : diffOn
                  ? diffTip
                  : scaleBarHidden
                    ? 'The scale bar is not shown over a processed picture: its colours are no longer the scale’s'
                    : 'Show or hide the temperature scale on the image'
            }
            active={!!graphsOptions?.includes(ExperimentGraphOption.scaleBar)}
            disabled={diffOn || in3D || !!scaleBarHidden}
            onClick={() => toggleGraphOption(expId, ExperimentGraphOption.scaleBar)}
          />

          {/* Stays live in the Δ view: when a frame was taken holds whichever image is shown. */}
          {captureTimeAvailable && (
            <ToolBarIcon
              Img={ClockSVG}
              name="Capture time"
              hint={
                in3D ? tip3D : captureTimeOn ? 'Hide the capture time' : 'Show when each frame was taken (time of day)'
              }
              active={captureTimeOn}
              disabled={in3D}
              onClick={() => toggleGraphOption(expId, ExperimentGraphOption.captureTime)}
            />
          )}

          <ToolBarIcon
            Img={DiffSVG}
            name="Difference"
            hint={
              in3D
                ? tip3D
                : processOpen
                  ? tipProcess
                  : 'Δ view: the current frame minus a reference frame. Right-click the image to set the reference'
            }
            active={!!graphsOptions?.includes(ExperimentGraphOption.diff)}
            disabled={in3D || processOpen}
            onClick={() => toggleGraphOption(expId, ExperimentGraphOption.diff)}
          />

          {onShow3D && (
            <ToolBarIcon
              Img={Surface3DSVG}
              name="3D surface"
              hint={
                processOpen
                  ? tipProcess
                  : surface3DOpen
                    ? 'Hide the 3D thermal surface'
                    : 'See this frame as a surface whose height is temperature'
              }
              active={surface3DOpen}
              disabled={processOpen}
              onClick={onShow3D}
            />
          )}

          {onResetView && (
            <ToolBarIcon
              Img={ResetSVG}
              name="Reset"
              hint={
                processOpen
                  ? tipProcess
                  : 'Discard your changes (thermometers, annotations, isotherms & view) and restore the original'
              }
              disabled={processOpen}
              onClick={onResetView}
            />
          )}
        </>
      )}

      {page === 'clip' && (
        <>
          <ToolBarIcon Img={ClipSVG} name="Add segment" hint="Add another stretch to keep" onClick={onAddSegment} />
          <ToolBarIcon Img={UndoSVG} name="Undo" hint="Remove the segment added last" onClick={onUndoClip} />
          <ToolBarIcon
            Img={ResetSVG}
            name="Reset"
            hint="Back to one segment covering the whole recording"
            onClick={onResetClip}
          />
          <ToolBarIcon
            Img={SaveSVG}
            name="Save clip"
            hint="Save the kept segments as a new clip"
            active={savingClip}
            onClick={onSaveClip}
          />
        </>
      )}
    </div>
  );
};

export default ToolBar;
