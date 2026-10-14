/** "1 experiment" / "3 experiments" — a count as the bulk toasts and confirm dialogs spell it. */
export const countExperiments = (n: number) => `${n} experiment${n === 1 ? '' : 's'}`;

/**
 * One write per id, all in flight at once. allSettled, not all: one doc the rules refuse must not hide
 * that the rest went through — the caller acts on exactly the ids that landed.
 */
export async function settleEach(ids: string[], write: (id: string) => Promise<void>): Promise<Set<string>> {
  const results = await Promise.allSettled(ids.map(write));
  const done = new Set<string>();
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') done.add(ids[i]);
    else console.error('bulk write failed', ids[i], r.reason);
  });
  return done;
}
