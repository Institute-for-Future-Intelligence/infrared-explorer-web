import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TWIN_CATALOGUE_SIZES,
  TWIN_OBJECT_KINDS,
  TWIN_SCENE_JSON_SCHEMA,
  TWIN_SCENE_REVISION_JSON_SCHEMA,
  TWIN_UNDRAWN_KINDS,
  applyTwinCorrections,
  buildTwinScenePrompt,
  carryTwinCorrections,
  describeJsonSchema,
  describeSensorTilt,
  extractJsonObject,
  foldedCorrectionsKey,
  parseTwinScene,
  readRevisableTwinScene,
  readTwinCorrections,
  twinRenderBlocker,
  type TwinScene,
} from './twinScene';

const good = {
  renderable: true,
  reason: '',
  confidence: 0.9,
  camera: { pitch: 'slightly_above', distanceHint: 'close' },
  support: { kind: 'table', farEdgeY: 0.6 },
  objects: [
    {
      id: 'obj1',
      kind: 'beaker',
      label: '250 mL beaker',
      confidence: 0.95,
      bbox: { x: 0.3, y: 0.2, w: 0.3, h: 0.5 },
      footprintY: 0.7,
      sizeCm: { height: 9.5, width: 7 },
      material: 'glass',
      fill: { level: 0.6, content: 'water' },
      restingOn: 'obj2',
      tiltDeg: 0,
      heldOver: '',
      thermal: { role: 'heated', note: 'warm liquid' },
    },
    {
      id: 'obj2',
      kind: 'tripod',
      label: 'tripod',
      confidence: 0.8,
      bbox: { x: 0.25, y: 0.65, w: 0.4, h: 0.25 },
      footprintY: 0.9,
      sizeCm: { height: 20, width: 15 },
      material: 'metal',
      fill: { level: 0, content: '' },
      restingOn: 'support',
      tiltDeg: 0,
      heldOver: '',
      thermal: { role: 'ambient', note: '' },
    },
  ],
};

