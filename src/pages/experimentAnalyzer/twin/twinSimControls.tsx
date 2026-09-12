/**
 * The controls of the scene twin's thermal views (twinBuildingViewer): every number the simulated heat
 * map is computed from — the scenario's conditions, the colour scale, each kind's material — and the
 * colour scale's pair of ends, which the measured view shares.
 *
 * A number is one line: what it is (hover for what it means), its unit, sometimes a word about its
 * state, and the value right-aligned at the column's own edge, with its slider drawn as the line's
 * baseline rather than on a line of its own. The unit sits beside the label rather than inside the box,
 * the way the materials table already hoists its units into its column heads — antd lays a suffix out in
 * flow, so "W/m²K" ate 42px of a 104px box and left 36px to type into. The materials fold away: they are
 * a table of constants to consult, not controls to drag.
 *
 * Values are kept in the model's units (°C, K, W/m², degrees, a fraction); the inputs show temperatures
 * in the viewer's unit. Nothing here persists: the viewer's state is the only state, and a scenario
 * preset refills the conditions and the scale.
 */
import { Fragment, type ReactNode } from 'react';
import { Button, InputNumber, Select, Slider, Tooltip } from 'antd';
import {
  SIM_KIND_HINTS,
  SIM_LIMITS,
  SIM_PRESETS,
  SIM_PRESET_KEYS,
  type SimKind,
  type SimMaterial,
  type SimMaterials,
  type SimPresetKey,
  type SimScenario,
  changedKinds,
  clampTo,
  matchingPreset,
  sunShines,
  sunSide,
} from '../../../utils/twinSimulation';

type Unit = 'C' | 'F';
type Range = [number, number];
type Bounds = readonly [number, number];

/** Model ↔ view for one quantity: as it is, a temperature, a temperature difference, or a fraction as a
 *  percentage. Every one is increasing, so bounds convert end for end. */
interface Conv {
  to: (v: number) => number;
  from: (v: number) => number;
}
const AS_IS: Conv = { to: (v) => v, from: (v) => v };
const PERCENT: Conv = { to: (v) => v * 100, from: (v) => v / 100 };
const tempConv = (unit: Unit): Conv =>
  unit === 'F' ? { to: (c) => c * 1.8 + 32, from: (f) => (f - 32) / 1.8 } : AS_IS;
const deltaConv = (unit: Unit): Conv => (unit === 'F' ? { to: (k) => k * 1.8, from: (f) => f / 1.8 } : AS_IS);
const tempSuffix = (unit: Unit) => (unit === 'F' ? '°F' : '°C');

/** Rounded for display. The inputs take no `precision`: one would re-round the value on blur and report
 *  that as a change, nudging a scale the viewer only clicked into. */
const roundTo = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** An input's handler: a finite number, back in the model's unit, within the bounds; anything else (a
 *  cleared box, a lone minus sign mid-typing) is ignored. */
const fromInput =
  (conv: Conv, bounds: Bounds, apply: (v: number) => void) =>
  (v: number | string | null): void => {
    if (typeof v === 'number' && Number.isFinite(v)) apply(clampTo(conv.from(v), bounds));
  };

interface NumberFieldProps {
  label: string;
  tip: ReactNode;
  value: number; // model unit
  bounds: Bounds; // model unit
  onChange: (v: number) => void;
  unit: string;
  /** The unit spelled out, for the screen reader that would otherwise read "°" as nothing. */
  unitName?: string;
  digits: number; // shown after the point
  step: number; // the input's arrows, view unit
  sliderStep: number; // model unit
  conv?: Conv;
  aside?: ReactNode;
  disabled?: boolean;
}

/** One number: its label (what it means on hover), its unit, its value to type, and the slider that is
 *  the line's own baseline — whose filled length says at a glance where the number stands between its
 *  limits. No spinners: the slider does what they did, and antd paints them over the digits on hover. */
const NumberField = ({
  label,
  tip,
  value,
  bounds,
  onChange,
  unit,
  unitName,
  digits,
  step,
  sliderStep,
  conv = AS_IS,
  aside,
  disabled,
}: NumberFieldProps) => (
  <div className="twin-param">
    <div className="twin-param-line">
      <Tooltip title={tip}>
        <span className="twin-param-label">{label}</span>
      </Tooltip>
      <span className="twin-param-unit">{unit}</span>
      {aside ? <span className="twin-param-aside">{aside}</span> : null}
      <InputNumber
        className="twin-param-input"
        size="small"
        controls={false}
        aria-label={`${label} (${unitName ?? unit})`}
        value={roundTo(conv.to(value), digits)}
        min={roundTo(conv.to(bounds[0]), digits)}
        max={roundTo(conv.to(bounds[1]), digits)}
        step={step}
        disabled={disabled}
        onChange={fromInput(conv, bounds, onChange)}
      />
    </div>
    <Slider
      className="twin-slider"
      min={bounds[0]}
      max={bounds[1]}
      step={sliderStep}
      value={value}
      disabled={disabled}
      tooltip={{ formatter: (v) => `${roundTo(conv.to(v ?? 0), digits)}${unit === '°' ? '' : ' '}${unit}` }}
      onChange={(v) => onChange(v as number)}
    />
  </div>
);

