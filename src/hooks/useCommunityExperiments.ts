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
  /** Drop a card from the loaded list (e.g. after a staff takedown), without a refetch. */
  removeItem: (id: string) => void;
  /** Flip a loaded card's `featured` flag in place (after staff publish a Showcase change), without a
   *  refetch — the card stays in the feed either way. */
  setFeatured: (id: string, featured: boolean) => void;
}

/**
 * The "Community" pool: every explorer's public (non-trashed) experiments, newest first, paginated.
 * It OVERLAPS the staff-curated Showcase: an explorer's experiment that staff feature stays in the
 * Community feed (being picked for the front page shouldn't make it vanish from the open feed, and the
 * owner should still find it here). What's excluded is the 'system' seed showcases — those aren't
 * community uploads, and all 49 share one seeding timestamp, so they'd land as a single block in a
 * newest-first feed.
 *
 * The query (visibility == 'public' && trash == false, orderBy createdAt desc) is authorized for
 * anyone by the collection's list rules, and served by the existing composite index (the one built
 * for the Recent page: visibility + trash + createdAt) — so this adds no rules and no index. The seed
 * exclusion is client-side (ownerId != 'system' can't join a where-equality + orderBy without a new
 * index); blank thumbnails never resolve, so they're dropped too. Because a whole page can filter to
 * zero, fetchPage keeps pulling pages until a call yields at least one usable card or the source is
 * exhausted, so a call never lands the feed on "empty but there's more" (which would hide the only
 * Load more control).
 *
 * Lazy: nothing is fetched until `active` first becomes true — the /community page passes true; the
 * homepage passes `!filtering` so its "From the community" preview loads while browsing.
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
      // A raw page can filter entirely to zero — its docs may all be 'system' seed showcases (they
      // share one createdAt, so they fill whole pages back to back) or all blank-thumbnailed — while
      // real community cards wait on the next page. `hasMore` tracks the RAW page size, but the button
      // that calls loadMore only renders when items is non-empty, so a fully-filtered first page would
      // dead-end the feed. Keep pulling pages (advancing the cursor) until this call yields at least
      // one usable card or the source is exhausted, so every consumer sees a page that's either
      // non-empty or truly the end.
      let page: ShowcaseCard[] = [];
      let more = true;
      while (more && page.length === 0) {
        const constraints: QueryConstraint[] = [
          where('visibility', '==', 'public'),
          where('trash', '==', false),
          orderBy('createdAt', 'desc'),
        ];
        if (cursorRef.current) constraints.push(startAfter(cursorRef.current));
        constraints.push(limit(PAGE));

        const snap = await getDocs(query(collection(firebaseDatabase, 'experiments'), ...constraints));
        const docs = snap.docs;
        if (docs.length) cursorRef.current = docs[docs.length - 1];
        more = docs.length === PAGE;
        page = docs
          .map((d) => ({ ...(d.data() as ShowcaseCard), id: d.id }))
          .filter((e) => e.ownerId !== 'system' && !!e.thumbnailURL);
      }
      setHasMore(more);
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

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const setFeatured = useCallback((id: string, featured: boolean) => {
    setItems((prev) => prev.map((c) => (c.id === id && !!c.featured !== featured ? { ...c, featured } : c)));
  }, []);

  return { items, loading, loadingMore, error, hasMore, loadMore, retry, removeItem, setFeatured };
}
