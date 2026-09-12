/**
 * Scene-twin analysis contract — what a vision model answers for a PHOTO SET of one subject shot from
 * several standpoints, or for frames sampled from a recording walked around it (docs/digital-twin-plan.md
 * §17–§18). The model writes the subject as a small three.js PROGRAM: the body of a function that adds
 * meshes to a scene through a tiny API the viewer frame provides (twinFrame.ts on the client). A program
 * can say what a fixed list of boxes cannot — columns, a recessed glazed ground floor, a kettle's spout,
 * a bench with the apparatus on it — which is what makes the result read as the thing in the photos.
 * The frame runs it in a sandboxed iframe with no origin; this module only checks that it is a
 * plausible program and not an obvious attempt to reach outside (the sandbox is the real guard).
 *
 * Contract v6 (§18.6) adds a second phase: for every photo that carries temperatures, a second model
 * call outlines the surfaces of the named parts in the picture, and surfaceStats reads the thermal
 * pixels inside each outline. That is what lets the viewer paint MEASURED temperatures on the model
 * instead of a simulation, and say honestly which faces were measured and which were inferred.
 *
 * Dependency-free on purpose (types, constants, pure functions), like twinScene.ts: the functions build
 * compiles it and a script can run it straight from the source tree. The thermal grid size is repeated
 * here rather than imported from thermal.ts for the same reason.
 */

// 1–4: a list of axis-aligned blocks with corners the client fitted cameras to and draped photos over;
// 5: the model writes the scene as code (no photo draping, a simulated heat map only);
// 6: any subject, named parts, and measured surface temperatures traced per thermal photo.
export const TWIN_BUILDING_VERSION = 6;

/** At most this many photos of a set go to the model (evenly spaced through the set when it has more):
 *  a subject needs a handful of standpoints, not every frame. */
export const TWIN_BUILDING_MAX_PHOTOS = 8;

/** The FLIR One thermal grid the temperatures come in (row-major, 120 wide × 160 tall). */
export const IR_GRID_WIDTH = 120;
export const IR_GRID_HEIGHT = 160;

/** Material kinds the frame's API knows. The first ten are a building's; the rest let any subject be
 *  described. Only the building kinds take part in the SIMULATED heat map — the others colour the
 *  realistic view and tell the thermal reading whether a surface is reflective (APPARENT_KINDS). */
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
  'metal',
  'plastic',
  'wood',
  'stone',
  'liquid',
  'fabric',
] as const;
export type TwinPartKind = (typeof TWIN_PART_KINDS)[number];

/** Kinds whose thermal reading is an APPARENT temperature: low emissivity or a reflection (a window
 *  showing the sky, a steel kettle showing the room), not the surface's own temperature. */
export const APPARENT_KINDS: readonly string[] = ['glass', 'metal', 'liquid'];

/** What the model decided the photos show — answered afresh on every revision. The client orders the
 *  measured view's inference by it and treats an interior apart (no ground plane, no sky cut); the
 *  simulated view is offered for every kind (docs/digital-twin-plan.md §21). */
export const TWIN_SUBJECT_KINDS = ['building', 'interior', 'apparatus', 'vehicle', 'nature', 'other'] as const;
export type TwinSubjectKind = (typeof TWIN_SUBJECT_KINDS)[number];

/** A face of a part in the subject's own frame (front = +z, right = +x, top = +y). 'all' is a body with
 *  no distinct faces (a cylinder, a tree), which may instead be traced in three height bands. */
export const TWIN_FACES = [
  'front',
  'back',
  'left',
  'right',
  'top',
  'bottom',
  'all',
  'upper',
  'middle',
  'lower',
] as const;
export type TwinFace = (typeof TWIN_FACES)[number];

/** The camera-relative facing the tracing model reports alongside the world face, so the client can
 *  catch a mirrored label (a face called 'left' that faces the camera's right). */
export const TWIN_FACINGS = ['toward', 'camLeft', 'camRight', 'up', 'down'] as const;
export type TwinFacing = (typeof TWIN_FACINGS)[number];

/** A named part of the program (`api.part(name, kind, description)`): the unit a temperature attaches to. */
export interface TwinBuildingPart {
  name: string;
  kind: TwinPartKind;
  description: string; // '' when the model gave none — never undefined, Firestore refuses it
}

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
  subject: string; // "a stainless-steel kettle on a hot plate"
  subjectKind: TwinSubjectKind;
  name: string; // "two-storey raised office wing"
  description: string;
  parts: TwinBuildingPart[]; // what the code declares with api.part, in the code's own names
  code: string; // the body of function (THREE, scene, api)
  views: TwinBuildingView[];
}

/** A program longer than this is not a model of anything. */
export const MAX_CODE_CHARS = 120_000;

/**
 * JSON schema for `response_format: { type: 'json_schema' }`, written for strict mode: every property
 * required, no additionalProperties, no numeric range keywords.
 */
