import {
  collection,
  collectionGroup,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
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
  // Owner-chosen experiment ids pinned to the top of their profile gallery (ordered, max 3). The
  // page renders only the pins that resolve to a currently-public owned experiment.
  pinned?: string[];
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
 * public, so it is NOT written to the private doc at all). A displayName CHANGE additionally
 * fans out to the denormalized `author` string on the caller's experiments (best-effort — the
 * profile save itself must not fail because a batch did).
 */
export async function updateUserProfile(
  uid: string,
  fields: { displayName?: string; prefs?: UserPrefs; bio?: string },
): Promise<void> {
  // Guard against blanking the identity: an empty/whitespace display name is never persisted,
  // and above all never fanned out to the `author` of every experiment (which the backfill tool
  // then refuses to repair, since it skips owners with no usable name). Treat it as "unchanged".
  const displayName =
    fields.displayName !== undefined && fields.displayName.trim() !== '' ? fields.displayName : undefined;

  // Detect a real rename BEFORE writing the mirror (the public slice holds the previous value).
  // On a read FAILURE we cannot tell — skip the fan-out rather than run a full-collection scan on
  // uncertain state (and rather than misread a transient null as "changed"). A later successful
  // rename or scripts/backfillAuthors.mjs reconciles any lag.
  let nameChanged = false;
  if (displayName !== undefined) {
    const current = await getPublicProfile(uid).catch(() => undefined);
    nameChanged = current !== undefined && (current?.displayName ?? null) !== displayName;
  }

  const { bio } = fields;
  const privateFields: { displayName?: string; prefs?: UserPrefs } = {};
  if (displayName !== undefined) privateFields.displayName = displayName;
  if (fields.prefs !== undefined) privateFields.prefs = fields.prefs;
  if (Object.keys(privateFields).length > 0) {
    await updateDoc(doc(firebaseDatabase, `users/${uid}`), privateFields);
  }
  const publicFields: { displayName?: string; bio?: string } = {};
  if (displayName !== undefined) publicFields.displayName = displayName;
  if (bio !== undefined) publicFields.bio = bio;
  if (Object.keys(publicFields).length > 0) {
    await setDoc(doc(firebaseDatabase, `usersPublic/${uid}`), publicFields, { merge: true });
    // The renamer's own comments render from the shared session cache — drop the stale entry so
    // their new name/avatar show without a reload.
    invalidatePublicProfile(uid);
  }

  if (nameChanged && displayName !== undefined) {
    try {
      await fanOutAuthorRename(uid, displayName);
    } catch (e) {
      // Non-fatal: the profile itself saved; stale author strings self-correct on the next rename
      // or via scripts/backfillAuthors.mjs.
      console.error('failed to fan out the new display name to experiment authors', e);
    }
  }
}

/**
 * Set the ordered list of experiment ids the owner has pinned to the top of their public profile
 * (uncapped for the owner; the rules keep only a sanity bound on the list size). Merges into the
 * world-readable usersPublic slice so a single write updates the whole set, and drops the cached
 * copy so comment rows re-read fresh.
 */
export async function updateProfilePins(uid: string, pinned: string[]): Promise<void> {
  await setDoc(doc(firebaseDatabase, `usersPublic/${uid}`), { pinned }, { merge: true });
  invalidatePublicProfile(uid);
}

/**
 * Mirror a display-name change onto the denormalized `author` string of every non-trashed
 * experiment the caller owns, so cards / related lists / the analyzer show the new name.
 * `updatedAt` is deliberately NOT bumped — a rename must not float everything to the top of
 * "Recently updated". Trashed docs are skipped (restoring one shows the old name; harmless,
 * and the backfill script normalizes stragglers).
 */
async function fanOutAuthorRename(uid: string, author: string): Promise<void> {
  const snap = await getDocs(
    query(collection(firebaseDatabase, 'experiments'), where('ownerId', '==', uid), where('trash', '==', false)),
  );
  const stale = snap.docs.filter((d) => d.data().author !== author);
  const BATCH_LIMIT = 450; // Firestore caps a batch at 500 writes
  for (let i = 0; i < stale.length; i += BATCH_LIMIT) {
    const batch = writeBatch(firebaseDatabase);
    stale.slice(i, i + BATCH_LIMIT).forEach((d) => batch.update(d.ref, { author }));
    await batch.commit();
  }
}

/**
 * Keep the public avatar fresh (Google photo URLs rotate/expire, and migrated Atlas URLs may be
 * dead). Called by the auth listener on session restore; writes only on an actual change, and
 * only when the public doc already exists — provisioning is onUserSignIn's job. Best-effort:
 * before the mongoId claim is minted the rules deny the write, which must never block sign-in.
 */
export async function refreshPublicAvatar(uid: string, photoURL: string): Promise<void> {
  try {
    await setDoc(doc(firebaseDatabase, `usersPublic/${uid}`), { avatar: photoURL }, { merge: true });
    invalidatePublicProfile(uid);
  } catch (e) {
    console.warn('[account] failed to refresh public avatar', e);
  }
}

/**
 * Give a user who has no name one, on the sign-in that discovers the profile is nameless. Apple
 * accounts normally arrive that way (utils/displayName explains why), and the pages used to paper
 * over it with the raw email address. Writes BOTH halves of the profile so the public slice — what
 * comments and the profile page read — agrees with the private doc; `merge` so a nickname saved in
 * Settings afterwards always wins, and so nothing else on either doc is touched. Best-effort: a
 * session with no stored name still works, so a denied write (the mongoId claim not minted yet)
 * must not break sign-in. The caller only reaches here when it KNOWS the profile has no name — a
 * failed profile read must not land here, or it would overwrite a nickname it simply couldn't see.
 * Returns the name that ended up on the profile, which is what the caller should show.
 */
export async function ensureDisplayName(uid: string, fallback: string): Promise<string> {
  try {
    // The private doc may already hold a name the public slice never received (a migrated account
    // whose backfill never ran) — mirror THAT rather than paper over it with a generated one.
    const priv = await getDoc(doc(firebaseDatabase, `users/${uid}`));
    const existing = (priv.data()?.displayName as string | null | undefined)?.trim();
    const displayName = existing || fallback;
    await Promise.all([
      setDoc(doc(firebaseDatabase, `users/${uid}`), { displayName }, { merge: true }),
      setDoc(doc(firebaseDatabase, `usersPublic/${uid}`), { displayName }, { merge: true }),
    ]);
    invalidatePublicProfile(uid);
    return displayName;
  } catch (e) {
    console.warn('[account] failed to save the default display name', e);
    return fallback;
  }
}

// Session-lifetime cache of public profiles, shared by every comment row so a thread with many
// posts from the same person issues one read, not one per row. Keyed by uid.
const publicProfileCache = new Map<string, Promise<PublicProfile | null>>();

/**
 * Cached read of a user's public profile for display (comment names/avatars). A genuinely
 * missing profile resolves null and stays cached (it won't appear mid-session); a transient
 * read FAILURE is evicted so a later mount retries instead of being pinned to null forever.
 */
export function getCachedPublicProfile(uid: string): Promise<PublicProfile | null> {
  let pending = publicProfileCache.get(uid);
  if (!pending) {
    pending = getPublicProfile(uid).catch(() => {
      publicProfileCache.delete(uid); // don't pin a transient failure — allow a retry
      return null;
    });
    publicProfileCache.set(uid, pending);
  }
  return pending;
}

/** Drop a cached public profile so the next read re-fetches (e.g. after the user renames). */
export function invalidatePublicProfile(uid: string): void {
  publicProfileCache.delete(uid);
}
