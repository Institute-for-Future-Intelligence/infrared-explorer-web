/*
 * The experiments a recording belongs to, for the recording's own page (the
 * analyzer's Info tab links them): asked of the app's server
 * (api.projectsOfRecording), since the `labProjects` collection has no client
 * rules. The answer depends on who asks — one's own experiments whatever
 * their sharing, anyone's public ones — so it is kept per viewer and
 * recording: a page that comes back to the Info tab shows what it showed, and
 * asks again only once that is a minute old. A failure (signed out of reach,
 * a server from before the callable) reads as none.
 *
 * This is the one thing the analyzer takes from a project: its title and its
 * link. The analyzer's own AI (Ask AI, AI Report) stays the recording's.
 */

import { useEffect, useState } from 'react';
import { projectsOfRecording, type RecordingProject } from './api';

const FRESH_MS = 60_000;
const NONE: RecordingProject[] = [];

const answers = new Map<string, { at: number; projects: RecordingProject[] }>();
const asking = new Map<string, Promise<RecordingProject[]>>();

function ask(key: string, expId: string): Promise<RecordingProject[]> {
  let p = asking.get(key);
  if (!p) {
    p = projectsOfRecording(expId)
      .catch(() => NONE)
      .then((projects) => {
        answers.set(key, { at: Date.now(), projects });
        asking.delete(key);
        return projects;
      });
    asking.set(key, p);
  }
  return p;
}

/**
 * `expId` undefined asks nothing (a recording that cannot be a capture).
 * `viewerId` is whoever is signed in (null: nobody), so that signing in asks again.
 */
export function useRecordingProjects(expId: string | undefined, viewerId: string | null): RecordingProject[] {
  const key = expId ? `${viewerId ?? ''}|${expId}` : null;
  const [shown, setShown] = useState<{ key: string; projects: RecordingProject[] } | null>(null);

  useEffect(() => {
    if (!key || !expId) return;
    const held = answers.get(key);
    if (held && Date.now() - held.at < FRESH_MS) return;
    let cancelled = false;
    ask(key, expId).then((projects) => {
      if (!cancelled) setShown({ key, projects });
    });
    return () => {
      cancelled = true;
    };
  }, [key, expId]);

  if (!key) return NONE;
  return shown?.key === key ? shown.projects : (answers.get(key)?.projects ?? NONE);
}
