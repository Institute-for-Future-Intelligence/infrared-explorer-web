/**
 * Twin-scene analysis contract — the structured "what is in this frame" answer a vision model gives for
 * the digital twin (docs/digital-twin-plan.md §5). Shared by the model bake-off
 * (scripts/evalTwinScene.ts) and, later, the analyzeTwinScene callable, so the prompt, the JSON schema
 * and the parser exist exactly once.
 *
 * Dependency-free on purpose (types, constants, pure functions): tsx runs it straight from the scripts
 * directory and the functions build compiles it, like analysis.ts. Its one import, twinBuilding.ts, is the
 * same kind of module — the revision thread (§19, §24) is one contract for both kinds of twin.
 */
import {
  TWIN_INSTRUCTIONS_MAX,
  TWIN_REVISION_CHANGES_MAX,
  describeJsonSchema,
  readRevisions,
  type TwinBuildingRevision,
} from './twinBuilding';

// Kept importable from here, where it was first written for the fixed-camera prompt.
export { describeJsonSchema };

export const TWIN_SCENE_VERSION = 2; // 2: restingOn may be "held"; tiltDeg + heldOver per object

/** Object classes the twin can instantiate. `other` is the catch-all the renderer draws as a box sized
 *  from the model's estimate; everything else maps to a parametric prop (plan §7). The people/hand/phone
 *  classes exist so the model has somewhere to put them instead of forcing them into lab glassware. */
export const TWIN_OBJECT_KINDS = [
  'beaker',
  'erlenmeyer_flask',
  'test_tube',
  'test_tube_rack',
  'graduated_cylinder',
  'bottle',
  'cup',
  'kettle',
  'pot',
  'petri_dish',
  'alcohol_lamp',
  'bunsen_burner',
  'candle',
  'hot_plate',
  'tripod',
  'wire_gauze',
  'ring_stand',
  'clamp',
  'thermometer',
  'metal_block',
  'ice',
  'hand',
  'person',
  'phone',
  'laptop',
  'screen',
  'other',
] as const;
export type TwinObjectKind = (typeof TWIN_OBJECT_KINDS)[number];

/** Kinds kept in the list but never drawn in 3D: people and devices, not apparatus (NON_RENDERED_KINDS in
 *  src/utils/twinSolver.ts). */
export const TWIN_UNDRAWN_KINDS: ReadonlySet<TwinObjectKind> = new Set(['hand', 'person', 'phone', 'laptop', 'screen']);

export const TWIN_CAMERA_PITCH = ['level', 'slightly_above', 'high_angle', 'top_down'] as const;
export const TWIN_DISTANCE_HINT = ['close', 'medium', 'far'] as const;
export const TWIN_SUPPORT_KINDS = ['table', 'bench', 'floor', 'unknown'] as const;
export const TWIN_MATERIALS = [
  'glass',
  'metal',
  'plastic',
  'ceramic',
  'wood',
  'paper',
  'liquid',
  'organic',
  'other',
] as const;
export const TWIN_THERMAL_ROLES = ['heat_source', 'heated', 'cooled', 'ambient'] as const;

export interface TwinBBox {
  x: number; // left edge, fraction of image width (0..1)
  y: number; // top edge, fraction of image height (0..1)
  w: number;
  h: number;
}

export interface TwinObject {
  id: string;
  kind: TwinObjectKind;
  label: string;
  confidence: number; // 0..1
  bbox: TwinBBox;
  footprintY: number; // fraction of image height where the object meets what it rests on
  sizeCm: { height: number; width: number };
  material: (typeof TWIN_MATERIALS)[number];
  fill: { level: number; content: string }; // level 0..1; 0 for a solid / empty object
  restingOn: string; // another object's id, 'support', or 'held' (in the air — a hand, a pour)
  tiltDeg: number; // lean from upright as seen in the image, −90..90; positive = the top leans right
  heldOver: string; // for a held object, the id of what it is held over / pouring into; '' if none
  thermal: { role: (typeof TWIN_THERMAL_ROLES)[number]; note: string };
}

export interface TwinScene {
  renderable: boolean;
  reason: string;
  confidence: number;
  camera: { pitch: (typeof TWIN_CAMERA_PITCH)[number]; distanceHint: (typeof TWIN_DISTANCE_HINT)[number] };
  support: { kind: (typeof TWIN_SUPPORT_KINDS)[number]; farEdgeY: number };
  objects: TwinObject[];
}

/**
 * JSON schema for the OpenAI-compatible `response_format: { type: 'json_schema' }`. Written for strict
 * mode: every property is required, no additionalProperties, and no numeric range keywords (strict mode
 * rejects them on some endpoints) — ranges are stated in the descriptions and enforced by parseTwinScene.
 */
