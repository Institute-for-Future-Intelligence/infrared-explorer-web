/**
 * The scene twin's viewer: a self-contained page that runs the model's scene program inside a
 * sandboxed iframe (docs/digital-twin-plan.md §17–§18). The program the vision model wrote is untrusted
 * code, so it never runs in the app's own document: the panel puts this page in an iframe with
 * `sandbox="allow-scripts"` (no same-origin — the frame has no origin, no storage, no access to the
 * parent) and talks to it with postMessage only.
 *
 * Messages in:  { type: 'build', code, mode, scenario, range, unit, materials?, parts?, subjectKind?, paint?, buildId? }
 *                   — run a program (replacing the model); `parts` are the declared part names the
 *                     frame resolves bare THREE objects against, `paint` a table to apply right away,
 *                     `buildId` a number the panel uses to tell this build's answer from a stale one
 *               { type: 'mode', mode, scenario, range, unit, materials? }
 *                   — 'realistic' | 'simulated' | 'measured' ('thermal' is an alias of 'simulated');
 *                     scenario = { tOut, tIn, irradiance, diffuse, sunAzimuthDeg, sunElevationDeg,
 *                     windH, skyLoss } and materials = { kind: { U, alpha, store, bias } } drive the
 *                     simulated balance, each missing value its default (utils/twinSimulation.ts)
 *               { type: 'paint', entries, lo, hi, palette, measuredOnly, stripes, ground }
 *                   — the measured heat map: one entry per (part, face) with tempC, status
 *                     measured/inferred/none and the label the probe shows; cached until the next build.
 *                     An entry whose value came from a round part traced as a whole (or in a band) may
 *                     carry `cameras` (the contributing photos' standpoints) and `farLabel`: the frame
 *                     paints the side of that part no camera saw as inferred and the probe reads farLabel
 *               { type: 'photos', photos: [{ photo, label, position, yaw, pitch, roll, fovV, aspect, dx, dy, w, h, temps }] }
 *                   — the thermal photos registered to the model (TwinProjectionPhoto in
 *                     src/utils/twinProjection.ts, at most 8): each one's fitted camera and its own
 *                     120 × 160 temperatures (`temps`, °C, a Float32Array or number[], NaN where the
 *                     panel masked the sky or an unreadable pixel), which the measured view projects onto
 *                     every surface the photo sees; a malformed photo is dropped, `photos: []` clears
 *                     them. Kept across builds: the cameras live in the model's frame, and the depth
 *                     pass is drawn again for the new geometry
 *               { type: 'probe', on, clear }                    — read temperatures under the pointer
 *               { type: 'view', x, y, z, targetX, targetY, targetZ, fov? } — look from a photo's standpoint;
 *                     `fov` (degrees, 10–120) is a registered photo's vertical field of view, so the
 *                     model lines up with the picture
 *               { type: 'overview' }                            — frame the whole model (the 45° lens again)
 * Messages out: { type: 'ready' } once, then
 *               { type: 'built', meshes, parts: [{ name, kinds, faces, center, min, max, meshCount, round }],
 *                 unnamedMeshes, size, buildId? } or { type: 'error', message, buildId? } — both echo the
 *                 build message's buildId, so the panel can ignore an answer to a program it has replaced,
 *               and { type: 'probes', count } whenever the pinned readings change.
 * The TypeScript shapes of `built` and `paint` live in src/utils/twinSceneThermal.ts.
 *
 * The frame owns the renderer, camera, lights, ground and orbit controls; the program only adds meshes
 * through a small API (api.part / api.material / api.box / api.cylinder, or raw THREE) — the same API
 * the contract in functions/src/twinBuilding.ts describes to the model. Every mesh belongs to a named
 * part (api.part's group, or an ancestor whose name matches a declared part; 'unnamed' otherwise):
 * the part is the unit a measured temperature attaches to.
 *
 * Three views. Realistic: the program's own materials. Simulated: every mesh's material swapped for a
 * shader that paints a plausible surface temperature from the part's kind and the direction it faces
 * under a chosen scenario — a demonstration of what a thermal camera would see, labelled as simulated,
 * not a measurement; the probe evaluates the shader's formula in JS for the surface under the pointer,
 * so a reading and the colour beneath it agree. Measured: the table the panel built from the thermal
 * photos, one value per (part, face), painted through per-vertex attributes into ONE shared shader —
 * measured faces in the palette, inferred faces under stripes of a contrasting colour, faces nothing
 * was measured for in a blue-grey no palette passes through — so a viewer can never mistake an
 * inference for a reading; the probe shows the entry's label verbatim. In the panel's all-inferred
 * fill every face (the ground too) carries a value and the stripes are off (`stripes: false`): there
 * the probe alone tells a reading from an inference. Wherever a registered photo sees a surface
 * SQUARELY — facing its camera at GRAZE_HI or more, and clear of the fade over the outer 4 % of its
 * picture and of its thermal grid — the measured view shows that photo's own pixels instead of the
 * table (projective texturing: each photo's fitted camera projects its thermal grid onto the model, and
 * a depth pass from each camera keeps a picture off what it could not see): a reading, never striped,
 * whatever the table says of the face. Seen at a graze (GRAZE_LO…GRAZE_HI) or near the edge of a
 * picture (or of its thermal grid), the pixels fade into the table's value for the face by 'sure' — how
 * fully the best photo vouches for the point — and below a sure of one half the point keeps the table's
 * state (its stripes, or the no-data grey where the table's value would not show). The probe reads the
 * same pixels with the same sums.
 * Both thermal scales are FIXED to the range the panel sends (a thermal camera in manual mode): the
 * same colour means the same temperature whatever is in the scene, and moving a slider visibly warms
 * or cools the picture instead of re-stretching it.
 *
 * The fixtures fit the model after every build: a bench-top kettle (0.3 m) and a building (100 m) both
 * get a ground plane just under them, a sun and shadow camera that cover them, a camera near plane
 * that does not clip them and orbit limits in proportion.
 *
 * three.js comes from a CDN through an import map: the frame has no origin, so it cannot load the
 * app's own bundle, and a script tag from a CDN with CORS is the one thing it can load. A CSP meta tag
 * in the head lets exactly that through — the CDN's scripts, the page's own inline script and styles,
 * and eval (the program runs through `new Function`) — and blocks every other load: the program can
 * neither fetch nor beacon anything, so what the server tells the model ("no network") is enforced.
 *
 * Written as String.raw with plain string concatenation inside: a template literal still substitutes
 * `${}`, so the frame's own code must not contain one, nor a backtick.
 */

import {
  SIM_DEFAULT_SKY_LOSS,
  SIM_DEFAULT_WIND_H,
  SIM_EMISSIVITY,
  SIM_MATERIALS,
  SIM_SIGMA,
} from '../../../utils/twinSimulation';

export const THREE_VERSION = '0.169.0';

