/**
 * A twin generation that outlives its panel. Switching tabs must not cancel a run of a minute or more,
 * so the work lives in a module-level map keyed by experiment, and the panels — and the workspace strip,
 * which marks the tab busy — merely subscribe to its progress while mounted (useTwinRun). Every twin runs
 * here: a recording's fixed-camera scene (twinPanel: motion gate, then
 * analyzeTwinScene), a scene program written from a photo set or a walk-around recording
 * (twinBuildingPanel / twinPanel: analyzeTwinBuilding), and the owner's revision of either (twinRevise,
 * §19, §24). One run per experiment at a time, whichever kind — a revision and a build exclude each
 * other — and the owner can stop any of them (stopTwinRun), which leaves the twin as it was.
 */
import { useEffect, useState } from 'react';
import useCommonStore from '../../../stores/common';
import type { TwinEdits, TwinRecord } from '../../../types';
import type { TwinProgressChunk } from '../../../services/ai';
import { readStoredTwin } from '../../../services/experiments';

export interface TwinRun {
  /** The task's own word on where it is — a fixed-camera build's motion gate, run on the client. Shown
   *  until the Function has said something (`live`). */
  progress: string;
  /** What the Function has streamed of the run so far (§28.5): the phase it is in and, while the model
   *  writes, its answer as it comes. Null until the first chunk. Kept when the run ends. */
  live: TwinLive | null;
  error: string | null;
  done: boolean;
  /** Ended by the owner's Stop rather than by finishing or failing: nothing was saved, and there is no
   *  error to show. */
  stopped: boolean;
  /** Stopped by the owner too late: the Function had already begun saving, and the twin it wrote is the
   *  experiment's now (§31.5) — found by reading the stored twin back after the Stop. */
  savedAfterStop: boolean;
  /** The owner pressed Stop and the run has not ended yet — it is reading the stored twin back to see
   *  whether the Function saved regardless (§31.7). The panels say "Stopping…" and grey Stop out. */
  stopping: boolean;
  /** The owner has closed the notice of how the run ended; kept on the run, so it stays closed across a
   *  tab switch and in every panel that shows it (§31.5). */
  dismissed: boolean;
  /** Set when the run revises the model rather than building one (§19): the owner's note and the AI model
   *  it went to (§20) — with the part it was about and how many pictures went with it (§28) — which the
   *  revision thread shows while the run goes and keeps when it fails or is stopped. The build toolbar
   *  reports only the runs without one. */
  revision: TwinRunRevision | null;
}

export interface TwinRunRevision {
  note: string;
  model?: string;
  /** How many pictures went with the note (§28). What it is about is not shown (§28.4). */
  images?: number;
}

/** The Function's progress so far, folded from its chunks (services/ai.ts TwinProgressChunk): the phase —
 *  the pictures being read, the model writing the scene (`modelKey`, sent `photos` pictures), the measured
 *  surfaces being traced (`done` of `total` photos), the record being saved — and what the model has
 *  written (`text`, the raw JSON of its answer) and reasoned (`thought`), which twinLiveProgress shows. */
export interface TwinLive {
  phase: NonNullable<TwinProgressChunk['phase']>;
  modelKey?: string;
  photos?: number;
  done?: number;
  total?: number;
  text: string;
  thought: string;
  /** When the phase began, for the seconds the line counts. */
  phaseAt: number;
}

/** What a task hands the Function's streamed progress to. */
export type TwinFeed = (chunk: TwinProgressChunk) => void;

const runs = new Map<string, TwinRun>();
/** The Stop of each unfinished run. Kept off the run object, which the panels read. */
const controllers = new WeakMap<TwinRun, AbortController>();
/** Everyone watching an experiment's runs — told of a NEW run too, so a panel learns of a run another
 *  component started (the revision thread starting one must disable the toolbar's Regenerate). */
const subscribers = new Map<string, Set<() => void>>();
const notify = (expId: string) => subscribers.get(expId)?.forEach((l) => l());

/** The time of a twin's newest revision round (the server's clock), 0 for none. */
const lastRoundAt = (record: unknown): number => {
  const revisions = (record as { revisions?: unknown } | null)?.revisions;
  const last = Array.isArray(revisions) && revisions.length ? revisions[revisions.length - 1] : null;
  const at = (last as { at?: unknown } | null)?.at;
  return typeof at === 'number' && Number.isFinite(at) ? at : 0;
};

/**
 * What a twin record says, as one string: for a scene program its program, its revisions (how many, and
 * when the newest was made — the history is capped, so a round saved at the cap leaves the count alone,
 * §31.7) and the model that wrote it; otherwise the whole record, its keys sorted (Firestore hands a map
 * back sorted by key, a callable's answer in the order written) — never when it was saved, which the
 * callable's answer and the stored doc stamp differently. '' for none.
 */
