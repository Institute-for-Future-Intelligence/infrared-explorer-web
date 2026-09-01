/**
 * Tests for the replayed Q&A thread.
 *
 * The properties worth pinning are the ones that protect the CURRENT turn: that a long thread can't push
 * the authoritative data out of the prompt (turn cap, per-turn clipping), and that half an exchange —
 * a question whose answer failed, or an object with the wrong shape — never reaches the model as if it
 * were one. Truncation has to be visible too: a cut-off earlier answer read as complete is how a model
 * ends up "remembering" a conclusion nobody wrote.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QA_HISTORY_ANSWER_CHARS, QA_HISTORY_MOMENTS, QA_HISTORY_TURNS, sanitizeQaHistory } from './qaHistory';

const turn = (i: number) => ({ question: `q${i}`, answer: `a${i}`, momentTimes: [] });

describe('sanitizeQaHistory', () => {
  it('passes a well-formed thread through, trimmed', () => {
    assert.deepEqual(sanitizeQaHistory([{ question: '  why?  ', answer: ' because.\n', momentTimes: [1.234] }]), [
      { question: 'why?', answer: 'because.', momentTimes: [1.2] },
    ]);
  });

  it('keeps the NEWEST turns when the thread is longer than the cap', () => {
    const many = Array.from({ length: QA_HISTORY_TURNS + 4 }, (_, i) => turn(i));
    const kept = sanitizeQaHistory(many);
    assert.equal(kept.length, QA_HISTORY_TURNS);
    assert.equal(kept[kept.length - 1].question, `q${many.length - 1}`);
    assert.equal(kept[0].question, `q${many.length - QA_HISTORY_TURNS}`);
  });

  it('marks a clipped answer as truncated', () => {
    const long = 'word '.repeat(QA_HISTORY_ANSWER_CHARS);
    const [only] = sanitizeQaHistory([{ question: 'q', answer: long, momentTimes: [] }]);
    assert.ok(only.answer.length <= QA_HISTORY_ANSWER_CHARS + 40);
    assert.match(only.answer, /earlier answer truncated/);
  });

  it('drops half-exchanges and malformed entries', () => {
    const kept = sanitizeQaHistory([
      { question: 'q', answer: '' }, // the answer failed or was stopped before any text
      { question: '   ', answer: 'a' },
      { question: 'q', answer: 42 },
      null,
      'nope',
      { question: 'good', answer: 'kept' },
    ]);
    assert.deepEqual(kept, [{ question: 'good', answer: 'kept', momentTimes: [] }]);
  });

  it('caps and cleans the moment times', () => {
    const [only] = sanitizeQaHistory([
      { question: 'q', answer: 'a', momentTimes: [0, 5.57, -3, Number.NaN, 'x', 9, 12] },
    ]);
    assert.equal(only.momentTimes.length, QA_HISTORY_MOMENTS);
    assert.deepEqual(only.momentTimes, [0, 5.6, 9]);
  });

  it('returns nothing for a non-array', () => {
    for (const value of [undefined, null, 'q', 7, {}]) {
      assert.deepEqual(sanitizeQaHistory(value), []);
    }
  });
});
