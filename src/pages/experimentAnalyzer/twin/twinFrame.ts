/**
 * The building twin's viewer: a self-contained page that runs the model's scene program inside a
 * sandboxed iframe (docs/digital-twin-plan.md §17). The program the vision model wrote is untrusted
 * code, so it never runs in the app's own document: the panel puts this page in an iframe with
 * `sandbox="allow-scripts"` (no same-origin — the frame has no origin, no storage, no access to the
 * parent) and talks to it with postMessage only.
 *
 * Messages in:  { type: 'build', code, mode, scenario, unit }    — run a program (replacing the model)
 *               { type: 'mode', mode, scenario, unit }           — realistic or simulated thermal view
 *               { type: 'view', x, y, z, targetX, targetY, targetZ } — look from a photo's standpoint
 *               { type: 'overview' }                             — frame the whole model
 * Messages out: { type: 'ready' } once, then { type: 'built', meshes } or { type: 'error', message }.
 *
 * The frame owns the renderer, camera, lights, ground and orbit controls; the program only adds meshes
 * through a small API (api.material / api.box / api.cylinder, or raw THREE) — the same API the
 * contract in functions/src/twinBuilding.ts describes to the model. The thermal view swaps every
 * mesh's material for a shader that paints a plausible surface temperature from the part's kind and
 * the direction it faces under a chosen scenario: a demonstration of what a thermal camera would see,
 * labelled as simulated, not a measurement.
 *
 * three.js comes from a CDN through an import map: the frame has no origin, so it cannot load the
 * app's own bundle, and a script tag from a CDN with CORS is the one thing it can load.
 */

export const THREE_VERSION = '0.169.0';

export const TWIN_FRAME_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #dfe6ee; font: 12px system-ui, sans-serif; color: #333; }
  canvas { display: block; width: 100%; height: 100%; }
  #legend { position: absolute; right: 10px; bottom: 10px; background: rgba(255,255,255,0.88); padding: 6px 8px; border-radius: 6px; display: none; min-width: 170px; }
  #legend .bar { height: 8px; border-radius: 3px; background: linear-gradient(to right, #020016, #4b0a6e, #a3155f, #e64d20, #f9b21c, #fdf6d0); }
  #legend .lab { display: flex; justify-content: space-between; margin-top: 3px; font-variant-numeric: tabular-nums; }
  #legend .cap { color: #777; font-size: 11px; margin-top: 2px; }
  #hint { position: absolute; left: 10px; bottom: 10px; color: rgba(40,40,40,0.6); font-size: 11px; pointer-events: none; }
</style>
<script type="importmap">
{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@__THREE_VERSION__/build/three.module.js", "three/addons/": "https://cdn.jsdelivr.net/npm/three@__THREE_VERSION__/examples/jsm/" } }
</script>
</head>
<body>
<canvas id="c"></canvas>
<div id="legend"><div class="bar"></div><div class="lab"><span id="lo"></span><span id="hi"></span></div><div class="cap">simulated surface temperature</div></div>
<div id="hint">drag to orbit · wheel to zoom · right-drag to pan</div>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe6ee);
const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 2500);
camera.position.set(70, 45, 90);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2 - 0.01;
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
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1200, 1200),
  new THREE.MeshStandardMaterial({ color: 0xb8b3a6, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.25; // well under any slab a program lays on the ground
ground.receiveShadow = true;
ground.userData.kind = 'ground';
scene.add(hemi, sun, ground);
const fixtures = new Set([hemi, sun, ground]);
const building = new THREE.Group();
building.name = 'building';
scene.add(building);
fixtures.add(building);

// ---- The material API the program builds with. Each part kind has a default look and is remembered
// on the material so the thermal view can tell parts apart.
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
function place(mesh, kind) {
  mesh.userData.kind = asKind(kind);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}
const api = {
  material: (kind, color) => makeMaterial(kind, color),
  box(w, h, d, x, y, z, kind, color) {
    w = Math.max(0.01, num(w, 1)); h = Math.max(0.01, num(h, 1)); d = Math.max(0.01, num(d, 1));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), makeMaterial(kind, color));
    mesh.position.set(num(x, 0), num(y, 0) + h / 2, num(z, 0));
    return place(mesh, kind);
  },
  cylinder(r, h, x, y, z, kind, color) {
    r = Math.max(0.01, num(r, 0.3)); h = Math.max(0.01, num(h, 1));
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 24), makeMaterial(kind, color));
    mesh.position.set(num(x, 0), num(y, 0) + h / 2, num(z, 0));
    return place(mesh, kind);
  },
};
Object.freeze(api);

