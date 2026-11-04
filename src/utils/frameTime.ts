/**
 * One time base for a recording's frames (docs/time-lapse-experiments.md).
 *
 * An ordinary recording is a 5 fps tick grid (constants FPS): player index i sits at i / FPS seconds. A
 * TIME-LAPSE recording (doc `timelapse.intervalSec` > 0) took one frame every intervalSec seconds of
 * recording time, so index i sits at i × intervalSec seconds — minutes or hours apart, not fifths of a
 * second — while PLAYBACK still paces at FPS (a sped-up film). Every surface that turns a frame index
 * into a RECORDING time (key moments, the T(t) axis, annotation windows, the report's figure instants,
 * the capture-time overlay) reads it from here. The transport clock opens on the film's own time (frames
 * at FPS), so a take's slider reads like any other clip's — and on a time-lapse the viewer can switch
 * it (TransportClock, below) to the recording's real elapsed time or the frames' time of day. FPS itself
 * is kept only where it means pacing or that film clock (the play tick, the preload distance, the 3D
 * surface's frame rate, the control bar).
 *
 * On the doc `duration` is always seconds of recording time and `frameCount` always the number of frames:
 * when both are present neither is derived from the other.
 */
import dayjs from 'dayjs';
import { FPS } from './constants';

/** One pause of a time-lapse take, real seconds since its `startedAt` (`startSec < endSec`), as the doc lists it. */
export interface TimelapsePause {
  startSec: number;
  endSec: number;
}

/** The doc fields the time base is read from (an Experiment, an ExperimentDoc or a card row). */
export interface FrameTimeSource {
  duration?: number;
  frameCount?: number;
  timelapse?: { intervalSec: number; pausedSec?: number; pauses?: TimelapsePause[] } | null;
  /** Epoch ms the take started; a time-lapse's capture-time clock counts from it. */
  startedAt?: number;
}

/** Whether the frames are a time-lapse (a positive interval on the doc). */
export const isTimelapse = (exp: FrameTimeSource): boolean => {
  const s = exp.timelapse?.intervalSec;
  return typeof s === 'number' && Number.isFinite(s) && s > 0;
};

/** Seconds of recording time between two consecutive frames: a time-lapse's interval, else 1 / FPS. */
export const secondsPerFrame = (exp: FrameTimeSource): number =>
  isTimelapse(exp) ? exp.timelapse!.intervalSec : 1 / FPS;

/**
 * The last player index of the whole (untrimmed) recording: frameCount − 1 when the doc carries a frame
 * count, else the 5 fps derivation round(duration × FPS) − 1. Never below 0. (A trimmed clip's own last
 * index comes from its segments — see useMappingIndex.)
 */
export const lastFrameIndexOf = (exp: FrameTimeSource): number => {
  const n = exp.frameCount;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 1) return Math.floor(n) - 1;
  const d = typeof exp.duration === 'number' && Number.isFinite(exp.duration) ? exp.duration : 0;
  return Math.max(0, Math.round(d * FPS) - 1);
};

/** Recording time (seconds) of a player index. Unrounded — callers round as they display or store it. */
export const frameTimeSec = (exp: FrameTimeSource, playerIndex: number): number => playerIndex * secondsPerFrame(exp);

/**
 * How much wall-clock time the take's pauses add to a frame at `recordingSec` of recording time (its grid
 * slot): the lengths of every pause that began before that slot. The doc logs pauses in REAL seconds since
 * the start, and pause i began at recording time `startSec_i − (lengths of the pauses before it)`; a frame
 * whose slot is at or before that instant was taken before the pause, one after it waited the pause out.
 * 0 without a log. Mirrors the app's `frameTime.pausedBeforeMs`.
 */
export const pausedBeforeSec = (pauses: TimelapsePause[] | null | undefined, recordingSec: number): number => {
  if (!pauses || pauses.length === 0) return 0;
  let added = 0;
  for (const p of pauses) {
    const length = p.endSec - p.startSec;
    if (!(length > 0)) continue;
    if (p.startSec - added >= recordingSec) break;
    added += length;
  }
  return added;
};

/**
 * Whether the capture-time clock can be trusted to the frame: a take that was never paused, or one whose doc
 * lists its pauses (`timelapse.pauses`, uploads since 2026-11). A paused take with only `pausedSec` (older
 * uploads) is approximate — a frame after a pause was really taken up to pausedSec later than the grid says.
 */
export const captureTimeIsExact = (exp: FrameTimeSource): boolean =>
  !((exp.timelapse?.pausedSec ?? 0) > 0) || (exp.timelapse?.pauses?.length ?? 0) > 0;

/**
 * Epoch ms when recording frame `recordingFrame` (1-based) of a time-lapse was taken: the take's start plus
 * the frame's recording time plus the pauses that preceded it. Null for an ordinary recording or a doc with
 * no `startedAt`. The capture-time overlay reads this.
 */
