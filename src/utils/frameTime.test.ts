import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatIntervalSec,
  formatTimeAxis,
  frameTimeSec,
  isTimelapse,
  lastFrameIndexOf,
  secondsPerFrame,
  timeAxisFor,
  playbackSpeedFactor,
  formatSpeedFactor,
} from './frameTime';

const ordinary = { duration: 28.2 };
const lapse = { duration: 86400, frameCount: 1441, timelapse: { intervalSec: 60 } };

describe('isTimelapse', () => {
  it('is a positive interval on the doc, nothing else', () => {
    assert.equal(isTimelapse(ordinary), false);
    assert.equal(isTimelapse({ duration: 10, frameCount: 50 }), false);
    assert.equal(isTimelapse({ duration: 10, timelapse: null }), false);
    assert.equal(isTimelapse({ duration: 10, timelapse: { intervalSec: 0 } }), false);
    assert.equal(isTimelapse({ duration: 10, timelapse: { intervalSec: NaN } }), false);
    assert.equal(isTimelapse(lapse), true);
    assert.equal(isTimelapse({ duration: 1, timelapse: { intervalSec: 1 } }), true);
  });
});

describe('secondsPerFrame', () => {
  it('is 1/5 s for an ordinary recording and the interval for a time-lapse', () => {
    assert.equal(secondsPerFrame(ordinary), 0.2);
    assert.equal(secondsPerFrame(lapse), 60);
    assert.equal(secondsPerFrame({ duration: 5, timelapse: { intervalSec: 0.5 } }), 0.5);
  });
});

describe('lastFrameIndexOf', () => {
  it('derives the 5 fps count from duration when the doc has no frameCount', () => {
    assert.equal(lastFrameIndexOf({ duration: 10 }), 49);
    // Rounds, so a float duration never yields a fractional index.
    assert.equal(lastFrameIndexOf(ordinary), 140);
    assert.equal(lastFrameIndexOf({ duration: 0 }), 0);
    assert.equal(lastFrameIndexOf({}), 0);
  });

  it('prefers frameCount and never derives it from duration when both are present', () => {
    assert.equal(lastFrameIndexOf(lapse), 1440);
    assert.equal(lastFrameIndexOf({ duration: 10, frameCount: 50 }), 49);
    // The two disagreeing is exactly the time-lapse case: the frame count wins.
    assert.equal(lastFrameIndexOf({ duration: 3600, frameCount: 7 }), 6);
    assert.equal(lastFrameIndexOf({ duration: 10, frameCount: 3.7 }), 2);
  });

  it('falls back to duration on a frameCount that is not a count', () => {
    assert.equal(lastFrameIndexOf({ duration: 10, frameCount: 0 }), 49);
    assert.equal(lastFrameIndexOf({ duration: 10, frameCount: NaN }), 49);
  });
});

describe('frameTimeSec', () => {
  it('places frame i at i × the frame interval', () => {
    assert.equal(frameTimeSec(ordinary, 0), 0);
    assert.equal(Number(frameTimeSec(ordinary, 7).toFixed(1)), 1.4);
    assert.equal(frameTimeSec(lapse, 1440), 86400);
    assert.equal(frameTimeSec(lapse, 1), 60);
  });
});

describe('formatIntervalSec', () => {
  it('writes seconds under a minute, minutes under an hour, hours above', () => {
    assert.equal(formatIntervalSec(1), '1 s');
    assert.equal(formatIntervalSec(30), '30 s');
    assert.equal(formatIntervalSec(0.5), '0.5 s');
    assert.equal(formatIntervalSec(60), '1 min');
    assert.equal(formatIntervalSec(150), '2.5 min');
    assert.equal(formatIntervalSec(600), '10 min');
    assert.equal(formatIntervalSec(3600), '1 h');
    assert.equal(formatIntervalSec(0), '');
    assert.equal(formatIntervalSec(NaN), '');
  });
});

describe('timeAxisFor', () => {
  it('keeps seconds below three minutes, then minutes, then hours', () => {
    assert.equal(timeAxisFor(0).unit, 'second');
    assert.equal(timeAxisFor(28).label, 'Time (Second)');
    assert.equal(timeAxisFor(179).unit, 'second');
    assert.equal(timeAxisFor(180).unit, 'minute');
    assert.equal(timeAxisFor(3599).label, 'Time (Minute)');
    assert.equal(timeAxisFor(3 * 3600 - 1).unit, 'minute');
    assert.equal(timeAxisFor(3 * 3600).unit, 'hour');
    assert.equal(timeAxisFor(86400).label, 'Time (Hour)');
  });

  it('keeps an ordinary clip in seconds whatever its length (sub-second frame spacing)', () => {
    assert.equal(timeAxisFor(3047, 0.2).unit, 'second');
    assert.equal(timeAxisFor(86400, 0.5).unit, 'second');
    assert.equal(timeAxisFor(3047, 1).unit, 'minute');
    assert.equal(timeAxisFor(86400, 60).unit, 'hour');
    assert.equal(timeAxisFor(3047).unit, 'minute');
  });

  it('formats a tick in the axis unit with decimals trimmed', () => {
    assert.equal(formatTimeAxis(28, timeAxisFor(28)), '28');
    assert.equal(formatTimeAxis(90, timeAxisFor(600)), '1.5');
    assert.equal(formatTimeAxis(600, timeAxisFor(600)), '10');
    assert.equal(formatTimeAxis(1800, timeAxisFor(86400)), '0.5');
    assert.equal(formatTimeAxis(86400, timeAxisFor(86400)), '24');
  });
});

describe('playbackSpeedFactor', () => {
  it('is the interval times the 5 fps playback, 0 for an ordinary recording', () => {
    assert.equal(playbackSpeedFactor({ duration: 86400, frameCount: 1441, timelapse: { intervalSec: 60 } }), 300);
    assert.equal(playbackSpeedFactor({ duration: 10, frameCount: 5, timelapse: { intervalSec: 2.5 } }), 12.5);
    assert.equal(playbackSpeedFactor({ duration: 5 }), 0);
  });
  it('prints with at most one decimal and the × sign', () => {
    assert.equal(formatSpeedFactor(300), '300×');
    assert.equal(formatSpeedFactor(12.5), '12.5×');
    assert.equal(formatSpeedFactor(7.333), '7.3×');
  });
});
