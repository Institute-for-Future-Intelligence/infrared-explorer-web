import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SDK_PALETTE_RANGE,
  ambientOutsideBoxes,
  plateauEqualization,
  projectVertexTemps,
  type ThermalSource,
} from './twinThermal';
import { projectWorld, twinIntrinsics, type TwinCamera } from './twinSolver';

const K = twinIntrinsics();
// Level camera 25 cm above the table, looking along −z.
const cam: TwinCamera = { ...K, pitchDeg: 0, position: [0, 0.25, 0] };

/** A frame whose temperature is its row index in °C (0 at the top, 159 at the bottom). */
function rowGradient(): ThermalSource {
  const temps = new Float32Array(K.width * K.height);
  for (let y = 0; y < K.height; y++) for (let x = 0; x < K.width; x++) temps[y * K.width + x] = y;
  return { temps, width: K.width, height: K.height, min: 0, max: K.height - 1 };
}

/** A frame whose temperature is its column index in °C (0 at the left, 119 at the right). */
function colGradient(): ThermalSource {
  const temps = new Float32Array(K.width * K.height);
  for (let y = 0; y < K.height; y++) for (let x = 0; x < K.width; x++) temps[y * K.width + x] = x;
  return { temps, width: K.width, height: K.height, min: 0, max: K.width - 1 };
}

describe('plateauEqualization', () => {
  const [LO, HI] = SDK_PALETTE_RANGE;
  const linearInRange = (t: number) => LO + (HI - LO) * t;

  it('is monotone across the SDK palette range and stretches the populated part of it', () => {
    // 95 % background around 20 °C, a warm object at 30–40 °C, a hot spot at 90 °C.
    const temps = new Float32Array(19200);
    for (let i = 0; i < temps.length; i++) {
      const u = (i * 7919) % 1000;
      temps[i] = u < 950 ? 18 + (u % 4) : u < 995 ? 30 + (u % 10) : 90;
    }
    const map = plateauEqualization(temps, 18, 90);
    assert.equal(map.length, 256);
    assert.ok(Math.abs(map[0] - LO) < 1e-6);
    assert.ok(Math.abs(map[255] - HI) < 1e-6);
    for (let i = 1; i < 256; i++) assert.ok(map[i] >= map[i - 1], `not monotone at ${i}`);
    // 35 °C is 0.24 of the way up linearly; the equalisation lifts it well above that, as the FLIR
    // render does for the few warm pixels in a cold frame — but not all the way to the top.
    const bin35 = Math.round(((35 - 18) / (90 - 18)) * 255);
    assert.ok(map[bin35] > linearInRange(0.24) + 0.12, `35 °C → ${map[bin35]}`);
    assert.ok(map[bin35] < linearInRange(0.85), `35 °C → ${map[bin35]}`);
    // The background itself spans a modest slice, not the whole bottom half of the palette.
    const bin22 = Math.round(((22 - 18) / (90 - 18)) * 255);
    assert.ok(map[bin22] < linearInRange(0.4), `22 °C → ${map[bin22]}`);
  });

  it('stays near linear for an evenly spread frame and copes with a flat one', () => {
    const even = new Float32Array(19200).map((_, i) => 10 + (((i * 7919) % 19200) / 19200) * 50);
    const map = plateauEqualization(even, 10, 60);
    for (let i = 0; i < 256; i += 15) assert.ok(Math.abs(map[i] - linearInRange(i / 255)) < 0.06, `${i}: ${map[i]}`);
    const flat = plateauEqualization(new Float32Array(100).fill(20), 20, 20);
    assert.ok(Math.abs(flat[0] - LO) < 1e-6);
    assert.ok(Math.abs(flat[255] - HI) < 1e-6);
    // An explicit full range is still available.
    const full = plateauEqualization(even, 10, 60, undefined, undefined, [0, 1]);
    assert.equal(full[0], 0);
    assert.equal(full[255], 1);
  });
});

