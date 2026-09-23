import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TWIN_NOTE_IMAGES_MAX,
  TWIN_NOTE_PARTS_MAX,
  buildTwinBuildingPrompt,
  readRevisionSelection,
  readRevisions,
} from './twinBuilding';

// The revision note's selection and pictures (docs/digital-twin-plan.md §28), and the no-vegetation rule.

const parts = [
  { name: 'mainBlock', kind: 'wall' as const, description: 'the house' },
  { name: 'chimney', kind: 'other' as const, description: '' },
  { name: 'porch', kind: 'other' as const, description: '' },
];

describe('readRevisionSelection', () => {
  it('takes a whole part (a bare name or an item), a mesh, a face — once each — and none at all', () => {
    assert.deepEqual(readRevisionSelection(' chimney ', parts), {
      selection: [{ part: 'chimney', mesh: null, face: null, label: 'chimney' }],
    });
    const r = readRevisionSelection(
      [
        {
          part: 'mainBlock',
          mesh: 1,
          face: 'front',
          kind: 'wall',
          round: false,
          center: [0, 1.5, 4.004],
          size: [8, 3, 0.3],
          label: 'mainBlock #2 front face',
        },
        { part: 'porch', mesh: 0, face: null, round: true },
        { part: 'porch' },
        { part: 'porch', mesh: 0 },
        'chimney',
      ],
      parts,
    );
    assert.deepEqual(r, {
      selection: [
        {
          part: 'mainBlock',
          mesh: 1,
          face: 'front',
          kind: 'wall',
          round: false,
          center: [0, 1.5, 4],
          size: [8, 3, 0.3],
          label: 'mainBlock #2 front face',
        },
        { part: 'porch', mesh: 0, face: null, round: true, label: 'porch #1' },
        { part: 'porch', mesh: null, face: null, label: 'porch' },
        { part: 'chimney', mesh: null, face: null, label: 'chimney' },
      ],
    });
    assert.deepEqual(readRevisionSelection(undefined, parts), { selection: [] });
    assert.deepEqual(readRevisionSelection(null, parts), { selection: [] });
    assert.deepEqual(readRevisionSelection('', parts), { selection: [] });
    assert.deepEqual(readRevisionSelection([], parts), { selection: [] });
  });
  it('refuses an undeclared part, a bad mesh or face, a wrong type, a runaway name and too many', () => {
    const r = readRevisionSelection([{ part: 'chimney' }, { part: 'roof' }], parts);
    assert.ok('error' in r && /no part named "roof"/.test(r.error));
    assert.ok('error' in readRevisionSelection(7, parts));
    assert.ok('error' in readRevisionSelection([7], parts));
    assert.ok('error' in readRevisionSelection({ part: 'chimney', mesh: -1 }, parts));
    assert.ok('error' in readRevisionSelection({ part: 'chimney', mesh: 1.5 }, parts));
    assert.ok('error' in readRevisionSelection({ part: 'chimney', mesh: 0, face: 'side' }, parts));
    assert.ok('error' in readRevisionSelection('x'.repeat(200), parts));
    // Case matters: the prompt quotes the name as the program spells it.
    assert.ok('error' in readRevisionSelection('Chimney', parts));
    const many = readRevisionSelection(
      Array.from({ length: TWIN_NOTE_PARTS_MAX + 1 }, () => 'chimney'),
      parts,
    );
    assert.ok('error' in many && /At most/.test(many.error));
  });
});

describe('readRevisions with a selection and pictures', () => {
  it('keeps the selection labels and the picture count, drops what is not one', () => {
    const rounds = readRevisions([
      { feedback: 'a', changes: '', at: 1, selection: ['chimney', 'walls #2 front face', 'chimney'], images: 2 },
      { feedback: 'b', changes: '', at: 2, selection: [], images: 0 },
      { feedback: 'c', changes: '', at: 3, selection: 'chimney', images: 'two' },
      { feedback: 'd', changes: '', at: 4, selection: [5, ' porch '], images: 2.7 },
    ]);
    assert.deepEqual(rounds, [
      { feedback: 'a', changes: '', at: 1, selection: ['chimney', 'walls #2 front face'], images: 2 },
      { feedback: 'b', changes: '', at: 2 },
      { feedback: 'c', changes: '', at: 3 },
      { feedback: 'd', changes: '', at: 4, selection: ['porch'], images: 2 },
    ]);
    assert.equal(TWIN_NOTE_IMAGES_MAX, 3);
  });
});

