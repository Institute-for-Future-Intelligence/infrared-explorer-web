import { doc, onSnapshot } from 'firebase/firestore';
import { firebaseDatabase } from './firebase';

/** Which part of a thumbnail a hero tile shows: the CSS object-position of the cover-fit image, in
 *  percent (0–100 per axis; 50/50 = centred, the default). */
export interface HeroFocus {
  x: number;
  y: number;
}

export interface HomeConfig {
  heroIds: string[];
  /** expId → focus, for thumbnails staff have re-framed in Manage mode. Absent = centred. */
  heroFocus: Record<string, HeroFocus>;
}

// config/homepage = { heroIds: [expId, …], heroFocus: { expId: {x, y} } } — the ordered hero board
// (max 5) plus per-experiment thumbnail framing. Public-readable so any visitor renders the same
// curated board; written only from the staff Curate mode's publish batch (see services/curation.ts)
// under the staff rule.
const HOME_CONFIG = () => doc(firebaseDatabase, 'config/homepage');

const clampPct = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 50);

function parseFocus(raw: unknown): Record<string, HeroFocus> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, HeroFocus> = {};
  for (const [id, f] of Object.entries(raw as Record<string, unknown>)) {
    if (f && typeof f === 'object') {
      const { x, y } = f as { x?: unknown; y?: unknown };
      out[id] = { x: clampPct(x), y: clampPct(y) };
    }
  }
  return out;
}

/** Live-subscribe to the homepage config. Missing doc → empty (the homepage then falls back to its
 *  top-rated algorithm, every thumbnail centred). Returns the unsubscribe fn. */
export function subscribeHomeConfig(onChange: (config: HomeConfig) => void): () => void {
  return onSnapshot(
    HOME_CONFIG(),
    (snap) => {
      const data = snap.exists() ? snap.data() : {};
      const ids = data.heroIds as unknown;
      onChange({
        heroIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
        heroFocus: parseFocus(data.heroFocus),
      });
    },
    (e) => {
      console.error('failed to subscribe to homepage hero config', e);
      onChange({ heroIds: [], heroFocus: {} });
    },
  );
}
