/**
 * A scene program run in Node as the frame runs it (docs/digital-twin-plan.md §32): for the photo-set eval
 * (scripts/evalTwinBuilding.ts) and twinProgramNode.test.ts, so a program a model wrote is judged offline
 * with the very API the frame gives it (TWIN_API_JS) and the frame's own checks after it (settleScene,
 * roofCover). Node only — never imported by the app: it reads three's CommonJS build off disk.
 *
 * The program is a model's, and the frame keeps it in a sandboxed iframe; here it runs in a context of its
 * own (node:vm). three, the API, the program and the checks are all evaluated inside it and nothing of the
 * process is handed in (no require, process, fetch or timers); the context's global has no prototype to
 * climb out through; three and the API are local to a function, as they are to the frame's module, so a
 * program can neither reach them by name nor replace them; three is frozen, as the frame's module
 * namespace is; and the run is cut off after `timeoutMs`, microtasks included — a program that loops for
 * ever stops the eval, not the machine. The result comes out as a JSON string made with the context's own
 * JSON.stringify, taken before the program ran. Node's vm keeps an ordinary program away from the process;
 * it is not a security boundary against one written to break out, and it shares the process's heap: a
 * program that allocates without bound can still exhaust it.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { TWIN_API_JS } from './twinFrameApi';
import { TWIN_GEOMETRY_JS } from './twinFrameGeometry';

/** What a program built, as the frame sees it once adopt() has claimed it and the §29 checks have run. */
export interface TwinProgramRun {
  /** Why nothing was built: the program does not parse, threw before it built anything, added nothing, or
   *  ran past the time allowed. Null when it built something. */
  error: string | null;
  /** What a program that did build something threw part-way (the frame shows what it had built by then). */
  stoppedAt: string | null;
  meshes: number;
  /** The parts the meshes belong to — api.part's name, the declared part an ancestor is named after, or
   *  'unnamed' — with how many meshes each has and of which kinds, in the order first met. */
  parts: { name: string; meshes: number; kinds: string[] }[];
  /** settleScene and roofCover's word, as the frame reports it on `built` (read it with readSettled);
   *  null when the checks threw, and the model stays as written. */
  settled: { moved: unknown[]; uncovered: unknown[]; shifts: unknown[]; split: unknown[] } | null;
  /** How long running and checking the program took, ms. */
  ms: number;
}

/** How long a program may run before it is given up, ms. */
export const TWIN_PROGRAM_TIMEOUT_MS = 10_000;

let threeScript: vm.Script | null = null;
/** three's CommonJS build inside a function of its own, with a quiet console for it to warn through; the
 *  script's value is three's exports, frozen. Compiled once, run in every context. */
function three(): vm.Script {
  if (!threeScript) {
    const path = createRequire(import.meta.url).resolve('three');
    threeScript = new vm.Script(
      '(function () {\n' +
        'var console = { log: function () {}, info: function () {}, warn: function () {}, error: function () {}, debug: function () {} };\n' +
        'var module = { exports: {} };\n(function (module, exports) {\n' +
        readFileSync(path, 'utf8') +
        '\n})(module, module.exports);\nreturn Object.freeze(module.exports);\n})();\n',
      { filename: 'three.cjs' },
    );
  }
  return threeScript;
}

