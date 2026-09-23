import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderTwinLive } from './twinLive';

// The live rendering of a twin answer as it streams (docs/digital-twin-plan.md §28.5): every prefix of the
// JSON must render without failing, and the whole must read as the fields, the list of parts and the program.

const answer = JSON.stringify({
  renderable: true,
  reason: '',
  confidence: 0.8,
  subject: 'A two-storey house with a "gable" roof',
  subjectKind: 'building',
  name: 'House',
  description: 'Two storeys.\nA porch in front.',
  parts: [
    { name: 'walls', kind: 'wall', description: 'the main block' },
    { name: 'roof', kind: 'roof', description: 'gabled' },
  ],
  code: "const w = api.part('walls', 'wall');\nw.add(api.box(8, 6, 10));",
  views: [{ photo: 1, x: 0, y: 1.5, z: 12, targetX: 0, targetY: 3, targetZ: 0 }],
});

describe('renderTwinLive', () => {
  it('renders the whole answer as fields, a list and the program', () => {
    const out = renderTwinLive(answer);
    assert.equal(
      out,
      [
        'renderable: true',
        'reason: ',
        'confidence: 0.8',
        'subject: A two-storey house with a "gable" roof',
        'subjectKind: building',
        'name: House',
        'description: Two storeys.\nA porch in front.',
        'parts:',
        '  - name: walls · kind: wall · description: the main block',
        '  - name: roof · kind: roof · description: gabled',
        '',
        "const w = api.part('walls', 'wall');",
        'w.add(api.box(8, 6, 10));',
        '',
        'views:',
        '  - photo: 1 · x: 0 · y: 1.5 · z: 12 · targetX: 0 · targetY: 3 · targetZ: 0',
        '',
      ].join('\n'),
    );
  });

  it('renders every prefix without throwing, each a prefix of the next in what it shows', () => {
    let previous = '';
    for (let n = 0; n <= answer.length; n++) {
      const out = renderTwinLive(answer.slice(0, n));
      assert.equal(typeof out, 'string');
      // What has been shown never changes shape later: a longer prefix only appends — except for the
      // closing of a value (its newline), which a cut-off value has not earned yet.
      const shownBefore = previous.replace(/\n$/, '');
      assert.ok(
        out.startsWith(shownBefore),
        `prefix ${n}: expected\n${JSON.stringify(out)}\nto start with\n${JSON.stringify(shownBefore)}`,
      );
      previous = out;
    }
  });

  it('shows a cut-off string as far as it goes, and a half-written key not at all', () => {
    assert.equal(renderTwinLive('{"renderable": true, "subject": "A hou'), 'renderable: true\nsubject: A hou');
    assert.equal(renderTwinLive('{"renderable": true, "subj'), 'renderable: true\n');
    assert.equal(renderTwinLive('{"renderable": true, "subject"'), 'renderable: true\nsubject:');
    assert.equal(renderTwinLive('{"renderable": true, "subject": '), 'renderable: true\nsubject:');
  });

  it('writes the program out as it is written, decoded, on its own lines', () => {
    const out = renderTwinLive('{"name": "House", "code": "const a = 1;\\nconst b = \\"two\\";\\nap');
    assert.equal(out, 'name: House\n\nconst a = 1;\nconst b = "two";\nap');
  });

  it('drops an escape cut off by the end rather than showing a backslash', () => {
    assert.equal(renderTwinLive('{"code": "a\\'), '\na');
    assert.equal(renderTwinLive('{"code": "a\\u00'), '\na');
    assert.equal(renderTwinLive('{"code": "a\\u00e9b"}'), '\naéb\n\n');
  });

  it('lists a cut-off array item as far as it goes', () => {
    assert.equal(
      renderTwinLive('{"parts": [{"name": "walls", "kind": "wall"}, {"name": "ro'),
      'parts:\n  - name: walls · kind: wall\n  - name: ro',
    );
    assert.equal(renderTwinLive('{"parts": [{"name": "walls", "kind": '), 'parts:\n  - name: walls · kind:');
  });

  it('writes what is nested deeper inline, in parentheses, and number lists in brackets', () => {
    const out = renderTwinLive(
      '{"camera": {"pitch": 10, "distanceHint": 3}, "objects": [{"label": "desk", "box": {"x": 0.1, "y": 0.2}, "quad": [0, 1, 2]}]}',
    );
    assert.equal(
      out,
      'camera: pitch: 10 · distanceHint: 3\nobjects:\n  - label: desk · box: (x: 0.1 · y: 0.2) · quad: [0, 1, 2]\n',
    );
  });

  it('shows an answer that is not JSON as it is, less a fence', () => {
    assert.equal(renderTwinLive('I cannot see a subject'), 'I cannot see a subject');
    assert.equal(renderTwinLive('```json\n{"name": "Hou'), 'name: Hou');
    assert.equal(renderTwinLive(''), '');
    assert.equal(renderTwinLive('  \n'), '');
  });
});
