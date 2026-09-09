import {
  GoogleAuthProvider,
  OAuthProvider,
  linkWithCredential,
  linkWithPopup,
  onAuthStateChanged,
  reauthenticateWithPopup,
  signInWithPopup,
  signOut as firebaseSignOut,
  unlink,
  User as FirebaseUser,
  type AuthCredential,
} from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import { ensureUgcConsent } from './ugcConsent';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseAuth, firebaseDatabase, firebaseFunctions } from './firebase';
import { ensureDisplayName, getPublicProfile, recordSignIn, refreshPublicAvatar } from './account';
import { defaultDisplayName } from '../utils/displayName';
import useCommonStore from '../stores/common';

/*
 * Identity providers. One Firebase account (uid, and through it the mongoId claim) can carry
 * several: a user who created the account with Sign in with Apple on the iPhone can add Google here
 * and use either afterwards. The set is deliberately the same two the capture app offers, so a
 * method linked on one surface is honoured on the other — Apple's `sub` is the same for the app and
 * for the web Services ID because both hang off one primary App ID (docs/sign-in-providers.md).
 */
export type SignInProvider = 'google' | 'apple';

export const SIGN_IN_PROVIDERS: SignInProvider[] = ['google', 'apple'];

export const PROVIDER_LABEL: Record<SignInProvider, string> = { google: 'Google', apple: 'Apple' };

const PROVIDER_ID: Record<SignInProvider, string> = { google: 'google.com', apple: 'apple.com' };

const providerFromId = (id: string): SignInProvider | null =>
  SIGN_IN_PROVIDERS.find((p) => PROVIDER_ID[p] === id) ?? null;

function makeProvider(provider: SignInProvider) {
  if (provider === 'google') return new GoogleAuthProvider();
  // Apple hands the name and email over on the FIRST authorization only, and the email may be a
  // private relay address — request both, never assume either arrives.
  const apple = new OAuthProvider('apple.com');
  apple.addScope('email');
  apple.addScope('name');
  return apple;
}

/** The sign-in methods attached to the signed-in Firebase user, in our own vocabulary. */
export function linkedProviders(user: FirebaseUser | null = firebaseAuth.currentUser): SignInProvider[] {
  if (!user) return [];
  return user.providerData.map((p) => providerFromId(p.providerId)).filter((p): p is SignInProvider => p !== null);
}

/** The email a linked provider reported (Apple's may be a private relay address, or absent). */
export function linkedProviderEmail(provider: SignInProvider): string | null {
  const row = firebaseAuth.currentUser?.providerData.find((p) => p.providerId === PROVIDER_ID[provider]);
  return row?.email ?? null;
}

// ---------------------------------------------------------------------------------------------
// Errors the UI tells apart

/** The user closed or declined a provider popup, or dismissed the chooser. Never worth a toast. */
export class SignInCancelledError extends Error {
  code = 'auth/sign-in-cancelled';
  constructor() {
    super('Sign-in cancelled');
  }
}

const POPUP_CANCEL_CODES = new Set([
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
  'auth/user-cancelled',
]);

export function isSignInCancelled(e: unknown): boolean {
  if (e instanceof SignInCancelledError) return true;
  const code = (e as { code?: string } | null)?.code;
  return typeof code === 'string' && POPUP_CANCEL_CODES.has(code);
}

/**
 * Firebase's "one account per email address" collision: the email the provider asserted already
 * belongs to an account that signs in the other way (a Google account, and the user just tried
 * Apple with the same address — or the reverse). Firebase refuses to create a second account and
 * hands back the credential it rejected; signing in through `existing` and then linking that
 * credential turns the collision into exactly the multi-method account the user wanted, which
 * signInWithProvider does on its own once the next sign-in succeeds.
 */
export class AccountExistsError extends Error {
  code = 'auth/account-exists-with-different-credential';
  constructor(
    public readonly email: string | null,
    public readonly attempted: SignInProvider,
    public readonly existing: SignInProvider,
  ) {
    super(`An account for ${email ?? 'this email'} already signs in with ${PROVIDER_LABEL[existing]}`);
  }
}

/** The credential Firebase rejected in the last collision, linked after the next successful sign-in. */
let pendingLink: { provider: SignInProvider; credential: AuthCredential; email: string | null } | null = null;