function twinContent(record: unknown): string {
  if (!record || typeof record !== 'object') return '';
  const r = record as Record<string, unknown>;
  if (typeof r.code === 'string')
    return JSON.stringify([
      r.code,
      Array.isArray(r.revisions) ? r.revisions.length : 0,
      lastRoundAt(r),
      r.modelKey ?? null,
    ]);
  const { analyzedAt: _at, ...rest } = r;
  return JSON.stringify(rest, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

/** What a panel says of a run stopped too late (savedAfterStop). */
export const SAVED_AFTER_STOP =
  'The twin was already being saved when Stop reached the server, so the new one was kept.';

/** When, after a Stop, the stored twin is read back: the Function's write takes a moment. */
const STOP_CHECKS_MS = [1200, 2500];

/** A note as the thread keeps it, for telling whether a stored round is this run's: the server tidies a
 *  note's line breaks and spaces (readRevisionNote), so they do not count. */
const noteKey = (note: unknown) => (typeof note === 'string' ? note.replace(/\s+/g, ' ').trim() : '');

/**
 * After the owner's Stop: whether the Function saved this run's twin anyway — a Stop that reached it after
 * its last look, as it began saving (§31.5). The stored twin is read back and compared with the stored
 * twin the run started from (`baseline`, read from the server as the run began, §31.7 — this tab's store
 * may be behind it: another tab's build, an earlier save it never read). A build counts as saved when the
 * stored twin is another; a revision only when a round newer than the baseline's newest carries its own
 * note — another tab's round is not this one. A twin that did change is put in the store either way; a
 * Stop that cannot be confirmed as saved ends as stopped, so a revision's note stays in the thread, Not
 * applied, to be sent again.
 */
async function savedDespiteStop(
  expId: string,
  baseline: Promise<{ twinScene: TwinRecord | null } | null>,
  revision: TwinRunRevision | null,
): Promise<boolean> {
  const base = await baseline;
  if (!base) return false;
  const before = twinContent(base.twinScene);
  const baseAt = lastRoundAt(base.twinScene);
  for (const wait of STOP_CHECKS_MS) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      const stored = await readStoredTwin(expId);
      if (!stored.twinScene || twinContent(stored.twinScene) === before) continue;
      storeTwinRecord(expId, stored.twinScene, stored.twinEdits);
      if (!revision) return true;
      const rounds = (stored.twinScene as { revisions?: unknown }).revisions;
      return (
        Array.isArray(rounds) &&
        rounds.some(
          (r) =>
            !!r &&
            typeof (r as { at?: unknown }).at === 'number' &&
            (r as { at: number }).at > baseAt &&
            noteKey((r as { feedback?: unknown }).feedback) === noteKey(revision.note),
        )
      );
    } catch (e) {
      console.warn('twin: the stored twin could not be read back after a stop', e);
      return false;
    }
  }
  return false;
}

/** Start `task` for the experiment unless one is already running. `task` reports progress through
 *  `set`, hands the Function's streamed chunks to `feed`, throws to fail, and must hand `signal` to
 *  whatever it waits on: the owner's Stop aborts it, and the run then ends as stopped, whatever the task
 *  threw on the way out. */
