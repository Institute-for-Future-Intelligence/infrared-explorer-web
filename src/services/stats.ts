import { httpsCallable } from 'firebase/functions';
import { firebaseFunctions } from './firebase';

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
