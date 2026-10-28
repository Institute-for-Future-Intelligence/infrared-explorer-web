import { ExperimentDoc } from '../types';

export type ShowcaseCard = ExperimentDoc & { id: string };

export interface HomeLayout {
  /** 1 big + up to 4 small featured cards; empty for a tiny pool. */
  hero: ShowcaseCard[];
}

const HERO_SIZE = 5;
const HERO_MIN = 5; // below this, no hero (just the grid)
const PRIOR = 3; // Bayesian prior vote count

/** Bayesian-weighted average rating: pulls a 1-vote 5★ toward the global mean so a well-reviewed
 *  4.6 (many votes) outranks it. */
const weighted = (c: ShowcaseCard, mean: number) =>
  ((c.ratingSum ?? 0) + mean * PRIOR) / ((c.ratingCount ?? 0) + PRIOR);

/**
 * Pick the homepage hero board from the (already-curated, featured) pool: staff-pinned ids first,
 * padded with the top-rated rest. An in-memory slice — zero extra queries. The bottom
 * "Explore the collection" grid still shows the full pool.
 */
export function buildHomeLayout(pool: ShowcaseCard[], heroIds: string[] = []): HomeLayout {
  if (pool.length < HERO_MIN) return { hero: [] };

  const rated = pool.filter((c) => (c.ratingCount ?? 0) > 0);
  const mean = rated.length
    ? rated.reduce((s, c) => s + (c.ratingSum ?? 0) / (c.ratingCount ?? 1), 0) / rated.length
    : 0;

  // Hero = staff-pinned ids first (resolved against the pool, dropping any that no longer qualify),
  // padded up to HERO_SIZE with the top-weighted rest. Empty pins → pure algorithm (the default).
  const byId = new Map(pool.map((c) => [c.id, c]));
  const pinned = heroIds.map((id) => byId.get(id)).filter((c): c is ShowcaseCard => !!c);
  const pinnedSet = new Set(pinned.map((c) => c.id));
  const filler = [...pool].filter((c) => !pinnedSet.has(c.id)).sort((a, b) => weighted(b, mean) - weighted(a, mean));
  return { hero: [...pinned, ...filler].slice(0, HERO_SIZE) };
}