export const frameCaptureTimeMs = (exp: FrameTimeSource, recordingFrame: number): number | null => {
  if (!isTimelapse(exp) || typeof exp.startedAt !== 'number' || !Number.isFinite(exp.startedAt)) return null;
  const recordingSec = Math.max(0, recordingFrame - 1) * secondsPerFrame(exp);
  return exp.startedAt + (recordingSec + pausedBeforeSec(exp.timelapse?.pauses, recordingSec)) * 1000;
};

/** "1 s", "30 s", "1 min", "2.5 min", "1 h" — how a time-lapse interval is written. '' when invalid. */
export const formatIntervalSec = (sec: number): string => {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const trim = (v: number) => String(Number(v.toFixed(2)));
  if (sec < 60) return `${trim(sec)} s`;
  if (sec < 3600) return `${trim(sec / 60)} min`;
  return `${trim(sec / 3600)} h`;
};

/** The unit a time axis is drawn in, chosen from the span it covers. */
export interface TimeAxis {
  unit: 'second' | 'minute' | 'hour';
  /** Seconds per unit: a time in seconds divided by it is the axis value. */
  divisor: number;
  /** The axis title. */
  label: string;
}

const SECOND_AXIS: TimeAxis = { unit: 'second', divisor: 1, label: 'Time (Second)' };
const MINUTE_AXIS: TimeAxis = { unit: 'minute', divisor: 60, label: 'Time (Minute)' };
const HOUR_AXIS: TimeAxis = { unit: 'hour', divisor: 3600, label: 'Time (Hour)' };

/**
 * Seconds below ~3 minutes, minutes below ~3 hours, hours above: a short clip keeps the axis it always had
 * and a long take gets ticks one can read ("2.5", in hours, rather than "9000").
 */
export const timeAxisFor = (spanSec: number, secondsPerFrame?: number): TimeAxis =>
  // Frames under a second apart are an ordinary clip (5 fps, or a video's own rate): its axis
  // stays in seconds whatever its length, exactly as before. A time-lapse (an interval of a
  // second or more) reads its span.
  secondsPerFrame != null && secondsPerFrame < 1
    ? SECOND_AXIS
    : spanSec >= 3 * 3600
      ? HOUR_AXIS
      : spanSec >= 3 * 60
        ? MINUTE_AXIS
        : SECOND_AXIS;

/** A value in seconds written in the axis's unit, trailing decimals trimmed ("0.5", "12"). */
export const formatTimeAxis = (sec: number, axis: TimeAxis): string => String(Number((sec / axis.divisor).toFixed(2)));

/**
 * How many times faster than real time a time-lapse plays: its interval times the playback rate
 * (one frame a minute at 5 fps → 300). 0 for an ordinary recording. Scientific viewers state this
 * beside the clock, so the film's speed is never a guess.
 */
export const playbackSpeedFactor = (exp: FrameTimeSource): number =>
  isTimelapse(exp) ? secondsPerFrame(exp) * FPS : 0;

