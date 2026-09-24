import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TWIN_GEOMETRY_JS, describeSettled, readSettled } from './twinFrameGeometry';

// The frame's geometry text, run against the real three package: the same functions the sandboxed page
// gets, with THREE passed in.
interface Moved {
  parts: string[];
  kinds: string[];
  meshes: number;
  dx: number;
  dy: number;
  dz: number;
}
interface Geom {
  settleScene: (
    T: typeof THREE,
    root: THREE.Object3D,
    groundY?: number,
  ) => {
    tol: number;
    moved: Moved[];
    shifts: { part: string; dx: number; dy: number; dz: number }[];
    split: string[];
  };
  roofCover: (T: typeof THREE, root: THREE.Object3D, tol: number) => { part: string; sides: Record<string, number> }[];
  gableGeometry: (T: typeof THREE, w: number, h: number, d: number, ridge: string) => THREE.BufferGeometry;
  hipGeometry: (T: typeof THREE, w: number, h: number, d: number) => THREE.BufferGeometry;
  shedGeometry: (T: typeof THREE, w: number, h: number, d: number, high: string) => THREE.BufferGeometry;
  prismGeometry: (T: typeof THREE, points: unknown, h: number) => THREE.BufferGeometry | null;
}
const geom = new Function(
  TWIN_GEOMETRY_JS + '\nreturn { settleScene, roofCover, gableGeometry, hipGeometry, shedGeometry, prismGeometry };',
)() as Geom;

/** A box standing on y at x, z, tagged as the frame's adopt() tags a mesh. */
function box(
  root: THREE.Object3D,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  part: string,
  kind: string,
) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial());
  m.position.set(x, y + h / 2, z);
  m.userData.part = part;
  m.userData.kind = kind;
  root.add(m);
  return m;
}
const worldBox = (m: THREE.Object3D) => {
  m.updateWorldMatrix(true, false);
  return new THREE.Box3().setFromObject(m);
};
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

describe('TWIN_GEOMETRY_JS', () => {
  it('is spliceable into the frame: no backtick, no template substitution', () => {
    assert.ok(!TWIN_GEOMETRY_JS.includes('`'));
    assert.ok(!TWIN_GEOMETRY_JS.includes('${'));
  });
});

