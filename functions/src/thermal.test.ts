/**
 * Tests for the recording sampler's time base (thermal.ts): the 5 fps default and a time-lapse's
 * frameCount / secondPerFrame (docs/time-lapse-experiments.md).
 *
 * Run: npm test   (node:test via tsx — see the root package.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FPS, recordingSampling, recordingTiming, timelapseIntervalSec } from './thermal';

describe('recordingSampling', () => {
  it('reproduces the 5 fps derivation when no timing is given', () => {
    const s = recordingSampling(null, 28.2, 25);
    assert.equal(s.lastFrameIndex, 140);
    assert.equal(s.secondPerFrame, 1 / FPS);
    assert.equal(s.spanSec, 28);
    assert.equal(s.samples.length, 25);
    assert.equal(s.samples[0].tSec, 0);
    assert.deepEqual(s.samples[s.samples.length - 1], { playerIndex: 140, recordingIndex: 141, tSec: 28 });
    // The same again with an empty timing object — the defaults are the old behaviour. (sampleAt is a
    // fresh closure each call, so it is compared by what it returns.)
    const { sampleAt, ...rest } = s;
    const { sampleAt: sampleAt2, ...rest2 } = recordingSampling(null, 28.2, 25, {});
    assert.deepEqual(rest2, rest);
    assert.deepEqual(sampleAt2(7), sampleAt(7));
  });

  it('takes the last index from frameCount and the clock from secondPerFrame', () => {
    // 1441 frames one minute apart; the doc's duration is the real span (86400 s), NOT frames / 5.
    const s = recordingSampling(null, 86400, 25, { frameCount: 1441, secondPerFrame: 60 });
    assert.equal(s.lastFrameIndex, 1440);
    assert.equal(s.secondPerFrame, 60);
    assert.equal(s.spanSec, 86400);
    assert.equal(s.samples.length, 25);
    assert.deepEqual(s.samples[0], { playerIndex: 0, recordingIndex: 1, tSec: 0 });
    assert.deepEqual(s.samples[24], { playerIndex: 1440, recordingIndex: 1441, tSec: 86400 });
    assert.deepEqual(s.sampleAt(7), { playerIndex: 7, recordingIndex: 8, tSec: 420 });
  });

  it('uses frameCount alone on an ordinary recording that carries one', () => {
    const s = recordingSampling(null, 10, 5, { frameCount: 50 });
    assert.equal(s.lastFrameIndex, 49);
    assert.equal(s.secondPerFrame, 1 / FPS);
    assert.equal(s.spanSec, 9.8);
  });

  it('ignores a frameCount or secondPerFrame that is not usable', () => {
    assert.equal(recordingSampling(null, 10, 5, { frameCount: 0 }).lastFrameIndex, 49);
    assert.equal(recordingSampling(null, 10, 5, { frameCount: NaN }).lastFrameIndex, 49);
    assert.equal(recordingSampling(null, 10, 5, { secondPerFrame: 0 }).secondPerFrame, 1 / FPS);
    assert.equal(recordingSampling(null, 10, 5, { secondPerFrame: -1 }).secondPerFrame, 1 / FPS);
  });

  it('keeps a trimmed clip in recording-frame space and stamps it with the time-lapse clock', () => {
    // Segments are frame indices, so a clip of a time-lapse just spans fewer intervals.
    const s = recordingSampling([{ start: 10, end: 19 }], 86400, 5, { frameCount: 1441, secondPerFrame: 60 });
    assert.equal(s.lastFrameIndex, 9);
    assert.equal(s.spanSec, 540);
    assert.deepEqual(s.samples[0], { playerIndex: 0, recordingIndex: 10, tSec: 0 });
    assert.deepEqual(s.samples[4], { playerIndex: 9, recordingIndex: 19, tSec: 540 });
  });
});

describe('timelapseIntervalSec / recordingTiming', () => {
  it('reads a positive interval and nothing else', () => {
    assert.equal(timelapseIntervalSec({}), null);
    assert.equal(timelapseIntervalSec({ timelapse: null }), null);
    assert.equal(timelapseIntervalSec({ timelapse: { intervalSec: 0 } }), null);
    assert.equal(timelapseIntervalSec({ timelapse: { intervalSec: 'x' } }), null);
    assert.equal(timelapseIntervalSec({ timelapse: { intervalSec: 60 } }), 60);
  });

  it('turns a doc into the sampler timing', () => {
    assert.deepEqual(recordingTiming({ duration: 28.2 }), { frameCount: undefined, secondPerFrame: undefined });
    assert.deepEqual(recordingTiming({ duration: 86400, frameCount: 1441, timelapse: { intervalSec: 60 } }), {
      frameCount: 1441,
      secondPerFrame: 60,
    });
    assert.deepEqual(recordingTiming({ frameCount: 'many' }), { frameCount: undefined, secondPerFrame: undefined });
  });
});
