/**
 * Building-twin analysis contract — what a vision model answers for a PHOTO SET of one building shot
 * from several standpoints (docs/digital-twin-plan.md §17). The model writes the building as a small
 * three.js PROGRAM: the body of a function that adds meshes to a scene through a tiny API the viewer
 * frame provides (twinFrame.ts on the client). A program can say what a fixed list of boxes cannot —
 * columns, a recessed glazed ground floor, a rooftop plant room, a canopy, the pavement and the road —
 * which is what makes the result read as the building in the photos. The frame runs it in a sandboxed
 * iframe with no origin; this module only checks that it is a plausible program and not an obvious
 * attempt to reach outside (the sandbox is the real guard).
 *
 * Dependency-free on purpose (types, constants, pure functions), like twinScene.ts: the functions build
 * compiles it and a script can run it straight from the source tree.
 */

// 1–4: a list of axis-aligned blocks with corners the client fitted cameras to and draped photos over;
// 5: the model writes the scene as code (no photo draping, a simulated heat map only).
export const TWIN_BUILDING_VERSION = 5;

/** At most this many photos of a set go to the model (evenly spaced through the set when it has more):
 *  a building needs a handful of standpoints, not every frame. */
export const TWIN_BUILDING_MAX_PHOTOS = 8;

/** Parts the frame's material API knows; the simulated heat map colours by these. */
export const TWIN_PART_KINDS = [
  'wall',
  'glass',
  'roof',
  'column',
  'canopy',
  'frame',
  'pavement',
  'road',
  'vegetation',
  'other',
] as const;
export type TwinPartKind = (typeof TWIN_PART_KINDS)[number];

/** Where a photo's camera stood, in the scene's frame, so the viewer can look from there. */
export interface TwinBuildingView {
  photo: number;
  x: number;
  y: number;
  z: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

export interface TwinBuildingCode {
  renderable: boolean;
  reason: string;
  confidence: number; // 0..1
  name: string; // "two-storey raised office wing"
  description: string;
  code: string; // the body of function (THREE, scene, api)
  views: TwinBuildingView[];
}

/** A program longer than this is not a building. */
export const MAX_CODE_CHARS = 120_000;

/**
 * JSON schema for `response_format: { type: 'json_schema' }`, written for strict mode: every property
 * required, no additionalProperties, no numeric range keywords.
 */
export const TWIN_BUILDING_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['renderable', 'reason', 'confidence', 'name', 'description', 'code', 'views'],
  properties: {
    renderable: {
      type: 'boolean',
      description:
        'true only when the photos show the exterior of ONE building (or one clearly bounded structure) well enough to model it. false for an interior, a lab bench, a screen, an object, several different buildings, or nothing recognisable.',
    },
    reason: { type: 'string', description: 'One sentence: why renderable is false, or empty string when true.' },
    confidence: { type: 'number', description: 'How well the model matches the photos, 0..1.' },
    name: { type: 'string', description: 'What the building is, a few words.' },
    description: { type: 'string', description: 'The massing in two or three sentences, as a viewer would read it.' },
    code: {
      type: 'string',
      description:
        'The body of the JavaScript function (THREE, scene, api) that builds the model — plain statements, no function wrapper, no imports, no markdown fences.',
    },
    views: {
      type: 'array',
      description:
        'One entry per photo that shows the building: where its camera stood and what it looked at, in the scene frame (metres).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['photo', 'x', 'y', 'z', 'targetX', 'targetY', 'targetZ'],
        properties: {
          photo: { type: 'integer', description: 'The photo number as announced to you.' },
          x: { type: 'number', description: 'Camera position x (metres).' },
          y: {
            type: 'number',
            description: 'Camera height above the ground (metres, about 1.6 for a street-level shot).',
          },
          z: { type: 'number', description: 'Camera position z (metres; the front of the building faces +z).' },
          targetX: { type: 'number', description: 'The point on the building the camera looks at, x.' },
          targetY: { type: 'number', description: 'That point, y.' },
          targetZ: { type: 'number', description: 'That point, z.' },
        },
      },
    },
  },
} as const;

export interface TwinBuildingPhotoInput {
  photo: number;
  width: number;
  height: number;
}

export interface TwinBuildingPromptContext {
  photos: TwinBuildingPhotoInput[];
  title?: string;
  description?: string;
}