export const TWIN_FRAME_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'" />
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #dfe6ee; font: 12px system-ui, sans-serif; color: #333; }
  canvas { display: block; width: 100%; height: 100%; }
  /* While probing the reticle IS the cursor: a DOM follower is always a frame behind the system pointer,
     which shows only when both are visible. */
  canvas.probing { cursor: none; }
  #legend { position: absolute; right: 10px; bottom: 10px; background: rgba(255,255,255,0.88); padding: 6px 8px; border-radius: 6px; display: none; min-width: 170px; max-width: 300px; }
  #legend .bar { height: 8px; border-radius: 3px; background: linear-gradient(to right, #020016, #4b0a6e, #a3155f, #e64d20, #f9b21c, #fdf6d0); }
  #legend .lab { display: flex; justify-content: space-between; margin-top: 3px; font-variant-numeric: tabular-nums; }
  #legend .keys { display: flex; gap: 10px; margin-top: 5px; font-size: 11px; color: #555; }
  #legend .keys span { display: inline-flex; align-items: center; gap: 4px; }
  #legend .sw { display: inline-block; width: 22px; height: 9px; border-radius: 2px; }
  /* The inferred swatch: the palette under the same diagonal stripes the shader draws (updateMeasuredLegend
     picks the stripe colour that contrasts with the palette; this is the default for the iron ramp). */
  #legend .sw.striped { background: repeating-linear-gradient(135deg, rgba(255,255,255,0.4) 0 2px, transparent 2px 4px), linear-gradient(to right, #020016, #4b0a6e, #a3155f, #e64d20, #f9b21c, #fdf6d0); }
  /* No data: the blue-grey the shader and the ground use, which no thermal palette passes through. */
  #legend .sw.none { background: #5a6674; }
  #hint { position: absolute; left: 10px; bottom: 10px; color: rgba(40,40,40,0.6); font-size: 11px; pointer-events: none; }
  /* The legend is at most 300 px wide (plus padding) in the bottom-right corner: the hint stops short of it. */
  body.legend-on #hint { max-width: calc(100% - 350px); }
  #probes { position: absolute; inset: 0; overflow: hidden; pointer-events: none; display: none; }
  /* A probe marker: its origin (translate) IS the surface point; the reticle SVG is centred on it exactly
     (no border box to mis-centre), the label sits up and to the right. */
  .probe { position: absolute; left: 0; top: 0; will-change: transform; }
  .probe .ring { position: absolute; left: -13px; top: -13px; display: block; }
  .probe .lab { position: absolute; left: 11px; top: -24px; white-space: nowrap; background: rgba(20,20,28,0.85); color: #fff; padding: 3px 7px; border-radius: 4px; font-variant-numeric: tabular-nums; }
  .probe .lab b { font-weight: 600; }
  .probe .lab span { color: #bbb; margin-left: 5px; }
  .probe .lab span:empty { display: none; }
  .probe .lab.dotted span::before { content: '· '; }
  .probe.pin { pointer-events: auto; cursor: pointer; }
  .probe.pin .ring .fg { stroke: #ffd54f; }
  .probe.pin .lab { border-left: 3px solid #ffd54f; }
  .probe.hidden-behind { opacity: 0.35; }
  .probe.nohit .lab { display: none; }
  #hover { pointer-events: none; }
</style>
<script type="importmap">
{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@__THREE_VERSION__/build/three.module.js", "three/addons/": "https://cdn.jsdelivr.net/npm/three@__THREE_VERSION__/examples/jsm/" } }
</script>
</head>
<body>
<canvas id="c"></canvas>
<div id="probes"><div id="hover" class="probe" style="display:none"></div></div>
<div id="legend">
  <div id="legSim"><div class="bar"></div><div class="lab"><span id="lo"></span><span id="hi"></span></div></div>
  <div id="legMeas" style="display:none"><div class="bar" id="mbar"></div><div class="lab"><span id="mlo"></span><span id="mhi"></span></div><div class="keys" id="mkeys"><span><i class="sw bar" id="msw"></i>measured</span><span><i class="sw striped" id="isw"></i>inferred</span><span><i class="sw none"></i>no data</span></div></div>
</div>
<div id="hint">drag to orbit · wheel to zoom · right-drag to pan</div>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// A forgiving three: models regularly hand THREE.ExtrudeGeometry / THREE.ShapeGeometry a THREE.Path
// (an outline drawn with moveTo/lineTo, or a window hole) where only a THREE.Shape has the method the
// geometry calls. A Path is a Shape without holes, so give it the same answer instead of letting the
// program die at its first window.
if (typeof THREE.Path.prototype.extractPoints !== 'function') {
  THREE.Path.prototype.extractPoints = function (divisions) {
    return { shape: this.getPoints(divisions), holes: [] };
  };
}

const post = (msg) => window.parent.postMessage(msg, '*');

// ---- The fixtures the program must not touch: renderer, camera, lights, ground.
const canvas = document.getElementById('c');
// A logarithmic depth buffer: a massing model is metres of slabs a few centimetres apart seen from
// a hundred metres away, where a linear 24-bit depth buffer with a close near plane cannot tell a
// pavement from the ground under it (the faces flicker against each other).
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// Nothing in the scene moves once built and the sun stands still, so the shadow map is drawn once per
// build (and mode change) rather than every frame: a whole depth pass saved on every redraw.
renderer.shadowMap.autoUpdate = false;
// Redraw only when something changed — the camera, the model, the materials, the uniforms. Between
// changes the main thread idles, so pointer events are handled the moment they arrive and the probe
// keeps up with the pointer instead of queueing behind a full-scene render every frame.
let dirty = true;
let camMoved = true; // the pinned readings need re-projecting (and their occlusion re-checking)
const invalidate = () => { dirty = true; camMoved = true; };
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe6ee);
const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 2500);
camera.position.set(70, 45, 90);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
// The orbit's floor: never under the target's horizon — except as far as a photo's view needs (a camera
// that looked up at a facade stands below the point it looks at); overview() puts the floor back.
const MAX_POLAR = Math.PI / 2 - 0.01;
controls.maxPolarAngle = MAX_POLAR;
controls.target.set(0, 6, 0);

const hemi = new THREE.HemisphereLight(0xffffff, 0x8c8a80, 0.9);
const sun = new THREE.DirectionalLight(0xffffff, 1.7);
sun.position.set(70, 110, 50);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -140; sc.right = 140; sc.top = 140; sc.bottom = -140; sc.near = 10; sc.far = 400;
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.04; // no shadow acne on the large flat roofs and slabs
// A unit plane scaled to the model: fitFixtures() sizes it after every build.
const groundMaterial = new THREE.MeshStandardMaterial({ color: 0xb8b3a6, roughness: 1 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.scale.set(1200, 1200, 1);
ground.position.y = -0.25; // well under any slab a program lays on the ground
ground.receiveShadow = true;
ground.userData.kind = 'ground';
scene.add(hemi, sun, sun.target, ground);
const fixtures = new Set([hemi, sun, sun.target, ground]);
const building = new THREE.Group();
building.name = 'building';
scene.add(building);
fixtures.add(building);

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
    add(obj) {
      if (obj && obj.isObject3D) {
        group.add(obj);
        tagPart(obj, part);
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
};
Object.freeze(api);

// ---- The simulated thermal look: one unlit shader per part kind, scenario uniforms shared.
// A steady-state surface energy balance, solved for the temperature at which a surface loses as much as
// it takes in: the sun (alpha · beam · cos, plus sky light over the part of the sky the face sees) and
// what leaks through from a conditioned interior (U · ΔT) go in; convection to the air (windH), the
// surface's own longwave radiation (emissivity · sigma · T⁴, which is what keeps a hot surface from
// running away as the wind drops), the extra longwave a clear sky takes, and the heat that soaks into
// the mass below a pavement (store) take it away. Newton's method solves it; the balance, its defaults
// and its reference implementation live in src/utils/twinSimulation.ts — the shader below, the JS mirror
// the probe reads (surfaceTemp) and that module must stay in step. Tuned to what cameras really measure:
// a dark road near 60 °C and a black roof near 68 °C on a clear 33 °C afternoon in a light breeze, a
// sunlit wall 10–15 K over the air, glass a few K over it on a winter night. No thermal mass as a time
// lag, no shadows cast by neighbouring parts, no reflections in glass — a demonstration.
// Every kind's material — U: conduction from a conditioned interior to this face (W/m²K); alpha: solar
// absorptance; bias: K, for what the balance leaves out — and the air film and sky cooling a twin starts
// with come from the panel's module (utils/twinSimulation.ts), injected here as JSON so the controls and
// the frame start from the same numbers. The panel's materials and scenario change them (setMaterials,
// applyScenario). Building kinds only: a material kind (metal, wood, …) is painted as 'other'.
const SIM_DEFAULTS = __SIM_DEFAULTS__;
const PROPS = {}; // kind → { U, alpha, bias } now in force
for (const k of Object.keys(SIM_DEFAULTS.materials)) PROPS[k] = Object.assign({}, SIM_DEFAULTS.materials[k]);
const shared = {
  sunDir: { value: new THREE.Vector3(0, 1, 0) },
  tOut: { value: 0 },
  tIn: { value: 21 },
  irr: { value: 0 }, // W/m², the beam on a surface squarely facing the sun
  dif: { value: 0 }, // W/m², sky light on a surface looking straight up
  hOut: { value: SIM_DEFAULTS.windH }, // W/m²K, convection to the outside air (the wind)
  skyLoss: { value: SIM_DEFAULTS.skyLoss }, // W/m², the extra longwave a clear sky takes from a face looking up
  tMin: { value: -10 },
  tMax: { value: 30 },
};
// Emissivity × the Stefan–Boltzmann constant, in the shader's units: temperatures enter the radiation
// term as (K / 100), so every quantity in it stays under a few hundred and a mediump float can hold it.
const ES100 = SIM_DEFAULTS.emissivity * SIM_DEFAULTS.sigma * 1e8;
const ES100_GLSL = ES100.toFixed(7);
const thermalMaterials = new Map();
function thermalMaterial(kind) {
  const k = PROPS[kind] ? kind : 'other';
  let m = thermalMaterials.get(k);
  if (m) return m;
  const p = PROPS[k];
  m = new THREE.ShaderMaterial({
    uniforms: Object.assign(
      { U: { value: p.U }, alpha: { value: p.alpha }, store: { value: p.store }, bias: { value: p.bias } },
      shared,
    ),
    // Double-sided: a program's open shell or plane (a floor, a lathe-turned vessel) must not vanish
    // when the thermal look replaces a material that was DoubleSide; the fragment flips the normal on
    // a back face, so the balance still reads the side the viewer sees.
    side: THREE.DoubleSide,
    vertexShader: [
      '#include <common>',
      '#include <logdepthbuf_pars_vertex>',
      'varying vec3 vNormal; varying vec3 vView;',
      'void main() {',
      // An InstancedMesh's vertices carry a per-instance matrix; without it every instance would be drawn
      // where the mesh itself sits.
      '  #ifdef USE_INSTANCING',
      '  mat4 wm = modelMatrix * instanceMatrix;',
      '  #else',
      '  mat4 wm = modelMatrix;',
      '  #endif',
      '  vNormal = normalize(mat3(wm) * normal);',
      '  vec4 wp = wm * vec4(position, 1.0);',
      '  vView = normalize(cameraPosition - wp.xyz);',
      '  gl_Position = projectionMatrix * viewMatrix * wp;',
      '  #include <logdepthbuf_vertex>',
      '}',
    ].join('\n'),
    fragmentShader: [
      '#include <common>',
      '#include <logdepthbuf_pars_fragment>',
      'uniform vec3 sunDir; uniform float tOut, tIn, irr, dif, hOut, skyLoss, tMin, tMax, U, alpha, store, bias;',
      'varying vec3 vNormal; varying vec3 vView;',
      'vec3 iron(float t) {',
      '  vec3 c0 = vec3(0.008, 0.0, 0.086), c1 = vec3(0.294, 0.039, 0.431), c2 = vec3(0.639, 0.082, 0.373),',
      '       c3 = vec3(0.902, 0.302, 0.125), c4 = vec3(0.976, 0.698, 0.110), c5 = vec3(0.992, 0.965, 0.816);',
      '  float s = clamp(t, 0.0, 1.0) * 5.0;',
      '  if (s < 1.0) return mix(c0, c1, s);',
      '  if (s < 2.0) return mix(c1, c2, s - 1.0);',
      '  if (s < 3.0) return mix(c2, c3, s - 2.0);',
      '  if (s < 4.0) return mix(c3, c4, s - 3.0);',
      '  return mix(c4, c5, s - 4.0);',
      '}',
      'void main() {',
      '  #include <logdepthbuf_fragment>',
      '  vec3 n = normalize(vNormal);',
      '  if (!gl_FrontFacing) n = -n;',
      '  float cosSun = max(0.0, dot(n, sunDir));',
      // A face looking straight up sees the whole sky, a vertical one half of it, one looking down none.
      '  float skyView = clamp(0.5 + 0.5 * n.y, 0.0, 1.0);',
      // The same balance as surfaceTemp() below and simSurfaceTemp in utils/twinSimulation.ts — keep the
      // three in step. Newton from the linear estimate: four steps settle it to a thousandth of a degree.
      '  float gain = alpha * (irr * cosSun + dif * skyView) + U * (tIn - tOut);',
      '  float h = max(0.5, hOut) + max(0.0, store);',
      '  float sky = skyView * skyLoss;',
      '  float xa = (tOut + 273.15) * 0.01;',
      '  float xa3 = xa * xa * xa;',
      '  float T = tOut + (gain - sky) / (h + 4.0 * ' + ES100_GLSL + ' * xa3 * 0.01);',
      '  for (int i = 0; i < 4; i++) {',
      '    float x = (T + 273.15) * 0.01;',
      '    float x3 = x * x * x;',
      '    float f = h * (T - tOut) + ' + ES100_GLSL + ' * (x3 * x - xa3 * xa) + sky - gain;',
      '    T -= f / (h + 4.0 * ' + ES100_GLSL + ' * x3 * 0.01);',
      '  }',
      '  T += bias;',
      '  float t = (T - tMin) / max(0.5, tMax - tMin);',
      // A faint view-angle shade so edges read as edges; small, so a colour still matches the legend.
      '  float shade = 0.92 + 0.08 * max(0.0, dot(n, normalize(vView)));',
      '  gl_FragColor = vec4(iron(t) * shade, 1.0);',
      '}',
    ].join('\n'),
  });
  thermalMaterials.set(k, m);
  return m;
}
/** The shader's balance in JS, for a world-space unit normal n: what the probe reads. Keep in step with
 *  the fragment shader above and with simSurfaceTemp in src/utils/twinSimulation.ts. */
function surfaceTemp(kind, n) {
  const p = PROPS[kind] || PROPS.other;
  const cosSun = Math.max(0, n.dot(shared.sunDir.value));
  const skyView = Math.min(1, Math.max(0, 0.5 + 0.5 * n.y));
  const tOut = shared.tOut.value;
  const gain = p.alpha * (shared.irr.value * cosSun + shared.dif.value * skyView) + p.U * (shared.tIn.value - tOut);
  const h = Math.max(0.5, shared.hOut.value) + Math.max(0, p.store);
  const sky = skyView * shared.skyLoss.value;
  const xa = (tOut + 273.15) * 0.01;
  const xa3 = xa * xa * xa;
  let T = tOut + (gain - sky) / (h + 4 * ES100 * xa3 * 0.01);
  for (let i = 0; i < 4; i++) {
    const x = (T + 273.15) * 0.01;
    const x3 = x * x * x;
    const f = h * (T - tOut) + ES100 * (x3 * x - xa3 * xa) + sky - gain;
    T -= f / (h + 4 * ES100 * x3 * 0.01);
  }
  return T + p.bias;
}
/** Take the panel's materials in: each kind's U, alpha and bias, a missing or non-finite value falling
 *  back to the kind's default (U never negative, alpha within 0..1); the cached shaders take them at once. */
function setMaterials(m) {
  const src = m && typeof m === 'object' ? m : {};
  for (const k of Object.keys(SIM_DEFAULTS.materials)) {
    const d = SIM_DEFAULTS.materials[k];
    const o = src[k] && typeof src[k] === 'object' ? src[k] : {};
    PROPS[k] = { U: Math.max(0, num(o.U, d.U)), alpha: Math.min(1, Math.max(0, num(o.alpha, d.alpha))), store: Math.max(0, num(o.store, d.store)), bias: num(o.bias, d.bias) };
  }
  for (const [k, mat] of thermalMaterials) {
    const p = PROPS[k];
    mat.uniforms.U.value = p.U;
    mat.uniforms.alpha.value = p.alpha;
    mat.uniforms.store.value = p.store;
    mat.uniforms.bias.value = p.bias;
  }
  dirty = true;
}
// The legend's range when the panel sends none: the extremes over every kind in the scene, for the six
// axis directions and the face that squarely meets the sun.
function temperatureRange(kinds) {
  let lo = Infinity, hi = -Infinity;
  const n = new THREE.Vector3();
  const dirs = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
  for (const k of kinds) {
    for (const d of dirs) {
      const T = surfaceTemp(k, n.set(d[0], d[1], d[2]));
      lo = Math.min(lo, T); hi = Math.max(hi, T);
    }
    const T = surfaceTemp(k, n.copy(shared.sunDir.value));
    lo = Math.min(lo, T); hi = Math.max(hi, T);
  }
  if (!Number.isFinite(lo)) { lo = shared.tOut.value - 5; hi = shared.tOut.value + 5; }
  if (hi - lo < 4) { const m = (lo + hi) / 2; lo = m - 2; hi = m + 2; }
  return [lo, hi];
}

// ---- The measured look: one shared unlit shader. Each vertex carries the temperature of the (part,
// face) it belongs to (aTemp) and whether that value was measured, inferred or missing (aState); the
// fragment looks the temperature up in a 256-entry palette texture — the same palette the photos were
// rendered with, so the twin's colours read like the pictures — and marks an inference with diagonal
// screen-space stripes, a missing value with a flat blue-grey. No view-angle shade: a colour IS a
// temperature. The stripes take whichever of black and white contrasts with the colour under them, so
// they show on a white-hot roof as well as on a black-hot one; the no-data colour is a desaturated
// blue-grey that no thermal palette passes through (the grey ramps run straight through a neutral grey,
// which would make a face without data look like a lukewarm reading).
const NO_DATA = '#5a6674';
const glslRgb = (hex) => 'vec3(' + hexRgb(hex).map((x) => (x / 255).toFixed(3)).join(', ') + ')';
/** The frame's own iron palette (the simulated shader's stops), 256 hex colours cold → hot. */
function ironLut() {
  const stops = ['#020016', '#4b0a6e', '#a3155f', '#e64d20', '#f9b21c', '#fdf6d0'];
  return resampleLut(stops);
}
const hexRgb = (h) => {
  const s = h[0] === '#' ? h.slice(1) : h;
  const v = parseInt(s, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
/** Any list of ≥ 2 hex colours resampled to exactly 256 by linear interpolation. */
function resampleLut(colors) {
  const rgb = colors.map(hexRgb);
  const out = [];
  for (let i = 0; i < 256; i++) {
    const f = (i / 255) * (rgb.length - 1);
    const a = Math.min(rgb.length - 1, Math.floor(f));
    const b = Math.min(rgb.length - 1, a + 1);
    const t = f - a;
    const c = [0, 1, 2].map((k) => Math.round(rgb[a][k] + (rgb[b][k] - rgb[a][k]) * t));
    out.push('#' + c.map((x) => x.toString(16).padStart(2, '0')).join(''));
  }
  return out;
}
const validPalette = (p) => Array.isArray(p) && p.length >= 2 && p.every((c) => typeof c === 'string' && HEX.test(c));
const lutTexture = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat);
lutTexture.minFilter = THREE.LinearFilter;
lutTexture.magFilter = THREE.LinearFilter;
lutTexture.generateMipmaps = false;
function setLut(colors) {
  const data = lutTexture.image.data;
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = hexRgb(colors[i]);
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  lutTexture.needsUpdate = true;
}
// The registered photos (a 'photos' message) paint over the table wherever they see the model. Each comes
// with the camera fitted to it — standpoint, yaw / pitch / roll in three's 'YXZ' order, vertical field of
// view, aspect — and its own 120 × 160 thermal grid. The fragment projects itself into every photo (the
// photo camera's view-projection), keeps the photos that have it in the picture, face it and SEE it — a
// depth pass from each camera (renderProjectionDepth) records the distance of the nearest surface, so a
// wall behind a porch post never takes the post's pixels — and blends their temperatures, weighted by how
// squarely the surface faces each camera (facing³) and faded over the outer 4 % of each picture, where the
// fit is least sure and a seam would show — and over the outer 4 % of its thermal grid as well: a picture
// registered with a shift (a visible photo's dx, dy) reaches past the grid on one side, where a lookup
// clamped to the grid would only repeat its last row or column across the model. Such a point is a reading
// whatever the table says of its face; the rest keeps the table's one value per face. A surface a photo
// sees only at a graze — the lawn in front of a house, from street level — takes that photo's pixels only
// partly (GRAZE_LO…GRAZE_HI), the rest from the table: at a graze every car and hedge the model lacks lands
// on it, smeared into long streaks, and a small error in the fit moves the picture a long way across it.
// The probe does the same sums in JS (projectedReading), with a raycast from each photo's camera standing in
// for its depth pass, so the reading under the pointer is the colour under it.
const PROJ_W = 120; // the thermal grid, x right, y down: a picture point (u, v) is grid (u·120 + dx, v·160 + dy)
const PROJ_H = 160;
// The cosine between the surface normal and the ray to a photo's camera below which the photo says nothing
// of the point (78°), and above which it says everything (66°); in between its pixels fade into the table's
// value. Written into the shader as literals: keep both non-integers (GLSL has no implicit int → float).
const GRAZE_LO = 0.2;
const GRAZE_HI = 0.4;
const PROJ_MAX = 8; // the shader's arrays hold this many photos
const TEMPS_GAP = 2; // texels between two cells of the temps atlas
const ATLAS_COLS = 4; // cells per row, in both atlases
const DEPTH_CELL = 512; // a depth cell's width in texels; its height follows its picture's aspect
/** Kinds whose reading is an apparent temperature (low emissivity or a reflection): the server's list. */
const APPARENT_KINDS = ['glass', 'metal', 'liquid'];
/** Bound to both atlas samplers while no photo is registered (projCount 0 never reads them). */
const projPlaceholder = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1, THREE.RGBAFormat);
projPlaceholder.needsUpdate = true;
const measured = {
  mLo: { value: 0 },
  mHi: { value: 1 },
  measuredOnly: { value: 0 },
  stripes: { value: 1 },
  lut: { value: lutTexture },
  // The projection (setProjectionPhotos, updateProjectionCameras): how many photos; each one's
  // view-projection and standpoint; its cell in the temps atlas (x0, y0 in texels, then the photo's
  // registration dx, dy in grid pixels); its cell in the depth atlas (a uv rect x, y, w, h); the angle one
  // depth texel spans (radians). Then the atlases (the temps atlas holds °C itself, in half floats), the
  // temps atlas's size in texels, the distance the depth atlas's values are fractions of, and the model's
  // size.
  projCount: { value: 0 },
  projVP: { value: Array.from({ length: PROJ_MAX }, () => new THREE.Matrix4()) },
  projPos: { value: Array.from({ length: PROJ_MAX }, () => new THREE.Vector3()) },
  projCell: { value: Array.from({ length: PROJ_MAX }, () => new THREE.Vector4()) },
  projDepth: { value: Array.from({ length: PROJ_MAX }, () => new THREE.Vector4()) },
  projTexel: { value: new Array(PROJ_MAX).fill(0) },
  tempsAtlas: { value: projPlaceholder },
  tempsSize: { value: new THREE.Vector2(1, 1) },
  depthAtlas: { value: projPlaceholder },
  distScale: { value: 1 },
  sceneSize: { value: 1 },
};
const measuredMaterial = new THREE.ShaderMaterial({
  uniforms: measured,
  side: THREE.DoubleSide, // as the simulated shader: a program's double-sided surfaces keep showing
  vertexShader: [
    '#include <common>',
    '#include <logdepthbuf_pars_vertex>',
    'attribute float aTemp; attribute float aState;',
    'varying float vT; varying float vS; varying vec3 vWorldPos; varying vec3 vWorldNormal;',
    'void main() {',
    '  vT = aTemp; vS = aState;',
    // Where the point is in the world and which way it faces, for the projection — an InstancedMesh's
    // instance matrix included, the normal through the inverse transpose (a non-uniformly scaled mesh).
    '  #ifdef USE_INSTANCING',
    '  mat4 wm = modelMatrix * instanceMatrix;',
    '  #else',
    '  mat4 wm = modelMatrix;',
    '  #endif',
    '  vWorldPos = (wm * vec4(position, 1.0)).xyz;',
    '  vWorldNormal = transpose(inverse(mat3(wm))) * normal;',
    '  vec3 transformed = vec3(position);',
    '  #include <project_vertex>', // handles an InstancedMesh's per-instance matrix too
    '  #include <logdepthbuf_vertex>',
    '}',
  ].join('\n'),
  fragmentShader: [
    '#include <common>',
    '#include <packing>',
    '#include <logdepthbuf_pars_fragment>',
    'uniform sampler2D lut;',
    'uniform float mLo, mHi, measuredOnly, stripes;',
    'uniform int projCount;',
    'uniform mat4 projVP[' + PROJ_MAX + '];',
    'uniform vec3 projPos[' + PROJ_MAX + '];',
    'uniform vec4 projCell[' + PROJ_MAX + '];',
    'uniform vec4 projDepth[' + PROJ_MAX + '];',
    'uniform float projTexel[' + PROJ_MAX + '];',
    'uniform sampler2D tempsAtlas; uniform vec2 tempsSize; uniform sampler2D depthAtlas;',
    'uniform float distScale, sceneSize;',
    'varying float vT; varying float vS; varying vec3 vWorldPos; varying vec3 vWorldNormal;',
    'void main() {',
    '  #include <logdepthbuf_fragment>',
    // The registered photos first — the same sums projectedReading() does for the probe; keep the two
    // in step. The normal is turned to the side the viewer sees, as the simulated shader does.
    '  vec3 n = normalize(vWorldNormal) * (gl_FrontFacing ? 1.0 : -1.0);',
    '  float wSum = 0.0;',
    '  float tSum = 0.0;',
    '  float sure = 0.0;', // how fully the best photo vouches for this point, 0..1 (see below)
    '  for (int i = 0; i < ' + PROJ_MAX + '; i++) {',
    '    if (i >= projCount) break;',
    '    vec4 clip = projVP[i] * vec4(vWorldPos, 1.0);',
    '    if (clip.w <= 0.0) continue;', // behind the camera
    '    vec2 ndc = clip.xy / clip.w;',
    '    if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) continue;', // outside the picture
    '    vec3 toCam = projPos[i] - vWorldPos;',
    '    float dist = length(toCam);',
    '    float facing = dot(n, toCam / max(dist, 1e-9));',
    '    if (!(facing >= ' + GRAZE_LO + ')) continue;', // turned away or seen at a graze (a NaN from a mesh without normals too)
    '    vec2 puv = ndc * 0.5 + 0.5;',
    // Hidden from this camera: the depth pass met a surface nearer along its ray. The allowance grows
    // with the distance and, on a surface seen at a slant, by the depth one texel spans along it, so a
    // face never shadows itself. Explicit level 0: no derivatives inside this loop.
    '    float stored = unpackRGBAToDepth(textureLod(depthAtlas, projDepth[i].xy + puv * projDepth[i].zw, 0.0)) * distScale;',
    '    float slope = sqrt(max(0.0, 1.0 - facing * facing)) / facing;',
    '    if (dist > stored + 0.01 * dist + 0.002 * sceneSize + projTexel[i] * dist * slope) continue;',
    // The thermal pixel under the point, where the photo's registration puts it — unclamped first, so the
    // edge fade below reaches zero at the grid's own edge too (a picture shifted past the grid on one side
    // would otherwise repeat the grid's last row or column across the model); clamped only for the lookup.
    '    vec2 gu = vec2(puv.x * 120.0, (1.0 - puv.y) * 160.0) + projCell[i].zw;',
    '    vec2 gf = gu / vec2(120.0, 160.0);',
    '    vec2 g = clamp(gu, vec2(0.5), vec2(119.5, 159.5));',
    '    vec4 s = textureLod(tempsAtlas, (projCell[i].xy + g) / tempsSize, 0.0);',
    '    if (s.a < 0.5) continue;', // the sky, or a pixel the camera could not read
    // The fade over the outer 4 % of the picture and over the outer 4 % of its thermal grid.
    '    vec2 edge = smoothstep(0.0, 0.04, puv) * smoothstep(0.0, 0.04, 1.0 - puv) * smoothstep(0.0, 0.04, gf) * smoothstep(0.0, 0.04, 1.0 - gf);',
    '    float graze = smoothstep(' + GRAZE_LO + ', ' + GRAZE_HI + ', facing);',
    '    float w = facing * facing * facing * edge.x * edge.y * graze;',
    '    wSum += w;',
    '    tSum += w * s.r;', // °C as it is: the temps atlas holds half floats
    '    sure = max(sure, edge.x * edge.y * graze);',
    '  }',
    // A point some photo sees squarely shows its reading and counts as measured, whatever the table entry
    // says, in every fill: no stripes, never the no-data grey. Seen at a graze (a lawn from street level,
    // where every car and hedge the model lacks would smear across it) or near the edge of a picture (or of
    // its thermal grid), the reading fades into the table's value for the face as 'sure' falls, and the
    // point keeps the table's state below one half. A face with no table value shows the reading only from
    // one half up. Elsewhere the table's value and state.
    '  bool seen = wSum > 1e-9;',
    '  float projT = seen ? tSum / wSum : vT;',
    // The table's value takes part only where it would show: a measurement, or an inference unless the
    // fill admits nothing inferred.
    '  bool tableShows = vS >= 0.75 || (vS >= 0.25 && measuredOnly < 0.5);',
    '  float t = seen ? (tableShows ? mix(vT, projT, sure) : projT) : vT;',
    '  float state = seen && sure >= 0.5 ? 1.0 : vS;',
    '  float u = clamp((t - mLo) / max(0.01, mHi - mLo), 0.0, 1.0);',
    '  vec3 c = texture2D(lut, vec2(u, 0.5)).rgb;',
    '  if (state < 0.25) {',
    '    c = ' + glslRgb(NO_DATA) + ';', // no data: flat blue-grey, no stripes
    '  } else if (state < 0.75) {', // inferred: the value (or the no-data base when only measurements may show colour) under stripes — plain when the fill turns them off
    '    if (measuredOnly > 0.5) c = ' + glslRgb(NO_DATA) + ';',
    '    if (stripes > 0.5) {',
    '      float h = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) * 0.125));',
    // Black stripes over a light colour, white over a dark one: visible whatever the palette.
    '      float lum = dot(c, vec3(0.299, 0.587, 0.114));',
    '      vec3 s = lum > 0.5 ? vec3(0.0) : vec3(1.0);',
    '      c = mix(c, s, 0.4 * h);',
    '    }',
    '  }',
    '  gl_FragColor = vec4(c, 1.0);',
    '}',
  ].join('\n'),
});
/** The depth pass's one material (renderProjectionDepth draws the whole model with it from each photo's
 *  camera): the distance of the surface from the camera, as a fraction of distScale packed into the four
 *  bytes of an RGBA8 texel (three's packDepthToRGBA), so the measured shader can tell what each photo
 *  could see. Double-sided like the looks it stands in for; with the log-depth chunks every material of
 *  this renderer needs, so the pass's own depth test keeps the nearest surface. */
const projDepthMaterial = new THREE.ShaderMaterial({
  uniforms: { distScale: measured.distScale }, // one uniform, shared with the measured shader
  side: THREE.DoubleSide,
  vertexShader: [
    '#include <common>',
    '#include <logdepthbuf_pars_vertex>',
    'varying vec3 vWorldPos;',
    'void main() {',
    '  #ifdef USE_INSTANCING',
    '  mat4 wm = modelMatrix * instanceMatrix;',
    '  #else',
    '  mat4 wm = modelMatrix;',
    '  #endif',
    '  vec4 wp = wm * vec4(position, 1.0);',
    '  vWorldPos = wp.xyz;',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '  #include <logdepthbuf_vertex>',
    '}',
  ].join('\n'),
  fragmentShader: [
    '#include <common>',
    '#include <packing>',
    '#include <logdepthbuf_pars_fragment>',
    'uniform float distScale;',
    'varying vec3 vWorldPos;',
    'void main() {',
    '  #include <logdepthbuf_fragment>',
    // cameraPosition: the photo camera this cell is drawn from (three sets it per camera).
    '  gl_FragColor = packDepthToRGBA(clamp(distance(vWorldPos, cameraPosition) / distScale, 0.0, 0.9999));',
    '}',
  ].join('\n'),
});
// The ground has no measurement either: the flat no-data colour, drawn with a stock material (log depth
// included); double-sided like the shaders so a mesh it stands in for is not lost from behind.
const noDataMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(NO_DATA), side: THREE.DoubleSide });
/** The ground in the all-inferred fill: the palette colour of the temperature the panel inferred for it
 *  (setPaintTable sets it whenever a table arrives, so it follows the scale). */
const groundPaintMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(NO_DATA), side: THREE.DoubleSide });
/** Relative luminance of a hex colour, 0–1: the rule the shader uses to pick a stripe colour. */
const luminance = (hex) => {
  const [r, g, b] = hexRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};
/** The shader's stripe, in CSS, for the colour under it: black over a light colour, white over a dark one. */
const stripeColor = (hex) => (luminance(hex) > 0.5 ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.4)');
const stripeLayer = (hex) => 'repeating-linear-gradient(135deg, ' + stripeColor(hex) + ' 0 2px, transparent 2px 4px)';
/** The stripe layers for a swatch showing a whole palette. The shader picks the stripe colour per pixel;
 *  a CSS layer cannot, and a ramp from black to white has no single contrasting colour — so the swatch
 *  is cut into a few segments, each striped in the colour that contrasts with the palette where it sits. */
function stripedSwatch(colors) {
  const SEGMENTS = 4;
  const layers = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const c = colors[Math.min(colors.length - 1, Math.floor(((i + 0.5) / SEGMENTS) * colors.length))];
    layers.push(stripeLayer(c) + ' ' + (i / (SEGMENTS - 1)) * 100 + '% 0 / calc(100% / ' + SEGMENTS + ') 100% no-repeat');
  }
  return layers.join(', ');
}

// ---- State and messages.
const MODES = ['realistic', 'simulated', 'measured'];
const asMode = (m) => (m === 'thermal' ? 'simulated' : MODES.includes(m) ? m : 'realistic');
let mode = 'realistic';
let unit = 'C';
let scenario = { tOut: -5, tIn: 21, irradiance: 0, diffuse: 0, sunAzimuthDeg: 0, sunElevationDeg: -10, windH: SIM_DEFAULTS.windH, skyLoss: SIM_DEFAULTS.skyLoss };
let range = null; // the fixed colour scale [lo, hi] in °C from the panel; null = stretch to the scene
let subjectKind = 'building';
let declaredParts = new Map(); // normalised name → the part name as declared (from the build message)
let partMeta = new Map(); // part name → { round, min, max, center } from the last build
let sceneSize = 100; // the model's largest extent, metres (fitFixtures)
const sceneCentre = new THREE.Vector3(0, 6, 0);
let paint = null; // the cached measured table: { byKey: Map('part|face' → entry), bandParts: Set, lo, hi, palette, measuredOnly, stripes, ground }
const originals = new Map(); // mesh → the material the program gave it
const clonedGeoms = new Set(); // geometries paint() cloned so a shared one could carry per-mesh attributes
const orphanGeoms = new Set(); // the shared originals those clones replaced (no mesh references them now)
const legend = document.getElementById('legend');
const fmtT = (c) => (unit === 'F' ? Math.round((c * 9) / 5 + 32) + ' °F' : Math.round(c) + ' °C');
const fmtT1 = (c) => {
  const v = unit === 'F' ? (c * 9) / 5 + 32 : c;
  const r = Math.round(v * 10) / 10;
  return (r === 0 ? 0 : r).toFixed(1) + (unit === 'F' ? ' °F' : ' °C');
};
const validRange = (r) => Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0];
const normalizePart = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const FACES = ['front', 'back', 'left', 'right', 'top', 'bottom'];
const LATERAL = ['front', 'back', 'left', 'right'];
const BANDS = ['upper', 'middle', 'lower'];
/** The six-face class of a world-space normal: its dominant axis, ties front > right > back > left > top
 *  > bottom (the same rule as faceOfNormal in src/utils/twinSceneThermal.ts). */