export const TWIN_SCENE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['renderable', 'reason', 'confidence', 'camera', 'support', 'objects'],
  properties: {
    renderable: {
      type: 'boolean',
      description:
        'true only when the photo shows a physical setup of real objects standing on a surface, sharp enough to identify. false for a screen, a photo of a screen or a printout, an empty room, heavy blur, or nothing recognisable.',
    },
    reason: { type: 'string', description: 'One sentence: why renderable is false, or empty string when true.' },
    confidence: { type: 'number', description: 'Overall confidence in this analysis, 0..1.' },
    camera: {
      type: 'object',
      additionalProperties: false,
      required: ['pitch', 'distanceHint'],
      properties: {
        pitch: {
          type: 'string',
          enum: [...TWIN_CAMERA_PITCH],
          description:
            'level = camera roughly at object height; slightly_above ≈ 10–25° down; high_angle ≈ 25–60° down; top_down ≈ straight down.',
        },
        distanceHint: {
          type: 'string',
          enum: [...TWIN_DISTANCE_HINT],
          description: 'close < 0.5 m to the main objects; medium 0.5–1.5 m; far > 1.5 m.',
        },
      },
    },
    support: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'farEdgeY'],
      properties: {
        kind: { type: 'string', enum: [...TWIN_SUPPORT_KINDS], description: 'The surface the setup stands on.' },
        farEdgeY: {
          type: 'number',
          description:
            'Vertical position (0..1, fraction of image height, 0 = top) of the far edge of the support surface where it meets the background, or -1 if not visible.',
        },
      },
    },
    objects: {
      type: 'array',
      description:
        'Every physical object of note, largest and most central first. Ignore drawn overlays, text or markers.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'kind',
          'label',
          'confidence',
          'bbox',
          'footprintY',
          'sizeCm',
          'material',
          'fill',
          'restingOn',
          'tiltDeg',
          'heldOver',
          'thermal',
        ],
        properties: {
          id: { type: 'string', description: 'Short unique id such as "obj1".' },
          kind: { type: 'string', enum: [...TWIN_OBJECT_KINDS] },
          label: { type: 'string', description: 'Free-text description, e.g. "250 mL glass beaker with water".' },
          confidence: { type: 'number', description: '0..1 confidence in the kind.' },
          bbox: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y', 'w', 'h'],
            properties: {
              x: { type: 'number', description: 'Left edge as a fraction of image width, 0..1.' },
              y: { type: 'number', description: 'Top edge as a fraction of image height, 0..1.' },
              w: { type: 'number', description: 'Width as a fraction of image width.' },
              h: { type: 'number', description: 'Height as a fraction of image height.' },
            },
          },
          footprintY: {
            type: 'number',
            description:
              'Fraction of image height (0..1) where the object touches whatever it rests on; usually the bottom of the bbox.',
          },
          sizeCm: {
            type: 'object',
            additionalProperties: false,
            required: ['height', 'width'],
            properties: {
              height: { type: 'number', description: 'Estimated real height in centimetres.' },
              width: { type: 'number', description: 'Estimated real width / diameter in centimetres.' },
            },
          },
          material: { type: 'string', enum: [...TWIN_MATERIALS] },
          fill: {
            type: 'object',
            additionalProperties: false,
            required: ['level', 'content'],
            properties: {
              level: { type: 'number', description: 'Liquid fill fraction 0..1 for a container; 0 otherwise.' },
              content: { type: 'string', description: 'What it contains, e.g. "water", or empty string.' },
            },
          },
          restingOn: {
            type: 'string',
            description:
              'The id of the object this one stands on; "support" for the table/floor; or "held" when it is in the air — held in a hand, being poured from, dipped into something — and rests on nothing.',
          },
          tiltDeg: {
            type: 'number',
            description:
              'How far the object leans from upright as seen in the image, in degrees: 0 standing upright, 90 lying on its side. Positive when its top leans toward the RIGHT of the image, negative toward the left. A kettle tipped to pour is typically 30–60.',
          },
          heldOver: {
            type: 'string',
            description:
              'For a held object: the id of the object it is held over, pouring into, or dipped into. Empty string otherwise.',
          },
          thermal: {
            type: 'object',
            additionalProperties: false,
            required: ['role', 'note'],
            properties: {
              role: { type: 'string', enum: [...TWIN_THERMAL_ROLES] },
              note: { type: 'string', description: 'What the thermal image shows for this object, one short clause.' },
            },
          },
        },
      },
    },
  },
} as const;

export interface TwinFrameStats {
  minC: number;
  maxC: number;
  meanC: number;
}

