import { doc, onSnapshot } from 'firebase/firestore';
import { firebaseDatabase } from './firebase';

// config/homepage = { heroIds: [expId, …] } — the ordered hero board (max 5). Public-readable so any
// visitor renders the same curated order; written only from the staff Curate mode's publish batch
// (see services/curation.ts) under the staff rule.
const HOME_CONFIG = () => doc(firebaseDatabase, 'config/homepage');

/** Live-subscribe to the hero id order. Missing doc → empty (the homepage then falls back to its
 *  top-rated algorithm). Returns the unsubscribe fn. */
export function subscribeHeroIds(onChange: (ids: string[]) => void): () => void {
  return onSnapshot(
    HOME_CONFIG(),
    (snap) => {
      const ids = snap.exists() ? (snap.data().heroIds as unknown) : [];
      onChange(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
    },
    (e) => {
      console.error('failed to subscribe to homepage hero config', e);
      onChange([]);
    },
  );
}