function faceOf(nx, ny, nz) {
  const cands = [['front', nz], ['right', nx], ['back', -nz], ['left', -nx], ['top', ny], ['bottom', -ny]];
  let face = 'front', best = -Infinity;
  for (const c of cands) if (c[1] > best) { best = c[1]; face = c[0]; }
  return face;
}
/** The height band of a world y within a part's box: the thirds a round body was traced in. */
function bandOf(y, meta) {
  const span = meta.max[1] - meta.min[1];
  const f = span > 1e-9 ? (y - meta.min[1]) / span : 0.5;
  return f > 2 / 3 ? 'upper' : f > 1 / 3 ? 'middle' : 'lower';
}
/** The table entry for a surface: (part, face) → (part, 'all') → null. A top or bottom face is looked
 *  up as itself first (a hot plate's top is its own reading even on a round body); a round MESH of a
 *  part traced in bands answers by the band the point lies in instead of its lateral face, while a boxy
 *  mesh of the same part (a kettle's handle) still resolves by face. */
function entryFor(part, face, y, roundMesh) {
  if (!paint) return null;
  const meta = partMeta.get(part);
  const horizontal = face === 'top' || face === 'bottom';
  const key = !horizontal && roundMesh && meta && paint.bandParts.has(part) ? bandOf(y, meta) : face;
  return paint.byKey.get(part + '|' + key) || paint.byKey.get(part + '|all') || null;
}
/** Whether a surface with world normal n on a part was in view of any of the cameras an entry came
 *  from: the normal leans toward the camera from the part's centre (the same 0.15 rule the panel's
 *  orientation check uses). An entry with no cameras is taken as seen everywhere. */
