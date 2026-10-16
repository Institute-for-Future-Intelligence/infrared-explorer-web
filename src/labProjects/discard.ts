/*
 * An empty project is not kept — the app's lib/labProjects/discard.ts rule.
 * New Project makes the project on the server at once (its page needs the
 * id for everything it does), so a user who leaves the page without a
 * message, a plan or a name for it would otherwise find an "Untitled
 * Project" in the list. Leaving such a project deletes it: from the page's
 * store at once, from the server without waiting for its answer.
 */

import { deleteProject } from './api';
import { isEmptyProject } from './core/empty';
import { isRunning } from './runner';
import { bundleOf, dropBundle } from './store';

/**
 * Called as the user leaves a project's page; true when the project was
 * discarded. The caller vouches that the bundle is the server's own: this
 * only asks whether that copy is empty and nothing is on its way that would
 * fill it.
 */
export function discardIfEmpty(projectId: string): boolean {
  if (!isEmptyProject(bundleOf(projectId)) || isRunning(projectId)) {
    return false;
  }
  dropBundle(projectId);
  deleteProject(projectId).catch(() => undefined);
  return true;
}