/** `300×` / `12.5×` — the factor with at most one decimal. */
export const formatSpeedFactor = (factor: number): string => {
  const r = Math.round(Math.max(0, factor) * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r}×`;
};

/**
 * The film's clock at a player index, to the tenth of a second: `0:09.8`, `1:02:05.0`. The transport
 * clock's own time base (frames at FPS, a time-lapse included — see the note at the top), but finer
 * than its whole seconds, so the frames of one second read apart: the digital twin's frame picker names
 * the frames the owner picked by it.
 */
export const formatFilmTime = (playerIndex: number): string => {
  const tenths = Math.round((Math.max(0, playerIndex) / FPS) * 10);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = Math.floor((tenths % 600) / 10);
  const rest = `${String(s).padStart(2, '0')}.${tenths % 10}`;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
};

/**
 * What the control bar's readout, scrub preview and slider tooltips count in. 'film' is the video's own
 * time (frames at FPS — every recording opens on it, and an ordinary one has nothing else); a time-lapse
 * can switch to 'recording' (real elapsed time, its frames an interval apart) and, when its start is
 * known, 'capture' (the frame's time of day). On the time of day the T(t) chart's axis is the wall
 * clock's too (clockTicksMs, below). The choice is this viewer's (viewerPrefs through the store's
 * transportClock), not the experiment's.
 */
export type TransportClock = 'film' | 'recording' | 'capture';

/** The clock a click on the readout turns to: film → recording → (capture →) film. */
export const nextTransportClock = (clock: TransportClock, captureAvailable: boolean): TransportClock =>
  clock === 'film' ? 'recording' : clock === 'recording' && captureAvailable ? 'capture' : 'film';

/**
 * A duration for the transport clock: `mm:ss`, with an hours field in front once it reaches an hour
 * (`04:48`, `1:02:05`, `24:00:00`). Whole seconds — the slider never shows finer.
 */
export const formatTransportTime = (seconds: number): string => {
  const total = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
};

// ---- The time-of-day axis ----
// The T(t) chart's x-axis on a time-lapse whose transport clock is the time of day: ticks at round
// wall-clock times (14:00, 14:15, …) in the viewer's time zone, while the chart's rows keep recording
// seconds. Pure; the chart places each tick with playerTimeAtCaptureMs.

/** The steps a clock axis may tick in, seconds: whole seconds and minutes up to a day. */
const CLOCK_STEPS_SEC = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

/**
 * The round clock step (seconds) that ticks a span of `spanSec` about `intervals` times: the smallest
 * listed step that gives that many ticks or fewer (95 min → 15 min, 24 h → 3 h).
 */
export const clockTickStepSec = (spanSec: number, intervals = 8): number => {
  const raw = Math.max(0, Number.isFinite(spanSec) ? spanSec : 0) / Math.max(1, intervals);
  return CLOCK_STEPS_SEC.find((s) => s >= raw) ?? CLOCK_STEPS_SEC[CLOCK_STEPS_SEC.length - 1];
};

/**
 * Epoch ms of the round clock times `stepSec` apart within [startMs, endMs]. Each day's ticks count from
 * its own local midnight, so they read 14:00, 14:15 … in the viewer's time zone and a take that runs
 * across a daylight-saving change stays on the hour after it. Capped so a bad step can't flood the chart.
 */
export const clockTicksMs = (startMs: number, endMs: number, stepSec: number): number[] => {
  const out: number[] = [];
  if (!(stepSec > 0) || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return out;
  const stepMs = stepSec * 1000;
  let day = dayjs(startMs).startOf('day');
  while (day.valueOf() <= endMs && out.length < 2000) {
    const dayStart = day.valueOf();
    const nextDay = day.add(1, 'day').valueOf();
    if (!(nextDay > dayStart)) break;
    for (let t = dayStart; t < nextDay && t <= endMs && out.length < 2000; t += stepMs) {
      if (t >= startMs) out.push(t);
    }
    day = dayjs(nextDay);
  }
  return out;
};

/** A clock tick's label: `14:15`, or `14:15:30` when the ticks are under a minute apart. */
export const formatClockTick = (ms: number, stepSec: number): string =>
  dayjs(ms).format(stepSec < 60 ? 'HH:mm:ss' : 'HH:mm');

/**
 * The clock axis's title: `Time of day (Sep 28, 2026)`, both dates when the take crosses midnight
 * (`Time of day (Sep 28 – 29, 2026)`).
 */
export const clockAxisLabel = (startMs: number, endMs: number): string => {
  const a = dayjs(startMs);
  const b = dayjs(endMs);
  if (a.isSame(b, 'day')) return `Time of day (${a.format('MMM D, YYYY')})`;
  if (a.isSame(b, 'month')) return `Time of day (${a.format('MMM D')} – ${b.format('D, YYYY')})`;
  if (a.isSame(b, 'year')) return `Time of day (${a.format('MMM D')} – ${b.format('MMM D, YYYY')})`;
  return `Time of day (${a.format('MMM D, YYYY')} – ${b.format('MMM D, YYYY')})`;
};

/**
 * Where an instant falls on a chart whose x is player time (index × secondsPerFrame): the index taken at
 * that time, with a fraction of the way to the next frame when it falls between two — so a round clock
 * time sits proportionally inside a pause's or a clip cut's gap, where the drawn line crosses it.
 * `captureTimeOf` must not decrease with the index (the frames are in order). Null before the first
 * frame's time, after the last's, or when a time is unknown.
 */
export const playerTimeAtCaptureMs = (
  captureTimeOf: (playerIndex: number) => number | null,
  lastIndex: number,
  secondsPerFrame: number,
  ms: number,
): number | null => {
  if (!(lastIndex >= 0) || !(secondsPerFrame > 0) || !Number.isFinite(ms)) return null;
  const first = captureTimeOf(0);
  const last = captureTimeOf(lastIndex);
  if (first == null || last == null || ms < first || ms > last) return null;
  // The last index taken at or before `ms` (lo) and the first after it (hi).
  let lo = 0;
  let hi = lastIndex;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const t = captureTimeOf(mid);
    if (t == null) return null;
    if (t <= ms) lo = mid;
    else hi = mid;
  }
  const tLo = captureTimeOf(lo);
  const tHi = captureTimeOf(hi);
  if (tLo == null || tHi == null) return null;
  const frac = tHi > tLo ? (ms - tLo) / (tHi - tLo) : 0;
  return (lo + Math.min(1, Math.max(0, frac))) * secondsPerFrame;
};
