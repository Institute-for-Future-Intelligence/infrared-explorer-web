/**
 * Registering a thermal photo to the scene twin's model with a real pinhole camera (docs/digital-twin-plan.md
 * §18.8), so the viewer can project the photo's own thermal pixels onto the model — every window, the warm
 * gable, the hot band under the eaves — instead of stretching one small traced patch over a whole face.
 *
 * The surface-tracing model is asked a second question about the same picture: a dozen LANDMARKS, sharp
 * points of the model (box corners, a gable's apex, window corners), each with its coordinates computed
 * from the program and its pixel in the picture. The 3D side comes out exact (the numbers are the
 * program's own); the pixels are a couple of percent of the picture off, and a few are simply wrong (a
 * corner placed on the next window, a point the picture does not show). fitPhotoCamera turns them into a
 * camera: RANSAC over 4-point samples finds the landmarks that agree with each other, Levenberg–Marquardt
 * fits the pose and the focal length to them under loose priors (the phone's field of view, a level
 * horizon, the standpoint phase 1 judged), and gates refuse a camera the landmarks do not support. A
 * program whose geometry is too far from its subject (a walk-around car) is refused on every frame, which
 * is the right outcome: such a photo is simply not projected, and its faces keep their flat medians.
 *
 * Conventions, shared with the client's twinProjection.ts and the viewer frame — all three must agree:
 *   - the camera's world rotation is R = Ry(yaw)·Rx(pitch)·Rz(roll) (three.js Euler order 'YXZ'); it looks
 *     along its local −z, with +y up. Its forward, in the world, is
 *     (−sin(yaw)·cos(pitch), sin(pitch), −cos(yaw)·cos(pitch));
 *   - a camera-space point (x, y, z) at depth d = −z > 0 lands at the picture fractions
 *     u = (aspect/2 + f·x/d) / aspect, v = 0.5 − f·y/d (v down), with f = 0.5 / tan(fovV/2) in picture heights;
 *   - landmarks, and so the camera, live on the picture the tracer saw: the visible photo when the photo
 *     has one, else the thermal render.
 *
 * Dependency-free apart from twinBuilding's helpers, like the rest of the twin's contract: the functions
 * build compiles it and a script can run it straight from the source tree.
 */
import {
  TWIN_SURFACE_CODE_CHARS,
  extractJsonValue,
  normalizePartName,
  type TwinBuildingPart,
  type TwinSurfacePromptContext,
} from './twinBuilding';

// ---------------------------------------------------------------------------------------------------
// Record contract (twinScene.thermal.photos[] — mirrored by src/types.ts on the client)

/** One landmark as the photo's row stores it. */
export interface TwinLandmark {
  part: string; // the part the tracer named (canonical parts[].name when it matches one), ≤ 60 chars
  what: string; // a few words, ≤ 80 chars
  x: number; // model coordinates (metres), rounded to 0.001
  y: number;
  z: number;
  u: number; // position in the picture, fractions (x right, y DOWN), rounded to 0.0001
  v: number;
  inlier: boolean; // the fitted camera agrees with it (false everywhere when there is no camera)
}

/** A landmark as the parser returns it, before the fit says whether it agrees. */
export type ParsedTwinLandmark = Omit<TwinLandmark, 'inlier'>;

/** The fitted camera of one photo (conventions in the header). */
export interface TwinPhotoCamera {
  position: number[]; // [x, y, z] metres (flat, 3 numbers)
  yaw: number; // radians, three.js Euler order 'YXZ'; the camera looks along its −z
  pitch: number;
  roll: number;
  fovV: number; // vertical field of view, degrees
  aspect: number; // picture width / height (the picture the landmarks were placed on)
  rms: number; // reprojection RMS of the inliers, fraction of the picture HEIGHT
  inliers: number; // how many landmarks it agrees with
}

// ---------------------------------------------------------------------------------------------------
// The landmark call

/** Landmarks per photo the parser keeps; the prompt asks for 10 to 16. */
export const TWIN_LANDMARK_MAX = 20;

/** Strict-mode schema for the landmark answer (every property required, no additionalProperties). */
export const TWIN_LANDMARK_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['landmarks'],
  properties: {
    landmarks: {
      type: 'array',
      description: 'Sharp points of the model the picture shows, 10 to 16 of them.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['part', 'what', 'x', 'y', 'z', 'px', 'py'],
        properties: {
          part: { type: 'string', description: 'The part the point belongs to, a name from the list.' },
          what: { type: 'string', description: 'A few words: which point it is.' },
          x: { type: 'number', description: "The point's x in the program's coordinates (metres)." },
          y: { type: 'number', description: 'Its y (metres).' },
          z: { type: 'number', description: 'Its z (metres).' },
          px: { type: 'number', description: 'Its pixel x in the picture (to the right).' },
          py: { type: 'number', description: 'Its pixel y in the picture (down).' },
        },
      },
    },
  },
} as const;

/** What the landmark prompt is built from: exactly what the surface prompt is (the caller builds one
 *  context and hands it to both), `viewpoint` being describeViewpoint's sentence — words, no numbers. */
export type TwinLandmarkPromptContext = TwinSurfacePromptContext;

/**
 * System + user text for one landmark call. Images attached by the caller, as for the surface call: the
 * picture the user text names first (the visible photo, or the render when the photo has none), then —
 * for a visible picture with `withRender` — the thermal render, which is only an aid for seeing edges.
 * The wording is the experiment's that worked (15–17 exact landmarks per house photo), plus the parts
 * list, the viewpoint in words (a camera number in the prompt gets copied into the answer), and the
 * warnings the fit needs: points spread over different depths, and corners of boxes rather than points
 * on organic shapes the program only approximates.
 */
