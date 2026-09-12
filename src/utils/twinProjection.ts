/**
 * The thermal photos projected onto a scene twin (docs/digital-twin-plan.md §18.8). The tracing model
 * outlines a small clean patch of each surface, for a clean median; a face painted from that patch alone
 * loses everything around it — the attic window's hot spot, the gable, the porch roof. So every thermal
 * photo is REGISTERED to the model instead: the server fits a pinhole camera to the 2D–3D landmarks a
 * second model call names in the picture (functions/src/twinCamera.ts), and the viewer frame projects
 * the photo's own thermal pixels onto whatever that camera sees squarely of the model, with a depth test
 * per photo (twinFrame.ts); seen at a steep slant the pixels fade into the face's value. What no
 * registered photo sees keeps the table's one value per face (twinSceneThermal.ts); a photo whose fit
 * was rejected is simply not projected.
 *
 * This module is the client's half of that contract: the camera convention, the sky mask a frame gets
 * before it is projected, the `photos` message the frame is sent, the view that looks from a photo's
 * camera, and what the panel says about the registration. Pure (no React, no three.js), unit-tested
 * (twinProjection.test.ts).
 *
 * The camera convention — identical in the server's fit, here and in the frame: the camera's world
 * rotation is R = Ry(yaw)·Rx(pitch)·Rz(roll) (three.js Euler(pitch, yaw, roll, 'YXZ')) and it looks along
 * its local −z with +y up. With the focal f = 0.5 / tan(fovV / 2) in picture heights, a camera-space point
 * (x, y, z) at depth d = −z > 0 lands at u = (aspect / 2 + f·x / d) / aspect, v = 0.5 − f·y / d —
 * fractions of the picture, v down. The picture is the one the landmarks were placed on: the visible
 * photo when the photo has one (`picture` 'vis'), else the thermal render. A picture point (u, v) reads
 * the thermal pixel (u·120 + dx, v·160 + dy), (dx, dy) being the photo's visible→thermal registration
 * when the picture is the visible photo and one was measured, else (0, 0) — the convention the server's
 * readSurfaceStats reads the traced quads with.
 */
import type { TwinBuildingThermal, TwinPhotoCamera, TwinThermalPhoto } from '../types';

const DEG = Math.PI / 180;

/** The thermal grid every photo's frame is: 120 × 160 pixels, row-major from the top-left corner. */
export const THERMAL_W = 120;
export const THERMAL_H = 160;

/** How many photos the frame projects at once (its shader holds eight) — as many as a twin is built from. */
export const TWIN_PROJECTION_MAX = 8;

/** Readings below this are outside the FLIR One's range — sky, or nothing — never a surface (the
 *  server's SURFACE_MIN_VALID_C). */
const MIN_VALID_C = -20;
/** The truncated-frame sentinel: a zero record reads −273.15 °C (the server's SURFACE_SENTINEL_C). */
const SENTINEL_C = -100;
/** How much colder than the coldest traced surface a pixel must be to be taken for sky, K. */
const SKY_MARGIN_K = 8;
/** How far a Look-from view aims when the scene's size is not known yet, metres. */
const DEFAULT_LOOK_DISTANCE = 10;

type Vec3 = [number, number, number];

/** The word for one picture: a set's photo, or a frame of a walk-around recording. */
export type TwinShot = 'photo' | 'frame';

// ---------------------------------------------------------------------------------------------------
// Frame messages (twinFrame.ts reads these; the shapes of `built` and `paint` are in twinSceneThermal.ts).

/** One registered photo as the frame projects it: its camera, the registration that carries a picture
 *  point onto the thermal grid, and the grid itself in °C with NaN wherever it must not be projected
 *  (an unreadable pixel, the sky — see maskTemps). */
export interface TwinProjectionPhoto {
  photo: number; // the stored photo number (a set's photo, a recording's frame index)
  label: string; // 'photo 3' / 'frame 34', for the probe
  position: Vec3; // the camera, metres
  yaw: number; // radians, three.js Euler order 'YXZ'
  pitch: number;
  roll: number;
  fovV: number; // vertical field of view, degrees
  aspect: number; // picture width / height
  dx: number; // thermal px added to a picture point's grid position (u·120, v·160)
  dy: number;
  w: 120;
  h: 160;
  temps: Float32Array; // w·h values, °C, row-major; NaN = unusable
}

