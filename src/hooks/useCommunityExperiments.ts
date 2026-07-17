import { useCallback, useEffect, useRef, useState } from 'react';
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  type DocumentData,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import type { ShowcaseCard } from '../utils/homeLayout';

const PAGE = 24;

export interface CommunityState {
  items: ShowcaseCard[];
  loading: boolean; // first page in flight
  loadingMore: boolean;
  error: boolean;
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

/**
 * The "Community" pool: every explorer's public (non-trashed) experiments, newest first, paginated —
 * distinct from the staff-curated Showcase.
 *
 * The query (visibility == 'public' && trash == false, orderBy createdAt desc) is authorized for
 * anyone by the collection's list rules, and served by the existing composite index (the one built
 * for the Recent page: visibility + trash + createdAt) — so this adds no rules and no index. Featured
 * experiments are public too and would show here; they're filtered out client-side (they already have
 * their own stage above, and many are 'system' seeds rather than genuine community uploads). Blank
 * thumbnails never resolve, so they're dropped too. `hasMore` is derived from the RAW page size
 * (before those client filters), so pagination stays correct even when a page renders fewer cards.
 *
 * Lazy: nothing is fetched until `active` first becomes true (i.e. the viewer opens the tab).
 */
export function useCommunityExperiments(active: boolean): CommunityState {
  const [items, setItems] = useState<ShowcaseCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const cursorRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);
  const startedRef = useRef(false);
  const inFlightRef = useRef(false);

  const fetchPage = useCallback(async (initial: boolean) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (initial) {
      setLoading(true);
      setError(false);
    } else {
      setLoadingMore(true);
    }
    try {
      const constraints: QueryConstraint[] = [
        where('visibility', '==', 'public'),
        where('trash', '==', false),
        orderBy('createdAt', 'desc'),
      ];
      if (!initial && cursorRef.current) constraints.push(startAfter(cursorRef.current));
      constraints.push(limit(PAGE));

      const snap = await getDocs(query(collection(firebaseDatabase, 'experiments'), ...constraints));
      const docs = snap.docs;
      if (docs.length) cursorRef.current = docs[docs.length - 1];
      setHasMore(docs.length === PAGE);

      const page = docs
        .map((d) => ({ ...(d.data() as ShowcaseCard), id: d.id }))
        .filter((e) => !e.featured && !!e.thumbnailURL);
      setItems((prev) => {
        if (initial) return page;
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...page.filter((p) => !seen.has(p.id))];
      });
    } catch (e) {
      console.error('failed to load community experiments', e);
      setError(true);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (active && !startedRef.current) {
      startedRef.current = true;
      fetchPage(true);
    }
  }, [active, fetchPage]);

  const loadMore = useCallback(() => {
    if (!inFlightRef.current && hasMore) fetchPage(false);
  }, [fetchPage, hasMore]);

  const retry = useCallback(() => {
    cursorRef.current = null;
    setItems([]);
    setHasMore(true);
    startedRef.current = true;
    fetchPage(true);
  }, [fetchPage]);

  return { items, loading, loadingMore, error, hasMore, loadMore, retry };
}
