import {
  collection,
  collectionGroup,
  doc,
  getCountFromServer,
  getDoc,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import type { Timestamp } from 'firebase/firestore';
import { firebaseDatabase } from './firebase';

export interface UserPrefs {
  disallowCopy?: boolean;
  disallowNotification?: boolean;
  disallowNewsletter?: boolean;
}

export interface UserProfile {
  displayName?: string;
  email?: string;
  prefs?: UserPrefs;
}

/** Profile-card counts for the settings sidebar. A count is `null` when its query
 *  fails (e.g. the collection-group index isn't deployed yet) so the page still renders. */
export interface UserStats {
  clips: number | null; // non-trashed experiments the user owns
  comments: number | null; // comments the user has authored across all experiments
}

/**
 * Best-effort counts for the profile sidebar. The clip count reuses the existing
 * `ownerId + trash` composite index; the comment count is a collection-group query over
 * every experiment's `comments` subcollection and needs the `comments.senderId`
 * COLLECTION_GROUP field override (see firestore.indexes.json). Each count is isolated so
 * one missing index doesn't take out the other — a failed count degrades to `null`.
 */
export async function getUserStats(uid: string): Promise<UserStats> {
  const clipsQ = query(
    collection(firebaseDatabase, 'experiments'),
    where('ownerId', '==', uid),
    where('trash', '==', false),
  );
  const commentsQ = query(collectionGroup(firebaseDatabase, 'comments'), where('senderId', '==', uid));
  const [clips, comments] = await Promise.all([
    getCountFromServer(clipsQ)
      .then((s) => s.data().count)
      .catch((e) => {
        console.error('failed to count clips', e);
        return null;
      }),
    getCountFromServer(commentsQ)
      .then((s) => s.data().count)
      .catch((e) => {
        console.error('failed to count comments', e);
        return null;
      }),
  ]);
  return { clips, comments };
}

/**
 * Stamp the caller's last sign-in time with the server clock. Best-effort and fire-and-forget
 * from the auth listener: a failure (e.g. the `mongoId` claim hasn't been minted yet, so the
 * rules deny the write) must never block restoring the session. `merge` so it never clobbers
 * other profile fields; `serverTimestamp()` so the value can't be skewed by a wrong client clock.
 */
export async function recordSignIn(uid: string): Promise<void> {
  try {
    await setDoc(doc(firebaseDatabase, `users/${uid}`), { lastSignIn: serverTimestamp() }, { merge: true });
  } catch (e) {
    console.warn('[account] failed to record sign-in time', e);
  }
}

/** Read the caller's private profile doc (owner-only under the rules). */
export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(firebaseDatabase, `users/${uid}`));
  return snap.exists() ? (snap.data() as UserProfile) : null;
}

/** World-readable slice at usersPublic/{uid} — everything the public profile page shows. */
export interface PublicProfile {
  displayName?: string;
  avatar?: string;
  bio?: string;
  createdAt?: Timestamp; // "Joined" date; stamped by onUserSignIn (new users) / backfill (existing)
}

/**
 * Read a user's public profile slice (displayName / avatar / bio / joined date). World-readable
 * under the rules, so it resolves even before the `mongoId` claim is minted — which is why the
 * auth listener uses this (not the owner-only `users/{id}`) to restore the saved nickname on
 * sign-in. Mirrored by updateUserProfile(), so it tracks the latest saved displayName.
 */
export async function getPublicProfile(uid: string): Promise<PublicProfile | null> {
  const snap = await getDoc(doc(firebaseDatabase, `usersPublic/${uid}`));
  return snap.exists() ? (snap.data() as PublicProfile) : null;
}

/**
 * Update the caller's profile. displayName/prefs live on the private users/{uid} doc;
 * displayName and bio are mirrored to the world-readable usersPublic slice (bio is inherently
 * public, so it is NOT written to the private doc at all).
 */
export async function updateUserProfile(
  uid: string,
  fields: { displayName?: string; prefs?: UserPrefs; bio?: string },
): Promise<void> {
  const { bio, ...privateFields } = fields;
  if (Object.keys(privateFields).length > 0) {
    await updateDoc(doc(firebaseDatabase, `users/${uid}`), privateFields);
  }
  const publicFields: { displayName?: string; bio?: string } = {};
  if (fields.displayName !== undefined) publicFields.displayName = fields.displayName;
  if (bio !== undefined) publicFields.bio = bio;
  if (Object.keys(publicFields).length > 0) {
    await setDoc(doc(firebaseDatabase, `usersPublic/${uid}`), publicFields, { merge: true });
  }
}
