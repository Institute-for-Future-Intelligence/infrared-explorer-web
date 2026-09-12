/**
 * A twin generation that outlives its panel. Switching tabs must not cancel a run of a minute or more,
 * so the work lives in a module-level map keyed by experiment, marks the workspace tab busy through the
 * store (the ONE writer of twinRunningExpId), and the panels merely subscribe to its progress while
 * mounted. Every twin runs here: a recording's fixed-camera scene (twinPanel: motion gate, then
 * analyzeTwinScene), a scene program written from a photo set or a walk-around recording
 * (twinBuildingPanel / twinPanel: analyzeTwinBuilding), and the owner's revision of that program
 * (twinRevise, §19). One run per experiment at a time, whichever kind — a revision and a build exclude
 * each other — and the owner can stop any of them (stopTwinRun), which leaves the twin as it was.
 */
import { useEffect, useState } from 'react';
import useCommonStore from '../../../stores/common';
import type { TwinRecord } from '../../../types';

export interface TwinRun {
  progress: string;
  error: string | null;
  done: boolean;
  /** Ended by the owner's Stop rather than by finishing or failing: nothing was saved, and there is no
   *  error to show. */
  stopped: boolean;
  /** Set when the run revises the model rather than building one (§19): the owner's note and the AI model
   *  it went to (§20), which the revision thread shows while the run goes and keeps when it fails or is
   *  stopped. The build toolbar reports only the runs without one. */
  revision: { note: string; model?: string } | null;
}

const runs = new Map<string, TwinRun>();
/** The Stop of each unfinished run. Kept off the run object, which the panels read. */
const controllers = new WeakMap<TwinRun, AbortController>();
/** Everyone watching an experiment's runs — told of a NEW run too, so a panel learns of a run another
 *  component started (the revision thread starting one must disable the toolbar's Regenerate). */
const subscribers = new Map<string, Set<() => void>>();
const notify = (expId: string) => subscribers.get(expId)?.forEach((l) => l());

/** Start `task` for the experiment unless one is already running. `task` reports progress through
 *  `set`, throws to fail, and must hand `signal` to whatever it waits on: the owner's Stop aborts it,
 *  and the run then ends as stopped, whatever the task threw on the way out. */
export function startTwinRun(
  expId: string,
  task: (set: (progress: string) => void, signal: AbortSignal) => Promise<void>,
  revision: { note: string; model?: string } | null = null,
): TwinRun {
  const existing = runs.get(expId);
  if (existing && !existing.done) return existing;
  const run: TwinRun = { progress: 'Starting…', error: null, done: false, stopped: false, revision };
  const controller = new AbortController();
  controllers.set(run, controller);
  runs.set(expId, run);
  useCommonStore.getState().setTwinRunningExpId(expId);
  notify(expId);
  const set = (progress: string) => {
    // Once stopping, the line keeps saying so until the run has actually ended.
    if (controller.signal.aborted) return;
    run.progress = progress;
    notify(expId);
  };
  task(set, controller.signal)
    .catch((e: unknown) => {
      if (controller.signal.aborted) {
        run.stopped = true;
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      // A bare "internal" is the callable SDK's word for "the request never got an answer" — the
      // function is missing (an emulator running an older build) or unreachable — not a server verdict.
      run.error =
        msg === 'internal' || /^internal$/i.test(msg.trim())
          ? 'The analysis service could not be reached. If this is a local build against the Functions emulator, wait for the emulator to finish starting (it rebuilds the functions first, about a minute after `yarn start`) or restart it so it picks up the twin functions (analyzeTwinScene, analyzeTwinBuilding); otherwise check the network and try again.'
          : msg;
    })
    .finally(() => {
      run.done = true;
      controllers.delete(run);
      const store = useCommonStore.getState();
      if (store.twinRunningExpId === expId) store.setTwinRunningExpId(null);
      notify(expId);
    });
  return run;
}

/** The owner's Stop: abort the experiment's unfinished run. The call it is waiting on drops its
 *  connection, the Function sees that and writes nothing, and the run ends as stopped. */
export function stopTwinRun(expId: string): void {
  const run = runs.get(expId);
  const controller = run && !run.done ? controllers.get(run) : undefined;
  if (!run || !controller || controller.signal.aborted) return;
  run.progress = 'Stopping…';
  controller.abort();
  notify(expId);
}

/** Record a failure that happened outside a run (a clear that failed) so the panel shows it the same way.
 *  A live run is never displaced: evicting it from the map would let a second generation start beside it
 *  (startTwinRun only refuses while the registered run is unfinished), so a clear that failed while a run
 *  is in flight is only logged — the run's own outcome is what the panel should be showing. */
export function failTwinRun(expId: string, error: string): void {
  const live = runs.get(expId);
  if (live && !live.done) {
    console.warn('twin: a clear failed while a generation is running; keeping the run', error);
    return;
  }
  runs.set(expId, { progress: '', error, done: true, stopped: false, revision: null });
  notify(expId);
}

/** Put a finished record in the store — the work of every run that succeeds, done by the run itself so a
 *  panel unmounted meanwhile still finds it. The previous corrections go with the previous scene (their
 *  object ids are gone; a scene program has none). */
export function storeTwinRecord(expId: string, record: TwinRecord): void {
  const store = useCommonStore.getState();
  const live = store.experimentMap.get(expId);
  if (live) {
    const { twinEdits: _stale, ...rest } = live;
    store.setExperiment(expId, { ...rest, twinScene: record });
  }
}

/** Subscribe to the experiment's runs: the latest one (running or finished), or null. */
export function useTwinRun(expId: string): TwinRun | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    let set = subscribers.get(expId);
    if (!set) subscribers.set(expId, (set = new Set()));
    set.add(l);
    return () => {
      set.delete(l);
      if (!set.size) subscribers.delete(expId);
    };
  }, [expId]);
  return runs.get(expId) ?? null;
}

/**
 * What a build toolbar shows of the experiment's runs: whether any is going (a revision too — they
 * exclude each other, so Regenerate waits), the BUILD in progress if that is what it is, and how the
 * last build ended — its error, or the owner's stop — until the owner dismisses it. A revision reports
 * in its own thread (twinRevise), never here.
 */
export function useTwinBuildRun(expId: string): {
  running: boolean;
  building: TwinRun | null;
  error: string | null;
  stopped: boolean;
  dismiss: () => void;
} {
  const run = useTwinRun(expId);
  const [dismissed, setDismissed] = useState<TwinRun | null>(null);
  const running = !!run && !run.done;
  const build = run && !run.revision ? run : null;
  const ended = build && build.done && build !== dismissed ? build : null;
  return {
    running,
    building: build && !build.done ? build : null,
    error: ended?.error ?? null,
    stopped: !!ended?.stopped,
    dismiss: () => setDismissed(run),
  };
}
