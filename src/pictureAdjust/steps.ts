/**
 * What the Process panel's Undo and Redo walk (processPanel.tsx): every set of settings the panel has
 * rested on since it opened on a picture, and which one it is on. The capture app's rule, from its Adjust
 * panel: a step is one whole move — a drag of a slider from press to release, an Auto, an effect put on or
 * taken off, a Reset (which is a step like the others, so Undo brings back what it cleared). A new step
 * ends what Redo could have gone forward to. The steps go when the panel closes or moves to another
 * picture.
 */
import { PictureAdjust, sameAdjust } from './core/pictureAdjustParams';

/** The steps Undo can walk back; the oldest are let go past this. */
export const STEPS_KEPT = 50;

export interface Steps {
  list: readonly PictureAdjust[];
  at: number;
}

export const firstStep = (initial: PictureAdjust): Steps => ({ list: [initial], at: 0 });

/** `now` becomes a step — unless it is the one the panel is on. */
export function withStep(steps: Steps, now: PictureAdjust): Steps {
  const { list, at } = steps;
  if (sameAdjust(list[at], now)) return steps;
  const kept = list.slice(Math.max(0, at + 2 - STEPS_KEPT), at + 1);
  return { list: [...kept, now], at: kept.length };
}

/** Whether `now` — what the panel shows — is the step it is on (a slider under the pointer is not, yet). */
export const resting = (steps: Steps, now: PictureAdjust): boolean => sameAdjust(steps.list[steps.at], now);
export const canUndo = (steps: Steps, now: PictureAdjust): boolean => steps.at > 0 || !resting(steps, now);
export const canRedo = (steps: Steps, now: PictureAdjust): boolean =>
  resting(steps, now) && steps.at < steps.list.length - 1;