export function buildTwinLandmarkPrompt(ctx: TwinLandmarkPromptContext): { system: string; user: string } {
  const picture = ctx.picture ?? 'vis';
  const withRender = picture === 'vis' && ctx.withRender !== false;
  const system = `You register a photograph to a 3D model of its subject. You are given ONE picture of the subject (${
    picture === 'vis'
      ? withRender
        ? 'a visible-light photo, followed by the thermal camera’s false-colour render of the same view'
        : 'a visible-light photo'
      : 'the thermal camera’s false-colour render'
  }), the list of the model's parts, the program that built the model, and roughly where the camera stood.

The program's coordinates are metres: x to the subject's right, y up, z toward its front. api.box(w, h, d, x, y, z) and part.box(w, h, d, x, y, z) make a box w wide (x), h tall (y) and d deep (z) whose BOTTOM face is centred at (x, y, z): it spans x−w/2…x+w/2, y…y+h, z−d/2…z+d/2. api.cylinder(r, h, x, y, z) and part.cylinder likewise stand on (x, y, z). A raw THREE.Mesh sits centred on its position, then rotated, inside its part's group: work its corners out from its geometry's size, its position and its rotation as the program gives them.

Pick 10 to 16 LANDMARKS: sharp, unambiguous points of the MODEL that the picture shows clearly — outer corners of walls at the ground and at the eaves, the apex of a gable, corners of a porch, a step or a roof edge, corners of large windows and doors; on an object, the corners of its boxes and the ends of its straight edges. Prefer corners of boxes; never a point on a tree, a hedge or any other organic shape. Spread them over the whole subject — left and right, high and low — and over DIFFERENT DEPTHS: not all on one wall, and never all on one line. For each give its position in the program's coordinates, computed exactly from the program's numbers (a box's corner, the tip of an extruded shape), and its pixel position in the picture. Skip any point hidden behind something (a tree, a car, a hedge, a person) or that you cannot place within a few pixels. Never give a point the program does not build.

Coordinates in the picture are PIXELS of the ${ctx.width}×${ctx.height} ${picture === 'vis' ? 'visible photo' : 'thermal render'}: x to the right, y down, (0, 0) the top-left corner.${
    withRender
      ? ' The thermal render is attached only to help you see edges; place every point on the visible photo.'
      : ''
  }

Answer with JSON only: { "landmarks": [ { "part": <the part it belongs to, a name from the list>, "what": <a few words>, "x": <m>, "y": <m>, "z": <m>, "px": <pixel x>, "py": <pixel y> } ] }. At most ${TWIN_LANDMARK_MAX} landmarks; an empty list when nothing of the subject is in view.`;
  const parts = ctx.parts.length
    ? ctx.parts.map((p) => `- ${p.name} — ${p.kind}${p.description ? ` — ${p.description}` : ''}`).join('\n')
    : '- (the program declares no named parts)';
  const code =
    ctx.code.length > TWIN_SURFACE_CODE_CHARS
      ? `${ctx.code.slice(0, TWIN_SURFACE_CODE_CHARS)}\n// … cut here: the rest of the program is omitted for length.`
      : ctx.code;
  const user = `Subject: ${ctx.subject || 'not named'}${ctx.subjectKind ? ` (${ctx.subjectKind})` : ''}.

Parts (name — kind — description):
${parts}

${ctx.label ?? `Photo ${ctx.photo}`}, ${ctx.width}×${ctx.height} px${
    picture === 'vis'
      ? withRender
        ? ' (the first picture); its thermal render is the second picture'
        : ' (the only picture)'
      : ' (the thermal render is the picture)'
  }.
Viewpoint: ${ctx.viewpoint}

The program that built the model:
\`\`\`javascript
${code}
\`\`\`

Give the landmarks, as JSON.`;
  return { system, user };
}

// ---------------------------------------------------------------------------------------------------
// Parsing

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A landmark's picture position may run past the picture by this fraction before it is dropped. */
export const LANDMARK_OVERSHOOT = 0.05;
/** A model coordinate beyond this (metres) is not a point of any model. */
const LANDMARK_MAX_COORD = 1e4;

/** Three numbers as an array or an {x, y, z} object, or null. */
function readTriple(v: unknown): number[] | null {
  if (Array.isArray(v)) return v.length >= 3 && isNum(v[0]) && isNum(v[1]) && isNum(v[2]) ? [v[0], v[1], v[2]] : null;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (isNum(o.x) && isNum(o.y) && isNum(o.z)) return [o.x, o.y, o.z];
  }
  return null;
}

/** Two numbers as an array or an {x, y} / {px, py} / {u, v} object, or null. */
function readPair(v: unknown): number[] | null {
  if (Array.isArray(v)) return v.length >= 2 && isNum(v[0]) && isNum(v[1]) ? [v[0], v[1]] : null;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (isNum(o.x) && isNum(o.y)) return [o.x, o.y];
    if (isNum(o.px) && isNum(o.py)) return [o.px, o.py];
    if (isNum(o.u) && isNum(o.v)) return [o.u, o.v];
  }
  return null;
}

/**
 * Parse a landmark answer into model points with their picture positions as fractions. Tolerant of the
 * shapes a provider without schema enforcement produces, like parseTwinSurfaces: a bare array, or the list
 * under `landmarks` / `points` / `correspondences`; the model point as `x`/`y`/`z` or a `world` / `position`
 * triple; the picture position as `px`/`py`, `u`/`v`, or a `pixel` / `image` pair. Pixels become fractions
 * by the picture size unless more than half of the entries have both their x and their y ≤ 1 +
 * LANDMARK_OVERSHOOT (one decision for the whole answer, by majority: a fractions answer with one point a
 * little past the picture's edge must not be read as pixels — every point would then crowd into the
 * picture's top-left pixel, and a camera kilometres away would "agree" with all of them — while no majority
 * of a real pixel answer can sit in that corner; the stragglers of the losing reading fall to the range
 * rule below). Dropped, with a reason in `errors`: an entry with no finite model point or picture
 * position, a coordinate past ±1e4 m, a position off the picture by more than LANDMARK_OVERSHOOT, a model
 * point that repeats an earlier one exactly (the first is kept); and everything past TWIN_LANDMARK_MAX. The
 * part is canonicalised against `parts` (the raw name, trimmed, when it matches none — a landmark on a
 * part the list lacks is still a point of the model); part and what are cut to 60 and 80 characters.
 * Model coordinates are rounded to the millimetre and positions to 1e-4, as the record stores them, so
 * the camera is fitted to exactly what the client reads back.
 */
