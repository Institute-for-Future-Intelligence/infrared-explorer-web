import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TwinLandmark, TwinPhotoCamera } from '../types';
import { applyHomography, faceHomographies, fitHomography, planeCoords } from './twinHomography';
import { projectPoint } from './twinProjection';
import type { TwinBuiltPart } from './twinSceneThermal';

const DEG = Math.PI / 180;

/** A camera 12 m in front of the origin, 2 m up, looking a little down at a house. */
function cam(o: Partial<TwinPhotoCamera> = {}): TwinPhotoCamera {
  return {
    position: [1, 2, 12],
    yaw: 0.05,
    pitch: -6 * DEG,
    roll: 0,
    fovV: 50,
    aspect: 0.75,
    rms: 0.01,
    inliers: 12,
    ...o,
  };
}

/** A 10 × 6 × 8 m block standing on the ground, its front at z = 4. */
function block(o: Partial<TwinBuiltPart> = {}): TwinBuiltPart {
  return {
    name: 'house',
    kinds: ['wall'],
    faces: ['front', 'back', 'left', 'right', 'top', 'bottom'],
    center: [0, 3, 0],
    min: [-5, 0, -4],
    max: [5, 6, 4],
    meshCount: 1,
    round: false,
    ...o,
  };
}

/** A landmark at a world point, placed in the picture where `c` sees it (plus a shift in picture heights). */
function mark(
  c: TwinPhotoCamera,
  part: string,
  P: number[],
  shift: [number, number] = [0, 0],
  inlier = true,
): TwinLandmark {
  const [u, v] = projectPoint(c, P);
  return { part, what: 'corner', x: P[0], y: P[1], z: P[2], u: u + shift[0] / c.aspect, v: v + shift[1], inlier };
}

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

describe('fitHomography', () => {
  it('recovers a known homography from four points and from more, with noise averaged', () => {
    const H = [1.2, 0.1, 0.3, -0.05, 0.9, 0.2, 0.01, -0.02, 1];
    const from: [number, number][] = [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
      [2, 1],
      [1, 2.5],
    ];
    const to = from.map(([a, b]) => applyHomography(H, a, b) as [number, number]);
    const fit4 = fitHomography(from.slice(0, 4), to.slice(0, 4));
    assert.ok(fit4);
    fit4.forEach((v, i) => near(v, H[i], 1e-9));
    const fit6 = fitHomography(from, to);
    assert.ok(fit6);
    fit6.forEach((v, i) => near(v, H[i], 1e-9));
  });

  it('refuses fewer than four points and collinear ones', () => {
    assert.equal(
      fitHomography(
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      ),
      null,
    );
    const line: [number, number][] = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ];
    assert.equal(fitHomography(line, line), null);
  });
});

describe('planeCoords', () => {
  it('spans front/back by x y, left/right by z y, top/bottom by x z', () => {
    assert.deepEqual(planeCoords(0, [1, 2, 3]), [1, 2]);
    assert.deepEqual(planeCoords(1, [1, 2, 3]), [3, 2]);
    assert.deepEqual(planeCoords(2, [1, 2, 3]), [1, 3]);
  });
});