describe('parseTwinScene', () => {
  it('accepts a well-formed answer with no repairs', () => {
    const { scene, errors } = parseTwinScene(JSON.stringify(good));
    assert.ok(scene);
    assert.deepEqual(errors, []);
    assert.equal(scene.objects.length, 2);
    assert.equal(scene.objects[0].restingOn, 'obj2');
    assert.equal(twinRenderBlocker(scene), null);
  });

  it('unwraps a fenced answer and rescales 0..1000 boxes', () => {
    const boxed = {
      ...good,
      objects: [{ ...good.objects[1], bbox: { x: 250, y: 650, w: 400, h: 250 }, footprintY: 900 }],
    };
    const text = '```json\n' + JSON.stringify(boxed) + '\n```';
    assert.ok(extractJsonObject(text));
    const { scene, errors } = parseTwinScene(text);
    assert.ok(scene);
    assert.ok(errors.some((e) => e.includes('rescaled')));
    const b = scene.objects[0].bbox;
    assert.ok(Math.abs(b.x - 0.25) < 1e-9 && Math.abs(b.w - 0.4) < 1e-9);
    assert.ok(Math.abs(scene.objects[0].footprintY - 0.9) < 1e-9);
  });

  it('drops an object with an unknown kind and repairs a dangling restingOn', () => {
    const bad = {
      ...good,
      objects: [
        { ...good.objects[0], restingOn: 'ghost' },
        { ...good.objects[1], kind: 'spaceship' },
      ],
    };
    const { scene, errors } = parseTwinScene(JSON.stringify(bad));
    assert.ok(scene);
    assert.equal(scene.objects.length, 1);
    assert.equal(scene.objects[0].restingOn, 'support');
    assert.ok(errors.some((e) => e.includes('unknown kind')));
    assert.ok(errors.some((e) => e.includes('names no object')));
    // An object standing on itself is as dangling as a missing id.
    const selfRef = parseTwinScene(JSON.stringify({ ...good, objects: [{ ...good.objects[1], restingOn: 'obj2' }] }));
    assert.equal(selfRef.scene!.objects[0].restingOn, 'support');
    assert.ok(selfRef.errors.some((e) => e.includes('names no object')));
  });

  it('keeps a held object with its tilt and target, clears a dangling or meaningless heldOver, and defaults old answers', () => {
    const kettle = {
      ...good.objects[1],
      id: 'k',
      kind: 'kettle',
      restingOn: 'held',
      tiltDeg: -140,
      heldOver: 'obj2',
    };
    const { scene, errors } = parseTwinScene(JSON.stringify({ ...good, objects: [good.objects[1], kettle] }));
    assert.ok(scene);
    assert.deepEqual(errors, []);
    const k = scene.objects[1];
    assert.equal(k.restingOn, 'held');
    assert.equal(k.tiltDeg, -90); // clamped
    assert.equal(k.heldOver, 'obj2');

    const dangling = parseTwinScene(JSON.stringify({ ...good, objects: [{ ...kettle, heldOver: 'nobody' }] }));
    assert.equal(dangling.scene!.objects[0].heldOver, '');
    assert.ok(dangling.errors.some((e) => e.includes('heldOver')));

    // heldOver on something that stands on the table means nothing and is dropped silently.
    const standing = parseTwinScene(
      JSON.stringify({ ...good, objects: [good.objects[1], { ...kettle, restingOn: 'support' }] }),
    );
    assert.equal(standing.scene!.objects[1].heldOver, '');

    // A version-1 answer without the new fields still parses, upright and over nothing.
    const { tiltDeg: _t, heldOver: _h, ...old } = good.objects[1];
    const legacy = parseTwinScene(JSON.stringify({ ...good, objects: [old] }));
    assert.equal(legacy.scene!.objects[0].tiltDeg, 0);
    assert.equal(legacy.scene!.objects[0].heldOver, '');
  });

  it('clamps a box that runs off the image and drops one with no area', () => {
    const bad = {
      ...good,
      objects: [
        { ...good.objects[0], bbox: { x: 0.8, y: 0.8, w: 0.5, h: 0.5 } },
        { ...good.objects[1], bbox: { x: 0.5, y: 0.5, w: 0, h: 0.2 } },
      ],
    };
    const { scene, errors } = parseTwinScene(JSON.stringify(bad));
    assert.ok(scene);
    assert.equal(scene.objects.length, 1);
    const b = scene.objects[0].bbox;
    assert.ok(Math.abs(b.x + b.w - 1) < 1e-9 && Math.abs(b.y + b.h - 1) < 1e-9);
    assert.ok(errors.some((e) => e.includes('no area')));
  });

  it('returns null for an answer with no JSON', () => {
    const { scene, errors } = parseTwinScene('I cannot see any objects.');
    assert.equal(scene, null);
    assert.equal(errors.length, 1);
  });
});

describe('twinRenderBlocker', () => {
  it('honours the model verdict', () => {
    const { scene } = parseTwinScene(JSON.stringify({ ...good, renderable: false, reason: 'photo of a screen' }));
    assert.equal(twinRenderBlocker(scene!), 'photo of a screen');
  });

  it('blocks when only people/devices were seen, or a box fills the frame', () => {
    const people = { ...good, objects: [{ ...good.objects[1], kind: 'laptop' }] };
    assert.match(twinRenderBlocker(parseTwinScene(JSON.stringify(people)).scene!) ?? '', /enough confidence/);
    const wall = { ...good, objects: [{ ...good.objects[1], bbox: { x: 0, y: 0, w: 1, h: 0.95 } }] };
    assert.match(twinRenderBlocker(parseTwinScene(JSON.stringify(wall)).scene!) ?? '', /whole frame/);
  });

  it('blocks when nothing stands on an unknown support', () => {
    const floating = {
      ...good,
      support: { kind: 'unknown', farEdgeY: -1 },
      objects: [{ ...good.objects[0], restingOn: 'held' }],
    };
    assert.match(twinRenderBlocker(parseTwinScene(JSON.stringify(floating)).scene!) ?? '', /supporting surface/);
  });
});

