import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTwinBuildingCode } from '../../../../functions/src/twinBuilding';
import { TWIN_FRAME_HTML } from './twinFrame';
import { TWIN_API_JS } from './twinFrameApi';
import { TWIN_GEOMETRY_JS, describeSettled, readSettled } from './twinFrameGeometry';
import { runTwinProgram } from './twinProgramNode';

const near = (a: number, b: number, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const partsOf = (run: ReturnType<typeof runTwinProgram>) =>
  Object.fromEntries(run.parts.map((p) => [p.name, `${p.meshes} ${[...p.kinds].sort().join('/')}`]));

describe('TWIN_API_JS', () => {
  it('is spliced into the frame page as written, the pitched shapes with it', () => {
    assert.ok(!TWIN_API_JS.includes('`'));
    assert.ok(!TWIN_API_JS.includes('${'));
    assert.ok(TWIN_FRAME_HTML.includes(TWIN_API_JS.split('__GEOMETRY_JS__').join(TWIN_GEOMETRY_JS)));
    assert.doesNotMatch(TWIN_FRAME_HTML, /__API_JS__|__GEOMETRY_JS__/);
  });
});

describe('runTwinProgram', () => {
  it('builds named parts with the builders, each mesh of its part or of the kind it was given', () => {
    const run = runTwinProgram(
      [
        "const walls = api.part('mainBlock', 'wall', 'the house');",
        'walls.box(10, 6, 8, 0, 0, 0);',
        "walls.box(1.2, 1.4, 0.1, 2, 2, 4, 'glass');",
        "api.part('roof', 'roof').gable(10.4, 3, 8.4, 0, 6, 0);",
        "api.box(20, 0.1, 20, 0, -0.1, 0, 'pavement');",
      ].join('\n'),
      ['mainBlock', 'roof'],
    );
    assert.equal(run.error, null);
    assert.equal(run.stoppedAt, null);
    assert.equal(run.meshes, 4);
    assert.deepEqual(partsOf(run), { mainBlock: '2 glass/wall', roof: '1 roof', unnamed: '1 pavement' });
    // It stands, and its roof covers its walls: nothing to set down or report.
    assert.equal(readSettled(run.settled), null);
  });

  it('sets down what floats and reports a roof short of its walls, as the frame does', () => {
    const run = runTwinProgram(
      [
        "api.part('mainBlock', 'wall').box(10, 6, 8, 0, 0, 0);",
        "api.part('roof', 'roof').gable(8, 3, 8, 0, 6, 0);",
        "api.part('shed', 'wall').box(2, 2, 2, 12, 1.5, 0);",
      ].join('\n'),
      ['mainBlock', 'roof', 'shed'],
    );
    const settled = readSettled(run.settled);
    assert.ok(settled);
    assert.equal(settled.moved.length, 1);
    assert.deepEqual(settled.moved[0].parts, ['shed']);
    near(settled.moved[0].dy, -1.5);
    assert.deepEqual(
      settled.uncovered.map((u) => u.part),
      ['roof'],
    );
    near(settled.uncovered[0].sides.left!, 1);
    near(settled.uncovered[0].sides.right!, 1);
    assert.match(describeSettled(settled)!, /shed down 1\.5 m.*The roof of roof leaves the walls under it bare/);
  });

  it('claims raw THREE as adopt() does: by a declared name up the tree, else unnamed, of its material’s kind', () => {
    const run = runTwinProgram(
      [
        "const g = new THREE.Group(); g.name = 'Porch Roof';",
        "const m = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 2), api.material('roof'));",
        'm.position.set(0, 0.1, 6); g.add(m); scene.add(g);',
        'scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));',
      ].join('\n'),
      ['porchRoof'],
    );
    assert.equal(run.error, null);
    assert.deepEqual(partsOf(run), { porchRoof: '1 roof', unnamed: '1 other' });
  });

  it('says why nothing was built, and where a program that built something stopped', () => {
    assert.match(runTwinProgram('this is not ( javascript').error!, /^The program does not parse: /);
    assert.equal(runTwinProgram('const x = 1;').error, 'The program added nothing to the scene.');
    assert.equal(
      runTwinProgram("throw new Error('no photos of the back')").error,
      'The program failed while building: no photos of the back',
    );
    // The document is the frame's, not Node's: a program that reaches for it stops here.
    const partial = runTwinProgram("api.part('a', 'wall').box(1, 1, 1, 0, 0, 0); document.createElement('canvas');");
    assert.equal(partial.error, null);
    assert.match(partial.stoppedAt!, /document is not defined/);
    assert.equal(partial.meshes, 1);
  });

  it('keeps the program away from the process, and stops one that never ends', () => {
    // What the program can reach, written into a part's name: nothing of Node, not even through the
    // global's constructor.
    const reach = runTwinProgram(
      [
        'let escape;',
        "try { escape = this.constructor.constructor('return typeof process')(); } catch (e) { escape = 'blocked'; }",
        'const seen = [typeof process, typeof require, typeof fetch, typeof setTimeout, escape];',
        "api.part(seen.join(' '), 'wall').box(1, 1, 1, 0, 0, 0);",
      ].join('\n'),
    );
    assert.equal(reach.error, null);
    assert.equal(reach.parts.length, 1);
    assert.match(reach.parts[0].name, /^undefined undefined undefined undefined (undefined|blocked)$/);
    const forever = runTwinProgram("api.part('a', 'wall').box(1, 1, 1, 0, 0, 0); for (;;) {}", [], 300);
    assert.equal(forever.error, 'The program ran for more than 0.3 s.');
    assert.ok(forever.ms < 5000, `${forever.ms} ms`);
    // A fresh context each time: what one program did to the context is gone for the next.
    runTwinProgram("Array.prototype.forEach = null; api.part('a', 'wall').box(1, 1, 1, 0, 0, 0);");
    assert.equal(runTwinProgram("api.part('a', 'wall').box(1, 1, 1, 0, 0, 0);").meshes, 1);
  });

  it('leaves three and the API as the frame leaves them: out of the program’s reach, forgiving a Path', () => {
    // In the frame they live in a module; a program assigning their names makes globals of its own, and
    // three's namespace does not take assignments.
    const run = runTwinProgram(
      [
        'num = 3; dim = 2; place = null; settleScene = null; THREE.Mesh = null;',
        "api.part('mainBlock', 'wall').box(4, 3, 4, 0, 0, 0);",
        "api.part('shed', 'wall').box(1, 1, 1, 6, 2, 0);",
      ].join('\n'),
    );
    assert.equal(run.error, null);
    assert.equal(run.stoppedAt, null);
    assert.equal(run.meshes, 2);
    assert.equal(readSettled(run.settled)?.moved.length, 1);
    // An outline drawn as a THREE.Path, extruded as if it were a Shape.
    const path = runTwinProgram(
      [
        'const outline = new THREE.Path();',
        'outline.moveTo(0, 0); outline.lineTo(4, 0); outline.lineTo(4, 3); outline.lineTo(0, 3); outline.lineTo(0, 0);',
        "const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(outline, { depth: 0.2 }), api.material('wall'));",
        "api.part('gableWall', 'wall').add(mesh);",
      ].join('\n'),
    );
    assert.equal(path.error, null);
    assert.equal(path.stoppedAt, null);
    assert.deepEqual(partsOf(path), { gableWall: '1 wall' });
  });

  // Phase-1 answers a model really gave (functions/src/__fixtures__/twinBuilding, the photo-set eval's
  // format): every program the eval kept runs (--keep keeps only those); the ones written down here run to
  // the end, build every part they declare, and what the frame would say of them holds.
  const dir = fileURLToPath(new URL('../../../../functions/src/__fixtures__/twinBuilding/', import.meta.url));
  const expected: Record<string, { meshes: number; bare: [string, string, number][] }> = {
    'house-deepseek-1': { meshes: 51, bare: [['roofMain', 'left', 1.27]] },
    'house-deepseek-2': { meshes: 62, bare: [['roofMain', 'left', 1.03]] },
  };
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const name = file.replace(/\.json$/, '');
    it(`runs the program of ${name}`, () => {
      const f = JSON.parse(readFileSync(dir + file, 'utf8')) as { text: string; photos: { photo: number }[] };
      const answer = parseTwinBuildingCode(
        f.text,
        f.photos.map((p) => p.photo),
      ).answer!;
      const declared = answer.parts.map((p) => p.name);
      const run = runTwinProgram(answer.code, declared);
      assert.equal(run.error, null);
      const want = expected[name];
      if (!want) return;
      assert.equal(run.stoppedAt, null);
      assert.deepEqual(
        declared.filter((n) => !run.parts.some((p) => p.name === n)),
        [],
        'every declared part is built',
      );
      assert.equal(run.meshes, want.meshes);
      const settled = readSettled(run.settled);
      assert.equal(settled?.moved.length ?? 0, 0);
      assert.deepEqual(
        (settled?.uncovered ?? []).map((u) => u.part),
        want.bare.map(([part]) => part),
      );
      for (const [part, side, metres] of want.bare)
        near(settled!.uncovered.find((u) => u.part === part)!.sides[side as 'left']!, metres);
    });
  }
});
