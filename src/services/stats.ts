import { httpsCallable } from 'firebase/functions';
import { firebaseFunctions } from './firebase';

// Callables are only reachable once deployed (or when the emulator runs) — mirrors the same
// gate in services/auth.ts so a dev setup without Functions isn't spammed with CORS errors.
const functionsEnabled =
  import.meta.env.VITE_FUNCTIONS_ENABLED === 'true' || import.meta.env.VITE_USE_EMULATORS === 'true';

export interface SiteStats {
  users: number;
  experiments: number;
}

/**
 * Global site counts for the homepage footer. Goes through the getSiteStats callable, which
 * computes the totals with the Admin SDK (the security rules keep both collections
 * un-enumerable by clients) and caches them server-side. No auth required.
 */
export async function getSiteStats(): Promise<SiteStats> {
  const fn = httpsCallable<void, SiteStats>(firebaseFunctions, 'getSiteStats');
  const { data } = await fn();
  return data;
}

/**
 * Fire-and-forget view ping for the analyzer. The server (recordView callable) enforces
 * everything: public/unlisted only, owner visits skipped, one counted view per (IP,
 * experiment) per hour. No auth required, so anonymous visitors count. Never throws — a
 * failed ping must not affect the page.
 */
export function recordView(expId: string): void {
  if (!functionsEnabled) return;
  const fn = httpsCallable<{ expId: string }, { counted: boolean }>(firebaseFunctions, 'recordView');
  void fn({ expId }).catch((e) => console.warn('failed to record view', e));
}

export interface PublicProfileStats {
  comments: number;
}

/**
 * Per-user public stats for the profile page (currently the authored-comment count, which the
 * rules keep visitors from counting themselves). Server-cached ~5 min. Returns null when
 * Functions are unavailable or the call fails — the profile renders without the stat.
 */
export async function getPublicProfileStats(userId: string): Promise<PublicProfileStats | null> {
  if (!functionsEnabled) return null;
  try {
    const fn = httpsCallable<{ userId: string }, PublicProfileStats>(firebaseFunctions, 'getPublicProfileStats');
    const { data } = await fn({ userId });
    return data;
  } catch (e) {
    console.warn('failed to load profile stats', e);
    return null;
  }
}