describe('settleScene', () => {
  it('leaves a model that stands on the ground and on itself alone', () => {
    const root = new THREE.Group();
    box(root, 10, 6, 8, 0, 0, 0, 'mainBlock', 'wall');
    box(root, 10.4, 2, 8.4, 0, 6, 0, 'roof', 'roof'); // on the walls
    box(root, 1.2, 1.4, 0.06, 2, 3, 4.03, 'windows', 'glass'); // a pane proud of the front wall
    for (let i = 0; i < 4; i++) box(root, 0.3, 3, 0.3, -8 + i * 2, 0, 0, 'columns', 'column');
    box(root, 7, 3, 4, -5, 3, 0, 'raisedWing', 'wall'); // on the columns
    const r = geom.settleScene(THREE, root);
    assert.deepEqual(r.moved, []);
  });

  it('sets a floating roof down onto the walls under it', () => {
    const root = new THREE.Group();
    box(root, 10, 6, 8, 0, 0, 0, 'mainBlock', 'wall');
    const roof = box(root, 10.4, 2, 8.4, 0, 6.5, 0, 'roof', 'roof');
    const r = geom.settleScene(THREE, root);
    assert.equal(r.moved.length, 1);
    assert.deepEqual(r.moved[0].parts, ['roof']);
    near(r.moved[0].dy, -0.5);
    near(worldBox(roof).min.y, 6, 1e-4);
  });

  it('drops a house hovering over its plinth onto the plinth, panes and all, as one body', () => {
    // The screenshot's case: the walls end above the foundation slab, the ground shows between.
    const root = new THREE.Group();
    box(root, 12, 0.3, 9, 0, 0, 0, 'plinth', 'stone');
    box(root, 30, 0.05, 30, 0, 0, 0, 'lawn', 'vegetation');
    const walls = box(root, 10, 6, 8, 0, 0.7, 0, 'mainBlock', 'wall');
    const pane = box(root, 1.2, 1.4, 0.06, 2, 3.7, 4.03, 'windows', 'glass');
    const roof = box(root, 10.4, 2, 8.4, 0, 6.7, 0, 'roof', 'roof');
    const r = geom.settleScene(THREE, root);
    assert.equal(r.moved.length, 1);
    assert.deepEqual([...r.moved[0].parts].sort(), ['mainBlock', 'roof', 'windows']);
    assert.equal(r.moved[0].meshes, 3);
    near(r.moved[0].dy, -0.4);
    near(worldBox(walls).min.y, 0.3, 1e-4);
    near(worldBox(pane).min.y, 3.3, 1e-4);
    near(worldBox(roof).min.y, 6.3, 1e-4);
  });

  it('settles the lower body first, so a roof lands on its walls and not through them', () => {
    const root = new THREE.Group();
    const walls = box(root, 10, 6, 8, 0, 0.3, 0, 'mainBlock', 'wall');
    const roof = box(root, 10.4, 2, 8.4, 0, 6.8, 0, 'roof', 'roof'); // 0.5 above the walls' top
    const r = geom.settleScene(THREE, root);
    assert.equal(r.moved.length, 2);
    assert.deepEqual(r.moved[0].parts, ['mainBlock']);
    near(r.moved[0].dy, -0.3);
    assert.deepEqual(r.moved[1].parts, ['roof']);
    near(r.moved[1].dy, -0.8);
    near(worldBox(walls).min.y, 0, 1e-4);
    near(worldBox(roof).min.y, 6, 1e-4);
  });

  it('moves a pane hanging in front of its wall back to the wall rather than down to the ground', () => {
    const root = new THREE.Group();
    const wall = box(root, 10, 6, 0.3, 0, 0, 0, 'wall', 'wall');
    const pane = box(root, 1.2, 1.4, 0.06, 2, 3, 0.5, 'windows', 'glass'); // 0.32 m off the wall's face
    const r = geom.settleScene(THREE, root);
    assert.equal(r.moved.length, 1);
    near(r.moved[0].dz, -0.32);
    near(r.moved[0].dy, 0);
    near(worldBox(pane).min.z, worldBox(wall).max.z, 1e-4);
  });

  it('raises a lamp under a ceiling to the ceiling when that is nearer than the floor', () => {
    const root = new THREE.Group();
    box(root, 10, 0.1, 10, 0, 0, 0, 'floor', 'other');
    box(root, 0.2, 2.6, 10, -4.9, 0.1, 0, 'leftWall', 'wall');
    box(root, 0.2, 2.6, 10, 4.9, 0.1, 0, 'rightWall', 'wall');
    box(root, 10, 0.1, 10, 0, 2.7, 0, 'ceiling', 'other');
    const lamp = box(root, 0.3, 0.4, 0.3, 0, 2.0, 0, 'lamp', 'metal'); // top at 2.4, ceiling at 2.7
    const r = geom.settleScene(THREE, root);
    assert.equal(r.moved.length, 1);
    assert.deepEqual(r.moved[0].parts, ['lamp']);
    near(r.moved[0].dy, 0.3);
    near(worldBox(lamp).max.y, 2.7, 1e-4);
  });

  it('moves meshes in world space whatever group they sit in, and takes the scene’s lowest point as the ground', () => {
    const root = new THREE.Group();
    const g = new THREE.Group();
    g.position.set(3, 1, -2);
    g.rotation.y = Math.PI / 2;
    root.add(g);
    const slab = box(root, 6, 0.2, 6, 0, -1, 0, 'slab', 'pavement'); // the lowest thing: the ground is at -1
    const block = box(g, 2, 2, 2, 0, 1, 0, 'block', 'wall'); // world base at y = 2, the slab's top at -0.8
    const r = geom.settleScene(THREE, root);
    assert.equal(r.moved.length, 1);
    near(r.moved[0].dy, -2.8);
    near(worldBox(block).min.y, worldBox(slab).max.y, 1e-4);
    near(worldBox(block).min.x, 2, 1e-4); // untouched sideways
  });

  it('accepts the ground level it is given', () => {
    const root = new THREE.Group();
    const block = box(root, 2, 2, 2, 0, 0.5, 0, 'block', 'wall');
    const r = geom.settleScene(THREE, root, 0);
    near(r.moved[0].dy, -0.5);
    near(worldBox(block).min.y, 0, 1e-4);
  });

  it('carries a mesh parented to a mesh of the same body once, not twice, whichever is listed first', () => {
    for (const childFirst of [false, true]) {
      const root = new THREE.Group();
      box(root, 10, 6, 8, 0, 0, 0, 'mainBlock', 'wall');
      // A roof 1 m above the walls with a chimney hung under the roof mesh (roof.add(chimney)).
      const roof = new THREE.Mesh(new THREE.BoxGeometry(10, 2, 8), new THREE.MeshBasicMaterial());
      roof.userData = { part: 'roof', kind: 'roof' };
      roof.position.set(0, 8, 0); // spans 7..9
      const chimney = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial());
      chimney.userData = { part: 'chimney', kind: 'wall' };
      chimney.position.set(3, 1.5, 0); // world 8.5..10.5: rests in the roof
      roof.add(chimney);
      if (childFirst) {
        // The traversal order puts the child's mesh first when the parent is added late.
        const holder = new THREE.Group();
        holder.add(roof);
        root.add(holder);
      } else root.add(roof);
      const before = worldBox(chimney).min.y;
      const r = geom.settleScene(THREE, root);
      assert.equal(r.moved.length, 1);
      near(r.moved[0].dy, -1);
      near(worldBox(roof).min.y, 6, 1e-4);
      near(worldBox(chimney).min.y, before - 1, 1e-4);
      assert.deepEqual(r.shifts.map((s) => s.part).sort(), ['chimney', 'roof']);
      assert.ok(r.shifts.every((s) => Math.abs(s.dy + 1) < 1e-9 && s.dx === 0 && s.dz === 0));
      assert.deepEqual(r.split, []);
    }
  });

  it('keeps the rotation and scale of a mesh placed by its matrix alone', () => {
    const root = new THREE.Group();
    box(root, 10, 6, 8, 0, 0, 0, 'mainBlock', 'wall');
    const roof = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 2), new THREE.MeshBasicMaterial());
    roof.userData = { part: 'roof', kind: 'roof' };
    roof.matrixAutoUpdate = false;
    roof.matrix.compose(
      new THREE.Vector3(0, 8, 0),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4),
      new THREE.Vector3(2, 1, 2),
    );
    root.add(roof);
    const r = geom.settleScene(THREE, root);
    assert.equal(r.moved.length, 1);
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    roof.matrix.decompose(p, q, s);
    near(p.y, 8 + r.moved[0].dy, 1e-6);
    near(s.x, 2, 1e-6);
    near(new THREE.Euler().setFromQuaternion(q, 'YXZ').y, Math.PI / 4, 1e-6);
    near(worldBox(roof).min.y, 6, 1e-4);
  });

  it('says how far each part was carried, and which part was pulled apart', () => {
    const root = new THREE.Group();
    box(root, 10, 6, 8, 0, 0, 0, 'mainBlock', 'wall');
    box(root, 10.4, 2, 8.4, 0, 6.5, 0, 'roof', 'roof'); // 0.5 above the walls
    // One part, two meshes: one on the ground, one floating over the roof's far side.
    box(root, 1, 1, 1, 8, 0, 0, 'shed', 'wall');
    box(root, 1, 1, 1, 20, 3, 0, 'shed', 'wall');
    const r = geom.settleScene(THREE, root);
    const roof = r.shifts.find((s) => s.part === 'roof');
    assert.ok(roof);
    near(roof!.dy, -0.5, 1e-9);
    assert.equal(
      r.shifts.find((s) => s.part === 'mainBlock'),
      undefined,
    ); // never moved
    assert.deepEqual(r.split, ['shed']);
  });
});

