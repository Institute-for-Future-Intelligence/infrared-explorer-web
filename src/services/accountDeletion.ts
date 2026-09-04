import { signOut } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { firebaseAuth, firebaseFunctions } from './firebase';
import { reauthenticateCurrentUser } from './auth';

/*
 * Account deletion from the web — the "delete your data without the app" half of Google
 * Play's user-data policy, which requires a public web resource where deletion can be
 * requested without re-downloading the app. It calls the SAME `deleteAccount` callable the
 * capture app calls, so there is one purge implementation, not two.
 *
 * Apple's Guideline 5.1.1(v) is satisfied by the app's own in-app entry point, not by this
 * page; a website may only ever COMPLETE a deletion the app started. Nothing here should be
 * linked from the iOS flow.
 */

/** Per-surface counts the callable reports back. Shown to no one; useful in the console. */
export interface DeletionResult {
  ok: boolean;
  experiments: number;
  streetViews: number;
  storageObjects: number;
  classesDeleted: number;
  recordingsRetained: number;
  /** What became of the Sign in with Apple grant, e.g. "revoked via access_token". */
  appleRevocation?: string;
}

/** The Apple material the purge revokes with (functions/src/appleRevoke.ts). */
interface DeleteAccountRequest {
  apple?: { accessToken: string; client: 'web' };
}

/**
 * Delete the signed-in account and everything it uploaded.
 *
 * Re-authenticates through one of the account's linked methods first (Apple when linked, else
 * Google — see services/auth reauthenticateCurrentUser): the callable refuses a sign-in older
 * than ten minutes (deleting is irreversible, so it takes a fresh proof of identity the way
 * Firebase's own client-side deleteUser does), and the popup is also the moment the user can
 * still back out. `getIdToken(true)` forces the refreshed token — without it the SDK would
 * happily send the cached one, whose `auth_time` still predates the popup.
 *
 * An Apple re-authentication also yields Apple's access token, which goes along so the callable
 * can revoke the Sign in with Apple grant (Apple requires that of account deletion; the page
 * itself cannot, Firebase having consumed the authorization code inside the popup).
 *
 * The callable deletes the Firebase Auth record itself, so the local session is dead on
 * return; signing out just clears it from this tab.
 */
export async function deleteMyAccount(): Promise<DeletionResult> {
  const user = firebaseAuth.currentUser;
  if (!user) throw new Error('Sign in first.');
  const { appleAccessToken } = await reauthenticateCurrentUser();
  await user.getIdToken(true);
  // The callable is deployed with timeoutSeconds: 540 because a large account takes minutes to
  // purge. httpsCallable defaults to a 70-second client timeout and does NOT abort the request
  // when it fires — the server would run to completion and delete the auth record while this
  // page reported failure, and the retry would then fail forever against a deleted account.
  const call = httpsCallable<DeleteAccountRequest, DeletionResult>(firebaseFunctions, 'deleteAccount', {
    timeout: 550_000,
  });
  const res = await call(appleAccessToken ? { apple: { accessToken: appleAccessToken, client: 'web' } } : {});
  await signOut(firebaseAuth).catch(() => undefined);
  return res.data;
}
