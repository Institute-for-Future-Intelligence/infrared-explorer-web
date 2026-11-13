import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { capturePicture, capturePictureSequence, isPictureOnly } from './capturePictures';
import { captureNames } from './core/captureNumbers';
import type { Take } from './core/types';
import type { CloudThumbState } from './useCloudThumbs';

const take = (takeId: string, source: Take['source'], at = 0): Take => ({
  takeId,
  localPath: '',
  source,
  timelapse: false,
  name: `name-${takeId}`,
  announced: true,
  at,
});
const ready = (expId: string, pictureOnly: boolean, thumbnailUrl: string | null = `https://t/${expId}.png`) =>
  ({ kind: 'ready', thumb: { expId, title: '', thumbnailUrl, pictureOnly } }) satisfies CloudThumbState;

describe('isPictureOnly', () => {
  it('is a one-photo set whose photo has no temperature data', () => {
    assert.equal(isPictureOnly({ sourceType: 'photos', photoCount: 1, photoThermal: [false] }), true);
    // the count is the flags' own length where the document leaves it out
    assert.equal(isPictureOnly({ sourceType: 'photos', photoThermal: [false] }), true);
  });
  it('is not a photo with its data, a set of several, a recording, or an upload from before the flags', () => {
    assert.equal(isPictureOnly({ sourceType: 'photos', photoCount: 1, photoThermal: [true] }), false);
    assert.equal(isPictureOnly({ sourceType: 'photos', photoCount: 2, photoThermal: [false, false] }), false);
    assert.equal(isPictureOnly({ sourceType: 'recording' }), false);
    assert.equal(isPictureOnly({ sourceType: 'recording', photoCount: 1, photoThermal: [false] }), false);
    assert.equal(isPictureOnly({ sourceType: 'photos', photoCount: 1 }), false);
    assert.equal(isPictureOnly({}), false);
  });
});

describe('capturePicture', () => {
  it('is a picture-only photo with a cloud copy, captioned as in Discuss', () => {
    assert.deepEqual(capturePicture(take('a', 'photos'), 'Photo 1', ready('exp1', true)), {
      id: 'take:a',
      url: 'https://t/exp1.png',
      caption: 'Photo 1 · name-a',
    });
  });
  it('is nothing for a photo with temperature data, a recording, or a picture not in the cloud', () => {
    assert.equal(capturePicture(take('a', 'photos'), 'Photo 1', ready('exp1', false)), null);
    assert.equal(capturePicture(take('a', 'recording'), 'Recording 1', ready('exp1', false)), null);
    assert.equal(capturePicture(take('a', 'photos'), 'Photo 1', { kind: 'missing' }), null);
    assert.equal(capturePicture(take('a', 'photos'), 'Photo 1', { kind: 'loading' }), null);
    assert.equal(capturePicture(take('a', 'photos'), 'Photo 1', ready('exp1', true, null)), null);
    assert.equal(capturePicture(take('a', 'photos'), 'Photo 1', undefined), null);
  });
});

describe('capturePictureSequence', () => {
  it('keeps the picture-only captures, in the order given, under what each is called', () => {
    // newest first, as the Captures tab lists them; numbered by kind, as the server files them
    const takes = [
      { ...take('p3', 'photos', 3), n: 3 },
      { ...take('v1', 'recording', 2), n: 1 },
      { ...take('p2', 'photos', 1), n: 2 },
      { ...take('p1', 'photos', 0), n: 1 },
    ];
    const cloud = new Map<string, CloudThumbState>([
      ['p3', ready('e3', true)],
      ['v1', ready('e-v1', false)],
      ['p2', ready('e2', false)],
      ['p1', ready('e1', true)],
    ]);
    const row = capturePictureSequence(takes, captureNames({ takes, numbering: 'kind' }), cloud);
    assert.deepEqual(
      row.map((p) => [p.id, p.caption]),
      [
        ['take:p3', 'Photo 3 · name-p3'],
        ['take:p1', 'Photo 1 · name-p1'],
      ],
    );
  });
});
