import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fitPhotoCamera } from '../../functions/src/twinCamera';
import type { TwinLandmark, TwinPhotoCamera } from '../types';
import { projectPoint } from './twinProjection';
import { settleRegistration } from './twinSettleRegistration';

// A house seen from its front-right: walls 10 × 6 × 8 on the ground, a roof slab 2 m deep on top of them.
const ASPECT = 0.75;
function lookFrom(position: [number, number, number], target: [number, number, number], fovV = 50): TwinPhotoCamera {
  const d = target.map((t, a) => t - position[a]);
  const len = Math.hypot(d[0], d[1], d[2]);
  const [fx, fy, fz] = d.map((c) => c / len);
  return {
    position,
    yaw: Math.atan2(-fx, -fz),
    pitch: Math.asin(fy),
    roll: 0,
    fovV,
    aspect: ASPECT,
    rms: 0,
    inliers: 0,
  };
}
const TRUE_CAMERA = lookFrom([9, 1.6, 16], [0, 3.5, 0]);
const WALL_CORNERS: [number, number, number][] = [
  [-5, 0, 4],
  [5, 0, 4],
  [-5, 6, 4],
  [5, 6, 4],
  [5, 0, -4],
  [5, 6, -4],
];
const ROOF_CORNERS: [number, number, number][] = [
  [-5.2, 6, 4.2],
  [5.2, 6, 4.2],
  [-5.2, 8, 4.2],
  [5.2, 8, 4.2],
  [5.2, 6, -4.2],
  [5.2, 8, -4.2],
];
/** Landmarks as the tracer gives them: the picture position from the real house (the photo), the 3D
 *  position from the program — which may have put a part `lift` metres higher than the photo shows it. */
function landmarks(roofLift: number, wallLift = 0): TwinLandmark[] {
  const mk =
    (part: string, lift: number) =>
    (p: [number, number, number]): TwinLandmark => {
      const [u, v] = projectPoint(TRUE_CAMERA, p);
      return { part, what: 'corner', x: p[0], y: p[1] + lift, z: p[2], u, v, inlier: true };
    };
  return [...WALL_CORNERS.map(mk('mainBlock', wallLift)), ...ROOF_CORNERS.map(mk('roof', roofLift + wallLift))];
}
const worst = (camera: TwinPhotoCamera, ls: TwinLandmark[]) =>
  Math.max(
    ...ls.map((l) => {
      const [u, v] = projectPoint(camera, [l.x, l.y, l.z]);
      return Math.hypot((u - l.u) * camera.aspect, v - l.v);
    }),
  );