const otherProvider = (provider: SignInProvider): SignInProvider => (provider === 'google' ? 'apple' : 'google');

// ---------------------------------------------------------------------------------------------
// Sign-in

/**
 * Run the provider popup. Resolves as soon as Firebase has the session — BEFORE the app-level
 * listener (initAuthListener) has resolved the mongoId and hydrated the store user, so callers that
 * need `user` wait on the store, not on this promise (see saveToMyExperiments). `linked` names the
 * method a preceding collision left pending and this sign-in just attached, if any.
 */
export async function signInWithProvider(provider: SignInProvider): Promise<{ linked: SignInProvider | null }> {
  let user: FirebaseUser;
  try {
    user = (await signInWithPopup(firebaseAuth, makeProvider(provider))).user;
  } catch (e) {
    if (e instanceof FirebaseError && e.code === 'auth/account-exists-with-different-credential') {
      const credential =
        provider === 'google' ? GoogleAuthProvider.credentialFromError(e) : OAuthProvider.credentialFromError(e);
      const email = (e.customData?.email as string | undefined) ?? null;
      if (credential) pendingLink = { provider, credential, email };
      throw new AccountExistsError(email, provider, otherProvider(provider));
    }
    throw e;
  }
  return { linked: await completePendingLink(user) };
}

/**
 * Attach the credential a previous collision rejected, now that its owner has proven they hold
 * the existing account. Best-effort: the user IS signed in either way; a failed link just means
 * the other method stays unlinked (Settings › Sign-in methods can retry it).
 */
async function completePendingLink(user: FirebaseUser): Promise<SignInProvider | null> {
  const pending = pendingLink;
  pendingLink = null;
  if (!pending) return null;
  if (pending.email && user.email && pending.email.toLowerCase() !== user.email.toLowerCase()) return null;
  try {
    await linkWithCredential(user, pending.credential);
    return pending.provider;
  } catch (e) {
    console.warn('[auth] could not link the rejected credential after sign-in', e);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The sign-in chooser (components/signInDialog) — every "Sign in" affordance opens it via signIn()

export interface SignInPromptState {
  open: boolean;
}

let promptState: SignInPromptState = { open: false };
const promptListeners = new Set<() => void>();
let promptWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

function setPrompt(next: SignInPromptState) {
  promptState = next;
  promptListeners.forEach((l) => l());
}

/** useSyncExternalStore pair for the dialog component. */
export const subscribeSignInPrompt = (listener: () => void): (() => void) => {
  promptListeners.add(listener);
  return () => promptListeners.delete(listener);
};
export const getSignInPrompt = (): SignInPromptState => promptState;

/**
 * Ask the user to sign in: opens the provider chooser and resolves once a provider popup has
 * succeeded (same timing caveat as signInWithProvider), or rejects with SignInCancelledError when
 * the chooser is dismissed. Concurrent requests share the one dialog.
 */
export function signIn(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    promptWaiters.push({ resolve, reject });
    if (!promptState.open) setPrompt({ open: true });
  });
}

/** Called by the dialog when a sign-in completed (settled) or the user dismissed it. */
export function settleSignInPrompt(settled: boolean): void {
  const waiters = promptWaiters;
  promptWaiters = [];
  setPrompt({ open: false });
  waiters.forEach((w) => (settled ? w.resolve() : w.reject(new SignInCancelledError())));
}

export const signOutUser = () => firebaseSignOut(firebaseAuth);

// ---------------------------------------------------------------------------------------------
// Linking (Settings › Sign-in methods)

/**
 * Add a sign-in method to the current account. Firebase refuses when that Google/Apple identity is
 * already attached to ANOTHER account (`auth/credential-already-in-use`) — two accounts cannot be
 * merged from the client, so the caller tells the user which account to keep using.
 */
export async function linkProvider(provider: SignInProvider): Promise<void> {
  const user = firebaseAuth.currentUser;
  if (!user) throw new Error('Sign in first.');
  await linkWithPopup(user, makeProvider(provider));
}

/** Remove a sign-in method. The last one cannot go — the account would become unreachable. */
export async function unlinkProvider(provider: SignInProvider): Promise<void> {
  const user = firebaseAuth.currentUser;
  if (!user) throw new Error('Sign in first.');
  if (linkedProviders(user).length <= 1) {
    throw new Error('This is the only way to sign in to the account — add another method before removing it.');
  }
  await unlink(user, PROVIDER_ID[provider]);
}

