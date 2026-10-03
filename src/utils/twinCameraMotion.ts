/**
 * What frames a recording's digital twin is built from (docs/digital-twin-plan.md §39, §42): the owner no
 * longer says how the clip was shot — the build finds out. A camera that stood still: the stillest frame
 * alone goes to the model; one that walked around the subject: several frames, sampled by the server.
 *
 * Two pictures of the clip decide, as on the server (functions/src/twinOrbit.ts):
 *
 *   - the thermal frames, through the camera-motion gate (twinStability.assessStability): a drift past
 *     the still-camera limit is a camera that moved;
 *   - the visible photos, when the thermal frames say the camera stood still: a centred, roughly
 *     symmetric subject (a kettle, a beaker) looks the same in the thermal frame from every side, so a
 *     walk around it passes the gate — while the room behind it, in the photo, moves on with every step.
 *     A handful of frames' photos are compared with the reference frame's, with the server's measure
 *     (twinOrbit.visibleDistance), and the clip is a walk when MOST of them show another standpoint: a
 *     hand reaching into a few frames of a fixed-camera clip must not turn it into a walk-around.
 *
 * Photos that say nothing (a dark room: sensor noise does not correlate with itself) are told by the
 * frame right next to the reference — the stillest moment of the clip — failing to match it; the
 * thermal verdict then stands. Pure; the caller fetches and decodes.
 */
import {
  ORBIT_FIXED_CAMERA_MAX_SHIFT_PX,
  ORBIT_MOTION_SEARCH_PX,
  visibleDistance,
} from '../../functions/src/twinOrbit';
import type { TwinStability } from '../types';

/** 'orbit' is the walk-around build, by the name its source goes to the server under. */
export type CameraMotionKind = 'fixed' | 'orbit';

/** How many frames' photos are compared with the reference frame's. */
export const VISIBLE_CHECK_FRAMES = 8;
/** With fewer photos than this to compare, the photos decide nothing. */
export const VISIBLE_CHECK_MIN_FRAMES = 3;

/**
 * The sampled frames whose photos are compared with the reference frame's: up to `want`, spread evenly
 * over the gate's samples and off the very ends of the clip (the phone is being raised or lowered
 * there), never the reference itself.
 */
export function visibleCheckIndices(sampled: number[], referenceIndex: number, want = VISIBLE_CHECK_FRAMES): number[] {
  const others = sampled.filter((i) => i !== referenceIndex);
  if (others.length <= want) return others;
  return Array.from({ length: want }, (_, k) => others[Math.floor(((k + 0.5) * others.length) / want)]);
}

/** The frame right next to `referenceIndex` (1-based, of `frameCount`), or null for a one-frame clip. */
export function neighbourIndex(referenceIndex: number, frameCount: number): number | null {
  if (referenceIndex + 1 <= frameCount) return referenceIndex + 1;
  return referenceIndex - 1 >= 1 ? referenceIndex - 1 : null;
}

export interface VisibleMotion {
  /** The photos compared with the reference frame's. */
  compared: number;
  /** How many of them show another standpoint. */
  moved: number;
}

/** Whether two visible lumas (twinOrbit.visibleLuma) show one standpoint: they correlate, within the
 *  still-camera shift limit. */
const sameStandpoint = (a: Float32Array, b: Float32Array): boolean =>
  visibleDistance(a, b, ORBIT_MOTION_SEARCH_PX) <= ORBIT_FIXED_CAMERA_MAX_SHIFT_PX;

/**
 * What the visible photos say about the camera: of `others` (the lumas of the frames of
 * visibleCheckIndices; null for a frame without a readable photo), how many show another standpoint than
 * `reference`. Null when they say nothing: no reference photo, too few others, or a `neighbour` — the
 * frame right next to the reference — that does not match it.
 */
export function assessVisibleMotion(
  reference: Float32Array | null,
  neighbour: Float32Array | null,
  others: (Float32Array | null)[],
): VisibleMotion | null {
  if (!reference || !neighbour || !sameStandpoint(reference, neighbour)) return null;
  const lumas = others.filter((l): l is Float32Array => !!l);
  if (lumas.length < VISIBLE_CHECK_MIN_FRAMES) return null;
  return { compared: lumas.length, moved: lumas.filter((l) => !sameStandpoint(reference, l)).length };
}

/** How the clip is built: walk-around when the thermal frames drift past the still-camera limit, or when
 *  most of the photos compared show another standpoint; from the stillest frame alone otherwise. */
export function cameraMotionKind(stability: TwinStability, visible: VisibleMotion | null): CameraMotionKind {
  if (!stability.stable) return 'orbit';
  return visible && visible.moved * 2 > visible.compared ? 'orbit' : 'fixed';
}
