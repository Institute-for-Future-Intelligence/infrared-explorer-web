/**
 * The geometry the twin's frame checks and makes after a scene program has run (docs/digital-twin-plan.md
 * §29): plain JavaScript in a string, spliced into TWIN_FRAME_HTML (twinFrame.ts) at __GEOMETRY_JS__ and
 * run against the real three package by twinFrameGeometry.test.ts. Every function takes THREE as its
 * first argument, so the same text runs in the sandboxed page and in Node. It defines:
 *
 *   settleScene(THREE, root, groundY) — what the program left floating is set down onto what is under it
 *       (or moved across to the mass beside it, or up to the one over it, when that is nearer than its own
 *       height). Meshes are moved in world space, one connected floating body at a time, lowest first.
 *       Returns { tol, moved: [{ parts, kinds, meshes, dx, dy, dz }] }.
 *   roofCover(THREE, root, tol) — the roofs that leave the walls under them uncovered, with how far the
 *       walls stick out on each side, metres. A report only: making a roof wider is the model's decision.
 *   gableGeometry / hipGeometry / shedGeometry / prismGeometry(THREE, ...) — the pitched shapes the part
 *       builders offer (p.gable, p.hip, p.shed, p.prism): base on y = 0, centred on x = z = 0, wound outward,
 *       flat-shaded (non-indexed, so the frame's per-vertex paint attributes attach like a box's).
 *
 * Written as String.raw with plain string concatenation inside: the frame's own rule — no template
 * literal and no backtick, or the frame's String.raw ends early.
 */