function seenByCameras(n, part, entry) {
  const cams = entry.cameras;
  if (!cams) return true;
  const meta = partMeta.get(part);
  if (!meta) return true;
  const c = meta.center;
  for (const cam of cams) {
    const dx = cam[0] - c[0], dy = cam[1] - c[1], dz = cam[2] - c[2];
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-9 && n.x * dx + n.y * dy + n.z * dz > 0.15 * len) return true;
  }
  return false;
}
/** A camera list as the panel sends it — [x, y, z] triples of finite numbers — or undefined. */
function readCameras(list) {
  if (!Array.isArray(list)) return undefined;
  const cams = list.filter((c) => Array.isArray(c) && c.length === 3 && c.every((v) => typeof v === 'number' && Number.isFinite(v)));
  return cams.length ? cams : undefined;
}
/** The palette colour of a temperature on the cached scale: what the shader paints a surface of it. */
function paletteColorAt(tempC) {
  const u = Math.min(1, Math.max(0, (tempC - paint.lo) / Math.max(0.01, paint.hi - paint.lo)));
  return paint.palette[Math.round(u * 255)];
}

// ---- The projection's state: the registered photos, their cameras and the two atlases the measured
// shader reads (see the note above PROJ_W).
const proj = {
  photos: [], // checked photos: { photo, label, position, yaw, pitch, roll, fovV, aspect, dx, dy, temps: Float32Array }
  cameras: [], // per photo: { cam: THREE.PerspectiveCamera, position: Vector3, vp: Matrix4 (view-projection) }
  depthCells: [], // per photo: { x, y, w, h } in texels of the depth atlas (y from the bottom, as GL's)
  tempsTexture: null, // the temps atlas (a DataTexture), or null
  depthTarget: null, // the depth atlas (a WebGLRenderTarget), or null
};
let projDirty = false; // the depth atlas must be drawn again before the next measured render
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** The photos of a photos message that are what the panel sends — a standpoint, three angles, a lens
 *  (1–170°) and aspect (0.2–5), a registration shift, a 120 × 160 grid of temperatures as a Float32Array
 *  or a number[] — at most PROJ_MAX; anything else is dropped, and so is a photo without a single
 *  readable pixel. The grid is copied; a value that is not a temperature a camera reads becomes NaN. */
function readProjectionPhotos(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const p of list) {
    if (out.length >= PROJ_MAX) break;
    if (!p || typeof p !== 'object') continue;
    const pos = p.position;
    if (!Array.isArray(pos) || pos.length !== 3 || !pos.every(finite)) continue;
    if (![p.yaw, p.pitch, p.roll, p.fovV, p.aspect, p.dx, p.dy].every(finite)) continue;
    if (p.fovV < 1 || p.fovV > 170 || p.aspect < 0.2 || p.aspect > 5) continue;
    if (Math.abs(p.dx) > PROJ_W || Math.abs(p.dy) > PROJ_H) continue;
    if (p.w !== PROJ_W || p.h !== PROJ_H) continue;
    const src = p.temps;
    if (!(Array.isArray(src) || ArrayBuffer.isView(src)) || src.length !== PROJ_W * PROJ_H) continue;
    const temps = new Float32Array(PROJ_W * PROJ_H);
    let readable = 0;
    for (let k = 0; k < temps.length; k++) {
      const v = src[k];
      temps[k] = typeof v === 'number' && v > -100 && v < 5000 ? v : NaN;
      if (temps[k] === temps[k]) readable++;
    }
    if (!readable) continue;
    const photo = finite(p.photo) ? p.photo : out.length + 1;
    const label = typeof p.label === 'string' && p.label.trim() ? p.label.trim().slice(0, 60) : 'photo ' + photo;
    out.push({ photo, label, position: pos.slice(), yaw: p.yaw, pitch: p.pitch, roll: p.roll, fovV: p.fovV, aspect: p.aspect, dx: p.dx, dy: p.dy, temps });
  }
  return out;
}
/** A copy of a grid whose unreadable pixels (NaN) take the mean of their readable 4-neighbours, ring by
 *  ring until none is left (the fill the old face textures used): what the temps atlas stores under a
 *  texel it marks unreadable, so linear filtering at the edge of the sky never blends in a stray value. */
function fillFromNeighbours(temps) {
  const w = PROJ_W, h = PROJ_H;
  const grid = Float32Array.from(temps);
  const known = new Uint8Array(w * h);
  for (let k = 0; k < grid.length; k++) known[k] = grid[k] === grid[k] ? 1 : 0;
  for (let pass = 0; pass < w + h; pass++) {
    const next = known.slice();
    let holes = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (known[k]) continue;
        let sum = 0, n = 0;
        if (i > 0 && known[k - 1]) { sum += grid[k - 1]; n++; }
        if (i < w - 1 && known[k + 1]) { sum += grid[k + 1]; n++; }
        if (j > 0 && known[k - w]) { sum += grid[k - w]; n++; }
        if (j < h - 1 && known[k + w]) { sum += grid[k + w]; n++; }
        if (n) { grid[k] = sum / n; next[k] = 1; } else holes++;
      }
    }
    known.set(next);
    if (!holes) break;
  }
  return grid;
}
/** The temps atlas: every photo's grid in one RGBA half-float texture, 120 × 160 cells TEMPS_GAP texels
 *  apart, ATLAS_COLS to a row, the grid's top row first (a texel's y is the grid's). R is the temperature
 *  in °C itself — a half float keeps it to about 0.03 K at 40 °C and 0.06 K at 100 °C, where one byte
 *  stretched over every photo's range (a 100 °C chimney in one picture, a frosty verge in another) would
 *  step 0.4 K and band a wall's gentle gradient — and A is 1 for a reading, 0 for a pixel the panel
 *  masked (and in the gaps between cells); linearly filtered, which WebGL 2 does for half floats, no
 *  mipmaps. */
function buildTempsAtlas(photos) {
  const half = THREE.DataUtils.toHalfFloat;
  const one = half(1);
  const cols = Math.min(ATLAS_COLS, photos.length);
  const rows = Math.ceil(photos.length / ATLAS_COLS);
  const width = cols * (PROJ_W + TEMPS_GAP), height = rows * (PROJ_H + TEMPS_GAP);
  const data = new Uint16Array(width * height * 4); // all zero bits: 0 °C, unreadable
  const cells = [];
  photos.forEach((p, idx) => {
    const x0 = (idx % ATLAS_COLS) * (PROJ_W + TEMPS_GAP), y0 = Math.floor(idx / ATLAS_COLS) * (PROJ_H + TEMPS_GAP);
    cells.push([x0, y0]);
    const filled = fillFromNeighbours(p.temps);
    for (let j = 0; j < PROJ_H; j++) {
      for (let i = 0; i < PROJ_W; i++) {
        const k = j * PROJ_W + i;
        const v = filled[k];
        const o = ((y0 + j) * width + x0 + i) * 4;
        data[o] = half(v === v ? v : 0);
        data[o + 3] = p.temps[k] === p.temps[k] ? one : 0;
      }
    }
  });
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, width, height, cells };
}
/** Where each photo's cell sits in the depth atlas: DEPTH_CELL texels wide and as tall as its picture's
 *  aspect makes it (at most twice as tall as wide), ATLAS_COLS to a row, rows stacked from the bottom —
 *  the cell size halved until the atlas fits the GPU's largest texture. */
function layoutDepthCells(photos) {
  const max = renderer.capabilities.maxTextureSize || 4096;
  for (let cellW = DEPTH_CELL; ; cellW /= 2) {
    const cells = [];
    let width = 0, height = 0;
    for (let r = 0; r * ATLAS_COLS < photos.length; r++) {
      const row = photos.slice(r * ATLAS_COLS, (r + 1) * ATLAS_COLS);
      let rowH = 0;
      row.forEach((p, c) => {
        const h = Math.max(8, Math.min(2 * cellW, Math.round(cellW / p.aspect)));
        cells.push({ x: c * cellW, y: height, w: cellW, h });
        rowH = Math.max(rowH, h);
      });
      width = Math.max(width, row.length * cellW);
      height += rowH;
    }
    if ((width <= max && height <= max) || cellW <= 64) return { width, height, cells };
  }
}
/** Each photo's camera in the model's frame — near and far planes in proportion to the model, which a
 *  new build changes — and the uniforms the measured shader projects with. The convention is the
 *  server's fit (utils/twinProjection.ts mirrors it): rotation Ry(yaw)·Rx(pitch)·Rz(roll), three's
 *  Euler order 'YXZ', looking along its own −z with +y up; fovV vertical, aspect width / height. */
function updateProjectionCameras() {
  let reach = 0;
  proj.cameras = proj.photos.map((p, i) => {
    const position = new THREE.Vector3(p.position[0], p.position[1], p.position[2]);
    const far = Math.max(100 * sceneSize, position.distanceTo(sceneCentre) + 4 * sceneSize);
    const cam = new THREE.PerspectiveCamera(p.fovV, p.aspect, sceneSize / 500, far);
    cam.position.copy(position);
    cam.rotation.set(p.pitch, p.yaw, p.roll, 'YXZ');
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    measured.projVP.value[i].copy(vp);
    measured.projPos.value[i].copy(position);
    reach = Math.max(reach, position.distanceTo(sceneCentre) + 2 * sceneSize);
    return { cam, position, vp };
  });
  // The depth atlas stores distances as fractions of this: the farthest camera's reach over the model.
  measured.distScale.value = Math.max(reach, 1e-3);
  measured.sceneSize.value = sceneSize;
}
/** Take a photos message in: check the photos, pack their grids into the temps atlas, lay out the depth
 *  atlas (reusing the render target when its size is unchanged), place the cameras and ask for a depth
 *  pass. An empty list clears the projection; the textures replaced are released. */