export interface ScaleFieldProps {
  value: Range; // °C
  bounds: Bounds; // °C
  unit: Unit;
  /** The handles never come closer than this, °C: a scale needs some width to mean anything. */
  minWidth: number;
  onChange: (r: Range) => void;
  tip: ReactNode;
}

/** The colour scale's two ends, typed or dragged, on the same line as everything else. An end that would
 *  bring them closer than `minWidth` is not taken (typing 30 over 25 passes through 3 on the way). */
export const ScaleField = ({ value, bounds, unit, minWidth, onChange, tip }: ScaleFieldProps) => {
  const conv = tempConv(unit);
  const suffix = tempSuffix(unit);
  const set = (lo: number, hi: number) => {
    if (hi - lo >= minWidth) onChange([lo, hi]);
  };
  const end = (i: 0 | 1, label: string) => (
    <InputNumber
      className="twin-param-input"
      size="small"
      controls={false}
      aria-label={`${label} (${suffix})`}
      value={roundTo(conv.to(value[i]), 1)}
      min={roundTo(conv.to(bounds[0]), 1)}
      max={roundTo(conv.to(bounds[1]), 1)}
      step={1}
      onChange={fromInput(conv, bounds, (c) => (i === 0 ? set(c, value[1]) : set(value[0], c)))}
    />
  );
  return (
    <div className="twin-param">
      <div className="twin-param-line">
        <Tooltip title={tip}>
          <span className="twin-param-label">Scale</span>
        </Tooltip>
        <span className="twin-param-unit">{suffix}</span>
        <span className="twin-param-pair">
          {end(0, 'Scale from')}
          {/* Decorative: the two boxes carry "Scale from" and "Scale to" themselves. */}
          <span className="twin-param-dash" aria-hidden="true">
            –
          </span>
          {end(1, 'Scale to')}
        </span>
      </div>
      <Slider
        className="twin-slider"
        range
        min={bounds[0]}
        max={bounds[1]}
        value={value}
        tooltip={{ formatter: (v) => `${Math.round(conv.to(v ?? 0))} ${suffix}` }}
        onChange={(v) => {
          const [lo, hi] = v as number[];
          set(lo, hi);
        }}
      />
    </div>
  );
};

interface MaterialsTableProps {
  kinds: SimKind[];
  materials: SimMaterials;
  unit: Unit;
  onChange: (kind: SimKind, patch: Partial<SimMaterial>) => void;
  onReset: () => void;
  /** Held by the viewer: the whole section unmounts on a trip to the Measured view, and a table the
   *  viewer opened should still be open when they come back. */
  open: boolean;
  onOpen: (open: boolean) => void;
}

/** Each kind of surface the model uses, with the four numbers the balance gives it — a table of
 *  constants to consult rather than controls to drag, so it starts folded. The summary says how many
 *  kinds the twin uses and how many the viewer has changed: a fold may put the numbers away, never the
 *  fact that one of them is no longer the twin's own. Reset puts every kind back. */
