import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProjectImage, Take, Turn } from './core/types';
import { capturePhoto, discussViewerSequence, turnTakeIds } from './discussViewer';
import type { CloudThumbState } from './useCloudThumbs';

const take = (takeId: string, source: Take['source']): Take => ({
  takeId,
  localPath: '',
  source,
  timelapse: false,
  name: `name-${takeId}`,
  announced: true,
  at: 0,
});
const ready = (expId: string, thumbnailUrl: string | null): CloudThumbState => ({
  kind: 'ready',
  thumb: { expId, title: '', thumbnailUrl },
});
const image = (id: string): ProjectImage => ({
  id,
  kind: 'diagram',
  path: '',
  mime: 'image/png',
  caption: `caption-${id}`,
  url: `https://img/${id}`,
  at: 0,
});
let seq = 0;
const turn = (t: Partial<Turn> & Pick<Turn, 'role'>): Turn => ({ seq: ++seq, at: 0, ...t }) as Turn;
const draws = (callId: string, imageId: string): Turn[] => [
  turn({ role: 'assistant', toolCalls: [{ id: callId, name: 'draw', args: '{}', side: 'server' }] }),
  turn({ role: 'tool', callId, name: 'draw', ok: true, result: { text: '', imageIds: [imageId] } }),
  turn({ role: 'assistant', text: 'Done.' }),
];

describe('capturePhoto', () => {
  it('is a photo with a cloud copy, under its number and name', () => {
    assert.deepEqual(capturePhoto(take('a', 'photos'), 'Capture 2', ready('exp1', 'https://t/a.png')), {
      id: 'take:a',
      url: 'https://t/a.png',
      caption: 'Capture 2 · name-a',
    });
    // where photos and recordings are numbered apart, by its name
    assert.equal(
      capturePhoto(take('a', 'photos'), 'Photo 1', ready('exp1', 'https://t/a.png'))?.caption,
      'Photo 1 · name-a',
    );
  });
  it('is nothing for a recording, a phone-only photo, a photo without a picture or a removed capture', () => {
    assert.equal(capturePhoto(take('a', 'recording'), 'Capture 1', ready('exp1', 'https://t/a.png')), null);
    assert.equal(capturePhoto(take('a', 'photos'), 'Capture 1', { kind: 'missing' }), null);
    assert.equal(capturePhoto(take('a', 'photos'), 'Capture 1', ready('exp1', null)), null);
    assert.equal(capturePhoto(null, 'Capture 1', undefined), null);
  });
});

describe('discussViewerSequence', () => {
  const takes = new Map([
    ['p1', take('p1', 'photos')],
    ['v1', take('v1', 'recording')],
    ['p2', take('p2', 'photos')],
  ]);
  const photoOf = (id: string) => capturePhoto(takes.get(id), null, ready(`exp-${id}`, `https://t/${id}.png`));

  it("runs the user's photos and the replies' pictures as one row, in the thread's order", () => {
    const turns: Turn[] = [
      turn({
        role: 'user',
        text: 'look',
        event: {
          type: 'takesAdded',
          takes: [
            { takeId: 'p1', overview: '' },
            { takeId: 'v1', overview: '' },
          ],
          imageIds: [],
        },
      }),
      ...draws('c1', 'i1'),
      turn({ role: 'user', text: 'and this', attachments: [{ takeId: 'p2' }] }),
      ...draws('c2', 'i2'),
    ];
    const row = discussViewerSequence(turns, [image('i1'), image('i2')], false, photoOf);
    assert.deepEqual(
      row.map((p) => p.id),
      ['take:p1', 'i1', 'take:p2', 'i2'],
    );
  });

  it('leaves out the captures of an event turn, which Discuss draws as a line', () => {
    const turns: Turn[] = [
      turn({ role: 'event', event: { type: 'takesAdded', takes: [{ takeId: 'p1', overview: '' }], imageIds: [] } }),
    ];
    assert.deepEqual(discussViewerSequence(turns, [], false, photoOf), []);
  });
});

describe('turnTakeIds', () => {
  it('lists attachments, then the captures sent with the turn, once each', () => {
    const t = turn({
      role: 'user',
      attachments: [{ takeId: 'a' }, { takeId: 'b' }],
      event: {
        type: 'takesAdded',
        takes: [
          { takeId: 'b', overview: '' },
          { takeId: 'c', overview: '' },
        ],
        imageIds: [],
      },
    });
    assert.deepEqual(turnTakeIds(t), ['a', 'b', 'c']);
  });
});