describe('roofCover', () => {
  it('reports the sides on which the walls under a roof stick out past it', () => {
    const root = new THREE.Group();
    box(root, 10, 6, 8, 0, 0, 0, 'mainBlock', 'wall');
    box(root, 6, 2, 8.4, 0, 6, 0, 'roof', 'roof'); // 2 m short on each side
    box(root, 4, 3, 3, 0, 0, 8, 'porch', 'wall'); // a lower wing under nothing: not this roof's
    const tol = 0.12;
    const out = geom.roofCover(THREE, root, tol);
    assert.equal(out.length, 1);
    assert.equal(out[0].part, 'roof');
    assert.deepEqual(out[0].sides, { left: 2, right: 2 });
  });

  it('says nothing about a roof that overhangs its walls, or one with no walls under it', () => {
    const root = new THREE.Group();
    box(root, 10, 6, 8, 0, 0, 0, 'mainBlock', 'wall');
    box(root, 10.4, 2, 8.4, 0, 6, 0, 'roof', 'roof');
    box(root, 3, 1, 3, 20, 0, 0, 'shelter', 'roof');
    assert.deepEqual(geom.roofCover(THREE, root, 0.12), []);
  });
});

/** Every triangle of a non-indexed convex solid faces away from the solid's centroid. */
function assertOutward(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position');
  assert.equal(p.count % 3, 0);
  const c = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) c.add(new THREE.Vector3().fromBufferAttribute(p, i));
  c.divideScalar(p.count);
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    d = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    d.fromBufferAttribute(p, i + 2);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a));
    const mid = new THREE.Vector3().add(a).add(b).add(d).divideScalar(3);
    assert.ok(n.dot(mid.sub(c)) > 0, `triangle ${i / 3} faces inward`);
  }
}
const bounds = (g: THREE.BufferGeometry) => {
  g.computeBoundingBox();
  return g.boundingBox as THREE.Box3;
};