const MaterialsTable = ({ kinds, materials, unit, onChange, onReset, open, onOpen }: MaterialsTableProps) => {
  // Which kinds the scene uses is the frame's answer, and until it arrives there are none: a summary
  // reading "Materials · 0 kinds" over an empty table would be the only thing the folded section showed.
  if (kinds.length === 0) return null;
  const changed = new Set(changedKinds(materials));
  const delta = deltaConv(unit);
  const cell = (kind: SimKind, field: keyof SimMaterial, conv: Conv, step: number, digits: number, name: string) => (
    <InputNumber
      className="twin-mat-input"
      size="small"
      controls={false}
      aria-label={`${kind} ${name}`}
      value={roundTo(conv.to(materials[kind][field]), digits)}
      min={roundTo(conv.to(SIM_LIMITS[field][0]), digits)}
      max={roundTo(conv.to(SIM_LIMITS[field][1]), digits)}
      step={step}
      onChange={fromInput(conv, SIM_LIMITS[field], (v) => onChange(kind, { [field]: v }))}
    />
  );
  return (
    <details className="twin-mats" open={open} onToggle={(e) => onOpen(e.currentTarget.open)}>
      <summary>
        Materials
        <span className="twin-muted"> · {kinds.length === 1 ? '1 kind' : `${kinds.length} kinds`}</span>
        {changed.size > 0 && <span className="twin-mats-changed"> · {changed.size} changed</span>}
      </summary>
      <div className="twin-mats-body">
        <div className="twin-mat-grid">
          <span className="twin-mat-head">Kind</span>
          <Tooltip title="Heat leaking out from the conditioned interior, W/m²K: 0 for anything with nothing heated behind it, about 0.3 for an insulated roof, 0.6 a wall, 2.8 double glazing, 5.8 single glazing. It is what makes a heated building's glass glow on a winter night.">
            <span className="twin-mat-head twin-param-label">U</span>
          </Tooltip>
          <Tooltip title="How much of the sunlight the surface absorbs, %: about 90 for asphalt or a dark roof, 55 a painted wall, 10–20 for glass (the rest passes through or reflects).">
            <span className="twin-mat-head twin-param-label">Sun %</span>
          </Tooltip>
          <Tooltip title="How much heat soaks into the mass below by day instead of warming the surface, W/m²K: about 5 for a pavement or soil, 0 for a thin roof, a wall panel or a window. It is why a road stays cooler than a black roof.">
            <span className="twin-mat-head twin-param-label">Store</span>
          </Tooltip>
          <Tooltip title="Added to the result for what the balance still leaves out, such as the evaporation that keeps leaves cool.">
            <span className="twin-mat-head twin-param-label">± {tempSuffix(unit)}</span>
          </Tooltip>
          {kinds.map((kind) => (
            <Fragment key={kind}>
              <Tooltip title={SIM_KIND_HINTS[kind]} placement="left">
                <span className={changed.has(kind) ? 'twin-mat-kind twin-mat-changed' : 'twin-mat-kind'}>{kind}</span>
              </Tooltip>
              {cell(kind, 'U', AS_IS, 0.1, 2, 'U')}
              {cell(kind, 'alpha', PERCENT, 5, 0, 'sun absorbed')}
              {cell(kind, 'store', AS_IS, 0.5, 1, 'store')}
              {cell(kind, 'bias', delta, 0.5, 1, 'offset')}
            </Fragment>
          ))}
        </div>
        {/* Under the table, not over it: appearing above would drop all 32 cells a row's height the
            moment the first value differed — while the viewer is still typing in one of them. */}
        {changed.size > 0 && (
          <div className="twin-row">
            <span className="twin-muted">Changed from what the twin starts with</span>
            <Button type="link" size="small" onClick={onReset}>
              Reset materials
            </Button>
          </div>
        )}
      </div>
    </details>
  );
};

export interface SimulationControlsProps {
  scenario: SimScenario;
  onScenario: (patch: Partial<SimScenario>) => void;
  range: Range;
  onRange: (r: Range) => void;
  /** The preset the viewer last chose: what "Reset" goes back to once the values are their own. */
  presetKey: SimPresetKey;
  onPreset: (key: SimPresetKey) => void;
  materials: SimMaterials;
  onMaterial: (kind: SimKind, patch: Partial<SimMaterial>) => void;
  onResetMaterials: () => void;
  materialsOpen: boolean;
  onMaterialsOpen: (open: boolean) => void;
  kinds: SimKind[]; // the kinds the model's surfaces are painted as
  unit: Unit;
  minScaleWidth: number;
}

/** Everything the simulated view is computed from. A preset fills in the conditions and the scale; once
 *  the viewer changes one, the Scenario reads Custom until they pick a preset again. */