describe('contract shape', () => {
  it('schema requires every property (strict mode) and the prompt mentions both images when thermal is attached', () => {
    const props = Object.keys(TWIN_SCENE_JSON_SCHEMA.properties);
    assert.deepEqual([...TWIN_SCENE_JSON_SCHEMA.required].sort(), props.sort());
    const item = TWIN_SCENE_JSON_SCHEMA.properties.objects.items;
    assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort());
    const p = buildTwinScenePrompt({
      frameStats: { minC: 20, maxC: 80, meanC: 30 },
      palette: 'iron',
      withThermal: true,
    });
    assert.match(p.user, /Image 2 is the thermal/);
    assert.match(p.user, /max 80\.0 °C/);
    const q = buildTwinScenePrompt({ frameStats: null, palette: null, withThermal: false });
    assert.doesNotMatch(q.user, /Image 2/);
  });

  it("quotes the owner's request (§20) and bounds it by the photo, only when there is one", () => {
    const base = { frameStats: null, palette: null, withThermal: true };
    const plain = buildTwinScenePrompt(base);
    assert.doesNotMatch(plain.user, /asked this of the analysis/);
    const blank = buildTwinScenePrompt({ ...base, instructions: '  \n ' });
    assert.equal(blank.user, plain.user);
    const p = buildTwinScenePrompt({ ...base, title: 'Kettle', instructions: 'The left beaker holds 80 °C water.' });
    assert.equal(p.system, plain.system);
    assert.match(p.user, /asked this of the analysis:\n"""\nThe left beaker holds 80 °C water\.\n"""/);
    assert.match(p.user, /Never report an object the photo does not show because the request mentions it/);
    // After the owner's other context, before the closing instruction.
    assert.ok(p.user.indexOf('"Kettle"') < p.user.indexOf('asked this'));
    assert.match(p.user, /Analyse the scene and return the JSON\.$/);
  });

  it('spells the shape out for an endpoint that takes no schema (shapeInPrompt), every field and value of it', () => {
    const base = { frameStats: null, palette: null, withThermal: true };
    const plain = buildTwinScenePrompt(base);
    assert.match(plain.system, /matching the schema you were given/);
    assert.doesNotMatch(plain.system, /"footprintY"/);
    const spelled = buildTwinScenePrompt({ ...base, shapeInPrompt: true });
    assert.equal(spelled.user, plain.user);
    assert.match(spelled.system, /of exactly the shape given after these rules/);
    const shape = describeJsonSchema(TWIN_SCENE_JSON_SCHEMA);
    assert.ok(spelled.system.endsWith(shape));
    // Every field of the scene and of each object, by name; every object kind, quoted as a value.
    const item = TWIN_SCENE_JSON_SCHEMA.properties.objects.items;
    for (const name of [...Object.keys(TWIN_SCENE_JSON_SCHEMA.properties), ...Object.keys(item.properties)])
      assert.match(shape, new RegExp(`^\\s*"${name}": `, 'm'));
    for (const kind of TWIN_OBJECT_KINDS) assert.ok(shape.includes(`"${kind}"`), kind);
    assert.match(shape, /"pitch": "level" \| "slightly_above" \| "high_angle" \| "top_down" — level = /);
    assert.match(shape, /"objects": \[ — Every physical object of note/);
    assert.match(shape, /"bbox": \{\n\s+"x": number — Left edge/);
    // DeepSeek's json_object mode insists the prompt say "json" somewhere.
    assert.match(spelled.system, /JSON/);
  });
});

describe('revision (§24)', () => {
  // A pour like the bottle-and-kettle bake-off frame: the bottle read as a petri dish, the kettle held over
  // it, a stray box with a cup on it.
  const pour = {
    ...good,
    objects: [
      { ...good.objects[1], id: 'obj1', kind: 'petri_dish', label: 'Translucent green plastic bottle' },
      {
        ...good.objects[1],
        id: 'obj2',
        kind: 'kettle',
        label: 'Metal kettle tilted to pour',
        restingOn: 'held',
        tiltDeg: 45,
        heldOver: 'obj1',
      },
      { ...good.objects[1], id: 'obj3', kind: 'other', label: 'a box' },
      { ...good.objects[1], id: 'obj4', kind: 'cup', label: 'a cup on the box', restingOn: 'obj3' },
    ],
  };
  const scene = parseTwinScene(JSON.stringify(pour)).scene!;
  const errorOf = (r: ReturnType<typeof readRevisableTwinScene>) => ('error' in r ? r.error : '');

  it('reads the corrections the client wrote field by field, ignoring what the client does not write', () => {
    const c = readTwinCorrections({
      pitchDeg: 120,
      objects: {
        obj1: { kind: 'bottle', spec: '  500 mL ', hidden: 'yes', restingOn: '' },
        obj2: { kind: 'spaceship' },
        obj3: { hidden: true },
        obj4: 'nonsense',
      },
    });
    assert.equal(c.pitchDeg, 85);
    assert.deepEqual(
      [...c.objects],
      [
        ['obj1', { kind: 'bottle', spec: '500 mL' }],
        ['obj3', { hidden: true }],
      ],
    );
    assert.deepEqual(readTwinCorrections(null), { pitchDeg: null, objects: new Map() });
    assert.equal(readTwinCorrections({ pitchDeg: Number.NaN }).pitchDeg, null);
  });

  it('shows the model the analysis with the kinds, supports and hidden objects applied, and says each in words', () => {
    const c = readTwinCorrections({
      pitchDeg: 20,
      objects: {
        obj1: { kind: 'bottle' },
        obj3: { hidden: true },
        obj2: { restingOn: 'support', spec: 'electric kettle' },
        ghost: { kind: 'cup' },
      },
    });
    const { scene: seen, notes } = applyTwinCorrections(scene, c);
    assert.deepEqual(
      seen.objects.map((o) => [o.id, o.kind, o.restingOn, o.heldOver]),
      [
        ['obj1', 'bottle', 'support', ''],
        // Put down, so over nothing.
        ['obj2', 'kettle', 'support', ''],
        // It stood on the hidden box, and falls to the table.
        ['obj4', 'cup', 'support', ''],
      ],
    );
    // The stored analysis is untouched.
    assert.equal(scene.objects.length, 4);
    assert.equal(scene.objects[0].kind, 'petri_dish');
    assert.deepEqual(notes, [
      'obj1 ("Translucent green plastic bottle"): the owner made it a bottle (the analysis said petri_dish).',
      'obj2 ("Metal kettle tilted to pour"): the owner stood it on the table (the analysis had it held in the air).',
      'obj2 ("Metal kettle tilted to pour"): the owner chose its size, "electric kettle", which it keeps while it stays a kettle.',
      'obj3 ("a box"): the owner hid it as not part of the setup, so it is left out of the analysis above.',
      'The owner set the camera tilt to 20° below horizontal; the 3D scene uses that, whatever camera.pitch says.',
    ]);
    // What is held over a hidden object is over nothing; a support that names a hidden object, the object
    // itself or nothing is not applied.
    const other = applyTwinCorrections(
      scene,
      readTwinCorrections({
        objects: { obj1: { hidden: true }, obj4: { restingOn: 'obj1' }, obj3: { restingOn: 'obj3' } },
      }),
    );
    assert.deepEqual(
      other.scene.objects.map((o) => [o.id, o.restingOn, o.heldOver]),
      [
        ['obj2', 'held', ''],
        ['obj3', 'support', ''],
        ['obj4', 'obj3', ''],
      ],
    );
    assert.equal(other.notes.length, 1);
  });

  it('carries the tilt, and a size while its object keeps its id and the kind the size was chosen for', () => {
    const c = readTwinCorrections({
      pitchDeg: 12,
      objects: {
        obj1: { kind: 'bottle', spec: '1 L' },
        obj2: { spec: 'electric kettle' },
        obj3: { hidden: true, spec: 'box' },
        obj4: { spec: '250 mL' },
      },
    });
    // The revision made obj1 the bottle the owner said, the kettle a pot, and dropped the box and the cup.
    const after: TwinScene = {
      ...scene,
      objects: [
        { ...scene.objects[0], kind: 'bottle' },
        { ...scene.objects[1], kind: 'pot' },
      ],
    };
    assert.deepEqual(carryTwinCorrections(c, scene, after), { pitchDeg: 12, objects: { obj1: { spec: '1 L' } } });
    // Nothing changed: every size chosen for the kind its object still is stays; the hidden box's does not.
    assert.deepEqual(carryTwinCorrections(c, scene, scene), {
      pitchDeg: 12,
      objects: { obj2: { spec: 'electric kettle' }, obj4: { spec: '250 mL' } },
    });
    assert.equal(
      carryTwinCorrections(readTwinCorrections({ objects: { obj1: { kind: 'bottle' } } }), scene, after),
      null,
    );
  });

  it('keys only what a revision folds in, whatever order the corrections were stored in', () => {
    const a = readTwinCorrections({
      pitchDeg: 10,
      objects: { obj2: { restingOn: 'support' }, obj1: { kind: 'bottle', spec: '1 L' } },
    });
    const b = readTwinCorrections({
      objects: {
        obj1: { kind: 'bottle' },
        obj2: { restingOn: 'support', spec: 'electric kettle' },
        obj4: { spec: 'x' },
      },
    });
    assert.equal(foldedCorrectionsKey(a), foldedCorrectionsKey(b));
    assert.notEqual(
      foldedCorrectionsKey(a),
      foldedCorrectionsKey(readTwinCorrections({ objects: { obj1: { kind: 'bottle' } } })),
    );
    assert.notEqual(
      foldedCorrectionsKey(a),
      foldedCorrectionsKey(
        readTwinCorrections({
          objects: { obj1: { kind: 'bottle' }, obj2: { restingOn: 'support' }, obj3: { hidden: true } },
        }),
      ),
    );
  });

  it("says the phone's tilt sets the camera only when the owner set none", () => {
    const none = readTwinCorrections(null);
    assert.equal(
      describeSensorTilt(none, { pitchDeg: -23.4 }),
      "The phone's tilt sensor put the camera 23° below horizontal, and the 3D scene uses that, whatever camera.pitch says.",
    );
    assert.equal(describeSensorTilt(readTwinCorrections({ pitchDeg: 30 }), { pitchDeg: -23.4 }), null);
    assert.equal(describeSensorTilt(none, null), null);
    assert.equal(describeSensorTilt(none, { pitchDeg: 'down' }), null);
    // A phone looking up is level as far as the table is concerned (the client clamps the same way).
    assert.match(describeSensorTilt(none, { pitchDeg: 10 }) ?? '', / 0° below/);
  });

  it('reads the twin a revision builds on, or says why there is none', () => {
    const stored = {
      version: 2,
      model: 'gpt-5.6-luna',
      modelKey: 'gpt56',
      recordingIndex: 15,
      stability: { stable: true, maxShiftPx: 1, p95ShiftPx: 1, sampled: 50, referenceIndex: 15 },
      scene: pour,
      blocker: null,
      registration: { dx: 1.5, dy: -2, score: 0.8, method: 'mix' },
      instructions: '  The bottle is being filled.  ',
      revisions: [
        { feedback: 'Remove the box.', changes: 'Removed it.', at: 5, modelKey: 'gpt56' },
        { changes: 'no note' },
      ],
    };
    const read = readRevisableTwinScene(stored, { objects: { obj3: { hidden: true } } });
    assert.ok('twin' in read);
    const t = read.twin;
    assert.equal(t.recordingIndex, 15);
    assert.deepEqual(t.scene, scene);
    assert.equal(t.storedKey, JSON.stringify(pour));
    assert.deepEqual([...t.corrections.objects.keys()], ['obj3']);
    assert.deepEqual(t.stability, stored.stability);
    assert.deepEqual(t.registration, { dx: 1.5, dy: -2, score: 0.8, method: 'mix' });
    assert.deepEqual(t.revisions, [{ feedback: 'Remove the box.', changes: 'Removed it.', at: 5, modelKey: 'gpt56' }]);
    assert.equal(t.instructions, 'The bottle is being filled.');
    assert.deepEqual([t.modelKey, t.model], ['gpt56', 'gpt-5.6-luna']);
    // A twin the render gate blocked may be revised: the note is how the owner says what the model missed.
    assert.ok('twin' in readRevisableTwinScene({ ...stored, blocker: 'No supporting surface was found.' }, null));
    const bare = readRevisableTwinScene({ ...stored, registration: null, instructions: '  ', modelKey: 7 }, null);
    assert.ok('twin' in bare);
    assert.deepEqual([bare.twin.registration, bare.twin.instructions, bare.twin.modelKey], [null, null, null]);
    assert.match(errorOf(readRevisableTwinScene(null, null)), /no fixed-camera twin/);
    assert.match(
      errorOf(readRevisableTwinScene({ kind: 'building', code: 'x', version: 6 }, null)),
      /no fixed-camera twin/,
    );
    assert.match(errorOf(readRevisableTwinScene({ ...stored, recordingIndex: 0 }, null)), /which frame/);
    assert.match(errorOf(readRevisableTwinScene({ ...stored, recordingIndex: 2.5 }, null)), /which frame/);
    assert.match(errorOf(readRevisableTwinScene({ ...stored, scene: 'nope' }, null)), /no analysis/);
  });

  it('revises on top of the analysis prompt: the rules stay, the analysis as the owner sees it and the note come after', () => {
    const base = { frameStats: { minC: 20, maxC: 80, meanC: 30 }, palette: 'iron', withThermal: true };
    const build = buildTwinScenePrompt(base);
    assert.doesNotMatch(build.system, /REVISING/);
    const seen = applyTwinCorrections(
      scene,
      readTwinCorrections({ pitchDeg: 20, objects: { obj1: { kind: 'bottle' }, obj3: { hidden: true } } }),
    );
    const revision = {
      scene: seen.scene,
      corrections: seen.notes,
      camera: null,
      note: 'The kettle pours into the bottle.',
      history: [
        { feedback: 'Remove the box.', changes: 'Removed it.', at: 1 },
        { feedback: 'Taller.', changes: '', at: 2 },
      ],
    };
    const p = buildTwinScenePrompt({ ...base, revision });
    assert.ok(p.system.startsWith(build.system));
    assert.match(p.system, /\n\nREVISING\. This photo has already been analysed/);
    assert.match(
      p.system,
      /Answer with the WHOLE JSON again — every object, not only the ones you changed — and add "changes"/,
    );
    assert.match(p.system, /How the 3D scene is built from the analysis/);
    assert.doesNotMatch(p.system, /still stands/);
    // The user text is the analysis's, up to its closing instruction, which the revision replaces.
    assert.ok(p.user.startsWith(build.user.replace(/Analyse the scene and return the JSON\.$/, '')));
    assert.doesNotMatch(p.user, /Analyse the scene and return the JSON/);
    const open = p.user.indexOf("The analysis as it stands, with the owner's corrections applied:\n```json\n");
    assert.ok(open > 0);
    const from = p.user.indexOf('```json\n', open) + '```json\n'.length;
    const shown = JSON.parse(p.user.slice(from, p.user.indexOf('\n```', from)));
    assert.deepEqual(
      shown.objects.map((o: { id: string; kind: string }) => [o.id, o.kind]),
      [
        ['obj1', 'bottle'],
        ['obj2', 'kettle'],
        ['obj4', 'cup'],
      ],
    );
    assert.match(
      p.user,
      /The owner's corrections, made by hand in the 3D scene:\n- obj1 \("Translucent green plastic bottle"\): the owner made it a bottle/,
    );
    assert.match(
      p.user,
      /Notes already applied, oldest first:\n1\. "Remove the box\." — answered: "Removed it\."\n2\. "Taller\."\n/,
    );
    assert.match(
      p.user,
      /The owner's note on the 3D scene as it stands:\n"""\nThe kettle pours into the bottle\.\n"""\nRevise the analysis: fix what the note says, keep the rest, and answer with the whole JSON again, changes included\.$/,
    );
    // Numbers are cut to three decimals.
    const long = buildTwinScenePrompt({
      ...base,
      revision: { ...revision, scene: { ...scene, objects: [{ ...scene.objects[0], footprintY: 0.123456789 }] } },
    });
    assert.match(long.user, /"footprintY": 0\.123\b/);

    // The request still stands; the tilt the sensor sets is said after the corrections.
    const camera =
      "The phone's tilt sensor put the camera 23° below horizontal, and the 3D scene uses that, whatever camera.pitch says.";
    const asked = buildTwinScenePrompt({
      ...base,
      instructions: 'The bottle is being filled.',
      revision: { ...revision, camera },
    });
    assert.match(asked.system, / The request the analysis was first made to still stands\./);
    assert.ok(asked.user.indexOf('asked this of the analysis') < asked.user.indexOf('The analysis as it stands'));
    assert.ok(asked.user.indexOf(camera) > asked.user.indexOf("The owner's corrections, made by hand"));
    assert.ok(asked.user.indexOf(camera) < asked.user.indexOf('Notes already applied'));

    // For an endpoint without a schema, the shape spelled out is the revision's, changes included, last.
    const spelled = buildTwinScenePrompt({ ...base, shapeInPrompt: true, revision });
    assert.ok(spelled.system.endsWith(describeJsonSchema(TWIN_SCENE_REVISION_JSON_SCHEMA)));
    assert.match(spelled.system, /"changes": string — One or two plain sentences/);
    assert.ok(spelled.system.indexOf('REVISING') < spelled.system.indexOf('The shape of the JSON object'));
  });

  it('tells a revision how the 3D scene sizes things — by the client solver’s own catalogue, kind for kind', () => {
    const solver = readFileSync(join(__dirname, '..', '..', 'src', 'utils', 'twinSolver.ts'), 'utf8');
    const from = solver.indexOf('export const NOMINAL_SIZES');
    const catalogue = [...solver.slice(from, solver.indexOf('\n};', from)).matchAll(/^ {2}(\w+): \[/gm)].map(
      (m) => m[1],
    );
    assert.ok(catalogue.length > 10, JSON.stringify(catalogue));
    assert.deepEqual(Object.keys(TWIN_CATALOGUE_SIZES).sort(), catalogue.sort());
    const undrawn = solver.match(/NON_RENDERED_KINDS[^=]*= new Set\(\[([^\]]*)\]\)/)![1];
    assert.deepEqual(
      [...TWIN_UNDRAWN_KINDS].sort(),
      undrawn
        .split(',')
        .map((k) => k.trim().replace(/'/g, ''))
        .filter(Boolean)
        .sort(),
    );
    const p = buildTwinScenePrompt({
      frameStats: null,
      palette: null,
      withThermal: true,
      revision: { scene, corrections: [], note: 'The kettle is huge.', history: [] },
    });
    assert.match(
      p.system,
      /its KIND wherever the kind has a catalogue size: beaker 50–1000 mL, 6–14\.5 cm tall; .*; petri_dish 9 cm across, 1\.5 cm tall; kettle 22 cm tall, 16 cm across; .*; thermometer 30 cm long\. For these kinds sizeCm changes nothing/,
    );
    assert.match(p.system, /Every other kind \(bottle, cup, pot, metal_block, ice, other\) is as big as its sizeCm\./);
    assert.match(
      p.system,
      /"other" is a plain box, and hand, person, phone, laptop, screen stay in the list but are never drawn/,
    );
    assert.match(p.system, /Never claim a change the 3D scene will not show\./);
    assert.match(p.system, /Keep them, unless the note is about what one of them did/);
  });

  it('asks a revision for its changes and reads them back; a first analysis has none', () => {
    const props = Object.keys(TWIN_SCENE_REVISION_JSON_SCHEMA.properties);
    assert.deepEqual([...TWIN_SCENE_REVISION_JSON_SCHEMA.required].sort(), props.sort());
    assert.ok(props.includes('changes'));
    assert.ok(!Object.keys(TWIN_SCENE_JSON_SCHEMA.properties).includes('changes'));
    const answer = parseTwinScene(JSON.stringify({ ...pour, changes: `  Made obj1 a bottle. ${'x'.repeat(900)}` }));
    assert.ok(answer.changes.startsWith('Made obj1 a bottle.'));
    assert.equal(answer.changes.length, 600);
    assert.equal(parseTwinScene(JSON.stringify(pour)).changes, '');
    assert.equal(parseTwinScene('I cannot see any objects.').changes, '');
  });
});
