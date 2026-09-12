/**
 * The simulated heat map's parameters and its balance (docs/digital-twin-plan.md §17.5, §18.7): the
 * conditions a scenario sets — the outside and inside air, the sun, the sky, the wind — and each
 * building kind's material, every one of which the viewer may change.
 *
 * The balance is a steady-state surface energy balance, solved for the temperature at which a surface
 * loses as much as it takes in:
 *
 *   in   = alpha · (beam · cos(sun) + sky light · sky view) + U · (inside − outside)
 *   out  = (wind + store) · (T − outside) + emissivity · sigma · (T⁴ − outside⁴) + sky view · sky cooling
 *
 * where `sky view` is 1 for a face looking straight up, 0.5 for a vertical one and 0 for a face looking
 * down. The T⁴ term is what keeps a hot surface from running away as the wind drops; `store` is the heat
 * that soaks into the mass below a pavement or the soil during the day, which is why a road does not get
 * as hot as a thin black roof. Newton's method solves it in a few steps.
 *
 * THREE copies of this balance exist and must stay in step: this one (the reference, unit-tested), the
 * frame's shader and the frame's JS mirror that the probe reads (both in twinFrame.ts, which is a page
 * built as a string and so cannot import this). The defaults below are injected into that page, so the
 * numbers at least are never copied by hand.
 *
 * What it still leaves out: thermal mass as a time lag (the surface would peak an hour or so after the
 * sun does), shadows cast by neighbouring parts, sunlight reflected off the ground onto walls, the
 * longwave a hot ground sends back to a wall, evaporation (vegetation's low absorptance stands in for
 * it), and any difference between the true surface temperature and what a camera set to emissivity 1
 * would read (2–3 K low on asphalt). It is a demonstration, not a measurement.
 */

/** What the surfaces are simulated under. Temperatures in °C. */
export interface SimScenario {
  tOut: number; // the outside air
  tIn: number; // the conditioned interior
  irradiance: number; // W/m² of direct sun on a surface squarely facing it
  diffuse: number; // W/m² of sky light (diffuse) on a surface looking straight up
  sunAzimuthDeg: number; // where the sun stands, in the subject's frame: 0 = in front, 90 = to the right
  sunElevationDeg: number; // above the horizon; ≤ 0 is night — no sun, whatever the irradiance says
  windH: number; // W/m²K, convection to the outside air (the wind); radiation is separate
  skyLoss: number; // W/m², the extra longwave a clear sky takes from a surface looking up at it
}

/** How one kind of surface takes part in the balance. */
export interface SimMaterial {
  U: number; // W/m²K, conduction from the conditioned interior to this face
  alpha: number; // solar absorptance, 0..1
  store: number; // W/m²K, daytime heat soaking into the mass below (a pavement, the soil); 0 for a thin skin
  bias: number; // K, for what the balance still leaves out (evaporation from leaves)
}

/** The kinds the simulation tells apart; any other kind (metal, wood, glassware …) is painted as 'other'. */
export const SIM_KINDS = [
  'wall',
  'glass',
  'roof',
  'column',
  'canopy',
  'frame',
  'pavement',
  'road',
  'vegetation',
  'ground',
  'other',
] as const;
export type SimKind = (typeof SIM_KINDS)[number];
export type SimMaterials = Record<SimKind, SimMaterial>;

/**
 * The materials a twin starts with, tuned so the balance lands on what thermal cameras really measure:
 * a dark road near 60 °C and a black roof near 68 °C on a clear 33 °C afternoon in a light breeze,
 * irrigated planting close to the air, glass a few K over it on a winter night. Parts with nothing
 * heated behind them — columns under a raised wing, a canopy, the site — get little or no U; the site's
 * surfaces carry the store, a roof or a window none.
 */