describe('faceHomographies', () => {
  const c = cam();
  const house = block();
  // The front face's four corners and two window corners on it, exactly where the pinhole puts them.
  const front = [
    [-5, 0, 4],
    [5, 0, 4],
    [5, 6, 4],
    [-5, 6, 4],
    [-2, 2, 4],
    [2, 4, 4],
  ];

  it('fits a face with four or more of its landmarks and agrees with the pinhole on it', () => {
    const landmarks = front.map((P) => mark(c, 'House', P));
    const out = faceHomographies({ landmarks }, c, [house]);
    assert.equal(out.length, 1);
    const [h] = out;
    assert.equal(h.part, 'house');
    assert.equal(h.face, 'front');
    assert.equal(h.axis, 0);
    assert.equal(h.landmarks, 6);
    near(h.rms, 0, 1e-9);
    for (const P of [
      [0, 3, 4],
      [-4.5, 5.5, 4],
      [3, 1, 4],
    ]) {
      const pin = projectPoint(c, P);
      const hom = applyHomography(h.h, ...planeCoords(0, P)) as [number, number];
      near(hom[0], pin[0], 1e-9);
      near(hom[1], pin[1], 1e-9);
    }
  });

  it("carries the face's corners to where the picture shows them when the model's proportions are off", () => {
    // The real house is 12 m wide; the model says 10. Its landmarks are the MODEL's vertices at the
    // pixels the REAL corners appear at: the homography lands the model's corners on those pixels.
    const real = cam();
    const stretch = (P: number[]) => [P[0] * 1.2, P[1], P[2]];
    const landmarks = front.map((P) => {
      const [u, v] = projectPoint(real, stretch(P));
      return { part: 'house', what: 'corner', x: P[0], y: P[1], z: P[2], u, v, inlier: true };
    });
    const out = faceHomographies({ landmarks }, c, [house]);
    assert.equal(out.length, 1);
    const hom = applyHomography(out[0].h, -5, 0) as [number, number]; // the model's corner…
    const [u, v] = projectPoint(real, [-6, 0, 4]); // …where the real corner is in the picture
    near(hom[0], u, 1e-9);
    near(hom[1], v, 1e-9);
  });

  it('needs four distinct inlier landmarks on the plane, spread over the face and the picture', () => {
    const three = front.slice(0, 3).map((P) => mark(c, 'house', P));
    assert.equal(faceHomographies({ landmarks: three }, c, [house]).length, 0);
    const outlier = front.map((P, i) => mark(c, 'house', P, [0, 0], i !== 5));
    assert.equal(faceHomographies({ landmarks: outlier }, c, [house])[0]?.landmarks, 5);
    const twice = [...front.slice(0, 3), front[0]].map((P) => mark(c, 'house', P)); // a corner named twice
    assert.equal(faceHomographies({ landmarks: twice }, c, [house]).length, 0);
    const edge = [
      [-5, 0, 4],
      [-2, 0, 4],
      [2, 0, 4],
      [5, 0, 4],
    ].map((P) => mark(c, 'house', P)); // along the bottom edge only
    assert.equal(faceHomographies({ landmarks: edge }, c, [house]).length, 0);
    const offPlane = front.map((P) => mark(c, 'house', [P[0], P[1], 3.5])); // half a metre inside the block
    assert.equal(faceHomographies({ landmarks: offPlane }, c, [house]).length, 0);
  });

  it('rejects landmarks the pinhole disagrees with at the corners, and skips round parts and other names', () => {
    const drifted = front.map((P) => mark(c, 'house', P, [0.2, 0.2])); // all shifted a fifth of the picture
    assert.equal(faceHomographies({ landmarks: drifted }, c, [house]).length, 0);
    const wrongName = front.map((P) => mark(c, 'garage', P));
    assert.equal(faceHomographies({ landmarks: wrongName }, c, [house]).length, 0);
    const landmarks = front.map((P) => mark(c, 'house', P));
    assert.equal(faceHomographies({ landmarks }, c, [block({ round: true })]).length, 0);
  });

  it('gives a corner to every face it lies on', () => {
    // The four corners of the right face (x = 5) and of the front face (z = 4) share the edge x = 5, z = 4.
    const right = [
      [5, 0, -4],
      [5, 0, 4],
      [5, 6, 4],
      [5, 6, -4],
    ];
    const landmarks = [...front.slice(0, 4), ...right].map((P) =>
      mark(cam({ position: [10, 2, 12], yaw: 0.6 }), 'house', P),
    );
    const out = faceHomographies({ landmarks }, cam({ position: [10, 2, 12], yaw: 0.6 }), [house]);
    assert.deepEqual(out.map((h) => h.face).sort(), ['front', 'right']);
    assert.equal(out.find((h) => h.face === 'right')?.axis, 1);
  });
});
