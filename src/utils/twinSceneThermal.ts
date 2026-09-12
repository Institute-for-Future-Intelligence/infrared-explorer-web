/**
 * The measured heat map of a scene twin (docs/digital-twin-plan.md §18.6 E): turns the surfaces the
 * tracing model outlined in the thermal photos — each a median temperature for one (part, face) in one
 * photo — into the table the sandboxed viewer paints from, one entry per (part, face) the built scene
 * actually has:
 *
 *   1. orientation check — a traced face must be one that photo's camera could see (a mirrored label is
 *      corrected once, then dropped; a top or bottom must also lie on the camera's side of the part);
 *   2. aggregation — the same (part, face) seen in several photos becomes one value when the photos
 *      agree, else the best-sampled photo's value, flagged;
 *   3. inference — faces no photo traced borrow from comparable measured faces by rules that depend on
 *      what the subject is, never across thermal classes, never from reflective or doubtful sources;
 *      what nothing comparable was measured for stays "no data" — unless the viewer asks for the
 *      all-inferred fill, which then fills it (the scenery and the ground too) from the measurements by
 *      an ever looser likeness, every such value weak and labelled with what it rests on.
 *
 * Every entry says which it is (measured / inferred / none) and carries the label the probe shows, so a
 * viewer can never mistake an inference for a reading. Pure functions, unit-tested (twinSceneThermal.test.ts);
 * the viewer frame only looks values up. No three.js, no React: the geometry here is six axis-aligned face
 * normals and one dot product.
 *
 * The table is one value per face. Wherever a thermal photo registered to the model sees it, the frame
 * paints the photo's own pixels instead (§18.8, utils/twinProjection.ts); the table is what the rest of
 * the model — and every face of a record without registered photos — is painted from.
 */
import type { TwinBuildingThermal, TwinBuildingView, TwinFace, TwinSubjectKind, TwinThermalSurface } from '../types';
import { normalizePaletteName } from './palette';
import { PALETTE_COLORS } from './paletteData';

// ---------------------------------------------------------------------------------------------------
// Frame messages (twinFrame.ts speaks these; kept here so the panel and the util share one definition).

/** A part as the frame found it after running the program (`built` message, §18.6 D1). */
export interface TwinBuiltPart {
  name: string; // canonical part name, or 'unnamed'
  kinds: string[]; // material kinds present, most meshes first
  faces: TwinFace[]; // the six-face classes its vertices span
  center: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  meshCount: number;
  round: boolean; // vertex normals spread over ≥ 3 lateral faces (a cylinder, a sphere)
}

export interface TwinBuiltMessage {
  type: 'built';
  meshes: number;
  parts: TwinBuiltPart[];
  unnamedMeshes: number;
  size: number; // the scene's largest extent, metres
}

/** One (part, face) of the paint table (`paint` message, §18.6 D2). */
export interface TwinPaintEntry {
  part: string;
  face: TwinFace;
  tempC: number | null; // null when status is 'none'
  status: 'measured' | 'inferred' | 'none';
  photo?: number; // the photo a measured value came from
  confidence?: 'strong' | 'weak';
  apparent?: boolean;
  label: string; // what the probe shows, already worded and in the viewer's unit
  /** Where the cameras that traced a round part's body ('all' or a height band) stood, [x, y, z] each.
   *  A vertex of that part whose normal faces none of them was never in a photo: the frame paints it as
   *  inferred and the probe shows `farLabel` there. Absent when no contributing photo has a camera on
   *  record (the whole body is then measured, weakly) and on every single-face entry. */
  cameras?: number[][];
  farLabel?: string;
}

export interface TwinPaintMessage {
  type: 'paint';
  entries: TwinPaintEntry[];
  lo: number; // the fixed colour scale, °C
  hi: number;
  palette: string[] | null; // 256 hex colours cold→hot, or null for the frame's built-in iron
  measuredOnly: boolean;
  /** Whether inferred faces are drawn under stripes. False in the all-inferred fill, where every face is
   *  inferred at some remove and the probe alone tells a reading from an inference. */
  stripes: boolean;
  /** The ground fixture's temperature in the all-inferred fill — it is scenery, painted from the site
   *  measurements or the scene as a whole — with the label the probe shows; null leaves it grey. */
  ground: TwinGroundPaint | null;
}

export interface TwinGroundPaint {
  tempC: number;
  label: string;
}

/** How far the measured view reaches beyond the camera's own readings: only those ('measured'), the
 *  faces comparable measured surfaces vouch for ('comparable', the default), or every face of the model,
 *  the rest filled from the measurements by ever looser likeness ('all'). */
export type TwinFill = 'measured' | 'comparable' | 'all';

// ---------------------------------------------------------------------------------------------------

/** The table the viewer paints from, with what the panel reports about it. */
export interface SurfaceTable {
  entries: TwinPaintEntry[];
  stats: {
    measured: number; // entries with a measurement
    inferred: number;
    none: number;
    rejected: number; // traced surfaces dropped before aggregation: rejectedNoPart + rejectedOrientation
    rejectedNoPart: number; // …because the program never built the part they name
    rejectedOrientation: number; // …because their photo's camera could not see the face (nor its mirror)
    unplaced: number; // accepted surfaces on a face the built part has no entry for (a side the frame never saw)
    unknownParts: number; // distinct traced part names the built scene lacks — the "names did not match" signal
    flipped: number; // traced surfaces whose face was mirrored to the one the camera could see
    photos: number; // photos that contributed at least one accepted surface
    /** Of the inferred faces, those the all-inferred fill gave a value the comparable rules would not have
     *  (0 outside that fill). */
    filled: number;
  };
  range: [number, number]; // default colour scale, °C
  sliderBounds: [number, number]; // what the Scale slider may span, °C
  /** What the ground fixture is painted in the all-inferred fill; null in the other fills, and when the
   *  scene has no measurement at all. */
  ground: TwinGroundPaint | null;
}