export const TWIN_GEOMETRY_JS = String.raw`
// ---- Geometry after a build (§29): the program is the model's; the frame sets down what floats and
// reports what a roof leaves bare. A program past this many meshes is left as written (the checks are
// quadratic in the mesh count).
const GEOM_MAX_MESHES = 1500;
/** A mesh's world box, or null when it has no finite geometry. */
function geomMeshBox(THREE, mesh) {
  const out = new THREE.Box3();
  if (mesh.isInstancedMesh) {
    mesh.computeBoundingBox();
    if (!mesh.boundingBox) return null;
    out.copy(mesh.boundingBox);
  } else {
    const g = mesh.geometry;
    if (!g) return null;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingBox) return null;
    out.copy(g.boundingBox);
  }
  out.applyMatrix4(mesh.matrixWorld);
  const v = [out.min.x, out.min.y, out.min.z, out.max.x, out.max.y, out.max.z];
  for (const n of v) if (!Number.isFinite(n)) return null;
  return out.isEmpty() ? null : out;
}
/** Every mesh under root with a finite world box: { mesh, box, part, kind }. */
function geomEntries(THREE, root) {
  root.updateMatrixWorld(true);
  const out = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const box = geomMeshBox(THREE, o);
    if (!box) return;
    out.push({ mesh: o, box, part: typeof o.userData.part === 'string' ? o.userData.part : 'unnamed', kind: typeof o.userData.kind === 'string' ? o.userData.kind : 'other' });
  });
  return out;
}
/** How much two intervals overlap (negative: the gap between them). */
const geomOverlap = (aMin, aMax, bMin, bMax) => Math.min(aMax, bMax) - Math.max(aMin, bMin);
/** Two boxes touch when they meet or intersect on every axis, to within tol. */
function geomTouching(a, b, tol) {
  return (
    geomOverlap(a.min.x, a.max.x, b.min.x, b.max.x) >= -tol &&
    geomOverlap(a.min.y, a.max.y, b.min.y, b.max.y) >= -tol &&
    geomOverlap(a.min.z, a.max.z, b.min.z, b.max.z) >= -tol
  );
}
/** The contact tolerance for a model of this size: about 1% of its largest extent, 5 mm to 25 cm — a
 *  pane a few centimetres proud of its wall touches it, a wall a storey's fraction above its plinth does not. */
function geomTolerance(size) {
  return Math.min(0.25, Math.max(0.005, 0.012 * size));
}
const geomRound = (v) => Math.round(v * 100) / 100;
/**
 * Set down what floats. Meshes that touch each other (boxes meeting within tol) form bodies; a body is
 * grounded when any mesh of it stands on the ground (groundY, the lowest point of the scene or 0) or
 * touches a grounded body. The lowest floating body is moved first: straight down onto the nearest grounded
 * mesh under it (or the ground) — unless that fall is longer than the body is tall, when the nearest
 * grounded mass in any direction wins, so a pane a hand's width in front of its wall goes back to the wall
 * and a lamp under a ceiling goes up to it, not down through the room. Then the bodies it now touches
 * are grounded with it, and the next lowest is looked at. Every move is in world space, each mesh once.
 */
function settleScene(THREE, root, groundYIn) {
  const items = geomEntries(THREE, root);
  const n = items.length;
  const empty = { tol: 0, moved: [] };
  if (n === 0 || n > GEOM_MAX_MESHES) return empty;
  const whole = new THREE.Box3();
  for (const it of items) whole.union(it.box);
  const ext = whole.getSize(new THREE.Vector3());
  const size = Math.max(ext.x, ext.y, ext.z, 0.2);
  const tol = geomTolerance(size);
  const groundY = Number.isFinite(groundYIn) ? groundYIn : Math.min(0, whole.min.y);
  const index = new Map(items.map((it, i) => [it.mesh, i]));
  // Contacts, symmetric.
  const adj = items.map(() => new Set());
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (geomTouching(items[i].box, items[j].box, tol)) { adj[i].add(j); adj[j].add(i); }
  const grounded = new Array(n).fill(false);
  const flood = (seeds) => {
    const stack = seeds.slice();
    while (stack.length) {
      const i = stack.pop();
      if (grounded[i]) continue;
      grounded[i] = true;
      for (const j of adj[i]) if (!grounded[j]) stack.push(j);
    }
  };
  flood(items.map((it, i) => i).filter((i) => items[i].box.min.y - groundY <= tol));
  const moved = [];
  const _wp = new THREE.Vector3();
  for (let guard = 0; guard < n; guard++) {
    // The floating bodies that remain, and the lowest of them.
    const seen = new Array(n).fill(false);
    let body = null, bodyMin = Infinity;
    for (let s = 0; s < n; s++) {
      if (grounded[s] || seen[s]) continue;
      const comp = [];
      const stack = [s];
      let lo = Infinity;
      while (stack.length) {
        const i = stack.pop();
        if (seen[i] || grounded[i]) continue;
        seen[i] = true;
        comp.push(i);
        lo = Math.min(lo, items[i].box.min.y);
        for (const j of adj[i]) if (!seen[j] && !grounded[j]) stack.push(j);
      }
      if (lo < bodyMin) { bodyMin = lo; body = comp; }
    }
    if (!body) break;
    const bbox = new THREE.Box3();
    for (const i of body) bbox.union(items[i].box);
    const height = bbox.max.y - bbox.min.y;
    // The fall: onto the nearest grounded mesh under any mesh of the body, else onto the ground.
    let down = bbox.min.y - groundY;
    const side = 0.5 * tol; // an overlap this small is an edge brushed, not a support
    for (const i of body) {
      const a = items[i].box;
      for (let j = 0; j < n; j++) {
        if (!grounded[j]) continue;
        const b = items[j].box;
        if (geomOverlap(a.min.x, a.max.x, b.min.x, b.max.x) <= side || geomOverlap(a.min.z, a.max.z, b.min.z, b.max.z) <= side) continue;
        const t = a.min.y - b.max.y;
        if (t >= 0 && t < down) down = t;
      }
    }
    let best = { dx: 0, dy: -down, dz: 0, t: down };
    if (down > height) {
      // Further than it is tall: the nearest grounded mass in any direction, if nearer.
      for (const i of body) {
        const a = items[i].box;
        for (let j = 0; j < n; j++) {
          if (!grounded[j]) continue;
          const b = items[j].box;
          const ox = geomOverlap(a.min.x, a.max.x, b.min.x, b.max.x);
          const oy = geomOverlap(a.min.y, a.max.y, b.min.y, b.max.y);
          const oz = geomOverlap(a.min.z, a.max.z, b.min.z, b.max.z);
          const consider = (dx, dy, dz, t) => { if (t >= 0 && t < best.t) best = { dx, dy, dz, t }; };
          if (ox > side && oz > side) consider(0, b.min.y - a.max.y, 0, b.min.y - a.max.y); // up onto its underside
          if (oy > side && oz > side) { consider(b.min.x - a.max.x, 0, 0, b.min.x - a.max.x); consider(-(a.min.x - b.max.x), 0, 0, a.min.x - b.max.x); }
          if (oy > side && ox > side) { consider(0, 0, b.min.z - a.max.z, b.min.z - a.max.z); consider(0, 0, -(a.min.z - b.max.z), a.min.z - b.max.z); }
        }
      }
    }
    if (best.t > tol) {
      const delta = new THREE.Vector3(best.dx, best.dy, best.dz);
      const parts = new Set(), kinds = new Set();
      const inBody = new Set(body);
      for (const i of body) {
        const it = items[i];
        const m = it.mesh;
        // Moved in world space: the parent's world matrix is current (nothing above a mesh moves, and a
        // parent mesh moved earlier updated its subtree), so its inverse places the mesh.
        m.getWorldPosition(_wp).add(delta);
        m.position.copy(m.parent ? m.parent.worldToLocal(_wp) : _wp);
        m.updateMatrix();
        m.updateMatrixWorld(true);
        it.box.translate(delta);
        parts.add(it.part);
        kinds.add(it.kind);
        // A mesh nested under this one (a program may parent a mesh to a mesh) came along: its cached
        // box follows, whatever body it is in.
        m.traverse((c) => {
          if (c === m || !c.isMesh) return;
          const ci = index.get(c);
          if (ci !== undefined && !inBody.has(ci)) items[ci].box.translate(delta);
        });
      }
      moved.push({ parts: [...parts], kinds: [...kinds], meshes: body.length, dx: geomRound(delta.x), dy: geomRound(delta.y), dz: geomRound(delta.z) });
      // Its contacts are new: with everything outside the body.
      for (const i of body) {
        for (let j = 0; j < n; j++) {
          if (inBody.has(j)) continue;
          if (geomTouching(items[i].box, items[j].box, tol)) { adj[i].add(j); adj[j].add(i); } else { adj[i].delete(j); adj[j].delete(i); }
        }
      }
    }
    // It stands on something now (by construction, or it never needed to move): it and whatever it
    // touches are grounded.
    flood(body);
  }
  return { tol, moved };
}
/**
 * The roofs that leave the walls under them bare. Per part with roof meshes: the box of its roof, the walls
 * (wall or glass meshes of any part) whose top meets the roof's base and whose footprint overlaps it, and how
 * far past the roof's box their union reaches on each side — left is -x, front +z. Only overshoots beyond
 * 2·tol are reported.
 */
function roofCover(THREE, root, tol) {
  const items = geomEntries(THREE, root);
  if (items.length === 0 || items.length > GEOM_MAX_MESHES) return [];
  const roofs = new Map();
  for (const it of items) {
    if (it.kind !== 'roof') continue;
    let r = roofs.get(it.part);
    if (!r) roofs.set(it.part, (r = new THREE.Box3()));
    r.union(it.box);
  }
  const out = [];
  for (const [part, r] of roofs) {
    const walls = new THREE.Box3();
    for (const it of items) {
      if (it.kind !== 'wall' && it.kind !== 'glass') continue;
      const b = it.box;
      if (b.min.y >= r.min.y || b.max.y < r.min.y - 4 * tol || b.max.y > r.max.y + tol) continue;
      if (geomOverlap(r.min.x, r.max.x, b.min.x, b.max.x) <= tol || geomOverlap(r.min.z, r.max.z, b.min.z, b.max.z) <= tol) continue;
      walls.union(b);
    }
    if (walls.isEmpty()) continue;
    const over = {
      left: r.min.x - walls.min.x,
      right: walls.max.x - r.max.x,
      front: walls.max.z - r.max.z,
      back: r.min.z - walls.min.z,
    };
    const sides = {};
    let any = false;
    for (const k of Object.keys(over)) if (over[k] > 2 * tol) { sides[k] = geomRound(over[k]); any = true; }
    if (any) out.push({ part, sides });
  }
  return out;
}
/** A convex solid from its faces (polygons of [x, y, z]), each triangulated as a fan and wound so its normal
 *  points away from the solid's centroid; flat-shaded, non-indexed. */
function polyGeometry(THREE, faces) {
  let cx = 0, cy = 0, cz = 0, count = 0;
  const clean = [];
  for (const f of faces) {
    const v = [];
    for (const p of f) {
      const last = v[v.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1] && last[2] === p[2]) continue;
      v.push(p);
    }
    while (v.length > 1 && v[0][0] === v[v.length - 1][0] && v[0][1] === v[v.length - 1][1] && v[0][2] === v[v.length - 1][2]) v.pop();
    if (v.length < 3) continue;
    clean.push(v);
    for (const p of v) { cx += p[0]; cy += p[1]; cz += p[2]; count++; }
  }
  if (count) { cx /= count; cy /= count; cz /= count; }
  const pos = [];
  for (const v of clean) {
    let nx = 0, ny = 0, nz = 0, fx = 0, fy = 0, fz = 0;
    for (let i = 0; i < v.length; i++) {
      const a = v[i], b = v[(i + 1) % v.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
      fx += a[0]; fy += a[1]; fz += a[2];
    }
    fx /= v.length; fy /= v.length; fz /= v.length;
    const order = nx * (fx - cx) + ny * (fy - cy) + nz * (fz - cz) >= 0 ? v : v.slice().reverse();
    for (let i = 1; i + 1 < order.length; i++) pos.push(order[0][0], order[0][1], order[0][2], order[i][0], order[i][1], order[i][2], order[i + 1][0], order[i + 1][1], order[i + 1][2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
/** A pitched roof: base w × d on y = 0, the ridge h above it along 'x' (the default) or 'z'. */
function gableGeometry(THREE, w, h, d, ridge) {
  const A = [-w / 2, 0, -d / 2], B = [w / 2, 0, -d / 2], C = [w / 2, 0, d / 2], D = [-w / 2, 0, d / 2];
  if (ridge === 'z') {
    const R1 = [0, h, -d / 2], R2 = [0, h, d / 2];
    return polyGeometry(THREE, [[A, B, C, D], [B, C, R2, R1], [D, A, R1, R2], [A, B, R1], [C, D, R2]]);
  }
  const R1 = [-w / 2, h, 0], R2 = [w / 2, h, 0];
  return polyGeometry(THREE, [[A, B, C, D], [D, C, R2, R1], [B, A, R1, R2], [A, D, R1], [C, B, R2]]);
}
/** A hipped roof: four slopes to a ridge along the longer side (a pyramid when w = d). */
function hipGeometry(THREE, w, h, d) {
  const A = [-w / 2, 0, -d / 2], B = [w / 2, 0, -d / 2], C = [w / 2, 0, d / 2], D = [-w / 2, 0, d / 2];
  if (d > w) {
    const r = (d - w) / 2, R1 = [0, h, -r], R2 = [0, h, r];
    return polyGeometry(THREE, [[A, B, C, D], [B, C, R2, R1], [D, A, R1, R2], [A, B, R1], [C, D, R2]]);
  }
  const r = (w - d) / 2, R1 = [-r, h, 0], R2 = [r, h, 0];
  return polyGeometry(THREE, [[A, B, C, D], [D, C, R2, R1], [B, A, R1, R2], [A, D, R1], [C, B, R2]]);
}
/** A single slope: base w × d on y = 0, rising to h along its 'front' (+z), 'back', 'left' (-x) or 'right' edge. */
function shedGeometry(THREE, w, h, d, high) {
  const A = [-w / 2, 0, -d / 2], B = [w / 2, 0, -d / 2], C = [w / 2, 0, d / 2], D = [-w / 2, 0, d / 2];
  if (high === 'front') {
    const E1 = [-w / 2, h, d / 2], E2 = [w / 2, h, d / 2];
    return polyGeometry(THREE, [[A, B, C, D], [A, B, E2, E1], [C, D, E1, E2], [A, D, E1], [B, C, E2]]);
  }
  if (high === 'left') {
    const E1 = [-w / 2, h, -d / 2], E2 = [-w / 2, h, d / 2];
    return polyGeometry(THREE, [[A, B, C, D], [B, C, E2, E1], [A, D, E2, E1], [A, B, E1], [D, C, E2]]);
  }
  if (high === 'right') {
    const E1 = [w / 2, h, -d / 2], E2 = [w / 2, h, d / 2];
    return polyGeometry(THREE, [[A, B, C, D], [A, D, E2, E1], [B, C, E2, E1], [A, B, E1], [C, D, E2]]);
  }
  const E1 = [-w / 2, h, -d / 2], E2 = [w / 2, h, -d / 2]; // 'back', the default
  return polyGeometry(THREE, [[A, B, C, D], [D, C, E2, E1], [B, A, E1, E2], [A, D, E1], [C, B, E2]]);
}
/** An outline of [dx, dz] pairs (metres about the mesh's x, z; three or more, either way round) extruded
 *  h upward from y = 0; null when the outline is not one. */
function prismGeometry(THREE, points, h) {
  if (!Array.isArray(points) || points.length < 3) return null;
  const shape = new THREE.Shape();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const x = Array.isArray(p) ? p[0] : p && typeof p === 'object' ? p.x : NaN;
    const z = Array.isArray(p) ? p[1] : p && typeof p === 'object' ? p.z : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    // The shape lies in its own x, y plane and is extruded along its z; rotated below so the extrusion
    // stands up (u, v, w) → (u, w, -v): a plan z becomes -v.
    if (i === 0) shape.moveTo(x, -z); else shape.lineTo(x, -z);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.computeVertexNormals();
  return g;
}
`;