export function startTwinRun(
  expId: string,
  task: (set: (progress: string) => void, signal: AbortSignal, feed: TwinFeed) => Promise<void>,
  revision: TwinRunRevision | null = null,
): TwinRun {
  const existing = runs.get(expId);
  if (existing && !existing.done) return existing;
  const run: TwinRun = {
    progress: 'Starting…',
    live: null,
    error: null,
    done: false,
    stopped: false,
    savedAfterStop: false,
    stopping: false,
    dismissed: false,
    revision,
  };
  const controller = new AbortController();
  controllers.set(run, controller);
  runs.set(expId, run);
  // The stored twin the run starts from, read from the server beside the task (nothing is written before
  // the model has answered), to tell after a Stop whether a new one was saved regardless (§31.7). Null when
  // it cannot be read: a Stop then ends as stopped.
  const baseline: Promise<{ twinScene: TwinRecord | null } | null> = readStoredTwin(expId).catch(() => null);
  notify(expId);
  const set = (progress: string) => {
    // Once stopping, the line keeps saying so until the run has actually ended.
    if (controller.signal.aborted) return;
    run.progress = progress;
    notify(expId);
  };
  // A fresh object per chunk, so what renders from it (twinLiveProgress's memo) sees the change. The
  // Function sends the model's text a few times a second at most, so every chunk is worth a render.
  const feed: TwinFeed = (chunk) => {
    if (controller.signal.aborted) return;
    const now = Date.now();
    const prev = run.live;
    const live: TwinLive = prev ? { ...prev } : { phase: 'photos', text: '', thought: '', phaseAt: now };
    if (chunk.reset) {
      live.text = '';
      live.thought = '';
    }
    if (chunk.phase) {
      if (chunk.phase !== live.phase || !prev) live.phaseAt = now;
      live.phase = chunk.phase;
      if (chunk.modelKey !== undefined) live.modelKey = chunk.modelKey;
      if (chunk.photos !== undefined) live.photos = chunk.photos;
      if (chunk.done !== undefined) live.done = chunk.done;
      if (chunk.total !== undefined) live.total = chunk.total;
    }
    if (chunk.text) live.text += chunk.text;
    if (chunk.thought) live.thought += chunk.thought;
    run.live = live;
    notify(expId);
  };
  task(set, controller.signal, feed)
    .catch(async (e: unknown) => {
      if (controller.signal.aborted) {
        // Nothing came from the Function before the Stop (a fixed-camera build still at its motion gate) —
        // the feed takes no chunk after it, so run.live is still what it was then: nothing can have been saved.
        if (run.live !== null && (await savedDespiteStop(expId, baseline, run.revision))) run.savedAfterStop = true;
        else run.stopped = true;
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
      run.stopping = false;
      controllers.delete(run);
      notify(expId);
    });
  return run;
}

/** Whether the owner's Stop can still stop the run: not once the Function has said it is saving — the
 *  write goes ahead whatever the connection does (§31.5). */
export function twinRunStoppable(run: TwinRun | null | undefined): boolean {
  return !!run && !run.done && !run.stopping && run.live?.phase !== 'saving';
}

/** The title of a Stop button: what it does, or why it is greyed out. */
export function twinStopTitle(run: TwinRun | null | undefined, does: string): string {
  if (run?.stopping) return 'Stopping…';
  return twinRunStoppable(run) || !run ? does : 'Saving — too late to stop';
}

/** The owner's Stop: abort the experiment's unfinished run. The call it is waiting on drops its
 *  connection, the Function sees that and writes nothing, and the run ends as stopped — or, when the
 *  Stop came as it was saving after all, as saved (savedDespiteStop). */
export function stopTwinRun(expId: string): void {
  const run = runs.get(expId);
  const controller = run && !run.done ? controllers.get(run) : undefined;
  if (!run || !controller || controller.signal.aborted || !twinRunStoppable(run)) return;
  run.progress = 'Stopping…';
  run.stopping = true;
  controller.abort();
  notify(expId);
}

/** The owner closed the notice of how the experiment's last run ended: every panel stops showing it, now
 *  and after a tab switch (§31.5). */
export function dismissTwinRun(expId: string): void {
  const run = runs.get(expId);
  if (!run || !run.done || run.dismissed) return;
  run.dismissed = true;
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
  runs.set(expId, {
    progress: '',
    live: null,
    error,
    done: true,
    stopped: false,
    savedAfterStop: false,
    stopping: false,
    dismissed: false,
    revision: null,
  });
  notify(expId);
}

/** Put a finished record in the store — the work of every run that succeeds, done by the run itself so a
 *  panel unmounted meanwhile still finds it. The previous corrections go with the previous scene (their
 *  object ids are gone; a scene program has none) — all but `edits`, the ones a fixed-camera revision says
 *  outlived it (§24). */
export function storeTwinRecord(expId: string, record: TwinRecord, edits: TwinEdits | null = null): void {
  const store = useCommonStore.getState();
  const live = store.experimentMap.get(expId);
  if (live) {
    const { twinEdits: _stale, ...rest } = live;
    store.setExperiment(
      expId,
      edits ? { ...rest, twinScene: record, twinEdits: edits } : { ...rest, twinScene: record },
    );
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
 * exclude each other, so a build waits), the BUILD in progress if that is what it is, and how the last
 * build ended — its error, the owner's stop, or a stop that came as the twin was being saved — until the
 * owner dismisses it (dismissTwinRun: for good, not just in this panel). A revision reports in its own
 * thread (twinRevise), never here; `revising` only says one is going, for a panel that holds its
 * corrections still meanwhile.
 */
export function useTwinBuildRun(expId: string): {
  running: boolean;
  building: TwinRun | null;
  revising: boolean;
  error: string | null;
  stopped: boolean;
  savedAfterStop: boolean;
  dismiss: () => void;
} {
  const run = useTwinRun(expId);
  const running = !!run && !run.done;
  const build = run && !run.revision ? run : null;
  const ended = build && build.done && !build.dismissed ? build : null;
  return {
    running,
    building: build && !build.done ? build : null,
    revising: running && !!run.revision,
    error: ended?.error ?? null,
    stopped: !!ended?.stopped,
    savedAfterStop: !!ended?.savedAfterStop,
    dismiss: () => dismissTwinRun(expId),
  };
}
