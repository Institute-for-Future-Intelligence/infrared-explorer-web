import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  IR_GRID_HEIGHT,
  IR_GRID_WIDTH,
  MAX_CODE_CHARS,
  SURFACE_MIN_SAMPLE,
  SURFACE_OVERSHOOT,
  TWIN_BUILDER_SHAPES,
  TWIN_BUILDING_JSON_SCHEMA,
  TWIN_DESCRIPTION_MAX,
  TWIN_NAME_MAX,
  TWIN_PART_DESCRIPTION_MAX,
  TWIN_REASON_MAX,
  TWIN_SUBJECT_MAX,
  TWIN_BUILDING_REVISION_JSON_SCHEMA,
  TWIN_BUILDING_VERSION,
  TWIN_INSTRUCTIONS_MAX,
  TWIN_PART_KINDS,
  TWIN_REVISION_CHANGES_MAX,
  TWIN_REVISION_HISTORY_MAX,
  TWIN_REVISION_NOTE_MAX,
  TWIN_SURFACE_CODE_CHARS,
  TWIN_SURFACE_JSON_SCHEMA,
  TWIN_SURFACE_MAX_PER_PHOTO,
  buildTwinBuildingPrompt,
  buildTwinSurfacePrompt,
  bareCode,
  checkSceneCode,
  describeJsonSchema,
  describeViewpoint,
  erosionFor,
  extractPartsFromCode,
  finishTwinThermal,
  framePercentiles,
  hasDynamicPartCalls,
  imageSize,
  isMixedSurface,
  mergeParts,
  mergeTwinThermal,
  parseTwinBuildingCode,
  parseTwinSurfaces,
  pickTwinPhotos,
  pictureLabel,
  readBuildInstructions,
  readRetrace,
  readRevisableTwin,
  readRevisionNote,
  readRevisions,
  readStoredThermal,
  readSurfaceStats,
  sceneSpanOf,
  surfaceMinShare,
  surfaceRange,
  surfaceStats,
  twinBuildingBlocker,
  twinTracingUnchanged,
  type TwinBuildingPart,
} from './twinBuilding';

const good = {
  renderable: true,
  reason: '',
  confidence: 0.8,
  subject: 'A two-storey office wing raised on columns over a glazed hall.',
  subjectKind: 'building',
  name: 'two-storey raised office wing',
  description: 'A long wing on columns with a glazed hall beneath.',
  parts: [
    { name: 'mainBlock', kind: 'wall', description: 'the raised office wing' },
    { name: 'columns', kind: 'column', description: 'six columns under it' },
  ],
  code: "const mainBlock = api.part('mainBlock', 'wall', 'the raised office wing');\nmainBlock.box(30, 10.5, 12, 0, 3.5, 0);\nconst cols = api.part(\"columns\", \"column\");\nfor (let i = 0; i < 6; i++) cols.cylinder(0.3, 3.5, -12 + i * 5, 0, 5);",
  views: [
    { photo: 1, x: 5, y: 1.6, z: 45, targetX: 0, targetY: 6, targetZ: 0 },
    { photo: 3, x: -30, y: 1.6, z: 25, targetX: 0, targetY: 6, targetZ: 0 },
  ],
};

/** Strict mode: every property required, no additionalProperties, no numeric range keywords. */
const walkStrict = (node: any, path: string) => {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'object') {
    assert.equal(node.additionalProperties, false, `${path} additionalProperties`);
    const keys = Object.keys(node.properties ?? {});
    assert.deepEqual([...(node.required ?? [])].sort(), [...keys].sort(), `${path} required`);
    for (const k of keys) walkStrict(node.properties[k], `${path}.${k}`);
  }
  if (node.type === 'array') walkStrict(node.items, `${path}[]`);
  for (const bad of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'])
    assert.ok(!(bad in node), `${path} uses ${bad}`);
};

describe('contract v6', () => {
  it('is version 6 with the extended kinds', () => {
    assert.equal(TWIN_BUILDING_VERSION, 6);
    for (const k of ['wall', 'glass', 'metal', 'plastic', 'wood', 'stone', 'liquid', 'fabric'])
      assert.ok((TWIN_PART_KINDS as readonly string[]).includes(k), k);
  });
});

describe('TWIN_BUILDING_JSON_SCHEMA', () => {
  it('is strict-mode shaped and carries subject, subjectKind and parts', () => {
    walkStrict(TWIN_BUILDING_JSON_SCHEMA, 'root');
    const p = TWIN_BUILDING_JSON_SCHEMA.properties;
    assert.equal(p.subject.type, 'string');
    assert.deepEqual([...p.subjectKind.enum], ['building', 'interior', 'apparatus', 'vehicle', 'nature', 'other']);
    assert.deepEqual([...p.parts.items.required].sort(), ['description', 'kind', 'name']);
    assert.ok((p.parts.items.properties.kind.enum as readonly string[]).includes('metal'));
    assert.match(p.renderable.description, /ONE identifiable subject/);
  });
});

describe('TWIN_SURFACE_JSON_SCHEMA', () => {
  it('is strict-mode shaped: surfaces of part/face/facing/quad/note', () => {
    walkStrict(TWIN_SURFACE_JSON_SCHEMA, 'root');
    const item = TWIN_SURFACE_JSON_SCHEMA.properties.surfaces.items;
    assert.deepEqual([...item.required].sort(), ['face', 'facing', 'note', 'part', 'quad']);
    assert.ok((item.properties.face.enum as readonly string[]).includes('all'));
    assert.ok((item.properties.facing.enum as readonly string[]).includes('camLeft'));
    assert.equal(item.properties.quad.items.type, 'number');
  });
});

