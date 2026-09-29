/**
 * One time base for a recording's frames (docs/time-lapse-experiments.md).
 *
 * An ordinary recording is a 5 fps tick grid (constants FPS): player index i sits at i / FPS seconds. A
 * TIME-LAPSE recording (doc `timelapse.intervalSec` > 0) took one frame every intervalSec seconds of
 * recording time, so index i sits at i × intervalSec seconds — minutes or hours apart, not fifths of a
 * second — while PLAYBACK still paces at FPS (a sped-up film). Every surface that turns a frame index
 * into a time (the transport clock, key moments, the T(t) axis, annotation windows, the report's figure
 * instants) reads it from here; FPS itself is kept only where it means pacing (the play tick, the preload
 * distance, the 3D surface's frame rate).
 *
 * On the doc `duration` is always seconds of recording time and `frameCount` always the number of frames:
 * when both are present neither is derived from the other.
 */
import { FPS } from './constants';

/** The doc fields the time base is read from (an Experiment, an ExperimentDoc or a card row). */
export interface FrameTimeSource {
  duration?: number;
  frameCount?: number;
  timelapse?: { intervalSec: number } | null;
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