export const TWIN_BUILDING_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'renderable',
    'reason',
    'confidence',
    'subject',
    'subjectKind',
    'name',
    'description',
    'parts',
    'code',
    'views',
  ],
  properties: {
    renderable: {
      type: 'boolean',
      description:
        'true when the photos show ONE identifiable subject well enough to model it; false for several unrelated subjects, a screen or chart, or nothing recognisable.',
    },
    reason: { type: 'string', description: 'One sentence: why renderable is false, or empty string when true.' },
    confidence: { type: 'number', description: 'How well the model matches the photos, 0..1.' },
    subject: { type: 'string', description: 'What the subject is, in one sentence.' },
    subjectKind: {
      type: 'string',
      enum: [...TWIN_SUBJECT_KINDS],
      description:
        'building: a structure seen from outside; interior: a room seen from inside; apparatus: equipment or objects on a bench or floor; vehicle; nature: a tree, rock, animal or landscape; other.',
    },
    name: { type: 'string', description: 'What the subject is, a few words.' },
    description: { type: 'string', description: 'The massing in two or three sentences, as a viewer would read it.' },
    parts: {
      type: 'array',
      description: 'Exactly the parts the code declares with api.part, one entry each, same names.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind', 'description'],
        properties: {
          name: { type: 'string', description: 'The camelCase identifier passed to api.part.' },
          kind: { type: 'string', enum: [...TWIN_PART_KINDS], description: 'Its material kind.' },
          description: { type: 'string', description: 'A few words: what it is and where it sits.' },
        },
      },
    },
    code: {
      type: 'string',
      description:
        'The body of the JavaScript function (THREE, scene, api) that builds the model — plain statements, no function wrapper, no imports, no markdown fences.',
    },
    views: {
      type: 'array',
      description:
        'One entry per photo that shows the subject: where its camera stood and what it looked at, in the scene frame (metres).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['photo', 'x', 'y', 'z', 'targetX', 'targetY', 'targetZ'],
        properties: {
          photo: { type: 'integer', description: 'The photo number as announced to you.' },
          x: { type: 'number', description: 'Camera position x (metres).' },
          y: {
            type: 'number',
            description: 'Camera height above the surface the subject stands on (metres).',
          },
          z: { type: 'number', description: 'Camera position z (metres; the front of the subject faces +z).' },
          targetX: { type: 'number', description: 'The point on the subject the camera looks at, x.' },
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
  /** 'orbit' when the pictures are frames of a recording walked around the subject (the wording says
   *  "frames" and warns that consecutive ones are close together). */
  source?: 'photos' | 'orbit';
  /** What the owner asked of the model before it was built (§20): what the subject is, what to leave
   *  out, how detailed to be. A revision is given the same request, which still stands. */
  instructions?: string;
  /** Present when the call REVISES a model the owner has looked at (§19) instead of writing one. */
  revision?: TwinBuildingRevisionInput;
}

/** What a revision call is given besides the photos: the model as it stands, the owner's note on it, and
 *  the rounds before (§19). The views speak in stored indices, as the record does; the prompt numbers
 *  them by their position among `photos`, the way the pictures are announced. */
export interface TwinBuildingRevisionInput {
  code: string;
  parts: TwinBuildingPart[];
  views: TwinBuildingView[];
  note: string;
  history: TwinBuildingRevision[];
}

/**
 * Identifiers a program must not use as variable names: the sandbox's globals, which the code check
 * refuses as member-access roots. Spelled out in the prompt so a model does not name its roof `top`.
 */
export const RESERVED_IDENTIFIERS = ['top', 'parent', 'self', 'window', 'document', 'location', 'frames'] as const;

/**
 * How a picture is named to the model, in both phases and whatever the source: by its 1-based position
 * in the order sent ("Photo 3"), with the stored index in brackets when it is something else — a
 * recording frame's number, or a photo's place in a set the model was shown only part of. The model
 * refers to pictures by the position (the prompt's "photo 1" defines the subject's front), and
 * parseTwinBuildingCode maps a view back to the stored index before anything is persisted, so the
 * record keeps speaking in recording frames and set photos as the client expects.
 */
export function pictureLabel(ordinal: number, stored: number, source: 'photos' | 'orbit' = 'photos'): string {
  if (source === 'orbit') return `Photo ${ordinal} (recording frame ${stored})`;
  return stored === ordinal ? `Photo ${ordinal}` : `Photo ${ordinal} (photo ${stored} of the set)`;
}

/** System + user text for the phase-1 call. Images are attached by the caller in the order the user
 *  text announces: each photo's picture. Two layers: a subject-neutral core, then size anchors per kind
 *  of subject — the model does not know the kind before it looks, so it is given all of them and told
 *  to use the ones that apply. With `ctx.instructions` the owner's request is quoted and the rules say
 *  how far it reaches (§20). With `ctx.revision` the same call revises the model as it stands (§19):
 *  the rules are the ones it wrote the model under, plus how to revise, and the user text carries the
 *  program, its parts and views, the notes already applied and the owner's new note. */
export function buildTwinBuildingPrompt(ctx: TwinBuildingPromptContext): { system: string; user: string } {
  const revision = ctx.revision ?? null;
  const instructions = ctx.instructions?.trim() || null;
  const kinds = TWIN_PART_KINDS.map((k) => `'${k}'`).join(', ');
  const system = `You are a modeller who builds quick, faithful 3D massing models in three.js. You are given several photos of ONE subject taken from different standpoints — a building, a room, a lab bench with apparatus, a machine, a vehicle, a tree, a statue, anything. First decide what the subject is; then write the JavaScript that rebuilds it as a massing model, faithful to what the photos show: its proportions, how its parts sit against each other and which one projects, what stands on or hangs from what, what is raised and how high the clear space is, what is recessed or glazed, the rhythm of repeated elements (columns, window bands, legs, pipes). Proportions and the relations between the parts matter far more than detail: someone who has seen the photos should recognise the subject at once from any angle.

The frame that runs your code:
- Your code is the BODY of \`function build(THREE, scene, api) { ... }\`. Plain ES2020 statements: no \`import\`, no \`require\`, no \`async\`, no DOM, no network, no timers. Do not create a renderer, camera, lights, controls, sky or ground plane — the frame has them. Never use the identifiers ${RESERVED_IDENTIFIERS.join(', ')} as variable names.
- \`THREE\` is the three.js r169 namespace (THREE.BoxGeometry, THREE.CylinderGeometry, THREE.SphereGeometry, THREE.ExtrudeGeometry with THREE.Shape, THREE.LatheGeometry, THREE.Mesh, THREE.Group, THREE.Vector3, THREE.Euler, …). \`scene\` is the THREE.Scene to add to.
- PARTS. Every mesh belongs to a named part, because temperatures are measured per part and per face. Declare a part with \`const p = api.part(name, kind, description)\` — name a short camelCase identifier ('mainBlock', 'northWing', 'kettleBody', 'hotPlate'), kind one of ${kinds}, description a few words — and build it through the builder it returns: \`p.box(w, h, d, x, y, z, kind?, color?)\`, \`p.cylinder(radius, h, x, y, z, kind?, color?)\` (kind defaults to the part's kind), \`p.add(object3d)\` for a mesh or group you made from raw THREE geometry, and \`p.group\`, the THREE.Group everything of the part goes into. Split parts where their temperatures could plausibly differ: a kettle's body and its handle, a hot plate and the beaker standing on it, a wall and its window band, a roof and the plant room on it are different parts; one part is one material at roughly one temperature. Declare every part before you build it, and list the same parts, with the same names, in the answer's \`parts\`.
- \`api.material(kind, color)\` returns the material for a kind; color is an optional hex string like '#d8d9d5'. ALWAYS take materials from api.material (the builders do) so the thermal views know what each surface is; a mesh with any other material is treated as 'other'.
- \`api.box(w, h, d, x, y, z, kind, color)\` and \`api.cylinder(radius, h, x, y, z, kind, color)\` add an unnamed box / vertical cylinder standing on y (its BASE at y, not its centre), centred at x, z, and return the mesh — for surroundings that need no temperature only (a distant tree, a kerb); everything that is the subject goes through a part. Use raw THREE geometry only for shapes the builders cannot make (a sloped roof, an L-shaped slab, a spout, a chamfer). An outline to extrude is a THREE.Shape built with moveTo/lineTo (a hole in it is a THREE.Path pushed into shape.holes); pass the Shape itself to THREE.ExtrudeGeometry or THREE.ShapeGeometry — never a Path or an array of points.
- Units are metres. +y is up; y = 0 is the surface the subject stands on (ground, floor or bench top). The subject's FRONT faces +z: a building — its entrance facade; a vehicle — its nose; apparatus and objects — the side facing the camera in photo 1; an interior — the wall opposite the camera in photo 1. +x is to your RIGHT when you face the front from outside; the origin is the centre of the subject's footprint on y = 0. Model an interior's walls as separate slabs seen from inside, never one hollow box.
- Size anchors — use the ones for what the subject turns out to be. A building: ≈3.5 m per storey for offices and schools, ≈3 m for houses, doors 2.1 m. An interior: doors 2.1 m, ceilings 2.7 m, table tops 0.75 m, chair seats 0.45 m. Apparatus: a bench top 0.9 m high, a 250 mL beaker 7 cm across and 9.5 cm tall, a hot plate 0.25 m across, an A4 sheet 0.21 × 0.30 m, a hand 0.18 m. A vehicle: wheels 0.65 m across, a car 4.5 × 1.8 × 1.5 m. Nature: a person 1.7 m. A wing that spans ten window bays is not 20 m long.
- Glazing: model a glazed wall as a thin 'glass' box (0.1–0.3 m) in the wall's plane, or as a glass box set back from the columns for a recessed ground floor. Window bands can be thin 'glass' boxes on a 'wall' box. Columns are 'column' cylinders on the ground under the raised block, at the spacing the photos show.
- No two faces in the same plane (they flicker): ground layers step up — a 'pavement' slab 0.15 m thick on the ground, a plaza, road or parking surface 0.05 m thicker on top of it, kerbs 0.15 m tall; glazing, cladding and window frames stand 0.05–0.3 m proud of the wall they belong to; never put one box exactly inside another's face, and never stack two slabs of the same height. For small subjects scale these offsets down with the subject.
- Surroundings: only what the photos show around the subject, scaled to it — a pavement and road for a building, the bench for apparatus, the floor for a room — modest, the subject is the subject. Keep the whole scene under about 300 meshes, and never loop more than a few hundred times.
- Make the model read the same from every photo's standpoint: check each photo against your model before you answer — is the projecting part on the correct side, does what stands on what agree, do the storeys or the counts add up?

Also give, for every photo that shows the subject, where its camera stood and what it looked at, in the same frame (views): the camera stood 1.5–4 subject sizes away, at the height the photos suggest.
${
  instructions
    ? `
THE OWNER'S REQUEST. The owner — who took the photos and knows the subject — has said what they want from this model; the message quotes it. Follow it wherever the photos allow: it may say what the subject is, what to include or leave out, which parts matter most, how much detail to give, or facts the photos cannot show. Where it and your reading of the photos disagree about what the subject is or how its parts relate, the owner's word wins; the photos still set every proportion the request does not mention. It cannot change how the frame works: the API, the units, the parts rule and the answer format above stay as they are. When it asks for something a massing model cannot show, do the nearest thing.
`
    : ''
}${
    revision
      ? `
REVISING. A model of this subject has already been written — its program is in the message, perhaps by another modeller — and its owner, who took the photos and knows the subject, has looked at it and says what is wrong. Fix what the note points at, checking it against the photos, and move whatever has to move with it. Keep everything the note does not mention as it is: the same part names, sizes and positions, and the same views unless they are what is wrong — a revision that quietly rebuilds the rest loses what was already right. On what the subject is and how its parts relate, the owner's word beats your reading of the photos (they were there); the photos still set every proportion the note does not mention. Notes listed as already applied were fixed in earlier rounds: keep them fixed.${instructions ? ' The request the model was first built to still stands.' : ''} When something asked for cannot be shown in a massing model, do the nearest thing and say so. Write the WHOLE program again — never a diff, an excerpt or an "unchanged" placeholder — and add \`changes\`: one or two plain sentences to the owner saying what you changed, or why part of the note could not be done.
`
      : ''
  }
Answer with JSON only, following the schema: renderable, reason, confidence, subject, subjectKind, name, description, parts, code, views${revision ? ', changes' : ''}.`;
  const orbit = ctx.source === 'orbit';
  const noun = orbit ? 'frame' : 'photo';
  // Pictures are numbered 1..N in the order sent, whatever they are stored as (pictureLabel): the
  // system text's "photo 1" then exists in every set, and a view's number is a position the server
  // maps back to the stored index.
  const photos = ctx.photos
    .map(
      (p, i) =>
        `${pictureLabel(i + 1, p.photo, ctx.source)}: a ${p.width >= p.height ? 'landscape' : 'portrait'} picture (${p.width}×${p.height} px).`,
    )
    .join('\n');
  const meta = [
    ctx.title ? `The set is titled "${ctx.title}".` : '',
    ctx.description ? `The owner describes it: "${ctx.description}".` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const count = `${ctx.photos.length} ${noun}${ctx.photos.length === 1 ? '' : 's'}`;
  const intro = orbit
    ? `${count} of one subject, sampled in time order from a recording whose camera walked around it (neighbouring frames were taken close together, so expect gradual changes of standpoint):`
    : `${count} of one subject, in this order:`;
  // Quoted like a revision note, so the owner's words cannot pass for the prompt's own.
  const request = instructions ? `\nThe owner's request for this model:\n"""\n${instructions}\n"""\n` : '';
  // The photo numbers are what the answer's views and the second phase refer to, so they are called
  // "photo N" in both kinds of set.
  const user = `${intro}\n${photos}\n${meta ? meta + '\n' : ''}${request}${revision ? `\n${describeRevision(revision, ctx.photos)}\n` : ''}
Refer to each picture by its number as photo N (photo 1 is the first listed). ${
    revision
      ? 'Revise the model: fix what the note says, keep the rest, and answer with the whole JSON again, changes included.'
      : instructions
        ? "Write the model, following the owner's request."
        : 'Write the model.'
  }`;
  return { system, user };
}

/** The revision half of the user text: the model as it stands — its program, its parts, where each
 *  camera stood (renumbered by position, the way the pictures were announced; a view of a picture not
 *  sent this time is left out) — then the notes already applied and the owner's new one. */
function describeRevision(revision: TwinBuildingRevisionInput, photos: TwinBuildingPhotoInput[]): string {
  const position = new Map(photos.map((p, i) => [p.photo, i + 1]));
  const n = (v: number) => String(Math.round(v * 100) / 100);
  const parts = revision.parts.length
    ? revision.parts.map((p) => `- ${p.name} — ${p.kind}${p.description ? ` — ${p.description}` : ''}`).join('\n')
    : '- (the program declares no named parts)';
  const views = revision.views
    .filter((v) => position.has(v.photo))
    .sort((a, b) => position.get(a.photo)! - position.get(b.photo)!)
    .map(
      (v) =>
        `- photo ${position.get(v.photo)}: camera at (${n(v.x)}, ${n(v.y)}, ${n(v.z)}), looking at (${n(v.targetX)}, ${n(v.targetY)}, ${n(v.targetZ)})`,
    );
  // Worded for whichever model revises: the owner may send a note to another model than the one that
  // wrote the program (§20).
  const history = revision.history.map(
    (r, i) => `${i + 1}. "${r.feedback}"${r.changes ? ` — answered: "${r.changes}"` : ''}`,
  );
  return [
    'The model as it stands — its program:',
    '```javascript',
    revision.code,
    '```',
    'Its parts (name — kind — description):',
    parts,
    ...(views.length ? ['Where each camera was judged to stand (metres):', ...views] : []),
    ...(history.length ? ['', 'Notes already applied, oldest first:', ...history] : []),
    '',
    "The owner's note on the model as it stands:",
    '"""',
    revision.note,
    '"""',
  ].join('\n');
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

/** Like extractJsonObject, but a bare array is a valid answer too (a surface list without its wrapper). */
export function extractJsonValue(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.startsWith('```') ? trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i) : null;
  const body = (fenced ? fenced[1] : trimmed).trim();
  const firstObj = body.indexOf('{');
  const firstArr = body.indexOf('[');
  const arrayFirst = firstArr >= 0 && (firstObj < 0 || firstArr < firstObj);
  const start = arrayFirst ? firstArr : firstObj;
  const end = body.lastIndexOf(arrayFirst ? ']' : '}');
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + 1);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.trim() : fallback);

/** Part names as the frame, the server and the client compare them: lower case, letters and digits only. */
export function normalizePartName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const isPartKind = (v: unknown): v is TwinPartKind => (TWIN_PART_KINDS as readonly string[]).includes(v as string);
const isSubjectKind = (v: unknown): v is TwinSubjectKind =>
  (TWIN_SUBJECT_KINDS as readonly string[]).includes(v as string);

/**
 * A program with its comments and string literals blanked out (their length kept, so positions hold),
 * so "window band" in a comment or 'document' in a label is not mistaken for the DOM. Template
 * literals are blanked whole; a ${} inside one is rare in a scene program and is lost with it.
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
 * Identifiers a scene program has no business using. The frame's sandbox (an iframe with no origin
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
/** Globals that are also ordinary English: a program may well say `const top = …` for a roof slab or
 *  `parent` for a group, and models do. They are refused only as the ROOT of a member access
 *  (`top.location`, `parent[…]`), which is the only way they reach anything outside. `this` is in the
 *  list because the frame runs the program as a sloppy-mode function body, where `this` IS the frame
 *  window — `this.parent.postMessage(…)` would reach the host page. */
const MEMBER_ROOT_IDENTIFIERS = ['top', 'parent', 'self', 'this'];
const FORBIDDEN_RE = new RegExp(`(^|[^\\w$.])(${FORBIDDEN_IDENTIFIERS.join('|')})\\b`);
const MEMBER_ROOT_RE = new RegExp(`(^|[^\\w$.])(${MEMBER_ROOT_IDENTIFIERS.join('|')})\\s*[.[]`);
/** Walking a prototype chain is how a program gets at the Function constructor without naming it
 *  (`[].constructor.constructor('return this')()` is the frame window again) — nothing a scene needs.
 *  The member form is tested on the bare code; the bracket form quotes the word, which bareCode blanks,
 *  so it is tested on the program as written. */
const PROTOTYPE_MEMBER_RE = /\.\s*(constructor|__proto__)\b|(?:^|[^\w$.])(__proto__)\b/;
const PROTOTYPE_BRACKET_RE = /\[\s*(['"`])(constructor|__proto__)\1\s*\]/;
const ENDLESS_RE = /\bwhile\s*\(\s*(true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/;

/** Why a program is refused, or null when it passes the checks. */
export function checkSceneCode(code: string): string | null {
  if (!code.trim()) return 'the program is empty';
  if (code.length > MAX_CODE_CHARS) return `the program is too long (${code.length} characters)`;
  const bare = bareCode(code);
  const hit = bare.match(FORBIDDEN_RE) ?? bare.match(MEMBER_ROOT_RE);
  if (hit) return `the program uses ${hit[2]}`;
  const member = bare.match(PROTOTYPE_MEMBER_RE);
  if (member) return `the program uses ${member[1] ?? member[2]}`;
  const bracket = code.match(PROTOTYPE_BRACKET_RE);
  if (bracket) return `the program uses ${bracket[2]}`;
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

/** One quoted JS string literal (single or double quotes, escapes allowed), captured without its quotes. */
const QUOTED = `(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`;
/** An `api.part(...)` call whose NAME is a quoted literal. The kind and the description may be any
 *  expression (`M`, `kinds[i]`, a template literal): only a quoted one is read, an unquoted kind is
 *  'other' and an unquoted description '' — mergeParts fills both from the JSON. */
const PART_CALL_RE = new RegExp(
  `api\\s*\\.\\s*part\\s*\\(\\s*${QUOTED}\\s*(?:,\\s*(?:${QUOTED}|[^,)]+?)\\s*)?(?:,\\s*(?:${QUOTED}|[^)]*?)\\s*)?[,)]`,
  'g',
);
/** An `api.part(` whose first argument is not a quoted literal: a template literal in a loop
 *  (`api.part(\`column${i}\`, …)`) or a variable. Such parts exist at run time but cannot be read
 *  from the text, so the JSON list is the only account of them. */
const DYNAMIC_PART_CALL_RE = /api\s*\.\s*part\s*\(\s*(?![\s'"])/;

/**
 * The parts a program declares — every `api.part('name', kind, description)` call whose name is a
 * quoted literal, in order of first appearance, read from the code as written (comments and strings
 * intact, since the arguments ARE strings). The code is the truth about parts: a part the JSON lists
 * but the code never declares has no meshes to paint. A kind that is not a quoted TWIN_PART_KINDS
 * word becomes 'other'; a description that is not a quoted string is ''.
 */
export function extractPartsFromCode(code: string): TwinBuildingPart[] {
  const out: TwinBuildingPart[] = [];
  const seen = new Set<string>();
  const unescape = (s: string) => s.replace(/\\(.)/g, '$1');
  for (const m of code.matchAll(PART_CALL_RE)) {
    const name = unescape(m[1] ?? m[2] ?? '').trim();
    const kind = unescape(m[3] ?? m[4] ?? '').trim();
    const description = unescape(m[5] ?? m[6] ?? '').trim();
    if (!name) continue;
    const key = normalizePartName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name, kind: isPartKind(kind) ? kind : 'other', description });
  }
  return out;
}

/** Whether the program declares a part whose name the text cannot give (see DYNAMIC_PART_CALL_RE). */
export function hasDynamicPartCalls(code: string): boolean {
  return DYNAMIC_PART_CALL_RE.test(code);
}

/**
 * Merge the JSON `parts` into the ones the code declares (§18.6 B2): the code's names and order win, the
 * JSON supplies descriptions (and a kind when the code's is unknown); a JSON part the code never
 * declares is dropped and reported — unless the code declares parts by names the text cannot read
 * (`dynamicParts`: a template literal or a variable as the name), in which case the JSON is the only
 * account of those parts and its extra entries are appended after the code's, with a note. When the
 * code declares nothing, the JSON list stands on its own — an older-style program with named THREE
 * groups still gets a parts list for the tracing phase.
 */
export function mergeParts(
  fromCode: TwinBuildingPart[],
  rawJson: unknown,
  errors: string[],
  dynamicParts = false,
): TwinBuildingPart[] {
  const json: TwinBuildingPart[] = [];
  const jsonSeen = new Set<string>();
  if (Array.isArray(rawJson)) {
    rawJson.forEach((p: any, i) => {
      const name = str(p?.name);
      if (!name || !normalizePartName(name)) {
        errors.push(`parts[${i}] has no name → dropped`);
        return;
      }
      const key = normalizePartName(name);
      if (jsonSeen.has(key)) return;
      jsonSeen.add(key);
      const kind = str(p?.kind);
      json.push({ name, kind: isPartKind(kind) ? kind : 'other', description: str(p?.description) });
    });
  }
  if (!fromCode.length) return json;
  const byKey = new Map(json.map((p) => [normalizePartName(p.name), p]));
  const merged = fromCode.map((c) => {
    const j = byKey.get(normalizePartName(c.name));
    return {
      name: c.name,
      kind: c.kind !== 'other' ? c.kind : (j?.kind ?? 'other'),
      description: j?.description || c.description,
    };
  });
  const codeKeys = new Set(fromCode.map((c) => normalizePartName(c.name)));
  for (const j of json) {
    if (codeKeys.has(normalizePartName(j.name))) continue;
    if (dynamicParts) {
      errors.push(`parts lists "${j.name}", which the code declares by a computed name → kept from the JSON`);
      merged.push(j);
    } else {
      errors.push(`parts lists "${j.name}", which the code never declares → dropped`);
    }
  }
  return merged;
}

/**
 * Parse and validate a phase-1 answer. `sentPhotos`, when given, lists the STORED indices (recording
 * frame numbers, or photo numbers of the set) of the pictures in the order they were announced, so
 * the model's "photo N" is position N and a view's `photo` comes back as the stored index — the number
 * the record, the tracing phase and the client all speak in. A view of a position that was not sent
 * is dropped; a number that is not a position but IS a stored index is taken as that picture, with a
 * note, since a model shown "(recording frame 37)" may well answer 37. A program that fails
 * checkSceneCode makes the answer non-renderable with that reason rather than an error: the record
 * still says what the model saw. `changes` is a revision's account of what it changed (§19), cut to
 * TWIN_REVISION_CHANGES_MAX; '' when the answer has none (every first build).
 */
export function parseTwinBuildingCode(
  text: string,
  sentPhotos?: number[],
): { answer: TwinBuildingCode | null; errors: string[]; changes: string } {
  const errors: string[] = [];
  const json = extractJsonObject(text);
  if (!json) return { answer: null, errors: ['no JSON object in the answer'], changes: '' };
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { answer: null, errors: [`JSON.parse failed: ${(e as Error).message}`], changes: '' };
  }
  if (!raw || typeof raw !== 'object') return { answer: null, errors: ['the answer is not an object'], changes: '' };
  const views: TwinBuildingView[] = [];
  const rawViews: unknown[] = Array.isArray(raw.views) ? raw.views : [];
  const seen = new Set<number>();
  rawViews.forEach((v: any, i) => {
    if (!v || typeof v !== 'object' || !isNum(v.photo)) {
      errors.push(`views[${i}] invalid → dropped`);
      return;
    }
    let photo = Math.round(v.photo);
    if (sentPhotos) {
      if (photo >= 1 && photo <= sentPhotos.length) {
        photo = sentPhotos[photo - 1];
      } else if (sentPhotos.includes(photo)) {
        errors.push(`views[${i}] names photo ${photo} by its stored index, not its position → taken as that picture`);
      } else {
        errors.push(`views[${i}] names photo ${photo}, but only ${sentPhotos.length} were sent → dropped`);
        return;
      }
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
  const parts = renderable ? mergeParts(extractPartsFromCode(code), raw.parts, errors, hasDynamicPartCalls(code)) : [];
  const subjectKind = str(raw.subjectKind).toLowerCase();
  if (raw.subjectKind !== undefined && !isSubjectKind(subjectKind))
    errors.push(`subjectKind "${str(raw.subjectKind)}" unknown → other`);
  return {
    answer: {
      renderable,
      reason,
      confidence: isNum(raw.confidence) ? clamp01(raw.confidence) : 0,
      subject: str(raw.subject),
      subjectKind: isSubjectKind(subjectKind) ? subjectKind : 'other',
      name: str(raw.name, 'subject'),
      description: str(raw.description),
      parts,
      code: renderable ? code : '',
      views,
    },
    errors,
    changes: str(raw.changes).slice(0, TWIN_REVISION_CHANGES_MAX),
  };
}

/** Why the answer should not be shown as a model, or null when it should. */
export function twinBuildingBlocker(answer: TwinBuildingCode, minConfidence = 0.4): string | null {
  if (!answer.renderable) return answer.reason || 'The photos do not show one subject well enough to model it.';
  if (answer.confidence < minConfidence) return 'The model was not confident enough that this matches the photos.';
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Revision — the owner's note on a model, and the model's rewrite of its program (§19)

/** A note longer than this is not a note about a massing model; the client's box has the same cap. */
export const TWIN_REVISION_NOTE_MAX = 1000;
/** The model's account of what it changed, as the thread shows it. */
export const TWIN_REVISION_CHANGES_MAX = 600;
/** Rounds of the thread a record keeps — and a revision replays to the model as notes already applied. */
export const TWIN_REVISION_HISTORY_MAX = 8;

/** One round of the revision thread: what the owner said was wrong, what the model says it changed
 *  ('' when it said nothing), when (ms since the epoch), and which AI model the note went to (§20; absent
 *  on rounds from before the owner could choose). A fresh build starts without a thread. */
export interface TwinBuildingRevision {
  feedback: string;
  changes: string;
  at: number;
  modelKey?: string;
}

/** The phase-1 schema with the revision's `changes` added — strict-mode shaped like the original. */
export const TWIN_BUILDING_REVISION_JSON_SCHEMA = {
  ...TWIN_BUILDING_JSON_SCHEMA,
  required: [...TWIN_BUILDING_JSON_SCHEMA.required, 'changes'],
  properties: {
    ...TWIN_BUILDING_JSON_SCHEMA.properties,
    changes: {
      type: 'string',
      description:
        'One or two plain sentences to the owner: what you changed for their note, or why part of it could not be done.',
    },
  },
} as const;

/** What the owner typed, as a prompt should quote it: line endings normalised, trailing spaces and runs
 *  of blank lines folded, the ends trimmed. */
const normalizeOwnerText = (raw: string): string =>
  raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** The owner's note as the request carried it (normalizeOwnerText), or why it is refused: not text,
 *  empty, or over the cap (refused rather than cut, since a cut note can say something else than the
 *  owner meant). */
export function readRevisionNote(raw: unknown): { note: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'The note must be text.' };
  const note = normalizeOwnerText(raw);
  if (!note) return { error: 'The note is empty.' };
  if (note.length > TWIN_REVISION_NOTE_MAX)
    return { error: `The note is too long (${note.length} characters; at most ${TWIN_REVISION_NOTE_MAX}).` };
  return { note };
}

// ---------------------------------------------------------------------------------------------------
// The owner's request — what they want the model to be, given before it is built (§20)

/** A request longer than this is not about a massing model; the client's box has the same cap. */
export const TWIN_INSTRUCTIONS_MAX = 1000;

/** The owner's request as the call carried it (normalizeOwnerText) — null when there is none, which is
 *  the usual case (absent, or only whitespace) — or why it is refused: not text, or over the cap
 *  (refused rather than cut, like a note). */
export function readBuildInstructions(raw: unknown): { instructions: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { instructions: null };
  if (typeof raw !== 'string') return { error: 'The request must be text.' };
  const instructions = normalizeOwnerText(raw);
  if (instructions.length > TWIN_INSTRUCTIONS_MAX)
    return {
      error: `The request is too long (${instructions.length} characters; at most ${TWIN_INSTRUCTIONS_MAX}).`,
    };
  return { instructions: instructions || null };
}

/** The thread a stored record carries, every round checked field by field — the record is the server's
 *  own, but it goes back into a prompt — and only the newest TWIN_REVISION_HISTORY_MAX kept. */
export function readRevisions(raw: unknown): TwinBuildingRevision[] {
  if (!Array.isArray(raw)) return [];
  const out: TwinBuildingRevision[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const feedback = str(o.feedback);
    if (!feedback) continue;
    const modelKey = str(o.modelKey).slice(0, 40);
    out.push({
      feedback: feedback.slice(0, TWIN_REVISION_NOTE_MAX),
      changes: str(o.changes).slice(0, TWIN_REVISION_CHANGES_MAX),
      at: isNum(o.at) ? o.at : 0,
      ...(modelKey ? { modelKey } : {}),
    });
  }
  return out.slice(-TWIN_REVISION_HISTORY_MAX);
}

/** What a revision builds on, read off the stored record. */
export interface RevisableTwin {
  code: string;
  parts: TwinBuildingPart[];
  views: TwinBuildingView[];
  /** The pictures the model was shown, by stored index, in the order they were announced. */
  photosSent: number[];
  revisions: TwinBuildingRevision[];
  /** The owner's request the model was built to (§20), which a revision carries forward; null for none. */
  instructions: string | null;
  /** Which model wrote it — the server's key for it, and the vendor's id — so the same one revises it. */
  modelKey: string | null;
  model: string;
}

/**
 * The stored twin a revision may build on, or why it may not: a scene program of the current contract
 * that was shown (a blocked record has no model to correct, an older one no named parts — both want a
 * regeneration), built the way this request builds (a photo set's, or a walk-around's), and saying which
 * pictures it was made from — the revision shows the model the same ones, so its views still apply.
 */
export function readRevisableTwin(
  raw: unknown,
  source: 'photos' | 'orbit',
): { twin: RevisableTwin } | { error: string } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!r || r.kind !== 'building') return { error: 'There is no scene twin to revise — build one first.' };
  if (r.version !== TWIN_BUILDING_VERSION)
    return { error: 'This twin was made by an earlier analysis — regenerate it before revising it.' };
  if (typeof r.code !== 'string' || !r.code.trim() || r.blocker)
    return { error: 'This twin has no model to revise — regenerate it.' };
  if ((r.source ?? 'photos') !== source)
    return { error: 'This twin was built another way — regenerate it before revising it.' };
  const photosSent = Array.isArray(r.photosSent)
    ? [...new Set(r.photosSent.filter((k): k is number => Number.isInteger(k) && (k as number) >= 1))].slice(
        0,
        TWIN_BUILDING_MAX_PHOTOS,
      )
    : [];
  if (!photosSent.length) return { error: 'This twin does not say which pictures it was built from — regenerate it.' };
  const parts: TwinBuildingPart[] = (Array.isArray(r.parts) ? r.parts : []).flatMap((p: any) =>
    str(p?.name)
      ? [{ name: str(p.name), kind: isPartKind(p.kind) ? p.kind : 'other', description: str(p.description) }]
      : [],
  );
  const views: TwinBuildingView[] = (Array.isArray(r.views) ? r.views : []).flatMap((v: any) =>
    v && [v.photo, v.x, v.y, v.z, v.targetX, v.targetY, v.targetZ].every(isNum)
      ? [{ photo: v.photo, x: v.x, y: v.y, z: v.z, targetX: v.targetX, targetY: v.targetY, targetZ: v.targetZ }]
      : [],
  );
  return {
    twin: {
      code: r.code,
      parts,
      views,
      photosSent,
      revisions: readRevisions(r.revisions),
      instructions: str(r.instructions).slice(0, TWIN_INSTRUCTIONS_MAX) || null,
      modelKey: str(r.modelKey) || null,
      model: str(r.model),
    },
  };
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

// ---------------------------------------------------------------------------------------------------
// Phase 2 — tracing the surfaces of the parts in one thermal photo (§18.6 A4/A5)

/** The words-only account of where a photo's camera stood, from the phase-1 view (§18.6 A5). No metres:
 *  a number in the prompt gets copied into the answer; what the tracer needs is which faces it can see
 *  and on which side of the picture each lies. Derived from camera − target: the horizontal direction
 *  names the side, the elevation says whether the top is in view, and the camera's right vector
 *  (view × up) decides which visible face sits on the left half of the picture. */
export function describeViewpoint(view: TwinBuildingView | null | undefined): string {
  if (!view) {
    return 'Where this photo was taken from is not known; judge the viewpoint from the picture itself and name faces by the subject frame described above.';
  }
  const dx = view.x - view.targetX;
  const dy = view.y - view.targetY;
  const dz = view.z - view.targetZ;
  const horizontal = Math.hypot(dx, dz);
  if (horizontal < 1e-6 && Math.abs(dy) < 1e-6) return describeViewpoint(null);
  const elevation = Math.atan2(dy, horizontal); // radians above the level line
  // Within 20° of straight up or down there is no side to name: the horizontal direction is noise, and
  // every lateral face is edge-on. Said plainly, before any side word can creep in.
  if (Math.abs(elevation) > Math.PI / 2 - Math.PI / 9) {
    return dy > 0
      ? 'You judged this photo was taken from directly above the subject, looking straight down: the TOP fills the picture; the FRONT, BACK, LEFT and RIGHT are edge-on or hidden.'
      : 'You judged this photo was taken from directly below the subject, looking straight up: the BOTTOM fills the picture; the FRONT, BACK, LEFT and RIGHT are edge-on or hidden.';
  }
  const hx = dx / horizontal;
  const hz = dz / horizontal;
  // The side: the dominant axis, hyphenated with the minor one when it is not negligible.
  const major = Math.abs(hz) >= Math.abs(hx) ? (hz >= 0 ? 'front' : 'back') : hx >= 0 ? 'right' : 'left';
  const minorMag = Math.min(Math.abs(hx), Math.abs(hz));
  const minor =
    minorMag > 0.35 * Math.max(Math.abs(hx), Math.abs(hz), 1e-6)
      ? major === 'front' || major === 'back'
        ? hx >= 0
          ? 'right'
          : 'left'
        : hz >= 0
          ? 'front'
          : 'back'
      : null;
  const side = minor ? `${major}-${minor}` : major;
  // Lateral faces in view: those whose outward normal has a component toward the camera.
  const lateral: { face: 'front' | 'back' | 'left' | 'right'; toward: number; nx: number; nz: number }[] = [
    { face: 'front', toward: hz, nx: 0, nz: 1 },
    { face: 'back', toward: -hz, nx: 0, nz: -1 },
    { face: 'right', toward: hx, nx: 1, nz: 0 },
    { face: 'left', toward: -hx, nx: -1, nz: 0 },
  ];
  const visible = lateral.filter((f) => f.toward > 0.2);
  const hidden = lateral.filter((f) => f.toward <= 0.2);
  // The camera's right vector for a view direction v = −(hx, hz): right = v × up = (−vz, vx) = (hz, −hx).
  const rx = hz;
  const rz = -hx;
  const sideOf = (nx: number, nz: number) => nx * rx + nz * rz;
  let faces: string;
  if (visible.length >= 2) {
    const sorted = [...visible].sort((a, b) => sideOf(a.nx, a.nz) - sideOf(b.nx, b.nz));
    const [l, r] = [sorted[0], sorted[sorted.length - 1]];
    const facing = (f: (typeof lateral)[number]) => (f.toward > 0.8 ? 'facing you' : 'receding');
    faces = `${l.face.toUpperCase()} on the left half of the picture (${facing(l)}), ${r.face.toUpperCase()} on the right half (${facing(r)})`;
  } else if (visible.length === 1) {
    faces = `${visible[0].face.toUpperCase()} fills the picture, facing you; the neighbouring faces are edge-on or hidden`;
  } else {
    faces = 'the top or the bottom, seen almost straight on';
  }
  const level =
    elevation > Math.PI / 9
      ? 'looking down on it, so the TOP may be in view'
      : elevation < -Math.PI / 9
        ? 'looking up at it, so the TOP is out of view and an underside may show'
        : 'roughly level with it, so the TOP and BOTTOM are edge-on or out of view';
  const cannot = hidden.length
    ? ` You cannot see the ${hidden.map((f) => f.face.toUpperCase()).join(' or the ')}.`
    : '';
  return `You judged this photo was taken from the subject's ${side}, ${level}. Faces you can see: ${faces}.${cannot}`;
}

/** What the surface-tracing prompt is built from. `viewpoint` is describeViewpoint's sentence. */
export interface TwinSurfacePromptContext {
  subject: string;
  subjectKind?: TwinSubjectKind;
  parts: TwinBuildingPart[];
  code: string;
  /** The picture's number as announced in phase 1 — its position in the order sent. */
  photo: number;
  /** The picture's name as phase 1 announced it (pictureLabel), when it is more than "Photo N". */
  label?: string;
  width: number;
  height: number;
  viewpoint: string;
  /** Which picture the tracing is done on: the visible photo (with the thermal render attached as a
   *  second picture when the photo has one), or the thermal render alone when the photo has no visible
   *  picture. */
  picture?: 'vis' | 'render';
  /** For a visible picture: whether the thermal render is attached after it. The caller derives this
   *  from what it actually attaches, so the wording never promises a second picture that is missing
   *  (a set whose data_N.png could not be read). Default true. */
  withRender?: boolean;
}

/** The program is context, not the task: past this length it is cut, with a note saying so. */
export const TWIN_SURFACE_CODE_CHARS = 12_000;
/** Surfaces per photo the tracer may report; the parser drops the rest. */
export const TWIN_SURFACE_MAX_PER_PHOTO = 24;

/** System + user text for one phase-2 call. Images attached by the caller: the picture the user text
 *  names first, then (for a visible picture with `withRender`) the thermal render. */
export function buildTwinSurfacePrompt(ctx: TwinSurfacePromptContext): { system: string; user: string } {
  const picture = ctx.picture ?? 'vis';
  const withRender = picture === 'vis' && ctx.withRender !== false;
  const faces = TWIN_FACES.map((f) => `'${f}'`).join(', ');
  const facings = TWIN_FACINGS.map((f) => `'${f}'`).join(', ');
  const system = `You outline the surfaces of a 3D model's parts in a photograph so their temperatures can be read from a thermal camera's pixels. You are given ONE picture of the subject (${
    picture === 'vis'
      ? withRender
        ? 'a visible-light photo, followed by the thermal camera’s false-colour render of the same view'
        : 'a visible-light photo'
      : 'the thermal camera’s false-colour render'
  }), the list of the model's parts, the program that built the model (so you know each part's shape and where it sits), and where the camera stood.

The subject frame: FRONT is the face toward +z, RIGHT toward +x, TOP toward +y, as the program's coordinates say. Faces are named in THAT frame, not the camera's — a face on the right of the picture may be the subject's LEFT if the photo was taken from behind. The viewpoint sentence tells you which faces can be in view and on which side of the picture each lies; trust it over your first impression.

For every visible surface of a part, give ONE quadrilateral: the largest four-sided region lying SAFELY INSIDE that one surface — a hand's width inside its edges. Leave out sky, ground, other faces, and anything in front (trees, cars, people, cables, a hand); if an obstruction sits in the middle, give the larger clear side only. Skip a surface narrower than 1/20 of the picture, a surface less than half visible, and reflections in glass. A cylinder, a tree or any body without distinct faces is 'all', or 'upper' / 'middle' / 'lower' when its height bands plausibly differ in temperature. Never guess a surface you cannot see.

Coordinates are PIXELS in the ${ctx.width}×${ctx.height} picture: x to the right, y down, the top-left corner is (0, 0). quad is 8 numbers — the corners in this order: top-left, top-right, bottom-right, bottom-left.${
    withRender
      ? ' The thermal render is attached only so you can see where one surface ends and the next begins — a temperature boundary the visible photo may hide. NEVER read temperatures from its colours, and never place a corner by it alone: coordinates are those of the visible photo.'
      : ''
  }

Answer with JSON only: { "surfaces": [ { "part": <a part name from the list, exactly>, "face": one of ${faces}, "facing": one of ${facings} (which way the surface faces relative to the camera: 'toward' you, to the camera's left or right, up or down), "quad": [x0, y0, x1, y1, x2, y2, x3, y3], "note": a few words or "" } ] }. At most ${TWIN_SURFACE_MAX_PER_PHOTO} surfaces; an empty list when nothing of the subject is in view.`;
  const parts = ctx.parts.length
    ? ctx.parts.map((p) => `- ${p.name} — ${p.kind}${p.description ? ` — ${p.description}` : ''}`).join('\n')
    : '- (the program declares no named parts)';
  const code =
    ctx.code.length > TWIN_SURFACE_CODE_CHARS
      ? `${ctx.code.slice(0, TWIN_SURFACE_CODE_CHARS)}\n// … cut here: the rest of the program is omitted for length.`
      : ctx.code;
  const user = `Subject: ${ctx.subject || 'not named'}${ctx.subjectKind ? ` (${ctx.subjectKind})` : ''}.

Parts (name — kind — description):
${parts}

${ctx.label ?? `Photo ${ctx.photo}`}, ${ctx.width}×${ctx.height} px${
    picture === 'vis'
      ? withRender
        ? ' (the first picture); its thermal render is the second picture'
        : ' (the only picture)'
      : ' (the thermal render is the picture)'
  }.
Viewpoint: ${ctx.viewpoint}

The program that built the model:
\`\`\`javascript
${code}
\`\`\`

Outline the surfaces, as JSON.`;
  return { system, user };
}

/** Strict-mode schema for the phase-2 answer (every property required, no additionalProperties). */
export const TWIN_SURFACE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['surfaces'],
  properties: {
    surfaces: {
      type: 'array',
      description: 'One entry per visible surface of a part, at most 24.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['part', 'face', 'facing', 'quad', 'note'],
        properties: {
          part: { type: 'string', description: 'A part name from the list, exactly as given.' },
          face: { type: 'string', enum: [...TWIN_FACES], description: 'The face in the subject frame.' },
          facing: {
            type: 'string',
            enum: [...TWIN_FACINGS],
            description: 'Which way the surface faces relative to the camera.',
          },
          quad: {
            type: 'array',
            items: { type: 'number' },
            description: '8 pixel coordinates: top-left, top-right, bottom-right, bottom-left (x, y each).',
          },
          note: { type: 'string', description: 'A few words, or an empty string.' },
        },
      },
    },
  },
} as const;

/** One surface the tracer outlined, resolved to a canonical part and fractions of the picture. */
export interface TwinSurfaceTrace {
  part: string; // canonical parts[].name
  kind: TwinPartKind;
  face: TwinFace;
  facing?: TwinFacing;
  quad: number[]; // 8 fractions of the picture, TL, TR, BR, BL
  note?: string;
}

const FACE_SYNONYMS: Record<string, TwinFace> = {
  front: 'front',
  back: 'back',
  rear: 'back',
  left: 'left',
  right: 'right',
  top: 'top',
  roof: 'top',
  bottom: 'bottom',
  floor: 'bottom',
  ground: 'bottom',
  underside: 'bottom',
  all: 'all',
  whole: 'all',
  body: 'all',
  upper: 'upper',
  middle: 'middle',
  lower: 'lower',
};

/** A quad in any of the shapes a model answers with, as 8 flat numbers, or null. */
function readQuad(v: unknown): number[] | null {
  const nums = (arr: unknown[]): number[] | null => (arr.every(isNum) ? (arr as number[]) : null);
  if (Array.isArray(v)) {
    if (v.length === 8) return nums(v);
    if (v.length === 4) {
      if (v.every(Array.isArray)) {
        const pts = v.map((p: unknown[]) => (p.length >= 2 && isNum(p[0]) && isNum(p[1]) ? [p[0], p[1]] : null));
        return pts.every(Boolean) ? (pts as number[][]).flat() : null;
      }
      if (v.every((p) => p && typeof p === 'object')) {
        const pts = v.map((p: any) => (isNum(p.x) && isNum(p.y) ? [p.x, p.y] : null));
        return pts.every(Boolean) ? (pts as number[][]).flat() : null;
      }
      // Four numbers can only be a box: left, top, right, bottom.
      const b = nums(v);
      return b ? [b[0], b[1], b[2], b[1], b[2], b[3], b[0], b[3]] : null;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = ['x0', 'y0', 'x1', 'y1', 'x2', 'y2', 'x3', 'y3'];
    if (keys.every((k) => isNum(o[k]))) return keys.map((k) => o[k] as number);
    if (isNum(o.x) && isNum(o.y) && isNum(o.w) && isNum(o.h)) {
      const [x, y, w, h] = [o.x, o.y, o.w, o.h];
      return [x, y, x + w, y, x + w, y + h, x, y + h];
    }
    if (isNum(o.x) && isNum(o.y) && isNum(o.width) && isNum(o.height)) {
      const [x, y, w, h] = [o.x, o.y, o.width, o.height];
      return [x, y, x + w, y, x + w, y + h, x, y + h];
    }
    if (isNum(o.left) && isNum(o.top) && isNum(o.right) && isNum(o.bottom)) {
      const [l, t, r, b] = [o.left, o.top, o.right, o.bottom];
      return [l, t, r, t, r, b, l, b];
    }
  }
  return null;
}

/** A quad's bounding box may run past the picture by this fraction before it is dropped (not clamped:
 *  a corner well outside means the tracer was not looking at this picture's pixels). */
export const SURFACE_OVERSHOOT = 0.05;

/**
 * Parse a phase-2 answer into surfaces of known parts with quads as fractions of the picture. Tolerant
 * of the shapes a provider without schema enforcement produces (a bare array; `regions` / `faces` /
 * `quads` for the list; `partName` / `name` / `mesh` for the part; `side` for the face, with roof/floor/
 * whole synonyms; a quad as 8 numbers, 4 pairs, 4 points, x0…y3 or a box). Pixels become fractions by
 * the picture size unless all eight numbers are already ≤ 1 + SURFACE_OVERSHOOT — the same slack the
 * bounding-box rule allows, so a fraction answer with one corner at 1.01 is not misread as a sub-pixel
 * quad of pixels (a pixel quad inside 1.05 px would mean nothing anyway). Dropped, with a reason in
 * `errors`: a part not in the list, a face that is not one, fewer than four points, a quad running past
 * the picture by more than SURFACE_OVERSHOOT; and everything past TWIN_SURFACE_MAX_PER_PHOTO.
 */
export function parseTwinSurfaces(
  text: string,
  parts: TwinBuildingPart[],
  width: number,
  height: number,
): { surfaces: TwinSurfaceTrace[]; errors: string[] } {
  const errors: string[] = [];
  const json = extractJsonValue(text);
  if (!json) return { surfaces: [], errors: ['no JSON in the answer'] };
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { surfaces: [], errors: [`JSON.parse failed: ${(e as Error).message}`] };
  }
  let list: unknown[] | null = null;
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    for (const key of ['surfaces', 'regions', 'faces', 'quads']) {
      if (Array.isArray(raw[key])) {
        list = raw[key];
        break;
      }
    }
  }
  if (!list) return { surfaces: [], errors: ['the answer holds no surface list'] };
  const byKey = new Map(parts.map((p) => [normalizePartName(p.name), p]));
  const surfaces: TwinSurfaceTrace[] = [];
  list.forEach((item: any, i) => {
    if (surfaces.length >= TWIN_SURFACE_MAX_PER_PHOTO) return;
    if (!item || typeof item !== 'object') {
      errors.push(`surfaces[${i}] is not an object → dropped`);
      return;
    }
    const partName = str(item.part) || str(item.partName) || str(item.name) || str(item.mesh);
    const part = byKey.get(normalizePartName(partName));
    if (!part) {
      errors.push(`surfaces[${i}] names part "${partName}", which the model has not → dropped`);
      return;
    }
    const faceWord = (str(item.face) || str(item.side)).toLowerCase();
    const face = FACE_SYNONYMS[faceWord];
    if (!face) {
      errors.push(`surfaces[${i}] face "${faceWord}" unknown → dropped`);
      return;
    }
    const facingWord = str(item.facing);
    const facing = (TWIN_FACINGS as readonly string[]).includes(facingWord) ? (facingWord as TwinFacing) : undefined;
    const q = readQuad(
      item.quad ?? item.corners ?? item.points ?? item.polygon ?? item.box ?? item.bbox ?? item.rect ?? item.region,
    );
    if (!q) {
      errors.push(`surfaces[${i}] has no four-cornered quad → dropped`);
      return;
    }
    const fractions = q.every((v) => v <= 1 + SURFACE_OVERSHOOT);
    const frac = q.map((v, k) => (fractions ? v : v / (k % 2 === 0 ? width : height)));
    const xs = frac.filter((_, k) => k % 2 === 0);
    const ys = frac.filter((_, k) => k % 2 === 1);
    const lo = Math.min(...xs, ...ys);
    const hi = Math.max(...xs, ...ys);
    if (lo < -SURFACE_OVERSHOOT || hi > 1 + SURFACE_OVERSHOOT) {
      errors.push(`surfaces[${i}] runs past the picture → dropped`);
      return;
    }
    const note = str(item.note).slice(0, 200);
    surfaces.push({
      part: part.name,
      kind: part.kind,
      face,
      ...(facing ? { facing } : {}),
      quad: frac.map((v) => clamp01(v)),
      ...(note ? { note } : {}),
    });
  });
  if (list.length > TWIN_SURFACE_MAX_PER_PHOTO)
    errors.push(
      `${list.length - TWIN_SURFACE_MAX_PER_PHOTO} surfaces past the cap of ${TWIN_SURFACE_MAX_PER_PHOTO} → dropped`,
    );
  return { surfaces, errors };
}

// ---------------------------------------------------------------------------------------------------
// Statistics of the thermal pixels inside a traced surface (§18.6 C1)

/** The registration as surfaceStats needs it: the visible-frame → thermal-frame shift in thermal px
 *  and how well it was measured (twinRegistration.Registration fits; method is free text here). */
export interface SurfaceRegistration {
  dx: number;
  dy: number;
  score?: number;
  method?: string;
}

/** Below this many pixels a surface says nothing; up to SURFACE_FULL_SAMPLE_MIN it is a small sample. */
export const SURFACE_MIN_SAMPLE = 24;
export const SURFACE_FULL_SAMPLE_MIN = 64;
/** More than this share of the polygon's pixels invalid (sky, sentinel) and the surface is dropped: the
 *  tracer most likely outlined sky or a truncated part of the frame. */
export const SURFACE_MAX_EXCLUDED_SHARE = 0.3;
/** Readings below this are outside the FLIR One's range — sky, or nothing — and never a surface. */
export const SURFACE_MIN_VALID_C = -20;
/** The truncated-frame sentinel (a zero record reads −273.15 °C). */
export const SURFACE_SENTINEL_C = -100;

/** How far (thermal px) the traced quad is shrunk before its pixels are read: a well-measured
 *  registration leaves the tracer's own slack; a doubtful one, or none, needs more margin so a beaker's
 *  edge does not read the bench behind it. */
export function erosionFor(registration: SurfaceRegistration | null | undefined): number {
  if (!registration) return 5;
  if (registration.method === 'vis-mix') return 3;
  if (registration.score !== undefined && registration.score >= 0.3) return 2;
  return 3;
}

export interface SurfaceStats {
  n: number;
  median: number;
  p10: number;
  p90: number;
  min: number;
  max: number;
  excluded: number; // pixels inside the polygon that were not a valid temperature
  erodePx: number;
}

/** Why a traced surface yielded no statistics: a quad that is not four finite points; no pixel centre
 *  inside the eroded polygon at all; more than SURFACE_MAX_EXCLUDED_SHARE of its pixels invalid (sky, the
 *  sentinel); or fewer than SURFACE_MIN_SAMPLE valid pixels left. Logged by the caller so a surface the
 *  tracer drew and the statistics threw away does not vanish silently. */
export type SurfaceUnreadReason = 'bad-quad' | 'no-pixels' | 'excluded' | 'too-few';

/**
 * Read the thermal pixels inside a traced quad. `quad` is 8 fractions of the picture (TL, TR, BR, BL
 * nominally — the corners are re-sorted by angle about their centroid so a bow-tie still reads as a
 * quadrilateral), `temps` the 120×160 frame in °C (row-major), `registration` the visible→thermal
 * shift (a visible feature at (u, v) lies at (u + dx, v + dy) in the thermal frame; null when none).
 * A pixel (centre (i + 0.5, j + 0.5)) counts when it lies inside the polygon and at least `erodePx`
 * from every edge. No statistics, with the reason, when too much of the polygon is invalid (sky), or
 * fewer than SURFACE_MIN_SAMPLE pixels remain — the caller marks 24 ≤ n < 64 as a small sample.
 */
export function readSurfaceStats(
  quad: ArrayLike<number>,
  temps: ArrayLike<number>,
  registration: SurfaceRegistration | null | undefined,
  erodePx = erosionFor(registration),
): { stats: SurfaceStats; reason: null } | { stats: null; reason: SurfaceUnreadReason } {
  if (quad.length < 8) return { stats: null, reason: 'bad-quad' };
  const dx = registration?.dx ?? 0;
  const dy = registration?.dy ?? 0;
  const pts: { x: number; y: number }[] = [];
  for (let k = 0; k < 4; k++) {
    const x = quad[2 * k] * IR_GRID_WIDTH + dx;
    const y = quad[2 * k + 1] * IR_GRID_HEIGHT + dy;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { stats: null, reason: 'bad-quad' };
    pts.push({ x, y });
  }
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

  const inside = (x: number, y: number) => {
    // Even–odd rule over the four edges.
    let hit = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  };
  const edgeDistance = (x: number, y: number) => {
    let best = Infinity;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const a = pts[i];
      const b = pts[j];
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const len2 = ex * ex + ey * ey;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * ex + (y - a.y) * ey) / len2)) : 0;
      best = Math.min(best, Math.hypot(x - (a.x + t * ex), y - (a.y + t * ey)));
    }
    return best;
  };

  const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x))));
  const x1 = Math.min(IR_GRID_WIDTH - 1, Math.ceil(Math.max(...pts.map((p) => p.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))));
  const y1 = Math.min(IR_GRID_HEIGHT - 1, Math.ceil(Math.max(...pts.map((p) => p.y))));
  const values: number[] = [];
  let excluded = 0;
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      const px = i + 0.5;
      const py = j + 0.5;
      if (!inside(px, py) || edgeDistance(px, py) < erodePx) continue;
      const c = temps[j * IR_GRID_WIDTH + i];
      if (!Number.isFinite(c) || c <= SURFACE_SENTINEL_C || c < SURFACE_MIN_VALID_C) {
        excluded++;
        continue;
      }
      values.push(c);
    }
  }
  const total = values.length + excluded;
  if (!total) return { stats: null, reason: 'no-pixels' };
  if (excluded / total > SURFACE_MAX_EXCLUDED_SHARE) return { stats: null, reason: 'excluded' };
  if (values.length < SURFACE_MIN_SAMPLE) return { stats: null, reason: 'too-few' };
  values.sort((a, b) => a - b);
  const n = values.length;
  const at = (q: number) => values[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
  return {
    stats: {
      n,
      median: at(0.5),
      p10: at(0.1),
      p90: at(0.9),
      min: values[0],
      max: values[n - 1],
      excluded,
      erodePx,
    },
    reason: null,
  };
}

