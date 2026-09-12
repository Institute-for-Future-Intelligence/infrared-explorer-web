import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TwinBuildingThermal, TwinPhotoCamera, TwinThermalPhoto } from '../types';
import {
  THERMAL_H,
  THERMAL_W,
  TWIN_PROJECTION_MAX,
  cameraForward,
  maskTemps,
  photoLabel,
  predatesProjection,
  projectPoint,
  projectionPhotos,
  registeredPhotos,
  registrationSummary,
  skyCut,
  validCamera,
  viewFromCamera,
} from './twinProjection';

// ---- fixtures -----------------------------------------------------------------------------------------

const DEG = Math.PI / 180;

function cam(o: Partial<TwinPhotoCamera> = {}): TwinPhotoCamera {
  return { position: [0, 0, 0], yaw: 0, pitch: 0, roll: 0, fovV: 90, aspect: 1, rms: 0.01, inliers: 12, ...o };
}

function photo(n: number, o: Partial<TwinThermalPhoto> = {}): TwinThermalPhoto {
  return { photo: n, picture: 'vis', status: 'ok', registration: null, ...o };
}

const thermalOf = (photos: TwinThermalPhoto[], medians: number[] = []): TwinBuildingThermal => ({
  photos,
  surfaces: medians.map((median) => ({
    part: 'block',
    kind: 'wall',
    face: 'front',
    photo: 1,
    quad: [0, 0, 1, 0, 1, 1, 0, 1],
    n: 400,
    median,
    p10: median - 2,
    p90: median + 2,
    min: median - 4,
    max: median + 4,
    registered: true,
  })),
  range: [15, 35],
});

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const nearAll = (a: readonly number[], b: readonly number[], eps = 1e-9) => {
  assert.equal(a.length, b.length);
  a.forEach((v, i) => near(v, b[i], eps));
};

/** The camera convention written out as matrices, independently of projectPoint's step-by-step
 *  rotations: R = Ry(yaw)·Rx(pitch)·Rz(roll), camera space = Rᵀ·(P − c). */
type M3 = number[][];
const mul = (A: M3, B: M3): M3 => A.map((row) => B[0].map((_, j) => row.reduce((s, a, k) => s + a * B[k][j], 0)));
function rotation(c: TwinPhotoCamera): M3 {
  const [cy, sy] = [Math.cos(c.yaw), Math.sin(c.yaw)];
  const [cp, sp] = [Math.cos(c.pitch), Math.sin(c.pitch)];
  const [cr, sr] = [Math.cos(c.roll), Math.sin(c.roll)];
  const Ry = [
    [cy, 0, sy],
    [0, 1, 0],
    [-sy, 0, cy],
  ];
  const Rx = [
    [1, 0, 0],
    [0, cp, -sp],
    [0, sp, cp],
  ];
  const Rz = [
    [cr, -sr, 0],
    [sr, cr, 0],
    [0, 0, 1],
  ];
  return mul(mul(Ry, Rx), Rz);
}
function projectByMatrix(c: TwinPhotoCamera, P: number[]): number[] {
  const R = rotation(c);
  const d = [0, 1, 2].map((k) => P[k] - c.position[k]);
  const [x, y, z] = [0, 1, 2].map((j) => R[0][j] * d[0] + R[1][j] * d[1] + R[2][j] * d[2]); // Rᵀ·d
  const f = 0.5 / Math.tan((c.fovV * DEG) / 2);
  return [(c.aspect / 2 + (f * x) / -z) / c.aspect, 0.5 - (f * y) / -z, -z];
}

// ---- the camera ---------------------------------------------------------------------------------------