describe('roof geometries', () => {
  it('gable: base w × d on y = 0, the ridge h up along x or z, faces outward', () => {
    const gx = geom.gableGeometry(THREE, 4, 1.5, 6, 'x');
    const bx = bounds(gx);
    assert.deepEqual([bx.min.x, bx.min.y, bx.min.z, bx.max.x, bx.max.y, bx.max.z], [-2, 0, -3, 2, 1.5, 3]);
    assert.equal(gx.getAttribute('position').count, 24); // bottom 2 + two slopes 4 + two gables 2 = 8 triangles
    assertOutward(gx);
    // The ridge runs along x: every vertex at the ridge height has z = 0.
    const p = gx.getAttribute('position');
    for (let i = 0; i < p.count; i++) if (p.getY(i) === 1.5) near(p.getZ(i), 0);
    const gz = geom.gableGeometry(THREE, 4, 1.5, 6, 'z');
    const pz = gz.getAttribute('position');
    for (let i = 0; i < pz.count; i++) if (pz.getY(i) === 1.5) near(pz.getX(i), 0);
    assertOutward(gz);
  });

  it('hip: a ridge along the longer side, a pyramid when square', () => {
    const h = geom.hipGeometry(THREE, 6, 2, 4);
    assert.equal(h.getAttribute('position').count, 24);
    assertOutward(h);
    const p = h.getAttribute('position');
    for (let i = 0; i < p.count; i++)
      if (p.getY(i) === 2) {
        near(p.getZ(i), 0);
        assert.ok(Math.abs(p.getX(i)) <= 1 + 1e-9);
      }
    const pyramid = geom.hipGeometry(THREE, 4, 2, 4);
    assert.equal(pyramid.getAttribute('position').count, 18); // bottom 2 + four triangles
    assertOutward(pyramid);
    const tall = geom.hipGeometry(THREE, 4, 2, 6);
    const pt = tall.getAttribute('position');
    for (let i = 0; i < pt.count; i++) if (pt.getY(i) === 2) near(pt.getX(i), 0);
  });

  it('shed: rises to h along the side named', () => {
    for (const [high, axis, sign] of [
      ['front', 'z', 1],
      ['back', 'z', -1],
      ['left', 'x', -1],
      ['right', 'x', 1],
    ] as const) {
      const s = geom.shedGeometry(THREE, 4, 1, 3, high);
      assertOutward(s);
      const b = bounds(s);
      assert.deepEqual([b.min.y, b.max.y], [0, 1]);
      const p = s.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        if (p.getY(i) !== 1) continue;
        near(axis === 'z' ? p.getZ(i) : p.getX(i), sign * (axis === 'z' ? 1.5 : 2));
      }
    }
  });

  it('prism: an outline of [dx, dz] extruded up, plan z kept as z; not an outline → null', () => {
    const g = geom.prismGeometry(
      THREE,
      [
        [-1, -1],
        [1, -1],
        [1, 0],
        [-1, 0],
      ],
      3,
    );
    assert.ok(g);
    const b = bounds(g as THREE.BufferGeometry);
    // The quarter turn that stands the extrusion up leaves float dust (1e-16) on the flat sides.
    const expect = (have: number[], want: number[]) => have.forEach((v, i) => near(v, want[i], 1e-9));
    expect([b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z], [-1, 0, -1, 1, 3, 0]);
    const L = geom.prismGeometry(
      THREE,
      [
        [-2, -2],
        [2, -2],
        [2, 0],
        [0, 0],
        [0, 2],
        [-2, 2],
      ],
      3,
    );
    const bl = bounds(L as THREE.BufferGeometry);
    expect([bl.min.x, bl.min.z, bl.max.x, bl.max.z], [-2, -2, 2, 2]);
    assert.equal(
      geom.prismGeometry(
        THREE,
        [
          [0, 0],
          [1, 0],
        ],
        3,
      ),
      null,
    );
    assert.equal(
      geom.prismGeometry(
        THREE,
        [
          [0, 0],
          [1, 'x'],
          [1, 1],
        ],
        3,
      ),
      null,
    );
    assert.equal(geom.prismGeometry(THREE, 'no', 3), null);
  });
});