export interface TwinPromptContext {
  frameStats: TwinFrameStats | null;
  palette: string | null;
  /** Optional owner-authored context. Off by default in the bake-off so recognition is judged on pixels. */
  title?: string;
  description?: string;
  /** What the owner asked of the analysis before it ran (plan §20): what the things are, what to leave
   *  out — context for naming and placing what the photo shows, never a licence to report what it does not. */
  instructions?: string;
  /** Whether the thermal render is attached as a second image. */
  withThermal: boolean;
  /** Whether the prompt spells the answer's shape out itself (describeJsonSchema): for an endpoint that
   *  takes no response schema — DeepSeek's json_object mode promises valid JSON and nothing about its
   *  fields. Off, the prompt leaves the fields to the schema sent with the request. */
  shapeInPrompt?: boolean;
  /** Present when the call REVISES the analysis the owner has looked at in 3D (§24) instead of making one. */
  revision?: TwinSceneRevisionInput;
}

const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '?');

/** System + user text for the analysis call. The images are attached by the caller (visible first, then
 *  the thermal render), so the text refers to them by order. With `ctx.revision` the same call revises the
 *  analysis as it stands (§24): the rules are the ones it was made under, plus how to revise and how the 3D
 *  scene is built from the answer, and the user text carries the analysis with the owner's corrections
 *  applied, the notes already applied and the owner's new note. */
export function buildTwinScenePrompt(ctx: TwinPromptContext): { system: string; user: string } {
  const revision = ctx.revision ?? null;
  const system = `You are a careful computer-vision annotator for a school thermal-imaging lab. Your output is used to rebuild the photographed setup as a simple 3D scene, so precision about WHAT each object is, WHERE it is in the image, and WHAT it rests on matters more than prose.

Rules:
- Answer ONLY with a JSON object ${ctx.shapeInPrompt ? 'of exactly the shape given after these rules' : 'matching the schema you were given'}. No markdown, no commentary.
- Coordinates are fractions of the image size: x rightwards 0..1, y downwards 0..1, origin at the top-left corner. A bbox is {x, y, w, h}; it must fit inside the image.
- Report physical objects only. Never report drawn overlays, markers, text labels or UI elements.
- If the photo is of a screen, monitor, printout or reflection rather than real objects, or shows no recognisable setup on a surface, set renderable=false and say why in reason. Still list what you can see.
- Prefer the specific lab-glassware kinds when they fit; use bottle/cup/kettle/pot for household containers; use other only when nothing fits.
- restingOn: the id of the object directly beneath (e.g. a beaker on wire_gauze on a tripod → beaker.restingOn = the gauze's id), "support" for the table/floor, or "held" when the object is in the air and rests on nothing — held in a hand, tipped to pour, a thermometer dipped into a beaker. Never say "support" for something that is clearly off the surface: the 3D rebuild would stand it on the table far behind everything else.
- For a held object also fill heldOver (the id of what it is over / pouring into / dipped into, or "") and tiltDeg (its lean from upright as seen in the image; positive = top leans right). Standing objects have tiltDeg 0 and heldOver "".
- sizeCm is your honest estimate of the real size; typical lab glassware sizes are known to you.
- The thermal image, when given, is pixel-aligned with the photo: use it to judge thermal.role and fill level (a liquid level often shows as a temperature step), not to invent objects the photo does not show.${
    revision
      ? `

REVISING. This photo has already been analysed — the analysis is in the message, perhaps by another annotator — and a 3D scene was built from it. The owner, who set the scene up, has looked at that 3D scene and says what is wrong with it. Work out which fields of the analysis cause what the note describes (the list below says how the 3D scene reads them), check them against the photo, fix them, and change whatever has to change with them (the restingOn or heldOver of an object that named one you removed, say). Keep everything the note does not mention as it is: the same objects under the same ids, with the same kinds, boxes, sizes and relations — a revision that quietly analyses the photo again from scratch loses what was already right. On what an object is, what it stands on or is held over, and what to leave out, the owner's word beats your reading of the photo (they were there); the photo still sets every box the note does not mention. The owner's corrections listed in the message are already applied to the analysis there. Keep them, unless the note is about what one of them did — the size, the shape or the place it gave an object — or one plainly contradicts the photo where the note points; then change it as the note needs, and say so. Notes listed as already applied were fixed in earlier rounds: keep them fixed.${ctx.instructions?.trim() ? ' The request the analysis was first made to still stands.' : ''} When nothing in the analysis can make the 3D scene do what the note asks, do the nearest thing, or change nothing for it, and say so. Answer with the WHOLE JSON again — every object, not only the ones you changed — and add "changes": one or two plain sentences to the owner saying what you changed and what that does in the 3D scene, or why part of the note could not be done. Never claim a change the 3D scene will not show.

How the 3D scene is built from the analysis:
- Each object becomes a simple 3D shape of its kind: "other" is a plain box, and ${[...TWIN_UNDRAWN_KINDS].join(', ')} stay in the list but are never drawn.
- An object's size comes from its KIND wherever the kind has a catalogue size: ${Object.entries(TWIN_CATALOGUE_SIZES)
          .map(([kind, size]) => `${kind} ${size}`)
          .join(
            '; ',
          )}. For these kinds sizeCm changes nothing, except which capacity a beaker, flask or cylinder gets. Every other kind (${TWIN_OBJECT_KINDS.filter((k) => !(k in TWIN_CATALOGUE_SIZES) && !TWIN_UNDRAWN_KINDS.has(k)).join(', ')}) is as big as its sizeCm. So an object the wrong size in 3D usually has the wrong kind.