/** Part names as the frame and the server compare them: lower case, letters and digits only. */
export function normalizePartName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// ---------------------------------------------------------------------------------------------------
// Faces.

/** The six faces with a normal, in the tie-break order the frame uses. */
const SIX_FACES: readonly TwinFace[] = ['front', 'right', 'back', 'left', 'top', 'bottom'];

/** Outward normals in the subject frame (front = +z, right = +x, top = +y). */
const FACE_NORMAL: Record<string, [number, number, number]> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
};

/** The face a camera-facing check may correct a traced face to: the model sometimes mirrors left/right
 *  (or front/back) when it reasons about "the building's right" from the camera's point of view, and
 *  calls a ceiling's underside its 'top' (or a shelf's upper side its 'bottom'). The top↔bottom flip is
 *  guarded by canSee: it happens only when the camera is strictly below the part's underside (or strictly
 *  above its top), never from between — a roof traced from the ground is sky, not a floor. */
const MIRROR_FACE: Partial<Record<TwinFace, TwinFace>> = {
  left: 'right',
  right: 'left',
  front: 'back',
  back: 'front',
  top: 'bottom',
  bottom: 'top',
};

/** The part the frame gives bare api.box/api.cylinder scenery: it is not part of the subject. */
const SCENERY_PART = 'unnamed';

const isSixFace = (face: TwinFace): boolean => face in FACE_NORMAL;
const isBand = (face: TwinFace): boolean => face === 'upper' || face === 'middle' || face === 'lower';
/** Top and bottom are horizontal; the four sides, a body's 'all' and its height bands are lateral. */
const isHorizontal = (face: TwinFace): boolean => face === 'top' || face === 'bottom';

/** The six-face class of a world-space normal: its dominant axis (ties broken front > right > back > left
 *  > top > bottom, as the frame does). A zero normal is called 'front' for want of anything better. */
export function faceOfNormal(nx: number, ny: number, nz: number): TwinFace {
  const along: Record<string, number> = {
    front: nz > 0 ? nz : 0,
    right: nx > 0 ? nx : 0,
    back: nz < 0 ? -nz : 0,
    left: nx < 0 ? -nx : 0,
    top: ny > 0 ? ny : 0,
    bottom: ny < 0 ? -ny : 0,
  };
  let best: TwinFace = 'front';
  let bestValue = -1;
  for (const face of SIX_FACES) {
    // Strictly greater: the first face in tie-break order keeps a tie.
    if (along[face] > bestValue) {
      best = face;
      bestValue = along[face];
    }
  }
  return best;
}

/** Whether `face` of a part centred at `center` turns towards a camera at `cam`: the outward normal must
 *  make up at least 15 % of the camera direction, so a face seen edge-on (the model cannot have traced a
 *  usable area of it) fails along with a face turned away. */
function facesCamera(face: TwinFace, center: readonly number[], cam: readonly number[]): boolean {
  const n = FACE_NORMAL[face];
  if (!n) return true; // 'all' and the bands have no single normal
  const dx = cam[0] - center[0];
  const dy = cam[1] - center[1];
  const dz = cam[2] - center[2];
  const len = Math.hypot(dx, dy, dz);
  if (len === 0) return false;
  return n[0] * dx + n[1] * dy + n[2] * dz > 0.15 * len;
}

/** Whether a camera at `cam` could have seen `face` of `part` (§18.6 E2 ①): a top only from above the
 *  part's top (from lower down it is sky, whatever the dot product against the centre says of a tall
 *  part), a bottom only from below its underside, and every face must turn towards the camera. Both the
 *  explicit-face path and the whole-body path decide visibility here, so they cannot disagree. */
function canSee(face: TwinFace, part: TwinBuiltPart, cam: readonly number[]): boolean {
  if (face === 'top' && cam[1] <= part.max[1]) return false;
  if (face === 'bottom' && cam[1] >= part.min[1]) return false;
  return facesCamera(face, part.center, cam);
}

// ---------------------------------------------------------------------------------------------------
// Thermal classes (§18.6 E3). Inference never crosses a class: a wall may lend its temperature to a roof
// of the same building, but never to its windows (reflective), its lawn (a different heat balance) or the
// water in a beaker. Kinds the server does not know arrive as 'other', which is envelope.

type ThermalClass = 'envelope' | 'glazing' | 'metal' | 'site' | 'vegetation' | 'liquid' | 'fabric';

const CLASS_OF_KIND: Record<string, ThermalClass> = {
  wall: 'envelope',
  roof: 'envelope',
  column: 'envelope',
  canopy: 'envelope',
  frame: 'envelope',
  stone: 'envelope',
  wood: 'envelope',
  plastic: 'envelope',
  other: 'envelope',
  glass: 'glazing',
  metal: 'metal',
  pavement: 'site',
  road: 'site',
  ground: 'site',
  vegetation: 'vegetation',
  liquid: 'liquid',
  fabric: 'fabric',
};

const classOfKind = (kind: string): ThermalClass => CLASS_OF_KIND[kind] ?? 'envelope';

