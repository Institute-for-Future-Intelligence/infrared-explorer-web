import { useCallback, useEffect, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import { toStreetView } from '../utils/streetView';
import type { StreetView } from '../types';

export interface StreetViewsState {
  items: StreetView[];
  loading: boolean;
  error: boolean;
  retry: () => void;
}

/**
 * Load ALL public street views for the map in one shot (~238 legacy docs today),
 * newest-order left to the map/clusterer. Deliberately unpaginated and UNORDERED:
 * the two equality filters (visibility=='public' && trash==false) are served by
 * single-field indexes via a zig-zag merge join, so this needs NO composite index
 * (unlike the Community feed, which adds orderBy createdAt). Public docs are
 * anonymously readable (streetviews rules), so this works signed-out.
 *
 * Lazy like useCommunityExperiments: nothing fetches until `active` is true.
 */
export function useStreetViews(active = true): StreetViewsState {
  const [items, setItems] = useState<StreetView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!active) {
      // Reset here too: if `active` flips false mid-fetch, the cleanup cancels the
      // in-flight resolver (which then bails before clearing loading), so without this
      // the badge would stay stuck on "Loading…" while inactive.
      setLoading(false);
      setError(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const snap = await getDocs(
          query(
            collection(firebaseDatabase, 'streetviews'),
            where('visibility', '==', 'public'),
            where('trash', '==', false),
          ),
        );
        if (cancelled) return;
        const out: StreetView[] = [];
        snap.forEach((d) => {
          const sv = toStreetView(d);
          if (sv) out.push(sv);
        });
        setItems(out);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        console.error('failed to load street views', e);
        setError(true);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { items, loading, error, retry };
}
