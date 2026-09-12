/**
 * The analyzer breadcrumb trail: how an experiment was reached, one navigation at a time.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NavigationType } from 'react-router-dom';
import type { NavCrumb } from '../stores/common';
import { trailFrom, type TrailContext, type TrailLocation } from './navTrail';

const at = (key: string, pathname: string, search = ''): TrailLocation => ({ key, pathname, search });

const context = (trails: Record<string, NavCrumb[]> = {}, userId?: string): TrailContext => ({
  trailOf: (key) => trails[key],
  titleOf: (expId) => ({ a: 'Salt gradient', b: 'Cooling cup' })[expId],
  userId,
});

const PUSH = NavigationType.Push;

describe('trailFrom', () => {
  it('is just Home when the experiment was opened directly or from Home', () => {
    assert.deepEqual(trailFrom(null, PUSH, '/experiments/a', context()), []);
    assert.deepEqual(trailFrom(at('k0', '/'), PUSH, '/experiments/a', context()), []);
  });

  it('names the page it was opened from, keeping its query', () => {
    assert.deepEqual(trailFrom(at('k0', '/recent'), PUSH, '/experiments/a', context()), [
      { label: 'History', to: '/recent' },
    ]);
    assert.deepEqual(trailFrom(at('k0', '/streetview', '?sv=x1'), PUSH, '/experiments/a', context()), [
      { label: 'Street View', to: '/streetview?sv=x1' },
    ]);
    assert.deepEqual(trailFrom(at('k0', '/myExperimentsList'), PUSH, '/experiments/a', context()), [
      { label: 'My Experiments', to: '/myExperimentsList' },
    ]);
  });

  it("tells the reader's own profile from someone else's, and marks the other user's", () => {
    assert.deepEqual(trailFrom(at('k0', '/users/me1'), PUSH, '/experiments/a', context({}, 'me1')), [
      { label: 'My Profile', to: '/users/me1' },
    ]);
    assert.deepEqual(trailFrom(at('k0', '/users/u2'), PUSH, '/experiments/a', context({}, 'me1')), [
      { label: 'User Profile', to: '/users/u2', ownerId: 'u2' },
    ]);
  });

  it("names a showcase author's gallery after the author", () => {
    assert.deepEqual(trailFrom(at('k0', '/showcase/authors/Jane%20Doe'), PUSH, '/experiments/a', context()), [
      { label: 'Jane Doe', to: '/showcase/authors/Jane%20Doe' },
    ]);
  });

  it('skips a page it cannot name', () => {
    assert.deepEqual(trailFrom(at('k0', '/no/such/page'), PUSH, '/experiments/a', context()), []);
  });

  it('from another experiment: the list the chain started on, then the experiment just left', () => {
    const trails = { kA: [{ label: 'History', to: '/recent' }] };
    assert.deepEqual(trailFrom(at('kA', '/experiments/a'), PUSH, '/experiments/b', context(trails)), [
      { label: 'History', to: '/recent' },
      { label: 'Salt gradient', to: '/experiments/a' },
    ]);
    // …and stays two steps however long the chain gets.
    const deeper = {
      kB: [
        { label: 'History', to: '/recent' },
        { label: 'Salt gradient', to: '/experiments/a' },
      ],
    };
    assert.deepEqual(trailFrom(at('kB', '/experiments/b'), PUSH, '/experiments/c', context(deeper)), [
      { label: 'History', to: '/recent' },
      { label: 'Cooling cup', to: '/experiments/b' },
    ]);
  });

  it('from an experiment opened from Home: just that experiment', () => {
    const trails = { kA: [] as NavCrumb[], kB: [{ label: 'Salt gradient', to: '/experiments/a' }] };
    assert.deepEqual(trailFrom(at('kA', '/experiments/a'), PUSH, '/experiments/b', context(trails)), [
      { label: 'Salt gradient', to: '/experiments/a' },
    ]);
    assert.deepEqual(trailFrom(at('kB', '/experiments/b'), PUSH, '/experiments/c', context(trails)), [
      { label: 'Cooling cup', to: '/experiments/b' },
    ]);
  });

  it('falls back to a generic name for an experiment that never loaded', () => {
    assert.deepEqual(trailFrom(at('kX', '/experiments/zzz'), PUSH, '/experiments/b', context()), [
      { label: 'Experiment', to: '/experiments/zzz' },
    ]);
  });

  it('keeps the trail when the entry is replaced in place or the same experiment reopens', () => {
    const trails = { kA: [{ label: 'Trash', to: '/trash' }] };
    const replaced = trailFrom(at('kA', '/experiments/a'), NavigationType.Replace, '/experiments/b', context(trails));
    assert.deepEqual(replaced, [{ label: 'Trash', to: '/trash' }]);
    const again = trailFrom(at('kA', '/experiments/a'), PUSH, '/experiments/a', context(trails));
    assert.deepEqual(again, [{ label: 'Trash', to: '/trash' }]);
  });

  it('claims nothing for a Back / Forward it has no record of', () => {
    const trails = { kA: [{ label: 'History', to: '/recent' }] };
    assert.deepEqual(trailFrom(at('kA', '/experiments/a'), NavigationType.Pop, '/experiments/b', context(trails)), []);
  });
});
