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
import useCommonStore from '../stores/common';

const provider = new GoogleAuthProvider();

export const signIn = () => signInWithPopup(firebaseAuth, provider);
export const signOutUser = () => firebaseSignOut(firebaseAuth);

/**
 * Resolve the caller's identity key — the legacy Mongo ObjectId, NOT auth.uid.
 *  1. Fast path: it's already in the `mongoId` custom claim.
 *  2. Otherwise call the onUserSignIn Function to provision/resolve it, then refresh
 *     the token so the claim is present for subsequent Firestore writes.
 *  3. Fallback (Function not deployed yet): look the user up by email so seeded users
 *     keep working; brand-new users require the Function to be deployed.
 */
async function resolveMongoId(fbUser: FirebaseUser): Promise<string | null> {
  const token = await fbUser.getIdTokenResult();
  if (token.claims.mongoId) return token.claims.mongoId as string;

  try {
    const fn = httpsCallable<unknown, { mongoId: string }>(firebaseFunctions, 'onUserSignIn');
    const res = await fn();
    await fbUser.getIdToken(true); // refresh so the new claim is live
    return res.data.mongoId;
  } catch (err) {
    console.warn('[auth] onUserSignIn unavailable — falling back to email lookup', err);
    if (fbUser.email) {
      const snap = await getDocs(query(collection(firebaseDatabase, 'users'), where('email', '==', fbUser.email)));
      if (!snap.empty) return (snap.docs[0].data().id as string) ?? snap.docs[0].id;
    }
    return null;
  }
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
      // No identity could be established (new user + Function not deployed). Treat as signed-out
      // so the UI doesn't pretend to be logged in with a broken identity.
      console.error('[auth] could not resolve mongoId; deploy the onUserSignIn Function to provision new users.');
      useCommonStore.getState().setUser(null);
      return;
    }
    useCommonStore.getState().setUser({
      id: mongoId,
      displayName: fbUser.displayName,
      email: fbUser.email,
      avatar: fbUser.photoURL,
    });
  });
};