function setProjectionPhotos(list) {
  const photos = readProjectionPhotos(list);
  proj.photos = photos;
  measured.projCount.value = 0;
  if (proj.tempsTexture) proj.tempsTexture.dispose();
  proj.tempsTexture = null;
  measured.tempsAtlas.value = projPlaceholder;
  if (!photos.length) {
    if (proj.depthTarget) proj.depthTarget.dispose();
    proj.depthTarget = null;
    measured.depthAtlas.value = projPlaceholder;
    proj.cameras = [];
    proj.depthCells = [];
    projDirty = false;
    return;
  }
  const atlas = buildTempsAtlas(photos);
  proj.tempsTexture = atlas.texture;
  measured.tempsAtlas.value = atlas.texture;
  measured.tempsSize.value.set(atlas.width, atlas.height);
  photos.forEach((p, i) => measured.projCell.value[i].set(atlas.cells[i][0], atlas.cells[i][1], p.dx, p.dy));
  const layout = layoutDepthCells(photos);
  const rt = proj.depthTarget;
  if (!rt || rt.width !== layout.width || rt.height !== layout.height) {
    if (rt) rt.dispose();
    proj.depthTarget = new THREE.WebGLRenderTarget(layout.width, layout.height, {
      minFilter: THREE.NearestFilter, // packed distances: never blended
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
    });
  }
  proj.depthCells = layout.cells;
  measured.depthAtlas.value = proj.depthTarget.texture;
  layout.cells.forEach((c, i) => {
    measured.projDepth.value[i].set(c.x / layout.width, c.y / layout.height, c.w / layout.width, c.h / layout.height);
    // The angle one depth texel spans: the picture's height over the cell's.
    measured.projTexel.value[i] = (2 * Math.tan((photos[i].fovV * Math.PI) / 360)) / c.h;
  });
  updateProjectionCameras();
  measured.projCount.value = photos.length;
  projDirty = true;
}
const _clearColor = new THREE.Color();
/** Draw the depth atlas: the model from each photo's camera into that photo's cell (the target's viewport
 *  and scissor), every surface in the one depth material, over a white clear (the farthest distance). The
 *  ground fixture is left out of the pass: it never takes a photo's pixels, and drawn double-sided it would
 *  hide the whole model from a camera fitted a little below it (a program's own floor or pavement is part
 *  of the model and stays). The probe's occlusion ray skips the ground alike. The renderer is left as it
 *  was found: its target, clear colour, the scene's background and override material, the ground shown
 *  or not as before. */
function renderProjectionDepth() {
  projDirty = false;
  const rt = proj.depthTarget;
  if (!rt || !proj.cameras.length) return;
  const prevTarget = renderer.getRenderTarget();
  const prevBackground = scene.background;
  const prevOverride = scene.overrideMaterial;
  const prevAlpha = renderer.getClearAlpha();
  const prevGround = ground.visible;
  renderer.getClearColor(_clearColor);
  scene.background = null;
  scene.overrideMaterial = projDepthMaterial;
  ground.visible = false;
  renderer.setClearColor(0xffffff, 1);
  try {
    rt.viewport.set(0, 0, rt.width, rt.height);
    rt.scissorTest = false;
    renderer.setRenderTarget(rt);
    renderer.state.buffers.color.setMask(true);
    renderer.state.buffers.depth.setMask(true);
    renderer.clear(true, true, false); // the gaps between cells too
    for (let i = 0; i < proj.cameras.length; i++) {
      const c = proj.depthCells[i];
      rt.viewport.set(c.x, c.y, c.w, c.h);
      rt.scissor.set(c.x, c.y, c.w, c.h);
      rt.scissorTest = true;
      renderer.setRenderTarget(rt); // takes the target's viewport and scissor in
      renderer.render(scene, proj.cameras[i].cam); // autoClear: clears this cell only (the scissor)
    }
  } finally {
    rt.viewport.set(0, 0, rt.width, rt.height);
    rt.scissor.set(0, 0, rt.width, rt.height);
    rt.scissorTest = false;
    renderer.setRenderTarget(prevTarget);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;
    ground.visible = prevGround;
    renderer.setClearColor(_clearColor, prevAlpha);
  }
}

function applyScenario(s, r) {
  scenario = s;
  if (r !== undefined) range = validRange(r) ? [r[0], r[1]] : null;
  const az = (num(s.sunAzimuthDeg, 0) * Math.PI) / 180;
  const el = (num(s.sunElevationDeg, 0) * Math.PI) / 180;
  const day = el > 0; // below the horizon the sun delivers nothing, beam or sky light
  const irr = day ? Math.max(0, num(s.irradiance, 0)) : 0;
  shared.sunDir.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
  shared.tOut.value = num(s.tOut, 0);
  shared.tIn.value = num(s.tIn, 21);
  shared.irr.value = irr;
  shared.dif.value = day ? Math.max(0, num(s.diffuse, 0)) : 0;
  shared.hOut.value = Math.max(0.5, num(s.windH, SIM_DEFAULTS.windH));
  shared.skyLoss.value = Math.max(0, num(s.skyLoss, SIM_DEFAULTS.skyLoss));
  let lo, hi;
  if (range) {
    lo = range[0]; hi = range[1];
  } else {
    const kinds = new Set(['ground']);
    building.traverse((o) => { if (o.isMesh) kinds.add(o.userData.kind || 'other'); });
    [lo, hi] = temperatureRange(kinds);
  }
  shared.tMin.value = lo;
  shared.tMax.value = hi;
  document.getElementById('lo').textContent = fmtT(lo);
  document.getElementById('hi').textContent = fmtT(hi);
  dirty = true;
  refreshProbes();
}
/** The measured legend: the palette as a CSS gradient (24 stops), the scale's ends and the keys. What the
 *  colours mean is said in the panel's Measured section, not over the model. */
function updateMeasuredLegend() {
  if (!paint) return;
  const stops = [];
  for (let i = 0; i < 24; i++) stops.push(paint.palette[Math.round((i / 23) * 255)]);
  const gradient = 'linear-gradient(to right, ' + stops.join(', ') + ')';
  document.getElementById('mbar').style.background = gradient;
  document.getElementById('msw').style.background = gradient;
  // The inferred key is drawn with the shader's own recipe: contrasting stripes over the palette, or over
  // the no-data base when only measurements may show colour — so the key matches the picture.
  document.getElementById('isw').style.background = paint.measuredOnly
    ? stripeLayer(NO_DATA) + ', ' + NO_DATA
    : stripedSwatch(stops) + ', ' + gradient;
  // With inferences painted plain the keys would show three swatches for two looks: the panel says so.
  document.getElementById('mkeys').style.display = paint.stripes ? 'flex' : 'none';
  document.getElementById('mlo').textContent = fmtT(paint.lo);
  document.getElementById('mhi').textContent = fmtT(paint.hi);
}
/** Which look the meshes wear now: the program's materials, the simulated shader per kind, or the
 *  measured shader (only once a table has arrived — before that measured mode shows the realistic look). */
function applyMode() {
  const simulated = mode === 'simulated';
  const measuredView = mode === 'measured' && !!paint;
  const swap = (mesh) => {
    if (simulated || measuredView) {
      if (!originals.has(mesh)) originals.set(mesh, mesh.material);
      mesh.material = simulated ? thermalMaterial(mesh.userData.kind || 'other') : measuredMaterial;
    } else if (originals.has(mesh)) {
      mesh.material = originals.get(mesh);
    }
  };
  building.traverse((o) => { if (o.isMesh) swap(o); });
  // The ground is a fixture: its own material is a constant, not an entry in originals (which a
  // rebuild clears while the ground stays).
  ground.material = simulated ? thermalMaterial('ground') : measuredView ? (paint.ground ? groundPaintMaterial : noDataMaterial) : groundMaterial;
  scene.background.set(simulated || measuredView ? 0x101018 : subjectKind === 'interior' ? 0x9aa0a6 : 0xdfe6ee);
  legend.style.display = simulated || measuredView ? 'block' : 'none';
  document.body.classList.toggle('legend-on', simulated || measuredView); // the hint wraps short of it
  document.getElementById('legSim').style.display = simulated ? 'block' : 'none';
  document.getElementById('legMeas').style.display = measuredView ? 'block' : 'none';
  if (measuredView) updateMeasuredLegend();
  renderer.shadowMap.needsUpdate = true; // a build lands here too: the new model's shadows, once
  dirty = true;
  applyProbeState();
}
function clearBuilding() {
  const disposeMats = (mats) => {
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      if (m && m.dispose && m !== measuredMaterial && m !== noDataMaterial && !(m instanceof THREE.ShaderMaterial)) m.dispose();
    }
  };
  for (const child of [...building.children]) {
    building.remove(child);
    child.traverse((o) => {
      if (o.isMesh) {
        o.geometry && o.geometry.dispose && o.geometry.dispose();
        disposeMats(o.material);
        if (originals.has(o)) disposeMats(originals.get(o)); // the program's material, parked while a thermal view showed
      }
    });
  }
  for (const g of clonedGeoms) g.dispose();
  for (const g of orphanGeoms) g.dispose();
  clonedGeoms.clear();
  orphanGeoms.clear();
  originals.clear();
  partMeta = new Map();
  clearPins();
}
/** The part a mesh belongs to: its own tag (api.part), else the nearest ancestor tagged or named after a
 *  declared part, else 'unnamed' — cached on the mesh so paint and probe never walk the tree again. */
function resolvePart(mesh) {
  for (let a = mesh; a && a !== building && a !== scene; a = a.parent) {
    if (typeof a.userData.part === 'string' && a.userData.part) return a.userData.part;
    if (a.name) {
      const declared = declaredParts.get(normalizePart(a.name));
      if (declared) return declared;
    }
  }
  return 'unnamed';
}
function adopt() {
  // Whatever the program added to the scene (through the API or by hand) becomes part of the building.
  for (const child of [...scene.children]) if (!fixtures.has(child)) { scene.remove(child); building.add(child); }
  // A program that cleared the scene (scene.clear(), scene.remove(...)) took the fixtures with it — the
  // lights, the ground and the building group its own objects were just moved into; put them back, or
  // the model never renders.
  for (const f of fixtures) if (f.parent !== scene) scene.add(f);
  let meshes = 0;
  building.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    o.castShadow = true;
    o.receiveShadow = true;
    if (!o.userData.kind) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const k = mats[0] && mats[0].userData && mats[0].userData.kind;
      o.userData.kind = asKind(k);
    }
    o.userData.part = resolvePart(o);
  });
  return meshes;
}
const _box = new THREE.Box3();
const _nm = new THREE.Matrix3();
const _n = new THREE.Vector3();
/** A mesh's world-space box from its own geometry (an InstancedMesh's from all its instances). */
function meshBox(mesh, out) {
  if (mesh.isInstancedMesh) {
    mesh.computeBoundingBox();
    return out.copy(mesh.boundingBox).applyMatrix4(mesh.matrixWorld);
  }
  const g = mesh.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  return out.copy(g.boundingBox).applyMatrix4(mesh.matrixWorld);
}
/** Every vertex's world normal, sampled (a stride over huge geometries): the callback gets the face
 *  class and the normal; used both to report a part's faces and to decide whether it is round. */
function forEachVertexNormal(mesh, fn) {
  const g = mesh.geometry;
  if (!g.attributes.normal) g.computeVertexNormals();
  const nor = g.attributes.normal;
  if (!nor) return;
  _nm.getNormalMatrix(mesh.matrixWorld);
  const stride = Math.max(1, Math.floor(nor.count / 4096));
  for (let i = 0; i < nor.count; i += stride) {
    _n.fromBufferAttribute(nor, i).applyMatrix3(_nm);
    fn(faceOf(_n.x, _n.y, _n.z), _n);
  }
}
const round3 = (v) => Math.round(v * 1000) / 1000;
// A MESH is round when its sideways normals point in many directions: the 30° sectors of the compass
// they fall in, at least six of twelve. A box, however it is turned, has four; a 24-segment cylinder, a
// sphere, a hexagonal prism have six or more. (Counting the lateral FACES the normals span would call
// every box round, since a box has all four.) The decision is per mesh, not per part: a desk with four
// thin cylindrical legs would otherwise count as round because the legs alone fill every sector, and
// its top's measured faces would be merged into one whole-body reading.
const ROUND_SECTORS = 6;
const azimuthSector = (n) => Math.floor(((Math.atan2(n.z, n.x) + Math.PI) / (Math.PI / 6)) % 12);
const _ext = new THREE.Vector3();
/** What the built scene actually contains, per part: kinds by mesh count, the faces its vertices span,
 *  its box, whether it is round. A part is round when its round meshes' surface area (that of each
 *  mesh's world box, 2·(wh + dh + wd)) exceeds its boxy meshes' — the body decides, not the knobs, and a
 *  desk top's broad face outweighs the thin legs under it (a lateral-only area would not: four 0.7 m
 *  legs have more side than a 5 cm slab). Each mesh remembers its own roundness in userData.round,
 *  which paint and the probe use to choose bands or faces. Also fills partMeta, which paint and the
 *  probe read. */