describe('validCamera', () => {
  it('copies a good camera field by field', () => {
    const c = { ...cam({ position: [1, 2, 3], yaw: 0.5 }), extra: 'dropped' };
    const v = validCamera(c);
    assert.deepEqual(v, cam({ position: [1, 2, 3], yaw: 0.5 }));
    assert.notEqual(v?.position, c.position);
  });

  it('accepts the bounds and rejects anything outside them or not finite', () => {
    for (const ok of [{ fovV: 1 }, { fovV: 170 }, { aspect: 0.2 }, { aspect: 5 }, { rms: 0 }])
      assert.ok(validCamera(cam(ok)), JSON.stringify(ok));
    for (const bad of [
      { fovV: 0.5 },
      { fovV: 171 },
      { aspect: 0.1 },
      { aspect: 6 },
      { rms: -0.01 },
      { yaw: Infinity },
      { pitch: NaN },
      { roll: Number.NaN },
      { position: [1, 2] },
      { position: [1, 2, NaN] },
      { position: [1, 2, 3, 4] },
    ])
      assert.equal(validCamera(cam(bad as Partial<TwinPhotoCamera>)), null, JSON.stringify(bad));
    const noInliers: Partial<TwinPhotoCamera> = cam();
    delete noInliers.inliers;
    assert.equal(validCamera(noInliers), null);
    assert.equal(validCamera({ ...cam(), fovV: '50' }), null);
    for (const junk of [null, undefined, 'camera', 42, [], {}]) assert.equal(validCamera(junk), null);
  });
});

describe('cameraForward', () => {
  it('looks down −z unturned, and turns with the yaw and the pitch but not the roll', () => {
    nearAll(cameraForward(cam()), [0, 0, -1]);
    nearAll(cameraForward(cam({ yaw: 90 * DEG })), [-1, 0, 0]);
    nearAll(cameraForward(cam({ yaw: 180 * DEG })), [0, 0, 1]);
    nearAll(cameraForward(cam({ pitch: 90 * DEG })), [0, 1, 0]);
    nearAll(cameraForward(cam({ roll: 40 * DEG })), [0, 0, -1]);
  });

  it('is R·(0, 0, −1) for any pose', () => {
    const c = cam({ yaw: 0.7, pitch: -0.2, roll: 0.1 });
    const R = rotation(c);
    nearAll(
      cameraForward(c),
      [0, 1, 2].map((i) => -R[i][2]),
    );
  });
});

describe('projectPoint', () => {
  it('projects in front of an unturned camera (hand-computed)', () => {
    // fovV 90° → f = 0.5 picture heights; aspect 0.75.
    const c = cam({ aspect: 0.75 });
    nearAll(projectPoint(c, [0, 0, -2]), [0.5, 0.5, 2]);
    nearAll(projectPoint(c, [1, 0, -2]), [(0.375 + 0.25) / 0.75, 0.5, 2]); // right of centre
    nearAll(projectPoint(c, [0, 1, -2]), [0.5, 0.25, 2]); // above: v is down the picture
    assert.ok(projectPoint(c, [0, 0, 2])[2] < 0, 'a point behind the camera has a negative depth');
  });

  it('follows a yawed camera: looking down −x, its right is −z', () => {
    const c = cam({ position: [10, 1, 0], yaw: 90 * DEG });
    nearAll(projectPoint(c, [8, 1, 0]), [0.5, 0.5, 2]);
    nearAll(projectPoint(c, [8, 1, -1]), [0.75, 0.5, 2]);
  });

  it('follows a pitched camera: a level point straight ahead drops below the centre', () => {
    const c = cam({ pitch: 30 * DEG });
    nearAll(projectPoint(c, [0, 1, -Math.sqrt(3)]), [0.5, 0.5, 2]); // on the axis, 2 m out
    nearAll(projectPoint(c, [0, 0, -2]), [0.5, 0.5 + 0.5 / Math.sqrt(3), Math.sqrt(3)]);
  });

  it("follows a rolled camera: at +90° roll the camera's up is the world's −x", () => {
    const c = cam({ roll: 90 * DEG });
    nearAll(projectPoint(c, [-1, 0, -2]), [0.5, 0.25, 2]);
    nearAll(projectPoint(c, [0, 1, -2]), [0.75, 0.5, 2]);
  });

  it('agrees with the rotation written as matrices for a yawed, pitched and rolled camera', () => {
    const c = cam({ position: [3, 2, 9], yaw: 0.7, pitch: -0.2, roll: 0.1, fovV: 55, aspect: 0.75 });
    for (const P of [
      [0, 0, 0],
      [-4, 6, 1],
      [5, 0.5, -3],
      [2, 2, 2],
    ])
      nearAll(projectPoint(c, P), projectByMatrix(c, P), 1e-12);
  });

  it('puts the target of a look-at pose in the middle of the picture, whatever the roll', () => {
    const c = [4.5, 1.7, 14];
    const T = [0, 4.8, 2];
    const yaw = Math.atan2(c[0] - T[0], c[2] - T[2]);
    const pitch = -Math.atan2(c[1] - T[1], Math.hypot(c[0] - T[0], c[2] - T[2]));
    const distance = Math.hypot(c[0] - T[0], c[1] - T[1], c[2] - T[2]);
    for (const roll of [0, 0.3, -1]) {
      const camera = cam({ position: c, yaw, pitch, roll, fovV: 50, aspect: 0.75 });
      nearAll(projectPoint(camera, T), [0.5, 0.5, distance], 1e-12);
      const f = cameraForward(camera);
      nearAll(
        [0, 1, 2].map((k) => c[k] + distance * f[k]),
        T,
        1e-12,
      );
    }
  });
});

