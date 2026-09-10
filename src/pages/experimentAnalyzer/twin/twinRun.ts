/**
 * A twin generation that outlives its panel. Switching tabs must not cancel a run of a minute or more,
 * so the work lives in a module-level map keyed by experiment, marks the workspace tab busy through the
 * store, and the panel merely subscribes to its progress while mounted (the recording twin's panel
 * keeps an equivalent of its own; this one serves the building twin).
 */
import { useEffect, useState } from 'react';
import useCommonStore from '../../../stores/common';

export interface TwinRun {
  progress: string;
  error: string | null;
  done: boolean;
  listeners: Set<() => void>;
}

const runs = new Map<string, TwinRun>();
const notify = (run: TwinRun) => run.listeners.forEach((l) => l());

/** Start `task` for the experiment unless one is already running. `task` reports progress through
 *  `set` and throws to fail; the error message lands in the run for the panel to show. */
export function startTwinRun(expId: string, task: (set: (progress: string) => void) => Promise<void>): TwinRun {
  const existing = runs.get(expId);
  if (existing && !existing.done) return existing;
  const run: TwinRun = { progress: 'Starting…', error: null, done: false, listeners: new Set() };
  runs.set(expId, run);
  useCommonStore.getState().setTwinRunningExpId(expId);
  const set = (progress: string) => {
    run.progress = progress;
    notify(run);
  };
  task(set)
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      // A bare "internal" is the callable SDK's word for "the request never got an answer" — the
      // function is missing (an emulator running an older build) or unreachable — not a server verdict.
      run.error =
        msg === 'internal' || /^internal$/i.test(msg.trim())
          ? 'The analysis service could not be reached. If this is a local build against the Functions emulator, wait for the emulator to finish starting (it rebuilds the functions first, about a minute after `yarn start`) or restart it so it picks up the twin functions; otherwise check the network and try again.'
          : msg;
    })
    .finally(() => {
      run.done = true;
      const store = useCommonStore.getState();
      if (store.twinRunningExpId === expId) store.setTwinRunningExpId(null);
      notify(run);
    });
  return run;
}

/** Record a failure that happened outside a run (a clear that failed) so the panel shows it the same way. */
export function failTwinRun(expId: string, error: string): void {
  runs.set(expId, { progress: '', error, done: true, listeners: new Set() });
}

/** Subscribe to the live run for this experiment (if any). */
export function useTwinRun(expId: string): TwinRun | null {
  const [, force] = useState(0);
  const run = runs.get(expId) ?? null;
  useEffect(() => {
    const r = runs.get(expId);
    if (!r) return;
    const l = () => force((n) => n + 1);
    r.listeners.add(l);
    return () => {
      r.listeners.delete(l);
    };
    // Re-subscribe whenever a new run object appears for this experiment.
  }, [expId, run]);
  return run;
}
