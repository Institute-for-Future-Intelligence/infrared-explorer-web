import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { firebaseDatabase } from './firebase';

/*
 * The site's half of the UGC terms record.
 *
 * `firestore.rules` gates BOTH publishing paths — street views and experiments — on
 * `users/{mongoId}/consents/ugcTerms` existing with a version at least this high. The app asks
 * for that consent with a tick box on its sign-in card, because two app stores require the
 * agreement to be explicit before anyone uploads. The website is not in a store, and the
 * sign-in dialog already states that signing in agrees to the Terms (which since v1 carry the
 * no-tolerance clause), so here the record is written from that act rather than from a second
 * click nobody asked for.
 *
 * Bumping the version re-prompts everyone: the rule stops accepting the old record, so the next
 * sign-in (or the next upload) writes the new one. Keep it in step with the app's
 * UGC_TERMS_VERSION (src/lib/ugcTerms.ts) and the rules' ugcTermsAccepted().
 */
export const UGC_TERMS_VERSION = 1;

// Accounts whose record this tab has already confirmed. Without it every clone would spend a
// read on a document that changes about once a year.
const confirmed = new Set<string>();

/**
 * Make sure this account's consent record exists and is current, and say so. Safe to call on
 * every sign-in and before every publish — after the first success it costs nothing.
 *
 * Failures are the caller's to decide about: sign-in treats them as nothing (the next publish
 * tries again), while a publish that proceeds without one is simply refused by the rules with a
 * message the caller can explain.
 */
export async function ensureUgcConsent(mongoId: string): Promise<boolean> {
  if (!mongoId) return false;
  if (confirmed.has(mongoId)) return true;
  const ref = doc(firebaseDatabase, `users/${mongoId}/consents/ugcTerms`);
  const snap = await getDoc(ref);
  const version = snap.exists() ? snap.data().version : 0;
  if (typeof version === 'number' && version >= UGC_TERMS_VERSION) {
    confirmed.add(mongoId);
    return true;
  }
  // The rules accept exactly these four keys, and `version` must be an integer.
  await setDoc(ref, { version: UGC_TERMS_VERSION, acceptedAt: serverTimestamp(), platform: 'web' });
  confirmed.add(mongoId);
  return true;
}