// ---- the thermal frames ---------------------------------------------------------------------------------

describe('skyCut', () => {
  it('is 8 K below the coldest measured surface, apparent readings aside', () => {
    const t = thermalOf([photo(1)], [21, 18, 25]);
    near(skyCut(t) as number, 10);
    t.surfaces[1].apparent = true; // a window's 18 °C is the sky's reflection
    near(skyCut(t) as number, 13);
  });

  it('is not dragged down by a mixed quad straddling the skyline, nor by a small sample', () => {
    // Walls of 31–33 °C, and a quad half on the gable, half on the sky: its median reads 12 °C.
    const t = thermalOf([photo(1)], [31, 12, 33, 32]);
    t.surfaces[1].mixed = true;
    t.surfaces[1].p10 = 2;
    t.surfaces[1].p90 = 33;
    near(skyCut(t) as number, 23); // the coldest wall, 31 °C, less 8 K — not 12 − 8
    t.surfaces.push({ ...t.surfaces[0], median: 16, n: 40, smallSample: true }); // a sliver at a window's edge
    near(skyCut(t) as number, 23);
  });

  it('falls back on the doubtful readings when there is nothing else', () => {
    const t = thermalOf([photo(1)], [20, 26, 30]);
    t.surfaces[0].mixed = true;
    t.surfaces[1].smallSample = true;
    t.surfaces[2].apparent = true; // glass is left out even then
    near(skyCut(t) as number, 12);
  });

  it('is null without a measured surface', () => {
    assert.equal(skyCut(null), null);
    assert.equal(skyCut(thermalOf([photo(1)])), null);
    const onlyGlass = thermalOf([photo(1)], [14]);
    onlyGlass.surfaces[0].apparent = true;
    assert.equal(skyCut(onlyGlass), null);
  });
});

describe('maskTemps', () => {
  // 4 × 4: an unreadable sky row, a cold band touching it on the left, a cold pocket low down.
  const grid = Float32Array.from(
    [
      [-30, -30, -30, -30],
      [5, 5, 20, 20],
      [20, 20, 20, 20],
      [20, 3, 20, 20],
    ].flat(),
  );
  const rows = (a: Float32Array) =>
    [0, 1, 2, 3].map((j) => Array.from(a.slice(4 * j, 4 * j + 4)).map((v) => (Number.isNaN(v) ? 'NaN' : v)));

  it('masks the sky a flood from the top reaches, one pixel wider, and keeps a cold pocket below', () => {
    const out = maskTemps(grid, 4, 4, 10);
    assert.deepEqual(rows(out), [
      ['NaN', 'NaN', 'NaN', 'NaN'],
      ['NaN', 'NaN', 'NaN', 'NaN'], // the cold band, and the pixels beside the sky grown into
      ['NaN', 'NaN', 'NaN', 20], // grown from the cold band above
      [20, 3, 20, 20], // not reached from the top: a surface
    ]);
  });

  it('masks only the unreadable pixels without a cut', () => {
    assert.deepEqual(rows(maskTemps(grid, 4, 4, null)), [
      ['NaN', 'NaN', 'NaN', 'NaN'],
      [5, 5, 20, 20],
      [20, 20, 20, 20],
      [20, 3, 20, 20],
    ]);
    const odd = maskTemps([NaN, -273.15, -100, -25, -19.5, Infinity, 0, 40], 8, 1, null);
    assert.deepEqual(
      Array.from(odd).map((v) => (Number.isNaN(v) ? 'NaN' : v)),
      ['NaN', 'NaN', 'NaN', 'NaN', -19.5, 'NaN', 0, 40],
    );
  });

  it('returns a new array and never writes the shared frame', () => {
    const before = Array.from(grid);
    const out = maskTemps(grid, 4, 4, 10);
    assert.ok(out instanceof Float32Array);
    assert.notEqual(out, grid);
    assert.deepEqual(Array.from(grid), before);
  });

  it('cuts a real frame at the skyline, one row below the sky band', () => {
    const temps = new Float32Array(THERMAL_W * THERMAL_H).fill(20);
    for (let i = 0; i < 10 * THERMAL_W; i++) temps[i] = -10; // rows 0–9: sky, readable but cold
    const out = maskTemps(temps, THERMAL_W, THERMAL_H, 12);
    assert.ok(Number.isNaN(out[10 * THERMAL_W + 60]), 'the row under the sky is grown into');
    assert.equal(out[11 * THERMAL_W + 60], 20);
    assert.equal(out.filter((v) => Number.isNaN(v)).length, 11 * THERMAL_W);
  });
});

