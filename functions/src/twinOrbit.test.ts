import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORBIT_FIXED_CAMERA_MAX_SHIFT_PX,
  ORBIT_GRID_HEIGHT,
  ORBIT_GRID_WIDTH,
  ORBIT_LUMA_HEIGHT,
  ORBIT_LUMA_WIDTH,
  ORBIT_MIN_SHIFT_PX,
  ORBIT_SEARCH_PX,
  laplacianVariance,
  selectOrbitFrames,
  standpointDistance,
  thermalEdgeMap,
  totalMotion,
  visibleLuma,
  type OrbitCandidate,
} from './twinOrbit';
import type { Gray } from './twinRegistration';

const W = ORBIT_GRID_WIDTH;
const H = ORBIT_GRID_HEIGHT;

/** A pair of pictures as standpointDistance compares them; no luma unless given. */
const view = (edges: Float32Array, luma: Float32Array | null = null) => ({ edges, luma });

/** A thermal frame of a lab scene — a warm beaker, a hot burner disc, a table edge — moved by `shift`
 *  thermal px. `variant` 1 is a different scene (the same features elsewhere, plus a second block). */
function thermalScene(shift: [number, number] = [0, 0], variant = 0): Float32Array {
  const t = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = x - shift[0];
      const gy = y - shift[1];
      let c = 21;
      if (variant === 0) {
        if (gy > 105) c = 23;
        if (gx > 40 && gx < 75 && gy > 45 && gy < 105) c = 60;
        if (Math.hypot(gx - 95, gy - 90) < 12) c = 180;
      } else {
        if (gx > 70) c = 24;
        if (gx > 10 && gx < 35 && gy > 20 && gy < 60) c = 55;
        if (gx > 50 && gx < 110 && gy > 120 && gy < 150) c = 35;
        if (Math.hypot(gx - 30, gy - 130) < 9) c = 150;
      }
      t[y * W + x] = c;
    }
  }
  return t;
}

/** A grey "photo" with sharp edges, optionally box-blurred. */
function photo(width: number, height: number, blur = 0): Gray {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let v = 100;
      if ((Math.floor(x / 12) + Math.floor(y / 12)) % 2 === 0) v = 180;
      if (x > width * 0.3 && x < width * 0.6 && y > height * 0.3 && y < height * 0.7) v = 30;
      data[y * width + x] = v;
    }
  if (!blur) return { data, width, height };
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let s = 0;
      let n = 0;
      for (let yy = Math.max(0, y - blur); yy <= Math.min(height - 1, y + blur); yy++)
        for (let xx = Math.max(0, x - blur); xx <= Math.min(width - 1, x + blur); xx++) {
          s += data[yy * width + xx];
          n++;
        }
      out[y * width + x] = s / n;
    }
  return { data: out, width, height };
}

const candidate = (
  index: number,
  temps: Float32Array,
  sharpness = 100,
  luma: Float32Array | null = null,
): OrbitCandidate => ({
  index,
  sharpness,
  edges: thermalEdgeMap(temps),
  luma,
});

/**
 * A walk around a kettle on a hot plate, seen from azimuth `theta` (radians) — the case the thermal
 * edges alone cannot tell apart. Thermal: the hot disc and the warm body are centred and look the same
 * from every side; only a small handle and spout swap sides. Visible (a 240×320 grey photo): the same
 * centred kettle and bench, but the room behind it — shelves, a window, a poster — sweeps past as the
 * camera walks, as a real background does. `jitter` nudges the whole frame by whole px, as a hand does.
 */
