/*
 * The three ways a project is shared, as the Share panel (components/
 * ShareDialog) lists them and the project list's selection bar offers them
 * for several projects at once.
 */

import { Globe, Link2, Lock } from 'lucide-react';
import type { ShareVisibility } from './core/types';

export const SHARE_TIERS: { key: ShareVisibility; label: string; hint: string; icon: typeof Lock }[] = [
  { key: 'private', label: 'Private', hint: 'Only you can open this experiment.', icon: Lock },
  { key: 'unlisted', label: 'Link Only', hint: 'Anyone with the link can view it.', icon: Link2 },
  { key: 'public', label: 'Public', hint: 'Listed in Community. Anyone can view it.', icon: Globe },
];

export const TAKEN_DOWN = 'Staff removed this experiment from Community.';