- How far from the camera an object stands follows from that size and the height of its bbox (the width, for a petri dish, a wire gauze or a clamp): a box that is small for the object's size puts it far back. Its left–right place is the centre of its bbox, and footprintY is where it meets what it stands on.
- restingOn "support" stands it on the table; another object's id stands it on that object's top; "held" hangs it in the air — over the object heldOver names, if any, with its spout, rim or bulb just above that object's mouth, leaning by tiltDeg toward it.`
      : ''
  }${
    ctx.shapeInPrompt
      ? `

The shape of the JSON object. Every field is required, in every object; add no other field; where values are listed, use one of them exactly; keep to the ranges described:
${describeJsonSchema(revision ? TWIN_SCENE_REVISION_JSON_SCHEMA : TWIN_SCENE_JSON_SCHEMA)}`
      : ''
  }`;

  const lines: string[] = [];
  lines.push(
    ctx.withThermal
      ? 'Image 1 is a visible-light photo (portrait). Image 2 is the thermal false-colour render of the same instant, pixel-aligned with image 1.'
      : 'The image is a visible-light photo (portrait).',
  );
  if (ctx.frameStats) {
    lines.push(
      `Thermal frame statistics: min ${fmt(ctx.frameStats.minC)} °C, max ${fmt(ctx.frameStats.maxC)} °C, mean ${fmt(ctx.frameStats.meanC)} °C${ctx.palette ? `; palette "${ctx.palette}" (hotter = brighter/warmer colours)` : ''}.`,
    );
  }
  if (ctx.title) lines.push(`The experiment is titled "${ctx.title}".`);
  if (ctx.description) lines.push(`Owner's description: ${ctx.description.slice(0, 600)}`);
  const instructions = ctx.instructions?.trim();
  if (instructions) {
    // Quoted, so the owner's words cannot pass for the prompt's own; and bounded, since the owner set the
    // scene up but the photo is still the only evidence of what is in it.
    lines.push(
      `The owner, who set this scene up, asked this of the analysis:\n"""\n${instructions}\n"""\nFollow it where the photo allows: use it to name the objects, judge their thermal role and decide what to leave out. Never report an object the photo does not show because the request mentions it, and keep to the rules and the JSON schema above.`,
    );
  }
  if (revision) lines.push(describeSceneRevision(revision));
  lines.push(
    revision
      ? 'Revise the analysis: fix what the note says, keep the rest, and answer with the whole JSON again, changes included.'
      : 'Analyse the scene and return the JSON.',
  );
  return { system, user: lines.join('\n') };
}

/** Numbers as a prompt shows them: three decimals are more than a box or a size needs. */
const roundForPrompt = (_key: string, v: unknown) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);

/** The revision half of the user text: the analysis as the owner sees it, their corrections in words and how
 *  the tilt is set, then the notes already applied and the owner's new one. */