export function parseTwinLandmarks(
  text: string,
  parts: TwinBuildingPart[],
  width: number,
  height: number,
): { landmarks: ParsedTwinLandmark[]; errors: string[] } {
  const errors: string[] = [];
  const json = extractJsonValue(text);
  if (!json) return { landmarks: [], errors: ['no JSON in the answer'] };
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { landmarks: [], errors: [`JSON.parse failed: ${(e as Error).message}`] };
  }
  let list: unknown[] | null = null;
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    for (const key of ['landmarks', 'points', 'correspondences']) {
      if (Array.isArray(raw[key])) {
        list = raw[key];
        break;
      }
    }
  }
  if (!list) return { landmarks: [], errors: ['the answer holds no landmark list'] };

  // First pass: what each entry says, in its own units.
  const read: { i: number; part: string; what: string; p: number[]; q: number[] }[] = [];
  list.forEach((item: any, i) => {
    if (!item || typeof item !== 'object') {
      errors.push(`landmarks[${i}] is not an object → dropped`);
      return;
    }
    const p =
      isNum(item.x) && isNum(item.y) && isNum(item.z)
        ? [item.x, item.y, item.z]
        : (readTriple(item.world) ?? readTriple(item.position));
    if (!p) {
      errors.push(`landmarks[${i}] has no finite model point → dropped`);
      return;
    }
    const q =
      isNum(item.px) && isNum(item.py)
        ? [item.px, item.py]
        : isNum(item.u) && isNum(item.v)
          ? [item.u, item.v]
          : (readPair(item.pixel) ?? readPair(item.image));
    if (!q) {
      errors.push(`landmarks[${i}] has no finite picture position → dropped`);
      return;
    }
    if (p.some((c) => Math.abs(c) > LANDMARK_MAX_COORD)) {
      errors.push(`landmarks[${i}] lies implausibly far out → dropped`);
      return;
    }
    const partName = str(item.part) || str(item.partName);
    const what = str(item.what) || str(item.label) || str(item.description) || str(item.name);
    read.push({ i, part: partName, what, p, q });
  });

  // Fractions already, or pixels — decided once for the whole answer, by the majority, with the same slack
  // the range rule allows. A pixel entry in a fractions answer then lies off the picture and is dropped; a
  // fraction in a pixel answer lands in the top-left corner, where the fit finds that it disagrees.
  const inUnit = read.filter((r) => r.q[0] <= 1 + LANDMARK_OVERSHOOT && r.q[1] <= 1 + LANDMARK_OVERSHOOT).length;
  const fractions = inUnit * 2 > read.length;
  const byKey = new Map(parts.map((p) => [normalizePartName(p.name), p]));
  const round3 = (v: number) => Math.round(v * 1000) / 1000;
  const round4 = (v: number) => Math.round(v * 10000) / 10000;
  const seen = new Map<string, number>();
  const landmarks: ParsedTwinLandmark[] = [];
  let pastCap = 0;
  for (const r of read) {
    const u = fractions ? r.q[0] : r.q[0] / width;
    const v = fractions ? r.q[1] : r.q[1] / height;
    if (
      !(
        u >= -LANDMARK_OVERSHOOT &&
        u <= 1 + LANDMARK_OVERSHOOT &&
        v >= -LANDMARK_OVERSHOOT &&
        v <= 1 + LANDMARK_OVERSHOOT
      )
    ) {
      errors.push(`landmarks[${r.i}] lies outside the picture → dropped`);
      continue;
    }
    const [x, y, z] = r.p.map(round3);
    const key = `${x},${y},${z}`;
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push(`landmarks[${r.i}] repeats the model point of landmarks[${first}] → dropped`);
      continue;
    }
    seen.set(key, r.i);
    if (landmarks.length >= TWIN_LANDMARK_MAX) {
      pastCap++;
      continue;
    }
    const canonical = byKey.get(normalizePartName(r.part));
    landmarks.push({
      part: (canonical ? canonical.name : r.part).slice(0, 60),
      what: r.what.slice(0, 80),
      x,
      y,
      z,
      u: round4(u),
      v: round4(v),
    });
  }
  if (pastCap) errors.push(`${pastCap} landmarks past the cap of ${TWIN_LANDMARK_MAX} → dropped`);
  return { landmarks, errors };
}

// ---------------------------------------------------------------------------------------------------
// Projection

const DEG = Math.PI / 180;

/**
 * Where a model point lands in a camera's picture: [u, v, depth] — u, v fractions of the picture (x
 * right, y DOWN), depth along the camera's view in metres. Only a positive depth is in front of the
 * camera; behind it u and v mean nothing. The one projection the fit, the tests and the client's mirror
 * (twinProjection.projectPoint) all agree on: the point relative to the camera is turned by Ry(−yaw),
 * then Rx(−pitch), then Rz(−roll) — R transposed.
 */
export function projectWithCamera(camera: TwinPhotoCamera, point: ArrayLike<number>): [number, number, number] {
  let x = point[0] - camera.position[0];
  let y = point[1] - camera.position[1];
  let z = point[2] - camera.position[2];
  let c = Math.cos(camera.yaw);
  let s = Math.sin(camera.yaw);
  [x, z] = [c * x - s * z, s * x + c * z];
  c = Math.cos(camera.pitch);
  s = Math.sin(camera.pitch);
  [y, z] = [c * y + s * z, -s * y + c * z];
  c = Math.cos(camera.roll);
  s = Math.sin(camera.roll);
  [x, y] = [c * x + s * y, -s * x + c * y];
  const depth = -z;
  const f = 0.5 / Math.tan((camera.fovV * DEG) / 2);
  return [(camera.aspect / 2 + (f * x) / depth) / camera.aspect, 0.5 - (f * y) / depth, depth];
}

// ---------------------------------------------------------------------------------------------------
// The camera fit

/** The vertical field of view the focal prior is centred on (degrees): a phone camera's. */
export const CAMERA_PRIOR_FOV_V = 50;
/** A landmark agrees with a camera when it reprojects within this fraction of the picture height. */
export const CAMERA_INLIER_TOL = 0.03;
/** A camera must agree with at least this many landmarks, and with at least this share of them. */
export const CAMERA_MIN_INLIERS = 6;
export const CAMERA_MIN_INLIER_SHARE = 0.45;
/** …and reproject those within this RMS (fraction of the picture height). */
export const CAMERA_MAX_RMS = 0.025;
/** …whose observed positions span at least this fraction of the picture height across or down: landmarks
 *  bunched in one spot pin down only the direction toward them. */
