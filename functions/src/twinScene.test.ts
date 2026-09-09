import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TWIN_SCENE_JSON_SCHEMA,
  buildTwinScenePrompt,
  extractJsonObject,
  parseTwinScene,
  twinRenderBlocker,
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
});
