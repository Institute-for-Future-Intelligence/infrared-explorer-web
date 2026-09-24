/**
 * The photos' registration carried onto the settled model (docs/digital-twin-plan.md §29, §30.1).
 *
 * Each thermal photo's camera was fitted on the server to landmarks whose 3D coordinates the model worked
 * out from its program as written. The viewer frame then sets down what that program left floating
 * (twinFrameGeometry.ts settleScene): a house hovering 0.4 m over its plinth is dropped onto it. Projected
 * through the stored camera, the photo would then land 0.4 m off the house it was registered to — the wall's
 * base would read the ground — and the ID pass would read the wrong strip of every photo for the moved parts.
 *
 * So the landmarks follow the model. The frame reports how far each part was carried (`shifts`) and which
 * parts were pulled apart (`split`: meshes carried by different amounts, whose `shifts` entry is how far
 * the part's largest mesh went — where a landmark named by its part alone most likely is, not certainly).
 * Then, per photo:
 *   - nothing it registers against moved: the stored camera stands;
 *   - every landmark the stored camera agrees with moved, for certain, by one amount d: the camera moves
 *     by d — exact, since a pinhole moved with the scene sees the same picture;
 *   - otherwise (the roof set down on its walls, the walls not moved; or a part pulled apart among them):
 *     the carried landmarks are fitted afresh with the server's own fit (functions/src/twinCamera.ts),
 *     anchored on the stored camera — its RANSAC leaves out a landmark a split part carried otherwise;
 *   - and when that fit is refused, the stored camera still stands if it agrees with enough landmarks on
 *     parts that certainly stayed (what moved is then projected as before §30.1); only a photo that
 *     agrees with neither is left unprojected — its traced surfaces still count, as for any photo
 *     without a camera.
 * The landmarks come back carried too, flagged by whether the returned camera agrees with them (within
 * the server's CAMERA_INLIER_TOL) — a roof the server's fit rejected while it floated may agree once set
 * down — for the per-face homographies (twinHomography.ts), which must describe the same model the camera
 * does.
 *
 * Pure, unit-tested (twinSettleRegistration.test.ts).
 */
import { CAMERA_INLIER_TOL, CAMERA_MIN_INLIERS, fitPhotoCamera } from '../../functions/src/twinCamera';
import type { TwinLandmark, TwinPhotoCamera, TwinThermalPhoto } from '../types';
import { cameraForward, projectPoint } from './twinProjection';
import { normalizePartName } from './twinSceneThermal';

/** What the frame said of the settling, as far as the photos care (twinFrameGeometry.ts TwinSettled). */
export interface TwinSettleShifts {
  shifts: readonly { part: string; dx: number; dy: number; dz: number }[];
  split: readonly string[];
}

export type TwinSettledRegistration =
  | { camera: TwinPhotoCamera; landmarks: TwinLandmark[]; how: 'unchanged' | 'translated' | 'refitted' }
  | { camera: null; landmarks: TwinLandmark[]; how: 'refused'; reason: string };

type Vec3 = [number, number, number];
const mm = (v: number) => Math.round(v * 1000) / 1000;
/** Whether a camera agrees with a landmark as the server's fit judges it: in front, and within
 *  CAMERA_INLIER_TOL of the picture height of where the picture shows it. */
const agrees = (camera: TwinPhotoCamera, l: TwinLandmark): boolean => {
  const [u, v, depth] = projectPoint(camera, [l.x, l.y, l.z]);
  return depth > 0 && Math.hypot((u - l.u) * camera.aspect, v - l.v) < CAMERA_INLIER_TOL;
};
const same = (a: Vec3, b: Vec3) =>
  Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(a[2] - b[2]) < 1e-9;

/**
 * One photo's camera and landmarks for the settled model. `camera` is the stored (validated) camera,
 * `settled` the frame's report — null or empty when it moved nothing.
 */
