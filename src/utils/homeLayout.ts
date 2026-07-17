import { ExperimentDoc, ExperimentSubjects } from '../types';
import { SUBJECT_META } from '../components/card/subjectMeta';

export type ShowcaseCard = ExperimentDoc & { id: string };

export interface HomeRow {
  key: string;
  title: string;
  subject?: ExperimentSubjects;
  items: ShowcaseCard[];
}

export interface HomeLayout {
  /** 1 big + up to 4 small featured cards; empty for a tiny pool. */
  hero: ShowcaseCard[];
  /** Curated scrolling rows (Trending / Top rated / per-subject), each already deduped against the
   *  hero and the rows above it. Empty when the pool is too small to bother. */
  rows: HomeRow[];
}

const HERO_SIZE = 5;
const HERO_MIN = 5; // below this, no hero (just the grid)
const SIMPLE_MAX = 20; // below this, hero + grid only (no curated rows)
const ROW_CAP = 12;
const ROW_MIN = 4; // a curated row needs at least this many after dedup to earn its header
const PRIOR = 3; // Bayesian prior vote count (also the "Top rated" min-votes gate)

/** Bayesian-weighted average rating: pulls a 1-vote 5★ toward the global mean so a well-reviewed
 *  4.6 (many votes) outranks it. Shared by the hero pick and the "Top rated" row. */
const weighted = (c: ShowcaseCard, mean: number) =>
  ((c.ratingSum ?? 0) + mean * PRIOR) / ((c.ratingCount ?? 0) + PRIOR);

const createdMillis = (c: ShowcaseCard) => (c.createdAt ? c.createdAt.toMillis() : 0);

const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

/**
 * Slice the (already-curated, featured) pool into a homepage layout: a hero board plus curated rows.
 *
 * Everything is an in-memory slice of the one array the homepage already loads — zero extra queries.
 * Rows dedupe against the hero and each other (cross-row dedup) so the same experiment can't fill
 * three rows and make the site look tiny; the bottom "All experiments" grid still shows the full
 * pool, so nothing is hidden. A small pool degrades gracefully (hero + grid, or just the grid).
 */
export function buildHomeLayout(pool: ShowcaseCard[], heroIds: string[] = []): HomeLayout {
  if (pool.length < HERO_MIN) return { hero: [], rows: [] };

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
  const hero = [...pinned, ...filler].slice(0, HERO_SIZE);
  const seen = new Set(hero.map((c) => c.id));

  // Tiny pool: hero + grid only, curated rows would just re-show the same handful.
  if (pool.length < SIMPLE_MAX) return { hero, rows: [] };

  const rows: HomeRow[] = [];
  const pick = (sorted: ShowcaseCard[]) => sorted.filter((c) => !seen.has(c.id)).slice(0, ROW_CAP);
  const commit = (items: ShowcaseCard[]) => items.forEach((c) => seen.add(c.id));

  const trending = pick([...pool].sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0)));
  if (trending.length >= ROW_MIN) {
    commit(trending);
    rows.push({ key: 'trending', title: 'Trending', items: trending });
  }

  const topRated = pick(
    [...pool].filter((c) => (c.ratingCount ?? 0) >= PRIOR).sort((a, b) => weighted(b, mean) - weighted(a, mean)),
  );
  if (topRated.length >= ROW_MIN) {
    commit(topRated);
    rows.push({ key: 'toprated', title: 'Top rated', items: topRated });
  }

  for (const subject of SUBJECT_ORDER) {
    const items = pick(
      [...pool].filter((c) => c.subject === subject).sort((a, b) => createdMillis(b) - createdMillis(a)),
    );
    if (items.length >= ROW_MIN) {
      commit(items);
      rows.push({ key: subject, title: SUBJECT_META[subject]?.label ?? subject, subject, items });
    }
  }

  return { hero, rows };
}
