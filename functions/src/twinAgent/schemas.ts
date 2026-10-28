/**
 * The twin agent's own tools (docs/digital-twin-plan.md §43.5), declared beside the synced
 * labCore/toolSchemas.ts (which cannot carry them): two more browser tools — the scene program run in
 * the viewer frame and scored against the thermal frame, and the score alone for another frame — and
 * the one server tool that ends the build by writing the record. look and run_code are the synced
 * schemas, as in Ask AI.
 */
import type { ToolSchema } from '../labCore/llm';

export const TWIN_PHONE_TOOLS = ['look', 'run_code', 'build_scene', 'verify_scene'] as const;
export const TWIN_SERVER_TOOLS = ['finish'] as const;

const PART = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'A short camelCase name, used as api.part(name, …) in the program.' },
    kind: {
      type: 'string',
      description:
        'What it is made of or is: plastic, glass, metal, wood, paper, ceramic, liquid, ice, fabric, skin, stone, other.',
    },
    description: { type: 'string', description: 'One line: what this part is in the scene.' },
  },
  required: ['name', 'kind', 'description'],
};

const OBJECT = {
  type: 'object',
  description: 'One object of the frame as you measured it, in thermal grid pixels (x 0–120 right, y 0–160 down).',
  properties: {
    name: { type: 'string', description: 'What it is, in a word or two ("upper dish").' },
    shape: { type: 'string', description: 'disc, rect or blob.' },
    cx: { type: 'number' },
    cy: { type: 'number' },
    rx: { type: 'number', description: 'Half-width (a disc: its radius), pixels.' },
    ry: { type: 'number', description: 'Half-height (a disc: its radius), pixels.' },
    from: { type: 'string', description: 'thermal or vis: which picture you measured it on.' },
    frames: {
      type: 'array',
      items: { type: 'number' },
      description: 'The first and last frame it was measured over, 1-based.',
    },
    appears: { type: 'number', description: 'The frame it first appears in, when it is not there from the start.' },
    disappears: { type: 'number', description: 'The frame it is last seen in, when it leaves.' },
    note: { type: 'string' },
  },
  required: ['name', 'shape', 'cx', 'cy', 'rx', 'ry', 'from'],
};

export const TWIN_SCHEMAS: ToolSchema[] = [
  {
    name: 'build_scene',
    description:
      'Run a three.js scene program in the twin viewer and score it against the thermal frame. The program is the body of function (THREE, scene, api) — the same api as the twin builder: api.part(name, kind, description) returns a part with .box(w, h, d, x, y, z, kind?, colour?) and .cylinder(r, h, x, y, z, kind?, colour?) (y is the centre), api.material(kind, colour), and raw THREE is allowed. Units are metres, y up, the bench top at y = 0. The picture convention is fixed: the camera looks straight down from (0, cameraHeightM, 0), the picture centre is the origin, picture right is +x, picture DOWN is +z; the picture is 2 · cameraHeightM · tan(27.5°) metres tall and three quarters of that wide, so a thermal pixel is (that height) / 160 metres. Returns what was built (the parts, their sizes and centres), the alignment report — every object the frame shows against the parts over it: IoU, centre offset in pixels, size ratio, and a verdict — and two pictures: the overlay (the frame’s objects red, the model blue, agreement purple) and the model as rendered. At most 3 builds in one session: measure first, build once, correct at most twice.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The program: the body of function (THREE, scene, api).' },
        parts: { type: 'array', items: PART, description: 'Every part the program declares with api.part.' },
        cameraHeightM: {
          type: 'number',
          description:
            'How high the camera stood over the bench, metres — your scale assumption made explicit (a picture 0.35 m tall means a height of 0.336 m).',
        },
        referenceFrame: {
          type: 'number',
          description: 'The frame (1-based) to score against: a still one before anything moved, usually.',
        },
        purpose: { type: 'string', description: 'One line shown to the user, saying what this build is.' },
      },
      required: ['code', 'parts', 'cameraHeightM', 'referenceFrame'],
    },
  },
  {
    name: 'verify_scene',
    description:
      'Score the last built scene against another frame of the recording (the alignment report and the overlay, as build_scene returns them) without building again — to see whether the model still fits later, when something has melted or moved.',
    parameters: {
      type: 'object',
      properties: {
        frame: { type: 'number', description: 'The frame (1-based) to score against.' },
      },
      required: ['frame'],
    },
  },
  {
    name: 'finish',
    description:
      'End the build: the scene program becomes the recording’s digital twin, painted with the recording’s own temperatures through the fixed camera, following the player. Call it once the alignment passes, or when the build budget is spent, with the best program you have. The user sees everything you pass here.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'What the scene is, in a sentence.' },
        subjectKind: { type: 'string', description: 'apparatus, building, interior, vehicle, person or other.' },
        name: { type: 'string', description: 'A title for the twin, a few words.' },
        description: { type: 'string', description: 'The scene in two or three sentences.' },
        parts: { type: 'array', items: PART },
        code: { type: 'string', description: 'The final program, as last built.' },
        cameraHeightM: { type: 'number' },
        referenceFrame: { type: 'number' },
        objects: { type: 'array', items: OBJECT, description: 'The object table you measured.' },
        assumptions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Every assumption behind the model: the scale ("90 mm dishes"), heights you could not see, what a thing is.',
        },
        alignment: {
          type: 'string',
          description: 'The last alignment verdict and its worst offset, as build_scene reported it ("pass, 2.4 px").',
        },
      },
      required: [
        'subject',
        'subjectKind',
        'name',
        'description',
        'parts',
        'code',
        'cameraHeightM',
        'referenceFrame',
        'objects',
        'assumptions',
      ],
    },
  },
];