function kettleThermal(theta: number, jitter: [number, number] = [0, 0]): Float32Array {
  const t = new Float32Array(W * H);
  const hx = 24 * Math.cos(theta); // handle offset from the body's centre; behind the body near ±90°
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = x - jitter[0];
      const gy = y - jitter[1];
      let c = 21;
      if (gy > 118) c = 23; // the bench, everywhere
      if (Math.hypot(gx - 60, gy - 104) < 18) c = 180; // the hot plate
      if (gx > 44 && gx < 76 && gy > 52 && gy < 100) c = 60; // the kettle body
      if (Math.abs(Math.cos(theta)) > 0.3) {
        if (Math.abs(gx - (60 + hx)) < 4 && gy > 60 && gy < 84) c = 40; // the handle
        if (Math.abs(gx - (60 - hx)) < 3 && gy > 56 && gy < 70) c = 55; // the spout
      }
      t[y * W + x] = c;
    }
  }
  return t;
}
function kettleVisible(theta: number, jitter: [number, number] = [0, 0]): Gray {
  const width = 240;
  const height = 320;
  const data = new Float32Array(width * height);
  // The room is a 360° panorama four pictures wide; the camera sees the quarter of it behind the kettle
  // from where it stands, so the background is different from every side and only repeats after a
  // full turn.
  const panorama = 4 * width;
  const pan = (theta / (2 * Math.PI)) * panorama;
  const props = Array.from({ length: 40 }, (_, k) => ({
    x: (((((k * 211) % panorama) - pan) % panorama) + panorama) % panorama,
    y: 20 + ((k * 71) % 150),
    w: 14 + ((k * 13) % 30),
    h: 20 + ((k * 29) % 70),
    v: 140 + ((k * 47) % 100),
  }));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx = x - jitter[0] * 2;
      const gy = y - jitter[1] * 2;
      let v = 90;
      for (const p of props) {
        // A prop just past the panorama's seam shows at its left edge too.
        if ((gx >= p.x && gx < p.x + p.w) || (gx >= p.x - panorama && gx < p.x - panorama + p.w)) {
          if (gy >= p.y && gy < p.y + p.h) v = p.v;
        }
      }
      if (gy > 236) v = 60; // the bench
      if (Math.hypot(gx - 120, gy - 208) < 36) v = 30; // the hot plate
      if (gx > 88 && gx < 152 && gy > 104 && gy < 200) v = 200; // the kettle body
      data[y * width + x] = v;
    }
  }
  return { data, width, height };
}
const kettle = (index: number, theta: number, jitter: [number, number] = [0, 0]): OrbitCandidate =>
  candidate(index, kettleThermal(theta, jitter), 100, visibleLuma(kettleVisible(theta, jitter)));

describe('laplacianVariance', () => {
  it('falls as the picture blurs', () => {
    const sharp = laplacianVariance(photo(240, 320));
    const soft = laplacianVariance(photo(240, 320, 2));
    const softer = laplacianVariance(photo(240, 320, 4));
    assert.ok(sharp > soft * 3, `${sharp} vs ${soft}`);
    assert.ok(soft > softer, `${soft} vs ${softer}`);
    assert.equal(laplacianVariance({ data: new Float32Array(4), width: 2, height: 2 }), 0);
    const flat = { data: new Float32Array(100).fill(77), width: 10, height: 10 };
    assert.equal(laplacianVariance(flat), 0);
  });
});

describe('thermalEdgeMap / standpointDistance', () => {
  it('finds the same view at zero, a shifted view at its shift, an unrelated view at the cap', () => {
    const a = view(thermalEdgeMap(thermalScene()));
    assert.equal(a.edges.length, W * H);
    assert.ok(standpointDistance(a, view(thermalEdgeMap(thermalScene()))) < 0.5);
    const d = standpointDistance(a, view(thermalEdgeMap(thermalScene([5, 0]))));
    assert.ok(Math.abs(d - 5) < 1, `shift 5 measured as ${d}`);
    const far = standpointDistance(a, view(thermalEdgeMap(thermalScene([30, 20]))));
    assert.equal(far, 2 * ORBIT_SEARCH_PX);
    assert.equal(standpointDistance(a, view(thermalEdgeMap(thermalScene([0, 0], 1)))), 2 * ORBIT_SEARCH_PX);
  });

  it('takes the larger of the thermal and the visible shift, and the thermal alone without a luma', () => {
    const front = kettle(1, 0);
    const side = kettle(2, Math.PI / 2);
    // The thermal frames of the two standpoints align almost perfectly: that is the symmetric-subject trap.
    const thermalOnly = standpointDistance(view(front.edges), view(side.edges));
    assert.ok(thermalOnly < ORBIT_MIN_SHIFT_PX, `thermal edges alone read the quarter turn as ${thermalOnly} px`);
    // The visible photo does not, so the pair is as far apart as the window allows.
    const both = standpointDistance(front, side);
    assert.equal(both, 2 * ORBIT_SEARCH_PX);
    // Same standpoint, same room: both agree, and a hand's jitter reads as that jitter.
    assert.ok(standpointDistance(front, kettle(3, 0)) < 0.5);
    const jittered = standpointDistance(front, kettle(4, 0, [3, 0]));
    assert.ok(jittered > 2 && jittered < 4.5, `3 px jitter measured as ${jittered}`);
    assert.equal(front.luma!.length, ORBIT_LUMA_WIDTH * ORBIT_LUMA_HEIGHT);
  });
});