function describeParts() {
  scene.updateMatrixWorld(true);
  const parts = new Map();
  building.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.userData.part || 'unnamed';
    let p = parts.get(name);
    if (!p) parts.set(name, (p = { name, kinds: new Map(), faces: new Set(), roundArea: 0, boxyArea: 0, box: new THREE.Box3(), meshCount: 0 }));
    p.meshCount++;
    const k = o.userData.kind || 'other';
    p.kinds.set(k, (p.kinds.get(k) || 0) + 1);
    const mb = meshBox(o, _box);
    p.box.union(mb);
    const sectors = new Set();
    forEachVertexNormal(o, (f, n) => {
      p.faces.add(f);
      if (LATERAL.includes(f)) sectors.add(azimuthSector(n));
    });
    const round = sectors.size >= ROUND_SECTORS;
    o.userData.round = round;
    mb.getSize(_ext); // (0, 0, 0) for an empty box, so a mesh without geometry weighs nothing
    const area = 2 * (_ext.x * _ext.y + _ext.z * _ext.y + _ext.x * _ext.z);
    if (round) p.roundArea += area;
    else p.boxyArea += area;
  });
  partMeta = new Map();
  const out = [];
  for (const p of parts.values()) {
    const round = p.roundArea > p.boxyArea;
    const min = [p.box.min.x, p.box.min.y, p.box.min.z];
    const max = [p.box.max.x, p.box.max.y, p.box.max.z];
    const c = p.box.getCenter(new THREE.Vector3());
    partMeta.set(p.name, { round, min, max, center: [c.x, c.y, c.z] });
    out.push({
      name: p.name,
      kinds: [...p.kinds.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]),
      faces: FACES.filter((f) => p.faces.has(f)),
      center: [round3(c.x), round3(c.y), round3(c.z)],
      min: min.map(round3),
      max: max.map(round3),
      meshCount: p.meshCount,
      round,
    });
  }
  return out;
}
/** Take a paint message in: index the entries, settle the palette and scale. Applied to the meshes by
 *  applyPaint() (which needs a built scene) and kept until the next build. */
function setPaintTable(d) {
  const entries = Array.isArray(d.entries) ? d.entries.filter((e) => e && typeof e.part === 'string' && typeof e.face === 'string') : [];
  const byKey = new Map();
  const bandParts = new Set();
  for (const e of entries) {
    // The cameras a whole-body or band value was seen from, checked here once so paint and probe can
    // trust the shape; an entry without any is seen from everywhere.
    e.cameras = readCameras(e.cameras);
    byKey.set(e.part + '|' + e.face, e);
    if (BANDS.includes(e.face)) bandParts.add(e.part);
  }
  const lo = num(d.lo, 0), hi = num(d.hi, lo + 1);
  const palette = validPalette(d.palette) ? (d.palette.length === 256 ? d.palette : resampleLut(d.palette)) : ironLut();
  // The ground fixture's value, when the panel's fill gives it one: a finite temperature and the label
  // the probe shows for it.
  const g = d.ground;
  const ground =
    g && typeof g === 'object' && typeof g.tempC === 'number' && Number.isFinite(g.tempC)
      ? { tempC: g.tempC, label: typeof g.label === 'string' && g.label ? g.label : fmtT1(g.tempC) + ' · ground · inferred' }
      : null;
  paint = {
    byKey,
    bandParts,
    lo,
    hi: hi > lo ? hi : lo + 1,
    palette,
    measuredOnly: !!d.measuredOnly,
    stripes: d.stripes !== false, // a panel that does not say keeps the stripes
    ground,
  };
  setLut(palette);
  measured.mLo.value = paint.lo;
  measured.mHi.value = paint.hi;
  measured.measuredOnly.value = paint.measuredOnly ? 1 : 0;
  measured.stripes.value = paint.stripes ? 1 : 0;
  if (ground) groundPaintMaterial.color.set(paletteColorAt(ground.tempC));
}
/** Write aTemp / aState for every mesh from the cached table. A geometry several meshes share is
 *  cloned first (each mesh may sit in a different part); a missing value gets the scale's floor with
 *  state 0 — never NaN, which would poison the interpolation of every triangle touching it. A mesh
 *  without a position attribute (a bare new THREE.Mesh()) has nothing to paint and is skipped.
 *
 *  Boxy meshes are painted per vertex: every vertex of a flat face shares its normal, so a triangle
 *  never straddles two entries. Round meshes are painted per TRIANGLE — the band and the face are
 *  decided once at the triangle's world centroid and written to its three vertices — so a band
 *  boundary is a hard line rather than a gradient smeared over the ring that crosses it; an indexed
 *  round geometry (a program's sphere) is made non-indexed first, since vertices shared between
 *  triangles could not hold two values. An InstancedMesh shares one vertex set between its instances,
 *  so it is painted per vertex from the base geometry's normals (the same reading describeParts
 *  classified its faces by) and never in bands, whose heights differ per instance; an instance turned
 *  relative to the mesh is therefore coloured by the base geometry's faces, while the probe reads the
 *  face its world normal actually shows.
 *
 *  Whichever entry a vertex resolves to, if that entry carries the cameras its value was seen from and
 *  the vertex faces none of them, it is painted as inferred: the far side of a drum traced from the
 *  front was never in a picture. */
function applyPaint() {
  if (!paint) return;
  scene.updateMatrixWorld(true);
  const uses = new Map();
  building.traverse((o) => { if (o.isMesh && o.geometry) uses.set(o.geometry, (uses.get(o.geometry) || 0) + 1); });
  const stateOf = (e) => (!e || e.status === 'none' ? 0 : e.status === 'inferred' ? 0.5 : 1);
  const tempOf = (e) => (e && Number.isFinite(e.tempC) ? e.tempC : paint.lo);
  // The state of a surface with world normal n that resolved to entry e: an unseen side of a traced
  // body is at most inferred.
  const stateAt = (e, n, part) => (e && !seenByCameras(n, part, e) ? Math.min(0.5, stateOf(e)) : stateOf(e));
  const pos = new THREE.Vector3();
  const pv = new THREE.Vector3();
  const nSum = new THREE.Vector3();
  const replaceGeometry = (o, g2) => {
    const g = o.geometry;
    if (clonedGeoms.has(g)) { clonedGeoms.delete(g); g.dispose(); } // our own clone: nothing else holds it
    else orphanGeoms.add(g); // the program's geometry: released with the building
    clonedGeoms.add(g2);
    o.geometry = g2;
  };
  building.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (uses.get(o.geometry) > 1 && !clonedGeoms.has(o.geometry)) replaceGeometry(o, o.geometry.clone());
    const part = o.userData.part || 'unnamed';
    const roundMesh = !!o.userData.round;
    const perTriangle = roundMesh && !o.isInstancedMesh;
    if (perTriangle && o.geometry.index) replaceGeometry(o, o.geometry.toNonIndexed());
    const g = o.geometry;
    const p = g.attributes.position;
    if (!p) return;
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = p.count;
    let aTemp = g.attributes.aTemp, aState = g.attributes.aState;
    if (!aTemp || aTemp.count !== n) g.setAttribute('aTemp', (aTemp = new THREE.BufferAttribute(new Float32Array(n), 1)));
    if (!aState || aState.count !== n) g.setAttribute('aState', (aState = new THREE.BufferAttribute(new Float32Array(n), 1)));
    aTemp.array.fill(paint.lo);
    aState.array.fill(0);
    const nor = g.attributes.normal;
    if (!nor) {
      // No normals to classify by (a point cloud, an empty geometry): one value serves the whole body.
      const e = paint.byKey.get(part + '|all') || null;
      aTemp.array.fill(tempOf(e));
      aState.array.fill(stateOf(e));
    } else {
      _nm.getNormalMatrix(o.matrixWorld);
      const banded = roundMesh && !o.isInstancedMesh && paint.bandParts.has(part);
      if (perTriangle) {
        for (let i = 0; i + 2 < n; i += 3) {
          nSum.set(0, 0, 0);
          pos.set(0, 0, 0);
          for (let k = 0; k < 3; k++) {
            nSum.add(_n.fromBufferAttribute(nor, i + k).applyMatrix3(_nm));
            if (banded) pos.add(pv.fromBufferAttribute(p, i + k).applyMatrix4(o.matrixWorld));
          }
          if (nSum.lengthSq() < 1e-12) nSum.copy(_n); // degenerate: fall back to the last vertex's normal
          nSum.normalize();
          const e = entryFor(part, faceOf(nSum.x, nSum.y, nSum.z), pos.y / 3, true);
          const t = tempOf(e), s = stateAt(e, nSum, part);
          aTemp.array[i] = t; aTemp.array[i + 1] = t; aTemp.array[i + 2] = t;
          aState.array[i] = s; aState.array[i + 1] = s; aState.array[i + 2] = s;
        }
      } else {
        for (let i = 0; i < n; i++) {
          _n.fromBufferAttribute(nor, i).applyMatrix3(_nm);
          let y = 0;
          if (banded) y = pos.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld).y;
          const e = entryFor(part, faceOf(_n.x, _n.y, _n.z), y, roundMesh);
          const s = stateAt(e, _n, part);
          aTemp.array[i] = tempOf(e);
          aState.array[i] = s;
        }
      }
    }
    aTemp.needsUpdate = true;
    aState.needsUpdate = true;
  });
  dirty = true;
}
/** applyPaint(), with a failure reported instead of thrown: a table that cannot be painted is dropped,
 *  so measured mode falls back to the realistic look rather than showing a half-painted model under a
 *  "Measured" label. Returns the error message, or null. */
function paintSafely() {
  try {
    applyPaint();
    return null;
  } catch (e) {
    paint = null;
    return 'Painting the measured temperatures failed: ' + (e && e.message ? e.message : String(e));
  }
}
/** Size the fixtures to the model's box: ground just under it, sun and shadow camera over it, camera
 *  planes and orbit limits in proportion — so a 0.3 m kettle and a 100 m building both look right. */
function fitFixtures(box) {
  const ext = box.getSize(new THREE.Vector3());
  const size = Math.max(ext.x, ext.y, ext.z, 0.2);
  sceneSize = size;
  box.getCenter(sceneCentre);
  ground.position.set(sceneCentre.x, box.min.y - 0.002 * size, sceneCentre.z);
  ground.scale.set(20 * size, 20 * size, 1);
  ground.visible = subjectKind !== 'interior'; // a room's floor is the program's; a plane would cut through its walls
  sun.position.set(sceneCentre.x + 0.7 * size, sceneCentre.y + 1.1 * size, sceneCentre.z + 0.5 * size);
  sun.target.position.copy(sceneCentre);
  const dist = sun.position.distanceTo(sceneCentre);
  sc.left = -0.8 * size; sc.right = 0.8 * size; sc.top = 0.8 * size; sc.bottom = -0.8 * size;
  sc.near = Math.max(0.001 * size, dist - 1.5 * size);
  sc.far = dist + 1.5 * size;
  sc.updateProjectionMatrix();
  sun.shadow.normalBias = 0.0004 * size;
  sun.shadow.bias = -0.000002 * size;
  camera.near = size / 500;
  camera.far = 50 * size;
  camera.updateProjectionMatrix();
  controls.minDistance = 0.05 * size;
  controls.maxDistance = 20 * size;
  renderer.shadowMap.needsUpdate = true;
  dirty = true;
}
/** What the overview frames. A room's shell (floor, walls, ceiling) is the biggest thing in an interior
 *  scene and the least interesting: frame the contents instead — the parts well under the scene's size —
 *  so a desk and its laptop fill the view rather than sitting as a speck in a grey room. */
function subjectBox() {
  const whole = new THREE.Box3().setFromObject(building);
  if (subjectKind !== 'interior' || whole.isEmpty()) return whole;
  const inner = new THREE.Box3();
  for (const m of partMeta.values()) {
    const ext = Math.max(m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2]);
    if (ext < 0.6 * sceneSize) inner.expandByPoint(new THREE.Vector3(m.min[0], m.min[1], m.min[2])).expandByPoint(new THREE.Vector3(m.max[0], m.max[1], m.max[2]));
  }
  return inner.isEmpty() ? whole : inner;
}
function overview() {
  // The overview's own lens and orbit floor, whatever a photo's view had set.
  if (camera.fov !== 45) {
    camera.fov = 45;
    camera.updateProjectionMatrix();
    invalidate();
  }
  controls.maxPolarAngle = MAX_POLAR;
  const box = subjectBox();
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 0.1 * sceneSize) * 0.75;
  const dist = radius / Math.tan((camera.fov * Math.PI) / 360);
  const pos = new THREE.Vector3(centre.x + dist * 0.6, centre.y + dist * 0.45, centre.z + dist * 0.75);
  if (subjectKind === 'interior') {
    // A room is seen from inside: stand back from the contents toward the room's open side, at a
    // height under the ceiling and within the walls — never above the ceiling looking at its top.
    const room = new THREE.Box3().setFromObject(building);
    const rc = room.getCenter(new THREE.Vector3());
    const away = new THREE.Vector3(rc.x - centre.x, 0, rc.z - centre.z);
    if (away.lengthSq() < 1e-6) away.set(0.6, 0, 0.75);
    away.normalize();
    pos.set(centre.x + away.x * dist, centre.y + dist * 0.35, centre.z + away.z * dist);
    const margin = (a, b) => 0.05 * (b - a);
    pos.x = Math.min(room.max.x - margin(room.min.x, room.max.x), Math.max(room.min.x + margin(room.min.x, room.max.x), pos.x));
    pos.z = Math.min(room.max.z - margin(room.min.z, room.max.z), Math.max(room.min.z + margin(room.min.z, room.max.z), pos.z));
    pos.y = Math.min(pos.y, room.max.y - 0.15 * (room.max.y - room.min.y));
  }
  camera.position.copy(pos);
  controls.target.copy(centre);
  controls.update();
  invalidate();
}
/** Run a program. buildId is whatever the build message carried (a number, or undefined from an older
 *  panel); every answer to this build echoes it, so the panel can tell it from a stale one. */
