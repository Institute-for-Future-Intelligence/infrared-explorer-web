/**
 * Twin-scene analysis contract — the structured "what is in this frame" answer a vision model gives for
 * the 3D digital twin (docs/digital-twin-plan.md §5). Shared by the model bake-off
 * (scripts/evalTwinScene.ts) and, later, the analyzeTwinScene callable, so the prompt, the JSON schema
 * and the parser exist exactly once.
 *
 * Dependency-free on purpose (types, constants, pure functions): tsx runs it straight from the scripts
 * directory and the functions build compiles it, like analysis.ts.
 */

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
}

const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '?');

/** System + user text for the analysis call. The images are attached by the caller (visible first, then
 *  the thermal render), so the text refers to them by order. */
export function buildTwinScenePrompt(ctx: TwinPromptContext): { system: string; user: string } {
  const system = `You are a careful computer-vision annotator for a school thermal-imaging lab. Your output is used to rebuild the photographed setup as a simple 3D scene, so precision about WHAT each object is, WHERE it is in the image, and WHAT it rests on matters more than prose.

Rules:
- Answer ONLY with a JSON object matching the schema you were given. No markdown, no commentary.
- Coordinates are fractions of the image size: x rightwards 0..1, y downwards 0..1, origin at the top-left corner. A bbox is {x, y, w, h}; it must fit inside the image.
- Report physical objects only. Never report drawn overlays, markers, text labels or UI elements.
- If the photo is of a screen, monitor, printout or reflection rather than real objects, or shows no recognisable setup on a surface, set renderable=false and say why in reason. Still list what you can see.
- Prefer the specific lab-glassware kinds when they fit; use bottle/cup/kettle/pot for household containers; use other only when nothing fits.
- restingOn: the id of the object directly beneath (e.g. a beaker on wire_gauze on a tripod → beaker.restingOn = the gauze's id), "support" for the table/floor, or "held" when the object is in the air and rests on nothing — held in a hand, tipped to pour, a thermometer dipped into a beaker. Never say "support" for something that is clearly off the surface: the 3D rebuild would stand it on the table far behind everything else.
- For a held object also fill heldOver (the id of what it is over / pouring into / dipped into, or "") and tiltDeg (its lean from upright as seen in the image; positive = top leans right). Standing objects have tiltDeg 0 and heldOver "".
- sizeCm is your honest estimate of the real size; typical lab glassware sizes are known to you.
- The thermal image, when given, is pixel-aligned with the photo: use it to judge thermal.role and fill level (a liquid level often shows as a temperature step), not to invent objects the photo does not show.`;

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
  lines.push('Analyse the scene and return the JSON.');
  return { system, user: lines.join('\n') };
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
export function parseTwinScene(text: string): { scene: TwinScene | null; errors: string[] } {
  const errors: string[] = [];
  const json = extractJsonObject(text);
  if (!json) return { scene: null, errors: ['no JSON object in the answer'] };
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { scene: null, errors: [`JSON.parse failed: ${(e as Error).message}`] };
  }
  if (!raw || typeof raw !== 'object') return { scene: null, errors: ['top level is not an object'] };

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
  return { scene, errors };
}

/**
 * The deterministic "do not render" gate on top of the model's own verdict (plan §5.2). Returns null when
 * the scene may be rendered, else the reason to show the user. The stability check (plan §4) runs before
 * this and is not repeated here.
 */
export function twinRenderBlocker(scene: TwinScene, minConfidence = 0.6): string | null {
  if (!scene.renderable) return scene.reason || 'The model could not recognise a physical setup.';
  const solid = scene.objects.filter(
    (o) => o.confidence >= minConfidence && !['hand', 'person', 'phone', 'laptop', 'screen'].includes(o.kind),
  );
  if (solid.length === 0) return 'No object was recognised with enough confidence.';
  if (scene.objects.some((o) => o.bbox.w * o.bbox.h > 0.9))
    return 'One object fills the whole frame — this looks like a screen or a wall.';
  if (scene.support.kind === 'unknown' && !solid.some((o) => o.restingOn === 'support'))
    return 'No supporting surface was found.';
  return null;
}
