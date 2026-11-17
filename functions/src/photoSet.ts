/*
 * A photo set's viewing order, as the server reads it.
 *
 * A photo-set experiment (sourceType 'photos') keeps its photos in capture
 * SLOTS and shows them in the owner's order, `photoOrder`. The building twin
 * reads its photos in that order (index.ts), and so does the script that
 * scores it (scripts/evalTwinBuilding.ts).
 *
 * Until 2026-11-17 this file also planned which photos the older report
 * engine sampled and catalogued them for its prompt; that engine is retired
 * (docs/analyzer-ai-app-flow-plan.md §11), and the analyzer's AI reads a photo
 * set in the browser (src/labProjects/cloudTake.ts).
 */

/**
 * A photo set's stored viewing order repaired into a permutation of 0..count-1 — MIRROR of the client's
 * utils/photoOrder.ts normalizePhotoOrder (the two builds share no package). `photoOrder[p]` is the
 * 0-based capture SLOT shown at PLACE p; entries that are not a slot of this set are dropped and every
 * slot the order misses is appended in capture order. Absent → capture order.
 */
export function normalizePhotoOrder(stored: unknown, count: number): number[] {
  const n = Math.max(0, Math.floor(count));
  const taken = new Array<boolean>(n).fill(false);
  const order: number[] = [];
  if (Array.isArray(stored)) {
    for (const v of stored) {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n && !taken[v]) {
        taken[v] = true;
        order.push(v);
      }
    }
  }
  for (let slot = 0; slot < n; slot++) if (!taken[slot]) order.push(slot);
  return order;
}
