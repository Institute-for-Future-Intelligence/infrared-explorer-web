/*
 * The three ways a project is shared, as the experiment list's tier filter
 * and selection bar read them — the site's one tier table
 * (components/visibilityControl), in a project's words.
 */

import type { ShareVisibility } from './core/types';
import { TAKEN_DOWN, VISIBILITY_OPTIONS, tierHint } from '../components/visibilityControl';

export { TAKEN_DOWN };

export const SHARE_TIERS: {
  key: ShareVisibility;
  label: string;
  hint: string;
  icon: (typeof VISIBILITY_OPTIONS)[number]['icon'];
}[] = VISIBILITY_OPTIONS.map((o) => ({
  key: o.value,
  label: o.label,
  hint: tierHint('experiment', o.value),
  icon: o.icon,
}));
