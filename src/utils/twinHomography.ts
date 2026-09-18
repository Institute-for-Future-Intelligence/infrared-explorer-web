/**
 * Per-face homographies for the projected photos of a scene twin (docs/digital-twin-plan.md §26).
 *
 * A photo registered to the model (§18.8) is projected through the pinhole camera fitted to its
 * landmarks. The fit is good — a couple of per cent of the picture — but the model's geometry is the
 * language model's, and a wing drawn a little too wide or a gable a little too low lands the photo's
 * pixels a little off every corner: the attic window's hot spot creeps onto the siding. The landmarks
 * themselves are exact on both sides — each is a model vertex the model computed from its own program,
 * and the pixel the vision model saw it at — so for a flat face with four or more of them we can do
 * better than the pinhole: fit a HOMOGRAPHY from the face's plane straight to the picture, which carries
 * the face's corners to the pixels the picture shows them at whatever the model's proportions, and
 * project that face through it. The frame keeps the pinhole for the depth test (occlusion is the model's
 * own business) and for every face without one.
 *
 * Pure (no three.js, no React), unit-tested (twinHomography.test.ts). The picture convention is
 * utils/twinProjection.ts's: (u, v) fractions of the picture, v down.
 */
import type { TwinFace, TwinLandmark, TwinPhotoCamera, TwinThermalPhoto } from '../types';
import { projectPoint } from './twinProjection';
import { type TwinBuiltPart, normalizePartName } from './twinSceneThermal';

/** The plane coordinates of a face: which two world axes span it — 0: (x, y) for front and back, 1: (z, y)
 *  for left and right, 2: (x, z) for top and bottom. The frame reads the same two from a fragment's
 *  world position. */
export type PlaneAxis = 0 | 1 | 2;

export interface TwinFaceHomography {
  part: string; // the built part's name, as the frame knows it
  face: TwinFace;
  axis: PlaneAxis;
  /** Row-major 3 × 3: (u·w, v·w, w) = H · (a, b, 1), (a, b) the plane coordinates of a point on the face. */
  h: number[];
  landmarks: number; // how many landmarks it was fitted to
  /** The fit's residual over those landmarks — RMS, in fractions of the picture height. */
  rms: number;
}

/** The six faces with a plane, with the axis they lie across and the two axes that span them. */
const FACE_PLANE: Record<string, { normal: 0 | 1 | 2; axis: PlaneAxis; side: 'min' | 'max' }> = {
  front: { normal: 2, axis: 0, side: 'max' },
  back: { normal: 2, axis: 0, side: 'min' },
  right: { normal: 0, axis: 1, side: 'max' },
  left: { normal: 0, axis: 1, side: 'min' },
  top: { normal: 1, axis: 2, side: 'max' },
  bottom: { normal: 1, axis: 2, side: 'min' },
};

/** How far off a face's plane a landmark may lie and still count as on it: 2 % of the part's largest
 *  extent, and at least 2 cm (the model's own numbers are exact; the slack is for a rounded coordinate). */
const ON_PLANE_SHARE = 0.02;
const ON_PLANE_MIN_M = 0.02;
/** A fit is kept when its landmarks re-project within this, RMS, in picture heights. */
const MAX_RMS = 0.015;
/** …and when it agrees with the pinhole at the face's corners to within this, in picture heights: further
 *  apart, the landmarks were not the face's (a mislabelled part) or the pinhole is not this photo's. */
const MAX_CORNER_DRIFT = 0.2;
/** The landmarks must spread over at least this share of the face's extent both ways, and over this
 *  much of the picture: four points on one edge fit a homography to anything. */
const MIN_SPREAD_SHARE = 0.15;
const MIN_PICTURE_SPREAD = 0.02;

/** Plane coordinates of a world point on a face. */
export function planeCoords(axis: PlaneAxis, p: readonly number[]): [number, number] {
  return axis === 0 ? [p[0], p[1]] : axis === 1 ? [p[2], p[1]] : [p[0], p[2]];
}

/** Where a homography puts a plane point: [u, v], or null when the point is at the horizon (w ≈ 0). */
export function applyHomography(h: readonly number[], a: number, b: number): [number, number] | null {
  const w = h[6] * a + h[7] * b + h[8];
  if (!(Math.abs(w) > 1e-12)) return null;
  return [(h[0] * a + h[1] * b + h[2]) / w, (h[3] * a + h[4] * b + h[5]) / w];
}