/**
 * Fresh proof of identity for destructive callables (account deletion). Apple is preferred whenever
 * it is linked — not for familiarity, but because its popup is the only place this page can obtain
 * a fresh Apple access token, which the purge needs to revoke the Sign in with Apple grant (Apple's
 * own condition on account deletion, TN3194; the callable does the revoking). Google-only accounts
 * re-authenticate through Google and have nothing to revoke.
 */
export async function reauthenticateCurrentUser(): Promise<{
  provider: SignInProvider;
  appleAccessToken: string | null;
}> {
  const user = firebaseAuth.currentUser;
  if (!user) throw new Error('Sign in first.');
  const linked = linkedProviders(user);
  const provider = linked.includes('apple') ? 'apple' : linked[0];
  if (!provider) throw new Error('This account has no sign-in method that can be confirmed here.');
  const result = await reauthenticateWithPopup(user, makeProvider(provider));
  // Firebase exchanged Apple's authorization code inside the popup (that is what the console's
  // OAuth code flow configuration is for) and hands back the resulting access token.
  const appleAccessToken =
    provider === 'apple' ? (OAuthProvider.credentialFromResult(result)?.accessToken ?? null) : null;
  return { provider, appleAccessToken };
}

// ---------------------------------------------------------------------------------------------
// Session → store

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
    // Whatever the outcome, mark the initial session as resolved so pages gated on
    // "is this me?" (the profile page) stop waiting instead of flashing the signed-out view.
    try {
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
      // Stamp last sign-in (best-effort, fire-and-forget — never blocks restoring the session).
      // Fires whenever an authenticated session is (re)established, so it also captures returning
      // visits on refresh, not just the explicit popup sign-in.
      void recordSignIn(mongoId);
      // Record that this account has accepted the UGC terms — the sign-in dialog says so in as
      // many words, and firestore.rules will not accept an upload without the document. Silent
      // and fire-and-forget: the publish paths ask again, so a failure here costs nothing.
      void ensureUgcConsent(mongoId).catch((e) => console.warn('[auth] could not record UGC consent', e));
      // Prefer the saved nickname over the provider's account name so a custom display name set
      // in Settings survives a refresh (the store is otherwise rebuilt from the Firebase user
      // on every load). Best-effort: fall back to fbUser.displayName if unset or the read fails.
      // `undefined` = the read failed, so we know nothing; `null` = there really is no profile.
      // The difference decides whether a missing name may be filled in below.
      const saved = await getPublicProfile(mongoId).catch((e) => {
        console.warn('[auth] failed to load public profile', e);
        return undefined;
      });
      // Keep the public avatar current: onUserSignIn only runs when the claim is missing, so
      // without this a rotated Google photo URL would go stale on the profile page forever.
      if (saved && fbUser.photoURL && saved.avatar !== fbUser.photoURL) {
        void refreshPublicAvatar(mongoId, fbUser.photoURL);
      }
      // A nameless account gets a name of its own rather than wearing its email address: Apple
      // releases the user's name on the first authorization only (and only with consent), so an
      // Apple sign-in normally lands here with nothing — and with "Hide My Email" the address is a
      // random relay one that reads as noise wherever a name belongs. Persisted the first time we
      // see the gap, so comments and experiment `author` strings agree with what the pages show;
      // skipped when the profile read failed, since we would be overwriting a name we can't see.
      let displayName = saved?.displayName?.trim() || fbUser.displayName?.trim() || null;
      if (!displayName) {
        const fallback = defaultDisplayName(fbUser.email, mongoId);
        // Awaited, not fired and forgotten: the write settles which name the account carries (the
        // private doc may hold one the public slice never got), and the page should show that one.
        // It runs at most once per account — the next sign-in finds the name and skips this.
        displayName = saved === undefined ? fallback : await ensureDisplayName(mongoId, fallback);
      }
      useCommonStore.getState().setUser({
        id: mongoId,
        displayName,
        email: fbUser.email,
        avatar: fbUser.photoURL,
      });
    } finally {
      useCommonStore.getState().setAuthReady(true);
    }
  });
};