describe('projectVertexTemps', () => {
  it('reads a front-facing vertex at its own pixel and mirrors a back-facing one', () => {
    const src = rowGradient();
    // A 10 cm-wide cylinder-ish object 1 m in front of the camera; two vertices at mid height:
    // one on the near side (normal toward the camera), one on the far side (normal away).
    const pose = { position: [0, 0, -1] as [number, number, number], yawRad: 0, bbox: { x: 0, y: 0, w: 1, h: 1 } };
    const positions = [0, 0.1, 0.05, 0, 0.1, -0.05];
    const normals = [0, 0, 1, 0, 0, -1];
    const r = projectVertexTemps(positions, normals, pose, cam, src);
    assert.equal(r.measured[0], 1);
    assert.equal(r.measured[1], 0);
    assert.equal(r.measuredCount, 1);
    // The near vertex's pixel row ↔ its temperature.
    const pr = projectWorld([0, 0.1, -0.95], cam)!;
    const expected = Math.floor(pr.v) / (K.height - 1);
    assert.ok(Math.abs(r.t01[0] - expected) < 1e-6, `${r.t01[0]} vs ${expected}`);
    // The far vertex mirrors to the near side at the same height → same row → same value.
    assert.ok(Math.abs(r.t01[1] - r.t01[0]) < 1e-6);
    assert.ok(r.meanC !== null && Math.abs(r.meanC - Math.floor(pr.v)) < 1e-6);
  });

  it('follows the vertical gradient: a higher vertex reads a higher row (cooler here)', () => {
    const src = rowGradient();
    const pose = { position: [0, 0, -1] as [number, number, number], yawRad: 0, bbox: { x: 0, y: 0, w: 1, h: 1 } };
    const positions = [0, 0.05, 0.05, 0, 0.2, 0.05];
    const normals = [0, 0, 1, 0, 0, 1];
    const r = projectVertexTemps(positions, normals, pose, cam, src);
    assert.ok(r.t01[1] < r.t01[0]);
  });

  it('fills a vertex outside the model box from the object mean and keeps it flagged inferred', () => {
    const src = rowGradient();
    // Box confined to the image centre; one vertex projects far to the right, outside it.
    const pose = {
      position: [0, 0, -1] as [number, number, number],
      yawRad: 0,
      bbox: { x: 0.4, y: 0.3, w: 0.2, h: 0.4 },
    };
    const positions = [0, 0.1, 0.05, 0.6, 0.1, 0.05];
    const normals = [0, 0, 1, 0, 0, 1];
    const r = projectVertexTemps(positions, normals, pose, cam, src);
    assert.equal(r.measured[0], 1);
    assert.equal(r.measured[1], 0);
    assert.ok(Math.abs(r.t01[1] - r.t01[0]) < 1e-6);
  });

  it('applies the registration offset and honours yaw', () => {
    const src = rowGradient();
    const pose = { position: [0, 0, -1] as [number, number, number], yawRad: 0, bbox: { x: 0, y: 0, w: 1, h: 1 } };
    const positions = [0, 0.1, 0.05];
    const normals = [0, 0, 1];
    const a = projectVertexTemps(positions, normals, pose, cam, src);
    const b = projectVertexTemps(positions, normals, pose, cam, { ...src, registration: { dx: 0, dy: 10 } });
    assert.ok(Math.abs(b.t01[0] - a.t01[0] - 10 / (K.height - 1)) < 1e-6);
    // Yaw by 180°: the local +z vertex now faces away and is inferred by mirroring, same value.
    const c = projectVertexTemps(positions, normals, { ...pose, yawRad: Math.PI }, cam, src);
    assert.equal(c.measured[0], 0);
    assert.ok(Math.abs(c.t01[0] - a.t01[0]) < 1e-6);
  });

  it('leans a vertex about the view axis: ±90° tilts read the columns to the right and left, zero tilt changes nothing', () => {
    // A frame whose temperature is its COLUMN index, so the lean's direction shows in the value.
    const src = colGradient();
    const base = { position: [0, 0, -1] as [number, number, number], yawRad: 0, bbox: { x: 0, y: 0, w: 1, h: 1 } };
    // One front-facing vertex 10 cm up the object's axis.
    const positions = [0, 0.1, 0.05];
    const normals = [0, 0, 1];
    const upright = projectVertexTemps(positions, normals, base, cam, src);
    const zeroTilt = projectVertexTemps(positions, normals, { ...base, tiltRad: 0, tiltAxis: [0, 0, -1] }, cam, src);
    assert.equal(zeroTilt.t01[0], upright.t01[0]);
    assert.ok(Math.abs(upright.t01[0] - Math.floor(K.cx) / (K.width - 1)) < 1e-6, 'upright: the centre column');
    // Lean the top to the camera's right by 90°: the vertex now sits level with the bottom, 10 cm to
    // the right → that column; to the left by 90° → the mirror column. A sign slip in the rotation
    // would swap them.
    const right = projectVertexTemps(
      positions,
      normals,
      { ...base, tiltRad: Math.PI / 2, tiltAxis: [0, 0, -1] },
      cam,
      src,
    );
    const left = projectVertexTemps(
      positions,
      normals,
      { ...base, tiltRad: -Math.PI / 2, tiltAxis: [0, 0, -1] },
      cam,
      src,
    );
    const uR = Math.floor(projectWorld([0.1, 0, -0.95], cam)!.u) / (K.width - 1);
    const uL = Math.floor(projectWorld([-0.1, 0, -0.95], cam)!.u) / (K.width - 1);
    assert.equal(right.measured[0], 1);
    assert.equal(left.measured[0], 1);
    assert.ok(Math.abs(right.t01[0] - uR) < 1e-6, `${right.t01[0]} vs ${uR}`);
    assert.ok(Math.abs(left.t01[0] - uL) < 1e-6, `${left.t01[0]} vs ${uL}`);
    assert.ok(right.t01[0] > upright.t01[0] && left.t01[0] < upright.t01[0]);
  });

  it('mirrors a back vertex of a leaning prop across the plane that holds its leaning axis', () => {
    const src = rowGradient();
    // Level camera; a prop at 1 m leaning 90° to the right, so its axis runs along +x. A vertex on its
    // far side (local −z) must mirror across the plane through the axis facing the camera — not the
    // vertical plane an upright prop would use.
    const pose = {
      position: [0, 0, -1] as [number, number, number],
      yawRad: 0,
      tiltRad: Math.PI / 2,
      tiltAxis: [0, 0, -1] as [number, number, number],
      bbox: { x: 0, y: 0, w: 1, h: 1 },
    };
    const r = projectVertexTemps([0, 0.1, -0.05], [0, 0, -1], pose, cam, src);
    assert.equal(r.measured[0], 0);
    // world = position + R·local = (0.1, 0, −1.05); axis a = (1,0,0); t = cam − position = (0, 0.25, 1);
    // n ∝ t − (t·a)a = (0, 0.25, 1)/|…|; d = (w − p)·n; mirror = w − 2 d n.
    const n = [0, 0.25, 1].map((v) => v / Math.hypot(0.25, 1));
    const d = 0.1 * n[0] + 0 * n[1] + -0.05 * n[2];
    const m = [0.1 - 2 * d * n[0], 0 - 2 * d * n[1], -1.05 - 2 * d * n[2]];
    const pr = projectWorld([m[0], m[1], m[2]], cam)!;
    const expected = Math.floor(pr.v) / (K.height - 1);
    assert.ok(Math.abs(r.t01[0] - expected) < 1e-6, `${r.t01[0]} vs ${expected}`);
    // …and that is a different row from the upright-style vertical mirror (0.1, 0, −0.95).
    const oldStyle = Math.floor(projectWorld([0.1, 0, -0.95], cam)!.v) / (K.height - 1);
    assert.notEqual(
      Math.floor(pr.v),
      Math.floor(projectWorld([0.1, 0, -0.95], cam)!.v),
      `mirror row ${pr.v} vs ${oldStyle}`,
    );
  });

  it("paints through the frame's display map when one is given", () => {
    const src = rowGradient();
    const pose = { position: [0, 0, -1] as [number, number, number], yawRad: 0, bbox: { x: 0, y: 0, w: 1, h: 1 } };
    const positions = [0, 0.1, 0.05];
    const normals = [0, 0, 1];
    const linear = projectVertexTemps(positions, normals, pose, cam, src);
    // A map that squares the palette position: the same pixel paints darker.
    const map = new Float32Array(256).map((_, i) => (i / 255) ** 2);
    const mapped = projectVertexTemps(positions, normals, pose, cam, { ...src, map });
    // The map is looked up per 1/255 bin, so allow one bin's worth of slope.
    assert.ok(Math.abs(mapped.t01[0] - linear.t01[0] ** 2) < 0.01, `${mapped.t01[0]} vs ${linear.t01[0] ** 2}`);
    assert.equal(mapped.meanC, linear.meanC); // the temperatures themselves are untouched
  });

  it('completes a body of revolution from the height profile of its visible side', () => {
    const src = rowGradient();
    // Rings at three heights: a front vertex (measured), a side vertex whose normal faces sideways and
    // whose mirror lands in front of the mirror plane (unknown to the mirror), and a vertex far out
    // of the frame to the right. Same height → same ring → same row value once completed.
    // Per ring: three front vertices (measured — a ring needs a few samples before its median counts),
    // then the side and the out-of-frame vertex. Indices per ring k: k*5 .. k*5+4.
    const heights = [0.05, 0.1, 0.15];
    const positions: number[] = [];
    const normals: number[] = [];
    for (const y of heights) {
      positions.push(-0.01, y, 0.05, 0, y, 0.05, 0.01, y, 0.05, 0.05, y, 0, 0.6, y, 0);
      normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0);
    }
    const base = { position: [0, 0, -1] as [number, number, number], yawRad: 0, bbox: { x: 0, y: 0, w: 1, h: 1 } };
    const rev = projectVertexTemps(positions, normals, { ...base, revolve: true }, cam, src);
    const flat = projectVertexTemps(positions, normals, { ...base, revolve: false }, cam, src);
    assert.equal(rev.measuredCount, 9);
    for (let k = 0; k < heights.length; k++) {
      const front = rev.t01[k * 5 + 1];
      const side = k * 5 + 3;
      const out = k * 5 + 4;
      assert.equal(rev.measured[side], 0);
      assert.equal(rev.measured[out], 0);
      // With the profile: each unseen vertex takes its own ring's value (within a pixel row).
      assert.ok(Math.abs(rev.t01[side] - front) < 0.02, `side ring ${k}: ${rev.t01[side]} vs ${front}`);
      assert.ok(Math.abs(rev.t01[out] - front) < 0.02, `out-of-frame ring ${k}: ${rev.t01[out]} vs ${front}`);
    }
    // The three rings differ, so the completion carries the gradient around — not one flat mean.
    assert.ok(rev.t01[3] > rev.t01[8] && rev.t01[8] > rev.t01[13]);
    // Without the revolve prior the unseen vertices all take the object mean.
    const meanT = flat.t01[4];
    assert.ok(
      Math.abs(flat.t01[3] - meanT) < 1e-6 &&
        Math.abs(flat.t01[8] - meanT) < 1e-6 &&
        Math.abs(flat.t01[13] - meanT) < 1e-6,
    );
    assert.ok(Number.isFinite(rev.tempC[3]) && Math.abs(rev.tempC[3] - rev.tempC[1]) < 1.01);
  });

  it('drops samples at ambient when the object stands out from it, and fills them from the profile', () => {
    // Ambient 20 °C everywhere except a hot vertical band (columns 50..70 → 60 °C).
    const temps = new Float32Array(K.width * K.height).fill(20);
    for (let y = 0; y < K.height; y++) for (let x = 50; x <= 70; x++) temps[y * K.width + x] = 60;
    const src: ThermalSource = { temps, width: K.width, height: K.height, min: 20, max: 60 };
    // A box around the band with the usual margin; a front vertex in the band, and edge vertices that
    // project just outside it (onto ambient) but inside the box + margin.
    const pose = {
      position: [0, 0, -1] as [number, number, number],
      yawRad: 0,
      bbox: { x: 0.4, y: 0.1, w: 0.2, h: 0.65 },
      revolve: true,
    };
    const positions: number[] = [];
    const normals: number[] = [];
    // Ten front vertices on one ring (same height, spread across the band's columns) so the ring has
    // a median of its own.
    for (let k = 0; k < 10; k++) {
      positions.push(-0.02 + k * 0.004, 0.1, 0.05); // u ≈ 57..62, inside the band
      normals.push(0, 0, 1);
    }
    positions.push(-0.1, 0.1, 0.0); // u ≈ 45: ambient, inside the box's left margin
    normals.push(0, 0, 1);
    const r = projectVertexTemps(positions, normals, pose, cam, src);
    assert.equal(r.measured[10], 0, 'the ambient sample is not counted as measured');
    assert.equal(r.measuredCount, 10);
    assert.ok(Math.abs(r.tempC[10] - 60) < 1e-6, `filled from the ring: ${r.tempC[10]}`);
    assert.ok(Math.abs(r.t01[10] - r.t01[0]) < 1e-6);
    // A near-ambient object keeps everything: a band only 0.5 °C above ambient is not distinct, and the
    // edge sample is within a ring's tolerance of its median.
    for (let y = 0; y < K.height; y++) for (let x = 50; x <= 70; x++) temps[y * K.width + x] = 20.5;
    const warmish = projectVertexTemps(positions, normals, pose, cam, { ...src, max: 20.5 });
    assert.equal(warmish.measuredCount, 11);
    // A ring whose median is the object still sheds a sample well below it (the wall past the
    // silhouette), even when the object as a whole is not distinct from ambient.
    for (let y = 0; y < K.height; y++) for (let x = 50; x <= 70; x++) temps[y * K.width + x] = 22;
    const mild = projectVertexTemps(positions, normals, pose, cam, { ...src, max: 22 });
    assert.equal(mild.measured[10], 0);
    assert.ok(Math.abs(mild.tempC[10] - 22) < 1e-6);
  });

  it('treats a cold object the same way: the warm wall past its silhouette is dropped, not kept as a hot spot', () => {
    // Ambient 20 °C; a cold band (columns 50..70 → 0 °C, ice).
    const temps = new Float32Array(K.width * K.height).fill(20);
    for (let y = 0; y < K.height; y++) for (let x = 50; x <= 70; x++) temps[y * K.width + x] = 0;
    const src: ThermalSource = { temps, width: K.width, height: K.height, min: 0, max: 20 };
    const pose = {
      position: [0, 0, -1] as [number, number, number],
      yawRad: 0,
      bbox: { x: 0.4, y: 0.1, w: 0.2, h: 0.65 },
      revolve: true,
    };
    const positions: number[] = [];
    const normals: number[] = [];
    for (let k = 0; k < 10; k++) {
      positions.push(-0.02 + k * 0.004, 0.1, 0.05);
      normals.push(0, 0, 1);
    }
    positions.push(-0.1, 0.1, 0.0); // ambient (20 °C), inside the box margin
    normals.push(0, 0, 1);
    const r = projectVertexTemps(positions, normals, pose, cam, src);
    assert.equal(r.measuredCount, 10);
    assert.equal(r.measured[10], 0);
    assert.ok(Math.abs(r.tempC[10] - 0) < 1e-6, `filled from the ring: ${r.tempC[10]}`);
    // A mildly cool object (17 °C, not distinct from ambient) still sheds the warmer wall sample by
    // the ring rule, because the object is on the cold side of ambient.
    for (let y = 0; y < K.height; y++) for (let x = 50; x <= 70; x++) temps[y * K.width + x] = 17;
    const cool = projectVertexTemps(positions, normals, pose, cam, { ...src, min: 17 });
    assert.equal(cool.measured[10], 0);
    assert.ok(Math.abs(cool.tempC[10] - 17) < 1e-6);
  });

  it("keeps a vessel's own room-temperature part when the rest is hot, and a cold feature on a warm ring", () => {
    // A beaker half full of hot water: rows below 100 read 60 °C, the empty glass above reads 23 °C,
    // ambient 22 °C. Rings at four heights, three front reads each, plus an unseen vertex per ring.
    const temps = new Float32Array(K.width * K.height).fill(22);
    for (let y = 0; y < K.height; y++) for (let x = 40; x <= 80; x++) temps[y * K.width + x] = y >= 100 ? 60 : 23;
    const src: ThermalSource = { temps, width: K.width, height: K.height, min: 22, max: 60 };
    const positions: number[] = [];
    const normals: number[] = [];
    // heights 0.02 and 0.06 project below row 100 (hot); 0.16 and 0.2 above it (glass).
    for (const y of [0.02, 0.06, 0.16, 0.2]) {
      positions.push(-0.01, y, 0.05, 0, y, 0.05, 0.01, y, 0.05, 0.6, y, 0);
      normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0);
    }
    const pose = {
      position: [0, 0, -1] as [number, number, number],
      yawRad: 0,
      bbox: { x: 0.3, y: 0, w: 0.4, h: 1 },
      revolve: true,
    };
    const r = projectVertexTemps(positions, normals, pose, cam, src);
    // The hot rings are hot, the glass rings stay at their measured 23 °C — no flip to all-hot — and
    // the unseen vertex of each ring follows its own ring.
    assert.equal(r.measuredCount, 12, 'every front read is kept');
    assert.ok(Math.abs(r.tempC[1] - 60) < 1e-6 && Math.abs(r.tempC[3] - 60) < 1e-6);
    assert.ok(
      Math.abs(r.tempC[9] - 23) < 1e-6 && Math.abs(r.tempC[11] - 23) < 1e-6,
      `glass ring ${r.tempC[9]} / ${r.tempC[11]}`,
    );
    assert.ok(Math.abs(r.tempC[13] - 23) < 1e-6 && Math.abs(r.tempC[15] - 23) < 1e-6);

    // An ice cube on the side of a room-temperature beaker: a ring at 22 with two of ten front reads
    // at 4 °C. The cold reads stay measured and cold; the ring (and its unseen back) stays 22.
    const t2 = new Float32Array(K.width * K.height).fill(22);
    for (let y = 0; y < K.height; y++) for (let x = 40; x <= 45; x++) t2[y * K.width + x] = 4;
    const s2: ThermalSource = { temps: t2, width: K.width, height: K.height, min: 4, max: 22 };
    const p2: number[] = [];
    const n2: number[] = [];
    for (let k = 0; k < 10; k++) {
      p2.push(-0.12 + k * 0.03, 0.1, 0.05); // u ≈ 42 .. 83: the first two land on the ice
      n2.push(0, 0, 1);
    }
    p2.push(0.6, 0.1, 0);
    n2.push(1, 0, 0);
    const ice = projectVertexTemps(p2, n2, { ...pose, bbox: { x: 0.3, y: 0, w: 0.45, h: 1 } }, cam, s2);
    assert.equal(ice.measured[0], 1);
    assert.equal(ice.measured[1], 1);
    assert.ok(
      Math.abs(ice.tempC[0] - 4) < 1e-6 && Math.abs(ice.tempC[1] - 4) < 1e-6,
      `ice reads ${ice.tempC[0]} ${ice.tempC[1]}`,
    );
    assert.ok(Math.abs(ice.tempC[10] - 22) < 1e-6, `ring value ${ice.tempC[10]}`);
    assert.equal(ice.measuredCount, 10);
  });

  it('takes the room from outside the boxes, and refuses to guess it in a close-up', () => {
    const temps = new Float32Array(K.width * K.height).fill(20);
    for (let y = 0; y < K.height; y++) for (let x = 40; x <= 80; x++) temps[y * K.width + x] = 60;
    const src: ThermalSource = { temps, width: K.width, height: K.height, min: 20, max: 60 };
    const box = { x: 40 / K.width, y: 0, w: 41 / K.width, h: 1 };
    const room = ambientOutsideBoxes(src, [box]);
    assert.ok(room !== null && Math.abs(room - 20) < 0.2, `room ${room}`);
    // The same frame with a box that leaves less than a quarter of it: no verdict.
    assert.equal(ambientOutsideBoxes(src, [{ x: 0, y: 0, w: 0.9, h: 1 }]), null);
    // And with ambient unknown, nothing is dropped as the wall.
    const pose = { position: [0, 0, -1] as [number, number, number], yawRad: 0, bbox: box, revolve: true };
    const positions = [0, 0.1, 0.05, -0.1, 0.1, 0.0];
    const normals = [0, 0, 1, 0, 0, 1];
    const r = projectVertexTemps(positions, normals, pose, cam, { ...src, ambientC: null });
    assert.equal(r.measuredCount, 2);
  });

  it('degrades to a flat 0.5 when nothing can be sampled', () => {
    const src = rowGradient();
    const pose = { position: [0, 0, 1] as [number, number, number], yawRad: 0, bbox: { x: 0, y: 0, w: 1, h: 1 } }; // behind the camera
    const r = projectVertexTemps([0, 0.1, 0], [0, 0, 1], pose, cam, src);
    assert.equal(r.measuredCount, 0);
    assert.equal(r.meanC, null);
    assert.equal(r.t01[0], 0.5);
  });
});
