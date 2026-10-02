import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TWIN_BUILDING_MAX_PHOTOS } from '../../../../functions/src/twinBuilding';
import { TWIN_FRAMES_MAX, tidyTwinFrames } from './twinModels';

describe('tidyTwinFrames', () => {
  it('keeps picked frames once each, in time order', () => {
    assert.deepEqual(tidyTwinFrames([40, 12, 40, 7]), [7, 12, 40]);
    assert.deepEqual(tidyTwinFrames([]), []);
  });

  it('drops what is not a frame number, and what is past the cap', () => {
    assert.deepEqual(tidyTwinFrames([3, '4', 0, -1, 2.5, null, 9]), [3, 9]);
    const many = Array.from({ length: TWIN_FRAMES_MAX + 3 }, (_, i) => i + 1);
    assert.equal(tidyTwinFrames(many).length, TWIN_FRAMES_MAX);
  });

  it('caps the pick where the server does', () => {
    assert.equal(TWIN_FRAMES_MAX, TWIN_BUILDING_MAX_PHOTOS);
  });
});