describe('settleRegistration', () => {
  it('leaves the stored camera alone when the frame moved nothing a landmark is on', () => {
    const ls = landmarks(0);
    const cam = { ...TRUE_CAMERA };
    for (const settled of [
      null,
      { shifts: [], split: [] },
      { shifts: [{ part: 'lawn', dx: 0, dy: -0.1, dz: 0 }], split: [] },
    ]) {
      const r = settleRegistration({ landmarks: ls }, cam, settled);
      assert.equal(r.how, 'unchanged');
      assert.equal(r.camera, cam);
      assert.equal(r.landmarks, ls);
    }
  });

  it('moves the camera with a house the frame dropped as one body, and the photo lands where it did', () => {
    // The program put the whole house 0.4 m up; the server's camera was fitted to that.
    const ls = landmarks(0, 0.4);
    const stored = fitPhotoCamera(ls, ASPECT, { position: [9, 2, 16], target: [0, 3.5, 0] }).camera;
    assert.ok(stored);
    const r = settleRegistration({ landmarks: ls }, stored!, {
      shifts: [
        { part: 'mainBlock', dx: 0, dy: -0.4, dz: 0 },
        { part: 'roof', dx: 0, dy: -0.4, dz: 0 },
      ],
      split: [],
    });
    assert.equal(r.how, 'translated');
    assert.ok(r.camera);
    assert.ok(Math.abs(r.camera!.position[1] - (stored!.position[1] - 0.4)) < 1e-9);
    assert.equal(r.camera!.yaw, stored!.yaw);
    // The carried landmarks are where the settled model has them, and the moved camera sees them where the
    // photo does, as the stored camera saw the program's.
    assert.ok(r.landmarks.every((l, k) => Math.abs(l.y - (ls[k].y - 0.4)) < 1e-9));
    assert.ok(worst(r.camera!, r.landmarks) < 1e-3);
    assert.ok(r.landmarks.every((l) => l.inlier));
  });

  it('fits the camera again when only the roof was set down onto its walls', () => {
    // The program's roof floats 0.5 m over the walls; in the photo it sits on them.
    const ls = landmarks(0.5);
    const fit = fitPhotoCamera(ls, ASPECT, { position: [9, 2, 16], target: [0, 3.5, 0] });
    assert.ok(fit.camera);
    const stored = fit.camera!;
    const flagged = ls.map((l, k) => ({ ...l, inlier: fit.inliers[k] }));
    const r = settleRegistration({ landmarks: flagged }, stored, {
      shifts: [{ part: 'roof', dx: 0, dy: -0.5, dz: 0 }],
      split: [],
    });
    assert.ok(r.camera, r.how === 'refused' ? r.reason : '');
    // Once set down the model is the photo's house: every landmark agrees, and closely.
    assert.ok(
      r.landmarks.every((l) => l.inlier),
      JSON.stringify(r.landmarks.map((l) => l.inlier)),
    );
    assert.ok(worst(r.camera!, r.landmarks) < 0.01);
    assert.ok(worst(r.camera!, r.landmarks) < worst(stored, flagged));
    assert.ok(Math.hypot(...r.camera!.position.map((c, a) => c - TRUE_CAMERA.position[a])) < 0.5);
  });

  it('keeps the stored camera when only a part pulled apart moved, and its largest mesh stayed', () => {
    const ls = landmarks(0);
    const cam = fitPhotoCamera(ls, ASPECT, { position: [9, 2, 16], target: [0, 3.5, 0] }).camera!;
    // A gutter of mainBlock was set back onto the wall; the wall itself, mainBlock's largest mesh, stayed.
    const r = settleRegistration({ landmarks: ls }, cam, {
      shifts: [{ part: 'mainBlock', dx: 0, dy: 0, dz: 0 }],
      split: ['mainBlock'],
    });
    assert.equal(r.how, 'unchanged');
    assert.equal(r.camera, cam);
  });

  it('does not let a moved roof carry the camera off walls whose part was pulled apart', () => {
    // The program floats the roof 0.5 m; mainBlock's gutter, 0.35 m proud, was also set back, so mainBlock
    // is split while its walls stayed. The stored camera agreed with walls and roof as the program had them.
    const ls = landmarks(0.5);
    const fit = fitPhotoCamera(ls, ASPECT, { position: [9, 2, 16], target: [0, 3.5, 0] });
    assert.ok(fit.camera);
    const flagged = ls.map((l, k) => ({ ...l, inlier: fit.inliers[k] }));
    const r = settleRegistration({ landmarks: flagged }, fit.camera!, {
      shifts: [
        { part: 'roof', dx: 0, dy: -0.5, dz: 0 },
        { part: 'mainBlock', dx: 0, dy: 0, dz: 0 },
      ],
      split: ['mainBlock'],
    });
    assert.notEqual(r.how, 'translated');
    assert.ok(r.camera, r.how === 'refused' ? r.reason : '');
    const walls = r.landmarks.filter((l) => l.part === 'mainBlock');
    assert.ok(worst(r.camera!, walls) < 0.01, `walls off by ${worst(r.camera!, walls)}`);
    assert.ok(walls.every((l) => l.inlier));
  });

  it('keeps the stored camera for what stayed when a fit of the moved model is refused', () => {
    // Six wall corners the stored camera agrees with, a chimney it agreed with where the program floated
    // it, and seven landmarks placed on the wrong pixels: 7 of 14 agree, just over the gate.
    const chimney = (lift: number): TwinLandmark => {
      const [u, v] = projectPoint(TRUE_CAMERA, [3, 8 + lift, 0]);
      return { part: 'chimney', what: 'top', x: 3, y: 8 + lift, z: 0, u, v, inlier: true };
    };
    const wrong: [number, number, number][] = [
      [-4, 0, 4],
      [-3, 2, 4],
      [-2, 4, 4],
      [2, 1, 4],
      [3, 3, 4],
      [4, 5, 4],
      [5, 3, 0],
    ];
    const bad = wrong.map((p, k): TwinLandmark => {
      const [u, v] = projectPoint(TRUE_CAMERA, wrong[(k + 3) % wrong.length]);
      return {
        part: 'mainBlock',
        what: 'bad',
        x: p[0],
        y: p[1],
        z: p[2],
        u: Math.min(1, u + 0.15),
        v: Math.max(0, v - 0.2),
        inlier: true,
      };
    });
    const ls = [...landmarks(0).filter((l) => l.part === 'mainBlock'), chimney(0.9), ...bad];
    const fit = fitPhotoCamera(ls, ASPECT, { position: [9, 2, 16], target: [0, 3.5, 0] });
    assert.ok(fit.camera, fit.reason ?? '');
    const flagged = ls.map((l, k) => ({ ...l, inlier: fit.inliers[k] }));
    const r = settleRegistration({ landmarks: flagged }, fit.camera!, {
      shifts: [{ part: 'chimney', dx: 0, dy: -0.9, dz: 0 }],
      split: [],
    });
    assert.equal(r.how, 'unchanged');
    assert.equal(r.camera, fit.camera);
    assert.equal(r.landmarks.find((l) => l.part === 'chimney')!.inlier, false);
    // And when nothing that stayed agrees with it either, the photo is not projected.
    const none = settleRegistration(
      { landmarks: flagged.map((l) => (l.part === 'mainBlock' && l.what !== 'bad' ? { ...l, u: l.u + 0.2 } : l)) },
      fit.camera!,
      { shifts: [{ part: 'chimney', dx: 0, dy: -0.9, dz: 0 }], split: [] },
    );
    assert.equal(none.camera, null);
  });
});
