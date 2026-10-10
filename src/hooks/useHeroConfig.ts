import { useEffect, useState } from 'react';
import { HomeConfig, subscribeHomeConfig } from '../services/homeConfig';

/**
 * Live hero config (config/homepage: hero order + thumbnail framing), shared by every visitor so the
 * curated board is global. Read-only: Curate mode edits a local draft and writes it in one publish
 * batch (see services/curation.ts), so this hook just tracks the published value.
 */
export function useHeroConfig(): HomeConfig {
  const [config, setConfig] = useState<HomeConfig>({ heroIds: [], heroFocus: {} });
  useEffect(() => subscribeHomeConfig(setConfig), []);
  return config;
}