function describeSceneRevision(revision: TwinSceneRevisionInput): string {
  // Worded for whichever model revises: the owner may send a note to another model than the one that made
  // the analysis (§20).
  const history = revision.history.map(
    (r, i) => `${i + 1}. "${r.feedback}"${r.changes ? ` — answered: "${r.changes}"` : ''}`,
  );
  return [
    '',
    "The analysis as it stands, with the owner's corrections applied:",
    '```json',
    JSON.stringify(revision.scene, roundForPrompt, 1),
    '```',
    ...(revision.corrections.length
      ? ["The owner's corrections, made by hand in the 3D scene:", ...revision.corrections.map((c) => `- ${c}`)]
      : []),
    ...(revision.camera ? [revision.camera] : []),
    ...(history.length ? ['', 'Notes already applied, oldest first:', ...history] : []),
    '',
    "The owner's note on the 3D scene as it stands:",
    '"""',
    revision.note,
    '"""',
  ].join('\n');
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Strip a ```json fence if the model wrapped its answer, and find the outermost object. */
export function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + 1);
}

/**
 * Parse and validate a model answer into a TwinScene. Tolerant where tolerance is safe (clamps a bbox
 * into the image, defaults a missing optional-ish string) and strict where the renderer would break
 * (missing kind/bbox → the object is dropped and reported). `errors` lists every repair or drop so the
 * bake-off can score schema discipline, not just the final shape.
 */
export function parseTwinScene(text: string): { scene: TwinScene | null; errors: string[]; changes: string } {
  const errors: string[] = [];
  const json = extractJsonObject(text);
  if (!json) return { scene: null, errors: ['no JSON object in the answer'], changes: '' };
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { scene: null, errors: [`JSON.parse failed: ${(e as Error).message}`], changes: '' };
  }
  if (!raw || typeof raw !== 'object') return { scene: null, errors: ['top level is not an object'], changes: '' };

  const kinds = new Set<string>(TWIN_OBJECT_KINDS);
  const objects: TwinObject[] = [];
  const rawObjects: unknown[] = Array.isArray(raw.objects) ? raw.objects : [];
  if (!Array.isArray(raw.objects)) errors.push('objects missing or not an array');
  rawObjects.forEach((o: any, i) => {
    if (!o || typeof o !== 'object') {
      errors.push(`objects[${i}] not an object`);
      return;
    }
    const kind = kinds.has(o.kind) ? (o.kind as TwinObjectKind) : null;
    if (!kind) {
      errors.push(`objects[${i}] unknown kind "${o.kind}" → dropped`);
      return;
    }
    const b = o.bbox;
    if (!b || !isNum(b.x) || !isNum(b.y) || !isNum(b.w) || !isNum(b.h)) {
      errors.push(`objects[${i}] bbox missing/invalid → dropped`);
      return;
    }
    // Accept 0..1000 (Gemini's native convention) or pixel-ish values by normalising when out of range.
    let { x, y, w, h } = b as TwinBBox;
    if (x > 1 || y > 1 || w > 1 || h > 1) {
      const s = Math.max(x + w, y + h) > 1000 ? 1 / Math.max(x + w, y + h) : 1 / 1000;
      x *= s;
      y *= s;
      w *= s;
      h *= s;
      errors.push(`objects[${i}] bbox not in 0..1 → rescaled`);
    }
    const x0 = clamp01(x);
    const y0 = clamp01(y);
    const x1 = clamp01(x + w);
    const y1 = clamp01(y + h);
    if (x1 - x0 <= 0 || y1 - y0 <= 0) {
      errors.push(`objects[${i}] bbox has no area → dropped`);
      return;
    }
    const bbox: TwinBBox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const footprintY = isNum(o.footprintY) ? clamp01(o.footprintY > 1 ? o.footprintY / 1000 : o.footprintY) : y1;
    if (!isNum(o.footprintY)) errors.push(`objects[${i}] footprintY missing → bbox bottom`);
    const materials = new Set<string>(TWIN_MATERIALS);
    const roles = new Set<string>(TWIN_THERMAL_ROLES);
    objects.push({
      id: typeof o.id === 'string' && o.id ? o.id : `obj${i + 1}`,
      kind,
      label: typeof o.label === 'string' ? o.label : '',
      confidence: isNum(o.confidence) ? clamp01(o.confidence) : 0.5,
      bbox,
      footprintY,
      sizeCm: {
        height: isNum(o.sizeCm?.height) ? o.sizeCm.height : 0,
        width: isNum(o.sizeCm?.width) ? o.sizeCm.width : 0,
      },
      material: materials.has(o.material) ? o.material : 'other',
      fill: {
        level: isNum(o.fill?.level) ? clamp01(o.fill.level) : 0,
        content: typeof o.fill?.content === 'string' ? o.fill.content : '',
      },
      restingOn: typeof o.restingOn === 'string' && o.restingOn ? o.restingOn : 'support',
      tiltDeg: isNum(o.tiltDeg) ? Math.max(-90, Math.min(90, o.tiltDeg)) : 0,
      heldOver: typeof o.heldOver === 'string' ? o.heldOver : '',
      thermal: {
        role: roles.has(o.thermal?.role) ? o.thermal.role : 'ambient',
        note: typeof o.thermal?.note === 'string' ? o.thermal.note : '',
      },
    });
  });
  // A restingOn / heldOver that names nothing in the list is a dangling reference: fall back to the
  // support / to nothing. heldOver only means something for a held object.
  const ids = new Set(objects.map((o) => o.id));
  for (const o of objects) {
    if (o.restingOn !== 'support' && o.restingOn !== 'held' && (o.restingOn === o.id || !ids.has(o.restingOn))) {
      errors.push(`${o.id}.restingOn "${o.restingOn}" names no object → support`);
      o.restingOn = 'support';
    }
    if (o.heldOver && (o.heldOver === o.id || !ids.has(o.heldOver))) {
      errors.push(`${o.id}.heldOver "${o.heldOver}" names no object → none`);
      o.heldOver = '';
    }
    if (o.heldOver && o.restingOn !== 'held') o.heldOver = '';
  }

  const pitches = new Set<string>(TWIN_CAMERA_PITCH);
  const hints = new Set<string>(TWIN_DISTANCE_HINT);
  const supports = new Set<string>(TWIN_SUPPORT_KINDS);
  if (typeof raw.renderable !== 'boolean') errors.push('renderable missing → false');
  const scene: TwinScene = {
    renderable: raw.renderable === true,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    confidence: isNum(raw.confidence) ? clamp01(raw.confidence) : 0,
    camera: {
      pitch: pitches.has(raw.camera?.pitch) ? raw.camera.pitch : 'slightly_above',
      distanceHint: hints.has(raw.camera?.distanceHint) ? raw.camera.distanceHint : 'medium',
    },
    support: {
      kind: supports.has(raw.support?.kind) ? raw.support.kind : 'unknown',
      farEdgeY: isNum(raw.support?.farEdgeY) ? (raw.support.farEdgeY < 0 ? -1 : clamp01(raw.support.farEdgeY)) : -1,
    },
    objects,
  };
  // A revision's account of what it changed (§24), cut to what the thread shows; '' on every first analysis.
  const changes = typeof raw.changes === 'string' ? raw.changes.trim().slice(0, TWIN_REVISION_CHANGES_MAX) : '';
  return { scene, errors, changes };
}

/**
 * The deterministic "do not render" gate on top of the model's own verdict (plan §5.2). Returns null when
 * the scene may be rendered, else the reason to show the user. The stability check (plan §4) runs before
 * this and is not repeated here.
 */
export function twinRenderBlocker(scene: TwinScene, minConfidence = 0.6): string | null {
  if (!scene.renderable) return scene.reason || 'The model could not recognise a physical setup.';
  const solid = scene.objects.filter((o) => o.confidence >= minConfidence && !TWIN_UNDRAWN_KINDS.has(o.kind));
  if (solid.length === 0) return 'No object was recognised with enough confidence.';
  if (scene.objects.some((o) => o.bbox.w * o.bbox.h > 0.9))
    return 'One object fills the whole frame — this looks like a screen or a wall.';
  if (scene.support.kind === 'unknown' && !solid.some((o) => o.restingOn === 'support'))
    return 'No supporting surface was found.';
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Revision — the owner's note on the 3D scene, and the model's revised analysis (§24)

/** The analysis schema with a revision's `changes` added — strict-mode shaped like the original. */
export const TWIN_SCENE_REVISION_JSON_SCHEMA = {
  ...TWIN_SCENE_JSON_SCHEMA,
  required: [...TWIN_SCENE_JSON_SCHEMA.required, 'changes'],
  properties: {
    ...TWIN_SCENE_JSON_SCHEMA.properties,
    changes: {
      type: 'string',
      description:
        'One or two plain sentences to the owner: what you changed for their note, or why part of it could not be done.',
    },
  },
} as const;

/** The kinds the 3D scene sizes from a catalogue rather than from sizeCm, as a revision prompt describes
 *  them: NOMINAL_SIZES in src/utils/twinSolver.ts, which twinScene.test.ts holds this list to. */
export const TWIN_CATALOGUE_SIZES: Partial<Record<TwinObjectKind, string>> = {
  beaker: '50–1000 mL, 6–14.5 cm tall',
  erlenmeyer_flask: '125–500 mL, 11–18 cm tall',
  graduated_cylinder: '100 or 250 mL, 25 or 32 cm tall',
  test_tube: '15 cm long',
  test_tube_rack: '20 cm wide',
  petri_dish: '9 cm across, 1.5 cm tall',
  kettle: '22 cm tall, 16 cm across',
  alcohol_lamp: '9 cm tall',
  bunsen_burner: '14 cm tall',
  candle: '10 cm tall',
  hot_plate: '18 cm across',
  tripod: '20 cm tall',
  wire_gauze: '15 cm across',
  ring_stand: '60 cm tall',
  clamp: '12 cm long',
  thermometer: '30 cm long',
};

/** What a revision call is given besides the frame (§24): the analysis as the owner sees it in 3D, their
 *  corrections in words, the rounds before and their new note. */
export interface TwinSceneRevisionInput {
  /** The analysis with the owner's corrections applied (applyTwinCorrections). */
  scene: TwinScene;
  /** Those corrections, one sentence each. */
  corrections: string[];
  /** How the 3D scene's camera tilt is set when the analysis's camera.pitch does not set it (describeSensorTilt). */
  camera?: string | null;
  note: string;
  history: TwinBuildingRevision[];
}

/** One object's corrections as the owner made them in the 3D view — twinEdits.objects[id], which the client
 *  writes (src/types.ts TwinObjectEdit): another kind, a catalogue size of the kind, hidden, another support. */
export interface TwinObjectCorrection {
  kind?: TwinObjectKind;
  spec?: string;
  hidden?: boolean;
  restingOn?: string;
}

/** The owner's corrections to a fixed-camera twin (the experiment's twinEdits). */
export interface TwinCorrections {
  /** The camera tilt the owner set, degrees below horizontal; null when they set none. */
  pitchDeg: number | null;
  /** By object id — a Map, since an id is whatever the model named the object. */
  objects: Map<string, TwinObjectCorrection>;
}

/** A spec label or an object id, as a correction carries it: longer is not one. */
const CORRECTION_TEXT_MAX = 60;

/** The corrections as stored, read field by field: twinEdits is the client's to write, and it goes into a
 *  prompt and back into the record. A field that is not what the client writes is ignored. */
export function readTwinCorrections(raw: unknown): TwinCorrections {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const kinds = new Set<string>(TWIN_OBJECT_KINDS);
  const objects = new Map<string, TwinObjectCorrection>();
  const entries = r.objects && typeof r.objects === 'object' ? Object.entries(r.objects as object) : [];
  for (const [id, e] of entries) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const c: TwinObjectCorrection = {};
    if (typeof o.kind === 'string' && kinds.has(o.kind)) c.kind = o.kind as TwinObjectKind;
    if (typeof o.spec === 'string' && o.spec.trim()) c.spec = o.spec.trim().slice(0, CORRECTION_TEXT_MAX);
    if (o.hidden === true) c.hidden = true;
    if (typeof o.restingOn === 'string' && o.restingOn.trim())
      c.restingOn = o.restingOn.trim().slice(0, CORRECTION_TEXT_MAX);
    if (Object.keys(c).length) objects.set(id, c);
  }
  return { pitchDeg: isNum(r.pitchDeg) ? Math.min(85, Math.max(0, r.pitchDeg)) : null, objects };
}

/**
 * The analysis as the owner sees it in the 3D view, and each of their corrections in words: kinds and
 * supports replaced, hidden objects left out — what stood on a hidden object falls to the support, what was
 * held over one is over nothing — the way applyTwinEdits (src/utils/twinSolver.ts) treats the analysis before
 * the scene is laid out. The size and the tilt the owner chose are said but change nothing here: they are the
 * layout's, not the analysis's, and outlive a revision (carryTwinCorrections). The stored scene is untouched.
 */
export function applyTwinCorrections(scene: TwinScene, c: TwinCorrections): { scene: TwinScene; notes: string[] } {
  const notes: string[] = [];
  const ids = new Set(scene.objects.map((o) => o.id));
  const hidden = new Set(scene.objects.filter((o) => c.objects.get(o.id)?.hidden).map((o) => o.id));
  const name = (o: TwinObject) => (o.label ? `${o.id} ("${o.label.slice(0, 80)}")` : o.id);
  const place = (on: string) =>
    on === 'support'
      ? `on the ${scene.support.kind === 'unknown' ? 'support' : scene.support.kind}`
      : on === 'held'
        ? 'held in the air'
        : `on ${on}`;
  const objects: TwinObject[] = [];
  for (const o of scene.objects) {
    if (hidden.has(o.id)) {
      notes.push(`${name(o)}: the owner hid it as not part of the setup, so it is left out of the analysis above.`);
      continue;
    }
    const e = c.objects.get(o.id);
    const next: TwinObject = { ...o };
    if (e?.kind && e.kind !== o.kind) {
      next.kind = e.kind;
      notes.push(`${name(o)}: the owner made it a ${e.kind} (the analysis said ${o.kind}).`);
    }
    const on = e?.restingOn;
    if (
      on &&
      on !== o.restingOn &&
      (on === 'support' || on === 'held' || (on !== o.id && ids.has(on) && !hidden.has(on)))
    ) {
      next.restingOn = on;
      notes.push(
        `${name(o)}: the owner ${on === 'held' ? 'had it' : 'stood it'} ${place(on)} (the analysis had it ${place(o.restingOn)}).`,
      );
    }
    if (hidden.has(next.restingOn)) next.restingOn = 'support';
    if (next.restingOn !== 'held' || hidden.has(next.heldOver)) next.heldOver = '';
    if (e?.spec)
      notes.push(`${name(o)}: the owner chose its size, "${e.spec}", which it keeps while it stays a ${next.kind}.`);
    objects.push(next);
  }
  if (c.pitchDeg !== null)
    notes.push(
      `The owner set the camera tilt to ${Math.round(c.pitchDeg)}° below horizontal; the 3D scene uses that, whatever camera.pitch says.`,
    );
  return { scene: { ...scene, objects }, notes };
}

/** How the 3D scene's camera tilt is set when neither the owner nor the analysis sets it: by the phone's tilt
 *  sensor at the start of the recording (capturePose.pitchDeg, the elevation above the horizon, as the client
 *  reads it). Null when the owner set the tilt — their corrections say so — or the recording has no reading. */
export function describeSensorTilt(c: TwinCorrections, capturePose: unknown): string | null {
  if (c.pitchDeg !== null) return null;
  const pitch =
    capturePose && typeof capturePose === 'object' ? (capturePose as Record<string, unknown>).pitchDeg : undefined;
  if (!isNum(pitch)) return null;
  return `The phone's tilt sensor put the camera ${Math.round(Math.min(85, Math.max(0, -pitch)))}° below horizontal, and the 3D scene uses that, whatever camera.pitch says.`;
}