// What the frame's build() does with a program (twinFrame.ts), inside one function, as the frame's module
// keeps it: take what the host left on the global (three, the program, the declared names) and clear it; the
// API over THREE and a scene; the program run over them; what it added claimed (adopt: a kind for every mesh —
// its material's when the program gave none — and a part: its own tag, the nearest ancestor tagged or named
// after a declared part, else 'unnamed'); then the §29 checks.
const PROLOGUE = `(function (THREE, code, declared) {
  'use strict';
  delete globalThis.__three;
  delete globalThis.__code;
  delete globalThis.__declared;
  var stringify = JSON.stringify;
  var scene = new THREE.Scene();
`;
const EPILOGUE = `
  function message(e) { return e && e.message ? String(e.message) : String(e); }
  function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function none(extra) { return stringify(Object.assign({ error: null, stoppedAt: null, meshes: 0, parts: [], settled: null }, extra)); }
  var program;
  try { program = new Function('THREE', 'scene', 'api', code); }
  catch (e) { return none({ error: 'The program does not parse: ' + message(e) }); }
  var stoppedAt = null;
  try { program(THREE, scene, api); } catch (e) { stoppedAt = message(e); }
  var building = new THREE.Group();
  scene.children.slice().forEach(function (c) { building.add(c); });
  var byName = new Map();
  declared.forEach(function (n) { var t = String(n).trim(); if (t) byName.set(norm(t), t); });
  var parts = new Map();
  var meshes = 0;
  building.traverse(function (o) {
    if (!o.isMesh) return;
    meshes++;
    if (!o.userData.kind) {
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      o.userData.kind = asKind(mats[0] && mats[0].userData && mats[0].userData.kind);
    }
    if (!o.geometry || !o.geometry.isBufferGeometry) o.geometry = new THREE.BufferGeometry();
    var part = 'unnamed';
    for (var a = o; a && a !== building; a = a.parent) {
      if (typeof a.userData.part === 'string' && a.userData.part) { part = a.userData.part; break; }
      var named = a.name ? byName.get(norm(a.name)) : undefined;
      if (named) { part = named; break; }
    }
    o.userData.part = part;
    var entry = parts.get(part) || { meshes: 0, kinds: new Set() };
    entry.meshes++;
    entry.kinds.add(o.userData.kind);
    parts.set(part, entry);
  });
  if (!meshes)
    return none({ stoppedAt: stoppedAt, error: stoppedAt ? 'The program failed while building: ' + stoppedAt : 'The program added nothing to the scene.' });
  var settled = null;
  try {
    var s = settleScene(THREE, building);
    settled = { moved: s.moved, uncovered: roofCover(THREE, building, s.tol), shifts: s.shifts, split: s.split };
  } catch (e) {
    settled = null;
  }
  var list = [];
  parts.forEach(function (p, name) { list.push({ name: name, meshes: p.meshes, kinds: Array.from(p.kinds) }); });
  return stringify({ error: null, stoppedAt: stoppedAt, meshes: meshes, parts: list, settled: settled });
})(globalThis.__three, globalThis.__code, JSON.parse(globalThis.__declared));
`;
let driverScript: vm.Script | null = null;

/** An error's own message, read without running anything of the program's (a getter, a toString). */
function ownMessage(e: unknown): string {
  if (!e || typeof e !== 'object') return typeof e === 'string' ? e : '';
  const d = Object.getOwnPropertyDescriptor(e, 'message');
  return d && typeof d.value === 'string' ? d.value : '';
}

/**
 * Run a scene program as the frame runs it (see above): in a fresh context, with the frame's API and
 * checks, stopped after `timeoutMs`. No renderer: what it reports is what the program built and what the
 * frame would do to it, not what it looks like. A program that reaches for the document (a canvas texture)
 * stops here where the frame would not, and says so as `stoppedAt`.
 */
export function runTwinProgram(
  code: string,
  declared: readonly string[] = [],
  timeoutMs = TWIN_PROGRAM_TIMEOUT_MS,
): TwinProgramRun {
  const started = performance.now();
  const failed = (error: string): TwinProgramRun => ({
    error,
    stoppedAt: null,
    meshes: 0,
    parts: [],
    settled: null,
    ms: Math.round(performance.now() - started),
  });
  const sandbox = Object.create(null) as Record<string, unknown>;
  const context = vm.createContext(sandbox, { microtaskMode: 'afterEvaluate' });
  sandbox.__three = three().runInContext(context);
  sandbox.__code = code;
  sandbox.__declared = JSON.stringify(declared.map(String));
  driverScript ??= new vm.Script(PROLOGUE + TWIN_API_JS.split('__GEOMETRY_JS__').join(TWIN_GEOMETRY_JS) + EPILOGUE, {
    filename: 'twin-program.js',
  });
  let out: unknown;
  try {
    out = driverScript.runInContext(context, { timeout: timeoutMs });
  } catch (e) {
    const code = e && typeof e === 'object' ? Object.getOwnPropertyDescriptor(e, 'code')?.value : undefined;
    return failed(
      code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
        ? `The program ran for more than ${timeoutMs / 1000} s.`
        : `The program could not be run: ${ownMessage(e)}`,
    );
  }
  if (typeof out !== 'string') return failed('The program could not be run: it left no result.');
  return { ...(JSON.parse(out) as Omit<TwinProgramRun, 'ms'>), ms: Math.round(performance.now() - started) };
}
