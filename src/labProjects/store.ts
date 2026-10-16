/*
 * What the AI Project pages hold in memory: each open project's bundle (the
 * project, its turns, its images) and the run views the runner keeps per
 * project. Module state, in a zustand store, so a turn that is streaming
 * keeps writing into its bundle after the page is left and the page finds
 * it where it was when it comes back — the app keeps the same in its cache
 * (lib/labProjects/cache.ts); the website has no offline copy, so a bundle
 * is seeded from labProjectGet each time a page opens.
 */

import { create } from 'zustand';
import { getProject } from './api';
import type { ProjectBundle, ProjectImage, Turn } from './core/types';
import type { RunView } from './runner';

interface LabState {
  bundles: Record<string, ProjectBundle>;
  runs: Record<string, RunView>;
}

export const useLabStore = create<LabState>(() => ({ bundles: {}, runs: {} }));

export const bundleOf = (projectId: string): ProjectBundle | null => useLabStore.getState().bundles[projectId] ?? null;

export function setBundle(b: ProjectBundle): void {
  useLabStore.setState((s) => ({ bundles: { ...s.bundles, [b.project.id]: b } }));
}

/** Change a project's bundle in place when there is one; nothing happens for a project no page has opened. */
export function updateBundle(projectId: string, fn: (b: ProjectBundle) => ProjectBundle): void {
  const b = bundleOf(projectId);
  if (b) {
    setBundle(fn(b));
  }
}

export function dropBundle(projectId: string): void {
  useLabStore.setState((s) => {
    const rest = { ...s.bundles };
    delete rest[projectId];
    return { bundles: rest };
  });
}

/** The project as the server has it now, kept here. */
export async function refreshBundle(projectId: string): Promise<ProjectBundle> {
  const b = await getProject(projectId);
  setBundle(b);
  return b;
}

/** The page's subscription to one project's bundle (null until seeded). */
export const useBundle = (projectId: string): ProjectBundle | null => useLabStore((s) => s.bundles[projectId] ?? null);

// ------------------------------------------------------------ bundle ops

export function upsertTurn(b: ProjectBundle, t: Turn): ProjectBundle {
  const turns = b.turns.filter((x) => x.seq !== t.seq);
  turns.push(t);
  turns.sort((a, c) => a.seq - c.seq);
  return { ...b, turns };
}

export function upsertImage(b: ProjectBundle, img: ProjectImage): ProjectBundle {
  return { ...b, images: [...b.images.filter((i) => i.id !== img.id), img] };
}

/** The captures a turn carried have been sent to the AI: the server marks them a moment after the turn, this marks them with it. */
export function announceTakes(b: ProjectBundle, t: Turn): ProjectBundle {
  const ids = new Set((t.event?.takes ?? []).map((k) => k.takeId));
  if (ids.size === 0) {
    return b;
  }
  const takes = b.project.takes.map((k) => (ids.has(k.takeId) ? { ...k, announced: true } : k));
  return { ...b, project: { ...b.project, takes } };
}