export function settleRegistration(
  photo: Pick<TwinThermalPhoto, 'landmarks'>,
  camera: TwinPhotoCamera,
  settled: TwinSettleShifts | null,
): TwinSettledRegistration {
  const landmarks = photo.landmarks ?? [];
  if (!settled || (!settled.shifts.length && !settled.split.length)) return { camera, landmarks, how: 'unchanged' };
  const shiftOf = new Map<string, Vec3>(settled.shifts.map((s) => [normalizePartName(s.part), [s.dx, s.dy, s.dz]]));
  const split = new Set(settled.split.map(normalizePartName));
  // Each landmark's carry: how far its part went, [0, 0, 0] for one that stayed. A part pulled apart has
  // no one carry; the frame gives its largest mesh's, where most of what a photo points at on a part is
  // (a wall's corners, not the gutter set back onto it) — likely, not certain (`sure` false).
  const carry = landmarks.map((l): Vec3 => shiftOf.get(normalizePartName(l.part)) ?? [0, 0, 0]);
  const sure = landmarks.map((l) => !split.has(normalizePartName(l.part)));
  if (carry.every((d) => same(d, [0, 0, 0]))) return { camera, landmarks, how: 'unchanged' };
  const carried = landmarks.map((l, k) => {
    const d = carry[k];
    return { ...l, x: mm(l.x + d[0]), y: mm(l.y + d[1]), z: mm(l.z + d[2]) };
  });

  // Every landmark the stored camera agrees with carried, for certain, by one amount: the camera goes with
  // them. Not when any of them is on a part pulled apart — a wall part split by one moved gutter would
  // otherwise leave only a moved roof to decide, and the camera would carry the walls off with it.
  const agreeing = landmarks.flatMap((l, k) => (l.inlier ? [k] : []));
  const first = agreeing.length ? carry[agreeing[0]] : null;
  if (first && agreeing.every((k) => sure[k] && same(carry[k], first))) {
    const moved: TwinPhotoCamera = { ...camera, position: camera.position.map((c, a) => mm(c + first[a])) };
    return {
      camera: moved,
      landmarks: carried.map((l) => ({ ...l, inlier: agrees(moved, l) })),
      how: 'translated',
    };
  }

  // Parts moved by different amounts: fit the carried landmarks again, anchored where the stored camera
  // stood (carried by the landmarks' mean move) and looking where it looked, with its lens as the prior.
  const mean: Vec3 = [0, 1, 2].map((a) => carry.reduce((s, d) => s + d[a], 0) / Math.max(1, carry.length)) as Vec3;
  const position: Vec3 = [0, 1, 2].map((a) => camera.position[a] + mean[a]) as Vec3;
  const centroid: Vec3 = [0, 1, 2].map(
    (a) => carried.reduce((s, l) => s + [l.x, l.y, l.z][a], 0) / Math.max(1, carried.length),
  ) as Vec3;
  const reach = Math.max(
    1,
    Math.hypot(centroid[0] - position[0], centroid[1] - position[1], centroid[2] - position[2]),
  );
  const forward = cameraForward(camera);
  const target: Vec3 = [0, 1, 2].map((a) => position[a] + forward[a] * reach) as Vec3;
  const fit = fitPhotoCamera(carried, camera.aspect, { position, target }, { fovV: camera.fovV });
  if (!fit.camera) {
    // The stored camera may still hold for what did not move: when it agrees with at least as many of the
    // landmarks on parts that certainly stayed as a fit needs, it stands (what moved is projected from
    // where the program had it, as before §30.1) rather than the photo going unprojected.
    const still = landmarks.filter((l, k) => l.inlier && sure[k] && same(carry[k], [0, 0, 0]) && agrees(camera, l));
    if (still.length >= CAMERA_MIN_INLIERS) {
      return { camera, landmarks: carried.map((l) => ({ ...l, inlier: agrees(camera, l) })), how: 'unchanged' };
    }
    return {
      camera: null,
      landmarks: carried.map((l) => ({ ...l, inlier: false })),
      how: 'refused',
      reason: fit.reason ?? 'the landmarks no longer agree on one camera',
    };
  }
  return {
    camera: fit.camera,
    landmarks: carried.map((l, k) => ({ ...l, inlier: fit.inliers[k] })),
    how: 'refitted',
  };
}
