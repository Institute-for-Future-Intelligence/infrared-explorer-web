import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TwinObject, TwinScene } from '../types';
import {
  DISTANCE_RANGE_M,
  NOMINAL_SIZES,
  applyTwinEdits,
  camToWorld,
  chooseSize,
  holdAnchor,
  projectWorld,
  rotAxis,
  solveTwinLayout,
  twinIntrinsics,
  worldToCam,
  type TwinCamera,
  type Vec3,
} from './twinSolver';

const K = twinIntrinsics();

const baseObject = (over: Partial<TwinObject>): TwinObject => ({
  id: 'obj1',
  kind: 'beaker',
  label: 'beaker',
  confidence: 0.9,
  bbox: { x: 0.4, y: 0.3, w: 0.2, h: 0.3 },
  footprintY: 0.6,
  sizeCm: { height: 0, width: 0 },
  material: 'glass',
  fill: { level: 0, content: '' },
  restingOn: 'support',
  thermal: { role: 'ambient', note: '' },
  ...over,
});

const baseScene = (objects: TwinObject[], over: Partial<TwinScene> = {}): TwinScene => ({
  renderable: true,
  reason: '',
  confidence: 0.9,
  camera: { pitch: 'slightly_above', distanceHint: 'medium' },
  support: { kind: 'table', farEdgeY: 0.6 },
  objects,
  ...over,
});

/** Synthesize the box the camera would see for an upright object of the given size at `bottom`. */
function boxFor(bottom: Vec3, heightM: number, widthM: number, cam: TwinCamera) {
  const b = projectWorld(bottom, cam)!;
  const t = projectWorld([bottom[0], bottom[1] + heightM, bottom[2]], cam)!;
  const halfW = ((cam.fx * widthM) / 2 / b.depth) * 1.0;
  return {
    bbox: { x: (b.u - halfW) / K.width, y: t.v / K.height, w: (2 * halfW) / K.width, h: (b.v - t.v) / K.height },
    footprintY: b.v / K.height,
  };
}

describe('camera model', () => {
  it('has near-square pixels and a principal point at the centre', () => {
    assert.ok(Math.abs(K.fx / K.fy - 1) < 0.02, `${K.fx} vs ${K.fy}`);
    assert.equal(K.cx, 60);
    assert.equal(K.cy, 80);
  });

  it('round-trips world ↔ camera and looks down when pitched', () => {
    const cam: TwinCamera = { ...K, pitchDeg: 20, position: [0, 0.3, 0] };
    const p: Vec3 = [0.1, 0.05, -0.7];
    const back = camToWorld(worldToCam(p, cam), cam);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - p[i]) < 1e-9);
    // A point straight down the pitched view axis projects to the principal point.
    const d = 0.5;
    const onAxis: Vec3 = [0, 0.3 - d * Math.sin((20 * Math.PI) / 180), -d * Math.cos((20 * Math.PI) / 180)];
    const pr = projectWorld(onAxis, cam)!;
    assert.ok(Math.abs(pr.u - K.cx) < 1e-6 && Math.abs(pr.v - K.cy) < 1e-6 && Math.abs(pr.depth - d) < 1e-9);
    assert.equal(projectWorld([0, 0.3, 1], cam), null);
  });
});