/** What the frame reports of the settling, on the `built` message's `settled`: the bodies it moved, and
 *  the roofs that leave walls bare (roofCover). Metres, two decimals. */
export interface TwinSettled {
  moved: { parts: string[]; dx: number; dy: number; dz: number }[];
  uncovered: { part: string; sides: Partial<Record<'left' | 'right' | 'front' | 'back', number>> }[];
}

const SIDES = ['left', 'right', 'front', 'back'] as const;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The `settled` field of a built message, checked field by field (the frame's word is not taken on trust:
 *  a program can post in its name); null when it is not there or not shaped like one. */
export function readSettled(raw: unknown): TwinSettled | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { moved?: unknown; uncovered?: unknown };
  const moved: TwinSettled['moved'] = [];
  for (const m of Array.isArray(o.moved) ? o.moved : []) {
    if (!m || typeof m !== 'object') return null;
    const e = m as { parts?: unknown; dx?: unknown; dy?: unknown; dz?: unknown };
    if (!Array.isArray(e.parts) || !finite(e.dx) || !finite(e.dy) || !finite(e.dz)) return null;
    const parts = e.parts.filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 80);
    moved.push({ parts, dx: e.dx, dy: e.dy, dz: e.dz });
  }
  const uncovered: TwinSettled['uncovered'] = [];
  for (const u of Array.isArray(o.uncovered) ? o.uncovered : []) {
    if (!u || typeof u !== 'object') return null;
    const e = u as { part?: unknown; sides?: unknown };
    if (typeof e.part !== 'string' || !e.part || e.part.length > 80 || !e.sides || typeof e.sides !== 'object')
      return null;
    const sides: TwinSettled['uncovered'][number]['sides'] = {};
    for (const s of SIDES) {
      const v = (e.sides as Record<string, unknown>)[s];
      if (finite(v) && v > 0) sides[s] = v;
    }
    if (Object.keys(sides).length) uncovered.push({ part: e.part, sides });
  }
  return moved.length || uncovered.length ? { moved, uncovered } : null;
}

