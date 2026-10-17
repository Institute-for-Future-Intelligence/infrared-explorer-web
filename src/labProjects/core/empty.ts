/*
 * Whether a project is still empty: no message, no capture, no plan, no
 * report, and the name New Project gave it. Such a project is not kept once
 * the user leaves its page (discard.ts). The model does not count: it is a
 * setting for a conversation, and one that never started leaves nothing to
 * keep.
 */

import type {ProjectBundle} from './types';

/** The name the server gives a new project (functions/src/store.ts emptyProject). */
export const NEW_PROJECT_TITLE = 'Untitled Project';

/**
 * A project's title as the screen shows it. Projects are called experiments
 * on screen (2026-10-16), but the stored name of an unnamed one stays
 * NEW_PROJECT_TITLE: the server names a project only while it carries that
 * name, and apps already out compare against it.
 */
export function shownTitle(title: string): string {
  return title === NEW_PROJECT_TITLE ? 'Untitled Experiment' : title;
}

export function isEmptyProject(b: ProjectBundle | null): boolean {
  if (!b) {
    return false;
  }
  const p = b.project;
  return (
    p.seq === 0 &&
    b.turns.length === 0 &&
    p.takes.length === 0 &&
    p.plan == null &&
    p.report == null &&
    !p.busy &&
    p.title === NEW_PROJECT_TITLE
  );
}