/** What a reading of a low-emissivity surface actually is, for the label. */
const apparentNote = (kind: string): string =>
  kind === 'metal' ? 'apparent (low emissivity, likely reads low)' : 'apparent (reflects sky/surroundings)';

// ---------------------------------------------------------------------------------------------------
// Temperatures in the viewer's unit.

type Unit = 'C' | 'F';

const toUnit = (c: number, unit: Unit): number => (unit === 'F' ? c * 1.8 + 32 : c);
/** A temperature DIFFERENCE in the viewer's unit (no offset). */
const deltaToUnit = (k: number, unit: Unit): number => (unit === 'F' ? k * 1.8 : k);

/** One decimal, never "-0.0". */
function fmt(v: number): string {
  const s = v.toFixed(1);
  return s === '-0.0' ? '0.0' : s;
}

const fmtTemp = (c: number, unit: Unit): string => `${fmt(toUnit(c, unit))} °${unit}`;

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------------------------------
// Step 1 — orientation check.

interface Accepted {
  s: TwinThermalSurface;
  part: TwinBuiltPart;
  partKey: string;
  face: TwinFace; // the face after any mirror correction
}

interface OrientationResult {
  accepted: Accepted[];
  rejectedNoPart: number;
  rejectedOrientation: number;
  unknownParts: number;
  flipped: number;
}

/**
 * Keep the traced surfaces the built scene can carry and their photo's camera could see (§18.6 E2 ①).
 * A surface whose part the program never built has nowhere to go and counts as rejected for that reason
 * (the distinct names are counted too, so the panel can tell a naming mismatch from a camera problem).
 * A photo the model gave no camera for is not checked — there is nothing to check against. 'all' and the
 * height bands have no single normal and pass; the six faces must be visible from the camera (canSee),
 * and a face that is not is tried once as its mirror (the model's commonest slip is naming the side from
 * its own point of view; for a ceiling, calling its underside 'top') provided the mirror face is visible
 * and the same photo did not already trace it.
 */
function checkOrientation(
  surfaces: TwinThermalSurface[],
  partsByKey: Map<string, TwinBuiltPart>,
  viewsByPhoto: Map<number, TwinBuildingView>,
): OrientationResult {
  const accepted: Accepted[] = [];
  let rejectedNoPart = 0;
  let rejectedOrientation = 0;
  let flipped = 0;
  const unknown = new Set<string>();
  // Every (photo, part, face) the photos traced, so a flip never lands on a face the photo already has.
  const occupied = new Set<string>();
  for (const s of surfaces) occupied.add(`${s.photo}|${normalizePartName(s.part)}|${s.face}`);

  for (const s of surfaces) {
    const partKey = normalizePartName(s.part);
    const part = partsByKey.get(partKey);
    if (!part) {
      rejectedNoPart++;
      unknown.add(partKey);
      continue;
    }
    const view = viewsByPhoto.get(s.photo);
    if (!view || !isSixFace(s.face)) {
      accepted.push({ s, part, partKey, face: s.face });
      continue;
    }
    const cam = [view.x, view.y, view.z];
    if (canSee(s.face, part, cam)) {
      accepted.push({ s, part, partKey, face: s.face });
      continue;
    }
    const mirror = MIRROR_FACE[s.face];
    const slot = `${s.photo}|${partKey}|${mirror}`;
    if (mirror && !occupied.has(slot) && canSee(mirror, part, cam)) {
      occupied.add(slot);
      accepted.push({ s, part, partKey, face: mirror });
      flipped++;
      continue;
    }
    rejectedOrientation++;
  }
  return { accepted, rejectedNoPart, rejectedOrientation, unknownParts: unknown.size, flipped };
}

// ---------------------------------------------------------------------------------------------------
// Step 2 — aggregation across photos.

/** One (part, face) after the photos that traced it were reconciled. */
interface Aggregate {
  partKey: string;
  part: TwinBuiltPart;
  face: TwinFace;
  kind: string; // the tracing model's kind for the dominant reading
  tempC: number;
  photos: number[]; // every contributing photo
  photo: number; // the dominant contributor — the label's photo, n and p10–p90 are its
  n: number;
  p10: number;
  p90: number;
  disagree: boolean;
  spread: number; // max − min of the contributing medians, K
  readings: number; // traced areas that went into it (more than photos when one photo traced a face twice)
  smallSample: boolean;
  mixed: boolean;
  apparent: boolean;
}

/**
 * One value per (part, face) (§18.6 E2 ②). Photos that agree — their medians within max(2 K, 15 % of
 * the scene's span of accepted medians) of each other — average with the pixel count as weight; photos
 * that do not are decided by the best-sampled one, flagged so the label shows the spread. The dominant photo's flags speak for
 * the aggregate: when a full sample agrees with a small one, the full sample is the dominant one.
 *
 * A round part (a cylinder, a tree) is painted by height band, never by side, so a side the model
 * traced on it ('front' of a kettle) is folded into its 'all' — but its top and bottom stay their own
 * faces (a hot plate's top is not its rim, and the frame looks a cap's vertices up by face before it
 * reaches for a band). A height band traced on a boxy part is folded into 'all' likewise, because the
 * frame paints boxes by side and would otherwise never look the band up.
 */
function foldFace(part: TwinBuiltPart, face: TwinFace): TwinFace {
  if (part.round) return isBand(face) || isHorizontal(face) ? face : 'all';
  return isBand(face) ? 'all' : face;
}