const SimulationControls = ({
  scenario,
  onScenario,
  range,
  onRange,
  presetKey,
  onPreset,
  materials,
  onMaterial,
  onResetMaterials,
  materialsOpen,
  onMaterialsOpen,
  kinds,
  unit,
  minScaleWidth,
}: SimulationControlsProps) => {
  const matched = matchingPreset(scenario, range);
  const temp = tempConv(unit);
  const deg = tempSuffix(unit);
  const night = scenario.sunElevationDeg <= 0;
  // Why the sun is warming nothing, said once beside the heading instead of three times down the rows —
  // it is also what explains the greyed-out direction below.
  const sunState = night
    ? 'below the horizon, warming nothing'
    : scenario.irradiance > 0
      ? null
      : scenario.diffuse > 0
        ? 'no direct beam, only the sky light'
        : 'up, but no light at all on the model';
  return (
    <>
      <div className="twin-fields">
        <label className="twin-field">
          <span>Scenario</span>
          <Select
            size="small"
            value={matched ?? 'custom'}
            onChange={(k: string) => onPreset(k as SimPresetKey)}
            options={[
              ...SIM_PRESET_KEYS.map((k) => ({ value: k, label: SIM_PRESETS[k].label })),
              ...(matched ? [] : [{ value: 'custom', label: 'Custom', disabled: true }]),
            ]}
          />
        </label>
      </div>
      <div className="twin-note-muted">
        {matched ? (
          SIM_PRESETS[matched].hint
        ) : (
          <>
            Your own conditions, started from {SIM_PRESETS[presetKey].label}.{' '}
            <Button type="link" size="small" className="twin-inline-link" onClick={() => onPreset(presetKey)}>
              Back to {SIM_PRESETS[presetKey].label}
            </Button>
          </>
        )}
      </div>
      <div className="twin-subhead">Air</div>
      <div className="twin-params">
        <NumberField
          label="Outside"
          tip="The outside air temperature. Every surface starts from it."
          value={scenario.tOut}
          bounds={SIM_LIMITS.tOut}
          onChange={(v) => onScenario({ tOut: v })}
          conv={temp}
          unit={deg}
          digits={1}
          step={1}
          sliderStep={0.5}
        />
        <NumberField
          label="Inside"
          tip="The heated or air-conditioned interior. The further it is from the outside air, the more heat leaks through each surface — most through glass."
          value={scenario.tIn}
          bounds={SIM_LIMITS.tIn}
          onChange={(v) => onScenario({ tIn: v })}
          conv={temp}
          unit={deg}
          digits={1}
          step={1}
          sliderStep={0.5}
        />
        <NumberField
          label="Wind"
          tip="How strongly the outside air carries a surface's surplus heat off, W/m²K: about 4 in still air, 12 in a light breeze, 30 in a gale. It is convection only — the surface's own radiation is worked out separately — so even in still air nothing runs away."
          value={scenario.windH}
          bounds={SIM_LIMITS.windH}
          onChange={(v) => onScenario({ windH: v })}
          unit="W/m²K"
          digits={1}
          step={1}
          sliderStep={0.5}
        />
        <NumberField
          label="Sky cooling"
          tip="How much more heat a clear sky takes from a surface than air at the same temperature would, W/m²: about 60 under a clear dry sky, less in humid air, 0 under thick cloud. A face looking straight up feels all of it, a wall half, a soffit none."
          value={scenario.skyLoss}
          bounds={SIM_LIMITS.skyLoss}
          onChange={(v) => onScenario({ skyLoss: v })}
          unit="W/m²"
          digits={0}
          step={5}
          sliderStep={1}
        />
      </div>
      <div className="twin-subhead">Sun{sunState && <span className="twin-subhead-note"> · {sunState}</span>}</div>
      <div className="twin-params">
        <NumberField
          label="Strength"
          tip="The direct beam, W/m² on a surface squarely facing the sun: about 1000 at noon on a clear summer day, 300–600 in winter, less through haze or cloud."
          value={scenario.irradiance}
          bounds={SIM_LIMITS.irradiance}
          onChange={(v) => onScenario({ irradiance: v })}
          unit="W/m²"
          digits={0}
          step={50}
          sliderStep={10}
        />
        <NumberField
          label="Sky light"
          tip="The light from the rest of the sky, W/m² on a surface looking straight up: about a sixth of the direct beam under a clear sky, more through haze or thin cloud. A wall gets half of it."
          value={scenario.diffuse}
          bounds={SIM_LIMITS.diffuse}
          onChange={(v) => onScenario({ diffuse: v })}
          unit="W/m²"
          digits={0}
          step={10}
          sliderStep={5}
        />
        <NumberField
          label="Height"
          tip="How high the sun stands above the horizon: 0° at sunrise, 90° overhead. At or below 0° it is night and the sun warms nothing. A low sun heats the walls facing it; a high one heats roofs."
          value={scenario.sunElevationDeg}
          bounds={SIM_LIMITS.sunElevationDeg}
          onChange={(v) => onScenario({ sunElevationDeg: v })}
          unit="°"
          unitName="degrees"
          digits={0}
          step={5}
          sliderStep={1}
        />
        <NumberField
          label="From"
          tip="Which side of the subject the sun stands on: 0° in front, 90° to the right, 180° behind, 270° to the left."
          value={scenario.sunAzimuthDeg}
          bounds={SIM_LIMITS.sunAzimuthDeg}
          onChange={(v) => onScenario({ sunAzimuthDeg: v })}
          unit="°"
          unitName="degrees"
          digits={0}
          step={15}
          sliderStep={1}
          aside={sunSide(scenario.sunAzimuthDeg)}
          disabled={!sunShines(scenario)}
        />
      </div>
      <div className="twin-params">
        <ScaleField
          value={range}
          bounds={SIM_LIMITS.scale}
          unit={unit}
          minWidth={minScaleWidth}
          onChange={onRange}
          tip="The colour scale is fixed: temperatures beyond its ends saturate at the palette's ends. Choosing a scenario resets it."
        />
      </div>
      <MaterialsTable
        kinds={kinds}
        materials={materials}
        unit={unit}
        onChange={onMaterial}
        onReset={onResetMaterials}
        open={materialsOpen}
        onOpen={onMaterialsOpen}
      />
    </>
  );
};

export default SimulationControls;