/**
 * The corrections that outlive a revision, shaped as twinEdits stores them; null when none do. A revision is
 * given the owner's kinds, supports and hidden objects folded into the analysis, so those go with the old
 * analysis; what an analysis cannot say stays — the camera tilt, and the catalogue size of an object the
 * revision kept under its id as the kind the size was chosen for.
 */
export function carryTwinCorrections(
  c: TwinCorrections,
  before: TwinScene,
  after: TwinScene,
): { pitchDeg?: number; objects?: Record<string, { spec: string }> } | null {
  const chosenFor = new Map(before.objects.map((o) => [o.id, c.objects.get(o.id)?.kind ?? o.kind]));
  const kindNow = new Map(after.objects.map((o) => [o.id, o.kind]));
  const sizes: [string, { spec: string }][] = [];
  for (const [id, e] of c.objects) {
    if (e.spec && !e.hidden && chosenFor.has(id) && kindNow.get(id) === chosenFor.get(id))
      sizes.push([id, { spec: e.spec }]);
  }
  if (c.pitchDeg === null && !sizes.length) return null;
  return {
    ...(c.pitchDeg !== null ? { pitchDeg: c.pitchDeg } : {}),
    ...(sizes.length ? { objects: Object.fromEntries(sizes) } : {}),
  };
}