/** Replaces the frame's projected photos; `photos: []` switches projection off. */
export interface TwinPhotosMessage {
  type: 'photos';
  photos: TwinProjectionPhoto[];
}

/** Look from a standpoint; `fov` (vertical, degrees) matches a photo's lens, and 'overview' undoes it. */
export interface TwinViewMessage {
  type: 'view';
  x: number;
  y: number;
  z: number;
  targetX: number;
  targetY: number;
  targetZ: number;
  fov?: number;
}

// ---------------------------------------------------------------------------------------------------
// The camera.

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A record's camera copied field by field, or null when it is not one the frame can render from:
 *  every number finite, a three-number position, a field of view of 1–170° and an aspect of 0.2–5 (a
 *  photo is neither a slit nor a banner). A record is written by the server, but the viewer must not
 *  put a malformed camera into a shader. */
export function validCamera(c: unknown): TwinPhotoCamera | null {
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  const p = o.position;
  if (!Array.isArray(p) || p.length !== 3 || !p.every(finite)) return null;
  if (
    !finite(o.yaw) ||
    !finite(o.pitch) ||
    !finite(o.roll) ||
    !finite(o.fovV) ||
    !finite(o.aspect) ||
    !finite(o.rms) ||
    !finite(o.inliers)
  )
    return null;
  if (o.fovV < 1 || o.fovV > 170 || o.aspect < 0.2 || o.aspect > 5 || o.rms < 0) return null;
  return {
    position: [p[0], p[1], p[2]],
    yaw: o.yaw,
    pitch: o.pitch,
    roll: o.roll,
    fovV: o.fovV,
    aspect: o.aspect,
    rms: o.rms,
    inliers: o.inliers,
  };
}

/** The direction the camera looks, in the world: R·(0, 0, −1). Unit length; the roll does not move it. */
export function cameraForward(c: TwinPhotoCamera): Vec3 {
  return [-Math.sin(c.yaw) * Math.cos(c.pitch), Math.sin(c.pitch), -Math.cos(c.yaw) * Math.cos(c.pitch)];
}

/**
 * Where a world point lands in the camera's picture: [u, v, depth] — fractions of the picture (u right,
 * v down) and the distance in front of the camera along its axis, metres. A depth ≤ 0 is a point behind
 * the camera, whose u and v mean nothing. The mirror of the server's projectWithCamera: camera space is
 * Rᵀ·(P − c), i.e. the yaw undone, then the pitch, then the roll.
 */
export function projectPoint(c: TwinPhotoCamera, P: readonly number[]): Vec3 {
  let x = P[0] - c.position[0];
  let y = P[1] - c.position[1];
  let z = P[2] - c.position[2];
  let cos = Math.cos(c.yaw);
  let sin = Math.sin(c.yaw);
  [x, z] = [cos * x - sin * z, sin * x + cos * z];
  cos = Math.cos(c.pitch);
  sin = Math.sin(c.pitch);
  [y, z] = [cos * y + sin * z, -sin * y + cos * z];
  cos = Math.cos(c.roll);
  sin = Math.sin(c.roll);
  [x, y] = [cos * x + sin * y, -sin * x + cos * y];
  const depth = -z;
  const f = 0.5 / Math.tan((c.fovV * DEG) / 2);
  return [(c.aspect / 2 + (f * x) / depth) / c.aspect, 0.5 - (f * y) / depth, depth];
}

/** Whether a photo reached the model: traced ('ok'), or sent and failed there ('model-failed'). The
 *  surface call and the landmark call run side by side on one deadline, so the surfaces can fail while
 *  the landmarks come back and fit a camera — which the server keeps on the row, since a camera needs no
 *  traced surface. A photo of any other status never reached the model and was never registered. */
const reachedModel = (p: TwinThermalPhoto): boolean => p.status === 'ok' || p.status === 'model-failed';

/** The photos whose camera can be projected from: every photo that reached the model (reachedModel) with
 *  a valid fitted camera, once each, in record order — its surfaces traced or not: its own pixels are the
 *  better reading either way. registrationSummary counts against the same photos, so what the panel
 *  reports and what the frame projects are the same photos. */