describe('chooseSize', () => {
  it('picks the beaker spec whose implied distance fits the hint', () => {
    // A 250 mL beaker (9.5 cm) at 0.6 m → h_px = fy·0.095/0.6
    const hFrac = (K.fy * 0.095) / 0.6 / K.height;
    const o = baseObject({ bbox: { x: 0.4, y: 0.3, w: 0.15, h: hFrac }, sizeCm: { height: 9.5, width: 7 } });
    const s = chooseSize(o, 'medium', K);
    assert.equal(s.spec, '250 mL');
    assert.ok(Math.abs(s.depthM - 0.6) < 1e-9);
  });

  it('ranges a flat object by its width', () => {
    const wFrac = (K.fx * 0.15) / 0.8 / K.width;
    const o = baseObject({ kind: 'wire_gauze', bbox: { x: 0.3, y: 0.5, w: wFrac, h: 0.01 } });
    const s = chooseSize(o, 'medium', K);
    assert.ok(Math.abs(s.depthM - 0.8) < 1e-9, `depth=${s.depthM}`);
    assert.equal(s.spec, NOMINAL_SIZES.wire_gauze![0].label);
  });

  it('falls back to the model estimate and the box aspect for a kind without a table', () => {
    const o = baseObject({
      kind: 'bottle',
      bbox: { x: 0.4, y: 0.2, w: 0.1, h: 0.4 },
      sizeCm: { height: 22, width: 0 },
    });
    const s = chooseSize(o, 'close', K);
    assert.equal(s.spec, null);
    assert.equal(s.heightM, 0.22);
    assert.ok(Math.abs(s.widthM - 0.22 * ((0.1 * K.width) / (0.4 * K.height))) < 1e-9);
    const [lo, hi] = DISTANCE_RANGE_M.close;
    assert.ok(s.depthM > 0 && lo > 0 && hi > lo);
  });
});

describe('applyTwinEdits', () => {
  it('keeps a held relation through edits and clears a heldOver whose target was hidden', () => {
    const scene = baseScene([
      baseObject({ id: 'b', kind: 'bottle' }),
      baseObject({ id: 'k', kind: 'kettle', restingOn: 'held', heldOver: 'b', tiltDeg: 30 }),
    ]);
    const kept = applyTwinEdits(scene, { objects: { k: { kind: 'pot' } } });
    assert.equal(kept.scene.objects[1].restingOn, 'held');
    assert.equal(kept.scene.objects[1].heldOver, 'b');
    const hiddenTarget = applyTwinEdits(scene, { objects: { b: { hidden: true } } });
    assert.equal(hiddenTarget.scene.objects.length, 1);
    assert.equal(hiddenTarget.scene.objects[0].restingOn, 'held');
    assert.equal(hiddenTarget.scene.objects[0].heldOver, '');
  });

  it('replaces kinds and support relations, drops hidden objects and re-homes their dependants', () => {
    const scene = baseScene([
      baseObject({ id: 'a', kind: 'tripod', material: 'metal' }),
      baseObject({ id: 'b', kind: 'beaker', restingOn: 'a' }),
      baseObject({ id: 'c', kind: 'other' }),
    ]);
    const r = applyTwinEdits(scene, {
      pitchDeg: 30,
      objects: { a: { hidden: true }, c: { kind: 'hot_plate', spec: 'hot plate' }, b: { restingOn: 'c' } },
    });
    assert.deepEqual(r.hiddenIds, ['a']);
    assert.equal(r.pitchDeg, 30);
    assert.deepEqual(r.specOverrides, { c: 'hot plate' });
    const ids = r.scene.objects.map((o) => o.id);
    assert.deepEqual(ids, ['b', 'c']);
    assert.equal(r.scene.objects.find((o) => o.id === 'c')!.kind, 'hot_plate');
    assert.equal(r.scene.objects.find((o) => o.id === 'b')!.restingOn, 'c');
    // A dependant of a hidden object falls to the support when it has no other home.
    const r2 = applyTwinEdits(scene, { objects: { a: { hidden: true } } });
    assert.equal(r2.scene.objects.find((o) => o.id === 'b')!.restingOn, 'support');
    // No edits → identical objects, nothing hidden, no pitch.
    const r3 = applyTwinEdits(scene, null);
    assert.equal(r3.scene.objects.length, 3);
    assert.equal(r3.pitchDeg, null);
    assert.equal(scene.objects.length, 3); // the input is untouched
  });
});

