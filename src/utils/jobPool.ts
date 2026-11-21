/**
 * A few workers doing one kind of job, and the page doing it itself where they cannot — the bookkeeping
 * only (who is busy, what is waiting, what to do when a worker fails), with the workers behind a small
 * interface so that this runs under Node's test runner. utils/blendedFrame.ts is its one user.
 *
 * The rules:
 *
 *  - One job a worker at a time; the rest wait here, and THE NEWEST GOES FIRST. The jobs are frames a
 *    player asks for as its playhead moves: when more are asked for than can be made, the ones asked for
 *    last are the ones still ahead of the playhead. Oldest-first would spend the workers on frames that
 *    have gone by, and never catch up.
 *  - Nothing asked for is dropped: every job settles, late or not (the caller caches what it gets).
 *  - A worker that fails a job the page can do is taken as a browser whose workers cannot do this (no 2D
 *    canvas off the page, say): the pool is closed and everything, from then on, is done on the page. A
 *    job the page cannot do either is that job's own failure, and the workers stay.
 *  - A worker that cannot start, or dies, closes the pool the same way.
 */

/** A reply from a worker: the job's result, or why there is none. */
export interface JobReply<R> {
  id: number;
  result?: R;
  error?: string;
}

/** One worker, as the pool drives it. */
export interface PoolWorker<J, R> {
  post(id: number, job: J): void;
  /** Set by the pool. */
  onReply: ((reply: JobReply<R>) => void) | null;
  /** Set by the pool: the worker failed as a whole (its script would not load, it threw outside a job). */
  onCrash: (() => void) | null;
  terminate(): void;
}

export interface JobPoolOptions<J, R> {
  /** The most workers started (each as the first job that needs it comes). */
  size: number;
  /** Start a worker; null (or a throw) where the browser has none to give. */
  spawn: () => PoolWorker<J, R> | null;
  /** The same job done right here, on the caller's thread. */
  runHere: (job: J) => Promise<R>;
}

export interface JobPool<J, R> {
  run(job: J): Promise<R>;
  /** False once the pool has closed and every job runs on the caller's thread. */
  readonly usingWorkers: boolean;
}

interface Waiting<J, R> {
  id: number;
  job: J;
  resolve: (r: R) => void;
  reject: (e: unknown) => void;
}

export function createJobPool<J, R>(opts: JobPoolOptions<J, R>): JobPool<J, R> {
  let open = opts.size > 0;
  // Cleared once the browser has refused a worker: the ones running carry on, no more are asked for.
  let canGrow = true;
  let nextId = 1;
  const workers: { worker: PoolWorker<J, R>; doing: Waiting<J, R> | null }[] = [];
  // Waiting for a worker, oldest first (the newest is taken from the end).
  const waiting: Waiting<J, R>[] = [];

  const here = (w: Waiting<J, R>): void => {
    opts.runHere(w.job).then(w.resolve, w.reject);
  };

  /** No more workers: what they were doing and what was waiting for them is done here. */
  const close = (): void => {
    if (!open) return;
    open = false;
    const owed: Waiting<J, R>[] = [];
    for (const slot of workers) {
      if (slot.doing) owed.push(slot.doing);
      slot.doing = null;
      slot.worker.onReply = null;
      slot.worker.onCrash = null;
      try {
        slot.worker.terminate();
      } catch {
        // Gone already.
      }
    }
    workers.length = 0;
    owed.push(...waiting.splice(0));
    owed.forEach(here);
  };

  const start = (): boolean => {
    let worker: PoolWorker<J, R> | null = null;
    try {
      worker = opts.spawn();
    } catch {
      worker = null;
    }
    if (!worker) return false;
    const slot = { worker, doing: null as Waiting<J, R> | null };
    worker.onReply = (reply) => {
      const w = slot.doing;
      if (!w || w.id !== reply.id) return;
      slot.doing = null;
      if (reply.error === undefined) {
        w.resolve(reply.result as R);
        pump();
        return;
      }
      pump();
      // Its own failure, or the worker's? The page tries, and its answer says which.
      opts.runHere(w.job).then(
        (r) => {
          close();
          w.resolve(r);
        },
        (e) => w.reject(e),
      );
    };
    worker.onCrash = close;
    workers.push(slot);
    return true;
  };

  const pump = (): void => {
    while (open && waiting.length > 0) {
      let slot = workers.find((s) => !s.doing);
      if (!slot && canGrow && workers.length < opts.size) {
        if (start()) {
          slot = workers[workers.length - 1];
        } else {
          canGrow = false;
          // (With none running there is no pool.)
          if (workers.length === 0) return close();
        }
      }
      if (!slot) return;
      const w = waiting.pop() as Waiting<J, R>;
      slot.doing = w;
      try {
        slot.worker.post(w.id, w.job);
      } catch {
        // The job could not be handed over (it holds something that cannot cross): the worker is fine.
        slot.doing = null;
        here(w);
      }
    }
  };

  return {
    run: (job) =>
      new Promise<R>((resolve, reject) => {
        const w = { id: nextId++, job, resolve, reject };
        if (!open) return here(w);
        waiting.push(w);
        pump();
      }),
    get usingWorkers() {
      return open;
    },
  };
}