/** The part of the corrections a revision folds into the analysis it sends — kinds, supports, hidden
 *  objects — as a key. A revision is written only while the key is unchanged: written over corrections made
 *  meanwhile, it would drop ones it never saw. */
export function foldedCorrectionsKey(c: TwinCorrections): string {
  return JSON.stringify(
    [...c.objects]
      .filter(([, e]) => e.kind || e.restingOn || e.hidden)
      .map(([id, e]) => [id, e.kind ?? '', e.restingOn ?? '', !!e.hidden])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}

/** What a revision builds on, read off the stored record and the owner's corrections. */
export interface RevisableTwinScene {
  /** The analysis as the model gave it. */
  scene: TwinScene;
  /** The stored scene as it was read, to write the revision only while it is still the one stored. */
  storedKey: string;
  corrections: TwinCorrections;
  /** The frame analysed — the revision shows the model the same one. */
  recordingIndex: number;
  /** Carried to the revised record as stored: the frame, and so the motion gate and the registration, are
   *  the same. The stability is the caller's to check (sanitizeTwinStability). */
  stability: unknown;
  registration: { dx: number; dy: number; score?: number; method?: string } | null;
  revisions: TwinBuildingRevision[];
  /** The owner's request the analysis was made to (§20), which a revision carries forward; null for none. */
  instructions: string | null;
  /** Which model made it — the server's key for it, and the vendor's id — so the same one revises it. */
  modelKey: string | null;
  model: string;
}

/**
 * The stored fixed-camera twin a revision may build on, or why it may not: a record of this kind (a scene
 * program is revised by analyzeTwinBuilding) that names its frame and carries an analysis. A twin the render
 * gate blocked may be revised — a note is how the owner tells the model what it failed to recognise.
 */
export function readRevisableTwinScene(
  rawRecord: unknown,
  rawEdits: unknown,
): { twin: RevisableTwinScene } | { error: string } {
  const r = rawRecord && typeof rawRecord === 'object' ? (rawRecord as Record<string, unknown>) : null;
  if (!r || r.kind === 'building') return { error: 'There is no fixed-camera twin to revise — build one first.' };
  const recordingIndex = r.recordingIndex;
  if (typeof recordingIndex !== 'number' || !Number.isInteger(recordingIndex) || recordingIndex < 1)
    return { error: 'This twin does not say which frame it was analysed from — regenerate it.' };
  const parsed = r.scene && typeof r.scene === 'object' ? parseTwinScene(JSON.stringify(r.scene)).scene : null;
  if (!parsed) return { error: 'This twin has no analysis to revise — regenerate it.' };
  const g = r.registration && typeof r.registration === 'object' ? (r.registration as Record<string, unknown>) : null;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return {
    twin: {
      scene: parsed,
      storedKey: JSON.stringify(r.scene),
      corrections: readTwinCorrections(rawEdits),
      recordingIndex,
      stability: r.stability ?? null,
      registration:
        g && isNum(g.dx) && isNum(g.dy)
          ? {
              dx: g.dx,
              dy: g.dy,
              ...(isNum(g.score) ? { score: g.score } : {}),
              ...(typeof g.method === 'string' ? { method: g.method.slice(0, 40) } : {}),
            }
          : null,
      revisions: readRevisions(r.revisions),
      instructions: text(r.instructions).slice(0, TWIN_INSTRUCTIONS_MAX) || null,
      modelKey: text(r.modelKey) || null,
      model: text(r.model),
    },
  };
}