export const CAMERA_MIN_SPAN = 0.1;
/** …and with no more than this share of ALL the landmarks behind it (one alone always passes). */
export const CAMERA_MAX_BEHIND_SHARE = 0.25;
/** RANSAC hypotheses: the first this many of the landmarks' 4-subsets, deterministically shuffled. */
export const CAMERA_RANSAC_SAMPLES = 120;

/** One sigma of any prior weighs as much as 2 % of the picture height of reprojection error. */
const PRIOR_WEIGHT = 0.02;
/** The priors' sigmas: the focal (log-scale, so ±8 %), the roll, and the camera's height around the
 *  standpoint phase 1 judged (at least 1.5 m, or a quarter of the landmarks' extent). */
const FOCAL_SIGMA = 0.08;
const ROLL_SIGMA = 6 * DEG;
const HEIGHT_SIGMA_MIN = 1.5;
const HEIGHT_SIGMA_SHARE = 0.25;
/** The camera's azimuth about the subject is free within 40° of the side phase 1 judged; past that each
 *  further 20° costs one sigma. The judged side is reliable, the exact angle is not. */
const AZIMUTH_FREE = 40 * DEG;
const AZIMUTH_SIGMA = 20 * DEG;
/** …unless the judged view looks up or down more steeply than this: its ground direction is then noise
 *  (phase 1 judged a laptop's photo 2 as looking at the ceiling, and that view's horizontal direction
 *  points nearly opposite the side the photo was taken from), so the azimuth prior is dropped and only the
 *  height prior is kept. Held, a reversed side drags a camera that looks down on a flattish subject round
 *  it along the pose's soft direction (a synthetic desk: 7° of yaw and 9 % of the distance off). */
const AZIMUTH_MAX_ELEVATION = 60 * DEG;
/** A landmark at a depth below this share of the landmarks' extent (or behind the camera) costs a flat
 *  penalty per coordinate, which keeps the solver from parking points behind the camera; and it never
 *  counts as agreeing. No photo shows a corner of its subject a hundredth of the subject's size from the
 *  lens, while a point that close projects wherever the solver likes — left in, it lets a pose parked
 *  on one landmark win RANSAC with that landmark "agreeing". */
const MIN_DEPTH_SHARE = 0.01;
const BEHIND_PENALTY = 10;
/** Levenberg–Marquardt iterations for a RANSAC hypothesis, and for a fit to a consensus. */
const LM_ITERS_SAMPLE = 40;
const LM_ITERS_FULL = 100;
/** Elevations (radians) of the look-at starts around the landmarks: nearly level, and from above. */
const START_ELEVATIONS = [0.1, 0.45];

/** The pose vector the solver moves: camera x, y, z, yaw, pitch, roll, and the focal's log-scale about
 *  the prior's (focal = f0 · exp(s)). */
const NP = 7;
/** Residual rows after the landmarks' two each: focal, roll, height, azimuth (0 when unused). */
const PRIOR_ROWS = 4;

/** A landmark as the fit reads it: a model point and where the picture shows it (fractions, v down). */
export interface CameraLandmark {
  x: number;
  y: number;
  z: number;
  u: number;
  v: number;
}

/** Where phase 1 judged the camera stood and what it looked at (the photo's view), in model metres. */
export interface CameraHint {
  position: ArrayLike<number>;
  target: ArrayLike<number>;
}

export interface CameraFitOptions {
  /** The vertical field of view the focal prior is centred on, degrees (default CAMERA_PRIOR_FOV_V). */
  fovV?: number;
  /** How far (radians) the camera's side may turn from the hint's for free, and the sigma beyond that
   *  (defaults AZIMUTH_FREE, AZIMUTH_SIGMA); without effect when the hint looks past AZIMUTH_MAX_ELEVATION
   *  up or down, since it then has no side. */
  azimuthFree?: number;
  azimuthSigma?: number;
}

/** fitPhotoCamera's answer. `inliers` are the flags the photo's landmarks are stored with (false
 *  everywhere when there is no camera); `agreeing` and `rms` describe the best pose found whether or not
 *  the gates passed it (for the logs: a refused fit still says how close it came), rms null when no pose
 *  was fitted at all. */
export interface CameraFit {
  camera: TwinPhotoCamera | null;
  inliers: boolean[];
  reason: string | null;
  agreeing: number;
  rms: number | null;
}

/** Everything one fit shares: the landmarks in flat arrays, the priors, and scratch buffers sized for the
 *  whole landmark set, so a Levenberg–Marquardt run allocates nothing. */
interface FitProblem {
  pts: Float64Array; // model points, x y z per landmark
  obs: Float64Array; // where the picture shows them, in picture heights: u·aspect, v
  aspect: number;
  f0: number; // the prior's focal, in picture heights
  minDepth: number;
  hint: {
    position: number[];
    target: number[];
    heightSigma: number;
    // The ground direction from the target toward the standpoint (unit), when it has one, and how far the
    // camera may turn from it for free / the sigma beyond (radians).
    azimuth: { hx: number; hz: number; free: number; sigma: number } | null;
  } | null;
  r: Float64Array;
  rTry: Float64Array;
  J: Float64Array; // row-major, NP per row
  A: Float64Array; // JᵀJ, NP × NP
  g: Float64Array; // Jᵀr
  aug: Float64Array; // the damped system, NP × (NP + 1)
  step: Float64Array;
  qTry: Float64Array;
  trial: Float64Array; // one start's end pose, in fitFromStarts
}

/**
 * The residuals of pose `q` on the landmarks idx[0..m) — two rows each, the reprojection error in picture
 * heights — then the PRIOR_ROWS prior rows, each scaled so one sigma costs PRIOR_WEIGHT; with `J`, their
 * Jacobian too (analytic). Returns the cost Σr². The projection is projectWithCamera's, spelled out step
 * by step so each step's derivative can be read off it.
 */
