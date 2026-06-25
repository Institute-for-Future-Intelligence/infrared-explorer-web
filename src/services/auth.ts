import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  User as FirebaseUser,
} from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseAuth, firebaseDatabase, firebaseFunctions } from './firebase';
import { getPublicProfile } from './account';
import useCommonStore from '../stores/common';

const provider = new GoogleAuthProvider();

export const signIn = () => signInWithPopup(firebaseAuth, provider);
export const signOutUser = () => firebaseSignOut(firebaseAuth);

// The onUserSignIn Function is only reachable once deployed (or when the emulator runs).
// Until then, skip the callable entirely so the page isn't spammed with CORS errors, and
// resolve identity by email instead (good enough for public reads; writes need the claim).
const functionsEnabled =
  import.meta.env.VITE_FUNCTIONS_ENABLED === 'true' || import.meta.env.VITE_USE_EMULATORS === 'true';

async function lookupMongoIdByEmail(email: string): Promise<string | null> {
  const snap = await getDocs(query(collection(firebaseDatabase, 'users'), where('email', '==', email)));
  if (snap.empty) return null;
  return (snap.docs[0].data().id as string) ?? snap.docs[0].id;
}

/**
 * Resolve the caller's identity key — the legacy Mongo ObjectId, NOT auth.uid.
 *  1. Fast path: it's already in the `mongoId` custom claim.
 *  2. If Functions are enabled, call onUserSignIn to provision/resolve it and mint the claim.
 *  3. Fallback: look the user up by email (seeded/existing users keep working for reads).
 */
async function resolveMongoId(fbUser: FirebaseUser): Promise<string | null> {
  const token = await fbUser.getIdTokenResult();
  if (token.claims.mongoId) return token.claims.mongoId as string;

  if (functionsEnabled) {
    try {
      const fn = httpsCallable<unknown, { mongoId: string }>(firebaseFunctions, 'onUserSignIn');
      const res = await fn();
      await fbUser.getIdToken(true); // refresh so the new claim is live
      return res.data.mongoId;
    } catch (err) {
      console.warn('[auth] onUserSignIn failed; falling back to email lookup', err);
    }
  }

  if (fbUser.email) {
    const mongoId = await lookupMongoIdByEmail(fbUser.email);
    if (mongoId) return mongoId;
  }

  if (!functionsEnabled) {
    console.info(
      '[auth] no user record for this email and Functions are disabled. Deploy onUserSignIn and set ' +
        'VITE_FUNCTIONS_ENABLED=true (or run the emulator) to provision new users.',
    );
  }
  return null;
}

let started = false;

/**
 * Register the single app-level auth listener. Idempotent — safe to call from a hook.
 * Replaces the old listener that was parasitic on the SignInButton's useEffect (which
 * unmounted after login, so a page refresh could leave the store user null).
 */
export const initAuthListener = () => {
  if (started) return;
  started = true;

  onAuthStateChanged(firebaseAuth, async (fbUser) => {
    if (!fbUser) {
      useCommonStore.getState().setUser(null);
      return;
    }
    const mongoId = await resolveMongoId(fbUser);
    if (!mongoId) {
      console.error('[auth] could not resolve mongoId; treating as signed out.');
      useCommonStore.getState().setUser(null);
      return;
    }
    // Prefer the saved nickname over the Google account name so a custom display name set
    // in Settings survives a refresh (the store is otherwise rebuilt from the Firebase user
    // on every load). Best-effort: fall back to fbUser.displayName if unset or the read fails.
    const saved = await getPublicProfile(mongoId).catch((e) => {
      console.warn('[auth] failed to load public profile', e);
      return null;
    });
    useCommonStore.getState().setUser({
      id: mongoId,
      displayName: saved?.displayName || fbUser.displayName,
      email: fbUser.email,
      avatar: fbUser.photoURL,
    });
  });
};