/** Solve the square system M·x = r by Gaussian elimination with partial pivoting; null when singular. */
function solve(M: number[][], r: number[]): number[] | null {
  const n = r.length;
  const A = M.map((row, i) => [...row, r[i]]);
  for (let c = 0; c < n; c++) {
    let best = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(A[i][c]) > Math.abs(A[best][c])) best = i;
    if (!(Math.abs(A[best][c]) > 1e-12)) return null;
    [A[c], A[best]] = [A[best], A[c]];
    for (let i = 0; i < n; i++) {
      if (i === c) continue;
      const f = A[i][c] / A[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) A[i][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

/** A similarity that moves points to their centroid and scales their mean distance to √2 (Hartley's
 *  normalisation): [sx, sy, tx, ty] meaning x' = sx·x + tx, y' = sy·y + ty, one scale for both. */
function normaliser(points: readonly (readonly [number, number])[]): [number, number, number] {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of points) {
    cx += x;
    cy += y;
  }
  cx /= points.length;
  cy /= points.length;
  let mean = 0;
  for (const [x, y] of points) mean += Math.hypot(x - cx, y - cy);
  mean /= points.length;
  const s = mean > 1e-12 ? Math.SQRT2 / mean : 1;
  return [s, -s * cx, -s * cy];
}

/**
 * The homography that carries plane points `from` to picture points `to` (four or more pairs), by the
 * direct linear transform on normalised coordinates with h33 fixed at 1, least squares over the pairs.
 * Null when the pairs do not determine one (fewer than four, or collinear). Exported for the tests.
 */
export function fitHomography(
  from: readonly (readonly [number, number])[],
  to: readonly (readonly [number, number])[],
): number[] | null {
  const n = Math.min(from.length, to.length);
  if (n < 4) return null;
  const [sa, ta, tb] = normaliser(from);
  const [su, tu, tv] = normaliser(to);
  // Normal equations of the 2n × 8 system.
  const M: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const r = new Array<number>(8).fill(0);
  for (let i = 0; i < n; i++) {
    const a = sa * from[i][0] + ta;
    const b = sa * from[i][1] + tb;
    const u = su * to[i][0] + tu;
    const v = su * to[i][1] + tv;
    const rows: [number[], number][] = [
      [[a, b, 1, 0, 0, 0, -u * a, -u * b], u],
      [[0, 0, 0, a, b, 1, -v * a, -v * b], v],
    ];
    for (const [row, rhs] of rows)
      for (let p = 0; p < 8; p++) {
        r[p] += row[p] * rhs;
        for (let q = 0; q < 8; q++) M[p][q] += row[p] * row[q];
      }
  }
  const x = solve(M, r);
  if (!x || !x.every(Number.isFinite)) return null;
  const Hn = [x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7], 1];
  // Denormalise: H = Tuv⁻¹ · Hn · Tab, with Tab = [[sa, 0, ta], [0, sa, tb], [0, 0, 1]] and
  // Tuv⁻¹ = [[1/su, 0, -tu/su], [0, 1/su, -tv/su], [0, 0, 1]].
  const Tab = [sa, 0, ta, 0, sa, tb, 0, 0, 1];
  const Tuvi = [1 / su, 0, -tu / su, 0, 1 / su, -tv / su, 0, 0, 1];
  const H = mul3(mul3(Tuvi, Hn), Tab);
  const scale = H[8];
  return Math.abs(scale) > 1e-12 ? H.map((v) => v / scale) : H;
}

function mul3(A: readonly number[], B: readonly number[]): number[] {
  const C = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
}

/** The distance between two picture points in picture heights (u is a fraction of the width). */
const pictureDistance = (a: readonly number[], b: readonly number[], aspect: number): number =>
  Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1]);

/**
 * The homographies of one photo: one per boxy part's face that four or more of the photo's inlier
 * landmarks lie on (distinct on both sides), spread over the face and the picture, fitting within MAX_RMS
 * and agreeing with the pinhole at the face's corners within MAX_CORNER_DRIFT. A round part has no flat
 * face and gets none; a landmark on an edge or a corner counts for every face it touches.
 */
