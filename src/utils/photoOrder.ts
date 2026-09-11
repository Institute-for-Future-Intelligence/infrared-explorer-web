/**
 * A photo set's viewing order (docs/photo-set-experiments.md, "Reordering the photos").
 *
 * The photos never move: photo k stays data_k.* in Storage, index k-1 in every per-photo array on the
 * doc, and frame k-1 to the player. The owner's order is a separate permutation on the doc —
 * `photoOrder[p]` is the 0-based capture SLOT shown at PLACE p — so a reorder rewrites one small array
 * and nothing that points at a photo (annotation windows, the twin's photo numbers, the frame caches)
 * has to follow it. Places are what the reader sees: the strip's order, "Photo k of N", stepping.
 */

/**
 * The stored order, repaired into a permutation of 0..count-1: entries that are not a slot of this set
 * (out of range, non-integer, repeated) are dropped and every slot the order misses is appended in
 * capture order. Absent → capture order. So a doc written against another photoCount, or by hand,
 * still shows every photo exactly once.
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

/** The inverse of an order: `places[slot]` is where capture slot `slot` is shown. */
export function photoPlaces(order: readonly number[]): number[] {
  const places = new Array<number>(order.length);
  order.forEach((slot, place) => {
    places[slot] = place;
  });
  return places;
}

/** Whether the order is plain capture order (so places and slots are the same numbers). */
export function isCaptureOrder(order: readonly number[]): boolean {
  return order.every((slot, place) => slot === place);
}

/** A note's photo window, inclusive, in 1-based photo numbers (Annotation.time on a photo set). */
export interface PhotoWindow {
  start: number;
  end: number;
}

// Renumber a window's two ends through `renumber` (1-based → 1-based). A window over the whole set, or
// over none of it, means the same in either numbering and comes back as is — as does every window of a
// set still in capture order, so nothing is rewritten until the owner actually reorders.
function renumberWindow(win: PhotoWindow, order: readonly number[], renumber: (k: number) => number): PhotoWindow {
  const n = order.length;
  if (n === 0 || isCaptureOrder(order)) return win;
  const first = Math.max(1, Math.ceil(win.start));
  const last = Math.min(n, Math.floor(win.end));
  if (first > last || (first === 1 && last === n)) return win;
  const a = renumber(first);
  const b = renumber(last);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/**
 * A note window as stored (capture numbers — so the note stays on its photo whatever the order) to the
 * numbers the reader sees on the strip. Exact for one photo, for the whole set and for any set in
 * capture order; a run of photos the reorder has scattered cannot be one window of places, and shows as
 * the places of its two ends — so an editor should keep the stored window when those numbers come back
 * unchanged rather than convert them back.
 */
export function windowToPlaces(win: PhotoWindow, order: readonly number[]): PhotoWindow {
  const places = photoPlaces(order);
  return renumberWindow(win, order, (k) => places[k - 1] + 1);
}

/** The inverse of windowToPlaces: a window typed in the strip's photo numbers, as stored. */
export function windowFromPlaces(win: PhotoWindow, order: readonly number[]): PhotoWindow {
  return renumberWindow(win, order, (k) => order[k - 1] + 1);
}

// A set's cover is photo 1's render (the capture app writes thumbnailURL as data_1.png — as a Storage
// download URL; migrated and older docs hold the bare object path). Either spelling ends in the file
// name, which the download URL does not escape.
const COVER_FILE = /data_(\d+)\.png(?=$|[?#])/;

/**
 * The cover a reorder should give the set: while its thumbnail is still the old first photo's render,
 * the new first photo's, spelled the same way; undefined when there is nothing to change — the first
 * photo stayed, or the cover is something else (a clone's, a custom one).
 */
export function coverAfterReorder(
  thumbnailURL: string | undefined,
  recordingId: string,
  oldFirstSlot: number,
  newFirstSlot: number,
): string | undefined {
  if (!thumbnailURL || !recordingId || oldFirstSlot === newFirstSlot) return undefined;
  let path = thumbnailURL;
  if (/^https?:\/\//.test(thumbnailURL)) {
    const encoded = /\/o\/([^?#]+)/.exec(thumbnailURL)?.[1];
    if (!encoded) return undefined;
    try {
      path = decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
  }
  if (path !== `recordings/${recordingId}/data_${oldFirstSlot + 1}.png`) return undefined;
  return thumbnailURL.replace(COVER_FILE, `data_${newFirstSlot + 1}.png`);
}