describe('buildTwinBuildingPrompt (§28)', () => {
  const photos = [
    { photo: 1, width: 480, height: 640 },
    { photo: 2, width: 480, height: 640 },
  ];
  it('rules out trees, on a build and on a revision, and names none as an example', () => {
    const { system } = buildTwinBuildingPrompt({ photos });
    assert.match(system, /No trees for now/);
    assert.match(system, /every tree, bush, hedge and standing plant/);
    // The examples must not contradict the rule: no tree among the subjects or the scenery.
    assert.doesNotMatch(system, /a distant tree|a vehicle, a tree/);
    const revised = buildTwinBuildingPrompt({
      photos,
      revision: { code: 'x', parts, views: [], note: 'n', history: [] },
    });
    assert.match(revised.system, /The rule against trees stands too/);
  });
  it('points the model at each selected thing by part, size and position, and announces the pictures after the photos', () => {
    const { user } = buildTwinBuildingPrompt({
      photos,
      revision: {
        code: 'x',
        parts,
        views: [],
        note: 'Make it taller.',
        history: [{ feedback: 'earlier', changes: 'done', at: 1, selection: ['mainBlock'] }],
        selection: [
          {
            part: 'mainBlock',
            mesh: 1,
            face: 'front',
            round: false,
            center: [0, 1.5, 4],
            size: [8, 3, 0.3],
            label: 'mainBlock #2 front face',
          },
          { part: 'porch', mesh: 0, face: null, round: true, center: [2, 1, 3], size: [1, 2, 1], label: 'porch' },
          { part: 'chimney', mesh: null, face: null, label: 'chimney' },
        ],
        images: 2,
      },
    });
    assert.match(
      user,
      /The owner selected in the viewer, before writing the note: the box of part mainBlock \(8 × 3 × 0\.3 m, centred at \(0, 1\.5, 4\) m\), its front \(\+z\) face; the round mesh of part porch \(1 × 2 × 1 m, centred at \(2, 1, 3\) m\); the part chimney as a whole\. The note is about those unless it plainly says otherwise/,
    );
    assert.match(user, /find each in the program by its part, size and position/);
    assert.match(user, /attached 2 pictures — after the photos above/);
    assert.match(user, /Then 2 more pictures: what the owner attached to their note/);
    assert.match(user, /1\. "earlier" \(about mainBlock\) — answered: "done"/);
    // The attachments are announced right after the photo list, in the order the pictures are sent.
    assert.ok(user.indexOf('Photo 2:') < user.indexOf('Then 2 more pictures'));
    assert.ok(user.indexOf('Then 2 more pictures') < user.indexOf('The model as it stands'));
  });
  it('says "that" of one thing, without size or centre when the frame gave none', () => {
    const { user } = buildTwinBuildingPrompt({
      photos,
      revision: {
        code: 'x',
        parts,
        views: [],
        note: 'Lower it.',
        history: [],
        selection: [{ part: 'chimney', mesh: 0, face: 'top', label: 'chimney top face' }],
        images: 1,
      },
    });
    assert.match(
      user,
      /before writing the note: the box of part chimney, its top \(\+y\) face\. The note is about that unless/,
    );
    assert.match(user, /attached 1 picture — after the photos above/);
    assert.match(user, /Then 1 more picture: what the owner attached/);
  });
  it('says nothing of a selection or pictures when the note has none', () => {
    const { user } = buildTwinBuildingPrompt({
      photos,
      revision: { code: 'x', parts, views: [], note: 'n', history: [], selection: [] },
    });
    assert.doesNotMatch(user, /selected in the viewer/);
    assert.doesNotMatch(user, /attached/);
    assert.doesNotMatch(user, /more picture/);
  });
});