/** System + user text for the analysis call. Images are attached by the caller in the order the user
 *  text announces: each photo's picture. */
export function buildTwinBuildingPrompt(ctx: TwinBuildingPromptContext): { system: string; user: string } {
  const system = `You are an architect who builds quick 3D massing models in three.js. You are given several photos of ONE building taken from different standpoints. Write the JavaScript that rebuilds that building as a massing model, faithful to what the photos show: the number of storeys, how the wings sit against each other and which one projects, what is raised on columns and how high the clear space is, where the ground floor is recessed or glazed, parapet heights, canopies, rooftop plant rooms, the rhythm of columns and window bands. Proportions and the relations between the parts matter far more than detail: someone who has seen the photos should recognise the building at once from any angle.

The frame that runs your code:
- Your code is the BODY of \`function build(THREE, scene, api) { ... }\`. Plain ES2020 statements: no \`import\`, no \`require\`, no \`async\`, no DOM, no network, no timers. Do not create a renderer, camera, lights, controls, sky or ground plane — the frame has them.
- \`THREE\` is the three.js r169 namespace (THREE.BoxGeometry, THREE.CylinderGeometry, THREE.ExtrudeGeometry with THREE.Shape, THREE.Mesh, THREE.Group, THREE.Vector3, THREE.Euler, …). \`scene\` is the THREE.Scene to add to.
- \`api.material(kind, color)\` returns the material for a part; kind is one of ${TWIN_PART_KINDS.map((k) => `'${k}'`).join(', ')}; color is an optional hex string like '#d8d9d5'. ALWAYS take materials from api.material so the thermal view knows what each part is; a mesh with any other material is treated as 'other'.
- \`api.box(w, h, d, x, y, z, kind, color)\` adds a box w wide (x), h high (y), d deep (z), standing on y (its BASE at y, not its centre), centred at x, z; returns the mesh. \`api.cylinder(radius, h, x, y, z, kind, color)\` adds a vertical cylinder standing on y. Use them for the bulk of the model; use raw THREE geometry only for shapes they cannot make (a sloped roof, an L-shaped slab, a chamfer).
- Units are metres. +y is up, the ground is y = 0. The building's FRONT — its main entrance facade, or failing that the facade seen most fully in photo 1 — faces +z; +x is to your RIGHT when you stand outside facing the front; the origin is the centre of the main block's footprint at ground level. Keep the whole model within about 150 m of the origin.
- Estimate sizes from storeys (≈3.5 m per storey for offices and schools, ≈3 m for houses), doors (≈2.1 m), cars (≈4.5 m long), people (≈1.7 m). A wing that spans ten window bays is not 20 m long.
- Glazing: model a glazed wall as a thin 'glass' box (0.1–0.3 m) in the wall's plane, or as a glass box set back from the columns for a recessed ground floor. Window bands can be thin 'glass' boxes on a 'wall' box. Columns are 'column' cylinders on the ground under the raised block, at the spacing the photos show.
- No two faces in the same plane (they flicker): ground layers step up — a 'pavement' slab 0.15 m thick on the ground, a plaza, road or parking surface 0.05 m thicker on top of it, kerbs 0.15 m tall; glazing, cladding and window frames stand 0.05–0.3 m proud of the wall they belong to; never put one box exactly inside another's face, and never stack two slabs of the same height.
- Site context helps the reader: a 'pavement' slab under and around the building, a 'road' strip where a photo shows one, a few 'vegetation' cylinders/spheres for trees, a kerb — modest, the building is the subject. Keep the whole scene under about 300 meshes, and never loop more than a few hundred times.
- Make the model read the same from every photo's standpoint: check each photo against your model before you answer — is the raised wing on the correct side, does the glazed hall sit under the right wing, do the storeys add up?

Also give, for every photo that shows the building, where its camera stood and what it looked at, in the same frame (views): street-level shots stand about 1.6 m up, 20–60 m out.

Answer with JSON only, following the schema: renderable, reason, confidence, name, description, code, views.`;
  const photos = ctx.photos
    .map(
      (p) =>
        `Photo ${p.photo}: a ${p.width >= p.height ? 'landscape' : 'portrait'} picture (${p.width}×${p.height} px).`,
    )
    .join('\n');
  const meta = [
    ctx.title ? `The set is titled "${ctx.title}".` : '',
    ctx.description ? `The owner describes it: "${ctx.description}".` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const user = `${ctx.photos.length} photo${ctx.photos.length === 1 ? '' : 's'} of one building, in this order:\n${photos}\n${meta ? meta + '\n' : ''}
Write the massing model.`;
  return { system, user };
}

// ---------------------------------------------------------------------------------------------------
// Parsing

export function extractJsonObject(text: string): string | null {
  // Only a fence around the WHOLE answer is a wrapper: the program inside the JSON may hold fences.
  const trimmed = text.trim();
  const fenced = trimmed.startsWith('```') ? trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i) : null;
  const body = (fenced ? fenced[1] : trimmed).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + 1);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.trim() : fallback);

