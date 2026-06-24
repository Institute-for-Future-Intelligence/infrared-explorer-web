import {
  collection,
  collectionGroup,
  doc,
  getCountFromServer,
  getDoc,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
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

/** Read the caller's private profile doc (owner-only under the rules). */
export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(firebaseDatabase, `users/${uid}`));
  return snap.exists() ? (snap.data() as UserProfile) : null;
}

/** Update the caller's profile; mirror displayName to the public slice so others see it. */
export async function updateUserProfile(
  uid: string,
  fields: { displayName?: string; prefs?: UserPrefs },
): Promise<void> {
  await updateDoc(doc(firebaseDatabase, `users/${uid}`), fields);
  if (fields.displayName !== undefined) {
    await setDoc(doc(firebaseDatabase, `usersPublic/${uid}`), { displayName: fields.displayName }, { merge: true });
  }
}