function evaluate(
  pb: FitProblem,
  q: Float64Array,
  idx: ArrayLike<number>,
  m: number,
  r: Float64Array,
  J: Float64Array | null,
): number {
  const camX = q[0];
  const camY = q[1];
  const camZ = q[2];
  const yaw = q[3];
  const pitch = q[4];
  const roll = q[5];
  const f = pb.f0 * Math.exp(q[6]);
  const cY = Math.cos(yaw);
  const sY = Math.sin(yaw);
  const cP = Math.cos(pitch);
  const sP = Math.sin(pitch);
  const cR = Math.cos(roll);
  const sR = Math.sin(roll);
  // R transposed (world → camera), for the position's derivatives: ∂p/∂c = −Rᵀ.
  const m00 = cR * cY + sR * sP * sY;
  const m01 = sR * cP;
  const m02 = -cR * sY + sR * sP * cY;
  const m10 = -sR * cY + cR * sP * sY;
  const m11 = cR * cP;
  const m12 = sR * sY + cR * sP * cY;
  const m20 = cP * sY;
  const m21 = -sP;
  const m22 = cP * cY;
  const half = pb.aspect / 2;
  let cost = 0;
  for (let k = 0; k < m; k++) {
    const i = idx[k];
    const row = 2 * k;
    const dx = pb.pts[3 * i] - camX;
    const dy = pb.pts[3 * i + 1] - camY;
    const dz = pb.pts[3 * i + 2] - camZ;
    // Ry(−yaw), then Rx(−pitch), then Rz(−roll).
    const x1 = cY * dx - sY * dz;
    const z1 = sY * dx + cY * dz;
    const y2 = cP * dy + sP * z1;
    const z2 = -sP * dy + cP * z1;
    const x3 = cR * x1 + sR * y2;
    const y3 = -sR * x1 + cR * y2;
    const depth = -z2;
    if (depth <= pb.minDepth) {
      r[row] = BEHIND_PENALTY;
      r[row + 1] = BEHIND_PENALTY;
      cost += 2 * BEHIND_PENALTY * BEHIND_PENALTY;
      if (J) J.fill(0, row * NP, (row + 2) * NP);
      continue;
    }
    const inv = 1 / depth;
    const xn = x3 * inv;
    const yn = y3 * inv;
    const ru = half + f * xn - pb.obs[2 * i];
    const rv = 0.5 - f * yn - pb.obs[2 * i + 1];
    r[row] = ru;
    r[row + 1] = rv;
    cost += ru * ru + rv * rv;
    if (!J) continue;
    // A change δ of the camera-space point moves u by f/d·(δx + xn·δz) and v by −f/d·(δy + yn·δz).
    const fi = f * inv;
    const ju = row * NP;
    const jv = ju + NP;
    // ∂/∂position: δ = −(column of Rᵀ).
    J[ju] = -fi * (m00 + xn * m20);
    J[jv] = fi * (m10 + yn * m20);
    J[ju + 1] = -fi * (m01 + xn * m21);
    J[jv + 1] = fi * (m11 + yn * m21);
    J[ju + 2] = -fi * (m02 + xn * m22);
    J[jv + 2] = fi * (m12 + yn * m22);
    // ∂/∂yaw: Ry's derivative turns (x1, z1) into (−z1, x1), then Rx and Rz carry it on.
    const yx = -cR * z1 + sR * sP * x1;
    const yy = sR * z1 + cR * sP * x1;
    const yz = cP * x1;
    J[ju + 3] = fi * (yx + xn * yz);
    J[jv + 3] = -fi * (yy + yn * yz);
    // ∂/∂pitch: (y2, z2) becomes (z2, −y2), then Rz.
    J[ju + 4] = fi * (sR * z2 - xn * y2);
    J[jv + 4] = -fi * (cR * z2 - yn * y2);
    // ∂/∂roll: (x3, y3) becomes (y3, −x3); the depth does not move.
    J[ju + 5] = fi * y3;
    J[jv + 5] = fi * x3;
    // ∂/∂s: the focal scales both offsets from the centre.
    J[ju + 6] = f * xn;
    J[jv + 6] = -f * yn;
  }
  const row = 2 * m;
  if (J) J.fill(0, row * NP, (row + PRIOR_ROWS) * NP);
  r[row] = (q[6] / FOCAL_SIGMA) * PRIOR_WEIGHT;
  r[row + 1] = (roll / ROLL_SIGMA) * PRIOR_WEIGHT;
  r[row + 2] = 0;
  r[row + 3] = 0;
  if (J) {
    J[row * NP + 6] = PRIOR_WEIGHT / FOCAL_SIGMA;
    J[(row + 1) * NP + 5] = PRIOR_WEIGHT / ROLL_SIGMA;
  }
  const hint = pb.hint;
  if (hint) {
    r[row + 2] = ((camY - hint.position[1]) / hint.heightSigma) * PRIOR_WEIGHT;
    if (J) J[(row + 2) * NP + 1] = PRIOR_WEIGHT / hint.heightSigma;
    if (hint.azimuth) {
      // The camera's own backward direction on the ground (from the subject toward the camera) against the
      // judged one; the angle between them grows at unit rate with the yaw, on the side the cross says.
      const { hx, hz, free, sigma } = hint.azimuth;
      const bx = sY;
      const bz = cY;
      const angle = Math.acos(Math.max(-1, Math.min(1, bx * hx + bz * hz)));
      const excess = Math.max(0, angle - free);
      r[row + 3] = (excess / sigma) * PRIOR_WEIGHT;
      if (J && excess > 0) J[(row + 3) * NP + 3] = (Math.sign(bx * hz - bz * hx) * PRIOR_WEIGHT) / sigma;
    }
  }
  for (let k = row; k < row + PRIOR_ROWS; k++) cost += r[k] * r[k];
  return cost;
}

/** Solve the NP × NP system in `aug` (augmented with its right-hand side) by Gaussian elimination with
 *  partial pivoting, into `out`. A vanishing pivot is floored, not refused: the damping keeps it rare. */
