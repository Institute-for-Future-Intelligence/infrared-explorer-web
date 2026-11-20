import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatIntervalSec,
  frameTimeSec,
  isTimelapse,
  lastFrameIndexOf,
  secondsPerFrame,
  playbackSpeedFactor,
  formatSpeedFactor,
  formatFilmTime,
  pausedBeforeSec,
  frameCaptureTimeMs,
  captureTimeIsExact,
  nextTransportClock,
  formatTransportTime,
  clockTickStepSec,
  clockTicksMs,
  formatClockTick,
  clockAxisLabel,
  playerTimeAtCaptureMs,
  elapsedTicksSec,
  elapsedAxisLabel,
  isCameraTimed,
  cameraMeanGapSec,
  playerClock,
  formatFrameClock,
} from './frameTime';
import dayjs from 'dayjs';

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

describe('elapsedTicksSec / elapsedAxisLabel', () => {
  it('ticks an elapsed span from 0 at the step, the end included when it lands on one', () => {
    assert.deepEqual(elapsedTicksSec(120, 30), [0, 30, 60, 90, 120]);
    assert.deepEqual(elapsedTicksSec(100, 30), [0, 30, 60, 90]);
    assert.deepEqual(elapsedTicksSec(0, 30), [0]);
    assert.deepEqual(elapsedTicksSec(100, 0), []);
    assert.deepEqual(elapsedTicksSec(NaN, 30), []);
  });

  it('writes a tick as the transport readout does, so the two agree to the letter', () => {
    const span = 3 * 3600 + 19 * 60 + 30; // the bar reads 3:19:30
    const ticks = elapsedTicksSec(span, clockTickStepSec(span)).map(formatTransportTime);
    assert.deepEqual(ticks, ['00:00', '30:00', '1:00:00', '1:30:00', '2:00:00', '2:30:00', '3:00:00']);
    const film = 1440 / 5; // the same take on the film clock: 04:48
    assert.deepEqual(elapsedTicksSec(film, clockTickStepSec(film)).map(formatTransportTime), [
      '00:00',
      '01:00',
      '02:00',
      '03:00',
      '04:00',
    ]);
  });

  it('titles the axis by the clock, with the hours field from an hour on', () => {
    assert.equal(elapsedAxisLabel('recording', 600), 'Elapsed time (mm:ss)');
    assert.equal(elapsedAxisLabel('recording', 3600), 'Elapsed time (h:mm:ss)');
    assert.equal(elapsedAxisLabel('film', 288), 'Film time (mm:ss)');
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

describe('pausedBeforeSec / frameCaptureTimeMs / captureTimeIsExact', () => {
  // Two pauses: 10 min after 90 s of real time (= 90 s of recording time), then 5 min after 750 s real
  // (= 150 s recording, the first pause excluded).
  const pauses = [
    { startSec: 90, endSec: 690 },
    { startSec: 750, endSec: 1050 },
  ];
  const logged = {
    duration: 600,
    frameCount: 11,
    timelapse: { intervalSec: 60, pausedSec: 900, pauses },
    startedAt: 500_000,
  };

  it('adds the pauses that began before a recording-time slot', () => {
    assert.equal(pausedBeforeSec(pauses, 0), 0);
    assert.equal(pausedBeforeSec(pauses, 60), 0);
    assert.equal(pausedBeforeSec(pauses, 90), 0); // a slot AT the pause's start was taken before it
    assert.equal(pausedBeforeSec(pauses, 120), 600);
    assert.equal(pausedBeforeSec(pauses, 150), 600);
    assert.equal(pausedBeforeSec(pauses, 180), 900);
    assert.equal(pausedBeforeSec(undefined, 180), 0);
    assert.equal(pausedBeforeSec([], 180), 0);
    // A degenerate entry (no length) is skipped, not counted.
    assert.equal(pausedBeforeSec([{ startSec: 10, endSec: 10 }, ...pauses], 180), 900);
  });

  it('dates a recording frame by the start, its grid slot and the pauses before it', () => {
    assert.equal(frameCaptureTimeMs(logged, 1), 500_000);
    assert.equal(frameCaptureTimeMs(logged, 2), 500_000 + 60_000);
    assert.equal(frameCaptureTimeMs(logged, 3), 500_000 + 60_000 * 12);
    assert.equal(frameCaptureTimeMs(logged, 4), 500_000 + 60_000 * 18);
    // Without a log the grid alone (the older, approximate reading); never below frame 1.
    const bare = { ...logged, timelapse: { intervalSec: 60, pausedSec: 900 } };
    assert.equal(frameCaptureTimeMs(bare, 3), 500_000 + 120_000);
    assert.equal(frameCaptureTimeMs(bare, 0), 500_000);
    // Null without a start, and for an ordinary recording.
    assert.equal(frameCaptureTimeMs({ ...logged, startedAt: undefined }, 3), null);
    assert.equal(frameCaptureTimeMs({ duration: 10, startedAt: 500_000 }, 3), null);
  });

  it('is exact unless the take was paused and only the total is known', () => {
    assert.equal(captureTimeIsExact(logged), true);
    assert.equal(captureTimeIsExact({ duration: 600, frameCount: 11, timelapse: { intervalSec: 60 } }), true);
    assert.equal(captureTimeIsExact({ ...logged, timelapse: { intervalSec: 60, pausedSec: 900 } }), false);
    assert.equal(captureTimeIsExact({ duration: 10 }), true);
  });
});

describe('formatFilmTime', () => {
  it('reads the film clock to the tenth of a second, so the frames of one second differ', () => {
    assert.equal(formatFilmTime(0), '0:00.0');
    assert.equal(formatFilmTime(49), '0:09.8');
    assert.equal(formatFilmTime(50), '0:10.0');
    assert.equal(formatFilmTime(51), '0:10.2');
    assert.equal(formatFilmTime(5 * 65), '1:05.0');
    assert.equal(formatFilmTime(5 * 3725 + 2), '1:02:05.4');
    assert.equal(formatFilmTime(-3), '0:00.0');
  });
});

describe('nextTransportClock', () => {
  it('cycles film → recording → capture → film when the take has a start', () => {
    assert.equal(nextTransportClock('film', true), 'recording');
    assert.equal(nextTransportClock('recording', true), 'capture');
    assert.equal(nextTransportClock('capture', true), 'film');
  });
  it('skips the time of day when the start is unknown', () => {
    assert.equal(nextTransportClock('film', false), 'recording');
    assert.equal(nextTransportClock('recording', false), 'film');
    assert.equal(nextTransportClock('capture', false), 'film');
  });
});

describe('formatTransportTime', () => {
  it('writes mm:ss and puts the hours in front from an hour on', () => {
    assert.equal(formatTransportTime(0), '00:00');
    assert.equal(formatTransportTime(288.2), '04:48');
    assert.equal(formatTransportTime(3725), '1:02:05');
    assert.equal(formatTransportTime(86400), '24:00:00');
  });
  it('never goes negative or NaN', () => {
    assert.equal(formatTransportTime(-5), '00:00');
    assert.equal(formatTransportTime(NaN), '00:00');
  });
});

// Local wall-clock instants, so the clock-axis tests read the same in any time zone.
const local = (iso: string) => dayjs(iso).valueOf();

describe('clockTickStepSec', () => {
  it('ticks a span about eight times with a round clock step', () => {
    assert.equal(clockTickStepSec(95 * 60), 900);
    assert.equal(clockTickStepSec(86400), 10800);
    assert.equal(clockTickStepSec(10 * 60), 120);
    assert.equal(clockTickStepSec(30), 5);
    assert.equal(clockTickStepSec(0), 1);
    assert.equal(clockTickStepSec(10 * 86400), 86400);
  });
});

describe('clockTicksMs', () => {
  it("lands on the wall clock's round times within the span", () => {
    const ticks = clockTicksMs(local('2026-09-28T14:07:00'), local('2026-09-28T15:42:00'), 900);
    assert.deepEqual(
      ticks.map((t) => dayjs(t).format('HH:mm')),
      ['14:15', '14:30', '14:45', '15:00', '15:15', '15:30'],
    );
  });
  it("includes ticks at the span's own ends and keeps counting across midnight", () => {
    const ticks = clockTicksMs(local('2026-09-28T22:00:00'), local('2026-09-29T02:00:00'), 3600);
    assert.deepEqual(
      ticks.map((t) => dayjs(t).format('MM-DD HH:mm')),
      ['09-28 22:00', '09-28 23:00', '09-29 00:00', '09-29 01:00', '09-29 02:00'],
    );
  });
  it('is empty for a bad step or span', () => {
    assert.deepEqual(clockTicksMs(10, 5, 60), []);
    assert.deepEqual(clockTicksMs(0, 10, 0), []);
    assert.deepEqual(clockTicksMs(NaN, 10, 60), []);
  });
});

describe('formatClockTick', () => {
  it('writes HH:mm, with seconds when the ticks are under a minute apart', () => {
    const t = local('2026-09-28T14:15:30');
    assert.equal(formatClockTick(t, 900), '14:15');
    assert.equal(formatClockTick(t, 30), '14:15:30');
  });
});

describe('clockAxisLabel', () => {
  it('names the date, or both dates when the take crosses midnight', () => {
    assert.equal(clockAxisLabel(local('2026-09-28T14:00'), local('2026-09-28T16:00')), 'Time of day (Sep 28, 2026)');
    assert.equal(
      clockAxisLabel(local('2026-09-28T22:00'), local('2026-09-29T02:00')),
      'Time of day (Sep 28 – 29, 2026)',
    );
    assert.equal(
      clockAxisLabel(local('2026-09-30T22:00'), local('2026-10-01T02:00')),
      'Time of day (Sep 30 – Oct 1, 2026)',
    );
    assert.equal(
      clockAxisLabel(local('2026-12-31T22:00'), local('2027-01-01T02:00')),
      'Time of day (Dec 31, 2026 – Jan 1, 2027)',
    );
  });
});

describe('playerTimeAtCaptureMs', () => {
  // A one-a-minute take of 11 frames (indices 0..10), paused 5 min between frames 4 and 5.
  const capture = (i: number) => (i <= 4 ? i * 60000 : i * 60000 + 300000);
  it('places an instant at its frame, or proportionally between the two around it', () => {
    assert.equal(playerTimeAtCaptureMs(capture, 10, 60, 0), 0);
    assert.equal(playerTimeAtCaptureMs(capture, 10, 60, 180000), 180);
    assert.equal(playerTimeAtCaptureMs(capture, 10, 60, 90000), 90);
    assert.equal(playerTimeAtCaptureMs(capture, 10, 60, 900000), 600);
  });
  it('puts an instant inside a pause proportionally in the gap the line crosses', () => {
    // Frame 4 at 240 s and frame 5 at 600 s of real time: 420 s is half-way through the gap → 4.5 frames.
    assert.equal(playerTimeAtCaptureMs(capture, 10, 60, 420000), 270);
  });
  it('is null outside the take or without times', () => {
    assert.equal(playerTimeAtCaptureMs(capture, 10, 60, -1), null);
    assert.equal(playerTimeAtCaptureMs(capture, 10, 60, 900001), null);
    assert.equal(
      playerTimeAtCaptureMs(() => null, 10, 60, 0),
      null,
    );
    assert.equal(playerTimeAtCaptureMs(capture, -1, 60, 0), null);
    assert.equal(playerTimeAtCaptureMs(capture, 10, 0, 0), null);
  });
});

// ---- Camera-timed recordings (doc `timing: 'camera'`) ----
// Seven frames as a camera delivers them: ~0.12 s apart, with a shutter recalibration (1.4 s) after the
// fourth. Capture times are ms since the take's start; the first frame is not at 0.
const captureMs = [40, 160, 275, 400, 1800, 1915, 2040];
const camera = { timing: 'camera' as const, frameCount: 7, fps: 3.5, duration: 2 };
const raw = (i: number) => i + 1; // an untrimmed take: player index i is recording frame i + 1

describe('isCameraTimed / cameraMeanGapSec / secondsPerFrame', () => {
  it("is the doc's marker, and never a time-lapse", () => {
    assert.equal(isCameraTimed(camera), true);
    assert.equal(isCameraTimed(ordinary), false);
    assert.equal(isCameraTimed(lapse), false);
    assert.equal(isCameraTimed({ timing: null }), false);
    assert.equal(isCameraTimed({ ...lapse, timing: 'camera' }), false);
  });

  it('takes the mean gap from the capture times, else the doc', () => {
    assert.ok(Math.abs(cameraMeanGapSec(camera, captureMs) - 2 / 6) < 1e-12);
    assert.equal(cameraMeanGapSec(camera), 1 / 3.5);
    assert.equal(cameraMeanGapSec(camera, [5]), 1 / 3.5);
    assert.equal(cameraMeanGapSec({ timing: 'camera', frameCount: 50, duration: 6 }), 6 / 50);
    assert.equal(cameraMeanGapSec({ timing: 'camera' }), 0.2);
    assert.equal(secondsPerFrame(camera), 1 / 3.5);
    assert.ok(Math.abs(secondsPerFrame(camera, captureMs) - 2 / 6) < 1e-12);
    // The capture times mean nothing to a grid take.
    assert.equal(secondsPerFrame(ordinary, captureMs), 0.2);
    assert.equal(secondsPerFrame(lapse, captureMs), 60);
  });
});

describe('playerClock', () => {
  it('is the old arithmetic, to the digit, for an ordinary recording and a time-lapse', () => {
    const o = playerClock(ordinary, 140, raw);
    assert.equal(o.uniform, true);
    assert.equal(o.secondsPerFrame, 0.2);
    for (const i of [0, 1, 7, 33, 140]) assert.equal(o.timeOf(i), i * 0.2);
    for (const s of [0, 0.09, 0.1, 1.4, 6.61, 27.9, 99]) {
      assert.equal(o.indexAt(s), Math.max(0, Math.min(140, Math.round(s / 0.2))));
    }
    assert.equal(o.indexAt(-3), 0);
    assert.equal(o.holdMs(0), 200);
    assert.equal(o.holdMs(77), 200);
    const l = playerClock(lapse, 1440, raw);
    assert.equal(l.timeOf(1440), 86400);
    assert.equal(l.indexAt(90), 2);
    // A time-lapse is a sped-up film: it still paces at 5 fps.
    assert.equal(l.holdMs(3), 200);
    // Capture times handed to a grid take change nothing.
    assert.equal(playerClock(ordinary, 140, raw, captureMs).timeOf(7), 7 * 0.2);
  });

  it("places an untrimmed camera-timed take's frames at their own capture times", () => {
    const c = playerClock(camera, 6, raw, captureMs);
    assert.equal(c.uniform, false);
    for (let i = 0; i <= 6; i++) assert.ok(Math.abs(c.timeOf(i) - (captureMs[i] - captureMs[0]) / 1000) < 1e-9);
    assert.ok(Math.abs(c.secondsPerFrame - 2 / 6) < 1e-9);
    // Between two frames, proportionally.
    assert.ok(Math.abs(c.timeOf(3.5) - (0.36 + 1.76) / 2) < 1e-9);
    assert.equal(c.timeOf(-2), 0);
  });

  it('finds the frame nearest to a time, the gap included', () => {
    const c = playerClock(camera, 6, raw, captureMs);
    for (let i = 0; i <= 6; i++) assert.equal(c.indexAt(c.timeOf(i)), i);
    assert.equal(c.indexAt(0.05), 0);
    assert.equal(c.indexAt(0.07), 1);
    // Inside the 1.4 s gap between frames 3 (0.36 s) and 4 (1.76 s): the nearer end.
    assert.equal(c.indexAt(1.0), 3);
    assert.equal(c.indexAt(1.1), 4);
    assert.equal(c.indexAt(-1), 0);
    assert.equal(c.indexAt(99), 6);
    assert.equal(c.indexAt(NaN), 0);
  });

  it('holds each frame for its own gap, and the last for the mean', () => {
    const c = playerClock(camera, 6, raw, captureMs);
    assert.ok(Math.abs(c.holdMs(0) - 120) < 1e-6);
    assert.ok(Math.abs(c.holdMs(3) - 1400) < 1e-6);
    assert.ok(Math.abs(c.holdMs(5) - 125) < 1e-6);
    assert.ok(Math.abs(c.holdMs(6) - 2000 / 6) < 1e-6);
    // The tick after the last frame is due one slot later, so the last frame is not cut short.
    assert.ok(Math.abs(c.timeOf(7) - (2 + 2 / 6)) < 1e-9);
  });

  it("runs a trimmed clip's kept stretches end to end, each frame keeping its own length", () => {
    // Kept: recording frames 2–3 and 6–7 (player 0..3).
    const map = [2, 3, 6, 7];
    const c = playerClock(camera, 3, (i) => map[i] ?? 0, captureMs);
    assert.equal(c.timeOf(0), 0);
    // Frame 2 lasts until frame 3 was taken (115 ms); frame 3 until frame 4 (125 ms) — the cut after it
    // collapses, the 1.4 s gap that followed frame 4 is not in the clip; frame 6 until frame 7 (125 ms).
    assert.ok(Math.abs(c.timeOf(1) - 0.115) < 1e-9);
    assert.ok(Math.abs(c.timeOf(2) - 0.24) < 1e-9);
    assert.ok(Math.abs(c.timeOf(3) - 0.365) < 1e-9);
    assert.equal(c.indexAt(0.3), 2);
    assert.equal(c.indexAt(0.31), 3);
    // A cut that ends on the frame before the shutter gap keeps that frame's long slot: it was on screen
    // that long in the take.
    const gap = playerClock(camera, 1, (i) => [4, 5][i] ?? 0, captureMs);
    assert.ok(Math.abs(gap.timeOf(1) - 1.4) < 1e-9);
  });

  it('is a grid at the mean rate until the capture times are read, and plays in real time', () => {
    const c = playerClock(camera, 6, raw, null);
    assert.equal(c.uniform, true);
    assert.equal(c.secondsPerFrame, 1 / 3.5);
    assert.ok(Math.abs(c.timeOf(7) - 2) < 1e-12);
    assert.equal(c.indexAt(1.2), 4); // round(4.2)
    assert.ok(Math.abs(c.holdMs(2) - 1000 / 3.5) < 1e-9);
    assert.equal(playerClock(camera, 6, raw, [12]).uniform, true);
  });

  it('survives a mapping that falls outside the take', () => {
    const c = playerClock(camera, 2, () => 0, captureMs);
    assert.ok(Math.abs(c.timeOf(2) - (2 * 2) / 6) < 1e-9); // the mean gap each
    assert.equal(c.indexAt(0.6), 2);
  });
});

describe('formatFrameClock', () => {
  it("is the film time of an evenly-paced recording's frame", () => {
    assert.equal(formatFrameClock(ordinary, 1), formatFilmTime(0));
    assert.equal(formatFrameClock(ordinary, 50), formatFilmTime(49));
    assert.equal(formatFrameClock(ordinary, 50, captureMs), '0:09.8');
  });

  it("is a camera-timed frame's real time since the first frame", () => {
    assert.equal(formatFrameClock(camera, 1, captureMs), '0:00.0');
    assert.equal(formatFrameClock(camera, 5, captureMs), '0:01.8');
    assert.equal(formatFrameClock(camera, 99, captureMs), '0:02.0');
    // Without the times: the mean rate.
    assert.equal(formatFrameClock(camera, 8), '0:02.0');
  });
});