describe('photoLabel', () => {
  it('says the stored number with the picture word', () => {
    assert.equal(photoLabel(3, 'photo'), 'photo 3');
    assert.equal(photoLabel(34, 'frame'), 'frame 34');
  });
});

describe('projectionPhotos', () => {
  const grid = () => new Float32Array(THERMAL_W * THERMAL_H).fill(21);

  it('sends the registered photos with a decoded frame, in record order, with their registration', () => {
    const c1 = cam({ position: [0.3, 1.7, 15.5], yaw: 0.05, pitch: 0.1, fovV: 52, aspect: 0.75 });
    const t = thermalOf([
      photo(1, { registration: { dx: 3, dy: -2, score: 0.5 }, camera: c1 }),
      photo(2, { picture: 'render', registration: { dx: 5, dy: 5 }, camera: cam() }), // the render IS the grid
      photo(3, { camera: null, cameraNote: 'only 5 of 15 landmarks agree' }),
      // Its surfaces failed, its landmarks did not: the camera needs no traced surface, so it projects.
      photo(4, { status: 'model-failed', camera: cam() }),
      photo(5, { camera: cam() }), // no frame decoded
      photo(6, { camera: cam() }), // a frame of the wrong size
      photo(7, { camera: cam({ aspect: 9 }) }), // not a camera the frame can use
      photo(8, { status: 'no-frame', camera: cam() }), // never reached the model: a camera there is no fit
    ]);
    const g1 = grid();
    const temps = new Map([
      [1, g1],
      [2, grid()],
      [3, grid()],
      [4, grid()],
      [6, new Float32Array(10)],
      [7, grid()],
      [8, grid()],
    ]);
    const out = projectionPhotos(t, temps, 'photo');
    assert.deepEqual(
      out.map((p) => p.photo),
      [1, 2, 4],
    );
    const [a, b] = out;
    assert.equal(a.label, 'photo 1');
    assert.deepEqual(a.position, [0.3, 1.7, 15.5]);
    assert.deepEqual([a.yaw, a.pitch, a.roll, a.fovV, a.aspect], [0.05, 0.1, 0, 52, 0.75]);
    assert.deepEqual([a.dx, a.dy, a.w, a.h], [3, -2, 120, 160]);
    assert.equal(a.temps, g1, 'the masked grid itself, not a copy');
    assert.deepEqual([b.dx, b.dy], [0, 0]);
    assert.deepEqual(Object.keys(a).sort(), [
      'aspect',
      'dx',
      'dy',
      'fovV',
      'h',
      'label',
      'photo',
      'pitch',
      'position',
      'roll',
      'temps',
      'w',
      'yaw',
    ]);
  });

  it('labels frames of a walk-around, and sends at most as many photos as the frame holds', () => {
    const photos = Array.from({ length: 11 }, (_, i) => photo(10 + i, { camera: cam() }));
    const temps = new Map(photos.map((p) => [p.photo, grid()] as [number, Float32Array]));
    const out = projectionPhotos(thermalOf(photos), temps, 'frame');
    assert.equal(out.length, TWIN_PROJECTION_MAX);
    assert.equal(out[0].label, 'frame 10');
    assert.deepEqual(projectionPhotos(null, temps, 'frame'), []);
  });
});