function build(code, buildId) {
  const tagged = (msg) => (buildId === undefined ? msg : Object.assign(msg, { buildId }));
  clearBuilding();
  let fn;
  try {
    fn = new Function('THREE', 'scene', 'api', code);
  } catch (e) {
    post(tagged({ type: 'error', message: 'The program does not parse: ' + (e && e.message ? e.message : String(e)) }));
    return;
  }
  // A program that throws part-way has still built everything before the throw: keep that, fit and
  // paint it like a complete build, and tell the panel where it stopped. Only a program that built
  // nothing at all is a failure.
  let stoppedAt = null;
  try {
    fn(THREE, scene, api);
  } catch (e) {
    stoppedAt = e && e.message ? e.message : String(e);
  }
  const meshes = adopt();
  if (!meshes) {
    post(tagged({ type: 'error', message: stoppedAt ? 'The program failed while building: ' + stoppedAt : 'The program added nothing to the scene.' }));
    return;
  }
  const parts = describeParts();
  const box = new THREE.Box3().setFromObject(building);
  fitFixtures(box);
  // The registered photos stay: their cameras take the new model's size (near and far planes, the depth
  // scale), and the depth atlas is drawn again for the new geometry.
  updateProjectionCameras();
  projDirty = true;
  const paintError = paintSafely();
  applyMode();
  applyScenario(scenario);
  overview();
  const unnamed = parts.find((p) => p.name === 'unnamed');
  const built = { type: 'built', meshes, parts, unnamedMeshes: unnamed ? unnamed.meshCount : 0, size: round3(sceneSize) };
  if (stoppedAt) built.warning = 'The program stopped early (' + stoppedAt + '); showing what it had built by then.';
  post(tagged(built));
  // The model is built even when the table it came with could not be painted: report that separately,
  // untagged, so it is not mistaken for the build failing.
  if (paintError) post({ type: 'error', message: paintError });
}

// ---- The probe: the temperature of the surface under the pointer — in the simulated view read with
// the same balance the shader paints with, in the measured view looked up in the same table the shader
// paints from. Hovering shows a live reading; a click pins one (a click on a pinned reading removes it).
// Pins remember the surface point, its normal, part, kind and face, so they re-read when the scenario,
// the mode or the table changes and follow the model as the camera orbits; one hidden behind the model
// dims.
const probesEl = document.getElementById('probes');
const hoverEl = document.getElementById('hover');
const raycaster = new THREE.Raycaster();
let probeOn = false;
const pins = []; // { point, normal, kind, part, face, round, fixture, el }
const pointer = { ndc: new THREE.Vector2(), px: 0, py: 0, inside: false, moved: false };
let hoverHit = null; // { point, normal, kind, part, face, round }
const MAX_PINS = 12;
// Only over a thermal look: measured mode wears the realistic materials until its table arrives (or when
// the table could not be painted), and a reading there would put a simulated number on a photo-like model.
const probeActive = () => probeOn && (mode === 'simulated' || (mode === 'measured' && !!paint));
const hintEl = document.getElementById('hint');
const HINT = 'drag to orbit · wheel to zoom · right-drag to pan';
const PROBE_HINT = 'hover to read · click to pin · ' + HINT;
// The marker: a small ring with four ticks, drawn in a 26 px SVG whose centre is the point, over a dark
// halo for contrast on any colour; then the label.
const TICKS = 'M0 -12V-7M0 7V12M-12 0H-7M7 0H12';
const RETICLE =
  '<svg class="ring" width="26" height="26" viewBox="-13 -13 26 26" aria-hidden="true">' +
  '<g fill="none" stroke="rgba(0,0,0,0.55)" stroke-width="3.5" stroke-linecap="round"><circle r="4.5"/><path d="' + TICKS + '"/></g>' +
  '<g class="fg" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"><circle r="4.5"/><path d="' + TICKS + '"/></g>' +
  '</svg><div class="lab"><b class="t"></b><span class="k"></span></div>';
hoverEl.innerHTML = RETICLE;

/** World-space unit normal at a raycast hit: the interpolated vertex normal (what the shader shades
 *  with — a smooth cylinder has no facets), falling back to the face's own. An InstancedMesh's hit
 *  names the instance, whose own matrix sits between the geometry and the mesh's world matrix. Either
 *  normal is carried into the world by the normal matrix — the inverse transpose, as the measured shader
 *  and applyPaint carry theirs — so on a mesh scaled unevenly (an ellipse drawn as a stretched cylinder)
 *  the probe's facing, and the face it reads, are the painted ones. */
function hitNormal(hit) {
  const obj = hit.object;
  const n = new THREE.Vector3();
  const geom = obj.geometry;
  const nor = geom && geom.attributes && geom.attributes.normal;
  const pos = geom && geom.attributes && geom.attributes.position;
  const wm = obj.matrixWorld.clone();
  if (obj.isInstancedMesh && hit.instanceId !== undefined) {
    const im = new THREE.Matrix4();
    obj.getMatrixAt(hit.instanceId, im);
    wm.multiply(im);
  }
  const nm = new THREE.Matrix3().getNormalMatrix(wm);
  if (hit.face && nor && pos) {
    const f = hit.face;
    const pa = new THREE.Vector3().fromBufferAttribute(pos, f.a).applyMatrix4(wm);
    const pb = new THREE.Vector3().fromBufferAttribute(pos, f.b).applyMatrix4(wm);
    const pc = new THREE.Vector3().fromBufferAttribute(pos, f.c).applyMatrix4(wm);
    const na = new THREE.Vector3().fromBufferAttribute(nor, f.a);
    const nb = new THREE.Vector3().fromBufferAttribute(nor, f.b);
    const nc = new THREE.Vector3().fromBufferAttribute(nor, f.c);
    THREE.Triangle.getInterpolation(hit.point, pa, pb, pc, na, nb, nc, n);
    if (n.lengthSq() > 1e-8) return n.applyMatrix3(nm).normalize();
  }
  if (hit.face) return n.copy(hit.face.normal).applyMatrix3(nm).normalize();
  return n.set(0, 1, 0);
}
/** What a probe ray may hit: only what is drawn — the ground is hidden in an interior scene, and a
 *  hidden mesh still answers a raycast (three tests layers, not visibility). */
const raycastTargets = () => (ground.visible ? [building, ground] : [building]);
/** Whether the renderer draws an object: neither it nor any ancestor is hidden. A program may hide a mesh
 *  or a whole group (visible = false); the renderer and the depth pass skip it, and so must every probe
 *  ray — pick, occluded and the projection's occlusion test — or the probe would read, or be blocked by,
 *  a surface the picture does not show. */
const drawn = (o) => {
  for (; o; o = o.parent) if (o.visible === false) return false;
  return true;
};
function pick(ndc) {
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(raycastTargets(), true);
  for (const h of hits) {
    if (!h.object.isMesh || !drawn(h.object)) continue;
    const normal = hitNormal(h);
    return {
      point: h.point.clone(),
      normal,
      kind: h.object.userData.kind || 'other',
      part: h.object.userData.part || 'unnamed',
      face: faceOf(normal.x, normal.y, normal.z),
      round: !!h.object.userData.round, // a round mesh reads by band, a boxy one by face (entryFor)
      fixture: h.object === ground, // the frame's own ground plane, not the program's scenery
    };
  }
  return null;
}
/** Bilinear read of a photo's grid at continuous grid coordinates (pixel centres at i + 0.5, as in the
 *  temps atlas), over its readable pixels only: null where they carry less than half the weight — the
 *  shader's alpha test on the same four texels. */
function sampleGrid(temps, gx, gy) {
  const x = gx - 0.5, y = gy - 0.5;
  const i0 = Math.floor(x), j0 = Math.floor(y);
  const fx = x - i0, fy = y - j0;
  const i1 = Math.min(PROJ_W - 1, i0 + 1), j1 = Math.min(PROJ_H - 1, j0 + 1);
  let wv = 0, tv = 0;
  const add = (i, j, w) => {
    const v = temps[j * PROJ_W + i];
    if (w > 0 && v === v) { wv += w; tv += w * v; }
  };
  add(i0, j0, (1 - fx) * (1 - fy));
  add(i1, j0, fx * (1 - fy));
  add(i0, j1, (1 - fx) * fy);
  add(i1, j1, fx * fy);
  return wv >= 0.5 ? tv / wv : null;
}
const _clip = new THREE.Vector4();
const _toCam = new THREE.Vector3();
const _ray = new THREE.Vector3();
const _pn = new THREE.Vector3();
/** Smoothstep from 0 at a picture's (or a thermal grid's) edge to 1 at 4 % inside it: the shader's edge fade. */
const edgeFade = (x) => {
  const t = Math.min(1, Math.max(0, x / 0.04));
  return t * t * (3 - 2 * t);
};
/** GLSL's smoothstep. */
const smooth = (lo, hi, x) => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};
/** The registered photos' reading at a surface point with the given world normal — the measured shader's
 *  sums, in JS: each photo that has the point in its picture, faces it (facing ≥ GRAZE_LO, the normal
 *  turned toward the viewer as gl_FrontFacing turns it), finds a readable pixel there (a bilinear sample of
 *  the grid itself, not the atlas) and sees it — the shader's depth test, with a raycast from the photo's
 *  camera standing in for its depth atlas — weighted facing³ × the edge fade (the picture's and the
 *  thermal grid's) × the graze ramp. Returns { tempC, sure, edge, graze, photos }: the blended reading;
 *  how fully the best photo vouches for it (its edge fade × its graze ramp, 0..1 — the shader's 'sure')
 *  and those two factors of that photo apart, so the probe can say why a reading is only partly the
 *  photo's; and the labels of the photos carrying at least a fifth of the weight, heaviest first (the
 *  heaviest always, should five or more share it evenly). Null where no photo sees the point. */
function projectedReading(point, normal) {
  if (!proj.cameras.length) return null;
  const n = _pn.copy(normal).normalize();
  if (n.dot(_toCam.subVectors(camera.position, point)) < 0) n.negate();
  const shares = [];
  let wSum = 0, tSum = 0, sure = 0, sureEdge = 1, sureGraze = 1;
  for (let i = 0; i < proj.cameras.length; i++) {
    const p = proj.photos[i], c = proj.cameras[i];
    _clip.set(point.x, point.y, point.z, 1).applyMatrix4(c.vp);
    if (_clip.w <= 0) continue;
    const nx = _clip.x / _clip.w, ny = _clip.y / _clip.w;
    if (Math.abs(nx) > 1 || Math.abs(ny) > 1) continue;
    _toCam.subVectors(c.position, point);
    const dist = _toCam.length();
    const facing = n.dot(_toCam) / Math.max(dist, 1e-9);
    if (!(facing >= GRAZE_LO)) continue;
    const pu = nx * 0.5 + 0.5, pv = ny * 0.5 + 0.5;
    // The thermal pixel under the point, unclamped: the fade reaches zero at the grid's own edge as well
    // as the picture's (the shader's gu); clamped only for the lookup.
    const gux = pu * PROJ_W + p.dx, guy = (1 - pv) * PROJ_H + p.dy;
    const edge =
      edgeFade(pu) * edgeFade(1 - pu) * edgeFade(pv) * edgeFade(1 - pv) *
      edgeFade(gux / PROJ_W) * edgeFade(1 - gux / PROJ_W) * edgeFade(guy / PROJ_H) * edgeFade(1 - guy / PROJ_H);
    const graze = smooth(GRAZE_LO, GRAZE_HI, facing);
    const vouch = edge * graze;
    const w = facing * facing * facing * vouch;
    if (!(w > 0)) continue;
    const gx = Math.min(PROJ_W - 0.5, Math.max(0.5, gux));
    const gy = Math.min(PROJ_H - 0.5, Math.max(0.5, guy));
    const t = sampleGrid(p.temps, gx, gy);
    if (t === null) continue;
    // Last, the one costly test — the shader's depth test, a ray standing in for the depth pass: from this
    // photo's camera toward the point, the first surface drawn (the model only, as in the pass) must not
    // stand nearer than the point by more than the shader's allowance: 1 % of the distance, 0.2 % of the
    // model, and the depth one depth-atlas texel spans along a surface seen at a slant.
    const slope = Math.sqrt(Math.max(0, 1 - facing * facing)) / facing;
    const allowance = 0.01 * dist + 0.002 * sceneSize + measured.projTexel.value[i] * dist * slope;
    raycaster.set(c.position, _ray.subVectors(point, c.position).normalize());
    let hidden = false;
    for (const h of raycaster.intersectObjects([building], true)) {
      if (!h.object.isMesh || !drawn(h.object)) continue;
      hidden = h.distance < dist - allowance;
      break;
    }
    if (hidden) continue;
    shares.push({ label: p.label, w });
    wSum += w;
    tSum += w * t;
    if (vouch > sure) {
      sure = vouch;
      sureEdge = edge;
      sureGraze = graze;
    }
  }
  if (!(wSum > 1e-9)) return null;
  shares.sort((a, b) => b.w - a.w);
  return {
    tempC: tSum / wSum,
    sure,
    edge: sureEdge,
    graze: sureGraze,
    photos: shares.filter((s, k) => k === 0 || s.w >= 0.2 * wSum).map((s) => s.label),
  };
}
/** What the probe says about a surface, in the current view: the simulated balance; in the measured
 *  view the registered photos' own pixels where they see the point, else the table's entry for the
 *  (part, face) — whose label the panel already worded — or the want of one. */