// ---- The simulated thermal look: one unlit shader per part kind, scenario uniforms shared.
const PROPS = {
  // U: conduction from inside (W/m²K); alpha: solar absorptance; up: extra sky cooling weight; bias: K.
  wall: { U: 0.6, alpha: 0.55, bias: 0 },
  glass: { U: 2.8, alpha: 0.12, bias: 0 },
  roof: { U: 0.3, alpha: 0.85, bias: 0 },
  column: { U: 1.2, alpha: 0.6, bias: 0 },
  canopy: { U: 1.0, alpha: 0.7, bias: 0 },
  frame: { U: 1.5, alpha: 0.5, bias: 0 },
  pavement: { U: 0, alpha: 0.7, bias: 0.5 },
  road: { U: 0, alpha: 0.9, bias: 1 },
  vegetation: { U: 0, alpha: 0.3, bias: -2 },
  ground: { U: 0, alpha: 0.6, bias: 0 },
  other: { U: 0.8, alpha: 0.5, bias: 0 },
};
const H_OUT = 15; // W/m²K, a light wind
const SKY_K = 3.5; // K a clear night sky pulls an upward face below the air
const shared = {
  sunDir: { value: new THREE.Vector3(0, 1, 0) },
  tOut: { value: 0 },
  tIn: { value: 21 },
  irr: { value: 0 },
  tMin: { value: -10 },
  tMax: { value: 30 },
};
const thermalMaterials = new Map();
function thermalMaterial(kind) {
  const k = PROPS[kind] ? kind : 'other';
  let m = thermalMaterials.get(k);
  if (m) return m;
  const p = PROPS[k];
  m = new THREE.ShaderMaterial({
    uniforms: Object.assign({ U: { value: p.U }, alpha: { value: p.alpha }, bias: { value: p.bias } }, shared),
    vertexShader: [
      '#include <common>',
      '#include <logdepthbuf_pars_vertex>',
      'varying vec3 vNormal; varying vec3 vView;',
      'void main() {',
      '  vNormal = normalize(mat3(modelMatrix) * normal);',
      '  vec4 wp = modelMatrix * vec4(position, 1.0);',
      '  vView = normalize(cameraPosition - wp.xyz);',
      '  gl_Position = projectionMatrix * viewMatrix * wp;',
      '  #include <logdepthbuf_vertex>',
      '}',
    ].join('\n'),
    fragmentShader: [
      '#include <common>',
      '#include <logdepthbuf_pars_fragment>',
      'uniform vec3 sunDir; uniform float tOut, tIn, irr, tMin, tMax, U, alpha, bias;',
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
      '  float up = max(0.0, n.y);',
      '  float T = tOut + (alpha * irr * cosSun + U * (tIn - tOut)) / ' + H_OUT.toFixed(1) + ' - ' + SKY_K.toFixed(1) + ' * up + bias;',
      '  float t = (T - tMin) / max(0.5, tMax - tMin);',
      '  float shade = 0.82 + 0.18 * max(0.0, dot(n, normalize(vView)));',
      '  gl_FragColor = vec4(iron(t) * shade, 1.0);',
      '}',
    ].join('\n'),
  });
  thermalMaterials.set(k, m);
  return m;
}
// The same formula in JS, for the legend's range: the extremes over every kind in the scene.
function temperatureRange(kinds, s) {
  let lo = Infinity, hi = -Infinity;
  for (const k of kinds) {
    const p = PROPS[k] || PROPS.other;
    for (const cosSun of [0, 1]) for (const up of [0, 1]) {
      const T = s.tOut + (p.alpha * s.irr * cosSun + p.U * (s.tIn - s.tOut)) / H_OUT - SKY_K * up + p.bias;
      lo = Math.min(lo, T); hi = Math.max(hi, T);
    }
  }
  if (!Number.isFinite(lo)) { lo = s.tOut - 5; hi = s.tOut + 5; }
  if (hi - lo < 4) { const m = (lo + hi) / 2; lo = m - 2; hi = m + 2; }
  return [lo, hi];
}

// ---- State and messages.
let mode = 'realistic';
let unit = 'C';
let scenario = { tOut: -5, tIn: 21, irradiance: 0, sunAzimuthDeg: 0, sunElevationDeg: -10 };
const originals = new Map(); // mesh → the material the program gave it
const legend = document.getElementById('legend');
const fmtT = (c) => (unit === 'F' ? Math.round((c * 9) / 5 + 32) + ' °F' : Math.round(c) + ' °C');

