import { useEffect, useState } from 'react';
import { subscribeHeroIds } from '../services/homeConfig';

/**
 * Live hero-order config (config/homepage.heroIds), shared by every visitor so the curated order is
 * global. Read-only: Curate mode edits a local draft and writes the order in one publish batch (see
 * services/curation.ts), so this hook just tracks the published value.
 */
export function useHeroConfig(): string[] {
  const [heroIds, setHeroIds] = useState<string[]>([]);
  useEffect(() => subscribeHeroIds(setHeroIds), []);
  return heroIds;
}