describe('solveTwinLayout', () => {
  it('recovers the position and camera height of a beaker seen from a pitched camera', () => {
    const truth: TwinCamera = { ...K, pitchDeg: 15, position: [0, 0.25, 0] };
    const bottom: Vec3 = [0.05, 0, -0.55];
    const box = boxFor(bottom, 0.095, 0.07, truth);
    const scene = baseScene([baseObject({ ...box, sizeCm: { height: 9.5, width: 7 } })]);
    const layout = solveTwinLayout(scene);
    assert.equal(layout.placed.length, 1);
    const p = layout.placed[0];
    assert.equal(p.spec, '250 mL');
    assert.ok(Math.abs(p.position[0] - 0.05) < 0.03, `x=${p.position[0]}`);
    assert.equal(p.position[1], 0);
    assert.ok(Math.abs(p.position[2] + 0.55) < 0.05, `z=${p.position[2]}`);
    assert.ok(Math.abs(layout.camera.position[1] - 0.25) < 0.05, `camY=${layout.camera.position[1]}`);
    assert.deepEqual(layout.warnings, []);
  });

  it('stacks a child on its parent and orients boxes toward the camera', () => {
    const truth: TwinCamera = { ...K, pitchDeg: 15, position: [0, 0.3, 0] };
    const tripodBox = boxFor([0, 0, -0.7], 0.2, 0.15, truth);
    const beakerBox = boxFor([0, 0.2, -0.7], 0.095, 0.07, truth);
    const scene = baseScene([
      baseObject({ id: 'tri', kind: 'tripod', material: 'metal', ...tripodBox }),
      baseObject({ id: 'bk', kind: 'beaker', restingOn: 'tri', ...beakerBox, sizeCm: { height: 9.5, width: 7 } }),
      baseObject({
        id: 'blk',
        kind: 'metal_block',
        material: 'metal',
        ...boxFor([0.2, 0, -0.6], 0.05, 0.05, truth),
        sizeCm: { height: 5, width: 5 },
      }),
    ]);
    const layout = solveTwinLayout(scene);
    const tri = layout.placed.find((p) => p.id === 'tri')!;
    const bk = layout.placed.find((p) => p.id === 'bk')!;
    const blk = layout.placed.find((p) => p.id === 'blk')!;
    assert.ok(Math.abs(bk.position[1] - tri.heightM) < 1e-9);
    assert.equal(bk.position[0], tri.position[0]);
    assert.equal(bk.position[2], tri.position[2]);
    assert.equal(bk.revolve, true);
    assert.equal(blk.revolve, false);
    // The block is to the camera's right (+x) and in front (−z): its yaw points back toward the camera.
    const expectedYaw = Math.atan2(
      layout.camera.position[0] - blk.position[0],
      layout.camera.position[2] - blk.position[2],
    );
    assert.ok(Math.abs(blk.yawRad - expectedYaw) < 1e-12);
    assert.ok(layout.extentM >= 0.5);
    assert.ok(layout.focus[2] < 0);
  });

  it("floats a held pourer at its target's depth, leaning and pointing toward it, clear of the table", () => {
    const truth: TwinCamera = { ...K, pitchDeg: 15, position: [0, 0.3, 0] };
    // A bottle standing on the table, centre-left; a kettle up and to the right, in the air, pouring
    // into it: its box would put it far behind the bottle if it were stood on the table.
    const bottleBox = boxFor([-0.05, 0, -0.5], 0.22, 0.06, truth);
    // Its box runs off the bottom of the frame, so nothing but the model's own angle says how it leans.
    const kettleTop = projectWorld([0.12, 0.35, -0.5], truth)!;
    const kettleBox = {
      bbox: {
        x: (kettleTop.u - 15) / K.width,
        y: kettleTop.v / K.height,
        w: 30 / K.width,
        h: 1 - kettleTop.v / K.height,
      },
      footprintY: 1,
    };
    const scene = baseScene([
      baseObject({ id: 'b', kind: 'bottle', material: 'plastic', ...bottleBox, sizeCm: { height: 22, width: 6 } }),
      baseObject({
        id: 'k',
        kind: 'kettle',
        material: 'metal',
        ...kettleBox,
        sizeCm: { height: 22, width: 18 },
        restingOn: 'held',
        heldOver: 'b',
        tiltDeg: 40,
      }),
    ]);
    const layout = solveTwinLayout(scene);
    const b = layout.placed.find((p) => p.id === 'b')!;
    const k = layout.placed.find((p) => p.id === 'k')!;
    assert.equal(b.tiltRad, 0);
    assert.equal(b.position[1], 0);
    // Kettle-sized from the table, whatever the (cut) box said.
    assert.equal(k.spec, 'electric kettle');
    assert.ok(Math.abs(k.heightM - 0.22) < 1e-9 && Math.abs(k.widthM - 0.16) < 1e-9);
    // Same depth as the bottle (not the far table point its box bottom would give), and off the table.
    assert.ok(Math.abs(k.position[2] - b.position[2]) < 0.08, `kettle z=${k.position[2]} bottle z=${b.position[2]}`);
    assert.ok(k.position[1] > 0.05, `kettle y=${k.position[1]}`);
    assert.ok(k.position[0] > b.position[0], 'the kettle stays to the right of the bottle');
    // Leans toward the bottle, which is to its left in the image → negative, 40°.
    assert.ok(Math.abs(k.tiltRad + (40 * Math.PI) / 180) < 1e-9, `tilt=${k.tiltRad}`);
    assert.equal(k.heldOver, 'b');
    // Its +x (the spout) points at the bottle …
    assert.ok(Math.abs(k.yawRad - Math.PI) < 1e-12, `yaw=${k.yawRad}`);
    // … and the spout TIP hangs 2 cm over the bottle's mouth, whatever the box size said.
    const anchor = holdAnchor('kettle', k.heightM, k.widthM, b.heightM);
    const cy = Math.cos(k.yawRad);
    const sy = Math.sin(k.yawRad);
    const l = anchor.local;
    const a = rotAxis([l[0] * cy + l[2] * sy, l[1], -l[0] * sy + l[2] * cy], layout.viewDir, k.tiltRad);
    const tip = [k.position[0] + a[0], k.position[1] + a[1], k.position[2] + a[2]];
    const mouth = [b.position[0], b.position[1] + b.heightM, b.position[2]];
    // (Over the mouth to within the bottle's radius: a spout shorter than the mouth is wide is backed
    // off to the near rim rather than the centre.)
    assert.ok(
      Math.abs(tip[0] - mouth[0]) <= b.widthM / 2 + 1e-9 && Math.abs(tip[2] - mouth[2]) < 1e-9,
      `tip ${tip} mouth ${mouth}`,
    );
    assert.ok(Math.abs(tip[1] - mouth[1] - 0.02) < 1e-9, `tip y ${tip[1]} mouth y ${mouth[1]}`);
    // Only the bottle pins the camera height.
    assert.ok(Math.abs(layout.camera.position[1] - 0.3) < 0.05, `camY=${layout.camera.position[1]}`);
    assert.deepEqual(layout.warnings, []);
    assert.ok(Math.abs(Math.hypot(...layout.viewDir) - 1) < 1e-12);

    // Without a target: the size-implied depth and the model's own lean direction.
    const alone = solveTwinLayout(baseScene([scene.objects[1]]));
    const ka = alone.placed[0];
    assert.ok(ka.position[1] > 0.005);
    assert.ok(ka.tiltRad > 0);
    assert.ok(alone.warnings.some((w) => /No object rests/.test(w)));
  });

  it("fits a pourer's lean to its box's bottom edge when that edge is inside the frame", () => {
    const truth: TwinCamera = { ...K, pitchDeg: 15, position: [0, 0.3, 0] };
    const bottle = baseObject({
      id: 'b',
      kind: 'bottle',
      material: 'plastic',
      ...boxFor([-0.05, 0, -0.5], 0.22, 0.06, truth),
      sizeCm: { height: 22, width: 6 },
    });
    const kettle = (bbox: TwinObject['bbox'], tiltDeg: number) =>
      baseObject({
        id: 'k',
        kind: 'kettle',
        material: 'metal',
        bbox,
        footprintY: bbox.y + bbox.h,
        restingOn: 'held',
        heldOver: 'b',
        tiltDeg,
      });
    // Ground truth: the kettle really leans 50°. Solve it with a cut box (model's angle trusted) to get
    // that pose, and read off where its base rim's lowest point lands in the frame.
    const cut = solveTwinLayout(baseScene([bottle, kettle({ x: 0.6, y: 0, w: 0.4, h: 1 }, 50)]));
    const kt = cut.placed.find((p) => p.id === 'k')!;
    assert.ok(Math.abs(kt.tiltRad + (50 * Math.PI) / 180) < 1e-9);
    const r = 1.05 * (kt.widthM / 2);
    const e1 = rotAxis([1, 0, 0], cut.viewDir, kt.tiltRad);
    const e2 = rotAxis([0, 0, 1], cut.viewDir, kt.tiltRad);
    let lowest = -Infinity;
    for (let i = 0; i < 24; i++) {
      const ph = (i / 24) * 2 * Math.PI;
      const c = Math.cos(ph) * r;
      const sn = Math.sin(ph) * r;
      const pr = projectWorld(
        [
          kt.position[0] + c * e1[0] + sn * e2[0],
          kt.position[1] + c * e1[1] + sn * e2[1],
          kt.position[2] + c * e1[2] + sn * e2[2],
        ],
        cut.camera,
      );
      if (pr && pr.u >= -2 && pr.u <= K.width + 2) lowest = Math.max(lowest, pr.v);
    }
    assert.ok(lowest > 0 && lowest < K.height * 0.9, `lowest rim point v=${lowest}`);
    // Now the model under-reads the lean (28°) but the box's bottom edge is where the rim really is.
    const boxed = solveTwinLayout(baseScene([bottle, kettle({ x: 0.6, y: 0, w: 0.4, h: lowest / K.height }, 28)]));
    const kf = boxed.placed.find((p) => p.id === 'k')!;
    assert.ok(
      Math.abs(kf.tiltRad + (50 * Math.PI) / 180) < (2.5 * Math.PI) / 180,
      `fitted ${(kf.tiltRad * 180) / Math.PI}°`,
    );
    // A box whose bottom edge is the frame edge falls back to the model's angle.
    const open = solveTwinLayout(baseScene([bottle, kettle({ x: 0.6, y: 0, w: 0.4, h: 1 }, 28)]));
    assert.ok(Math.abs(open.placed.find((p) => p.id === 'k')!.tiltRad + (28 * Math.PI) / 180) < 1e-9);
  });

  it('keeps people and devices in the list but out of the render, and warns without a support object', () => {
    const scene = baseScene([baseObject({ id: 'h', kind: 'hand', material: 'organic', restingOn: 'held' })], {
      support: { kind: 'unknown', farEdgeY: -1 },
    });
    const layout = solveTwinLayout(scene);
    assert.equal(layout.placed[0].rendered, false);
    assert.ok(layout.warnings.some((w) => w.includes('camera height defaulted')));
    assert.equal(layout.camera.position[1], 0.3);
  });

  it('breaks support / held-over loops instead of stacking copies into the air', () => {
    const truth: TwinCamera = { ...K, pitchDeg: 15, position: [0, 0.3, 0] };
    // A self-reference (a model slip the parser also catches) and a 2-cycle an owner's edit can make.
    const selfRef = solveTwinLayout(
      baseScene([baseObject({ id: 'a', ...boxFor([0, 0, -0.6], 0.095, 0.07, truth), restingOn: 'a' })]),
    );
    assert.equal(selfRef.placed[0].position[1], 0);
    assert.ok(
      selfRef.warnings.some((w) => /loop/.test(w)),
      selfRef.warnings.join(' | '),
    );
    const cycle = solveTwinLayout(
      baseScene([
        baseObject({
          id: 'tri',
          kind: 'tripod',
          material: 'metal',
          ...boxFor([0, 0, -0.7], 0.2, 0.15, truth),
          restingOn: 'bk',
        }),
        baseObject({ id: 'bk', kind: 'beaker', ...boxFor([0, 0.2, -0.7], 0.095, 0.07, truth), restingOn: 'tri' }),
      ]),
    );
    const ys = cycle.placed.map((p) => p.position[1]);
    assert.ok(Math.max(...ys) < 0.25, `heights ${ys}`);
    assert.ok(Math.min(...ys) === 0, `one of them must land on the table: ${ys}`);
    assert.ok(cycle.warnings.some((w) => /loop/.test(w)));
    // A held-over 2-cycle terminates, and neither object flies away.
    const held = solveTwinLayout(
      baseScene([
        baseObject({ id: 'c1', kind: 'cup', restingOn: 'held', heldOver: 'c2', tiltDeg: 20 }),
        baseObject({ id: 'c2', kind: 'cup', restingOn: 'held', heldOver: 'c1', tiltDeg: -20 }),
      ]),
    );
    for (const p of held.placed)
      for (const v of p.position) assert.ok(Number.isFinite(v) && Math.abs(v) < 3, `${p.id} ${p.position}`);
    assert.ok(held.warnings.some((w) => /loop/.test(w)));
  });

  it("keeps the lean the model saw for something dipped in on the target's axis, and hangs off a leaning target where it is drawn", () => {
    const truth: TwinCamera = { ...K, pitchDeg: 15, position: [0, 0.3, 0] };
    const beaker = baseObject({
      id: 'bk',
      kind: 'beaker',
      ...boxFor([0, 0, -0.5], 0.095, 0.07, truth),
      sizeCm: { height: 9.5, width: 7 },
    });
    // A thermometer dipped into the beaker, its top leaning to the right (+25°): its box centre is to
    // the right of the mouth BECAUSE it leans that way — the pourer rule would flip it.
    const th = baseObject({
      id: 'th',
      kind: 'thermometer',
      bbox: { x: 0.55, y: 0.1, w: 0.05, h: 0.4 },
      restingOn: 'held',
      heldOver: 'bk',
      tiltDeg: 25,
    });
    const a = solveTwinLayout(baseScene([beaker, th]));
    const t = a.placed.find((p) => p.id === 'th')!;
    assert.ok(Math.abs(t.tiltRad - (25 * Math.PI) / 180) < 1e-9, `tilt=${t.tiltRad}`);
    const b = solveTwinLayout(baseScene([beaker, { ...th, tiltDeg: -25 }]));
    assert.ok(Math.abs(b.placed.find((p) => p.id === 'th')!.tiltRad + (25 * Math.PI) / 180) < 1e-9);
    // The bulb sits half-way down the beaker, on its axis.
    const bk = a.placed.find((p) => p.id === 'bk')!;
    assert.ok(Math.abs(t.position[0] - bk.position[0]) < 1e-9 && Math.abs(t.position[2] - bk.position[2]) < 1e-9);
    assert.ok(Math.abs(t.position[1] - bk.heightM / 2) < 1e-9, `bulb y=${t.position[1]}`);

    // A cup held tilted in the air, a kettle pouring into it: the spout tip meets the cup's mouth
    // where the scene draws it (the leaning top), not where an upright cup's top would be.
    const cup = baseObject({
      id: 'cup',
      kind: 'cup',
      bbox: { x: 0.3, y: 0.3, w: 0.2, h: 0.25 },
      sizeCm: { height: 10, width: 8 },
      restingOn: 'held',
      tiltDeg: 30,
    });
    const kettle = baseObject({
      id: 'k',
      kind: 'kettle',
      bbox: { x: 0.6, y: 0, w: 0.4, h: 0.3 },
      restingOn: 'held',
      heldOver: 'cup',
      tiltDeg: 40,
    });
    const l = solveTwinLayout(baseScene([beaker, cup, kettle]));
    const c = l.placed.find((p) => p.id === 'cup')!;
    const k = l.placed.find((p) => p.id === 'k')!;
    const drawnMouth = rotAxis([0, c.heightM, 0], l.viewDir, c.tiltRad).map((v, i) => v + c.position[i]);
    const anchor = holdAnchor('kettle', k.heightM, k.widthM, c.heightM);
    const cy = Math.cos(k.yawRad);
    const sy = Math.sin(k.yawRad);
    const la = anchor.local;
    const tipOff = rotAxis([la[0] * cy + la[2] * sy, la[1], -la[0] * sy + la[2] * cy], l.viewDir, k.tiltRad);
    const tip = tipOff.map((v, i) => v + k.position[i]);
    // Over the near rim of the cup (the cup is wider than the spout reaches), 2 cm up, unless lifted.
    const sideways = Math.abs(tip[0] - drawnMouth[0]);
    assert.ok(sideways <= c.widthM / 2 + 1e-9, `tip x off the mouth by ${sideways}`);
    assert.ok(Math.abs(tip[2] - drawnMouth[2]) < 1e-9);
    assert.ok(tip[1] - drawnMouth[1] >= 0.02 - 1e-9, `tip y ${tip[1]} mouth y ${drawnMouth[1]}`);
  });

  it('backs a pourer off a wide mouth, lifts it clear of the table, and keeps a target-less pourer in range', () => {
    const truth: TwinCamera = { ...K, pitchDeg: 15, position: [0, 0.3, 0] };
    const big = baseObject({
      id: 'bk',
      kind: 'beaker',
      ...boxFor([0, 0, -0.5], 0.145, 0.105, truth),
      sizeCm: { height: 14.5, width: 10.5 },
    });
    const kettle = baseObject({
      id: 'k',
      kind: 'kettle',
      bbox: { x: 0.6, y: 0, w: 0.4, h: 0.3 },
      restingOn: 'held',
      heldOver: 'bk',
      tiltDeg: 0,
    });
    const l = solveTwinLayout(baseScene([big, kettle]));
    const bk = l.placed.find((p) => p.id === 'bk')!;
    const k = l.placed.find((p) => p.id === 'k')!;
    assert.equal(bk.spec, '1000 mL');
    // Upright kettle beside a 10.5 cm mouth: its plinth (1.05 r = 8.4 cm) must stay outside the rim.
    const plinth = 1.05 * (k.widthM / 2);
    assert.ok(
      k.position[0] - plinth >= bk.position[0] + bk.widthM / 2 - 1e-9,
      `kettle x ${k.position[0]} plinth ${plinth} rim ${bk.position[0] + bk.widthM / 2}`,
    );
    // Its base is above the table (a 22 cm kettle cannot reach a 14.5 cm mouth upright without lifting).
    assert.ok(k.position[1] >= 0.005 - 1e-12);
    // Without a target and a tiny (cut) box, the depth stays inside the distance hint.
    const alone = solveTwinLayout(baseScene([{ ...kettle, heldOver: '', bbox: { x: 0.6, y: 0, w: 0.4, h: 0.05 } }]));
    const ka = alone.placed[0];
    assert.ok(-ka.position[2] <= DISTANCE_RANGE_M.medium[1] + 0.3, `z=${ka.position[2]}`);
    // A NaN tilt in a hand-edited record does not poison the placement.
    const nan = solveTwinLayout(baseScene([big, { ...kettle, tiltDeg: Number.NaN }]));
    for (const v of nan.placed.find((p) => p.id === 'k')!.position) assert.ok(Number.isFinite(v));
  });

  it('lets an owner force a spec, which wins over the hint and the model estimate', () => {
    const hFrac = (K.fy * 0.095) / 0.6 / K.height;
    const o = baseObject({ bbox: { x: 0.4, y: 0.3, w: 0.15, h: hFrac }, sizeCm: { height: 9.5, width: 7 } });
    const s = chooseSize(o, 'medium', K, '1000 mL');
    assert.equal(s.spec, '1000 mL');
    assert.ok(s.depthM > 0.6);
    // An unknown label falls back to the normal choice.
    assert.equal(chooseSize(o, 'medium', K, '5 L').spec, '250 mL');
    const layout = solveTwinLayout(baseScene([o]), { specOverrides: { obj1: '600 mL' } });
    assert.equal(layout.placed[0].spec, '600 mL');
  });

  it('honours an explicit pitch override', () => {
    const scene = baseScene([baseObject({})]);
    const a = solveTwinLayout(scene, { pitchDeg: 0 });
    const b = solveTwinLayout(scene, { pitchDeg: 40 });
    assert.equal(a.camera.pitchDeg, 0);
    assert.equal(b.camera.pitchDeg, 40);
    assert.notEqual(a.camera.position[1], b.camera.position[1]);
  });
});