/** readSurfaceStats without the reason: the statistics, or null. */
export function surfaceStats(
  quad: ArrayLike<number>,
  temps: ArrayLike<number>,
  registration: SurfaceRegistration | null | undefined,
  erodePx = erosionFor(registration),
): SurfaceStats | null {
  return readSurfaceStats(quad, temps, registration, erodePx).stats;
}

/** The scene's own spread and the robust bounds of one frame: p02/p98 of its valid pixels (sentinel and
 *  below-range readings left out), or null when the frame has none. */
export function framePercentiles(temps: ArrayLike<number>): { p02: number; p98: number } | null {
  const valid: number[] = [];
  for (let i = 0; i < temps.length; i++) {
    const c = temps[i];
    if (Number.isFinite(c) && c > SURFACE_SENTINEL_C && c >= SURFACE_MIN_VALID_C) valid.push(c);
  }
  if (!valid.length) return null;
  valid.sort((a, b) => a - b);
  const at = (q: number) => valid[Math.min(valid.length - 1, Math.max(0, Math.round(q * (valid.length - 1))))];
  return { p02: at(0.02), p98: at(0.98) };
}

/** Whether one surface's spread says it is not one temperature (§18.6 C3): its p10–p90 band is wider
 *  than 3 K and than a quarter of the scene's span — the range of the surface medians, see sceneSpanOf. */
