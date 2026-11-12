import { useEffect, useMemo, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import type { ExperimentDoc } from '../types';
import { CaptureDoc, CaptureTime, resolveCaptureTime } from '../utils/captureTime';

// Copy sources read this session (null = deleted, or private to this viewer), shared by every list so a
// source is fetched once however often the lists remount. A capture time never changes, so no expiry.
const sourceReads = new Map<string, Promise<CaptureDoc | null>>();

const readSource = (id: string): Promise<CaptureDoc | null> => {
  let read = sourceReads.get(id);
  if (!read) {
    read = getDoc(doc(firebaseDatabase, `experiments/${id}`))
      .then((snap) => (snap.exists() ? (snap.data() as ExperimentDoc) : null))
      .catch(() => null);
    sourceReads.set(id, read);
  }
  return read;
};

// The answers for a list, and which of them still wait on a copy's source being read (`pending`).
function useResolved(items: (CaptureDoc & { id: string })[]) {
  const [fetched, setFetched] = useState<ReadonlyMap<string, CaptureDoc | null>>(new Map());

  const { times, pending, missing } = useMemo(() => {
    const byId = new Map<string, CaptureDoc>(items.map((it) => [it.id, it]));
    const lookup = (id: string) => byId.get(id) ?? fetched.get(id);
    const times = new Map<string, CaptureTime | null>();
    const pending = new Set<string>();
    const missing = new Set<string>();
    for (const it of items) {
      const r = resolveCaptureTime(it, lookup);
      times.set(it.id, r.time);
      if (r.missing) {
        missing.add(r.missing);
        pending.add(it.id);
      }
    }
    return { times, pending, missing: [...missing].sort().join(',') };
  }, [items, fetched]);

  useEffect(() => {
    if (!missing) return;
    let cancelled = false;
    const ids = missing.split(',');
    Promise.all(ids.map((id) => readSource(id))).then((docs) => {
      if (cancelled) return;
      setFetched((prev) => {
        const next = new Map(prev);
        ids.forEach((id, i) => next.set(id, docs[i]));
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [missing]);

  return { times, pending };
}

/**
 * When each listed experiment was shot (see utils/captureTime), by id. A copy is answered from its
 * original, which is usually in the same list; one that isn't (trashed, or someone else's) is read from
 * Firestore, so that card's date fills in a moment later.
 */
export function useCaptureTimes(items: (CaptureDoc & { id: string })[]): ReadonlyMap<string, CaptureTime | null> {
  return useResolved(items).times;
}

/**
 * When one experiment was shot — the analyzer's Info tab, which dates a recording as its card does.
 * undefined while a copy's source is still being read (so the page does not name one date and then
 * another), null when the document has nothing to go on.
 */
export function useCaptureTime(item: (CaptureDoc & { id: string }) | undefined): CaptureTime | null | undefined {
  const items = useMemo(() => (item ? [item] : []), [item]);
  const { times, pending } = useResolved(items);
  if (!item || pending.has(item.id)) return undefined;
  return times.get(item.id) ?? null;
}