export function faceHomographies(
  photo: Pick<TwinThermalPhoto, 'landmarks'>,
  camera: TwinPhotoCamera,
  parts: readonly TwinBuiltPart[],
): TwinFaceHomography[] {
  const landmarks = (photo.landmarks ?? []).filter(
    (l): l is TwinLandmark =>
      !!l && l.inlier === true && [l.x, l.y, l.z, l.u, l.v].every((n) => typeof n === 'number' && Number.isFinite(n)),
  );
  if (landmarks.length < 4) return [];
  const out: TwinFaceHomography[] = [];
  for (const part of parts) {
    if (part.round || part.name === 'unnamed') continue;
    const key = normalizePartName(part.name);
    const own = landmarks.filter((l) => normalizePartName(l.part) === key);
    if (own.length < 4) continue;
    const size = Math.max(part.max[0] - part.min[0], part.max[1] - part.min[1], part.max[2] - part.min[2]);
    const tol = Math.max(ON_PLANE_MIN_M, ON_PLANE_SHARE * size);
    for (const face of part.faces) {
      const plane = FACE_PLANE[face];
      if (!plane) continue;
      const offset = plane.side === 'max' ? part.max[plane.normal] : part.min[plane.normal];
      const onFace = own.filter((l) => Math.abs([l.x, l.y, l.z][plane.normal] - offset) <= tol);
      const fit = fitFace(onFace, plane.axis, part, face, camera);
      if (fit) out.push(fit);
    }
  }
  return out;
}

function fitFace(
  onFace: TwinLandmark[],
  axis: PlaneAxis,
  part: TwinBuiltPart,
  face: TwinFace,
  camera: TwinPhotoCamera,
): TwinFaceHomography | null {
  // Distinct on both sides: two landmarks at one vertex (a corner named twice) or one pixel are one.
  const from: [number, number][] = [];
  const to: [number, number][] = [];
  for (const l of onFace) {
    const p = planeCoords(axis, [l.x, l.y, l.z]);
    const q: [number, number] = [l.u, l.v];
    if (from.some((f) => Math.hypot(f[0] - p[0], f[1] - p[1]) < 1e-6)) continue;
    if (to.some((t) => pictureDistance(t, q, camera.aspect) < 0.002)) continue;
    from.push(p);
    to.push(q);
  }
  if (from.length < 4) return null;
  // Spread: over the face's extent both ways, and over the picture.
  const [amin, bmin] = planeCoords(axis, part.min);
  const [amax, bmax] = planeCoords(axis, part.max);
  const spanA = Math.max(...from.map((f) => f[0])) - Math.min(...from.map((f) => f[0]));
  const spanB = Math.max(...from.map((f) => f[1])) - Math.min(...from.map((f) => f[1]));
  if (spanA < MIN_SPREAD_SHARE * (amax - amin) || spanB < MIN_SPREAD_SHARE * (bmax - bmin)) return null;
  const spanU = (Math.max(...to.map((t) => t[0])) - Math.min(...to.map((t) => t[0]))) * camera.aspect;
  const spanV = Math.max(...to.map((t) => t[1])) - Math.min(...to.map((t) => t[1]));
  if (spanU < MIN_PICTURE_SPREAD || spanV < MIN_PICTURE_SPREAD) return null;
  const h = fitHomography(from, to);
  if (!h) return null;
  let sq = 0;
  for (let i = 0; i < from.length; i++) {
    const p = applyHomography(h, from[i][0], from[i][1]);
    if (!p) return null;
    sq += pictureDistance(p, to[i], camera.aspect) ** 2;
  }
  const rms = Math.sqrt(sq / from.length);
  if (!(rms <= MAX_RMS)) return null;
  // Agreement with the pinhole at the face's corners (those in front of the camera).
  const plane = FACE_PLANE[face];
  const offset = plane.side === 'max' ? part.max[plane.normal] : part.min[plane.normal];
  for (const ca of [amin, amax])
    for (const cb of [bmin, bmax]) {
      const world = [0, 0, 0];
      world[plane.normal] = offset;
      if (axis === 0) {
        world[0] = ca;
        world[1] = cb;
      } else if (axis === 1) {
        world[2] = ca;
        world[1] = cb;
      } else {
        world[0] = ca;
        world[2] = cb;
      }
      const pin = projectPoint(camera, world);
      if (!(pin[2] > 0)) continue;
      const hom = applyHomography(h, ca, cb);
      if (!hom || pictureDistance(pin, hom, camera.aspect) > MAX_CORNER_DRIFT) return null;
    }
  return { part: part.name, face, axis, h, landmarks: from.length, rms };
}