function solveInto(aug: Float64Array, out: Float64Array): void {
  const w = NP + 1;
  for (let i = 0; i < NP; i++) {
    let piv = i;
    for (let j = i + 1; j < NP; j++) if (Math.abs(aug[j * w + i]) > Math.abs(aug[piv * w + i])) piv = j;
    if (piv !== i) {
      for (let k = 0; k < w; k++) {
        const t = aug[i * w + k];
        aug[i * w + k] = aug[piv * w + k];
        aug[piv * w + k] = t;
      }
    }
    if (Math.abs(aug[i * w + i]) < 1e-15) aug[i * w + i] = 1e-15;
    for (let j = i + 1; j < NP; j++) {
      const factor = aug[j * w + i] / aug[i * w + i];
      if (factor === 0) continue;
      for (let k = i; k < w; k++) aug[j * w + k] -= factor * aug[i * w + k];
    }
  }
  for (let i = NP - 1; i >= 0; i--) {
    let s = aug[i * w + NP];
    for (let k = i + 1; k < NP; k++) s -= aug[i * w + k] * out[k];
    out[i] = s / aug[i * w + i];
  }
}

/**
 * Levenberg–Marquardt from `start` on the landmarks idx[0..m), the pose left in `q`; returns its cost.
 * The damping is the prototype's: λ starts at 1e−3, a step that lowers the cost is taken and divides λ by
 * 3, one that does not multiplies it by 4 (ten tries per iteration); the run ends when no try helps or
 * the cost stops falling (relative gain below 1e−9).
 */
function levenberg(
  pb: FitProblem,
  idx: ArrayLike<number>,
  m: number,
  start: ArrayLike<number>,
  iters: number,
  q: Float64Array,
): number {
  const rows = 2 * m + PRIOR_ROWS;
  const { r, rTry, J, A, g, aug, step, qTry } = pb;
  q.set(start);
  let cost = evaluate(pb, q, idx, m, r, J);
  let lambda = 1e-3;
  for (let it = 0; it < iters; it++) {
    A.fill(0);
    g.fill(0);
    for (let row = 0; row < rows; row++) {
      const o = row * NP;
      const rr = r[row];
      for (let a = 0; a < NP; a++) {
        const ja = J[o + a];
        if (ja === 0) continue;
        g[a] += ja * rr;
        for (let b = a; b < NP; b++) A[a * NP + b] += ja * J[o + b];
      }
    }
    for (let a = 0; a < NP; a++) for (let b = 0; b < a; b++) A[a * NP + b] = A[b * NP + a];
    let accepted = false;
    let gain = 0;
    for (let tries = 0; tries < 10 && !accepted; tries++) {
      for (let a = 0; a < NP; a++) {
        for (let b = 0; b < NP; b++) {
          const v = A[a * NP + b];
          aug[a * (NP + 1) + b] = a === b ? v * (1 + lambda) + 1e-12 : v;
        }
        aug[a * (NP + 1) + NP] = -g[a];
      }
      solveInto(aug, step);
      for (let k = 0; k < NP; k++) qTry[k] = q[k] + step[k];
      const next = evaluate(pb, qTry, idx, m, rTry, null);
      if (next < cost) {
        gain = (cost - next) / cost;
        q.set(qTry);
        cost = next;
        lambda = Math.max(1e-12, lambda / 3);
        accepted = true;
      } else {
        lambda *= 4;
      }
    }
    if (!accepted || gain < 1e-9) break;
    evaluate(pb, q, idx, m, r, J);
  }
  return cost;
}

/** The look-at pose from `c` toward `target`: roll 0, the prior's focal. */
function lookAt(c: ArrayLike<number>, target: ArrayLike<number>): Float64Array {
  const dx = c[0] - target[0];
  const dy = c[1] - target[1];
  const dz = c[2] - target[2];
  return Float64Array.of(c[0], c[1], c[2], Math.atan2(dx, dz), -Math.atan2(dy, Math.hypot(dx, dz)), 0, 0);
}

/**
 * Where the solver starts on the landmarks idx[0..m): the judged view's own look-at pose (with a hint),
 * then look-at poses toward the landmarks' centroid every 45° of azimuth (from the judged side round) at
 * two elevations, at the distance where the landmarks' 3D spread matches their spread in the picture.
 */
function startPoses(pb: FitProblem, idx: ArrayLike<number>, m: number): Float64Array[] {
  const G = [0, 0, 0];
  let gu = 0;
  let gv = 0;
  for (let k = 0; k < m; k++) {
    const i = idx[k];
    for (let a = 0; a < 3; a++) G[a] += pb.pts[3 * i + a] / m;
    gu += pb.obs[2 * i] / m;
    gv += pb.obs[2 * i + 1] / m;
  }
  let s3 = 0;
  let s2 = 0;
  for (let k = 0; k < m; k++) {
    const i = idx[k];
    s3 += (pb.pts[3 * i] - G[0]) ** 2 + (pb.pts[3 * i + 1] - G[1]) ** 2 + (pb.pts[3 * i + 2] - G[2]) ** 2;
    s2 += (pb.obs[2 * i] - gu) ** 2 + (pb.obs[2 * i + 1] - gv) ** 2;
  }
  s3 = Math.sqrt(s3 / m) || 1;
  s2 = Math.sqrt(s2 / m) || 0.2;
  const distance = (pb.f0 * s3) / s2;
  const out: Float64Array[] = [];
  const hint = pb.hint;
  if (hint) out.push(lookAt(hint.position, hint.target));
  const az0 = hint ? Math.atan2(hint.position[0] - hint.target[0], hint.position[2] - hint.target[2]) : 0;
  for (let k = 0; k < 8; k++) {
    const az = az0 + (k * Math.PI) / 4;
    for (const el of START_ELEVATIONS) {
      const dir = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
      out.push(lookAt([G[0] + dir[0] * distance, G[1] + dir[1] * distance, G[2] + dir[2] * distance], G));
    }
  }
  return out;
}

/** The lowest-cost pose Levenberg–Marquardt reaches from any of `starts` (the first wins a tie), into `q`. */
function fitFromStarts(
  pb: FitProblem,
  idx: ArrayLike<number>,
  m: number,
  starts: ArrayLike<number>[],
  iters: number,
  q: Float64Array,
): number {
  let best = Infinity;
  starts.forEach((s, k) => {
    const cost = levenberg(pb, idx, m, s, iters, pb.trial);
    if (k === 0 || cost < best) {
      best = cost;
      q.set(pb.trial);
    }
  });
  return best;
}