function readSurface(hit) {
  if (mode === 'measured' && paint) {
    // The ground fixture answers for itself — the fill's value for it, or the want of one — never with
    // the table's entry for an unnamed part, which is the program's scenery.
    if (hit.fixture) {
      const g = paint.ground;
      return g
        ? { tempC: g.tempC, kind: 'ground', part: 'ground', face: 'top', status: 'inferred', label: g.label }
        : { tempC: null, kind: 'ground', part: 'ground', face: 'top', status: 'none', label: '— · ground · no measurement' };
    }
    const e = entryFor(hit.part, hit.face, hit.point.y, hit.round);
    // The side of a traced body no camera saw is painted as inferred; say so here too, in the panel's
    // words for it, so the reading and the stripes under the pointer agree.
    const far = !!e && !seenByCameras(hit.normal, hit.part, e);
    // A point a registered photo sees: the reading under this very point — what the shader paints there
    // — with the photos it comes from and, for comparison, the table's one value for the face. Seen at a
    // graze or near a picture's edge the shader fades the reading into the face's value (tableShows below
    // is its rule), and so does the reading here, saying so — and saying which it was: 'sure' is the best
    // photo's edge fade × its graze ramp, and a point seen squarely near the edge of a picture is no slant.
    const projected = projectedReading(hit.point, hit.normal);
    if (projected) {
      const tableStatus = e ? (far && e.status === 'measured' ? 'inferred' : e.status) : 'none';
      const tableShows = !!e && Number.isFinite(e.tempC) && (tableStatus === 'measured' || (tableStatus === 'inferred' && !paint.measuredOnly));
      const sure = projected.sure;
      const pct = Math.round(sure * 100);
      const tempC = tableShows ? e.tempC + (projected.tempC - e.tempC) * sure : projected.tempC;
      const photos = projected.photos.join(' + ');
      const faceTerm = e && Number.isFinite(e.tempC) ? ' · face ' + fmtT1(e.tempC) + ' (' + tableStatus + ')' : '';
      // What held the photo back. A factor under 0.999 counts, so a sure under 0.995 always names one.
      const slanted = projected.graze < 0.999, edgy = projected.edge < 0.999;
      const why = slanted && edgy ? "at a slant and near the picture's edge" : edgy ? "near the picture's edge" : 'at a slant';
      if (sure >= 0.5) {
        const partly = tableShows && sure < 0.995 ? ' ' + why + ' (' + pct + ' % its pixels, the rest the face value)' : '';
        const label =
          fmtT1(tempC) + ' · ' + hit.kind + ' · ' +
          (APPARENT_KINDS.includes(hit.kind) ? 'apparent at this point' : 'measured at this point') +
          ' · ' + photos + partly + faceTerm;
        return { tempC, kind: hit.kind, part: hit.part, face: e ? e.face : hit.face, status: 'measured', label };
      }
      if (tableShows && pct > 0) {
        const label =
          fmtT1(tempC) + ' · ' + hit.kind + ' · face value ' + fmtT1(e.tempC) + ' (' + tableStatus + '), ' +
          pct + ' % from ' + photos + ' ' + (slanted ? 'seen ' : '') + why;
        return { tempC, kind: hit.kind, part: hit.part, face: e.face, status: tableStatus, label };
      }
      // Too slight a view to show — on a face with nothing else to show, or under half a percent of a face
      // value that does show: the table's entry as it stands (never "0 % from" a photo).
    }
    if (e) {
      const status = far && e.status === 'measured' ? 'inferred' : e.status;
      const label = far && typeof e.farLabel === 'string' && e.farLabel ? e.farLabel : typeof e.label === 'string' && e.label ? e.label : '— · ' + hit.kind + ' · ' + status;
      return {
        tempC: Number.isFinite(e.tempC) ? e.tempC : null,
        kind: hit.kind,
        part: hit.part,
        face: e.face,
        status,
        label,
      };
    }
    return { tempC: null, kind: hit.kind, part: hit.part, face: hit.face, status: 'none', label: '— · ' + hit.kind + ' · no measurement' };
  }
  const T = surfaceTemp(hit.kind, hit.normal);
  return { tempC: T, kind: hit.kind, part: hit.part, face: hit.face, status: 'simulated', label: fmtT1(T) + ' · ' + hit.kind };
}
/** Show a reading: the first term (the temperature) bold, the rest dimmed; the whole label is kept on
 *  the element verbatim. In the measured view the rest keeps its separators, since it is several terms. */
function setLabel(el, reading) {
  const lab = el.querySelector('.lab');
  const label = reading.label;
  const i = label.indexOf(' · ');
  const head = i < 0 ? label : label.slice(0, i);
  const rest = i < 0 ? '' : label.slice(i + 3);
  lab.dataset.label = label;
  lab.classList.toggle('dotted', reading.status !== 'simulated');
  el.querySelector('.t').textContent = head;
  el.querySelector('.k').textContent = rest;
}
function placeEl(el, x, y) {
  el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
}
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
/** Screen position of a world point, or null when it is behind the camera. */
function toScreen(point) {
  _v.copy(point).project(camera);
  if (_v.z > 1) return null;
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  return [(_v.x * 0.5 + 0.5) * w, (-_v.y * 0.5 + 0.5) * h];
}
function occluded(point) {
  _dir.subVectors(point, camera.position);
  const d = _dir.length();
  raycaster.set(camera.position, _dir.normalize());
  const hits = raycaster.intersectObjects(raycastTargets(), true);
  for (const h of hits) {
    if (!h.object.isMesh || !drawn(h.object)) continue;
    return h.distance < d - Math.max(0.001 * sceneSize, d * 0.004);
  }
  return false;
}
let rect = null; // the canvas's box, measured on resize rather than on every pointer event
function readPointer(e) {
  const r = rect || (rect = canvas.getBoundingClientRect());
  pointer.px = e.clientX - r.left;
  pointer.py = e.clientY - r.top;
  pointer.ndc.set((pointer.px / Math.max(1, r.width)) * 2 - 1, -(pointer.py / Math.max(1, r.height)) * 2 + 1);
}
/** The reading under the pointer. The reticle itself was placed by the pointer event; this only picks
 *  the surface and writes the label (the label hides over the sky, the reticle stays: it is the cursor). */
function updateHover() {
  if (!pointer.inside) {
    hoverHit = null;
    hoverEl.style.display = 'none';
    return;
  }
  if (pointer.moved) {
    pointer.moved = false;
    hoverHit = pick(pointer.ndc);
  }
  hoverEl.classList.toggle('nohit', !hoverHit);
  if (hoverHit) setLabel(hoverEl, readSurface(hoverHit));
  hoverEl.style.display = 'block';
}
function addPin(hit) {
  const el = document.createElement('div');
  el.className = 'probe pin';
  el.innerHTML = RETICLE;
  const pin = { point: hit.point.clone(), normal: hit.normal.clone(), kind: hit.kind, part: hit.part, face: hit.face, round: hit.round, fixture: !!hit.fixture, el };
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    removePin(pin);
  });
  pins.push(pin);
  while (pins.length > MAX_PINS) removePin(pins[0], true);
  probesEl.appendChild(el);
  setLabel(el, readSurface(pin));
  camMoved = true;
  post({ type: 'probes', count: pins.length });
}
function removePin(pin, quiet) {
  const i = pins.indexOf(pin);
  if (i < 0) return;
  pins.splice(i, 1);
  pin.el.remove();
  if (!quiet) post({ type: 'probes', count: pins.length });
}
function clearPins() {
  if (!pins.length) return;
  for (const p of pins) p.el.remove();
  pins.length = 0;
  post({ type: 'probes', count: 0 });
}
/** Re-label every pin (the scenario, the mode or the table changed) and re-read the hover. */
function refreshProbes() {
  for (const p of pins) setLabel(p.el, readSurface(p));
  pointer.moved = true;
  camMoved = true;
}
function updatePins() {
  if (!pins.length) return;
  const check = camMoved;
  camMoved = false;
  for (const p of pins) {
    const s = toScreen(p.point);
    if (!s) {
      p.el.style.display = 'none';
      continue;
    }
    p.el.style.display = 'block';
    placeEl(p.el, s[0], s[1]);
    if (check) p.el.classList.toggle('hidden-behind', occluded(p.point));
  }
}
function applyProbeState() {
  const on = probeActive();
  probesEl.style.display = on ? 'block' : 'none';
  canvas.classList.toggle('probing', on);
  hintEl.textContent = on ? PROBE_HINT : HINT; // the probe has no switch in the panel: the hint says it is there
  pointer.moved = true;
  camMoved = true;
  if (!on) {
    hoverHit = null;
    hoverEl.style.display = 'none';
  }
}
let down = null;
canvas.addEventListener('pointermove', (e) => {
  readPointer(e);
  pointer.inside = true;
  pointer.moved = true;
  // Move the reticle now, in the event itself: it must sit under the pointer, not trail it by a frame.
  if (probeActive()) {
    placeEl(hoverEl, pointer.px, pointer.py);
    hoverEl.style.display = 'block';
  }
});
canvas.addEventListener('pointerleave', () => {
  pointer.inside = false;
  hoverHit = null;
  hoverEl.style.display = 'none';
});
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };
});
canvas.addEventListener('pointerup', (e) => {
  const d = down;
  down = null;
  if (!d || !probeActive() || d.button !== 0) return;
  // A click, not the end of an orbit: little movement, briefly held.
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || performance.now() - d.t > 600) return;
  readPointer(e);
  const hit = pick(pointer.ndc);
  if (hit) addPin(hit);
});
controls.addEventListener('change', invalidate);

/** The declared part names from a build message: strings, or objects with a name. */
function readDeclaredParts(list) {
  const map = new Map();
  if (Array.isArray(list)) {
    for (const p of list) {
      const name = typeof p === 'string' ? p : p && typeof p.name === 'string' ? p.name : '';
      if (name.trim()) map.set(normalizePart(name), name.trim());
    }
  }
  return map;
}
const SUBJECT_KINDS = ['building', 'interior', 'apparatus', 'vehicle', 'nature', 'other'];
window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'build' && typeof d.code === 'string') {
    if (d.mode) mode = asMode(d.mode);
    if (d.unit) unit = d.unit === 'F' ? 'F' : 'C';
    if (d.scenario) scenario = d.scenario;
    if ('materials' in d) setMaterials(d.materials);
    if ('range' in d) range = validRange(d.range) ? [d.range[0], d.range[1]] : null;
    subjectKind = SUBJECT_KINDS.includes(d.subjectKind) ? d.subjectKind : 'building';
    declaredParts = readDeclaredParts(d.parts);
    // A table belongs to one model: the last one is dropped unless the build brings its own.
    paint = null;
    if (d.paint && typeof d.paint === 'object') setPaintTable(d.paint);
    build(d.code, typeof d.buildId === 'number' && Number.isFinite(d.buildId) ? d.buildId : undefined);
  } else if (d.type === 'mode') {
    mode = asMode(d.mode);
    if (d.unit) unit = d.unit === 'F' ? 'F' : 'C';
    if (d.scenario) scenario = d.scenario;
    if ('materials' in d) setMaterials(d.materials);
    applyMode(); // redraws the measured legend too, in case the unit changed
    applyScenario(scenario, 'range' in d ? d.range : undefined);
  } else if (d.type === 'paint') {
    setPaintTable(d);
    const paintError = paintSafely();
    applyMode(); // measured mode may have been waiting for a table; the legend follows the new one
    refreshProbes();
    if (paintError) post({ type: 'error', message: paintError });
  } else if (d.type === 'photos') {
    setProjectionPhotos(d.photos);
    dirty = true;
    refreshProbes(); // a pinned reading may now fall on a photo's pixels, or off them
  } else if (d.type === 'probe') {
    probeOn = !!d.on;
    if (d.clear) clearPins();
    applyProbeState();
  } else if (d.type === 'view') {
    const c = sceneCentre, s = sceneSize;
    camera.position.set(num(d.x, c.x + 0.6 * s), num(d.y, c.y + 0.3 * s), num(d.z, c.z + 0.9 * s));
    controls.target.set(num(d.targetX, c.x), num(d.targetY, c.y), num(d.targetZ, c.z));
    // A registered photo's view brings its camera's lens, so the model lines up with the picture.
    if (finite(d.fov)) {
      camera.fov = Math.min(120, Math.max(10, d.fov));
      camera.updateProjectionMatrix();
    }
    // A camera that looked up at the subject stands below the point it looks at, past the orbit's floor:
    // lower the floor as far as this view needs, or controls.update() would lift the camera off the
    // photo's standpoint (overview() puts the floor back).
    const off = new THREE.Vector3().subVectors(camera.position, controls.target);
    const len = off.length();
    if (len > 1e-9) {
      const polar = Math.acos(Math.min(1, Math.max(-1, off.y / len)));
      controls.maxPolarAngle = Math.min(Math.PI - 0.01, Math.max(MAX_POLAR, polar + 0.01));
    }
    controls.update();
    invalidate();
  } else if (d.type === 'overview') {
    overview();
  }
});

function resize() {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
  rect = null;
  invalidate();
}
window.addEventListener('resize', resize);
resize();
renderer.setAnimationLoop(() => {
  // OrbitControls says whether the camera moved this tick (a drag, a wheel, or damping still settling).
  if (controls.update()) invalidate();
  if (dirty) {
    dirty = false;
    // The depth atlas the measured shader tests against, drawn again only when the photos or the model
    // changed — and only once measured mode shows them.
    if (projDirty && mode === 'measured' && paint && proj.cameras.length) renderProjectionDepth();
    renderer.render(scene, camera);
  }
  // After any render, so every matrixWorld the raycasts read is current; between renders nothing moved.
  if (probeActive()) {
    updateHover();
    updatePins();
  }
});
post({ type: 'ready' });
</script>
</body>
</html>`
  .split('__THREE_VERSION__')
  .join(THREE_VERSION)
  .split('__SIM_DEFAULTS__')
  .join(
    JSON.stringify({
      materials: SIM_MATERIALS,
      windH: SIM_DEFAULT_WIND_H,
      skyLoss: SIM_DEFAULT_SKY_LOSS,
      emissivity: SIM_EMISSIVITY,
      sigma: SIM_SIGMA,
    }),
  );
