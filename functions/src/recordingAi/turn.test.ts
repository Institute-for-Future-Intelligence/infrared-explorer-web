/**
 * The recording AI's request parsing and its reading of a conversation's state (functions/src/recordingAi/turn.ts).
 *
 * What is worth pinning: that a request's input is validated into one of the four kinds and nothing else
 * (an unknown kind, an empty message, oversized pictures are refused or dropped), that only a message or a
 * report request is charged (the browser's tool results and a resume continue a paid turn), and that the
 * conversation's state is read as the app reads it — which calls are still pending, and whether the model
 * has the last word or the user does.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RecTurnDoc } from './store';
import { isChargedInput, needsModel, parseInput, pendingCalls } from './turn';

const png = (n: number) => ({ mime: 'image/png', b64: 'A'.repeat(n), caption: 'a frame' });

describe('parseInput', () => {
  it('reads a message with its moments and overview, and refuses an empty one', () => {
    const got = parseInput({
      kind: 'message',
      text: 'Why does the cup cool faster?',
      moments: [png(8), png(8), png(8), png(8)],
      overview: { text: '{"name":"Cup"}', images: [png(4)] },
    });
    assert.equal(got.kind, 'message');
    if (got.kind !== 'message') return;
    assert.equal(got.text, 'Why does the cup cool faster?');
    // at most three moments, the analyzer's chip tray
    assert.equal(got.moments.length, 3);
    assert.equal(got.overview?.text, '{"name":"Cup"}');
    assert.equal(got.overview?.images.length, 1);
    assert.throws(() => parseInput({ kind: 'message', text: '   ', moments: [] }), /empty/);
    // a message of moments alone is a message
    assert.equal(parseInput({ kind: 'message', text: '', moments: [png(8)] }).kind, 'message');
  });

  it('drops a picture that is not an image or is oversized, and keeps the rest', () => {
    const got = parseInput({
      kind: 'message',
      text: 'look',
      moments: [{ mime: 'text/plain', b64: 'AAAA', caption: '' }, png(6 * 1024 * 1024 + 1), png(8)],
    });
    if (got.kind !== 'message') throw new Error('not a message');
    assert.equal(got.moments.length, 1);
    assert.equal(got.moments[0].b64, 'A'.repeat(8));
  });

  it('reads tool results, a report request and a resume; refuses an unknown kind', () => {
    const results = parseInput({
      kind: 'toolResults',
      results: [
        { callId: 'c1', ok: false, text: 'no' },
        { ok: true, text: 'orphan' },
      ],
    });
    assert.deepEqual(results, { kind: 'toolResults', results: [{ callId: 'c1', ok: false, text: 'no', images: [] }] });
    const report = parseInput({ kind: 'report', mode: 'revise', notes: '  shorter  ', overview: null });
    assert.deepEqual(report, { kind: 'report', mode: 'revise', notes: 'shorter', overview: null });
    // any other mode is a rewrite
    assert.equal((parseInput({ kind: 'report', mode: 'x' }) as { mode: string }).mode, 'rewrite');
    assert.deepEqual(parseInput({ kind: 'resume' }), { kind: 'resume' });
    assert.throws(() => parseInput({ kind: 'event' }), /Unknown/);
    assert.throws(() => parseInput(undefined), /Unknown/);
  });

  it('charges a message and a report request, not the browser’s results or a resume', () => {
    assert.equal(isChargedInput('message'), true);
    assert.equal(isChargedInput('report'), true);
    assert.equal(isChargedInput('toolResults'), false);
    assert.equal(isChargedInput('resume'), false);
  });
});

const turn = (seq: number, t: Omit<RecTurnDoc, 'seq' | 'at'>): RecTurnDoc => ({ seq, at: seq, ...t });

describe('the conversation’s state', () => {
  it('names the last assistant turn’s calls without a result, until the user moves on', () => {
    const turns = [
      turn(1, { role: 'user', text: 'hi' }),
      turn(2, {
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'a', name: 'look', args: '{}', side: 'phone' },
          { id: 'b', name: 'view', args: '{}', side: 'server' },
        ],
      }),
      turn(3, { role: 'tool', callId: 'b', name: 'view', ok: true, result: { text: 'ok', imageIds: [] } }),
    ];
    assert.deepEqual(
      pendingCalls(turns).map((c) => c.id),
      ['a'],
    );
    assert.equal(needsModel(turns), false);
    // the browser answered: the model's turn
    const answered = [
      ...turns,
      turn(4, { role: 'tool', callId: 'a', name: 'look', ok: true, result: { text: 'ok', imageIds: [] } }),
    ];
    assert.deepEqual(pendingCalls(answered), []);
    assert.equal(needsModel(answered), true);
    // the user wrote again: the old call is forgotten, and the model owes an answer
    const movedOn = [...turns, turn(4, { role: 'user', text: 'never mind' })];
    assert.deepEqual(pendingCalls(movedOn), []);
    assert.equal(needsModel(movedOn), true);
  });

  it('is done when the model answered without tools, and a note says nothing', () => {
    const turns = [turn(1, { role: 'user', text: 'hi' }), turn(2, { role: 'assistant', text: 'Hello.' })];
    assert.equal(needsModel(turns), false);
    assert.equal(needsModel([...turns, turn(3, { role: 'note', note: { type: 'reportEdited', diff: '+ x' } })]), false);
    assert.equal(needsModel([]), false);
  });
});
