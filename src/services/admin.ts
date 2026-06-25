import { collection, collectionGroup, getDocs } from 'firebase/firestore';
import { firebaseDatabase } from './firebase';
import { ExperimentDoc } from '../types';

// Staff-only data access for the Admin screens (All Users / All Experiments). These reads cut
// across every owner and every visibility, so they are authorized in firestore.rules by the
// `isStaff()` email-domain check — a non-staff caller's queries here are rejected by the rules.
// This is the Firebase analogue of telelab's GET /api/users + /api/recentClips admin endpoints,
// but the per-user clip/comment counts are derived client-side from full-collection reads
// instead of being denormalized + recomputed by a "Force Update" button.

export interface AdminUserRow {
  id: string; // legacy Mongo ObjectId (identity key)
  displayName: string;
  email: string;
  role: string;
  createdAtMillis: number | null;
  clips: number; // non-trashed experiments the user owns
  comments: number; // comments authored across all experiments
}

export interface AdminUsersResult {
  users: AdminUserRow[];
  roleCounts: Record<string, number>;
}

/**
 * Load every user with their clip/comment counts, newest-first. Clip and comment totals are
 * joined in memory from a single pass over the `experiments` collection and the `comments`
 * collection group, so this is three reads regardless of user count (vs. telelab's per-user
 * recompute loop).
 */
export async function listAllUsers(): Promise<AdminUsersResult> {
  const [usersSnap, expSnap, commentsSnap] = await Promise.all([
    getDocs(collection(firebaseDatabase, 'users')),
    getDocs(collection(firebaseDatabase, 'experiments')),
    getDocs(collectionGroup(firebaseDatabase, 'comments')),
  ]);

  // Clips per owner: non-trashed experiments, excluding the 'system' showcase owner.
  const clipsByOwner = new Map<string, number>();
  expSnap.forEach((d) => {
    const data = d.data();
    if (data.trash === true) return;
    const owner = data.ownerId as string | undefined;
    if (!owner || owner === 'system') return;
    clipsByOwner.set(owner, (clipsByOwner.get(owner) ?? 0) + 1);
  });

  // Comments per author.
  const commentsBySender = new Map<string, number>();
  commentsSnap.forEach((d) => {
    const sender = d.data().senderId as string | undefined;
    if (!sender) return;
    commentsBySender.set(sender, (commentsBySender.get(sender) ?? 0) + 1);
  });

  const roleCounts: Record<string, number> = {};
  const users: AdminUserRow[] = usersSnap.docs.map((d) => {
    const data = d.data();
    const id = (data.id as string) ?? d.id;
    // Normalize role casing — legacy docs mix 'Admin'/'admin', which otherwise show up as two
    // separate buckets in the registration tally and the Role column.
    const role = ((data.role as string) ?? 'student').toLowerCase();
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;
    return {
      id,
      displayName: (data.displayName as string) ?? '',
      email: (data.email as string) ?? '',
      role,
      createdAtMillis: data.createdAt?.toMillis?.() ?? null,
      clips: clipsByOwner.get(id) ?? 0,
      comments: commentsBySender.get(id) ?? 0,
    };
  });

  users.sort((a, b) => (b.createdAtMillis ?? 0) - (a.createdAtMillis ?? 0));
  return { users, roleCounts };
}

export type AdminExperimentRow = ExperimentDoc & { id: string };

/**
 * Every experiment across all owners and visibilities (trash excluded), newest-first by the
 * server-set `createdAt`. Sorted client-side to tolerate legacy docs missing the field.
 */
export async function listAllExperiments(): Promise<AdminExperimentRow[]> {
  const snap = await getDocs(collection(firebaseDatabase, 'experiments'));
  const docs = snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id })).filter((e) => e.trash !== true);
  docs.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
  return docs;
}
