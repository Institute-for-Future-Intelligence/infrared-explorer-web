import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
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