export const SIM_MATERIALS: Readonly<SimMaterials> = {
  wall: { U: 0.6, alpha: 0.55, store: 0, bias: 0 },
  glass: { U: 2.8, alpha: 0.12, store: 0, bias: 0 },
  // Dark roofing, the common case and the hottest thing on a building; dial it down for a light or
  // metal roof.
  roof: { U: 0.3, alpha: 0.93, store: 0, bias: 0 },
  column: { U: 0.3, alpha: 0.6, store: 0, bias: 0 },
  canopy: { U: 0.15, alpha: 0.7, store: 0, bias: 0 },
  frame: { U: 1.5, alpha: 0.5, store: 0, bias: 0 },
  pavement: { U: 0, alpha: 0.7, store: 5, bias: 0 },
  road: { U: 0, alpha: 0.9, store: 5, bias: 0 },
  // Leaves spend most of the sun they catch on evaporation, so a tree reads near or under the air: the
  // low absorptance stands in for the evaporation the balance does not model.
  vegetation: { U: 0, alpha: 0.12, store: 3, bias: -2 },
  ground: { U: 0, alpha: 0.6, store: 5, bias: 0 },
  other: { U: 0.8, alpha: 0.5, store: 0, bias: 0 },
};

/** What each kind stands for, for the materials table. */
export const SIM_KIND_HINTS: Readonly<Record<SimKind, string>> = {
  wall: 'Walls: a little heat leaks out from inside; about half the sunlight is absorbed.',
  glass: 'Glazing: leaks the most heat from inside, absorbs little sunlight.',
  roof: 'Roofs: dark roofing over insulation, with nothing below to soak up the heat — the hottest surface on a building.',
  column: 'Columns and piers: little heated behind them.',
  canopy: 'Canopies and porch roofs: nothing heated behind them.',
  frame: 'Window and door frames.',
  pavement: 'Paving: nothing heated below, but the slab soaks up a fifth of the sun it absorbs.',
  road: 'Asphalt: absorbs nearly all the sunlight, and soaks a good share of it into the pavement.',
  vegetation: 'Leaves and grass: spend most of the sun on evaporation. Dry grass is far hotter than this.',
  ground: 'The ground plane the model stands on: bare soil, which also soaks up heat.',
  other: 'Every other kind — metal, wood, plastic and the rest.',
};

/** Convection to the outside air in a light breeze, W/m²K: still air is about 4, a gale 30. Radiation is
 *  no longer folded in here — the balance has its own T⁴ term. */
export const SIM_DEFAULT_WIND_H = 12;
/** The extra longwave a clear sky takes from a surface looking up at it, W/m²: about 60 under a clear
 *  sky, 0 under thick cloud. */
export const SIM_DEFAULT_SKY_LOSS = 60;
/** How grey the surfaces are to longwave radiation. Asphalt, paint, glass and leaves all sit at 0.9–0.95;
 *  only bare metal is far from it, and the simulation paints metal as 'other'. */
export const SIM_EMISSIVITY = 0.95;
/** The Stefan–Boltzmann constant, W/m²K⁴. */
export const SIM_SIGMA = 5.670374419e-8;
const ZERO_C = 273.15;

type Bounds = readonly [number, number];
/** What each control may reach (°C, W/m², degrees, W/m²K; alpha a fraction). The inputs clamp to these;
 *  the balance guards its own arithmetic whatever it is given. */
export const SIM_LIMITS: Readonly<Record<keyof SimScenario | keyof SimMaterial | 'scale', Bounds>> = {
  tOut: [-30, 50],
  tIn: [0, 40],
  irradiance: [0, 1200],
  diffuse: [0, 400],
  sunAzimuthDeg: [0, 359],
  sunElevationDeg: [-10, 90],
  windH: [2, 40],
  skyLoss: [0, 150],
  U: [0, 6],
  alpha: [0, 1],
  store: [0, 15],
  bias: [-10, 10],
  scale: [-40, 130],
};