/**
 * A program with its comments and string literals blanked out (their length kept, so positions hold),
 * so "window band" in a comment or 'document' in a label is not mistaken for the DOM. Template
 * literals are blanked whole; a ${} inside one is rare in a building program and is lost with it.
 */
export function bareCode(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && code[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        out += code[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
    } else if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += q;
      i++;
      while (i < n && code[i] !== q) {
        if (code[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += code[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += q;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Identifiers a building program has no business using. The frame's sandbox (an iframe with no origin
 * and no network permission) is what actually stops a program reaching outside; this is the cheap
 * first line that also catches a model that misunderstood the task (importing three, touching the DOM).
 * Tested on the bare code (bareCode) as whole identifiers that are not a property: `windowBand`, a
 * comment saying "window" and `mesh.parent` pass; `window.parent` does not.
 */
const FORBIDDEN_IDENTIFIERS = [
  'import',
  'require',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'document',
  'window',
  'globalThis',
  'self',
  'parent',
  'top',
  'frames',
  'location',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'postMessage',
  'eval',
  'Function',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'Worker',
  'importScripts',
];
const FORBIDDEN_RE = new RegExp(`(^|[^\\w$.])(${FORBIDDEN_IDENTIFIERS.join('|')})\\b`);
const ENDLESS_RE = /\bwhile\s*\(\s*(true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/;

/** Why a program is refused, or null when it passes the checks. */
export function checkSceneCode(code: string): string | null {
  if (!code.trim()) return 'the program is empty';
  if (code.length > MAX_CODE_CHARS) return `the program is too long (${code.length} characters)`;
  const bare = bareCode(code);
  const hit = bare.match(FORBIDDEN_RE);
  if (hit) return `the program uses ${hit[2]}`;
  if (ENDLESS_RE.test(bare)) return 'the program has an endless loop';
  if (/<\s*script\b/i.test(bare)) return 'the program contains a script tag';
  return null;
}

/** A program the model wrapped anyway — in fences, or in the function header it was told to omit. */
function unwrapCode(raw: string): string {
  let code = raw.trim();
  const fenced = code.match(/^```(?:javascript|js)?\s*([\s\S]*?)```$/i);
  if (fenced) code = fenced[1].trim();
  const wrapped = code.match(/^function\s+\w*\s*\(\s*THREE\s*,\s*scene\s*,\s*api\s*\)\s*\{([\s\S]*)\}\s*$/);
  if (wrapped) code = wrapped[1].trim();
  return code;
}

/**
 * Parse and validate a model answer. `sentPhotos`, when given, is the list of photo numbers the model
 * was shown; a view of any other photo is dropped. A program that fails checkSceneCode makes the answer
 * non-renderable with that reason rather than an error: the record still says what the model saw.
 */
export function parseTwinBuildingCode(
  text: string,
  sentPhotos?: number[],
): { answer: TwinBuildingCode | null; errors: string[] } {
  const errors: string[] = [];
  const json = extractJsonObject(text);
  if (!json) return { answer: null, errors: ['no JSON object in the answer'] };
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { answer: null, errors: [`JSON.parse failed: ${(e as Error).message}`] };
  }
  if (!raw || typeof raw !== 'object') return { answer: null, errors: ['the answer is not an object'] };
  const sent = sentPhotos ? new Set(sentPhotos) : null;
  const views: TwinBuildingView[] = [];
  const rawViews: unknown[] = Array.isArray(raw.views) ? raw.views : [];
  const seen = new Set<number>();
  rawViews.forEach((v: any, i) => {
    if (!v || typeof v !== 'object' || !isNum(v.photo)) {
      errors.push(`views[${i}] invalid → dropped`);
      return;
    }
    const photo = Math.round(v.photo);
    if (sent && !sent.has(photo)) {
      errors.push(`views[${i}] names photo ${photo}, which was not sent → dropped`);
      return;
    }
    if (seen.has(photo)) {
      errors.push(`views[${i}] repeats photo ${photo} → dropped`);
      return;
    }
    // The schema asks for flat x/y/z + targetX/Y/Z; a provider without schema enforcement may answer
    // with a position and a target as triples or {x, y, z} objects under a few likely names.
    const triple = (o: unknown): number[] | null => {
      if (Array.isArray(o) && o.length >= 3 && o.slice(0, 3).every(isNum)) return o.slice(0, 3) as number[];
      if (o && typeof o === 'object') {
        const p = o as Record<string, unknown>;
        if (isNum(p.x) && isNum(p.y) && isNum(p.z)) return [p.x, p.y, p.z];
      }
      return null;
    };
    const pos =
      isNum(v.x) && isNum(v.y) && isNum(v.z)
        ? [v.x, v.y, v.z]
        : (triple(v.position) ?? triple(v.camera) ?? triple(v.eye) ?? triple(v.from));
    const tgt =
      isNum(v.targetX) && isNum(v.targetY) && isNum(v.targetZ)
        ? [v.targetX, v.targetY, v.targetZ]
        : (triple(v.target) ?? triple(v.look) ?? triple(v.lookAt) ?? triple(v.to));
    if (!pos || !tgt || [...pos, ...tgt].some((n) => Math.abs(n) > 2000)) {
      errors.push(`views[${i}] has a bad position → dropped`);
      return;
    }
    seen.add(photo);
    views.push({ photo, x: pos[0], y: pos[1], z: pos[2], targetX: tgt[0], targetY: tgt[1], targetZ: tgt[2] });
  });
  let renderable = raw.renderable !== false;
  let reason = str(raw.reason);
  const code = renderable ? unwrapCode(str(raw.code)) : '';
  if (renderable) {
    const problem = checkSceneCode(code);
    if (problem) {
      errors.push(`code refused: ${problem}`);
      renderable = false;
      reason = `The model's program could not be used: ${problem}.`;
    }
  }
  return {
    answer: {
      renderable,
      reason,
      confidence: isNum(raw.confidence) ? clamp01(raw.confidence) : 0,
      name: str(raw.name, 'building'),
      description: str(raw.description),
      code: renderable ? code : '',
      views,
    },
    errors,
  };
}

/** Why the answer should not be shown as a model, or null when it should. */
export function twinBuildingBlocker(answer: TwinBuildingCode, minConfidence = 0.4): string | null {
  if (!answer.renderable) return answer.reason || 'The photos do not show one building well enough to model it.';
  if (answer.confidence < minConfidence) return 'The model was not confident enough that this matches the photos.';
  return null;
}

/** Evenly spaced photo numbers (1-based) when a set has more photos than the model should see. Keeps the
 *  first and the last so the standpoints span the whole walk. */
export function pickTwinPhotos(photoCount: number, max = TWIN_BUILDING_MAX_PHOTOS): number[] {
  const n = Math.max(0, Math.floor(photoCount));
  if (n <= max) return Array.from({ length: n }, (_, i) => i + 1);
  const out: number[] = [];
  for (let i = 0; i < max; i++) {
    const k = Math.round((i * (n - 1)) / (max - 1)) + 1;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** Pixel size of a JPEG or PNG from its header bytes; null when it is neither. Reads only what it needs,
 *  so a 1600-px picture costs nothing to measure. */
export function imageSize(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
    const height = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
    return width > 0 && height > 0 ? { width: width >>> 0, height: height >>> 0 } : null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      // Standalone markers carry no length.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = (buf[i + 2] << 8) | buf[i + 3];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = (buf[i + 5] << 8) | buf[i + 6];
        const width = (buf[i + 7] << 8) | buf[i + 8];
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (marker === 0xda) break; // start of scan: no SOF before it
      i += 2 + len;
    }
  }
  return null;
}
