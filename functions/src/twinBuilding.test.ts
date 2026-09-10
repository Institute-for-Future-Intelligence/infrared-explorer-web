import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CODE_CHARS,
  TWIN_BUILDING_JSON_SCHEMA,
  buildTwinBuildingPrompt,
  checkSceneCode,
  imageSize,
  parseTwinBuildingCode,
  pickTwinPhotos,
  twinBuildingBlocker,
} from './twinBuilding';

const good = {
  renderable: true,
  reason: '',
  confidence: 0.8,
  name: 'two-storey raised office wing',
  description: 'A long wing on columns with a glazed hall beneath.',
  code: "api.box(30, 10.5, 12, 0, 3.5, 0, 'wall');\nfor (let i = 0; i < 6; i++) api.cylinder(0.3, 3.5, -12 + i * 5, 0, 5, 'column');",
  views: [
    { photo: 1, x: 5, y: 1.6, z: 45, targetX: 0, targetY: 6, targetZ: 0 },
    { photo: 3, x: -30, y: 1.6, z: 25, targetX: 0, targetY: 6, targetZ: 0 },
  ],
};

describe('TWIN_BUILDING_JSON_SCHEMA', () => {
  it('is strict-mode shaped: every property required, no additionalProperties, no range keywords', () => {
    const walk = (node: any, path: string) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object') {
        assert.equal(node.additionalProperties, false, `${path} additionalProperties`);
        const keys = Object.keys(node.properties ?? {});
        assert.deepEqual([...(node.required ?? [])].sort(), [...keys].sort(), `${path} required`);
        for (const k of keys) walk(node.properties[k], `${path}.${k}`);
      }
      if (node.type === 'array') walk(node.items, `${path}[]`);
      for (const bad of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'])
        assert.ok(!(bad in node), `${path} uses ${bad}`);
    };
    walk(TWIN_BUILDING_JSON_SCHEMA, 'root');
  });
});

describe('buildTwinBuildingPrompt', () => {
  it('describes the frame API and announces every photo', () => {
    const { system, user } = buildTwinBuildingPrompt({
      photos: [
        { photo: 1, width: 1600, height: 900 },
        { photo: 4, width: 480, height: 640 },
      ],
      title: 'Library',
    });
    assert.match(system, /function build\(THREE, scene, api\)/);
    assert.match(system, /api\.box\(/);
    assert.match(system, /'glass'/);
    assert.match(system, /faces \+z/);
    assert.match(user, /2 photos/);
    assert.match(user, /Photo 1: a landscape picture \(1600×900 px\)/);
    assert.match(user, /Photo 4: a portrait picture/);
    assert.match(user, /"Library"/);
  });
});

describe('checkSceneCode', () => {
  it('passes a plain building program and refuses reaching outside', () => {
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
    assert.match(checkSceneCode('const p = parent;')!, /parent/);
    assert.equal(checkSceneCode('const mesh = api.box(1,1,1,0,0,0,"wall"); mesh.parent.remove(mesh);'), null);
    assert.match(checkSceneCode('for (;;) {}')!, /endless/);
  });
});

describe('parseTwinBuildingCode', () => {
  it('accepts a well-formed answer', () => {
    const { answer, errors } = parseTwinBuildingCode(JSON.stringify(good), [1, 2, 3]);
    assert.deepEqual(errors, []);
    assert.ok(answer);
    assert.equal(answer!.renderable, true);
    assert.equal(answer!.code, good.code);
    assert.equal(answer!.views.length, 2);
    assert.equal(twinBuildingBlocker(answer!), null);
  });

  it('unwraps fences and a function header the model added anyway', () => {
    const wrapped = {
      ...good,
      code: '```javascript\nfunction build(THREE, scene, api) {\n' + good.code + '\n}\n```',
    };
    const { answer } = parseTwinBuildingCode(JSON.stringify(wrapped));
    assert.equal(answer!.code, good.code);
  });

  it('turns a forbidden program into a non-renderable answer with the reason', () => {
    const bad = { ...good, code: "fetch('https://evil')" };
    const { answer, errors } = parseTwinBuildingCode(JSON.stringify(bad));
    assert.equal(answer!.renderable, false);
    assert.equal(answer!.code, '');
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

  it('gates on confidence and renderable', () => {
    const shy = { ...good, confidence: 0.2 };
    assert.match(twinBuildingBlocker(parseTwinBuildingCode(JSON.stringify(shy)).answer!)!, /confident/);
    const not = { ...good, renderable: false, reason: 'It is a lab bench.' };
    const { answer } = parseTwinBuildingCode(JSON.stringify(not));
    assert.equal(answer!.code, '');
    assert.equal(twinBuildingBlocker(answer!), 'It is a lab bench.');
    assert.equal(parseTwinBuildingCode('nothing here').answer, null);
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