describe('totalMotion', () => {
  it('stays under the fixed-camera line for a still clip and blows through it for a walk', () => {
    const still = [
      candidate(1, thermalScene([0, 0])),
      candidate(10, thermalScene([1, 0])),
      candidate(20, thermalScene([-1, 1])),
      candidate(30, thermalScene([2, -1])),
    ];
    assert.ok(totalMotion(still) <= ORBIT_FIXED_CAMERA_MAX_SHIFT_PX, `${totalMotion(still)}`);
    const walk = [
      candidate(1, thermalScene([0, 0])),
      candidate(10, thermalScene([6, 2])),
      candidate(20, thermalScene([20, 5])),
      candidate(30, thermalScene([0, 0], 1)),
    ];
    assert.ok(totalMotion(walk) > ORBIT_FIXED_CAMERA_MAX_SHIFT_PX, `${totalMotion(walk)}`);
    assert.equal(totalMotion([still[0]]), 0);
    assert.equal(totalMotion([]), 0);
  });

  it('does not refuse a walk around a centred, symmetric subject as a fixed camera', () => {
    // Eight standpoints around the kettle, with a careful user's jitter: the thermal outline of the body
    // and the disc never moves, the room behind them turns.
    const walk = Array.from({ length: 8 }, (_, i) =>
      kettle(1 + 5 * i, (i * Math.PI) / 4, [[0, 1, -1, 2, 0, -2, 1, 0][i], [0, 0, 1, -1, 1, 0, -1, 0][i]]),
    );
    const thermalOnly = walk.map((c) => ({ ...c, luma: null }));
    assert.ok(
      totalMotion(thermalOnly) <= ORBIT_FIXED_CAMERA_MAX_SHIFT_PX,
      `the thermal edges alone would refuse this walk: ${totalMotion(thermalOnly)} px`,
    );
    assert.ok(totalMotion(walk) > ORBIT_FIXED_CAMERA_MAX_SHIFT_PX, `${totalMotion(walk)}`);
    // And the selector sees several standpoints, not one frame and seven duplicates.
    const { picked, duplicates } = selectOrbitFrames({ candidates: walk, want: 8 });
    assert.ok(picked.length >= 6, `picked ${picked.length}, ${duplicates} duplicates`);
    assert.deepEqual(
      picked.map((c) => c.index),
      [...picked.map((c) => c.index)].sort((a, b) => a - b),
    );
    // A clip of the same kettle from one standpoint is still a fixed camera, whatever the jitter.
    const still = Array.from({ length: 6 }, (_, i) =>
      kettle(1 + i, 0, [[0, 1, -1, 2, 0, 1][i], [0, 0, 1, 0, -1, 1][i]]),
    );
    assert.ok(totalMotion(still) <= ORBIT_FIXED_CAMERA_MAX_SHIFT_PX, `${totalMotion(still)}`);
    assert.equal(selectOrbitFrames({ candidates: still, want: 8 }).picked.length, 1);
  });
});

describe('selectOrbitFrames', () => {
  it('keeps distinct standpoints, drops a duplicate, and returns them in recording order', () => {
    const candidates = [
      candidate(40, thermalScene([0, 0], 1), 90), // a different view
      candidate(5, thermalScene([0, 0]), 100), // the reference view
      candidate(6, thermalScene([1, 0]), 120), // the same view again (1 px), sharper: the pair yields ONE frame
      candidate(20, thermalScene([14, 4]), 80), // shifted past the window: novel
    ];
    // The sharpest frame is picked first, so of the near-identical pair the sharper (6) stays and 5 is the
    // duplicate; the two distinct views join it, and the result is in recording order.
    const { picked, duplicates } = selectOrbitFrames({ candidates, want: 8 });
    assert.deepEqual(
      picked.map((c) => c.index),
      [6, 20, 40],
    );
    assert.equal(duplicates, 1);
  });

  it('starts from the sharpest frame and stops at `want`', () => {
    const candidates = [
      candidate(1, thermalScene([0, 0]), 10),
      candidate(2, thermalScene([0, 0], 1), 200),
      candidate(3, thermalScene([20, 20]), 50),
    ];
    const two = selectOrbitFrames({ candidates, want: 2 });
    assert.equal(two.picked.length, 2);
    assert.ok(two.picked.some((c) => c.index === 2)); // the sharpest is always in
    assert.deepEqual(selectOrbitFrames({ candidates, want: 0 }).picked, []);
    assert.deepEqual(selectOrbitFrames({ candidates: [], want: 8 }).picked, []);
    const one = selectOrbitFrames({ candidates: [candidates[0]], want: 8 });
    assert.deepEqual(
      one.picked.map((c) => c.index),
      [1],
    );
  });

  it('yields fewer frames than wanted when only duplicates remain', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => candidate(i + 1, thermalScene([i % 2, 0]), 50 + i));
    const { picked, duplicates } = selectOrbitFrames({ candidates, want: 8 });
    assert.equal(picked.length, 1);
    assert.equal(duplicates, 9);
  });
});
