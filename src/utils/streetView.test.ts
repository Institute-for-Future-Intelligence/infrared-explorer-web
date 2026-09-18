/**
 * The street-view map's ?sv= rule — which is really the rule that closing the viewer closes it.
 *
 * The page holds two things that mean "which street view is open": the `selected` state, set
 * and cleared urgently, and the ?sv= on the address, rewritten inside a React transition
 * (RouterProvider v7_startTransition) and therefore a render behind. Every case below is one
 * of the moments where the two disagree.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deepLinkAction } from './streetView';

const action = (deepLinkId: string | null, selectedId: string | null, openedId: string | null, loading = false) =>
  deepLinkAction({ deepLinkId, loading, selectedId, openedId });

describe('deepLinkAction', () => {
  it('opens a link nobody has followed yet', () => {
    assert.equal(action('a', null, null), 'open');
  });

  it('waits for the public set rather than deciding a link is missing', () => {
    assert.equal(action('a', null, null, true), 'wait');
  });

  it('only remembers a street view opened from the map, since it is already showing', () => {
    assert.equal(action('a', 'a', null), 'remember');
  });

  it('leaves a followed link alone when the viewer closes ahead of the URL', () => {
    // The click that closes: `selected` is already null, ?sv=a has not been rewritten yet.
    // Re-opening here is exactly what made closing take two clicks.
    assert.equal(action('a', null, 'a'), 'ignore');
  });

  it('forgets the link once the URL catches up, so the same one can be opened again', () => {
    assert.equal(action(null, null, 'a'), 'forget');
    // ...and after forgetting, pasting ?sv=a again opens it.
    assert.equal(action('a', null, null), 'open');
  });

  it('follows a different link even while one is remembered', () => {
    assert.equal(action('b', null, 'a'), 'open');
    // A neighbour jump sets both at once: the viewer shows b, the link only follows.
    assert.equal(action('b', 'b', 'a'), 'remember');
  });
});
