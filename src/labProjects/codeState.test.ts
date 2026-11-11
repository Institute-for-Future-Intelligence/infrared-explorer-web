import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readCodeState, rewindCodeState, savedAsOf, writeCodeState } from './codeState';
import type { Turn } from './core/types';

const ran = (seq: number, saved?: Record<string, number>): Turn => ({
  seq,
  at: seq,
  role: 'tool',
  name: 'run_code',
  callId: `c${seq}`,
  ok: true,
  result: { text: JSON.stringify({ printed: '', returned: null, ...(saved ? { saved } : {}) }), imageIds: [] },
});

describe('what the code saved goes back with the conversation', () => {
  it('reads what was saved then from the last run that is left', () => {
    assert.deepEqual(savedAsOf([]), {});
    assert.deepEqual(savedAsOf([{ seq: 1, at: 1, role: 'user', text: 'hi' }]), {});
    assert.deepEqual(savedAsOf([ran(1, { a: 3 }), ran(2, { a: 3, b: 7 })]), { a: 3, b: 7 });
    // a run that saved nothing lists nothing
    assert.deepEqual(savedAsOf([ran(1)]), {});
    // a result cut short on its way cannot be read: nothing is known
    assert.equal(savedAsOf([{ ...ran(1), result: { text: '{"printed":"…', imageIds: [] } }]), undefined);
  });

  it('drops the values saved or rewritten in the deleted part and keeps the ones from before', async () => {
    const kept = JSON.stringify([1, 2, 3]);
    await writeCodeState('u', 'p1', { series: kept, peak: '42.25', later: '"x"' });
    // as of the last run left: series as it is, peak at another size, later not there
    await rewindCodeState('u', 'p1', [ran(1, { series: kept.length, peak: 2 })]);
    assert.deepEqual(await readCodeState('u', 'p1'), { series: kept });
  });

  it('keeps nothing when no run is left, and everything when the last result cannot be read', async () => {
    await writeCodeState('u', 'p2', { a: '1' });
    await rewindCodeState('u', 'p2', [{ ...ran(1), result: { text: 'not json', imageIds: [] } }]);
    assert.deepEqual(await readCodeState('u', 'p2'), { a: '1' });
    await rewindCodeState('u', 'p2', []);
    assert.deepEqual(await readCodeState('u', 'p2'), {});
  });
});
