/**
 * The API a scene program builds with (docs/digital-twin-plan.md §17, §29, §32): plain JavaScript in a
 * string, spliced into TWIN_FRAME_HTML (twinFrame.ts) at __API_JS__ — and run in Node against the real
 * three package by twinProgramNode.ts, for its tests and the photo-set eval (scripts/evalTwinBuilding.ts),
 * so a program is judged offline with the very builders the frame gives it.
 * It makes three forgiving where models trip it (a THREE.Path handed where a THREE.Shape is wanted), and
 * defines each part kind's look (LOOK, KINDS, asKind, makeMaterial), the builders (box, cylinder, and
 * the pitched shapes of twinFrameGeometry.ts, which it takes in at __GEOMETRY_JS__) and `api` itself:
 * api.part(name, kind, description) → { group, box, cylinder, gable, hip, shed, prism, add }, api.material,
 * and the bare api.box … api.prism for unnamed scenery. Its free names are THREE and scene: the frame's
 * own, or twinProgramNode's.
 *
 * Written as String.raw with plain string concatenation inside: the frame's rule — no template literal
 * and no backtick, or the frame's String.raw ends early.
 */
export const TWIN_API_JS = String.raw`// A forgiving three: models regularly hand THREE.ExtrudeGeometry / THREE.ShapeGeometry a THREE.Path
// (an outline drawn with moveTo/lineTo, or a window hole) where only a THREE.Shape has the method the
// geometry calls. A Path is a Shape without holes, so give it the same answer instead of letting the
// program die at its first window.
if (typeof THREE.Path.prototype.extractPoints !== 'function') {
  THREE.Path.prototype.extractPoints = function (divisions) {
    return { shape: this.getPoints(divisions), holes: [] };
  };
}

// ---- The material API the program builds with. Each part kind has a default look and is remembered
// on the material so the thermal views can tell parts apart. The building kinds carry the simulated
// balance below; the material kinds (metal, plastic, …) only pick a realistic colour.
const LOOK = {
  wall: { color: '#d8d9d5', roughness: 0.85, metalness: 0.05 },
  glass: { color: '#7fa7b8', roughness: 0.15, metalness: 0.3, transparent: true, opacity: 0.55 },
  roof: { color: '#b9b9b4', roughness: 0.9, metalness: 0 },
  column: { color: '#9d9c95', roughness: 0.8, metalness: 0.05 },
  canopy: { color: '#cfcfcb', roughness: 0.7, metalness: 0.1 },
  frame: { color: '#eeeeea', roughness: 0.6, metalness: 0.2 },
  pavement: { color: '#cdc6b6', roughness: 1, metalness: 0 },
  road: { color: '#55575a', roughness: 1, metalness: 0 },
  vegetation: { color: '#5d8a4a', roughness: 0.95, metalness: 0 },
  metal: { color: '#a9adb3', roughness: 0.35, metalness: 0.8 },
  plastic: { color: '#d9d5cc', roughness: 0.5, metalness: 0 },
  wood: { color: '#a8875f', roughness: 0.8, metalness: 0 },
  stone: { color: '#9a968c', roughness: 0.95, metalness: 0 },
  liquid: { color: '#6f9fc4', roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.7 },
  fabric: { color: '#8f7f8f', roughness: 1, metalness: 0 },
  other: { color: '#bdbdbd', roughness: 0.8, metalness: 0 },
};
const KINDS = Object.keys(LOOK);
const asKind = (k) => (KINDS.includes(k) ? k : 'other');
const HEX = /^#?[0-9a-fA-F]{6}$/;
function makeMaterial(kind, color) {
  const k = asKind(kind);
  const look = LOOK[k];
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(typeof color === 'string' && HEX.test(color) ? (color[0] === '#' ? color : '#' + color) : look.color),
    roughness: look.roughness,
    metalness: look.metalness,
    transparent: !!look.transparent,
    // Tinted glass does not write depth: panes and glazed boxes overlap freely without popping.
    depthWrite: !look.transparent,
    opacity: look.opacity == null ? 1 : look.opacity,
  });
  m.userData.kind = k;
  return m;
}
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
function place(mesh, kind, parent) {
  mesh.userData.kind = asKind(kind);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
function makeBox(w, h, d, x, y, z, kind, color) {
  w = Math.max(0.01, num(w, 1)); h = Math.max(0.01, num(h, 1)); d = Math.max(0.01, num(d, 1));
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), makeMaterial(kind, color));
  mesh.position.set(num(x, 0), num(y, 0) + h / 2, num(z, 0));
  return mesh;
}
function makeCylinder(r, h, x, y, z, kind, color) {
  r = Math.max(0.01, num(r, 0.3)); h = Math.max(0.01, num(h, 1));
  // Three height segments, so the ring seams sit exactly at the thirds a round body's measured
  // temperatures are traced in (upper / middle / lower), and no triangle straddles a band boundary; the
  // geometry is made non-indexed so no vertex is shared between the triangles of two bands, which would
  // otherwise interpolate a gradient across a boundary that is really a hard line.
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 24, 3).toNonIndexed(), makeMaterial(kind, color));
  mesh.position.set(num(x, 0), num(y, 0) + h / 2, num(z, 0));
  return mesh;
}
// The pitched shapes and the settling (twinFrameGeometry.ts, §29): gableGeometry, hipGeometry,
// shedGeometry, prismGeometry, settleScene, roofCover.
__GEOMETRY_JS__
const dim = (v, d) => Math.max(0.01, num(v, d));
/** A mesh of a geometry whose base is its y = 0, standing on y at x, z — the builders' rule. */
function makeShape(geometry, x, y, z, kind, color) {
  const mesh = new THREE.Mesh(geometry, makeMaterial(kind, color));
  mesh.position.set(num(x, 0), num(y, 0), num(z, 0));
  return mesh;
}
function makeGable(w, h, d, x, y, z, ridge, kind, color) {
  return makeShape(gableGeometry(THREE, dim(w, 1), dim(h, 1), dim(d, 1), ridge === 'z' ? 'z' : 'x'), x, y, z, kind, color);
}
function makeHip(w, h, d, x, y, z, kind, color) {
  return makeShape(hipGeometry(THREE, dim(w, 1), dim(h, 1), dim(d, 1)), x, y, z, kind, color);
}
const SHED_SIDES = ['front', 'back', 'left', 'right'];
function makeShed(w, h, d, x, y, z, high, kind, color) {
  return makeShape(shedGeometry(THREE, dim(w, 1), dim(h, 1), dim(d, 1), SHED_SIDES.includes(high) ? high : 'back'), x, y, z, kind, color);
}
/** An outline that is not one (fewer than three finite [dx, dz] pairs) becomes a 1 × h × 1 box, so the
 *  program still builds. */
function makePrism(points, h, x, y, z, kind, color) {
  const g = prismGeometry(THREE, points, dim(h, 1));
  return g ? makeShape(g, x, y, z, kind, color) : makeBox(1, h, 1, x, y, z, kind, color);
}
/** Tag an object and everything under it as belonging to a part — only what no part has claimed yet:
 *  a program may nest one api.part's group inside another (a wheel assembly added to a body), and the
 *  nested part and its meshes must keep their own name, or the part vanishes from the built model. */
function tagPart(obj, part) {
  obj.traverse((o) => { if (!o.userData.part) o.userData.part = part; });
  return obj;
}
/**
 * api.part: a scoped builder for one named part. Everything built through it lands in one group named
 * after the part, so a measured temperature has a body to attach to; box/cylinder default to the
 * part's kind, add() takes a mesh or group the program made from raw THREE.
 */
function partBuilder(name, kind, description) {
  const part = typeof name === 'string' && name.trim() ? name.trim() : 'unnamed';
  const partKind = asKind(kind);
  const group = new THREE.Group();
  group.name = part;
  group.userData.part = part;
  group.userData.partKind = partKind;
  group.userData.description = typeof description === 'string' ? description : '';
  scene.add(group);
  const kindOf = (k) => (typeof k === 'string' ? k : partKind);
  return Object.freeze({
    group,
    box(w, h, d, x, y, z, k, color) {
      return tagPart(place(makeBox(w, h, d, x, y, z, kindOf(k), color), kindOf(k), group), part);
    },
    cylinder(r, h, x, y, z, k, color) {
      return tagPart(place(makeCylinder(r, h, x, y, z, kindOf(k), color), kindOf(k), group), part);
    },
    gable(w, h, d, x, y, z, ridge, k, color) {
      return tagPart(place(makeGable(w, h, d, x, y, z, ridge, kindOf(k), color), kindOf(k), group), part);
    },
    hip(w, h, d, x, y, z, k, color) {
      return tagPart(place(makeHip(w, h, d, x, y, z, kindOf(k), color), kindOf(k), group), part);
    },
    shed(w, h, d, x, y, z, high, k, color) {
      return tagPart(place(makeShed(w, h, d, x, y, z, high, kindOf(k), color), kindOf(k), group), part);
    },
    prism(points, h, x, y, z, k, color) {
      return tagPart(place(makePrism(points, h, x, y, z, kindOf(k), color), kindOf(k), group), part);
    },
    add(obj) {
      if (obj && obj.isObject3D) {
        group.add(obj);
        tagPart(obj, part);
        // A mesh made from raw THREE with a material of its own and no kind is of the part's kind, as a
        // builder's mesh defaults to it (§30.6): left to adopt(), it would be 'other', and in a glass or a
        // steel part a stranger whose pixels the part's reading leaves out.
        obj.traverse((o) => {
          if (!o.isMesh || o.userData.kind) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          if (!(mats[0] && mats[0].userData && mats[0].userData.kind)) o.userData.kind = partKind;
        });
      }
      return obj;
    },
  });
}
const api = {
  material: (kind, color) => makeMaterial(kind, color),
  part: (name, kind, description) => partBuilder(name, kind, description),
  // Bare box/cylinder: scenery without a name (a pavement, a tree) — part 'unnamed'.
  box: (w, h, d, x, y, z, kind, color) => place(makeBox(w, h, d, x, y, z, kind, color), kind, scene),
  cylinder: (r, h, x, y, z, kind, color) => place(makeCylinder(r, h, x, y, z, kind, color), kind, scene),
  gable: (w, h, d, x, y, z, ridge, kind, color) => place(makeGable(w, h, d, x, y, z, ridge, kind, color), kind, scene),
  hip: (w, h, d, x, y, z, kind, color) => place(makeHip(w, h, d, x, y, z, kind, color), kind, scene),
  shed: (w, h, d, x, y, z, high, kind, color) => place(makeShed(w, h, d, x, y, z, high, kind, color), kind, scene),
  prism: (points, h, x, y, z, kind, color) => place(makePrism(points, h, x, y, z, kind, color), kind, scene),
};
Object.freeze(api);`;
