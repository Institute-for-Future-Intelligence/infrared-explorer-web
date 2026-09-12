import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAMERA_INLIER_TOL,
  CAMERA_MAX_RMS,
  TWIN_LANDMARK_JSON_SCHEMA,
  TWIN_LANDMARK_MAX,
  buildTwinLandmarkPrompt,
  fitPhotoCamera,
  parseTwinLandmarks,
  projectWithCamera,
  type CameraHint,
  type CameraLandmark,
  type TwinPhotoCamera,
} from './twinCamera';
import { TWIN_SURFACE_CODE_CHARS, describeViewpoint, type TwinBuildingPart } from './twinBuilding';

const DEG = Math.PI / 180;

/** Strict mode: every property required, no additionalProperties, no numeric range keywords. */
const walkStrict = (node: any, path: string) => {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'object') {
    assert.equal(node.additionalProperties, false, `${path} additionalProperties`);
    const keys = Object.keys(node.properties ?? {});
    assert.deepEqual([...(node.required ?? [])].sort(), [...keys].sort(), `${path} required`);
    for (const k of keys) walkStrict(node.properties[k], `${path}.${k}`);
  }
  if (node.type === 'array') walkStrict(node.items, `${path}[]`);
  for (const bad of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'])
    assert.ok(!(bad in node), `${path} uses ${bad}`);
};

/** A deterministic generator in [0, 1). */
const lcg = (seed: number) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

/** The eight corners of a box as api.box builds it: w × h × d, its BOTTOM face centred at (x, y, z). */
const boxCorners = (w: number, h: number, d: number, x: number, y: number, z: number): number[][] => {
  const out: number[][] = [];
  for (const sx of [-1, 1])
    for (const yy of [y, y + h]) for (const sz of [-1, 1]) out.push([x + (sx * w) / 2, yy, z + (sz * d) / 2]);
  return out;
};

/** A camera at `c` looking at `t` — the look-at pose as SPEC §1 writes it. */
const lookAtCamera = (c: number[], t: number[], fovV = 50, aspect = 0.75, roll = 0): TwinPhotoCamera => ({
  position: c,
  yaw: Math.atan2(c[0] - t[0], c[2] - t[2]),
  pitch: -Math.atan2(c[1] - t[1], Math.hypot(c[0] - t[0], c[2] - t[2])),
  roll,
  fovV,
  aspect,
  rms: 0,
  inliers: 0,
});

/** What a camera sees of `points`, each picture position moved by up to ±`noise` picture heights. */
const observe = (camera: TwinPhotoCamera, points: number[][], noise: number, seed: number): CameraLandmark[] => {
  const rnd = lcg(seed);
  return points.map((p) => {
    const [u, v, depth] = projectWithCamera(camera, p);
    assert.ok(depth > 0 && u > 0 && u < 1 && v > 0 && v < 1, `synthetic point ${p} is in view`);
    return {
      x: p[0],
      y: p[1],
      z: p[2],
      u: u + (noise * (2 * rnd() - 1)) / camera.aspect,
      v: v + noise * (2 * rnd() - 1),
    };
  });
};

const distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const closeTo = (actual: number, expected: number, tol: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} vs ${expected} (±${tol})`);

describe('projectWithCamera', () => {
  const cam = (over: Partial<TwinPhotoCamera>): TwinPhotoCamera => ({
    position: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    roll: 0,
    fovV: 90, // f = 0.5 picture heights
    aspect: 0.75,
    rms: 0,
    inliers: 0,
    ...over,
  });
  const near = (got: number[], want: number[]) =>
    got.forEach((g, i) => assert.ok(Math.abs(g - want[i]) < 1e-9, `[${got}] vs [${want}]`));

  it('projects along −z with +y up, u right and v down, in fractions of the picture', () => {
    // Camera space (1, 0.5, −2): depth 2; u = (0.375 + 0.5·1/2) / 0.75, v = 0.5 − 0.5·0.5/2.
    near(projectWithCamera(cam({}), [1, 0.5, -2]), [0.625 / 0.75, 0.375, 2]);
    near(projectWithCamera(cam({ position: [1, 2, 3] }), [1, 2, 1]), [0.5, 0.5, 2]);
    assert.ok(projectWithCamera(cam({}), [0, 0, 2])[2] < 0, 'a point behind has a negative depth');
  });

  it('turns by yaw (about +y), pitch (about x) and roll (about the view) as three.js YXZ does', () => {
    // Yawed 90°: it looks along −x, and its right is −z.
    near(projectWithCamera(cam({ yaw: Math.PI / 2 }), [-2, 0, 0]), [0.5, 0.5, 2]);
    near(projectWithCamera(cam({ yaw: Math.PI / 2 }), [-2, 0, -1]), [0.625 / 0.75, 0.5, 2]);
    // Pitched up 30°: forward is (0, sin 30°, −cos 30°).
    near(projectWithCamera(cam({ pitch: 30 * DEG }), [0, 1, -Math.sqrt(3)]), [0.5, 0.5, 2]);
    // Rolled 90°: the camera's up is the world's −x, so a point to the world's left is high in the picture.
    near(projectWithCamera(cam({ roll: Math.PI / 2 }), [-1, 0, -2]), [0.5, 0.25, 2]);
  });

  it('puts a look-at target in the middle of the picture, whatever the roll, along the stated forward', () => {
    for (const [c, t] of [
      [
        [7, 1.7, 22],
        [0, 3, 0],
      ],
      [
        [-9, 12, -4],
        [1, 0.5, 2],
      ],
    ]) {
      for (const roll of [0, 0.3]) {
        const camera = lookAtCamera(c, t, 50, 0.75, roll);
        near(projectWithCamera(camera, t), [0.5, 0.5, distance(c, t)]);
        const f = [
          -Math.sin(camera.yaw) * Math.cos(camera.pitch),
          Math.sin(camera.pitch),
          -Math.cos(camera.yaw) * Math.cos(camera.pitch),
        ];
        near(projectWithCamera(camera, [c[0] + f[0], c[1] + f[1], c[2] + f[2]]), [0.5, 0.5, 1]);
      }
    }
  });
});

describe('TWIN_LANDMARK_JSON_SCHEMA', () => {
  it('is strict-mode shaped: landmarks of part/what/x/y/z/px/py', () => {
    walkStrict(TWIN_LANDMARK_JSON_SCHEMA, 'root');
    const item = TWIN_LANDMARK_JSON_SCHEMA.properties.landmarks.items;
    assert.deepEqual([...item.required].sort(), ['part', 'px', 'py', 'what', 'x', 'y', 'z']);
    assert.equal(item.properties.px.type, 'number');
  });
});

describe('buildTwinLandmarkPrompt', () => {
  const parts: TwinBuildingPart[] = [
    { name: 'mainBlock', kind: 'wall', description: 'the house' },
    { name: 'windows', kind: 'glass', description: '' },
  ];
  // A view with numbers found nowhere else in the prompt, so any that leaks in is caught.
  const view = { photo: 2, x: 13.7, y: 2.9, z: 41.3, targetX: 0.6, targetY: 5.2, targetZ: -3.4 };
  const ctx = {
    subject: 'a two-storey house',
    subjectKind: 'building' as const,
    parts,
    code: "const m = api.part('mainBlock', 'wall', 'the house');\nm.box(8, 6, 10, 0, 0, 0);",
    photo: 2,
    width: 1080,
    height: 1440,
    viewpoint: describeViewpoint(view),
  };

  it('asks for exact model corners over different depths, in pixels of the first picture', () => {
    const { system, user } = buildTwinLandmarkPrompt(ctx);
    assert.match(system, /PIXELS of the 1080×1440 visible photo/);
    assert.match(system, /DIFFERENT DEPTHS/);
    assert.match(system, /Prefer corners of boxes; never a point on a tree, a hedge/);
    assert.match(system, /BOTTOM face is centred at \(x, y, z\)/);
    assert.match(system, /api\.cylinder/);
    assert.match(system, /raw THREE\.Mesh sits centred on its position, then rotated, inside its part's group/);
    assert.match(system, /attached only to help you see edges; place every point on the visible photo/);
    assert.match(system, new RegExp(`At most ${TWIN_LANDMARK_MAX} landmarks`));
    assert.match(user, /Photo 2, 1080×1440 px \(the first picture\); its thermal render is the second picture/);
    assert.match(user, /- mainBlock — wall — the house\n- windows — glass\n/);
    assert.match(user, /Viewpoint: You judged this photo was taken from the subject's front, roughly level/);
    assert.match(user, /m\.box\(8, 6, 10, 0, 0, 0\)/);
  });

  it('gives the camera in words only — never a number of the view', () => {
    const { system, user } = buildTwinLandmarkPrompt(ctx);
    for (const n of ['13.7', '2.9', '41.3', '0.6', '5.2', '3.4'])
      assert.ok(!`${system}\n${user}`.includes(n), `the prompt leaks ${n}`);
  });

  it('names the picture it is given: a visible photo alone, or the render as the picture', () => {
    const alone = buildTwinLandmarkPrompt({ ...ctx, withRender: false });
    assert.match(alone.system, /\(a visible-light photo\)/);
    assert.doesNotMatch(alone.system, /attached only to help/);
    assert.match(alone.user, /\(the only picture\)/);
    const render = buildTwinLandmarkPrompt({ ...ctx, picture: 'render', width: 480, height: 640 });
    assert.match(render.system, /PIXELS of the 480×640 thermal render/);
    assert.match(render.user, /\(the thermal render is the picture\)/);
    const label = buildTwinLandmarkPrompt({ ...ctx, label: 'Photo 2 (recording frame 37)' });
    assert.match(label.user, /Photo 2 \(recording frame 37\), 1080×1440 px/);
  });

  it('cuts a long program like the surface prompt does', () => {
    const { user } = buildTwinLandmarkPrompt({ ...ctx, code: 'x'.repeat(TWIN_SURFACE_CODE_CHARS + 50) });
    assert.match(user, /cut here: the rest of the program is omitted for length/);
    assert.ok(!user.includes('x'.repeat(TWIN_SURFACE_CODE_CHARS + 1)));
  });
});

describe('parseTwinLandmarks', () => {
  const parts: TwinBuildingPart[] = [{ name: 'mainBlock', kind: 'wall', description: '' }];
  const W = 1000;
  const H = 2000;

  it('reads the schema shape: pixels to fractions, the part canonical, coordinates rounded', () => {
    const text = JSON.stringify({
      landmarks: [
        { part: 'Main Block', what: 'gable apex', x: 0.12345, y: 10.9, z: 3.4, px: 486, py: 253 },
        { part: ' porch ', what: 'porch corner', x: -4.15, y: 4.21, z: 5.93, px: 139.5, py: 776 },
      ],
    });
    const { landmarks, errors } = parseTwinLandmarks(text, parts, W, H);
    assert.deepEqual(errors, []);
    assert.deepEqual(landmarks, [
      { part: 'mainBlock', what: 'gable apex', x: 0.123, y: 10.9, z: 3.4, u: 0.486, v: 0.1265 },
      { part: 'porch', what: 'porch corner', x: -4.15, y: 4.21, z: 5.93, u: 0.1395, v: 0.388 },
    ]);
  });

  it('takes the other shapes: a bare array, points / correspondences, world / position, pixel / image, u / v', () => {
    const bare = parseTwinLandmarks(
      '```json\n[{"part": "mainBlock", "what": "a", "world": [1, 2, 3], "pixel": [100, 200]}]\n```',
      parts,
      W,
      H,
    );
    assert.deepEqual(bare.landmarks, [{ part: 'mainBlock', what: 'a', x: 1, y: 2, z: 3, u: 0.1, v: 0.1 }]);
    const points = parseTwinLandmarks(
      JSON.stringify({ points: [{ label: 'b', position: { x: 1, y: 2, z: 3 }, image: { x: 500, y: 1000 } }] }),
      parts,
      W,
      H,
    );
    assert.deepEqual(points.landmarks, [{ part: '', what: 'b', x: 1, y: 2, z: 3, u: 0.5, v: 0.5 }]);
    // Every position ≤ 1.05: the answer is in fractions already.
    const fractions = parseTwinLandmarks(
      JSON.stringify({
        correspondences: [
          { part: 'mainBlock', what: 'c', x: 1, y: 2, z: 3, u: 0.25, v: 0.75 },
          { part: 'mainBlock', what: 'd', x: 4, y: 5, z: 6, u: 1.02, v: -0.01 },
        ],
      }),
      parts,
      W,
      H,
    );
    assert.deepEqual(
      fractions.landmarks.map((l) => [l.u, l.v]),
      [
        [0.25, 0.75],
        [1.02, -0.01],
      ],
    );
  });

  it('reads fractions or pixels by the majority, the stragglers of the other reading dropped', () => {
    // An answer of one landmark per picture position, each at its own model point.
    const read = (...qs: number[][]) =>
      parseTwinLandmarks(
        JSON.stringify({ landmarks: qs.map(([px, py], i) => ({ what: `p${i}`, x: i, y: 0, z: 0, px, py })) }),
        parts,
        W,
        H,
      );
    const uv = (r: ReturnType<typeof parseTwinLandmarks>) => r.landmarks.map((l) => [l.u, l.v]);
    // Fractions, one point a little past the right edge: still fractions — that one lies off the picture.
    const fractions = read([0.25, 0.75], [0.5, 0.5], [1.08, 0.8]);
    assert.deepEqual(uv(fractions), [
      [0.25, 0.75],
      [0.5, 0.5],
    ]);
    assert.deepEqual(fractions.errors, ['landmarks[2] lies outside the picture → dropped']);
    // Pixels, one entry that reads like a fraction: still pixels — that one sits in the top-left corner, where
    // the fit finds that it disagrees.
    const pixels = read([250, 1500], [500, 1000], [0.5, 1]);
    assert.deepEqual(uv(pixels), [
      [0.25, 0.75],
      [0.5, 0.5],
      [0.0005, 0.0005],
    ]);
    assert.deepEqual(pixels.errors, []);
    // Half and half is no majority: pixels.
    const tie = read([0.3, 0.8], [0.6, 0.4], [250, 1500], [500, 1000]);
    assert.deepEqual(uv(tie), [
      [0.0003, 0.0004],
      [0.0006, 0.0002],
      [0.25, 0.75],
      [0.5, 0.5],
    ]);
  });

  it('drops what cannot be a landmark, with a reason each', () => {
    const text = `{"landmarks": [
      "a string",
      {"what": "no z", "x": 1, "y": 2, "px": 10, "py": 10},
      {"what": "no pixel", "x": 1, "y": 2, "z": 3},
      {"what": "infinite", "x": 1e999, "y": 2, "z": 3, "px": 10, "py": 10},
      {"what": "far out", "x": 20000, "y": 2, "z": 3, "px": 10, "py": 10},
      {"what": "off the picture", "x": 1, "y": 2, "z": 3, "px": -80, "py": 10},
      {"what": "kept", "x": 1, "y": 2, "z": 3, "px": 10, "py": 10},
      {"what": "repeat", "x": 1.0001, "y": 2, "z": 3, "px": 50, "py": 50}
    ]}`;
    const { landmarks, errors } = parseTwinLandmarks(text, parts, W, H);
    assert.deepEqual(
      landmarks.map((l) => l.what),
      ['kept'],
    );
    assert.equal(errors.length, 7);
    assert.match(errors[0], /landmarks\[0\] is not an object/);
    assert.match(errors[1], /landmarks\[1\] has no finite model point/);
    assert.match(errors[2], /landmarks\[2\] has no finite picture position/);
    assert.match(errors[3], /landmarks\[3\] has no finite model point/);
    assert.match(errors[4], /landmarks\[4\] lies implausibly far out/);
    assert.match(errors[5], /landmarks\[5\] lies outside the picture/);
    assert.match(errors[6], /landmarks\[7\] repeats the model point of landmarks\[6\]/);
  });

  it('cuts long names and caps the list at TWIN_LANDMARK_MAX', () => {
    const many = Array.from({ length: TWIN_LANDMARK_MAX + 5 }, (_, i) => ({
      part: 'p'.repeat(70),
      what: 'w'.repeat(90),
      x: i,
      y: 0,
      z: 0,
      px: 10 + i,
      py: 10,
    }));
    const { landmarks, errors } = parseTwinLandmarks(JSON.stringify({ landmarks: many }), parts, W, H);
    assert.equal(landmarks.length, TWIN_LANDMARK_MAX);
    assert.equal(landmarks[0].part.length, 60);
    assert.equal(landmarks[0].what.length, 80);
    assert.deepEqual(errors, [`5 landmarks past the cap of ${TWIN_LANDMARK_MAX} → dropped`]);
  });

  it('says why an answer holds nothing', () => {
    assert.deepEqual(parseTwinLandmarks('no idea', parts, W, H).errors, ['no JSON in the answer']);
    assert.match(parseTwinLandmarks('{"landmarks": [}', parts, W, H).errors[0], /^JSON\.parse failed/);
    assert.deepEqual(parseTwinLandmarks('{"surfaces": []}', parts, W, H).errors, ['the answer holds no landmark list']);
    assert.deepEqual(parseTwinLandmarks('{"landmarks": []}', parts, W, H), { landmarks: [], errors: [] });
  });
});

describe('fitPhotoCamera — synthetic', () => {
  // A house-sized block (8 × 6 × 10 m) and a porch in front of it; the photo from the front-right.
  const block = boxCorners(8, 6, 10, 0, 0, 0);
  const porch = boxCorners(6, 3, 2, 0, 0, 6);
  const truth = lookAtCamera([7, 1.7, 22], [0, 3, 0], 50, 0.75, 1 * DEG);
  // Phase 1's rough guess of the same view: metres off, the right side.
  const hint: CameraHint = { position: [5, 1.6, 18], target: [0, 4, 0] };
  const away = distance(truth.position, [0, 3, 0]);

  const expectRecovered = (camera: TwinPhotoCamera | null, posShare = 0.03, angleDeg = 1.5) => {
    assert.ok(camera, 'a camera');
    const off = distance(camera.position, truth.position);
    assert.ok(off <= posShare * away, `position off by ${off.toFixed(2)} m of ${away.toFixed(1)}`);
    closeTo(camera.yaw, truth.yaw, angleDeg * DEG, 'yaw');
    closeTo(camera.pitch, truth.pitch, angleDeg * DEG, 'pitch');
  };

  it("recovers a known camera from a box's corners with 1 % noise, with and without a hint", () => {
    for (const seed of [1, 2, 3]) {
      const lms = observe(truth, block, 0.01, seed);
      for (const h of [hint, null]) {
        const fit = fitPhotoCamera(lms, 0.75, h);
        assert.equal(fit.reason, null);
        expectRecovered(fit.camera);
        assert.equal(fit.camera!.inliers, 8);
        assert.deepEqual(fit.inliers, new Array(8).fill(true));
        assert.ok(fit.camera!.rms < 0.01);
        closeTo(fit.camera!.fovV, 50, 2, 'fovV');
      }
    }
  });

  it('flags 30 % gross outliers and fits the rest', () => {
    for (const seed of [1, 2, 3]) {
      const lms = observe(truth, [...block, ...porch], 0.01, seed);
      const rnd = lcg(100 + seed);
      const bad = new Set<number>();
      while (bad.size < 5) bad.add(Math.floor(rnd() * lms.length));
      for (const i of bad) {
        const angle = rnd() * 2 * Math.PI;
        const size = 0.1 + 0.2 * rnd(); // 10–30 % of the picture height
        lms[i] = { ...lms[i], u: lms[i].u + (Math.cos(angle) * size) / 0.75, v: lms[i].v + Math.sin(angle) * size };
      }
      const fit = fitPhotoCamera(lms, 0.75, hint);
      expectRecovered(fit.camera);
      fit.inliers.forEach((ok, i) => assert.equal(ok, !bad.has(i), `landmark ${i}`));
      assert.equal(fit.camera!.inliers, 11);
    }
  });

  it('fits coplanar points (one facade and its windows) with a hint', () => {
    const facade = [
      ...[
        [-4, 0],
        [4, 0],
        [4, 6],
        [-4, 6],
      ],
      ...[-2.5, 1].flatMap((x0) => [
        [x0, 2],
        [x0 + 1.5, 2],
        [x0 + 1.5, 3.5],
        [x0, 3.5],
      ]),
    ].map(([x, y]) => [x, y, 5]);
    const fit = fitPhotoCamera(observe(truth, facade, 0.01, 1), 0.75, hint);
    assert.equal(fit.reason, null);
    assert.equal(fit.camera!.inliers, facade.length);
    assert.ok(fit.camera!.rms < 0.01);
    expectRecovered(fit.camera, 0.05, 2);
  });

  it('refuses five landmarks, and a set the model disagrees with', () => {
    const five = fitPhotoCamera(observe(truth, block.slice(0, 5), 0, 1), 0.75, hint);
    assert.equal(five.camera, null);
    assert.equal(five.reason, 'too few landmarks (5)');
    assert.deepEqual(five.inliers, new Array(5).fill(false));
    assert.equal(five.rms, null);
    // Every landmark up to 12 % of the picture off, at random: no camera agrees with enough of them.
    const scattered = fitPhotoCamera(observe(truth, [...block, ...porch], 0.12, 4), 0.75, hint);
    assert.equal(scattered.camera, null);
    assert.match(scattered.reason!, /^only \d+ of 16 landmarks agree$|^the landmarks disagree with the model by/);
    assert.ok(scattered.inliers.every((ok) => !ok));
  });

  it('refuses a camera with more than a quarter of all the landmarks behind it', () => {
    // Points of the model behind the photographer and off to the sides, which the tracer placed in the
    // picture all the same: the camera that took the picture cannot have them behind it.
    const behind = [
      [20, 8, 30],
      [-6, 10, 32],
      [25, 2, 26],
      [-10, 1, 30],
      [15, 12, 28],
      [0, 9, 35],
    ];
    const placed = [
      [0.2, 0.3],
      [0.8, 0.2],
      [0.5, 0.92],
      [0.1, 0.7],
      [0.9, 0.6],
      [0.4, 0.1],
    ];
    for (const p of behind) assert.ok(projectWithCamera(truth, p)[2] < 0, `${p} lies behind the camera`);
    const withBehind = (good: number, bad: number, seed: number): CameraLandmark[] => [
      ...observe(truth, [...block, ...porch].slice(0, good), 0.01, seed),
      ...behind.slice(0, bad).map(([x, y, z], k) => ({ x, y, z, u: placed[k][0], v: placed[k][1] })),
    ];
    for (const seed of [1, 2, 3]) {
      // Six of 16 behind: refused, though the ten others agree with the camera to 1 % of the picture.
      const six = fitPhotoCamera(withBehind(10, 6, seed), 0.75, hint);
      assert.equal(six.camera, null);
      assert.equal(six.reason, 'implausible camera: 6 of 16 landmarks fall behind it');
      assert.equal(six.agreeing, 10);
      assert.ok(six.inliers.every((ok) => !ok));
      // Four of 16 — a quarter — is what a few misplaced landmarks may do: the camera stands.
      const four = fitPhotoCamera(withBehind(12, 4, seed), 0.75, hint);
      assert.equal(four.reason, null);
      expectRecovered(four.camera);
      assert.equal(four.camera!.inliers, 12);
    }
  });

  it('refuses landmarks bunched in one spot of the picture: they fix a direction, not a distance', () => {
    const points = [...block, ...porch];
    // Every landmark on one pixel; and a fractions answer misread as pixels (every position divided by the
    // picture's size, so all of them crowd into its top-left corner). A camera far enough away along the
    // line of sight "agrees" with every one of them.
    const onePixel = points.map(([x, y, z]) => ({ x, y, z, u: 0.5, v: 0.48 }));
    const misread = observe(truth, points, 0.01, 1).map((l) => ({ ...l, u: l.u / 1080, v: l.v / 1440 }));
    for (const lms of [onePixel, misread]) {
      const fit = fitPhotoCamera(lms, 0.75, hint);
      assert.equal(fit.camera, null);
      assert.equal(fit.reason, 'the landmarks cover too little of the picture');
      assert.ok(fit.agreeing >= 12, `${fit.agreeing} agree`);
    }
  });

  it('holds the camera to no side when the hint looks steeply down: its ground direction is noise', () => {
    // A desk seen from above: a laptop's base and its screen, a monitor behind them.
    const desk = [
      ...boxCorners(0.34, 0.02, 0.24, 0, 0.75, -1),
      ...boxCorners(0.34, 0.22, 0.01, 0, 0.77, -1.12),
      ...boxCorners(0.6, 0.35, 0.05, 0.5, 1.1, -1.3),
    ];
    const target = [0.2, 0.9, -1.1];
    const above = lookAtCamera([0.2, 2.4, 0.3], target, 50, 0.75, 1 * DEG);
    // Phase 1 judged the view right — from above, looking down at 76° — but put its target on the camera's
    // side of the desk, so its ground direction points 163° away from the side the camera is on. Held to
    // that side (within 40°, then ±20°), the fit came out 6–8° of yaw and 8–10 % of the distance off.
    const steep: CameraHint = { position: [0.15, 2.3, 0.2], target: [0, 0.2, 0.7] };
    for (const seed of [1, 2, 3]) {
      const fit = fitPhotoCamera(observe(above, desk, 0.01, seed), 0.75, steep);
      assert.equal(fit.reason, null);
      const c = fit.camera!;
      const off = distance(c.position, above.position);
      assert.ok(off <= 0.03 * distance(above.position, target), `position off by ${off.toFixed(3)} m`);
      closeTo(c.yaw, above.yaw, 1.5 * DEG, 'yaw');
      closeTo(c.pitch, above.pitch, 1.5 * DEG, 'pitch');
      assert.equal(c.inliers, desk.length);
    }
  });

  it('returns the camera as the record stores it, reprojecting its own inliers', () => {
    const lms = observe(truth, [...block, ...porch], 0.01, 7);
    const fit = fitPhotoCamera(lms, 0.75, hint);
    const c = fit.camera!;
    const stored = (v: number, per: number) => assert.equal(v, Math.round(v * per) / per);
    c.position.forEach((v) => stored(v, 1000));
    [c.yaw, c.pitch, c.roll, c.rms, c.aspect].forEach((v) => stored(v, 1e4));
    stored(c.fovV, 100);
    assert.equal(c.position.length, 3);
    assert.ok(c.yaw > -Math.PI && c.yaw <= Math.PI);
    let sum = 0;
    lms.forEach((l, i) => {
      const [u, v, depth] = projectWithCamera(c, [l.x, l.y, l.z]);
      const e = Math.hypot((u - l.u) * c.aspect, v - l.v);
      assert.ok(depth > 0);
      assert.equal(fit.inliers[i], e < CAMERA_INLIER_TOL);
      if (fit.inliers[i]) sum += e * e;
    });
    closeTo(c.rms, Math.sqrt(sum / c.inliers), 1e-4, 'rms');
    // Deterministic: the same answer fits the same camera.
    assert.deepEqual(fitPhotoCamera(lms, 0.75, hint), fit);
  });
});

describe('fitPhotoCamera — real landmark answers (GPT-5.6, 2026-09-11)', () => {
  interface Fixture {
    width: number;
    height: number;
    view: { x: number; y: number; z: number; targetX: number; targetY: number; targetZ: number };
    answer: unknown;
  }
  const load = (name: string): Fixture =>
    JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'twinLandmarks', `${name}.json`), 'utf8'));
  const fit = (name: string) => {
    const f = load(name);
    const { landmarks, errors } = parseTwinLandmarks(JSON.stringify(f.answer), [], f.width, f.height);
    assert.deepEqual(errors, []);
    const hint = { position: [f.view.x, f.view.y, f.view.z], target: [f.view.targetX, f.view.targetY, f.view.targetZ] };
    const started = performance.now();
    const result = fitPhotoCamera(landmarks, f.width / f.height, hint);
    return { landmarks, result, ms: performance.now() - started };
  };

  // The experiment's fits of the same answers (camfit2.mts): inliers 14/15, 10/16, 13/17 at 23, 19 and 29 px
  // of 1440, the camera about where these positions say. The port must do at least as well.
  const experiment: Record<string, { inliers: number; position: number[] }> = {
    'house-1': { inliers: 14, position: [-0.63, 3.42, 23.76] },
    'house-2': { inliers: 10, position: [10.25, 4.0, 20.86] },
    'house-3': { inliers: 13, position: [-4.24, 3.16, 25.28] },
  };
  for (const [name, expected] of Object.entries(experiment)) {
    it(`registers ${name}`, (t) => {
      const { landmarks, result, ms } = fit(name);
      t.diagnostic(`${landmarks.length} landmarks fitted in ${ms.toFixed(0)} ms`);
      const c = result.camera;
      assert.ok(c, `${name}: ${result.reason}`);
      assert.ok(c.inliers >= 10, `${c.inliers} inliers`);
      assert.ok(c.inliers >= expected.inliers, `${c.inliers} inliers, the experiment had ${expected.inliers}`);
      assert.ok(c.rms < CAMERA_MAX_RMS, `rms ${c.rms}`);
      assert.equal(result.inliers.filter(Boolean).length, c.inliers);
      assert.ok(distance(c.position, expected.position) < 0.1, `camera at ${c.position}`);
      closeTo(c.fovV, 50, 4, 'fovV');
    });
  }

  it('refuses frame 19 of the walk-around car: its program is too far from the car', (t) => {
    const { landmarks, result, ms } = fit('car-19');
    t.diagnostic(`${landmarks.length} landmarks fitted in ${ms.toFixed(0)} ms`);
    assert.equal(result.camera, null);
    assert.match(result.reason!, /^only \d+ of 15 landmarks agree$/);
    assert.ok(result.agreeing < 7);
    assert.ok(result.inliers.every((ok) => !ok));
  });

  // House photo 1's answer rewritten the ways a provider might garble it.
  const house1 = () => {
    const f = load('house-1');
    const entries = (f.answer as { landmarks: { px: number; py: number }[] }).landmarks;
    const hint: CameraHint = {
      position: [f.view.x, f.view.y, f.view.z],
      target: [f.view.targetX, f.view.targetY, f.view.targetZ],
    };
    const parse = (list: object[]) => parseTwinLandmarks(JSON.stringify({ landmarks: list }), [], f.width, f.height);
    return { f, entries, hint, parse, aspect: f.width / f.height };
  };

  it('fits house photo 1 answered in fractions, one point past the edge, exactly as the pixel answer', () => {
    const { entries, hint, parse, aspect } = house1();
    const pixels = parse(entries);
    const fractions = entries.map((l) => ({ ...l, px: l.px / 1080, py: l.py / 1440 }));
    assert.deepEqual(parse(fractions), pixels);
    // One point at 1.08 of the width: the answer is still read as fractions, and that point dropped — read as
    // pixels, every landmark would crowd into the top-left pixel.
    const straggler = { part: 'mainBlock', what: 'past the right edge', x: 20, y: 0, z: 0, px: 1.08, py: 0.8 };
    const garbled = parse([...fractions, straggler]);
    assert.deepEqual(garbled.landmarks, pixels.landmarks);
    assert.deepEqual(garbled.errors, [`landmarks[${fractions.length}] lies outside the picture → dropped`]);
    const fit = fitPhotoCamera(garbled.landmarks, aspect, hint);
    assert.ok(fit.camera, `${fit.reason}`);
    assert.deepEqual(fit, fitPhotoCamera(pixels.landmarks, aspect, hint));
  });

  it('refuses house photo 1 with every landmark put on one pixel', () => {
    const { entries, hint, parse, aspect } = house1();
    const { landmarks } = parse(entries.map((l) => ({ ...l, px: 540, py: 700 })));
    assert.equal(landmarks.length, entries.length);
    const fit = fitPhotoCamera(landmarks, aspect, hint);
    assert.equal(fit.camera, null);
    assert.equal(fit.reason, 'the landmarks cover too little of the picture');
  });
});