function aggregate(accepted: Accepted[]): Map<string, Aggregate> {
  const groups = new Map<string, Accepted[]>();
  for (const a of accepted) {
    const face = foldFace(a.part, a.face);
    const key = `${a.partKey}|${face}`;
    const list = groups.get(key);
    if (list) list.push({ ...a, face });
    else groups.set(key, [{ ...a, face }]);
  }
  const all = accepted.map((a) => a.s.median);
  const tolerance = all.length ? Math.max(2, 0.15 * (Math.max(...all) - Math.min(...all))) : 2;
  const out = new Map<string, Aggregate>();
  for (const [key, list] of groups) {
    const medians = list.map((a) => a.s.median);
    const spread = Math.max(...medians) - Math.min(...medians);
    const agree = spread <= tolerance;
    let dominant = list[0];
    for (const a of list) if (a.s.n > dominant.s.n) dominant = a;
    let tempC = dominant.s.median;
    if (agree && list.length > 1) {
      let sum = 0;
      let weight = 0;
      for (const a of list) {
        sum += a.s.median * a.s.n;
        weight += a.s.n;
      }
      tempC = weight > 0 ? sum / weight : dominant.s.median;
    }
    out.set(key, {
      partKey: dominant.partKey,
      part: dominant.part,
      face: dominant.face,
      kind: dominant.s.kind || dominant.part.kinds[0] || 'other',
      tempC,
      photos: [...new Set(list.map((a) => a.s.photo))],
      photo: dominant.s.photo,
      n: dominant.s.n,
      p10: dominant.s.p10,
      p90: dominant.s.p90,
      disagree: !agree,
      spread,
      readings: list.length,
      smallSample: !!dominant.s.smallSample,
      mixed: !!dominant.s.mixed,
      apparent: !!dominant.s.apparent,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Step 3 — inference.

/** A measured entry another face may borrow from. */
interface Source {
  partKey: string;
  kind: string;
  cls: ThermalClass;
  face: TwinFace;
  tempC: number;
  apparent: boolean;
  /** Why the comparable rules may not borrow from it — an apparent, mixed-surface or small-area reading;
   *  absent for a clean source. The all-inferred fill reaches for these after the clean ones. */
  doubtful?: 'apparent' | 'mixed-surface' | 'small-area';
  n: number; // the pixels of the dominant reading (groundCover weighs by it)
}

/** The source an aggregate makes, with its doubt (the gravest first) recorded rather than filtered. */
function sourceOf(partKey: string, face: TwinFace, a: Aggregate): Source {
  const doubtful = a.apparent ? 'apparent' : a.mixed ? 'mixed-surface' : a.smallSample ? 'small-area' : undefined;
  return {
    partKey,
    kind: a.kind,
    cls: classOfKind(a.kind),
    face,
    tempC: a.tempC,
    apparent: a.apparent,
    ...(doubtful ? { doubtful } : {}),
    n: a.n,
  };
}

/** The classes that cover the ground round a subject: paving and bare ground, and what grows on it. */
const GROUND_COVER: ReadonlySet<ThermalClass> = new Set<ThermalClass>(['site', 'vegetation']);

/**
 * What the ground fixture is painted in the all-inferred fill, when the photos measured any of what covers
 * the ground: the clean site AND vegetation readings — a lawn is most of the ground round a house, and a
 * plane twenty times the model's size painted the colour of the one sun-baked street in front of it (the
 * site class alone) is what the viewer sees first — one value per part (its top where it has one; never an
 * underside), weighted by the pixels each was read from. Null when nothing of the ground cover was
 * measured cleanly: the fill's ladder then decides, as for any face.
 */
function groundCover(sources: Source[]): { tempC: number; from: string } | null {
  const byPart = new Map<string, Source>();
  for (const s of sources) {
    if (s.doubtful || !GROUND_COVER.has(s.cls) || s.face === 'bottom') continue;
    const prev = byPart.get(s.partKey);
    if (!prev || (s.face === 'top' && prev.face !== 'top')) byPart.set(s.partKey, s);
  }
  const picked = [...byPart.values()];
  if (!picked.length) return null;
  let sum = 0;
  let weight = 0;
  for (const s of picked) {
    const w = Math.max(1, s.n);
    sum += s.tempC * w;
    weight += w;
  }
  return {
    tempC: sum / weight,
    from: `inferred from the ground cover measured (${describe(picked)}), weighted by the area each was read over`,
  };
}

interface Target {
  partKey: string;
  kind: string;
  cls: ThermalClass;
  face: TwinFace;
}

interface Inference {
  tempC: number;
  confidence: 'strong' | 'weak';
  from: string; // the label's "inferred from …" clause, without the "(weak)"
}

/** A source may serve a target only within the same thermal class and the same orientation family: a
 *  top borrows from tops, a bottom from bottoms, and a side, a body or a band from sides, bodies and
 *  bands — a sun-lit roof says nothing about a shaded wall and a hot plate's top nothing about its rim. */
const comparable = (src: Source, t: Target): boolean =>
  src.cls === t.cls && (isHorizontal(t.face) ? src.face === t.face : !isHorizontal(src.face));

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** "2 wall faces" / "3 wall/column faces" — the source kinds, so the reader sees what lent the value. */
function describe(srcs: Source[]): string {
  const kinds = [...new Set(srcs.map((s) => s.kind))];
  return plural(srcs.length, `${kinds.join('/')} face`);
}

const fromAll = (srcs: Source[], clause: string, confidence: 'strong' | 'weak'): Inference => ({
  tempC: mean(srcs.map((s) => s.tempC)),
  confidence,
  from: `inferred from ${describe(srcs)} ${clause}`,
});

/**
 * The rules of §18.6 E3, first hit wins. The order differs by subject: a building's like faces (the
 * north walls of two wings) are alike because they share sun and wind, so kind + face comes before the
 * part's own other faces; a piece of apparatus is at one temperature per part (a kettle is hot all
 * round), so the part's own faces come first. Glass and metal never get here as sources — their readings
 * are apparent, and apparent readings are excluded — so with the class barrier they stay 'none' unless
 * traced themselves. No rule reaches for a scene-wide mean: a face nothing comparable was measured for
 * stays "no data".
 */
function infer(t: Target, all: Source[], subjectKind: TwinSubjectKind | undefined): Inference | null {
  const pool = all.filter((s) => comparable(s, t));
  const samePart = pool.filter((s) => s.partKey === t.partKey && s.face !== t.face);
  const sameKindSameFace = pool.filter((s) => s.partKey !== t.partKey && s.kind === t.kind && s.face === t.face);
  const sameKind = pool.filter((s) => s.partKey !== t.partKey && s.kind === t.kind);
  const sameFace = pool.filter((s) => s.partKey !== t.partKey && s.face === t.face);
  const others = pool.filter((s) => s.partKey !== t.partKey);

  if (subjectKind === 'building' || subjectKind === 'nature') {
    if (sameKindSameFace.length) return fromAll(sameKindSameFace, 'facing the same way', 'strong');
    // The part's own sides only when they tell one story: a sunlit and a shaded wall 6 K apart say
    // nothing reliable about the third.
    if (samePart.length && !isHorizontal(t.face)) {
      const temps = samePart.map((s) => s.tempC);
      if (Math.max(...temps) - Math.min(...temps) <= 2)
        return {
          tempC: mean(temps),
          confidence: 'strong',
          from: `inferred from ${plural(samePart.length, 'other face')} of this part`,
        };
    }
    if (sameFace.length) return fromAll(sameFace, 'facing the same way', 'strong');
    if (others.length && !isHorizontal(t.face)) return fromAll(others, 'facing other ways', 'weak');
    return null;
  }
  // apparatus / vehicle / interior / other, and a record too old to say
  if (samePart.length)
    return {
      tempC: mean(samePart.map((s) => s.tempC)),
      confidence: 'strong',
      from: `inferred from ${plural(samePart.length, 'other face')} of this part`,
    };
  if (sameKindSameFace.length) return fromAll(sameKindSameFace, 'facing the same way', 'strong');
  if (sameKind.length) return fromAll(sameKind, 'facing other ways', 'strong');
  if (others.length) return fromAll(others, isHorizontal(t.face) ? 'facing the same way' : 'facing other ways', 'weak');
  return null;
}

/** A face of the same orientation family as the target: the same face for a top or bottom, any lateral
 *  face (a side, a body, a band) for a lateral target. */
const sameFamily = (t: Target, s: Source): boolean =>
  isHorizontal(t.face) ? s.face === t.face : !isHorizontal(s.face);

/** What the sources of a fill inference are, when some are readings the comparable rules refuse. An
 *  inference whose sources are all apparent is apparent itself and its label says so already. */
function doubtNote(srcs: Source[]): string {
  if (srcs.every((s) => s.apparent)) return '';
  const flags = [...new Set(srcs.map((s) => s.doubtful).filter((f): f is NonNullable<Source['doubtful']> => !!f))];
  if (!flags.length) return '';
  return ` · ${srcs.every((s) => s.doubtful) ? '' : 'some '}${flags.join('/')} readings`;
}

interface FillInference extends Inference {
  apparent: boolean;
}

/**
 * The all-inferred fill: what a face is given when the rules above found nothing comparable. Still from
 * the measurements, never invented, but by an ever looser likeness — first hit wins, every hit weak:
 *   1. the part's own measured faces, whatever way they face;
 *   2. the same kind, then the same thermal class, on other parts, facing any way;
 *   3. the same class again, now admitting the readings the comparable rules refuse (apparent, mixed,
 *      small-area) — a window's apparent reading says more about another window than a wall does;
 *   4. the whole scene's clean readings, facing the same way first, then any;
 *   5. every reading the scene has.
 * The value is the plain mean of the sources found.
 */
function inferFill(t: Target, all: Source[]): FillInference | null {
  const clean = all.filter((s) => !s.doubtful);
  const other = (s: Source) => s.partKey !== t.partKey;
  const scene = (srcs: Source[]) =>
    `inferred from every measured face of the scene (${describe(srcs)}) · nothing of the same material measured`;
  const steps: [Source[], (srcs: Source[]) => string][] = [
    [
      clean.filter((s) => s.partKey === t.partKey && s.face !== t.face),
      (srcs) => `inferred from ${plural(srcs.length, 'other face')} of this part facing other ways`,
    ],
    [clean.filter((s) => other(s) && s.kind === t.kind), (srcs) => `inferred from ${describe(srcs)} facing other ways`],
    [clean.filter((s) => other(s) && s.cls === t.cls), (srcs) => `inferred from ${describe(srcs)} facing other ways`],
    [
      all.filter((s) => s.cls === t.cls && sameFamily(t, s)),
      (srcs) => `inferred from ${describe(srcs)} facing the same way${doubtNote(srcs)}`,
    ],
    [
      all.filter((s) => s.cls === t.cls),
      (srcs) => `inferred from ${describe(srcs)} facing other ways${doubtNote(srcs)}`,
    ],
    [
      clean.filter((s) => sameFamily(t, s)),
      (srcs) => `inferred from ${describe(srcs)} facing the same way · nothing of the same material measured`,
    ],
    [clean, scene],
    [all, (srcs) => scene(srcs) + doubtNote(srcs)],
  ];
  for (const [pool, clause] of steps)
    if (pool.length)
      return {
        tempC: mean(pool.map((s) => s.tempC)),
        confidence: 'weak',
        from: clause(pool),
        apparent: pool.every((s) => s.apparent),
      };
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Step 4 — labels (§18.6 D7). Worded here, in the viewer's unit, so the frame shows them verbatim.

/** `shot` is the word for one picture — 'photo' for a set, 'frame' for a walk-around recording. */
function measuredLabel(a: Aggregate, kind: string, unit: Unit, shot: string, extra: string[]): string {
  const bits = [fmtTemp(a.tempC, unit), kind];
  if (a.apparent) bits.push(apparentNote(kind), `${shot} ${a.photo}`);
  else
    bits.push(
      'measured',
      `${shot} ${a.photo}`,
      `n=${a.n}`,
      `p10–p90 ${fmt(toUnit(a.p10, unit))}–${fmt(toUnit(a.p90, unit))}`,
    );
  if (a.disagree) {
    // Several photos disagreeing is one story; one photo whose traced areas of a face disagree (or whose
    // bands were folded into one body) is another — never "over 1 photos".
    const half = fmt(deltaToUnit(a.spread / 2, unit));
    bits.push(
      a.photos.length > 1
        ? `±${half} over ${plural(a.photos.length, shot)}`
        : `±${half} across ${plural(a.readings, 'traced area')}`,
    );
  }
  if (a.smallSample) bits.push('small area');
  if (a.mixed) bits.push('mixed surface');
  bits.push(...extra);
  return bits.join(' · ');
}

/** `extra` goes after the kind: 'scenery' for what is not part of the subject. */
function inferredLabel(
  tempC: number,
  kind: string,
  unit: Unit,
  from: string,
  weak: boolean,
  apparent: boolean,
  extra: string[] = [],
): string {
  const bits = [fmtTemp(tempC, unit), kind, ...extra];
  if (apparent) bits.push(apparentNote(kind));
  bits.push(from);
  return bits.join(' · ') + (weak ? ' (weak)' : '');
}

const noneLabel = (kind: string): string => `— · ${kind} · no measurement`;
const sceneryLabel = (kind: string): string => `— · ${kind} · scenery · not part of the subject`;

/** What the probe shows on the side of a round body no camera saw: the body's value, owned up to as an
 *  inference rather than a reading. */
function farLabelFor(a: Aggregate, unit: Unit): string {
  const from =
    a.face === 'all'
      ? 'far side, inferred from this part traced as a whole'
      : `far side, inferred from this part's ${a.face} band`;
  return inferredLabel(a.tempC, a.kind, unit, from, false, a.apparent);
}

// ---------------------------------------------------------------------------------------------------
// Step 5 — the table.

/** The faces an entry is owed for a part: the six-face classes the frame saw for a boxy part; 'all' plus
 *  whichever height bands and caps (top, bottom) were traced for a round one (the frame looks a cap up
 *  by face, then a band, then falls back to 'all'). */
function facesOwed(part: TwinBuiltPart, aggregates: Map<string, Aggregate>): TwinFace[] {
  const key = normalizePartName(part.name);
  if (part.round) {
    const traced: TwinFace[] = ['upper', 'middle', 'lower', 'top', 'bottom'];
    return ['all', ...traced.filter((f) => aggregates.has(`${key}|${f}`))];
  }
  const faces = part.faces.filter(isSixFace);
  return faces.length ? faces : ['all'];
}

const EMPTY_STATS: SurfaceTable['stats'] = {
  measured: 0,
  inferred: 0,
  none: 0,
  rejected: 0,
  rejectedNoPart: 0,
  rejectedOrientation: 0,
  unplaced: 0,
  unknownParts: 0,
  flipped: 0,
  photos: 0,
  filled: 0,
};

/**
 * Build the paint table for a scene (§18.6 E2–E4). `parts` is what the frame reported after building,
 * `views` where the phase-1 model judged each photo's camera stood (the record's views) — used for the
 * orientation check (a photo without one is not checked) and for the cameras a round body's entry
 * carries. They stay the phase-1 views even for a photo registered to the model: the tracer named its
 * faces from the viewpoint sentence built from them, and a fitted camera can stand where the model's own
 * (wrong) side geometry hides a side the photo really shows. `unit` decides how labels read, `source`
 * whether they say "photo 3" or "frame 3", `fill` how far inference reaches ('all' fills every face, the
 * scenery and the ground from the measurements by the ladder of inferFill; the other fills differ only in
 * the frame, which greys what 'measured' hides).
 * Without thermal data every face is 'none' and the scale is the default one, so a panel can always send
 * a table.
 */
export function buildSurfaceTable(
  thermal: TwinBuildingThermal | null | undefined,
  parts: TwinBuiltPart[],
  views: TwinBuildingView[] | undefined,
  subjectKind: TwinSubjectKind | undefined,
  unit: 'C' | 'F',
  source: 'photos' | 'orbit' = 'photos',
  fill: TwinFill = 'comparable',
): SurfaceTable {
  const shot = source === 'orbit' ? 'frame' : 'photo';
  const partsByKey = new Map<string, TwinBuiltPart>();
  for (const p of parts) if (!partsByKey.has(normalizePartName(p.name))) partsByKey.set(normalizePartName(p.name), p);
  const viewsByPhoto = new Map<number, TwinBuildingView>();
  for (const v of views ?? []) viewsByPhoto.set(v.photo, v);

  const { accepted, rejectedNoPart, rejectedOrientation, unknownParts, flipped } = checkOrientation(
    thermal?.surfaces ?? [],
    partsByKey,
    viewsByPhoto,
  );
  const aggregates = aggregate(accepted);
  const camerasOf = (a: Aggregate): number[][] =>
    a.photos
      .map((ph) => viewsByPhoto.get(ph))
      .filter((v): v is TwinBuildingView => !!v)
      .map((v) => [v.x, v.y, v.z]);

  // Pass one: what is measured, directly or through a boxy part traced as a whole (G). Scenery the program
  // left unnamed is not part of the subject: it gets a 'none' entry per face saying so, borrows nothing
  // and is left out of the counts.
  interface Pending {
    part: TwinBuiltPart;
    partKey: string;
    kind: string;
    face: TwinFace;
    entry?: TwinPaintEntry;
    source?: Source;
  }
  const pending: Pending[] = [];
  const scenery: Pending[] = [];
  // Every (part, folded face) that gets an entry or feeds one — 'all' always does, through the whole-body
  // path for a boxy part — so a traced surface that lands nowhere can be counted.
  const placed = new Set<string>();
  for (const part of partsByKey.values()) {
    const partKey = normalizePartName(part.name);
    const partKind = part.kinds[0] || 'other';
    const owed = facesOwed(part, aggregates);
    if (partKey === SCENERY_PART) {
      for (const face of owed) scenery.push({ part, partKey, kind: partKind, face });
      continue;
    }
    placed.add(`${partKey}|all`);
    for (const face of owed) {
      placed.add(`${partKey}|${face}`);
      const p: Pending = { part, partKey, kind: partKind, face };
      pending.push(p);
      const own = aggregates.get(`${partKey}|${face}`);
      if (own) {
        // A round part's body ('all', a band) was traced from wherever its photos' cameras stood: the frame
        // paints the vertices facing none of them as inferred, so the entry carries the cameras. With no
        // camera on record we cannot tell which side was seen, so the whole body is measured but weak.
        const body = part.round && (face === 'all' || isBand(face));
        const cams = body ? camerasOf(own) : [];
        const weak = body && cams.length === 0;
        p.entry = {
          part: part.name,
          face,
          tempC: own.tempC,
          status: 'measured',
          photo: own.photo,
          confidence: weak ? 'weak' : 'strong',
          apparent: own.apparent || undefined,
          label: measuredLabel(own, own.kind, unit, shot, []) + (weak ? ' (weak)' : ''),
          ...(cams.length ? { cameras: cams, farLabel: farLabelFor(own, unit) } : {}),
        };
        p.source = sourceOf(partKey, face, own);
        continue;
      }
      const whole = !part.round ? aggregates.get(`${partKey}|all`) : undefined;
      if (whole) {
        // A boxy part traced as a whole: the reading is of the faces that photo's camera could see. Those
        // faces are measured; the faces turned away (and a top or bottom on the far side of the camera's
        // height) only inherit it, weakly. With no camera on record for any contributing photo we cannot
        // tell which faces were seen, so all are measured but weak.
        const cams = camerasOf(whole);
        const seen = cams.some((cam) => canSee(face, part, cam));
        if (cams.length === 0 || seen) {
          const weak = cams.length === 0;
          p.entry = {
            part: part.name,
            face,
            tempC: whole.tempC,
            status: 'measured',
            photo: whole.photo,
            confidence: weak ? 'weak' : 'strong',
            apparent: whole.apparent || undefined,
            label: measuredLabel(whole, whole.kind, unit, shot, ['traced as a whole']) + (weak ? ' (weak)' : ''),
          };
          p.source = sourceOf(partKey, face, whole);
        } else {
          p.entry = {
            part: part.name,
            face,
            tempC: whole.tempC,
            status: 'inferred',
            confidence: 'weak',
            apparent: whole.apparent || undefined,
            label: inferredLabel(
              whole.tempC,
              whole.kind,
              unit,
              'inferred from this part traced as a whole',
              true,
              whole.apparent,
            ),
          };
        }
      }
    }
  }

  // Pass two: the rest borrow from the measured pool — the clean sources by the comparable rules, then,
  // in the all-inferred fill, whatever the fill ladder finds — or stay without data.
  const sources = pending.map((p) => p.source).filter((s): s is Source => !!s);
  const clean = sources.filter((s) => !s.doubtful);
  const fillAll = fill === 'all';
  const targetOf = (p: Pending): Target => ({
    partKey: p.partKey,
    kind: p.kind,
    cls: classOfKind(p.kind),
    face: p.face,
  });
  /** An inference for a face nothing measured, and whether only the fill ladder found it; null when
   *  even that finds nothing, which takes a scene without a single reading. */
  const inferFor = (t: Target): { found: FillInference | null; filled: boolean } => {
    const found = infer(t, clean, subjectKind);
    if (found) return { found: { ...found, apparent: false }, filled: false };
    const filled = fillAll ? inferFill(t, sources) : null;
    return { found: filled, filled: !!filled };
  };
  const inferredEntry = (p: Pending, found: FillInference, extra: string[]): TwinPaintEntry => ({
    part: p.part.name,
    face: p.face,
    tempC: found.tempC,
    status: 'inferred',
    confidence: found.confidence,
    apparent: found.apparent || undefined,
    label: inferredLabel(found.tempC, p.kind, unit, found.from, found.confidence === 'weak', found.apparent, extra),
  });
  const entries: TwinPaintEntry[] = [];
  const stats = {
    ...EMPTY_STATS,
    rejected: rejectedNoPart + rejectedOrientation,
    rejectedNoPart,
    rejectedOrientation,
    unknownParts,
    flipped,
  };
  for (const p of pending) {
    let entry = p.entry;
    if (!entry) {
      const { found, filled } = inferFor(targetOf(p));
      entry = found
        ? inferredEntry(p, found, [])
        : { part: p.part.name, face: p.face, tempC: null, status: 'none', label: noneLabel(p.kind) };
      if (filled) stats.filled++;
    }
    entries.push(entry);
    stats[entry.status]++;
  }
  // Scenery is not part of the subject: 'none' entries saying so, borrowing nothing, out of the counts —
  // except in the all-inferred fill, where it is painted like everything else (and still not counted).
  for (const p of scenery) {
    const found = fillAll ? inferFor(targetOf(p)).found : null;
    entries.push(
      found
        ? inferredEntry(p, found, ['scenery'])
        : { part: p.part.name, face: p.face, tempC: null, status: 'none', label: sceneryLabel(p.kind) },
    );
  }
  // The ground fixture likewise, as scenery of kind 'ground': from the ground cover the photos measured
  // (groundCover), else by the ladder like any face (its key can collide with no part name:
  // normalizePartName keeps letters and digits only).
  let ground: TwinGroundPaint | null = null;
  const cover = fillAll ? groundCover(sources) : null;
  if (cover) {
    ground = {
      tempC: cover.tempC,
      label: inferredLabel(cover.tempC, 'ground', unit, cover.from, true, false, ['scenery']),
    };
  } else if (fillAll) {
    const { found } = inferFor({ partKey: '#ground', kind: 'ground', cls: 'site', face: 'top' });
    if (found) {
      const label = inferredLabel(
        found.tempC,
        'ground',
        unit,
        found.from,
        found.confidence === 'weak',
        found.apparent,
        ['scenery'],
      );
      ground = { tempC: found.tempC, label };
    }
  }
  stats.photos = new Set(accepted.map((a) => a.s.photo)).size;
  stats.unplaced = accepted.filter((a) => !placed.has(`${a.partKey}|${foldFace(a.part, a.face)}`)).length;

  // The default scale spans the measured medians with a kelvin to spare, and at least 4 K so one warm
  // wall does not paint as a rainbow; the slider may reach a little beyond the widest p10–p90.
  const measured = entries.filter((e) => e.status === 'measured' && e.tempC !== null).map((e) => e.tempC as number);
  let range: [number, number];
  if (measured.length) {
    let lo = Math.floor(Math.min(...measured)) - 1;
    let hi = Math.ceil(Math.max(...measured)) + 1;
    if (hi - lo < 4) {
      const pad = (4 - (hi - lo)) / 2;
      lo -= pad;
      hi += pad;
    }
    range = [lo, hi];
  } else {
    const stored = thermal?.range;
    range =
      stored && stored.length === 2 && Number.isFinite(stored[0]) && Number.isFinite(stored[1]) && stored[0] < stored[1]
        ? [stored[0], stored[1]]
        : [15, 35];
  }
  const p10s = accepted.map((a) => a.s.p10).filter(Number.isFinite);
  const p90s = accepted.map((a) => a.s.p90).filter(Number.isFinite);
  const clamp = (v: number) => Math.min(400, Math.max(-40, v));
  const sliderBounds: [number, number] = [
    clamp(p10s.length ? Math.floor(Math.min(...p10s)) - 10 : range[0] - 10),
    clamp(p90s.length ? Math.ceil(Math.max(...p90s)) + 10 : range[1] + 10),
  ];
  if (sliderBounds[1] <= sliderBounds[0]) sliderBounds[1] = clamp(sliderBounds[0] + 1);

  return { entries, stats, range, sliderBounds, ground };
}

// ---------------------------------------------------------------------------------------------------
// Palettes (§18.6 E5).

/** A palette key resampled to 256 hex colours for the frame's LUT texture; the cyclic colorwheel6 (one
 *  colour = two temperatures) and unknown keys fall back to iron. The LUTs are 120–433 entries, so the
 *  resampling picks the nearest stop, as paletteHexAt does for the scale bar. */
export function paletteLut256(key: string | null | undefined): string[] {
  const lut = (key && key !== 'colorwheel6' && PALETTE_COLORS[key]) || PALETTE_COLORS.iron;
  const out: string[] = new Array(256);
  for (let i = 0; i < 256; i++) out[i] = lut[Math.round((i / 255) * (lut.length - 1))];
  return out;
}

/** Which palette paints a measured twin: the set's palette, else the first photo palette on record,
 *  else iron. */
export function paletteKeyFor(exp: { palette?: string; photoPalettes?: (string | null)[] }): string {
  const own = normalizePaletteName(exp.palette);
  if (own) return own;
  for (const p of exp.photoPalettes ?? []) {
    const key = normalizePaletteName(p);
    if (key) return key;
  }
  return 'iron';
}

export type { TwinThermalSurface };
