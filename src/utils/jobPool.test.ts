import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JobReply, PoolWorker, createJobPool } from './jobPool';

/** A worker the test answers for: what it was handed, and the means to reply or to die. */
interface FakeWorker extends PoolWorker<string, string> {
  got: { id: number; job: string }[];
  terminated: boolean;
  reply(r: Omit<JobReply<string>, 'id'>): void;
}

function fakeWorker(): FakeWorker {
  const w: FakeWorker = {
    got: [],
    terminated: false,
    onReply: null,
    onCrash: null,
    post: (id, job) => {
      w.got.push({ id, job });
    },
    terminate: () => {
      w.terminated = true;
    },
    /** Answers the job it was handed last. */
    reply: (r) => {
      const last = w.got[w.got.length - 1];
      w.onReply?.({ id: last.id, ...r });
    },
  };
  return w;
}

/** A pool over fake workers; `here` records what the page was asked to do itself. */
function setup(
  size: number,
  opts: { spawn?: () => FakeWorker | null; runHere?: (job: string) => Promise<string> } = {},
) {
  const workers: FakeWorker[] = [];
  const here: string[] = [];
  const pool = createJobPool<string, string>({
    size,
    spawn:
      opts.spawn ??
      (() => {
        const w = fakeWorker();
        workers.push(w);
        return w;
      }),
    runHere:
      opts.runHere ??
      (async (job) => {
        here.push(job);
        return `page:${job}`;
      }),
  });
  return { pool, workers, here };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

describe('createJobPool', () => {
  it('hands a job to a worker and resolves with its reply', async () => {
    const { pool, workers, here } = setup(2);
    const p = pool.run('a');
    assert.equal(workers.length, 1);
    assert.deepEqual(
      workers[0].got.map((g) => g.job),
      ['a'],
    );
    workers[0].reply({ result: 'A' });
    assert.equal(await p, 'A');
    assert.deepEqual(here, []);
    assert.equal(pool.usingWorkers, true);
  });

  it('starts workers as jobs wait, up to its size, and gives each one job at a time', async () => {
    const { pool, workers } = setup(2);
    const all = ['a', 'b', 'c', 'd'].map((j) => pool.run(j));
    assert.equal(workers.length, 2);
    assert.deepEqual(
      workers.map((w) => w.got.map((g) => g.job)),
      [['a'], ['b']],
    );
    workers[0].reply({ result: 'A' });
    workers[1].reply({ result: 'B' });
    // Of the two that waited, the newer went first.
    assert.deepEqual(
      workers.map((w) => w.got.map((g) => g.job)),
      [
        ['a', 'd'],
        ['b', 'c'],
      ],
    );
    workers[0].reply({ result: 'D' });
    workers[1].reply({ result: 'C' });
    assert.deepEqual(await Promise.all(all), ['A', 'B', 'C', 'D']);
  });

  it('takes the newest of what is waiting first, and still does all of it', async () => {
    const { pool, workers } = setup(1);
    const done: string[] = [];
    const all = ['f1', 'f2', 'f3', 'f4'].map((j) => pool.run(j).then((r) => done.push(r)));
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const job = workers[0].got[workers[0].got.length - 1].job;
      order.push(job);
      workers[0].reply({ result: job });
      await settled();
    }
    assert.deepEqual(order, ['f1', 'f4', 'f3', 'f2']);
    await Promise.all(all);
    assert.equal(done.length, 4);
  });

  it('a job the worker fails and the page can do closes the pool: the page does everything from then on', async () => {
    const { pool, workers, here } = setup(2);
    const a = pool.run('a');
    const b = pool.run('b');
    const c = pool.run('c');
    workers[0].reply({ error: 'no canvas here' });
    assert.equal(await a, 'page:a');
    assert.equal(pool.usingWorkers, false);
    assert.ok(workers.every((w) => w.terminated));
    // What the other worker was doing, and what was waiting, are done on the page too.
    assert.equal(await b, 'page:b');
    assert.equal(await c, 'page:c');
    assert.equal(await pool.run('d'), 'page:d');
    assert.deepEqual([...here].sort(), ['a', 'b', 'c', 'd']);
    // A reply that comes in after all is nobody's.
    workers[1].onReply?.({ id: 2, result: 'late' });
  });

  it('a job neither can do is that job’s failure, and the workers stay', async () => {
    const { pool, workers } = setup(1, {
      runHere: async (job) => {
        throw new Error(`cannot decode ${job}`);
      },
    });
    const a = pool.run('bad');
    workers[0].reply({ error: 'cannot decode' });
    await assert.rejects(a, /cannot decode bad/);
    assert.equal(pool.usingWorkers, true);
    const b = pool.run('good');
    workers[0].reply({ result: 'G' });
    assert.equal(await b, 'G');
  });

  it('a worker that dies closes the pool, and what it owed is done on the page', async () => {
    const { pool, workers, here } = setup(2);
    const a = pool.run('a');
    const b = pool.run('b');
    workers[1].onCrash?.();
    assert.deepEqual(await Promise.all([a, b]), ['page:a', 'page:b']);
    assert.equal(pool.usingWorkers, false);
    assert.deepEqual([...here].sort(), ['a', 'b']);
  });

  it('with no worker to be had, the page does the job', async () => {
    for (const spawn of [
      () => null,
      () => {
        throw new Error('blocked');
      },
    ]) {
      const { pool, here } = setup(2, { spawn });
      assert.equal(await pool.run('a'), 'page:a');
      assert.equal(await pool.run('b'), 'page:b');
      assert.equal(pool.usingWorkers, false);
      assert.deepEqual(here, ['a', 'b']);
    }
  });

  it('carries on with the workers it has when the browser refuses another', async () => {
    const workers: FakeWorker[] = [];
    let asked = 0;
    const { pool, here } = setup(3, {
      spawn: () => {
        asked += 1;
        if (asked > 1) return null;
        const w = fakeWorker();
        workers.push(w);
        return w;
      },
    });
    const a = pool.run('a');
    const b = pool.run('b');
    const c = pool.run('c');
    assert.equal(workers.length, 1);
    workers[0].reply({ result: 'A' });
    workers[0].reply({ result: 'C' });
    workers[0].reply({ result: 'B' });
    assert.deepEqual(await Promise.all([a, b, c]), ['A', 'B', 'C']);
    // Asked once more, refused, and not asked again.
    assert.equal(asked, 2);
    assert.equal(pool.usingWorkers, true);
    assert.deepEqual(here, []);
  });

  it('a job that cannot be handed over is done on the page, and the worker kept', async () => {
    const w = fakeWorker();
    const post = w.post;
    w.post = (id, job) => {
      if (job === 'uncloneable') throw new Error('DataCloneError');
      post(id, job);
    };
    const { pool, here } = setup(1, { spawn: () => w });
    assert.equal(await pool.run('uncloneable'), 'page:uncloneable');
    assert.equal(pool.usingWorkers, true);
    const ok = pool.run('fine');
    w.reply({ result: 'F' });
    assert.equal(await ok, 'F');
    assert.deepEqual(here, ['uncloneable']);
  });

  it('a pool of no size is the page', async () => {
    const { pool, workers, here } = setup(0);
    assert.equal(await pool.run('a'), 'page:a');
    assert.equal(workers.length, 0);
    assert.deepEqual(here, ['a']);
  });
});