describe('readSettled / describeSettled', () => {
  it('reads a report and puts it in words', () => {
    const s = readSettled({
      moved: [
        { parts: ['mainBlock', 'windows'], kinds: ['wall'], meshes: 3, dx: 0, dy: -0.4, dz: 0 },
        { parts: ['pane'], dx: 0, dy: 0, dz: -0.32 },
        { parts: ['unnamed'], dx: 0.5, dy: 0, dz: 0 },
        { parts: ['lamp'], dx: 0, dy: 0.3, dz: 0 },
      ],
      uncovered: [{ part: 'roof', sides: { left: 2, right: 2, front: 0, back: -1 } }],
    });
    assert.ok(s);
    assert.equal(s?.uncovered[0].sides.front, undefined);
    assert.equal(
      describeSettled(s),
      'The viewer moved what the program left floating onto what is under or beside it: mainBlock, windows down 0.4 m; pane 0.32 m back; the scenery 0.5 m to the right; lamp up 0.3 m. ' +
        'The roof of roof leaves the walls under it bare: 2 m on the left, 2 m on the right.',
    );
  });

  it('reads the per-part shifts and the split parts, and refuses malformed ones', () => {
    const s = readSettled({
      moved: [{ parts: ['roof'], dx: 0, dy: -0.5, dz: 0 }],
      uncovered: [],
      shifts: [{ part: 'roof', dx: 0, dy: -0.5, dz: 0 }],
      split: ['shed'],
    });
    assert.deepEqual(s?.shifts, [{ part: 'roof', dx: 0, dy: -0.5, dz: 0 }]);
    assert.deepEqual(s?.split, ['shed']);
    // A frame from before the shifts: none.
    assert.deepEqual(readSettled({ moved: [{ parts: ['roof'], dx: 0, dy: -0.5, dz: 0 }] })?.shifts, []);
    assert.equal(
      readSettled({ moved: [{ parts: ['r'], dx: 0, dy: -1, dz: 0 }], shifts: [{ part: 'r', dy: 'x' }] }),
      null,
    );
    assert.equal(readSettled({ moved: [{ parts: ['r'], dx: 0, dy: -1, dz: 0 }], split: [3] }), null);
  });

  it('is null for nothing, and for anything not shaped like a report', () => {
    assert.equal(readSettled(undefined), null);
    assert.equal(readSettled({ moved: [], uncovered: [] }), null);
    assert.equal(readSettled({ moved: [{ parts: 'x', dx: 0, dy: 0, dz: 0 }] }), null);
    assert.equal(readSettled({ moved: [{ parts: [], dx: 0, dy: 'down', dz: 0 }] }), null);
    assert.equal(readSettled({ uncovered: [{ part: 'roof' }] }), null);
    assert.equal(describeSettled(null), null);
  });
});