/** Pose `q` as a camera (unrounded), for projectWithCamera. */
function poseCamera(pb: FitProblem, q: ArrayLike<number>): TwinPhotoCamera {
  return {
    position: [q[0], q[1], q[2]],
    yaw: q[3],
    pitch: q[4],
    roll: q[5],
    fovV: (2 * Math.atan(0.5 / (pb.f0 * Math.exp(q[6])))) / DEG,
    aspect: pb.aspect,
    rms: 0,
    inliers: 0,
  };
}

/** Each landmark's reprojection error under `camera`, in picture heights (99 behind the camera, or nearer
 *  to it than `minDepth` — see MIN_DEPTH_SHARE). */
function reprojectionErrors(
  landmarks: readonly CameraLandmark[],
  camera: TwinPhotoCamera,
  minDepth: number,
  out: Float64Array,
): void {
  landmarks.forEach((l, k) => {
    const [u, v, depth] = projectWithCamera(camera, [l.x, l.y, l.z]);
    out[k] = depth > minDepth ? Math.hypot((u - l.u) * camera.aspect, v - l.v) : 99;
  });
}

/** The landmarks within the inlier tolerance of pose errors `e`, and their RMS (0 when there are none). */
function consensus(e: Float64Array): { inliers: number[]; rms: number } {
  const inliers: number[] = [];
  let sum = 0;
  for (let k = 0; k < e.length; k++) {
    if (e[k] < CAMERA_INLIER_TOL) {
      inliers.push(k);
      sum += e[k] * e[k];
    }
  }
  return { inliers, rms: Math.sqrt(sum / Math.max(1, inliers.length)) };
}

/** Every 4-subset of n landmarks, shuffled by the prototype's generator (a fixed seed, so a photo's fit
 *  is the same every time; the arithmetic is plain doubles, so it is the same in every JS engine). */
function shuffledQuadruples(n: number): number[][] {
  const combos: number[][] = [];
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) combos.push([a, b, c, d]);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = combos.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [combos[i], combos[j]] = [combos[j], combos[i]];
  }
  return combos;
}

const finite3 = (v: ArrayLike<number> | null | undefined): v is ArrayLike<number> =>
  !!v && v.length >= 3 && isNum(v[0]) && isNum(v[1]) && isNum(v[2]);

/**
 * Fit the camera of one photo to its landmarks (plan §18.8): a pinhole camera — position, yaw, pitch,
 * roll, and a focal length that may move ±8 % from `opts.fovV` — under priors (a roll of ±6°, and with a
 * `hint` — the view phase 1 judged — the camera's height ±max(1.5 m, a quarter of the landmarks' extent)
 * and its azimuth free within 40° of the judged side, unless the view looks more than 60° up or down and so
 * has no side). `aspect` is the picture's width / height. The caller fits no photo without a hint (index.ts,
 * photoCameraFields): nothing else ties the camera to a side, and a wrong one can fit about as well.
 *
 * RANSAC finds the landmarks that agree: every 4-subset (deterministically shuffled, the first
 * CAMERA_RANSAC_SAMPLES) is fitted and the pose that brings the most landmarks within CAMERA_INLIER_TOL
 * (the lower RMS breaking a tie) wins; the consensus is then refitted from every start, and twice more
 * the inliers are re-collected and refitted. The search is the experiment's, start for start and sample
 * for sample — it gives the same cameras on the same answers — at a tenth of its cost (100–200 ms for 16
 * landmarks rather than 1–1.7 s): an analytic Jacobian, and scratch buffers that a Levenberg–Marquardt run
 * never allocates in.
 *
 * No camera, with the reason: fewer than CAMERA_MIN_INLIERS landmarks; no 4-subset that four landmarks
 * agree with; fewer than max(CAMERA_MIN_INLIERS, 45 % of the landmarks) agreeing; an inlier RMS over
 * CAMERA_MAX_RMS; inliers that span less than CAMERA_MIN_SPAN of the picture height both across and down
 * (bunched in one spot, they fix the direction toward the subject but not its distance); a non-finite pose
 * ("implausible camera"); or a camera with more than max(1, ⌊CAMERA_MAX_BEHIND_SHARE · n⌋) of all n
 * landmarks behind it ("implausible camera: k of n landmarks fall behind it" — every landmark was seen in
 * the picture, so each must lie in front of its camera; the inliers cannot show this, being in front by
 * definition, so it is counted over them all). The camera is rounded as the record stores it (position to
 * the millimetre, angles to 1e−4 rad — yaw and roll wrapped into (−π, π] — the field of view to 0.01°), and
 * its inliers, RMS and gates are those of the rounded camera through projectWithCamera, so the flags agree
 * with what the client recomputes.
 */
