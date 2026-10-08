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

/**
 * When each listed experiment was shot (see utils/captureTime), by id. A copy is answered from its
 * original, which is usually in the same list; one that isn't (trashed, or someone else's) is read from
 * Firestore, so that card's date fills in a moment later.
 */
export function useCaptureTimes(items: (CaptureDoc & { id: string })[]): ReadonlyMap<string, CaptureTime | null> {
  const [fetched, setFetched] = useState<ReadonlyMap<string, CaptureDoc | null>>(new Map());

  const { times, missing } = useMemo(() => {
    const byId = new Map<string, CaptureDoc>(items.map((it) => [it.id, it]));
    const lookup = (id: string) => byId.get(id) ?? fetched.get(id);
    const times = new Map<string, CaptureTime | null>();
    const missing = new Set<string>();
    for (const it of items) {
      const r = resolveCaptureTime(it, lookup);
      times.set(it.id, r.time);
      if (r.missing) missing.add(r.missing);
    }
    return { times, missing: [...missing].sort().join(',') };
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

  return times;
}
