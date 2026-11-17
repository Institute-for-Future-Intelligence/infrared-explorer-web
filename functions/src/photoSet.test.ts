/*
 * A photo set's viewing order as the server repairs it (photoSet.ts) — the
 * mirror of the client's utils/photoOrder.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhotoOrder } from './photoSet';

describe('normalizePhotoOrder (server mirror of utils/photoOrder)', () => {
  it('is capture order when nothing is stored', () => {
    assert.deepEqual(normalizePhotoOrder(undefined, 3), [0, 1, 2]);
  });
  it('keeps a stored permutation, drops what is not a slot, and appends the slots it misses', () => {
    assert.deepEqual(normalizePhotoOrder([2, 0, 1], 3), [2, 0, 1]);
    assert.deepEqual(normalizePhotoOrder([2, 9, 2, -1, 0.5], 4), [2, 0, 1, 3]);
  });
});