export function isMixedSurface(p10: number, p90: number, sceneSpan: number): boolean {
  return p90 - p10 > Math.max(3, 0.25 * sceneSpan);
}

/**
 * The scene's span for the `mixed` threshold: the range of the medians of the surfaces whose reading is
 * the surface's own temperature — an APPARENT reading (a window reflecting a clear sky at −12 °C, a
 * steel body showing the room) is not part of the scene's real spread and would widen the threshold
 * until a genuinely two-temperature wall passed as uniform. Falls back to every median when no surface
 * is a real one, and to 0 when there are none at all.
 */
export function sceneSpanOf(surfaces: { median: number; apparent?: boolean }[]): number {
  const real = surfaces.filter((s) => !s.apparent).map((s) => s.median);
  const base = real.length ? real : surfaces.map((s) => s.median);
  return base.length ? Math.max(...base) - Math.min(...base) : 0;
}

/** The default colour scale for the measured view (§18.6 C4): the medians' range rounded outward by one
 *  degree, widened symmetrically to at least 4 K so a uniform scene does not become a two-colour map. */
export function surfaceRange(medians: number[]): [number, number] {
  if (!medians.length) return [0, 40];
  let lo = Math.floor(Math.min(...medians)) - 1;
  let hi = Math.ceil(Math.max(...medians)) + 1;
  if (hi - lo < 4) {
    const pad = (4 - (hi - lo)) / 2;
    lo -= pad;
    hi += pad;
  }
  return [lo, hi];
}
