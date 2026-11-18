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
  // each project's title as its page last showed it (the owner's or a shared one), for the breadcrumbs of a
  // recording opened from that page (hooks/useNavTrail.ts)
  titles: Record<string, string>;
}

export const useLabStore = create<LabState>(() => ({ bundles: {}, runs: {}, titles: {} }));

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

export function noteTitle(projectId: string, title: string): void {
  if (useLabStore.getState().titles[projectId] !== title) {
    useLabStore.setState((s) => ({ titles: { ...s.titles, [projectId]: title } }));
  }
}

export const titleOf = (projectId: string): string | undefined => useLabStore.getState().titles[projectId];

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

const DOC_WRITER = { plan: 'write_plan', report: 'write_report' } as const;
const DOC_EDIT = { plan: 'planEdited', report: 'reportEdited' } as const;

/**
 * Delete from Here as the page shows it while the server does it (the page does not wait: the
 * server's answer, the project as it then is, takes this one's place). The turns from `fromSeq` go,
 * with the pictures only they name and the captures only they sent, as the server works it out
 * (the app's functions/src/rewind.ts). The plan and the report go back to wordings this page does
 * not hold: one that every turn that wrote it is leaving with goes at once, another stays as it is
 * until the answer brings the earlier wording.
 */
export function cutFrom(b: ProjectBundle, fromSeq: number): ProjectBundle {
  const kept = b.turns.filter((t) => t.seq < fromSeq);
  const cut = b.turns.filter((t) => t.seq >= fromSeq);
  const named = (turns: Turn[]) =>
    new Set(turns.flatMap((t) => [...(t.event?.imageIds ?? []), ...(t.result?.imageIds ?? [])]));
  const sent = (turns: Turn[]) => new Set(turns.flatMap((t) => (t.event?.takes ?? []).map((k) => k.takeId)));
  const namedBefore = named(kept);
  const namedSince = named(cut);
  const sentBefore = sent(kept);
  const sentSince = sent(cut);
  const wrote = (key: 'plan' | 'report') => (t: Turn) =>
    (t.role === 'tool' && t.name === DOC_WRITER[key] && t.ok !== false) ||
    (t.role === 'note' && t.note?.type === DOC_EDIT[key]);
  const gone = (key: 'plan' | 'report') => cut.some(wrote(key)) && !kept.some(wrote(key));
  return {
    project: {
      ...b.project,
      plan: gone('plan') ? null : b.project.plan,
      report: gone('report') ? null : b.project.report,
      takes: b.project.takes.filter((t) => !sentSince.has(t.takeId) || sentBefore.has(t.takeId)),
    },
    turns: kept,
    images: b.images.filter((i) => !namedSince.has(i.id) || namedBefore.has(i.id)),
  };
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