export function fitPhotoCamera(
  landmarks: readonly CameraLandmark[],
  aspect: number,
  hint: CameraHint | null,
  opts: CameraFitOptions = {},
): CameraFit {
  const n = landmarks.length;
  const refuse = (reason: string, agreeing = 0, rms: number | null = null): CameraFit => ({
    camera: null,
    inliers: new Array<boolean>(n).fill(false),
    reason,
    agreeing,
    rms,
  });
  if (n < CAMERA_MIN_INLIERS) return refuse(`too few landmarks (${n})`);
  if (!isNum(aspect) || aspect <= 0 || landmarks.some((l) => ![l.x, l.y, l.z, l.u, l.v].every(isNum)))
    return refuse('implausible camera');

  const pts = new Float64Array(3 * n);
  const obs = new Float64Array(2 * n);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  landmarks.forEach((l, k) => {
    [l.x, l.y, l.z].forEach((c, a) => {
      pts[3 * k + a] = c;
      lo[a] = Math.min(lo[a], c);
      hi[a] = Math.max(hi[a], c);
    });
    obs[2 * k] = l.u * aspect;
    obs[2 * k + 1] = l.v;
  });
  // The landmarks' largest extent sets the scale of the depth guard and of the height prior.
  const scale = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 0.1);
  const fovPrior = isNum(opts.fovV) && opts.fovV > 1 && opts.fovV < 170 ? opts.fovV : CAMERA_PRIOR_FOV_V;
  const f0 = 0.5 / Math.tan((fovPrior * DEG) / 2);
  let hintInfo: FitProblem['hint'] = null;
  if (hint && finite3(hint.position) && finite3(hint.target)) {
    const position = [hint.position[0], hint.position[1], hint.position[2]];
    const target = [hint.target[0], hint.target[1], hint.target[2]];
    const hx = position[0] - target[0];
    const hz = position[2] - target[2];
    const len = Math.hypot(hx, hz);
    // A view that looks steeply up or down has no side to hold the camera to: only its height counts.
    const steep = Math.abs(Math.atan2(position[1] - target[1], len)) > AZIMUTH_MAX_ELEVATION;
    hintInfo = {
      position,
      target,
      heightSigma: Math.max(HEIGHT_SIGMA_MIN, HEIGHT_SIGMA_SHARE * scale),
      azimuth:
        len > 1e-6 && !steep
          ? {
              hx: hx / len,
              hz: hz / len,
              free: isNum(opts.azimuthFree) && opts.azimuthFree >= 0 ? opts.azimuthFree : AZIMUTH_FREE,
              sigma: isNum(opts.azimuthSigma) && opts.azimuthSigma > 0 ? opts.azimuthSigma : AZIMUTH_SIGMA,
            }
          : null,
    };
  }
  const rows = 2 * n + PRIOR_ROWS;
  const pb: FitProblem = {
    pts,
    obs,
    aspect,
    f0,
    minDepth: MIN_DEPTH_SHARE * scale,
    hint: hintInfo,
    r: new Float64Array(rows),
    rTry: new Float64Array(rows),
    J: new Float64Array(rows * NP),
    A: new Float64Array(NP * NP),
    g: new Float64Array(NP),
    aug: new Float64Array(NP * (NP + 1)),
    step: new Float64Array(NP),
    qTry: new Float64Array(NP),
    trial: new Float64Array(NP),
  };

  // RANSAC: each 4-landmark hypothesis is fitted from every start (four points pin a pose down, but which of
  // its few solutions LM lands in depends on where it starts), and scored on all the landmarks.
  const q = new Float64Array(NP);
  const errors = new Float64Array(n);
  let best: number[] = [];
  let bestRms = Infinity;
  for (const sample of shuffledQuadruples(n).slice(0, CAMERA_RANSAC_SAMPLES)) {
    fitFromStarts(pb, sample, 4, startPoses(pb, sample, 4), LM_ITERS_SAMPLE, q);
    reprojectionErrors(landmarks, poseCamera(pb, q), pb.minDepth, errors);
    const { inliers, rms } = consensus(errors);
    if (inliers.length > best.length || (inliers.length === best.length && rms < bestRms)) {
      best = inliers;
      bestRms = rms;
    }
  }
  if (best.length < 4) return refuse('no consistent subset');

  // The consensus, fitted from every start; then twice: re-collect the inliers, refit.
  fitFromStarts(pb, best, best.length, startPoses(pb, best, best.length), LM_ITERS_FULL, q);
  for (let round = 0; round < 2; round++) {
    reprojectionErrors(landmarks, poseCamera(pb, q), pb.minDepth, errors);
    const { inliers } = consensus(errors);
    if (inliers.length < 4) break;
    best = inliers;
    fitFromStarts(pb, best, best.length, startPoses(pb, best, best.length), LM_ITERS_FULL, q);
  }

  if (!Array.from(q).every(isNum)) return refuse('implausible camera');
  const round = (v: number, per: number) => Math.round(v * per) / per;
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const fitted = poseCamera(pb, q);
  const camera: TwinPhotoCamera = {
    position: fitted.position.map((c) => round(c, 1000)),
    yaw: round(wrap(fitted.yaw), 1e4),
    pitch: round(wrap(fitted.pitch), 1e4),
    roll: round(wrap(fitted.roll), 1e4),
    fovV: round(fitted.fovV, 100),
    aspect: round(aspect, 1e4),
    rms: 0,
    inliers: 0,
  };
  // The verdict is the stored camera's own, so the flags agree with what the client recomputes.
  reprojectionErrors(landmarks, camera, pb.minDepth, errors);
  const flags = Array.from(errors, (e) => e < CAMERA_INLIER_TOL);
  const agreeing = flags.filter(Boolean).length;
  const rms = consensus(errors).rms;
  if (!isNum(rms)) return refuse('implausible camera');
  if (agreeing < Math.max(CAMERA_MIN_INLIERS, Math.ceil(CAMERA_MIN_INLIER_SHARE * n)))
    return refuse(`only ${agreeing} of ${n} landmarks agree`, agreeing, rms);
  if (rms > CAMERA_MAX_RMS)
    return refuse(`the landmarks disagree with the model by ${(rms * 100).toFixed(1)} % of the picture`, agreeing, rms);
  // Inliers bunched in one spot of the picture say in which direction the subject lies, not how far: a
  // camera anywhere along that line reprojects them all (an answer misread as pixels, or every point put on
  // one pixel, "fits" a camera kilometres away with every landmark agreeing and next to no error).
  const span = [Infinity, -Infinity, Infinity, -Infinity];
  flags.forEach((ok, k) => {
    if (!ok) return;
    span[0] = Math.min(span[0], obs[2 * k]);
    span[1] = Math.max(span[1], obs[2 * k]);
    span[2] = Math.min(span[2], obs[2 * k + 1]);
    span[3] = Math.max(span[3], obs[2 * k + 1]);
  });
  if (span[1] - span[0] < CAMERA_MIN_SPAN && span[3] - span[2] < CAMERA_MIN_SPAN)
    return refuse('the landmarks cover too little of the picture', agreeing, rms);
  // Every landmark was seen in the picture, so each lies in front of the camera that took it: a pose with
  // more than a few of ALL the landmarks behind it is a wrong solution. (Its inliers alone can never say
  // so — each lies in front of it by definition.)
  const behind = landmarks.filter((l) => projectWithCamera(camera, [l.x, l.y, l.z])[2] <= pb.minDepth).length;
  if (behind > Math.max(1, Math.floor(CAMERA_MAX_BEHIND_SHARE * n)))
    return refuse(`implausible camera: ${behind} of ${n} landmarks fall behind it`, agreeing, rms);
  return {
    camera: { ...camera, rms: round(rms, 1e4), inliers: agreeing },
    inliers: flags,
    reason: null,
    agreeing,
    rms,
  };
}
