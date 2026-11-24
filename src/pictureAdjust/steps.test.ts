import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NO_ADJUST, PictureAdjust } from './core/pictureAdjustParams';
import { STEPS_KEPT, canRedo, canUndo, firstStep, withStep } from './steps';

const set = (over: Partial<PictureAdjust>): PictureAdjust => ({ ...NO_ADJUST, ...over });

describe('the Process panel’s steps', () => {
  it('adds a step for a change and none for the settings it is on', () => {
    const one = withStep(firstStep(set({})), set({ contrast: 10 }));
    assert.equal(one.list.length, 2);
    assert.equal(one.at, 1);
    assert.equal(withStep(one, set({ contrast: 10 })), one);
  });

  it('a new step ends what Redo could have gone forward to', () => {
    let steps = withStep(withStep(firstStep(set({})), set({ contrast: 10 })), set({ contrast: 20 }));
    steps = { ...steps, at: 1 }; // one Undo
    assert.equal(canRedo(steps, steps.list[1]), true);
    steps = withStep(steps, set({ contrast: 5 }));
    assert.deepEqual(
      steps.list.map((s) => s.contrast),
      [0, 10, 5],
    );
    assert.equal(canRedo(steps, steps.list[steps.at]), false);
  });

  it('offers Undo from the first step only while a change is not yet a step', () => {
    const steps = firstStep(set({}));
    assert.equal(canUndo(steps, set({})), false);
    assert.equal(canUndo(steps, set({ hue: 3 })), true);
    assert.equal(canRedo(steps, set({ hue: 3 })), false);
  });

  it('lets the oldest steps go', () => {
    let steps = firstStep(set({}));
    for (let i = 1; i <= STEPS_KEPT + 10; i++) steps = withStep(steps, set({ brightness: (i % 100) + 1, hue: i % 7 }));
    assert.equal(steps.list.length, STEPS_KEPT);
    assert.equal(steps.at, STEPS_KEPT - 1);
  });
});
