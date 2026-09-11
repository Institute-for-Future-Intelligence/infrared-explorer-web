import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  coverAfterReorder,
  isCaptureOrder,
  normalizePhotoOrder,
  photoPlaces,
  windowFromPlaces,
  windowToPlaces,
} from './photoOrder';

describe('normalizePhotoOrder', () => {
  it('reads an absent order as capture order', () => {
    assert.deepEqual(normalizePhotoOrder(undefined, 4), [0, 1, 2, 3]);
    assert.deepEqual(normalizePhotoOrder(null, 2), [0, 1]);
  });

  it('keeps a valid permutation as it is', () => {
    assert.deepEqual(normalizePhotoOrder([2, 0, 1], 3), [2, 0, 1]);
  });

  it('drops what is not a slot of the set and appends the slots it misses', () => {
    assert.deepEqual(normalizePhotoOrder([3, 7, -1, 1.5, '0', 3, 1], 5), [3, 1, 0, 2, 4]);
  });

  it('follows the set when photoCount changed under the stored order', () => {
    assert.deepEqual(normalizePhotoOrder([1, 0], 3), [1, 0, 2]); // a photo added
    assert.deepEqual(normalizePhotoOrder([2, 1, 0], 2), [1, 0]); // one taken away
  });

  it('gives an empty order for an empty or nonsensical count', () => {
    assert.deepEqual(normalizePhotoOrder([0, 1], 0), []);
    assert.deepEqual(normalizePhotoOrder([0, 1], -3), []);
  });
});

describe('photoPlaces / isCaptureOrder', () => {
  it('inverts an order', () => {
    assert.deepEqual(photoPlaces([2, 0, 1]), [1, 2, 0]);
    assert.deepEqual(photoPlaces([0, 1, 2]), [0, 1, 2]);
  });

  it('recognises capture order', () => {
    assert.equal(isCaptureOrder([0, 1, 2]), true);
    assert.equal(isCaptureOrder([]), true);
    assert.equal(isCaptureOrder([1, 0, 2]), false);
  });
});

describe('note windows between capture numbers and places', () => {
  // Photo 3 was dragged to the front: the strip reads 3, 1, 2.
  const order = [2, 0, 1];

  it('leaves every window alone while the set is in capture order', () => {
    assert.deepEqual(windowToPlaces({ start: 0, end: 2 }, [0, 1, 2]), { start: 0, end: 2 });
    assert.deepEqual(windowFromPlaces({ start: 1.5, end: 2 }, [0, 1, 2]), { start: 1.5, end: 2 });
  });

  it('keeps a whole-set window (the default 0..N) as it is', () => {
    assert.deepEqual(windowToPlaces({ start: 0, end: 3 }, order), { start: 0, end: 3 });
    assert.deepEqual(windowFromPlaces({ start: 1, end: 3 }, order), { start: 1, end: 3 });
  });

  it('keeps a window that covers no photo as it is', () => {
    assert.deepEqual(windowToPlaces({ start: 5, end: 9 }, order), { start: 5, end: 9 });
    assert.deepEqual(windowToPlaces({ start: 2.2, end: 2.8 }, order), { start: 2.2, end: 2.8 });
  });

  it('moves a one-photo window with its photo', () => {
    // Capture photo 3 is shown first; capture photo 1 second.
    assert.deepEqual(windowToPlaces({ start: 3, end: 3 }, order), { start: 1, end: 1 });
    assert.deepEqual(windowToPlaces({ start: 1, end: 1 }, order), { start: 2, end: 2 });
    assert.deepEqual(windowFromPlaces({ start: 1, end: 1 }, order), { start: 3, end: 3 });
    assert.deepEqual(windowFromPlaces({ start: 3, end: 3 }, order), { start: 2, end: 2 });
  });

  it('reads a fractional window by the photos it covers', () => {
    assert.deepEqual(windowToPlaces({ start: 2.5, end: 3.4 }, order), { start: 1, end: 1 });
  });

  it('round-trips a run of photos that stayed together', () => {
    const shown = windowToPlaces({ start: 1, end: 2 }, order);
    assert.deepEqual(shown, { start: 2, end: 3 });
    assert.deepEqual(windowFromPlaces(shown, order), { start: 1, end: 2 });
  });

  it('shows a scattered run by the places of its ends', () => {
    // Capture photos 2 and 3 now sit at places 3 and 1 — no window of places holds just those two.
    assert.deepEqual(windowToPlaces({ start: 2, end: 3 }, order), { start: 1, end: 3 });
  });
});

describe('coverAfterReorder', () => {
  const bucket = 'infrared-explorer.appspot.com';
  const url = (n: number) =>
    `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(`recordings/rec1/data_${n}.png`)}?alt=media`;

  it("moves the capture app's download-URL cover to the new first photo", () => {
    assert.equal(coverAfterReorder(url(1), 'rec1', 0, 2), url(3));
  });

  it('moves a bare-path cover too', () => {
    assert.equal(coverAfterReorder('recordings/rec1/data_2.png', 'rec1', 1, 0), 'recordings/rec1/data_1.png');
  });

  it('keeps a token on the download URL', () => {
    const tokened = `${url(1)}&token=abc`;
    assert.equal(coverAfterReorder(tokened, 'rec1', 0, 1), `${url(2)}&token=abc`);
  });

  it('changes nothing when the first photo stayed', () => {
    assert.equal(coverAfterReorder(url(1), 'rec1', 0, 0), undefined);
  });

  it("changes nothing when the cover is not the old first photo's render", () => {
    assert.equal(coverAfterReorder(url(2), 'rec1', 0, 2), undefined); // someone chose photo 2
    assert.equal(coverAfterReorder('recordings/other/data_1.png', 'rec1', 0, 2), undefined);
    assert.equal(coverAfterReorder('thumbnails/u1/cover.png', 'rec1', 0, 2), undefined);
    assert.equal(coverAfterReorder('', 'rec1', 0, 2), undefined);
    assert.equal(coverAfterReorder(undefined, 'rec1', 0, 2), undefined);
  });
});
