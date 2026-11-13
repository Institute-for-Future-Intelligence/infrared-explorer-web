/*
 * What a capture is called in its project: the number and the name its tile
 * shows everywhere and the AI is told.
 *
 * A project made since 2026-11-13 by a client that shows the names numbers
 * photos and recordings apart, each from 1 (`numbering: 'kind'`): Photo 1, 2,
 * … and Recording 1, 2, … — a video and a time-lapse are both recordings. An
 * older project has one sequence over them all: Capture 1, 2, …, "#2" on a
 * tile. Either way the server gives the number out when a capture is filed
 * (functions/src/store.ts takeNumbersUsed); one that has been sent to the AI
 * keeps it for good, and one taken out before it was sent gives it back
 * (closeNumberGap). A take that arrives without a number (a server from
 * before numbers) is numbered here the same way, after the numbered ones, in
 * the order added.
 */

import type {Note, Project, SharedProject, Take} from './types';

export function captureNumbers(takes: Pick<Take, 'takeId' | 'at' | 'n'>[]): Map<string, number> {
  const out = new Map<string, number>();
  let next = 0;
  for (const t of takes) {
    if (t.n != null) {
      out.set(t.takeId, t.n);
      next = Math.max(next, t.n);
    }
  }
  for (const t of [...takes].sort((a, b) => a.at - b.at)) {
    if (t.n == null) {
      out.set(t.takeId, ++next);
    }
  }
  return out;
}

/** What a capture is numbered as where each kind is numbered from 1. */
export type CaptureKind = 'photo' | 'recording';

/** What a capture is called: its number, and the words for it. */
export interface CaptureName {
  n: number;
  /** Null in a project with one sequence over photos and recordings. */
  kind: CaptureKind | null;
  /** In a sentence: "Capture 3", or "Photo 1" / "Recording 2". */
  label: string;
  /** On a tile: "#3", or the name itself where "#1" would be a photo and a recording both. */
  tag: string;
}

/**
 * The name of capture `n` (English, as the server tells the AI:
 * functions/src/prompt.ts captureLabel). `kind` is null or absent for a
 * project with one sequence.
 */
export function captureName(n: number, kind?: CaptureKind | null): CaptureName {
  const label = kind === 'photo' ? `Photo ${n}` : kind === 'recording' ? `Recording ${n}` : `Capture ${n}`;
  return {n, kind: kind ?? null, label, tag: kind ? label : `#${n}`};
}

/** Every capture's name in the project, by take id. */
export function captureNames(
  project: Pick<Project | SharedProject, 'numbering'> & {takes: Pick<Take, 'takeId' | 'at' | 'n' | 'source'>[]},
): Map<string, CaptureName> {
  const byKind = project.numbering === 'kind';
  const numbers = captureNumbers(project.takes);
  const out = new Map<string, CaptureName>();
  for (const t of project.takes) {
    const n = numbers.get(t.takeId);
    if (n != null) {
      out.set(t.takeId, captureName(n, byKind ? (t.source === 'photos' ? 'photo' : 'recording') : null));
    }
  }
  return out;
}

/** The name a removed capture had, from the note of its removal; null when the note carries no number. */
export function removedCaptureName(note: Extract<Note, {type: 'takeRemoved'}>): CaptureName | null {
  return note.n != null ? captureName(note.n, note.kind) : null;
}