function applyScenario(s) {
  scenario = s;
  const az = (num(s.sunAzimuthDeg, 0) * Math.PI) / 180;
  const el = (num(s.sunElevationDeg, 0) * Math.PI) / 180;
  const irr = el > 0 ? Math.max(0, num(s.irradiance, 0)) : 0;
  shared.sunDir.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
  shared.tOut.value = num(s.tOut, 0);
  shared.tIn.value = num(s.tIn, 21);
  shared.irr.value = irr;
  const kinds = new Set(['ground']);
  building.traverse((o) => { if (o.isMesh) kinds.add(o.userData.kind || 'other'); });
  const [lo, hi] = temperatureRange(kinds, { tOut: shared.tOut.value, tIn: shared.tIn.value, irr });
  shared.tMin.value = lo;
  shared.tMax.value = hi;
  document.getElementById('lo').textContent = fmtT(lo);
  document.getElementById('hi').textContent = fmtT(hi);
}
function applyMode() {
  const thermal = mode === 'thermal';
  const swap = (mesh) => {
    if (thermal) {
      if (!originals.has(mesh)) originals.set(mesh, mesh.material);
      mesh.material = thermalMaterial(mesh.userData.kind || 'other');
    } else if (originals.has(mesh)) {
      mesh.material = originals.get(mesh);
    }
  };
  building.traverse((o) => { if (o.isMesh) swap(o); });
  swap(ground);
  scene.background.set(thermal ? 0x101018 : 0xdfe6ee);
  legend.style.display = thermal ? 'block' : 'none';
}
function clearBuilding() {
  originals.clear();
  for (const child of [...building.children]) {
    building.remove(child);
    child.traverse((o) => {
      if (o.isMesh) {
        o.geometry && o.geometry.dispose && o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m && m.dispose && !thermalMaterials.has(m.userData && m.userData.kind) && !(m instanceof THREE.ShaderMaterial)) m.dispose();
      }
    });
  }
}
function adopt() {
  // Whatever the program added to the scene (through the API or by hand) becomes part of the building.
  for (const child of [...scene.children]) if (!fixtures.has(child)) { scene.remove(child); building.add(child); }
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
  });
  return meshes;
}
function overview() {
  const box = new THREE.Box3().setFromObject(building);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 10) * 0.75;
  const dist = radius / Math.tan((camera.fov * Math.PI) / 360);
  camera.position.set(centre.x + dist * 0.6, centre.y + dist * 0.45, centre.z + dist * 0.75);
  controls.target.copy(centre);
  controls.update();
}
function build(code) {
  clearBuilding();
  let fn;
  try {
    fn = new Function('THREE', 'scene', 'api', code);
  } catch (e) {
    post({ type: 'error', message: 'The program does not parse: ' + (e && e.message ? e.message : String(e)) });
    return;
  }
  try {
    fn(THREE, scene, api);
  } catch (e) {
    adopt();
    post({ type: 'error', message: 'The program failed while building: ' + (e && e.message ? e.message : String(e)) });
    return;
  }
  const meshes = adopt();
  if (!meshes) {
    post({ type: 'error', message: 'The program added nothing to the scene.' });
    return;
  }
  applyMode();
  applyScenario(scenario);
  overview();
  post({ type: 'built', meshes });
}

window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'build' && typeof d.code === 'string') {
    if (d.mode) mode = d.mode === 'thermal' ? 'thermal' : 'realistic';
    if (d.unit) unit = d.unit === 'F' ? 'F' : 'C';
    if (d.scenario) scenario = d.scenario;
    build(d.code);
  } else if (d.type === 'mode') {
    mode = d.mode === 'thermal' ? 'thermal' : 'realistic';
    if (d.unit) unit = d.unit === 'F' ? 'F' : 'C';
    if (d.scenario) scenario = d.scenario;
    applyMode();
    applyScenario(scenario);
  } else if (d.type === 'view') {
    camera.position.set(num(d.x, 40), num(d.y, 1.6), num(d.z, 60));
    controls.target.set(num(d.targetX, 0), num(d.targetY, 5), num(d.targetZ, 0));
    controls.update();
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
}
window.addEventListener('resize', resize);
resize();
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
post({ type: 'ready' });
</script>
</body>
</html>`
  .split('__THREE_VERSION__')
  .join(THREE_VERSION);