export type SimPresetKey = 'winterNight' | 'winterDay' | 'summerDay' | 'summerNight';

export interface SimPreset {
  label: string;
  hint: string;
  scenario: SimScenario;
  /** The fixed colour scale, °C: like a thermal camera in manual mode, so a colour means the same
   *  temperature whatever the model holds. Each spans what its balance produces, with room at both ends. */
  range: [number, number];
}

const AIR = { windH: SIM_DEFAULT_WIND_H, skyLoss: SIM_DEFAULT_SKY_LOSS };

/** Starting points: each fills in every condition and the scale; the viewer changes what it likes after.
 *  The sky light of a clear day is about a sixth of the direct beam. */
export const SIM_PRESETS: Readonly<Record<SimPresetKey, SimPreset>> = {
  winterNight: {
    label: 'Winter night',
    hint: 'Heated inside, freezing outside, clear sky: glass leaks heat, the roof chills.',
    scenario: { tOut: -5, tIn: 21, irradiance: 0, diffuse: 0, sunAzimuthDeg: 0, sunElevationDeg: -10, ...AIR },
    range: [-12, 2],
  },
  winterDay: {
    label: 'Winter day',
    hint: 'Low sun on one side, heating inside: sunlit walls warm a little, glass still stands out.',
    scenario: { tOut: 2, tIn: 21, irradiance: 500, diffuse: 80, sunAzimuthDeg: 150, sunElevationDeg: 25, ...AIR },
    range: [-5, 25],
  },
  summerDay: {
    label: 'Summer afternoon',
    hint: 'High sun, air-conditioned inside: the roof and the road bake, glass reads cooler.',
    scenario: { tOut: 33, tIn: 24, irradiance: 800, diffuse: 130, sunAzimuthDeg: 220, sunElevationDeg: 55, ...AIR },
    range: [25, 75],
  },
  summerNight: {
    label: 'Summer night',
    hint: 'Warm air, no sun: everything close to the air, the roof a little below it.',
    scenario: { tOut: 24, tIn: 24, irradiance: 0, diffuse: 0, sunAzimuthDeg: 0, sunElevationDeg: -10, ...AIR },
    range: [15, 30],
  },
};

export const SIM_PRESET_KEYS = Object.keys(SIM_PRESETS) as SimPresetKey[];

const SCENARIO_FIELDS: readonly (keyof SimScenario)[] = [
  'tOut',
  'tIn',
  'irradiance',
  'diffuse',
  'sunAzimuthDeg',
  'sunElevationDeg',
  'windH',
  'skyLoss',
];

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** The preset whose conditions and scale these are exactly, or null when the viewer has made them their own. */
export function matchingPreset(scenario: SimScenario, range: readonly number[]): SimPresetKey | null {
  for (const key of SIM_PRESET_KEYS) {
    const p = SIM_PRESETS[key];
    if (
      SCENARIO_FIELDS.every((f) => same(scenario[f], p.scenario[f])) &&
      same(range[0], p.range[0]) &&
      same(range[1], p.range[1])
    )
      return key;
  }
  return null;
}

/** Whether the sun is up and shining: below the horizon, or with no irradiance, it warms nothing. */
export const sunShines = (s: SimScenario): boolean => s.sunElevationDeg > 0 && s.irradiance > 0;

const SIDES = ['front', 'front-right', 'right', 'back-right', 'back', 'back-left', 'left', 'front-left'];
/** The side of the subject the sun stands on, in eighths: 0° front, 90° right, 180° back, 270° left. */
export function sunSide(azimuthDeg: number): string {
  const a = ((azimuthDeg % 360) + 360) % 360;
  return SIDES[Math.round(a / 45) % 8];
}

/** The simulation's kind for a part's kind: itself when it has its own material, else 'other'. */
export function simKindOf(kind: string): SimKind {
  return (SIM_KINDS as readonly string[]).includes(kind) ? (kind as SimKind) : 'other';
}