// ---- what the panel says, and where it looks from -------------------------------------------------------

describe('registeredPhotos and registrationSummary', () => {
  const t = thermalOf([
    photo(1, { camera: cam() }),
    photo(2, { camera: null, cameraNote: 'only 5 of 15 landmarks agree' }),
    photo(3, { landmarks: [], camera: null }),
    photo(4), // a photo of an older record: never tried, not a failure
    photo(5, { status: 'model-failed', camera: null, cameraNote: 'landmark model failed: timed out after 150s' }),
    photo(6, { camera: cam({ fovV: 400 }) }),
    photo(7, { status: 'model-failed', camera: cam() }), // the surfaces failed, the camera was fitted
    photo(8, { status: 'unreadable', camera: null, cameraNote: 'never sent' }), // never reached the model
  ]);

  it('counts the photos that reached the model and the registered ones, and says why the others are not', () => {
    assert.deepEqual(
      registeredPhotos(t).map((r) => r.photo.photo),
      [1, 7],
    );
    assert.deepEqual(registrationSummary(t, 'photo'), {
      registered: 2,
      traced: 7,
      failures: [
        'photo 2: only 5 of 15 landmarks agree',
        'photo 3: no landmarks were found',
        'photo 5: landmark model failed: timed out after 150s',
        'photo 6: the fitted camera is not usable',
      ],
    });
    assert.deepEqual(registrationSummary(null, 'frame'), { registered: 0, traced: 0, failures: [] });
  });

  it('never registers more photos than reached the model', () => {
    // Every surface call failed and every landmark call fitted a camera: "2 of 2", not "2 of 0".
    const allFailed = thermalOf([
      photo(1, { status: 'model-failed', camera: cam() }),
      photo(2, { status: 'model-failed', camera: cam() }),
    ]);
    assert.deepEqual(registrationSummary(allFailed, 'photo'), { registered: 2, traced: 2, failures: [] });
  });

  it('owns up to landmarks the camera could not be fitted to, in the picture word', () => {
    const lm = { part: 'house', what: 'corner', x: 1, y: 0, z: 1, u: 0.5, v: 0.5, inlier: false };
    const s = registrationSummary(thermalOf([photo(34, { landmarks: [lm, lm, lm], camera: null })]), 'frame');
    assert.deepEqual(s.failures, ['frame 34: the camera could not be fitted to its 3 landmarks']);
  });
});

describe('predatesProjection', () => {
  it('holds for traced photos none of which went through the landmark call', () => {
    assert.equal(predatesProjection(thermalOf([photo(1), photo(2)])), true);
    assert.equal(predatesProjection(thermalOf([photo(1), photo(2, { camera: null })])), false);
    assert.equal(predatesProjection(thermalOf([photo(1), photo(2, { cameraNote: 'too few landmarks (3)' })])), false);
    assert.equal(predatesProjection(thermalOf([photo(1, { landmarks: [] })])), false);
    assert.equal(predatesProjection(thermalOf([photo(1, { status: 'no-frame' })])), false);
    assert.equal(predatesProjection(null), false);
  });
});

describe('viewFromCamera', () => {
  it("aims along the camera's axis as far as the middle of the built model, with its lens", () => {
    const c = cam({ position: [0, 1.7, 15], fovV: 52 });
    const v = viewFromCamera(c, [
      { min: [-5, 0, -5], max: [1, 10, 5] },
      { min: [-1, 0, -2], max: [5, 4, 1] },
    ]);
    const distance = Math.hypot(0, 5 - 1.7, 15); // to the union's centre (0, 5, 0)
    assert.equal(v.type, 'view');
    nearAll([v.x, v.y, v.z], [0, 1.7, 15]);
    nearAll([v.targetX, v.targetY, v.targetZ], [0, 1.7, 15 - distance]);
    assert.equal(v.fov, 52);
  });

  it('aims 10 m out before anything is built', () => {
    const v = viewFromCamera(cam({ yaw: 90 * DEG }), []);
    nearAll([v.targetX, v.targetY, v.targetZ], [-10, 0, 0]);
  });
});
