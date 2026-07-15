import { useEffect, useState } from 'react';
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import type { Timestamp } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import { ExperimentDoc, ExperimentSubjects, ExperimentType, User } from '../types';
import type { GridItem } from '../components/card/experimentGrid';

/*
 * Shared owner-scoped experiment fetches, extracted from the section pages so the "Me" hub can
 * render the same lists without duplicating query semantics (the Raw filter in particular is subtle
 * and would drift if copied). Each hook owns its fetch + state and returns the setter too — the
 * section pages' grids mutate the list in place (rename / visibility / trash / restore patches).
 * All follow the codebase convention: equality-only queries (no composite index, legacy-doc
 * tolerant), newest-first client-side sort.
 */

export type ExperimentCard = ExperimentDoc & { id: string };

type ListState = {
  items: ExperimentCard[];
  setItems: React.Dispatch<React.SetStateAction<ExperimentCard[]>>;
  loading: boolean;
};

/** Newest-first by server-set createdAt, tolerant of legacy docs missing it. */
const byCreatedDesc = (a: ExperimentCard, b: ExperimentCard) =>
  (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0);

function useExperimentQuery(user: User | null, fetcher: (user: User) => Promise<ExperimentCard[]>): ListState {
  const [items, setItems] = useState<ExperimentCard[]>([]);
  const [loading, setLoading] = useState(true);

  // Keyed on the user id, not the user object: a same-user update (e.g. a display-name change calls
  // setUser with a fresh object) must not refetch, but an account switch (sign out → sign in in the
  // same tab, which keeps this mounted) must — and must first drop the previous account's rows so
  // they can't flash under the new user.
  const uid = user?.id;
  useEffect(() => {
    if (!user) {
      setItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setItems([]);
    setLoading(true);
    fetcher(user)
      .then((docs) => {
        if (!cancelled) setItems(docs);
      })
      .catch((e) => console.error('failed to load experiments', e))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the account (uid) changes; fetchers are constants and only read user.id
  }, [uid]);

  return { items, setItems, loading };
}

const fetchOwned = async (user: User): Promise<ExperimentCard[]> => {
  const q = query(
    collection(firebaseDatabase, 'experiments'),
    where('ownerId', '==', user.id),
    where('trash', '==', false),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id })).sort(byCreatedDesc);
};

/** All of the user's non-trashed experiments (the My Experiments page + the hub row). */
export const useOwnedExperiments = (user: User | null) => useExperimentQuery(user, fetchOwned);

const fetchRaw = async (user: User): Promise<ExperimentCard[]> => {
  const q = query(
    collection(firebaseDatabase, 'experiments'),
    where('ownerId', '==', user.id),
    where('isRaw', '==', true),
  );
  const snap = await getDocs(q);
  return (
    snap.docs
      .map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id }))
      // Original captures only: drop trashed docs, non-recording sources (e.g. saved copies of
      // video showcases), and any clone/clip (clonedFrom set). "Raw" means an original recording,
      // not merely "untrimmed" — a full-length clone is also isRaw but is a copy.
      .filter((e) => !e.trash && e.sourceType === ExperimentType.Recording && !e.clonedFrom)
      .sort(byCreatedDesc)
  );
};

/** The user's original mobile-app captures (the Raw Data page + the hub row). */
export const useRawExperiments = (user: User | null) => useExperimentQuery(user, fetchRaw);

const fetchTrashed = async (user: User): Promise<ExperimentCard[]> => {
  const q = query(
    collection(firebaseDatabase, 'experiments'),
    where('ownerId', '==', user.id),
    where('trash', '==', true),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id })).sort(byCreatedDesc);
};

/** The user's trashed experiments (the Trash page + the hub row). */
export const useTrashedExperiments = (user: User | null) => useExperimentQuery(user, fetchTrashed);

// History rows carry the view time so the Recent page's recency filter can narrow them client-side.
export interface HistoryItem extends GridItem {
  viewedMs: number;
}

/**
 * The user's viewing history (denormalized snapshots at users/{uid}/history, newest view first).
 * `max` bounds the Firestore read: the Recent page pulls a deep slice (200) so its recency filter
 * has rows to work over; the hub row needs far fewer.
 */
export function useViewHistory(user: User | null, max: number): { items: HistoryItem[]; loading: boolean } {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  const uid = user?.id;
  useEffect(() => {
    if (!user) {
      setItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setItems([]);
    setLoading(true);
    const fetchRecent = async () => {
      const q = query(
        collection(firebaseDatabase, `users/${user.id}/history`),
        orderBy('viewedAt', 'desc'),
        limit(max),
      );
      const snap = await getDocs(q);
      if (cancelled) return;
      setItems(
        snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            thumbnailURL: data.thumbnailURL ?? '',
            displayName: data.displayName ?? '',
            subject: (data.subject as ExperimentSubjects | null) ?? null,
            author: data.author ?? '',
            // Absent on snapshots written before the field existed → author renders unlinked.
            ownerId: (data.ownerId as string | undefined) ?? undefined,
            description: data.description ?? '',
            duration: typeof data.duration === 'number' ? data.duration : undefined,
            createdAt: (data.createdAt as Timestamp | null) ?? null,
            updatedAt: (data.updatedAt as Timestamp | null) ?? null,
            viewedMs: data.viewedAt?.toMillis?.() ?? 0,
          };
        }),
      );
    };
    fetchRecent()
      .catch((e) => console.error('failed to load history', e))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on account (uid) or max change; only user.id is read
  }, [uid, max]);

  return { items, loading };
}