const metres = (v: number) => `${Math.round(Math.abs(v) * 100) / 100} m`;
const names = (parts: string[]) => {
  const list = parts.map((p) => (p === 'unnamed' ? 'the scenery' : p));
  return list.length ? list.join(', ') : 'a part';
};
/** One body's move in words: the largest component of its shift, in the viewer's directions (left is -x,
 *  front +z). */
function describeMove(m: TwinSettled['moved'][number]): string {
  const ax = Math.abs(m.dx),
    ay = Math.abs(m.dy),
    az = Math.abs(m.dz);
  const how =
    ay >= ax && ay >= az
      ? m.dy < 0
        ? `down ${metres(m.dy)}`
        : `up ${metres(m.dy)}`
      : ax >= az
        ? `${metres(m.dx)} to the ${m.dx < 0 ? 'left' : 'right'}`
        : `${metres(m.dz)} ${m.dz < 0 ? 'back' : 'forward'}`;
  return `${names(m.parts)} ${how}`;
}
const SIDE_WORDS: Record<(typeof SIDES)[number], string> = {
  left: 'on the left',
  right: 'on the right',
  front: 'at the front',
  back: 'at the back',
};

/** The settling as a sentence or two for the About section, or null when there is nothing to say. */
export function describeSettled(s: TwinSettled | null): string | null {
  if (!s) return null;
  const out: string[] = [];
  if (s.moved.length) {
    out.push(
      `The viewer moved what the program left floating onto what is under or beside it: ${s.moved.map(describeMove).join('; ')}.`,
    );
  }
  for (const u of s.uncovered) {
    const sides = SIDES.filter((k) => u.sides[k] !== undefined).map(
      (k) => `${metres(u.sides[k] as number)} ${SIDE_WORDS[k]}`,
    );
    if (sides.length) out.push(`The roof of ${u.part} leaves the walls under it bare: ${sides.join(', ')}.`);
  }
  return out.length ? out.join(' ') : null;
}