export function registeredPhotos(
  thermal: TwinBuildingThermal | null | undefined,
): { photo: TwinThermalPhoto; camera: TwinPhotoCamera }[] {
  const out: { photo: TwinThermalPhoto; camera: TwinPhotoCamera }[] = [];
  const seen = new Set<number>();
  for (const photo of thermal?.photos ?? []) {
    if (!reachedModel(photo) || seen.has(photo.photo)) continue;
    const camera = validCamera(photo.camera);
    if (!camera) continue;
    seen.add(photo.photo);
    out.push({ photo, camera });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The thermal frames.

/** 'photo 3' / 'frame 34' — the stored number, as the table's labels say it. */
export const photoLabel = (photo: number, shot: TwinShot): string => `${shot} ${photo}`;

/**
 * Below this a pixel of a photo's frame is taken for sky (when it reaches the top edge, see maskTemps):
 * 8 K colder than the coldest surface the tracer measured, doubtful readings aside. One cold median is
 * enough to drag the cut down and let the sky through, so it is taken over the CLEAN readings: not an
 * apparent one (a window reflects the sky), not a mixed one (its p10–p90 too wide for one surface — a
 * quad that straddles the skyline reads partly sky: the house set's gable quad, p10 12 °C / p90 34 °C,
 * has a median of 23 °C among walls of 30–31 °C and would put the cut at 15 °C, below the sky's own
 * reading beside the roof's verge, which would then be projected onto the roof's edge), not a small
 * sample (a sliver a few stray pixels move). When every reading that is not apparent is doubtful, those
 * still give a cut — a rough mask beats none. Null without such a reading: nothing says how cold the
 * subject itself is. (A room is not flooded at all: it has no sky, and useTwinProjection passes no cut
 * for an interior.)
 */
export function skyCut(thermal: TwinBuildingThermal | null | undefined): number | null {
  const readings = (thermal?.surfaces ?? []).filter((s) => !s.apparent && Number.isFinite(s.median));
  const clean = readings.filter((s) => !s.mixed && !s.smallSample);
  const medians = (clean.length ? clean : readings).map((s) => s.median);
  return medians.length ? Math.min(...medians) - SKY_MARGIN_K : null;
}

/**
 * A photo's temperatures as the frame may project them — a NEW array; the input (a decoded frame shared
 * across the analyzer) is never written. NaN marks what must not reach the model:
 *   - a pixel with no reading: not finite, the truncated-frame sentinel, or below the camera's range;
 *   - the sky — every pixel colder than `cut` (or without a reading) that a 4-connected flood from the top
 *     edge reaches, grown by one pixel all round for the thermal blur at the skyline. A camera fit a few
 *     pixels off would otherwise paint the sky's −10 °C along a roof's edge; a cold patch the flood does
 *     not reach (a shaded window low in the wall) is a surface and stays.
 * With `cut` null only the unreadable pixels are masked.
 */
export function maskTemps(temps: ArrayLike<number>, w: number, h: number, cut: number | null): Float32Array {
  const n = w * h;
  const out = new Float32Array(n);
  const unreadable = (t: number) => !Number.isFinite(t) || t <= SENTINEL_C || t < MIN_VALID_C;
  for (let i = 0; i < n; i++) out[i] = unreadable(temps[i]) ? NaN : temps[i];
  if (cut === null) return out;

  const sky = new Uint8Array(n);
  const stack: number[] = [];
  const reach = (i: number) => {
    if (sky[i]) return;
    const t = temps[i];
    if (!unreadable(t) && !(t < cut)) return;
    sky[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < w; x++) reach(x);
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % w;
    if (x > 0) reach(i - 1);
    if (x < w - 1) reach(i + 1);
    if (i >= w) reach(i - w);
    if (i + w < n) reach(i + w);
  }
  // Grow the sky by one pixel, the eight neighbours included.
  for (let i = 0; i < n; i++) {
    if (!sky[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++)
      for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) out[yy * w + xx] = NaN;
  }
  return out;
}

/**
 * The frame's `photos`: every registered photo whose thermal frame was decoded (`temps`, already masked,
 * by photo number), at most TWIN_PROJECTION_MAX, in record order. The registration applies only when the
 * landmarks were placed on the visible photo; on the render the picture IS the thermal grid.
 */
export function projectionPhotos(
  thermal: TwinBuildingThermal | null | undefined,
  temps: ReadonlyMap<number, Float32Array>,
  shot: TwinShot,
): TwinProjectionPhoto[] {
  const out: TwinProjectionPhoto[] = [];
  for (const { photo: p, camera } of registeredPhotos(thermal)) {
    if (out.length >= TWIN_PROJECTION_MAX) break;
    const grid = temps.get(p.photo);
    if (!grid || grid.length !== THERMAL_W * THERMAL_H) continue;
    const reg = p.picture === 'vis' ? p.registration : null;
    out.push({
      photo: p.photo,
      label: photoLabel(p.photo, shot),
      position: [camera.position[0], camera.position[1], camera.position[2]],
      yaw: camera.yaw,
      pitch: camera.pitch,
      roll: camera.roll,
      fovV: camera.fovV,
      aspect: camera.aspect,
      dx: reg && Number.isFinite(reg.dx) ? reg.dx : 0,
      dy: reg && Number.isFinite(reg.dy) ? reg.dy : 0,
      w: THERMAL_W,
      h: THERMAL_H,
      temps: grid,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// What the panel says, and where it looks from.

export interface TwinRegistrationSummary {
  registered: number; // registeredPhotos: the photos that reached the model with a valid fitted camera
  /** The photos that reached the model ('ok' or 'model-failed', see reachedModel) — every photo the
   *  server tried to register, its surfaces traced or not — so "N of M registered" never has N > M. */
  traced: number;
  /** Why a photo that reached the model has no camera, one line each: "photo 3: only 5 of 15 landmarks
   *  agree". Only for photos the server tried to register — an older record's photos never were, and
   *  are not failures. */
  failures: string[];
}

/** Why a photo that reached the model has no usable camera, or null when nothing was tried. */
function cameraFailure(p: TwinThermalPhoto): string | null {
  const note = typeof p.cameraNote === 'string' ? p.cameraNote.trim() : '';
  if (note) return note;
  if (Array.isArray(p.landmarks))
    return p.landmarks.length
      ? `the camera could not be fitted to its ${p.landmarks.length} landmark${p.landmarks.length === 1 ? '' : 's'}`
      : 'no landmarks were found';
  if (p.camera != null) return 'the fitted camera is not usable';
  return null;
}

export function registrationSummary(
  thermal: TwinBuildingThermal | null | undefined,
  shot: TwinShot,
): TwinRegistrationSummary {
  // The same photos registeredPhotos picks from, so the count it registers is a part of this one.
  const traced = (thermal?.photos ?? []).filter(reachedModel);
  const registered = registeredPhotos(thermal).length;
  const failures: string[] = [];
  for (const p of traced) {
    if (validCamera(p.camera)) continue;
    const why = cameraFailure(p);
    if (why) failures.push(`${photoLabel(p.photo, shot)}: ${why}`);
  }
  return { registered, traced: traced.length, failures };
}

/** A record measured before photos could be registered: it has traced photos, and none of them carries
 *  a trace of the landmark call (landmarks, a camera — null included — or a note on why there is none). */
export function predatesProjection(thermal: TwinBuildingThermal | null | undefined): boolean {
  const photos = thermal?.photos ?? [];
  return (
    photos.some((p) => p.status === 'ok') &&
    !photos.some((p) => p.landmarks !== undefined || p.camera !== undefined || p.cameraNote !== undefined)
  );
}

/**
 * The view that looks from a photo's camera: its position, its field of view, and a target on its axis
 * as far off as the middle of the built model (the union of `boxes`, the built parts' min/max), so the
 * orbit controls turn about the subject rather than about a point in front of the lens; 10 m when
 * nothing is built yet. The roll is the one thing the orbiting camera cannot take.
 */
export function viewFromCamera(
  c: TwinPhotoCamera,
  boxes: readonly { min: readonly number[]; max: readonly number[] }[],
): TwinViewMessage {
  const [x, y, z] = c.position;
  let distance = DEFAULT_LOOK_DISTANCE;
  if (boxes.length) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const b of boxes)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], b.min[k]);
        hi[k] = Math.max(hi[k], b.max[k]);
      }
    const d = Math.hypot((lo[0] + hi[0]) / 2 - x, (lo[1] + hi[1]) / 2 - y, (lo[2] + hi[2]) / 2 - z);
    if (Number.isFinite(d) && d > 1e-6) distance = d;
  }
  const [fx, fy, fz] = cameraForward(c);
  return {
    type: 'view',
    x,
    y,
    z,
    targetX: x + distance * fx,
    targetY: y + distance * fy,
    targetZ: z + distance * fz,
    fov: c.fovV,
  };
}