/** The kinds a scene's surfaces are painted as — each once, in the materials table's order — with the
 *  ground plane's when it is drawn (an interior's floor is the program's own). */
export function simKindsInScene(kinds: readonly string[], withGround: boolean): SimKind[] {
  const present = new Set(kinds.map(simKindOf));
  if (withGround) present.add('ground');
  return SIM_KINDS.filter((k) => present.has(k));
}

/** The kinds whose material differs from the one a twin starts with. */
export function changedKinds(materials: SimMaterials): SimKind[] {
  return SIM_KINDS.filter((k) => {
    const m = materials[k];
    const d = SIM_MATERIALS[k];
    return !same(m.U, d.U) || !same(m.alpha, d.alpha) || !same(m.store, d.store) || !same(m.bias, d.bias);
  });
}

/** A fresh, editable copy of the starting materials. */
export function defaultMaterials(): SimMaterials {
  const out = {} as SimMaterials;
  for (const k of SIM_KINDS) out[k] = { ...SIM_MATERIALS[k] };
  return out;
}

/** A value brought within a control's bounds (a non-finite one to the lower end). */
export function clampTo(v: number, [lo, hi]: Bounds): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

// ---------------------------------------------------------------------------------------------------
// The balance. Keep in step with the shader and surfaceTemp() in twinFrame.ts.

/** Where the sun stands as a unit vector in the subject's frame (front = +z, right = +x, up = +y);
 *  below the horizon it delivers nothing, so the caller uses `sunPower` for the beam. */
export function sunDirection(s: SimScenario): [number, number, number] {
  const az = (s.sunAzimuthDeg * Math.PI) / 180;
  const el = (s.sunElevationDeg * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
}

/** The beam that actually arrives: none at all once the sun is at or below the horizon. */
export const sunPower = (s: SimScenario): number => (s.sunElevationDeg > 0 ? Math.max(0, s.irradiance) : 0);
/** The sky light that actually arrives: the sky is only bright while the sun is up. */
export const skyPower = (s: SimScenario): number => (s.sunElevationDeg > 0 ? Math.max(0, s.diffuse) : 0);

/**
 * The temperature a surface of this material settles at, given its outward unit normal in the subject's
 * frame. Newton's method on the balance in the file's header: four steps from the linear estimate bring
 * it within a thousandth of a degree over the whole range the controls allow.
 */
export function simSurfaceTemp(material: SimMaterial, normal: readonly number[], s: SimScenario): number {
  const dir = sunDirection(s);
  const n = normalize(normal);
  const cosSun = Math.max(0, n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2]);
  // A face looking straight up sees the whole sky, a vertical one half of it, one looking down none.
  const skyView = Math.min(1, Math.max(0, 0.5 + 0.5 * n[1]));
  const gain = material.alpha * (sunPower(s) * cosSun + skyPower(s) * skyView) + material.U * (s.tIn - s.tOut);
  const h = Math.max(0.5, s.windH) + Math.max(0, material.store);
  const sky = skyView * s.skyLoss;
  const ka = s.tOut + ZERO_C;
  const hr0 = 4 * SIM_EMISSIVITY * SIM_SIGMA * ka * ka * ka;
  let t = s.tOut + (gain - sky) / (h + hr0);
  for (let i = 0; i < 4; i++) {
    const k = t + ZERO_C;
    const k3 = k * k * k;
    const f = h * (t - s.tOut) + SIM_EMISSIVITY * SIM_SIGMA * (k3 * k - ka * ka * ka * ka) + sky - gain;
    t -= f / (h + 4 * SIM_EMISSIVITY * SIM_SIGMA * k3);
  }
  return t + material.bias;
}

function normalize(n: readonly number[]): [number, number, number] {
  const len = Math.hypot(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0);
  return len > 1e-9 ? [n[0] / len, n[1] / len, n[2] / len] : [0, 1, 0];
}
