/**
 * The recording AI's server tools: the edits write_report applies to the current report (the app's
 * write_plan / write_report `edits`), kept pure so the suite runs them without Firestore.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits } from './tools';

describe('applyEdits', () => {
  it('changes the parts named, in order, each edit seeing the text as the earlier ones left it', () => {
    assert.deepEqual(
      applyEdits('a b c', [
        { find: 'b', replace: 'B' },
        { find: 'c', replace: 'C' },
      ]),
      { next: 'a B C', missing: [] },
    );
    assert.deepEqual(
      applyEdits('a', [
        { find: 'a', replace: 'b' },
        { find: 'b', replace: 'c' },
      ]),
      { next: 'c', missing: [] },
    );
    // the first match only
    assert.deepEqual(applyEdits('x x', [{ find: 'x', replace: 'y' }]), { next: 'y x', missing: [] });
  });

  it('names the edits whose text is not there (1-based), an empty find and a malformed edit among them', () => {
    assert.deepEqual(
      applyEdits('a b', [{ find: 'z', replace: 'y' }, { find: '', replace: 'q' }, null, { find: 'b', replace: 'B' }]),
      {
        next: 'a B',
        missing: [1, 2, 3],
      },
    );
  });
});