describe('buildTwinBuildingPrompt', () => {
  it('describes the frame API, the parts rule, the anchors, and announces every photo', () => {
    const { system, user } = buildTwinBuildingPrompt({
      photos: [
        { photo: 1, width: 1600, height: 900 },
        { photo: 4, width: 480, height: 640 },
      ],
      title: 'Library',
    });
    assert.match(system, /function build\(THREE, scene, api\)/);
    assert.match(system, /api\.box\(/);
    assert.match(system, /api\.part\(name, kind, description\)/);
    assert.match(system, /p\.box\(/);
    assert.match(system, /p\.cylinder\(/);
    // §29: the pitched builders, and that everything stands on something.
    assert.match(system, /p\.gable\(w, h, d, x, y, z, ridge, kind\?, color\?\)/);
    assert.match(system, /p\.hip\(w, h, d, x, y, z, kind\?, color\?\)/);
    assert.match(system, /p\.shed\(w, h, d, x, y, z, high, kind\?, color\?\)/);
    assert.match(system, /p\.prism\(points, h, x, y, z, kind\?, color\?\)/);
    assert.match(system, /every builder STANDS ON y/);
    assert.match(system, /api\.gable/);
    assert.match(system, /never for a roof or a slab/);
    assert.match(system, /Everything STANDS ON something/);
    assert.match(system, /A roof covers the WHOLE footprint of the walls under it/);
    assert.match(system, /Begin the program with a comment that counts the storeys/);
    assert.match(system, /does every part stand on something, does each roof cover its walls/);
    assert.match(system, /p\.add\(/);
    assert.match(system, /p\.group/);
    assert.match(system, /'glass'/);
    assert.match(system, /'metal'/);
    assert.match(system, /FRONT faces \+z/);
    assert.match(system, /ONE subject/);
    assert.match(system, /a building, a room, a lab bench/);
    assert.match(system, /Split parts where their temperatures could plausibly differ/);
    assert.match(system, /kettle's body and its handle/);
    assert.match(system, /y = 0 is the surface the subject stands on/);
    assert.match(system, /never one hollow box/);
    assert.match(system, /250 mL beaker/);
    assert.match(system, /wheels 0\.65 m/);
    assert.match(system, /1\.5–4 subject sizes away/);
    assert.match(system, /Never use the identifiers top, parent, self, window, document, location, frames/);
    assert.match(system, /only what the photos show around the subject, scaled to it/);
    assert.match(system, /subject, subjectKind, name, description, parts, code, views/);
    assert.match(user, /2 photos/);
    assert.match(user, /Photo 1: a landscape picture \(1600×900 px\)/);
    // The second picture is photo 4 of the set but photo 2 to the model: pictures are numbered by position.
    assert.match(user, /Photo 2 \(photo 4 of the set\): a portrait picture/);
    assert.doesNotMatch(user, /Photo 4:/);
    assert.match(user, /photo 1 is the first listed/);
    assert.match(user, /"Library"/);
  });

  it("calls a recording's frames frames, numbers them by position, and says the camera walked", () => {
    const { system, user } = buildTwinBuildingPrompt({
      photos: [
        { photo: 12, width: 1080, height: 1440 },
        { photo: 40, width: 1080, height: 1440 },
      ],
      source: 'orbit',
    });
    assert.match(user, /2 frames/);
    // The system text anchors the subject's FRONT on "photo 1", so a photo 1 must exist in every set:
    // the frames are announced as photo 1..N with their recording index alongside, never as "Frame 12".
    assert.match(system, /the side facing the camera in photo 1/);
    assert.match(user, /Photo 1 \(recording frame 12\): a portrait picture/);
    assert.match(user, /Photo 2 \(recording frame 40\)/);
    assert.doesNotMatch(user, /Frame 12/);
    assert.match(user, /walked around it/);
    assert.match(user, /photo N/);
  });
});

describe('pictureLabel', () => {
  it('names a picture by its position, with the stored index when that is something else', () => {
    assert.equal(pictureLabel(1, 1), 'Photo 1');
    assert.equal(pictureLabel(3, 9), 'Photo 3 (photo 9 of the set)');
    assert.equal(pictureLabel(3, 9, 'photos'), 'Photo 3 (photo 9 of the set)');
    assert.equal(pictureLabel(1, 12, 'orbit'), 'Photo 1 (recording frame 12)');
    assert.equal(pictureLabel(2, 2, 'orbit'), 'Photo 2 (recording frame 2)');
  });
});

describe('checkSceneCode', () => {
  it('passes a plain program and refuses reaching outside', () => {
    assert.equal(checkSceneCode(good.code), null);
    assert.match(checkSceneCode('')!, /empty/);
    assert.match(checkSceneCode("import * as T from 'three';")!, /import/);
    assert.match(checkSceneCode("fetch('https://x')")!, /fetch/);
    assert.match(checkSceneCode('window.parent.postMessage(1)')!, /window/);
    assert.match(checkSceneCode('document.body.innerHTML = 1')!, /document/);
    assert.match(checkSceneCode('while (true) {}')!, /endless/);
    assert.match(checkSceneCode('x'.repeat(MAX_CODE_CHARS + 1))!, /too long/);
    // Words inside identifiers, comments and strings are not the forbidden globals; member access is.
    assert.equal(checkSceneCode('const windowBand = api.box(1, 1, 1, 0, 0, 0, "glass"); const documented = 1;'), null);
    assert.equal(
      checkSceneCode("// window band on the top floor\nconst label = 'document store';\napi.box(1,1,1,0,0,0,'wall');"),
      null,
    );
    assert.match(checkSceneCode('const w = window.innerWidth;')!, /window/);
    assert.equal(checkSceneCode('const mesh = api.box(1,1,1,0,0,0,"wall"); mesh.parent.remove(mesh);'), null);
    assert.match(checkSceneCode('for (;;) {}')!, /endless/);
  });

  it('refuses top / parent / self only as the root of a member access', () => {
    assert.equal(checkSceneCode("const top = api.box(1, 0.2, 1, 0, 3, 0, 'roof');"), null);
    // A bare use is fine; a member access on the name is not, whatever it was bound to — which is why
    // the prompt tells the model not to use these names at all.
    assert.equal(checkSceneCode('const parent = new THREE.Group(); scene.add(parent);'), null);
    assert.match(checkSceneCode('const parent = new THREE.Group(); parent.add(mesh);')!, /parent/);
    assert.equal(checkSceneCode('const self = 1; const top = 2; const x = top + self;'), null);
    assert.match(checkSceneCode('top.location.href = "x";')!, /top/);
    assert.match(checkSceneCode('parent.postMessage(1, "*");')!, /parent/);
    assert.match(checkSceneCode('self["fetch"]("x");')!, /self/);
    assert.match(checkSceneCode('window.parent.postMessage(1)')!, /window/);
    // An alias defeats the cheap check (postMessage is a property here). What keeps a program from
    // speaking to the page in the frame's name is the frame's private channel to it (twinFrame.ts), which
    // the program cannot reach; what keeps it off the network is the frame's sandbox and CSP.
    assert.equal(checkSceneCode('const p = parent; p.postMessage(1)'), null);
  });

  it('does not let a quote inside a regular expression or an HTML-like comment hide the code after it', () => {
    const hidden = [
      "/'/.test(''); window.parent.postMessage(1, '*'); // '",
      "if (1) /'/.test(''); window.x = 1; // '",
      "{} /'/.test(''); window.x = 1; // '",
      "<!-- '\nwindow.parent.postMessage(1, '*')\n// '",
      "x = 1\n--> '\nwindow.x = 1\n// '",
      "/* a\n */ --> '\nwindow.x = 1; // '",
    ];
    for (const code of hidden) assert.match(checkSceneCode(code) ?? '', /window/, code);
    // Divisions stay divisions, and a slash or a quote inside a class stays inside the expression.
    assert.equal(checkSceneCode("const r = w / 2 / h; const label = 'window band';"), null);
    assert.equal(checkSceneCode("const m = s.match(/[/']x/); const t = 1;"), null);
    assert.equal(checkSceneCode("const half = (w) / 2; const q = 'it' + \"'s\";"), null);
    assert.equal(bareCode('a = b / c; d = /x/g;'), 'a = b / c; d = / /g;');
  });

  it('reads a slash both ways, so a division taken for a regular expression hides nothing either', () => {
    for (const code of [
      '{} / window.parent.postMessage(1) / 1;',
      'a++ / fetch(x) / 1;',
      'let of = 2; of / window / 1;',
      'o.for(1) / Function("x") / 1;',
    ])
      assert.ok(checkSceneCode(code), code);
    assert.equal(bareCode('a = b / c; d = /x/g;', false), 'a = b / c; d = /x/g;');
    // The event being handled is the frame's message, its target the frame's private port.
    assert.match(checkSceneCode('const p = event.currentTarget;') ?? '', /event/);
    assert.equal(
      checkSceneCode("const event = api.part('event', 'other', ''); event.box(1, 1, 1, 0, 0, 0);") === null,
      false,
    );
  });

  it('refuses `this` as a member root and any walk up a prototype chain', () => {
    // The program runs as a sloppy-mode function body, where `this` is the frame window.
    assert.match(checkSceneCode('this.parent.postMessage(1, "*")')!, /this/);
    assert.match(checkSceneCode('this["parent"].postMessage(1, "*")')!, /this/);
    // The Function constructor without its name: [].constructor.constructor('return this')().
    assert.match(checkSceneCode('const F = [].constructor.constructor; F("return this")()')!, /constructor/);
    assert.match(checkSceneCode("const F = []['constructor']['constructor'];")!, /constructor/);
    assert.match(checkSceneCode('const F = [][ "constructor" ];')!, /constructor/);
    assert.match(checkSceneCode('const o = {}; o.__proto__.x = 1;')!, /__proto__/);
    assert.match(checkSceneCode('const o = {}; o["__proto__"].x = 1;')!, /__proto__/);
    assert.match(checkSceneCode('const o = { __proto__: null };')!, /__proto__/);
    // Ordinary programs are untouched: the words inside identifiers, comments and strings, and `this`
    // in a comment.
    assert.equal(checkSceneCode("const constructorHall = api.part('constructorHall', 'wall', 'this hall');"), null);
    assert.equal(
      checkSceneCode("// this.constructor is not what a scene needs\nconst x = api.box(1,1,1,0,0,0,'wall');"),
      null,
    );
    assert.equal(checkSceneCode("const label = '__proto__ and constructor as words';"), null);
    assert.equal(checkSceneCode("const thisWall = api.part('thisWall', 'wall', ''); thisWall.box(1,1,1,0,0,0);"), null);
    assert.equal(checkSceneCode('const g = new THREE.Group(); g.userData.constructorName = 1;'), null);
  });
});

describe('extractPartsFromCode', () => {
  it('reads api.part calls with either quote, with or without a description, first occurrence wins', () => {
    const code = `
      const body = api.part('kettleBody', 'metal', 'the stainless body');
      const lid = api.part("lid", "metal");
      const handle = api.part('handle', 'plastic', "the black handle, it's cool");
      const odd = api.part('plate', 'ceramic', 'a hot plate');
      const again = api.part('kettleBody', 'wood', 'ignored');
      api.part( 'spaced' , 'glass' , 'gap' );
    `;
    assert.deepEqual(extractPartsFromCode(code), [
      { name: 'kettleBody', kind: 'metal', description: 'the stainless body' },
      { name: 'lid', kind: 'metal', description: '' },
      { name: 'handle', kind: 'plastic', description: "the black handle, it's cool" },
      { name: 'plate', kind: 'other', description: 'a hot plate' },
      { name: 'spaced', kind: 'glass', description: 'gap' },
    ]);
    assert.deepEqual(extractPartsFromCode("api.box(1,1,1,0,0,0,'wall');"), []);
  });

  it('reads a literal name whatever the kind and description are; a computed name is left to the JSON', () => {
    const code = `
      const M = 'metal';
      const legDesc = 'a steel leg';
      const kinds = ['wood', 'plastic'];
      const leg = api.part('leg', M, 'x');
      const top = api.part('deskTop', kinds[0], legDesc);
      const rail = api.part('rail', \`\${M}\`, \`the \${M} rail\`);
      const knob = api.part('knob', 'plastic', desc(1));
      for (let i = 0; i < 4; i++) api.part(\`column\${i}\`, 'column', 'a pilotis');
      const n = 'plinth'; api.part(n, 'stone', 'the base');
    `;
    assert.deepEqual(extractPartsFromCode(code), [
      { name: 'leg', kind: 'other', description: 'x' },
      { name: 'deskTop', kind: 'other', description: '' },
      { name: 'rail', kind: 'other', description: '' },
      { name: 'knob', kind: 'plastic', description: '' },
    ]);
    assert.equal(hasDynamicPartCalls(code), true);
    assert.equal(hasDynamicPartCalls(good.code), false);
    assert.equal(hasDynamicPartCalls("api.part( 'spaced' , 'glass' )"), false);
    assert.equal(hasDynamicPartCalls('api.part(`col${i}`, "column")'), true);
    assert.equal(hasDynamicPartCalls('api.part(name, "column")'), true);
  });

  it('reads no call out of a comment or a string (§31.4)', () => {
    const code = [
      "// the roof: api.part('roof') below, then api.part('ghost')",
      "/* api.part(name, 'wall') was here */",
      "const label = \"api.part('inString', 'glass')\";",
      "const roof = api.part('roof', 'roof', 'the pitched roof');",
      'const q = /api.part/;',
      "api.part('eaves', 'roof');",
    ].join('\n');
    assert.deepEqual(extractPartsFromCode(code), [
      { name: 'roof', kind: 'roof', description: 'the pitched roof' },
      { name: 'eaves', kind: 'roof', description: '' },
    ]);
    assert.equal(hasDynamicPartCalls(code), false);
  });

  it('does not let an unclosed call in a comment or a string swallow the real one after it (§31.7)', () => {
    for (const lead of [
      "// api.part('walls', 'wall', see the note below",
      "/* api.part('walls', 'wall', see below */",
      "const hint = \"api.part('walls', 'wall', ...\";",
    ]) {
      const code = [
        lead,
        "const walls = api.part('walls', 'wall', 'Main walls');",
        "api.part('roof', 'roof', 'The roof');",
      ].join('\n');
      assert.deepEqual(
        extractPartsFromCode(code),
        [
          { name: 'walls', kind: 'wall', description: 'Main walls' },
          { name: 'roof', kind: 'roof', description: 'The roof' },
        ],
        lead,
      );
    }
  });
});

describe('mergeParts', () => {
  const fromCode: TwinBuildingPart[] = [{ name: 'leg', kind: 'other', description: '' }];
  const json = [
    { name: 'leg', kind: 'metal', description: 'a steel leg' },
    { name: 'column0', kind: 'column', description: 'a pilotis' },
    { name: 'column1', kind: 'column', description: 'a pilotis' },
  ];

  it('drops a JSON-only part when every api.part name in the code is a literal', () => {
    const errors: string[] = [];
    const merged = mergeParts(fromCode, json, errors);
    assert.deepEqual(merged, [{ name: 'leg', kind: 'metal', description: 'a steel leg' }]);
    assert.equal(errors.filter((e) => /never declares → dropped/.test(e)).length, 2);
  });

  it('appends JSON-only parts after the code’s when the code declares parts by computed names', () => {
    const errors: string[] = [];
    const merged = mergeParts(fromCode, json, errors, true);
    assert.deepEqual(
      merged.map((p) => p.name),
      ['leg', 'column0', 'column1'],
    );
    assert.equal(merged[0].kind, 'metal');
    assert.equal(merged[1].kind, 'column');
    assert.equal(errors.filter((e) => /computed name → kept from the JSON/.test(e)).length, 2);
    assert.equal(
      errors.some((e) => /dropped/.test(e)),
      false,
    );
  });

  it('through parseTwinBuildingCode: a loop of template-literal columns survives into the parts list', () => {
    const answer = {
      ...good,
      code:
        "const mainBlock = api.part('mainBlock', 'wall', 'the raised office wing');\n" +
        'mainBlock.box(30, 10.5, 12, 0, 3.5, 0);\n' +
        "for (let i = 0; i < 2; i++) { const c = api.part(`column${i}`, 'column', 'a pilotis'); c.cylinder(0.3, 3.5, -5 + i * 10, 0, 5); }",
      parts: [
        { name: 'mainBlock', kind: 'wall', description: 'the raised office wing' },
        { name: 'column0', kind: 'column', description: 'a pilotis' },
        { name: 'column1', kind: 'column', description: 'a pilotis' },
      ],
    };
    const { answer: parsed, errors } = parseTwinBuildingCode(JSON.stringify(answer));
    assert.deepEqual(
      parsed!.parts.map((p) => p.name),
      ['mainBlock', 'column0', 'column1'],
    );
    assert.equal(
      errors.some((e) => /dropped/.test(e)),
      false,
    );
    // A variable as the kind does not cost the part its JSON kind either.
    const varKind = {
      ...good,
      code: "const M = 'column';\nconst cols = api.part('columns', M, 'six columns');\ncols.cylinder(0.3, 3.5, 0, 0, 0);",
      parts: [{ name: 'columns', kind: 'column', description: 'six columns under it' }],
    };
    assert.deepEqual(parseTwinBuildingCode(JSON.stringify(varKind)).answer!.parts, [
      { name: 'columns', kind: 'column', description: 'six columns under it' },
    ]);
  });
});

describe('parseTwinBuildingCode', () => {
  it('accepts a well-formed answer with subject, kind and parts', () => {
    const { answer, errors } = parseTwinBuildingCode(JSON.stringify(good), [1, 2, 3]);
    assert.deepEqual(errors, []);
    assert.ok(answer);
    assert.equal(answer!.renderable, true);
    assert.equal(answer!.code, good.code);
    assert.equal(answer!.views.length, 2);
    assert.equal(answer!.subject, good.subject);
    assert.equal(answer!.subjectKind, 'building');
    assert.deepEqual(answer!.parts, [
      { name: 'mainBlock', kind: 'wall', description: 'the raised office wing' },
      { name: 'columns', kind: 'column', description: 'six columns under it' },
    ]);
    assert.equal(twinBuildingBlocker(answer!), null);
  });

  it('takes the code as the truth about parts and the JSON for descriptions', () => {
    const answerJson = {
      ...good,
      parts: [
        { name: 'MainBlock', kind: 'wall', description: 'from the JSON' },
        { name: 'ghost', kind: 'roof', description: 'never declared in code' },
        { name: '', kind: 'wall', description: 'nameless' },
      ],
    };
    const { answer, errors } = parseTwinBuildingCode(JSON.stringify(answerJson));
    assert.deepEqual(
      answer!.parts.map((p) => p.name),
      ['mainBlock', 'columns'],
    );
    assert.equal(answer!.parts[0].description, 'from the JSON');
    assert.equal(answer!.parts[1].description, '');
    assert.ok(errors.some((e) => /"ghost"/.test(e)));
    assert.ok(errors.some((e) => /parts\[2\] has no name/.test(e)));
    for (const p of answer!.parts) assert.equal(typeof p.description, 'string');
  });

  it('falls back to the JSON parts when the code declares none, and to other/subject when fields are off', () => {
    const loose = {
      ...good,
      subjectKind: 'spaceship',
      name: undefined,
      code: "const g = new THREE.Group(); g.name = 'hull'; scene.add(g);",
      parts: [{ name: 'hull', kind: 'titanium', description: 'the hull' }],
    };
    const { answer, errors } = parseTwinBuildingCode(JSON.stringify(loose));
    assert.equal(answer!.subjectKind, 'other');
    assert.equal(answer!.name, 'subject');
    assert.deepEqual(answer!.parts, [{ name: 'hull', kind: 'other', description: 'the hull' }]);
    assert.ok(errors.some((e) => /subjectKind "spaceship"/.test(e)));
    const bare = parseTwinBuildingCode(JSON.stringify({ ...good, subjectKind: undefined, subject: undefined }));
    assert.equal(bare.answer!.subjectKind, 'other');
    assert.equal(bare.answer!.subject, '');
  });

  it('unwraps fences and a function header the model added anyway', () => {
    const wrapped = {
      ...good,
      code: '```javascript\nfunction build(THREE, scene, api) {\n' + good.code + '\n}\n```',
    };
    const { answer } = parseTwinBuildingCode(JSON.stringify(wrapped));
    assert.equal(answer!.code, good.code);
    assert.equal(answer!.parts.length, 2);
  });

  it('turns a forbidden program into a non-renderable answer with the reason and no parts', () => {
    const bad = { ...good, code: "fetch('https://evil')" };
    const { answer, errors } = parseTwinBuildingCode(JSON.stringify(bad));
    assert.equal(answer!.renderable, false);
    assert.equal(answer!.code, '');
    assert.deepEqual(answer!.parts, []);
    assert.match(answer!.reason, /fetch/);
    assert.match(errors[0], /code refused/);
    assert.match(twinBuildingBlocker(answer!)!, /fetch/);
  });

  it('drops views of photos it was not sent, repeats and bad numbers', () => {
    const v = {
      ...good,
      views: [
        ...good.views,
        { photo: 9, x: 0, y: 1, z: 1, targetX: 0, targetY: 0, targetZ: 0 },
        { photo: 1, x: 0, y: 1, z: 1, targetX: 0, targetY: 0, targetZ: 0 },
        { photo: 2, x: 'far', y: 1, z: 1, targetX: 0, targetY: 0, targetZ: 0 },
      ],
    };
    const { answer, errors } = parseTwinBuildingCode(JSON.stringify(v), [1, 2, 3]);
    assert.deepEqual(
      answer!.views.map((x) => x.photo),
      [1, 3],
    );
    assert.equal(errors.length, 3);
    assert.ok(errors.some((e) => /names photo 9, but only 3 were sent/.test(e)));
  });

  it('maps a view’s photo number (a position) back to the stored index of the picture sent there', () => {
    // An orbit set: recording frames 12, 40 and 61 were announced as photos 1, 2 and 3.
    const v = {
      ...good,
      views: [
        { photo: 1, x: 0, y: 1.6, z: 4, targetX: 0, targetY: 0.5, targetZ: 0 },
        { photo: 3, x: 4, y: 1.6, z: 0, targetX: 0, targetY: 0.5, targetZ: 0 },
        { photo: 4, x: 0, y: 1.6, z: -4, targetX: 0, targetY: 0.5, targetZ: 0 },
      ],
    };
    const { answer, errors } = parseTwinBuildingCode(JSON.stringify(v), [12, 40, 61]);
    assert.deepEqual(
      answer!.views.map((x) => x.photo),
      [12, 61],
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /photo 4, but only 3 were sent/);
    // A model that answered with the recording frame it was shown in brackets is understood, with a note.
    const byIndex = { ...good, views: [{ photo: 40, x: 4, y: 1.6, z: 0, targetX: 0, targetY: 0.5, targetZ: 0 }] };
    const r = parseTwinBuildingCode(JSON.stringify(byIndex), [12, 40, 61]);
    assert.deepEqual(
      r.answer!.views.map((x) => x.photo),
      [40],
    );
    assert.match(r.errors[0], /stored index/);
    // The same picture named both ways is one view.
    const twice = {
      ...good,
      views: [
        { photo: 2, x: 4, y: 1.6, z: 0, targetX: 0, targetY: 0.5, targetZ: 0 },
        { photo: 40, x: 5, y: 1.6, z: 0, targetX: 0, targetY: 0.5, targetZ: 0 },
      ],
    };
    const t = parseTwinBuildingCode(JSON.stringify(twice), [12, 40, 61]);
    assert.equal(t.answer!.views.length, 1);
    assert.ok(t.errors.some((e) => /repeats photo 40/.test(e)));
  });

  it("maps a view named by a set photo's place on the strip back to its stored number (§31.3)", () => {
    // Stored photos 7, 1, 2 sent in that order, at places 1, 5, 9 of the set (the model was shown "photo 5
    // of the set", "photo 9 of the set").
    const byPlace = { ...good, views: [{ photo: 9, x: 4, y: 1.6, z: 0, targetX: 0, targetY: 0.5, targetZ: 0 }] };
    const r = parseTwinBuildingCode(JSON.stringify(byPlace), [7, 1, 2], [1, 5, 9]);
    assert.deepEqual(
      r.answer!.views.map((x) => x.photo),
      [2],
    );
    assert.match(r.errors[0], /by its place in the set/);
    // A stored number the model was never shown is not a picture it can mean.
    const byStored = { ...good, views: [{ photo: 7, x: 4, y: 1.6, z: 0, targetX: 0, targetY: 0.5, targetZ: 0 }] };
    const s = parseTwinBuildingCode(JSON.stringify(byStored), [7, 1, 2], [1, 5, 9]);
    assert.equal(s.answer!.views.length, 0);
    assert.match(s.errors[0], /only 3 were sent/);
  });

  it('reads a view given as position/target triples or objects (a provider without schema enforcement)', () => {
    const loose = {
      ...good,
      views: [
        { photo: 1, position: [54, 1.6, 50], target: [8, 7, 2], fov: 65 },
        { photo: 2, camera: { x: 38, y: 1.6, z: 54 }, look: [-2, 7, 0] },
      ],
    };
    const { answer, errors } = parseTwinBuildingCode(JSON.stringify(loose), [1, 2]);
    assert.deepEqual(errors, []);
    assert.deepEqual(answer!.views[0], { photo: 1, x: 54, y: 1.6, z: 50, targetX: 8, targetY: 7, targetZ: 2 });
    assert.deepEqual(answer!.views[1], { photo: 2, x: 38, y: 1.6, z: 54, targetX: -2, targetY: 7, targetZ: 0 });
  });

  it('gates on confidence and renderable with subject-neutral wording', () => {
    const shy = { ...good, confidence: 0.2 };
    assert.match(twinBuildingBlocker(parseTwinBuildingCode(JSON.stringify(shy)).answer!)!, /confident/);
    const not = { ...good, renderable: false, reason: 'It is a chart on a screen.' };
    const { answer } = parseTwinBuildingCode(JSON.stringify(not));
    assert.equal(answer!.code, '');
    assert.equal(twinBuildingBlocker(answer!), 'It is a chart on a screen.');
    assert.match(twinBuildingBlocker({ ...answer!, reason: '' })!, /one subject/);
    assert.equal(parseTwinBuildingCode('nothing here').answer, null);
  });
});

describe('describeViewpoint', () => {
  const view = (x: number, y: number, z: number) => ({ photo: 1, x, y, z, targetX: 0, targetY: 1, targetZ: 0 });

  it('names the quadrant, the visible faces by picture side, and the hidden ones', () => {
    const fr = describeViewpoint(view(30, 2, 40));
    assert.match(fr, /from the subject's front-right/);
    assert.match(fr, /FRONT on the left half of the picture/);
    assert.match(fr, /RIGHT on the right half/);
    assert.match(fr, /cannot see the BACK or the LEFT/);
    assert.match(fr, /roughly level/);
    assert.doesNotMatch(fr, /\d+(\.\d+)? ?m\b/);
    // From behind and to the left, facing the subject, the BACK face is on the viewer's left: the picture's
    // right vector is (−0.6, 0.8), and the back face's centre (0, −1) projects to −0.8 on it.
    const bl = describeViewpoint(view(-40, 2, -30));
    assert.match(bl, /from the subject's left-back/);
    assert.match(bl, /BACK on the left half of the picture/);
    assert.match(bl, /LEFT on the right half/);
    assert.match(bl, /cannot see the FRONT or the RIGHT/);
    const rf = describeViewpoint(view(40, 2, 10));
    assert.match(rf, /from the subject's right, /);
    assert.match(rf, /FRONT on the left half/);
    assert.match(rf, /RIGHT on the right half \(facing you\)/);
  });

  it('says a face fills the picture from straight on, and reads elevation', () => {
    const front = describeViewpoint(view(0, 2, 50));
    assert.match(front, /from the subject's front,/);
    assert.match(front, /FRONT fills the picture/);
    assert.match(front, /cannot see the BACK or the RIGHT or the LEFT/);
    const high = describeViewpoint(view(20, 40, 20));
    assert.match(high, /looking down on it, so the TOP may be in view/);
    const low = describeViewpoint({ ...view(0, -20, 30), targetY: 5 });
    assert.match(low, /looking up at it/);
    assert.match(describeViewpoint(null), /not known/);
  });

  it('names no side for a camera straight above or below the subject', () => {
    for (const v of [view(0, 6, 0), view(0.01, 6, 0), view(0.4, 6, -0.3)]) {
      const s = describeViewpoint(v);
      assert.match(s, /from directly above the subject, looking straight down/);
      assert.match(s, /the TOP fills the picture/);
      assert.match(s, /FRONT, BACK, LEFT and RIGHT are edge-on or hidden/);
      assert.doesNotMatch(s, /from the subject's/);
      assert.doesNotMatch(s, /FRONT fills the picture/);
    }
    const below = describeViewpoint({ ...view(0.01, -6, 0), targetY: 0 });
    assert.match(below, /from directly below the subject, looking straight up/);
    assert.match(below, /the BOTTOM fills the picture/);
    assert.doesNotMatch(below, /from the subject's/);
    // Just outside the vertical cone (60° up) the usual sentence returns, with its side.
    const steep = describeViewpoint(view(0, 1 + 5 * Math.tan(Math.PI / 3), 5));
    assert.match(steep, /from the subject's front, looking down on it/);
  });
});

const parts: TwinBuildingPart[] = [
  { name: 'kettleBody', kind: 'metal', description: 'the stainless body' },
  { name: 'hotPlate', kind: 'other', description: 'the plate it stands on' },
];

describe('buildTwinSurfacePrompt', () => {
  it('states the pixel frame, the parts, the viewpoint, the code and asks for JSON', () => {
    const { system, user } = buildTwinSurfacePrompt({
      subject: 'a kettle on a hot plate',
      subjectKind: 'apparatus',
      parts,
      code: "const b = api.part('kettleBody', 'metal');",
      photo: 3,
      width: 1080,
      height: 1440,
      viewpoint: 'You judged this photo was taken from the front-right.',
    });
    assert.match(system, /PIXELS in the 1080×1440 picture/);
    assert.match(system, /x to the right, y down/);
    assert.match(system, /top-left, top-right, bottom-right, bottom-left/);
    assert.match(system, /SAFELY INSIDE/);
    assert.match(system, /hand's width/);
    assert.match(system, /larger clear side only/);
    assert.match(system, /1\/20 of the picture/);
    assert.match(system, /reflections in glass/);
    assert.match(system, /NEVER read temperatures from its colours/);
    assert.match(system, /'camLeft'/);
    assert.match(system, /JSON/);
    assert.match(system, new RegExp(`At most ${TWIN_SURFACE_MAX_PER_PHOTO} surfaces`));
    assert.match(user, /Subject: a kettle on a hot plate \(apparatus\)/);
    assert.match(user, /- kettleBody — metal — the stainless body/);
    assert.match(user, /Photo 3, 1080×1440 px/);
    assert.match(user, /thermal render is the second picture/);
    assert.match(user, /Viewpoint: You judged this photo was taken from the front-right\./);
    assert.match(user, /api\.part\('kettleBody', 'metal'\)/);
    assert.match(user, /JSON/);
    // The roof builders' shapes, so a slope is named as the frame names it (§31.4).
    assert.ok(system.includes(TWIN_BUILDER_SHAPES));
    assert.match(system, /under 45° it is the 'top', steeper it is the side it faces/);
  });

  it('asks for no surface narrower than the margin the statistics take off leaves anything of (§31.6)', () => {
    // 2·erode + 2 of the grid's 120 columns: 1/20 at 2 px, 1/15 at 3, 1/10 at the 5 of an unregistered photo.
    assert.equal(surfaceMinShare(), 20);
    assert.equal(surfaceMinShare(3), 15);
    assert.equal(surfaceMinShare(5), 10);
    assert.equal(surfaceMinShare(erosionFor(null)), 10);
    const ctx = { subject: 's', parts, code: 'x', photo: 1, width: 1080, height: 1440, viewpoint: 'v' };
    assert.match(buildTwinSurfacePrompt(ctx).system, /narrower than 1\/20 of the picture's width/);
    assert.match(buildTwinSurfacePrompt({ ...ctx, erodePx: 5 }).system, /narrower than 1\/10 of the picture's width/);
  });

  it('cuts a long program and words the render-only case', () => {
    const { system, user } = buildTwinSurfacePrompt({
      subject: '',
      parts: [],
      code: 'x'.repeat(TWIN_SURFACE_CODE_CHARS + 500),
      photo: 1,
      width: 480,
      height: 640,
      viewpoint: describeViewpoint(null),
      picture: 'render',
    });
    assert.match(user, /cut here/);
    assert.ok(user.length < TWIN_SURFACE_CODE_CHARS + 2000);
    assert.match(user, /Subject: not named/);
    assert.match(user, /declares no named parts/);
    assert.match(user, /the thermal render is the picture/);
    assert.doesNotMatch(system, /NEVER read temperatures/);
    assert.match(system, /false-colour render\)/);
  });

  it('promises no second picture when the render is not attached, and names the picture as phase 1 did', () => {
    const ctx = {
      subject: 'a kettle',
      parts,
      code: '',
      photo: 3,
      label: 'Photo 3 (recording frame 61)',
      width: 1080,
      height: 1440,
      viewpoint: describeViewpoint(null),
    };
    const alone = buildTwinSurfacePrompt({ ...ctx, picture: 'vis', withRender: false });
    assert.match(alone.system, /ONE picture of the subject \(a visible-light photo\)/);
    assert.doesNotMatch(alone.system, /followed by the thermal camera/);
    assert.doesNotMatch(alone.system, /The thermal render is attached/);
    assert.doesNotMatch(alone.system, /NEVER read temperatures/);
    assert.match(alone.user, /Photo 3 \(recording frame 61\), 1080×1440 px \(the only picture\)\./);
    assert.doesNotMatch(alone.user, /second picture/);
    // The default (withRender omitted, or true) is the two-picture wording.
    const both = buildTwinSurfacePrompt({ ...ctx, picture: 'vis' });
    assert.match(both.system, /followed by the thermal camera/);
    assert.match(both.system, /NEVER read temperatures/);
    assert.match(
      both.user,
      /Photo 3 \(recording frame 61\), 1080×1440 px \(the first picture\); its thermal render is the second picture/,
    );
    // withRender means nothing for a render-only picture.
    const render = buildTwinSurfacePrompt({ ...ctx, label: undefined, picture: 'render', withRender: true });
    assert.match(render.user, /Photo 3, 1080×1440 px \(the thermal render is the picture\)/);
    assert.doesNotMatch(render.system, /followed by the thermal camera/);
  });
});

describe('parseTwinSurfaces', () => {
  const W = 1080;
  const H = 1440;
  const round = (a: number[]) => a.map((v) => Math.round(v * 1000) / 1000);

  it('reads the schema shape in pixels and converts to fractions; keeps fractions as they are', () => {
    const text = JSON.stringify({
      surfaces: [
        {
          part: 'kettleBody',
          face: 'front',
          facing: 'toward',
          quad: [108, 144, 540, 144, 540, 720, 108, 720],
          note: 'body',
        },
        { part: 'hotPlate', face: 'top', facing: 'up', quad: [0.1, 0.6, 0.9, 0.6, 0.9, 0.9, 0.1, 0.9], note: '' },
      ],
    });
    const { surfaces, errors } = parseTwinSurfaces(text, parts, W, H);
    assert.deepEqual(errors, []);
    assert.equal(surfaces.length, 2);
    assert.equal(surfaces[0].part, 'kettleBody');
    assert.equal(surfaces[0].kind, 'metal');
    assert.equal(surfaces[0].face, 'front');
    assert.equal(surfaces[0].facing, 'toward');
    assert.equal(surfaces[0].note, 'body');
    assert.deepEqual(round(surfaces[0].quad), [0.1, 0.1, 0.5, 0.1, 0.5, 0.5, 0.1, 0.5]);
    assert.deepEqual(surfaces[1].quad, [0.1, 0.6, 0.9, 0.6, 0.9, 0.9, 0.1, 0.9]);
    assert.equal('note' in surfaces[1], false);
  });

  it('reads a fraction quad with a corner just past 1 as fractions (the overshoot slack), not as pixels', () => {
    const { surfaces, errors } = parseTwinSurfaces(
      JSON.stringify({
        surfaces: [
          { part: 'kettleBody', face: 'front', quad: [0.6, 0.1, 1.01, 0.1, 1.01, 0.5, 0.6, 0.5] },
          // Past the slack the numbers can only be pixels — a sub-pixel quad, which the statistics then
          // report as 'no-pixels' (and the caller logs) rather than losing it silently.
          {
            part: 'kettleBody',
            face: 'back',
            quad: [0.6, 0.1, 1 + SURFACE_OVERSHOOT + 0.01, 0.1, 1.06, 0.5, 0.6, 0.5],
          },
        ],
      }),
      parts,
      W,
      H,
    );
    assert.deepEqual(errors, []);
    assert.equal(surfaces.length, 2);
    assert.deepEqual(surfaces[0].quad, [0.6, 0.1, 1, 0.1, 1, 0.5, 0.6, 0.5]);
    assert.ok(surfaces[1].quad.every((v) => v < 0.002));
    assert.equal(
      readSurfaceStats(surfaces[1].quad, new Float32Array(IR_GRID_WIDTH * IR_GRID_HEIGHT), null).reason,
      'no-pixels',
    );
  });

  it('tolerates the loose shapes: bare array, other list keys, part/face synonyms, quad forms', () => {
    const bare = parseTwinSurfaces(
      JSON.stringify([
        {
          partName: 'KETTLEBODY',
          side: 'roof',
          quad: [
            [100, 100],
            [200, 100],
            [200, 200],
            [100, 200],
          ],
        },
      ]),
      parts,
      W,
      H,
    );
    assert.equal(bare.surfaces.length, 1);
    assert.equal(bare.surfaces[0].part, 'kettleBody');
    assert.equal(bare.surfaces[0].face, 'top');
    assert.equal(bare.surfaces[0].facing, undefined);
    const regions = parseTwinSurfaces(
      '```json\n' +
        JSON.stringify({
          regions: [
            {
              name: 'hot plate',
              face: 'floor',
              corners: [
                { x: 10, y: 10 },
                { x: 50, y: 10 },
                { x: 50, y: 50 },
                { x: 10, y: 50 },
              ],
            },
            {
              mesh: 'kettleBody',
              face: 'whole',
              quad: { x0: 10, y0: 10, x1: 50, y1: 10, x2: 50, y2: 50, x3: 10, y3: 50 },
            },
            { part: 'kettleBody', face: 'upper', bbox: { x: 100, y: 200, w: 300, h: 400 } },
            { part: 'kettleBody', face: 'lower', box: { left: 100, top: 200, right: 400, bottom: 600 } },
            { part: 'kettleBody', face: 'middle', quad: [100, 200, 400, 600] },
            { part: 'kettleBody', face: 'ground', facing: 'sideways', quad: [0, 0, 1, 0, 1, 1, 0, 1] },
          ],
        }) +
        '\n```',
      parts,
      W,
      H,
    );
    assert.deepEqual(regions.errors, []);
    assert.deepEqual(
      regions.surfaces.map((s) => s.face),
      ['bottom', 'all', 'upper', 'lower', 'middle', 'bottom'],
    );
    assert.equal(regions.surfaces[0].part, 'hotPlate');
    const box = round(regions.surfaces[2].quad);
    assert.deepEqual(box, round([100 / W, 200 / H, 400 / W, 200 / H, 400 / W, 600 / H, 100 / W, 600 / H]));
    assert.deepEqual(round(regions.surfaces[3].quad), box);
    assert.deepEqual(round(regions.surfaces[4].quad), box);
    assert.equal(regions.surfaces[5].facing, undefined);
    assert.deepEqual(regions.surfaces[5].quad, [0, 0, 1, 0, 1, 1, 0, 1]);
  });

  it('drops an unknown part, a bad face, too few points, a quad past the picture, and everything past the cap', () => {
    const many = Array.from({ length: TWIN_SURFACE_MAX_PER_PHOTO + 3 }, (_, i) => ({
      part: 'kettleBody',
      face: 'front',
      quad: [10 + i, 10, 50, 10, 50, 50, 10, 50],
    }));
    const { surfaces, errors } = parseTwinSurfaces(
      JSON.stringify({
        surfaces: [
          { part: 'teapot', face: 'front', quad: [10, 10, 50, 10, 50, 50, 10, 50] },
          { part: 'kettleBody', face: 'diagonal', quad: [10, 10, 50, 10, 50, 50, 10, 50] },
          { part: 'kettleBody', face: 'front', quad: [10, 10, 50, 10, 50, 50] },
          { part: 'kettleBody', face: 'front', quad: [-200, 10, 50, 10, 50, 50, -200, 50] },
          { part: 'kettleBody', face: 'front', quad: [10, 10, 50, 10, 50, H + 100, 10, H + 100] },
          // within 5 % overshoot: kept and clamped
          { part: 'kettleBody', face: 'front', quad: [-20, 10, 50, 10, 50, 50, -20, 50] },
          ...many,
        ],
      }),
      parts,
      W,
      H,
    );
    assert.equal(surfaces.length, TWIN_SURFACE_MAX_PER_PHOTO);
    assert.equal(surfaces[0].quad[0], 0);
    assert.ok(errors.some((e) => /"teapot"/.test(e)));
    assert.ok(errors.some((e) => /face "diagonal"/.test(e)));
    assert.ok(errors.some((e) => /no four-cornered quad/.test(e)));
    assert.equal(errors.filter((e) => /runs past the picture/.test(e)).length, 2);
    assert.ok(errors.some((e) => /past the cap/.test(e)));
  });

  it('reports an unreadable answer', () => {
    assert.match(parseTwinSurfaces('no json here', parts, W, H).errors[0], /no JSON/);
    assert.match(parseTwinSurfaces('{"surfaces": [1, 2}', parts, W, H).errors[0], /JSON\.parse/);
    assert.match(parseTwinSurfaces('{"answer": "none"}', parts, W, H).errors[0], /no surface list/);
    assert.deepEqual(parseTwinSurfaces('{"surfaces": []}', parts, W, H), { surfaces: [], errors: [] });
  });
});

/** A synthetic 120×160 frame: 20 °C background, a 40 °C rectangle at x 30–90, y 40–120 (thermal px),
 *  sky (−40 °C) above y = 30, and one sentinel row at y = 150. `shift` moves the rectangle. */
function frame(shift: [number, number] = [0, 0]): Float32Array {
  const t = new Float32Array(IR_GRID_WIDTH * IR_GRID_HEIGHT);
  for (let y = 0; y < IR_GRID_HEIGHT; y++) {
    for (let x = 0; x < IR_GRID_WIDTH; x++) {
      let c = 20;
      if (y < 30) c = -40;
      const rx = x - shift[0];
      const ry = y - shift[1];
      if (rx >= 30 && rx < 90 && ry >= 40 && ry < 120) c = 40;
      if (y === 150) c = -273.15;
      t[y * IR_GRID_WIDTH + x] = c;
    }
  }
  return t;
}
/** Fractions of the picture for a thermal-px rectangle. */
const quadPx = (x0: number, y0: number, x1: number, y1: number) => [
  x0 / IR_GRID_WIDTH,
  y0 / IR_GRID_HEIGHT,
  x1 / IR_GRID_WIDTH,
  y0 / IR_GRID_HEIGHT,
  x1 / IR_GRID_WIDTH,
  y1 / IR_GRID_HEIGHT,
  x0 / IR_GRID_WIDTH,
  y1 / IR_GRID_HEIGHT,
];

describe('surfaceStats', () => {
  it('reads the warm rectangle, eroded by the registration quality', () => {
    const reg = { dx: 0, dy: 0, score: 0.5, method: 'vis-mix-thermal' };
    const s = surfaceStats(quadPx(30, 40, 90, 120), frame(), reg)!;
    assert.ok(s);
    assert.equal(s.erodePx, 2);
    assert.equal(s.median, 40);
    assert.equal(s.min, 40);
    assert.equal(s.max, 40);
    assert.equal(s.excluded, 0);
    // 60×80 px minus a 2 px margin each side ≈ 56×76 pixel centres.
    assert.ok(s.n >= 55 * 75 && s.n <= 57 * 77, `n=${s.n}`);
    const wide = surfaceStats(quadPx(30, 40, 90, 120), frame(), null)!;
    assert.equal(wide.erodePx, 5);
    assert.ok(wide.n < s.n);
    assert.equal(wide.min, 40);
  });

  it('applies the visible→thermal shift, and shows the leak without it', () => {
    const shifted = frame([8, 6]);
    const q = quadPx(30, 40, 90, 120);
    const withReg = surfaceStats(q, shifted, { dx: 8, dy: 6, score: 0.6, method: 'vis-mix-thermal' })!;
    assert.equal(withReg.min, 40);
    assert.equal(withReg.median, 40);
    const without = surfaceStats(q, shifted, null)!;
    assert.equal(without.min, 20); // background pixels inside the un-shifted outline
    assert.equal(without.median, 40);
  });

  it('accepts corners in any order (a bow-tie is re-sorted about its centroid)', () => {
    const ordered = quadPx(30, 40, 90, 120);
    const crossed = [ordered[0], ordered[1], ordered[4], ordered[5], ordered[2], ordered[3], ordered[6], ordered[7]];
    assert.deepEqual(surfaceStats(crossed, frame(), null), surfaceStats(ordered, frame(), null));
  });

  it('drops sky, a half-sky outline, a sentinel row and a too-small outline', () => {
    assert.equal(surfaceStats(quadPx(10, 2, 110, 28), frame(), null), null); // all sky
    assert.equal(surfaceStats(quadPx(10, 5, 110, 50), frame(), null), null); // > 30 % sky
    assert.equal(surfaceStats(quadPx(10, 148, 110, 153), frame(), null), null); // the sentinel row dominates
    const tiny = surfaceStats(quadPx(50, 50, 58, 58), frame(), { dx: 0, dy: 0, score: 0.9 });
    assert.equal(tiny, null); // 8×8 eroded by 2 → 16 pixels < SURFACE_MIN_SAMPLE
    const small = surfaceStats(quadPx(50, 50, 61, 61), frame(), { dx: 0, dy: 0, score: 0.9 })!;
    assert.ok(small && small.n >= SURFACE_MIN_SAMPLE && small.n < 64, `n=${small?.n}`);
    // A bit of background at one edge is tolerated (< 30 %), and shows up in p10 / min.
    const edge = surfaceStats(quadPx(25, 40, 90, 120), frame(), { dx: 0, dy: 0, score: 0.9 })!;
    assert.equal(edge.min, 20);
    assert.equal(edge.median, 40);
    assert.equal(edge.excluded, 0);
    assert.equal(surfaceStats([0, 0, 1, 0, 1, 1], frame(), null), null);
  });

  it('says why a surface yielded nothing (readSurfaceStats)', () => {
    const reg = { dx: 0, dy: 0, score: 0.9 };
    assert.equal(readSurfaceStats(quadPx(10, 2, 110, 28), frame(), null).reason, 'excluded'); // all sky
    assert.equal(readSurfaceStats(quadPx(10, 5, 110, 50), frame(), null).reason, 'excluded'); // > 30 % sky
    assert.equal(readSurfaceStats(quadPx(50, 50, 58, 58), frame(), reg).reason, 'too-few'); // 16 pixels
    // A sub-pixel quad (a fraction answer misread as pixels) has no pixel centre inside it at all.
    assert.equal(
      readSurfaceStats([0.001, 0.001, 0.002, 0.001, 0.002, 0.002, 0.001, 0.002], frame(), reg).reason,
      'no-pixels',
    );
    assert.equal(readSurfaceStats([0, 0, 1, 0, 1, 1], frame(), null).reason, 'bad-quad');
    assert.equal(readSurfaceStats([NaN, 0, 1, 0, 1, 1, 0, 1], frame(), null).reason, 'bad-quad');
    const ok = readSurfaceStats(quadPx(30, 40, 90, 120), frame(), reg);
    assert.equal(ok.reason, null);
    assert.equal(ok.stats!.median, 40);
    assert.deepEqual(ok.stats, surfaceStats(quadPx(30, 40, 90, 120), frame(), reg));
  });

  it('picks the erosion from the registration', () => {
    assert.equal(erosionFor(null), 5);
    assert.equal(erosionFor(undefined), 5);
    assert.equal(erosionFor({ dx: 1, dy: 1, score: 0.4, method: 'vis-mix' }), 3);
    assert.equal(erosionFor({ dx: 1, dy: 1, score: 0.31, method: 'vis-mix-thermal' }), 2);
    assert.equal(erosionFor({ dx: 1, dy: 1, score: 0.2, method: 'vis-thermal' }), 3);
    assert.equal(erosionFor({ dx: 1, dy: 1 }), 3);
  });
});

describe('frame and scene helpers', () => {
  it('framePercentiles ignores sky and sentinel pixels', () => {
    const p = framePercentiles(frame())!;
    assert.equal(p.p02, 20);
    assert.equal(p.p98, 40);
    assert.equal(framePercentiles(new Float32Array([-273.15, -40])), null);
  });

  it('isMixedSurface uses the wider of 3 K and a quarter of the scene span', () => {
    assert.equal(isMixedSurface(20, 22.9, 0), false);
    assert.equal(isMixedSurface(20, 23.1, 0), true);
    assert.equal(isMixedSurface(20, 26, 40), false); // 6 K spread, scene span 40 → limit 10
    assert.equal(isMixedSurface(20, 31, 40), true);
  });

  it('sceneSpanOf leaves apparent readings out of the span, so a sky-reflecting window does not hide a mixed wall', () => {
    const walls = [{ median: 18 }, { median: 21 }, { median: 24 }];
    const window = { median: -12, apparent: true };
    assert.equal(sceneSpanOf(walls), 6);
    assert.equal(sceneSpanOf([...walls, window]), 6);
    // A wall with an 8 K p10–p90 band is mixed either way; with the window in the span it was not.
    assert.equal(isMixedSurface(16, 24, sceneSpanOf([...walls, window])), true);
    assert.equal(isMixedSurface(16, 24, 36), false);
    // Only apparent surfaces: their span is all there is. None: 0.
    assert.equal(sceneSpanOf([window, { median: 30, apparent: true }]), 42);
    assert.equal(sceneSpanOf([]), 0);
    assert.equal(sceneSpanOf([{ median: 5 }]), 0);
  });

  it('surfaceRange rounds outward by a degree and never spans less than 4 K', () => {
    assert.deepEqual(surfaceRange([21.3, 24.8, 30.1]), [20, 32]);
    assert.deepEqual(surfaceRange([21.3, 21.6]), [19.5, 23.5]);
    assert.deepEqual(surfaceRange([]), [0, 40]);
  });
});

describe('pickTwinPhotos', () => {
  it('keeps a small set whole and spaces a large one evenly from first to last', () => {
    assert.deepEqual(pickTwinPhotos(3), [1, 2, 3]);
    const picked = pickTwinPhotos(30, 8);
    assert.equal(picked.length, 8);
    assert.equal(picked[0], 1);
    assert.equal(picked[picked.length - 1], 30);
  });

  it("follows the owner's viewing order: photo 1 is the first on the strip (§31.3)", () => {
    // Slot 6 (stored photo 7) dragged to the front of a 10-photo set.
    const order = [6, 0, 1, 2, 3, 4, 5, 7, 8, 9];
    assert.deepEqual(pickTwinPhotos(3, 8, [2, 0, 1]), [3, 1, 2]);
    const picked = pickTwinPhotos(10, 8, order);
    assert.equal(picked.length, 8);
    assert.equal(picked[0], 7);
    assert.equal(picked[picked.length - 1], 10);
    // Evenly spaced along the strip, not along the capture order.
    assert.deepEqual(picked, [7, 1, 3, 4, 5, 6, 9, 10]);
    // An order for another count is not this set's: capture order.
    assert.deepEqual(pickTwinPhotos(3, 8, [1, 0]), [1, 2, 3]);
  });
});

describe('imageSize', () => {
  it('reads a PNG header and a JPEG SOF', () => {
    const png = Buffer.alloc(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    assert.deepEqual(imageSize(png), { width: 640, height: 480 });
    const jpg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03,
    ]);
    assert.deepEqual(imageSize(jpg), { width: 640, height: 480 });
    assert.equal(imageSize(Buffer.from([1, 2, 3])), null);
  });
});

describe('revision (§19)', () => {
  const stored = {
    kind: 'building',
    version: TWIN_BUILDING_VERSION,
    source: 'photos',
    photosSent: [1, 4, 7],
    code: good.code,
    parts: good.parts,
    views: [
      { photo: 4, x: -30, y: 1.6, z: 25, targetX: 0, targetY: 6, targetZ: 0 },
      { photo: 1, x: 5.123, y: 1.6, z: 45, targetX: 0, targetY: 6, targetZ: 0 },
      { photo: 9, x: 1, y: 1, z: 1, targetX: 0, targetY: 0, targetZ: 0 },
    ],
    blocker: null,
    revisions: [{ feedback: 'The roof is flat.', changes: 'Made the roof flat.', at: 1000 }],
  };

  it('asks for `changes` in a strict-mode schema the first build does not carry', () => {
    walkStrict(TWIN_BUILDING_REVISION_JSON_SCHEMA, 'root');
    assert.equal(TWIN_BUILDING_REVISION_JSON_SCHEMA.properties.changes.type, 'string');
    assert.ok((TWIN_BUILDING_REVISION_JSON_SCHEMA.required as readonly string[]).includes('changes'));
    assert.ok(!(TWIN_BUILDING_JSON_SCHEMA.required as readonly string[]).includes('changes'));
    assert.ok(!('changes' in TWIN_BUILDING_JSON_SCHEMA.properties));
  });

  it('builds the revision prompt on the build prompt: the model as it stands, the notes, the new note', () => {
    const photos = [
      { photo: 1, width: 1600, height: 900 },
      { photo: 4, width: 1600, height: 900 },
      { photo: 7, width: 1600, height: 900 },
    ];
    const plain = buildTwinBuildingPrompt({ photos });
    assert.doesNotMatch(plain.system, /REVISING/);
    assert.match(plain.system, /code, views\.$/);
    assert.match(plain.user, /Write the model\.$/);

    const { system, user } = buildTwinBuildingPrompt({
      photos,
      revision: {
        code: stored.code,
        parts: stored.parts,
        views: stored.views,
        note: 'There are eight columns, not six.',
        history: stored.revisions,
      },
    });
    // The rules the model wrote under stay; the revision adds how to revise and asks for `changes`.
    assert.ok(system.startsWith(plain.system.slice(0, plain.system.indexOf('Answer with JSON only'))));
    assert.match(system, /REVISING/);
    assert.match(system, /Keep everything the note does not mention as it is/);
    assert.match(system, /the owner's word beats your reading of the photos/);
    assert.match(system, /WHOLE program again/);
    assert.match(system, /code, views, changes\.$/);
    assert.match(user, /Photo 3 \(photo 7 of the set\)/);
    assert.ok(user.includes('```javascript\n' + stored.code + '\n```'));
    assert.match(user, /- mainBlock — wall — the raised office wing/);
    // Views renumbered by position (stored 4 → photo 2), ordered, rounded; one of a picture not sent dropped.
    assert.match(user, /- photo 1: camera at \(5\.12, 1\.6, 45\), looking at \(0, 6, 0\)\n- photo 2: camera at \(-30,/);
    assert.doesNotMatch(user, /photo 9|\(1, 1, 1\)/);
    assert.match(
      user,
      /Notes already applied, oldest first:\n1\. "The roof is flat\." — answered: "Made the roof flat\."/,
    );
    // Worded for whichever model revises — the owner may send the note to another one (§20).
    assert.match(system, /has already been written — its program is in the message, perhaps by another modeller/);
    assert.doesNotMatch(user, /you wrote|you answered|Where you judged/);
    assert.match(user, /Where each camera was judged to stand \(metres\):/);
    assert.match(user, /The owner's note on the model as it stands:\n"""\nThere are eight columns, not six\.\n"""/);
    assert.match(user, /Revise the model: fix what the note says, keep the rest/);
    assert.doesNotMatch(user, /Write the model\./);
  });

  it("tells the model the owner's words use the set's numbers where the brackets differ (§31.7)", () => {
    const photos = [
      { photo: 7, width: 640, height: 480, place: 1 },
      { photo: 4, width: 640, height: 480, place: 6 },
    ];
    const asked = buildTwinBuildingPrompt({ photos, instructions: 'The chimney in photo 6 is on the left.' });
    assert.match(asked.user, /'photo N' in the owner's words means the photo of the set with that number/);
    // No brackets, or nothing of the owner's to read: nothing to say.
    const plain = buildTwinBuildingPrompt({
      photos: [{ photo: 7, width: 640, height: 480, place: 1 }],
      instructions: 'x',
    });
    assert.doesNotMatch(plain.user, /in the owner's words/);
    assert.doesNotMatch(buildTwinBuildingPrompt({ photos }).user, /in the owner's words/);
  });

  it("names a set's photos by their places on the owner's strip (§31.3)", () => {
    const { user } = buildTwinBuildingPrompt({
      photos: [
        { photo: 7, width: 640, height: 480, place: 1 },
        { photo: 1, width: 640, height: 480, place: 2 },
        { photo: 4, width: 640, height: 480, place: 6 },
      ],
    });
    assert.match(user, /^Photo 1: a landscape/m);
    assert.match(user, /^Photo 2: a landscape/m);
    assert.match(user, /^Photo 3 \(photo 6 of the set\): a landscape/m);
    assert.doesNotMatch(user, /photo 7 of the set/);
  });

  it('leaves out the notes block when there is no earlier round', () => {
    const { user } = buildTwinBuildingPrompt({
      photos: [{ photo: 1, width: 640, height: 480 }],
      revision: { code: 'x', parts: [], views: [], note: 'Taller.', history: [] },
    });
    assert.doesNotMatch(user, /Notes already applied/);
    assert.doesNotMatch(user, /Where each camera was judged to stand/);
    assert.match(user, /- \(the program declares no named parts\)/);
  });

  it('cuts over-long free text to its cap, with a note (§31.6)', () => {
    const long = (n: number) => 'x'.repeat(n);
    const big = {
      ...good,
      subject: long(500),
      name: long(200),
      description: long(3000),
      parts: [{ ...good.parts[0], description: long(400) }, good.parts[1]],
    };
    const { answer, errors } = parseTwinBuildingCode(JSON.stringify(big));
    assert.equal(answer!.subject.length, TWIN_SUBJECT_MAX);
    assert.equal(answer!.name.length, TWIN_NAME_MAX);
    assert.equal(answer!.description.length, TWIN_DESCRIPTION_MAX);
    assert.equal(answer!.parts[0].description.length, TWIN_PART_DESCRIPTION_MAX);
    assert.equal(answer!.parts[1].description, 'six columns under it');
    assert.ok(errors.includes('subject is 500 characters → cut to 300'), errors.join('; '));
    assert.ok(errors.some((e) => /the description of part "mainBlock" is 400 characters → cut to 200/.test(e)));
    const refused = parseTwinBuildingCode(JSON.stringify({ ...good, renderable: false, reason: long(900), code: '' }));
    assert.equal(refused.answer!.reason.length, TWIN_REASON_MAX);
  });

  it('reads the answer’s `changes`, cut to the cap, and gives an empty one when there is none', () => {
    assert.equal(parseTwinBuildingCode(JSON.stringify(good)).changes, '');
    assert.equal(
      parseTwinBuildingCode(JSON.stringify({ ...good, changes: '  Added two columns. ' })).changes,
      'Added two columns.',
    );
    const long = parseTwinBuildingCode(JSON.stringify({ ...good, changes: 'x'.repeat(5000) })).changes;
    assert.equal(long.length, TWIN_REVISION_CHANGES_MAX);
    assert.equal(parseTwinBuildingCode('no json').changes, '');
  });

  it('reads the owner’s note: normalised, refused when empty, not text or too long', () => {
    assert.deepEqual(readRevisionNote('  The roof is flat.\r\n\r\n\r\n\r\nAnd the door is left.  \n'), {
      note: 'The roof is flat.\n\nAnd the door is left.',
    });
    assert.ok('error' in readRevisionNote('   \n  '));
    assert.ok('error' in readRevisionNote(42));
    assert.ok('error' in readRevisionNote(null));
    assert.deepEqual(readRevisionNote('a'.repeat(TWIN_REVISION_NOTE_MAX)), {
      note: 'a'.repeat(TWIN_REVISION_NOTE_MAX),
    });
    const tooLong = readRevisionNote('a'.repeat(TWIN_REVISION_NOTE_MAX + 1));
    assert.ok('error' in tooLong && /too long/.test(tooLong.error));
  });

  it('reads a stored thread round by round and keeps only the newest', () => {
    assert.deepEqual(readRevisions(undefined), []);
    assert.deepEqual(
      readRevisions([null, 'x', { feedback: '' }, { feedback: ' Flat roof ', changes: 3, at: 'soon' }]),
      [{ feedback: 'Flat roof', changes: '', at: 0 }],
    );
    // The model a round went to (§20) is kept when the round says; a non-string is dropped, not stored.
    assert.deepEqual(
      readRevisions([
        { feedback: 'a', changes: '', at: 1, modelKey: 'gpt52' },
        { feedback: 'b', changes: '', at: 2, modelKey: 7 },
      ]),
      [
        { feedback: 'a', changes: '', at: 1, modelKey: 'gpt52' },
        { feedback: 'b', changes: '', at: 2 },
      ],
    );
    const many = Array.from({ length: TWIN_REVISION_HISTORY_MAX + 3 }, (_, i) => ({
      feedback: `note ${i}`,
      changes: '',
      at: i,
    }));
    const kept = readRevisions(many);
    assert.equal(kept.length, TWIN_REVISION_HISTORY_MAX);
    assert.equal(kept[0].feedback, 'note 3');
    assert.equal(kept[kept.length - 1].feedback, `note ${TWIN_REVISION_HISTORY_MAX + 2}`);
  });

  it('builds only on a shown scene program of the current contract, made the same way', () => {
    const ok = readRevisableTwin(stored, 'photos');
    assert.ok('twin' in ok);
    assert.deepEqual(ok.twin.photosSent, [1, 4, 7]);
    assert.equal(ok.twin.code, stored.code);
    assert.deepEqual(ok.twin.parts, stored.parts);
    assert.equal(ok.twin.views.length, 3);
    assert.deepEqual(ok.twin.revisions, stored.revisions);
    // A record from before the source field is a photo set's.
    const { source: _s, ...unsourced } = stored;
    assert.ok('twin' in readRevisableTwin(unsourced, 'photos'));

    const refused = (raw: unknown, source: 'photos' | 'orbit' = 'photos') => {
      const r = readRevisableTwin(raw, source);
      assert.ok('error' in r, JSON.stringify(raw)?.slice(0, 80));
      return r.error;
    };
    assert.match(refused(undefined), /build one first/);
    assert.match(refused({ version: 1, scene: {} }), /build one first/); // a fixed-camera record
    assert.match(refused({ ...stored, version: 5 }), /earlier analysis/);
    assert.match(refused({ ...stored, code: '' }), /no model to revise/);
    assert.match(refused({ ...stored, blocker: 'Not confident.' }), /no model to revise/);
    assert.match(refused(stored, 'orbit'), /built another way/);
    assert.match(refused({ ...stored, photosSent: [0, 'x'] }), /which pictures/);
  });

  it('cleans what it reads: bad parts and views dropped, repeated pictures once, at most eight', () => {
    const r = readRevisableTwin(
      {
        ...stored,
        photosSent: [3, 3, 1, 2, 4, 5, 6, 7, 8, 9, 10],
        parts: [{ name: 'a', kind: 'granite' }, { kind: 'wall' }, null],
        views: [
          { photo: 1, x: 1, y: 2, z: 3, targetX: 0, targetY: 0 },
          { photo: 2, x: 1, y: 2, z: 3, targetX: 0, targetY: 0, targetZ: 0, extra: 1 },
        ],
      },
      'photos',
    );
    assert.ok('twin' in r);
    assert.deepEqual(r.twin.photosSent, [3, 1, 2, 4, 5, 6, 7, 8]);
    assert.deepEqual(r.twin.parts, [{ name: 'a', kind: 'other', description: '' }]);
    assert.deepEqual(r.twin.views, [{ photo: 2, x: 1, y: 2, z: 3, targetX: 0, targetY: 0, targetZ: 0 }]);
  });
});

describe("the owner's request (§20)", () => {
  const photos = [
    { photo: 1, width: 1600, height: 900 },
    { photo: 2, width: 1600, height: 900 },
  ];
  const request = 'Only the main building — leave out the trees.\nThe entrance is set back 2 m.';

  it('is quoted and ruled on only when there is one', () => {
    const plain = buildTwinBuildingPrompt({ photos });
    assert.doesNotMatch(plain.system, /OWNER'S REQUEST/);
    assert.doesNotMatch(plain.user, /owner's request/);
    assert.deepEqual(buildTwinBuildingPrompt({ photos, instructions: '  \n  ' }), plain);

    const { system, user } = buildTwinBuildingPrompt({ photos, title: 'Library', instructions: `  ${request} ` });
    // The rules the model writes under stay; the request adds how far it reaches, before the answer line.
    assert.ok(system.startsWith(plain.system.slice(0, plain.system.indexOf('Answer with JSON only'))));
    assert.match(system, /THE OWNER'S REQUEST\./);
    assert.match(system, /the owner's word wins/);
    assert.match(system, /the API, the units, the parts rule and the answer format above stay as they are/);
    assert.match(system, /code, views\.$/);
    assert.ok(system.indexOf("THE OWNER'S REQUEST") < system.indexOf('Answer with JSON only'));
    assert.match(user, new RegExp(`The owner's request for this model:\n"""\n${request}\n"""`));
    assert.ok(user.indexOf('"Library"') < user.indexOf("owner's request for this model"));
    assert.match(user, /Write the model, following the owner's request\.$/);
  });

  it('still stands in a revision, quoted once, before the model as it stands', () => {
    const revision = { code: good.code, parts: good.parts, views: [], note: 'Taller.', history: [] };
    const { system, user } = buildTwinBuildingPrompt({ photos, instructions: request, revision });
    assert.match(system, /THE OWNER'S REQUEST\./);
    assert.match(system, /REVISING\./);
    assert.match(system, /The request the model was first built to still stands\./);
    assert.ok(system.indexOf("THE OWNER'S REQUEST") < system.indexOf('REVISING'));
    assert.equal(user.split("The owner's request for this model").length, 2);
    assert.ok(user.indexOf("owner's request for this model") < user.indexOf('The model as it stands'));
    assert.match(user, /Revise the model: fix what the note says/);
    // Without a request, the revision does not speak of one.
    const bare = buildTwinBuildingPrompt({ photos, revision });
    assert.doesNotMatch(bare.system, /first built to/);
  });

  it('is read like a note, but absent or blank means none rather than an error', () => {
    assert.deepEqual(readBuildInstructions(undefined), { instructions: null });
    assert.deepEqual(readBuildInstructions(null), { instructions: null });
    assert.deepEqual(readBuildInstructions(' \r\n\t '), { instructions: null });
    assert.deepEqual(readBuildInstructions('  Only the house.\r\n\r\n\r\nNo trees.  '), {
      instructions: 'Only the house.\n\nNo trees.',
    });
    assert.ok('error' in readBuildInstructions(7));
    assert.ok('error' in readBuildInstructions({ text: 'x' }));
    assert.deepEqual(readBuildInstructions('a'.repeat(TWIN_INSTRUCTIONS_MAX)), {
      instructions: 'a'.repeat(TWIN_INSTRUCTIONS_MAX),
    });
    const tooLong = readBuildInstructions('a'.repeat(TWIN_INSTRUCTIONS_MAX + 1));
    assert.ok('error' in tooLong && /too long/.test(tooLong.error));
  });

  it('rides on the stored twin a revision reads, with the model that wrote it', () => {
    const stored = {
      kind: 'building',
      version: TWIN_BUILDING_VERSION,
      source: 'photos',
      photosSent: [1, 2],
      code: good.code,
      parts: good.parts,
      views: [],
      blocker: null,
      model: 'gpt-5.2',
      modelKey: 'gpt52',
      instructions: ` ${request} `,
    };
    const r = readRevisableTwin(stored, 'photos');
    assert.ok('twin' in r);
    assert.equal(r.twin.instructions, request);
    assert.equal(r.twin.modelKey, 'gpt52');
    assert.equal(r.twin.model, 'gpt-5.2');
    // A record from before the choice: no key, no request.
    const { modelKey: _k, instructions: _i, ...older } = stored;
    const o = readRevisableTwin({ ...older, model: 'deepseek-flash' }, 'photos');
    assert.ok('twin' in o);
    assert.equal(o.twin.instructions, null);
    assert.equal(o.twin.modelKey, null);
    assert.equal(o.twin.model, 'deepseek-flash');
    const long = readRevisableTwin({ ...stored, instructions: 'b'.repeat(TWIN_INSTRUCTIONS_MAX + 50) }, 'photos');
    assert.ok('twin' in long);
    assert.equal(long.twin.instructions?.length, TWIN_INSTRUCTIONS_MAX);
  });
});

describe('an endpoint without a response schema (§30.4)', () => {
  const photos = [
    { photo: 1, width: 1600, height: 1200 },
    { photo: 3, width: 1600, height: 1200 },
  ];

  it("spells the answer's shape out, the views' fields included, only when asked to", () => {
    const plain = buildTwinBuildingPrompt({ photos });
    assert.doesNotMatch(plain.system, /The shape of the JSON object/);
    assert.match(plain.system, /following the schema:/);
    const spelled = buildTwinBuildingPrompt({ photos, shapeInPrompt: true });
    assert.match(spelled.system, /following the shape below:/);
    assert.ok(spelled.system.endsWith(describeJsonSchema(TWIN_BUILDING_JSON_SCHEMA)));
    for (const field of ['"views"', '"photo"', '"targetX"', '"targetZ"', '"confidence"', '"subjectKind"'])
      assert.ok(spelled.system.includes(field), field);
    assert.equal(spelled.user, plain.user);
  });

  it('spells out the revision shape, changes included, for a revision', () => {
    const revision = { code: 'api.box(1,1,1,0,0,0);', parts: [], views: [], note: 'taller', history: [] };
    const { system } = buildTwinBuildingPrompt({ photos, revision, shapeInPrompt: true });
    assert.ok(system.endsWith(describeJsonSchema(TWIN_BUILDING_REVISION_JSON_SCHEMA)));
    assert.ok(system.includes('"changes"'));
  });

  it('reads a confidence written as text or as a percentage, with a note', () => {
    const read = (confidence: unknown) => parseTwinBuildingCode(JSON.stringify({ ...good, confidence }), [1, 2, 3]);
    assert.equal(read('0.8').answer!.confidence, 0.8);
    assert.match(read('0.8').errors.join(';'), /confidence "0.8" is text/);
    assert.equal(read('80%').answer!.confidence, 0.8);
    assert.equal(read(85).answer!.confidence, 0.85);
    assert.match(read(85).errors.join(';'), /percentage/);
    assert.equal(read(0.8).errors.length, 0);
    assert.equal(read('high').answer!.confidence, 0);
    assert.match(read('high').errors.join(';'), /not a number/);
    // A number just over 1 overshoots the scale; it is not 1.5 % — that would block a usable twin.
    assert.equal(read(1.5).answer!.confidence, 1);
    assert.match(read(1.5).errors.join(';'), /above 1 → 1/);
    assert.equal(read(8).answer!.confidence, 1);
    assert.equal(twinBuildingBlocker(read(8).answer!), null);
    assert.equal(read(-0.2).answer!.confidence, 0);
  });

  it('reads views written as an object keyed by photo, and a photo number written as text', () => {
    const keyed = {
      ...good,
      views: {
        '1': { x: 5, y: 1.6, z: 45, targetX: 0, targetY: 6, targetZ: 0 },
        '2': { photo: '2', x: -30, y: 1.6, z: 25, targetX: 0, targetY: 6, targetZ: 0 },
      },
    };
    const { answer, errors } = parseTwinBuildingCode(JSON.stringify(keyed), [1, 3, 5]);
    assert.deepEqual(
      answer!.views.map((v) => v.photo),
      [1, 3],
    );
    assert.match(errors.join(';'), /keyed by photo/);
  });

  it('reads views keyed as the prompt names pictures, from 0, and never lets a key override a photo number', () => {
    const at = (x: number) => ({ x, y: 1.6, z: 30, targetX: 0, targetY: 6, targetZ: 0 });
    const named = parseTwinBuildingCode(
      JSON.stringify({ ...good, views: { 'photo 1': at(1), photo_2: at(2) } }),
      [1, 3],
    );
    assert.deepEqual(
      named.answer!.views.map((v) => [v.photo, v.x]),
      [
        [1, 1],
        [3, 2],
      ],
    );
    const zero = parseTwinBuildingCode(JSON.stringify({ ...good, views: { '0': at(1), '1': at(2) } }), [1, 3]);
    assert.deepEqual(
      zero.answer!.views.map((v) => [v.photo, v.x]),
      [
        [1, 1],
        [3, 2],
      ],
    );
    assert.match(zero.errors.join(';'), /keys from 0/);
    const own = parseTwinBuildingCode(JSON.stringify({ ...good, views: { '1': { ...at(7), photo: '2' } } }), [1, 3]);
    assert.deepEqual(
      own.answer!.views.map((v) => [v.photo, v.x]),
      [[3, 7]],
    );
    const none = parseTwinBuildingCode(JSON.stringify({ ...good, views: { front: at(1) } }), [1, 3]);
    assert.equal(none.answer!.views.length, 0);
    assert.match(none.errors.join(';'), /without photo numbers/);
  });

  it('notes a missing or malformed views, which leaves no photo a standpoint', () => {
    const { views: _drop, ...noViews } = good;
    assert.match(parseTwinBuildingCode(JSON.stringify(noViews)).errors.join(';'), /views missing/);
    assert.match(parseTwinBuildingCode(JSON.stringify({ ...good, views: 'none' })).errors.join(';'), /not a list/);
  });
});

// Phase-1 answers a model really gave, in the photo-set eval's format (scripts/evalTwinBuilding.ts, §32):
// what the parser makes of them may change only on purpose.
describe('real phase-1 answers (__fixtures__/twinBuilding)', () => {
  const dir = join(__dirname, '__fixtures__', 'twinBuilding');
  // What the eval keeps (--keep) is an answer that parsed and was not blocked; the answers written down here
  // are held to more: the repairs they need, a view for every photo, and every part they declare built.
  const known: Record<string, { repairs: RegExp[] }> = {
    // DeepSeek's reasons run past the cap (§31.6).
    'house-deepseek-1.json': { repairs: [/^reason is 406 characters → cut to 300$/] },
    'house-deepseek-2.json': { repairs: [/^reason is 674 characters → cut to 300$/] },
  };
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    it(`reads ${file}`, () => {
      const f = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
        text: string;
        photos: { photo: number; place?: number }[];
      };
      const places = f.photos.every((p) => typeof p.place === 'number') ? f.photos.map((p) => p.place!) : undefined;
      const parsed = parseTwinBuildingCode(
        f.text,
        f.photos.map((p) => p.photo),
        places,
      );
      assert.ok(parsed.answer, parsed.errors.join('; '));
      assert.equal(twinBuildingBlocker(parsed.answer), null);
      const want = known[file];
      if (!want) return;
      assert.equal(parsed.errors.length, want.repairs.length, parsed.errors.join('; '));
      want.repairs.forEach((re, i) => assert.match(parsed.errors[i], re));
      assert.equal(parsed.answer.views.length, f.photos.length);
      // Every part the answer declares is one its program builds with api.part.
      const inCode = extractPartsFromCode(parsed.answer.code).map((p) => p.name);
      assert.deepEqual(
        parsed.answer.parts.map((p) => p.name).filter((n) => !inCode.includes(n)),
        [],
      );
    });
  }
});

describe('tracing photos again (§32)', () => {
  const row = (photo: number, extra: Record<string, unknown> = {}) => ({
    photo,
    status: 'ok',
    picture: 'vis',
    ...extra,
  });
  const surface = (photo: number, median: number, band = 1, extra: Record<string, unknown> = {}) => ({
    part: 'mainBlock',
    face: 'front',
    photo,
    median,
    p10: median - band / 2,
    p90: median + band / 2,
    ...extra,
  });
  const stored = {
    kind: 'building',
    version: TWIN_BUILDING_VERSION,
    source: 'photos',
    photosSent: [1, 3],
    ...good,
    surfaceModelKey: 'gpt52',
    blocker: null,
    thermal: {
      photos: [row(1), row(3, { status: 'model-failed', error: 'timed out after 150s' })],
      surfaces: [surface(1, 10)],
      range: [9, 13],
    },
  };

  it('reads what the tracer needs off the stored twin, and its measured record', () => {
    const r = readRevisableTwin(stored, 'photos');
    assert.ok('twin' in r);
    assert.equal(r.twin.subject, good.subject);
    assert.equal(r.twin.subjectKind, 'building');
    assert.equal(r.twin.name, good.name);
    assert.equal(r.twin.surfaceModelKey, 'gpt52');
    assert.deepEqual(
      r.twin.thermal?.photos.map((p) => [p.photo, p.status]),
      [
        [1, 'ok'],
        [3, 'model-failed'],
      ],
    );
    assert.deepEqual(r.twin.thermal?.range, [9, 13]);
    // A twin without measurements, or without a word on who traced it.
    const bare = readRevisableTwin(
      { ...stored, thermal: null, surfaceModelKey: undefined, subjectKind: 'x' },
      'photos',
    );
    assert.ok('twin' in bare);
    assert.equal(bare.twin.thermal, null);
    assert.equal(bare.twin.surfaceModelKey, null);
    assert.equal(bare.twin.subjectKind, 'other');
  });

  it('reads a stored measured record, dropping the rows nothing could be merged against', () => {
    const t = readStoredThermal({
      photos: [row(1), { status: 'ok' }, null, row(2.5), row(4, { status: 3 }), row(5, { camera: null })],
      surfaces: [surface(1, 10), { photo: 1, median: 'x', p10: 1, p90: 2 }, surface(5, 20), null],
      tracedAt: 1234,
    });
    assert.deepEqual(
      t?.photos.map((p) => p.photo),
      [1, 5],
    );
    assert.deepEqual(
      t?.surfaces.map((s) => s.median),
      [10, 20],
    );
    // No range stored: the medians'.
    assert.deepEqual(t?.range, [9, 21]);
    assert.equal(t?.tracedAt, 1234);
    assert.equal(readStoredThermal(null), null);
    assert.equal(readStoredThermal({ photos: [] }), null);
  });

  it('keeps the measurements of a revision that left the program, its parts and its standpoints alone', () => {
    const was = { code: good.code, parts: good.parts, views: good.views };
    assert.equal(twinTracingUnchanged(was, { ...was }), true);
    // The views in another order are the same views.
    assert.equal(twinTracingUnchanged(was, { ...was, views: [...good.views].reverse() }), true);
    assert.equal(twinTracingUnchanged(was, { ...was, code: `${good.code}\n` }), false);
    assert.equal(
      twinTracingUnchanged(was, {
        ...was,
        parts: [{ ...good.parts[0], description: 'the office wing' }, good.parts[1]],
      }),
      false,
    );
    assert.equal(twinTracingUnchanged(was, { ...was, views: [{ ...good.views[0], x: 6 }, good.views[1]] }), false);
    assert.equal(twinTracingUnchanged(was, { ...was, views: good.views.slice(1) }), false);
  });

  it('takes a list of the measured photos, each once', () => {
    assert.deepEqual(readRetrace([3, 1, 3], [1, 3, 5]), { photos: [3, 1] });
    const refused = (raw: unknown) => {
      const r = readRetrace(raw, [1, 3, 5]);
      assert.ok('error' in r, JSON.stringify(raw));
      return r.error;
    };
    assert.match(refused([]), /Say which/);
    assert.match(refused('3'), /Say which/);
    assert.match(refused([2]), /Only the photos the twin measured/);
    assert.match(refused([1.5]), /Only the photos/);
    assert.match(refused(['1']), /Only the photos/);
    assert.match(refused(Array.from({ length: 9 }, () => 1)), /At most 8/);
  });

  it('works the mixed flags and the range out over the whole record', () => {
    // A 5 K band over a scene of 2 K is mixed; the stale flag on the other surface goes.
    const narrow = finishTwinThermal([row(1)], [surface(1, 10, 5), surface(1, 12, 1, { mixed: true })]);
    assert.deepEqual(
      narrow.surfaces.map((s) => !!s.mixed),
      [true, false],
    );
    assert.deepEqual(narrow.range, [9, 13]);
    // An apparent reading does not widen the span: the band is still mixed.
    const sky = finishTwinThermal(
      [row(1)],
      [surface(1, 10, 5), surface(1, 12), surface(1, -30, 1, { apparent: true })],
    );
    assert.equal(sky.surfaces[0].mixed, true);
    // No surface read: the photos' own spans set the scale.
    assert.deepEqual(finishTwinThermal([row(1, { p02: 2, p98: 30 })], []).range, [1, 31]);
  });

  it("puts the photos traced again in their old rows' places, and keeps every other photo's", () => {
    const old = {
      photos: [row(1), row(3, { status: 'model-failed' }), row(5)],
      surfaces: [surface(1, 10, 5), surface(3, 99), surface(5, 12)],
    };
    // Photo 3 traced again, with a surface far warmer than the rest; photo 7 was not in the record.
    const fresh = { photos: [row(3), row(7)], surfaces: [surface(7, 41), surface(3, 40)] };
    const merged = mergeTwinThermal(old, fresh);
    assert.deepEqual(
      merged.photos.map((p) => [p.photo, p.status]),
      [
        [1, 'ok'],
        [3, 'ok'],
        [5, 'ok'],
        [7, 'ok'],
      ],
    );
    // The old surfaces of photo 3 are gone, and the surfaces go in the photos' order.
    assert.deepEqual(
      merged.surfaces.map((s) => [s.photo, s.median]),
      [
        [1, 10],
        [3, 40],
        [5, 12],
        [7, 41],
      ],
    );
    // Photo 1's 5 K band was mixed against a 2 K scene; against a 31 K one it is not.
    assert.equal(
      finishTwinThermal(old.photos, old.surfaces.slice(0, 1).concat(old.surfaces[2])).surfaces[0].mixed,
      true,
    );
    assert.equal(merged.surfaces[0].mixed, undefined);
    assert.deepEqual(merged.range, [9, 42]);
    // Nothing stored: the fresh tracing is the record.
    assert.deepEqual(
      mergeTwinThermal(null, fresh).photos.map((p) => p.photo),
      [3, 7],
    );
  });

  it('keeps the half of a photo that its calls lost this time: the surfaces read before, the camera fitted before', () => {
    const camera = { position: [0, 1.6, 20] };
    const old = {
      photos: [
        // Surfaces read, landmarks timed out: offered again for its camera.
        row(1, { camera: null, cameraNote: 'landmark model failed: timed out after 150s', unread: [{ part: 'a' }] }),
        // Surfaces timed out, camera fitted: offered again for its surfaces.
        row(2, { status: 'model-failed', error: 'timed out after 150s', camera, landmarks: [{ part: 'a' }] }),
      ],
      surfaces: [surface(1, 10), surface(1, 12)],
    };
    // This time photo 1's camera fits and its surfaces time out; photo 2's surfaces read and its landmarks fail.
    const fresh = {
      photos: [
        row(1, { status: 'model-failed', error: 'timed out after 150s', camera, landmarks: [{ part: 'b' }] }),
        row(2, { camera: null, cameraNote: 'landmark model failed: HTTP 500' }),
      ],
      surfaces: [surface(2, 20)],
    };
    const merged = mergeTwinThermal(old, fresh);
    const [one, two] = merged.photos as Record<string, unknown>[];
    // Photo 1: the old surfaces and status, the new camera.
    assert.equal(one.status, 'ok');
    assert.equal(one.error, undefined);
    assert.deepEqual(one.unread, [{ part: 'a' }]);
    assert.deepEqual(one.camera, camera);
    assert.deepEqual(one.landmarks, [{ part: 'b' }]);
    assert.equal(one.cameraNote, undefined);
    // Photo 2: the new surfaces and status, the old camera.
    assert.equal(two.status, 'ok');
    assert.deepEqual(two.camera, camera);
    assert.deepEqual(two.landmarks, [{ part: 'a' }]);
    assert.equal(two.cameraNote, undefined);
    assert.deepEqual(
      merged.surfaces.map((s) => [s.photo, s.median]),
      [
        [1, 10],
        [1, 12],
        [2, 20],
      ],
    );
    // Both calls failing again: the surfaces stay as they were, and the camera half says why it failed now.
    const again = mergeTwinThermal(old, {
      photos: [
        row(1, {
          status: 'model-failed',
          error: 'timed out after 150s',
          camera: null,
          cameraNote: 'landmark model failed: HTTP 500',
        }),
      ],
      surfaces: [],
    });
    assert.equal(again.photos[0].status, 'ok');
    assert.equal((again.photos[0] as Record<string, unknown>).cameraNote, 'landmark model failed: HTTP 500');
    assert.equal(again.surfaces.length, 2);
  });
});
