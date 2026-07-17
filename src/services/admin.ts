import { collection, collectionGroup, getDocs, query, where, type Timestamp } from 'firebase/firestore';
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
  lastActivityMillis: number | null; // recorded last sign-in, else newest experiment edit/comment; null if unknown
  clips: number; // non-trashed experiments the user owns
  comments: number; // comments authored across all experiments
}

// Comments store their time as a locale string (new Date().toLocaleString()), not a Firestore
// Timestamp, and its layout follows the author's browser locale — M/D/YYYY (en-US), D/M/YYYY
// (en-GB), D.M.YYYY (de-DE), etc. Date.parse only reliably handles the US form, so when it fails
// we pull out the numeric components and disambiguate day vs. month (any value > 12 must be the
// day). Anything still unparseable (e.g. non-Latin digits) yields null and just doesn't count.
function parseMillis(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const direct = Date.parse(v);
  if (!Number.isNaN(direct)) return direct;
  const m = v.match(/(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, g1, g2, g3, hh, mm, ss] = m;
  let year: number;
  let p1: number;
  let p2: number;
  if (g1.length === 4) {
    year = +g1; // YYYY/M/D
    p1 = +g2;
    p2 = +g3;
  } else if (g3.length === 4) {
    year = +g3; // D/M/YYYY or M/D/YYYY
    p1 = +g1;
    p2 = +g2;
  } else {
    return null;
  }
  const month = p1 > 12 ? p2 : p1;
  const day = p1 > 12 ? p1 : p2;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Note: AM/PM is ignored, but the only locales reaching this fallback use 24h clocks (the 12h
  // en-US form is already handled by Date.parse above).
  const d = new Date(year, month - 1, day, hh ? +hh : 0, mm ? +mm : 0, ss ? +ss : 0);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
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

  // Last activity per user: prefer the recorded sign-in time (users/{id}.lastSignIn, stamped by
  // the auth listener). When a user has no stamp yet — they last signed in before the feature
  // shipped — fall back to the newest signal we can derive: an experiment created/edited or a
  // comment posted.
  const lastActivityByUser = new Map<string, number>();
  const bumpActivity = (id: string, ms: number | null) => {
    if (ms == null) return;
    const prev = lastActivityByUser.get(id);
    if (prev === undefined || ms > prev) lastActivityByUser.set(id, ms);
  };

  // Clips per owner: non-trashed experiments, excluding the 'system' showcase owner. Activity is
  // tracked for trashed experiments too (trashing/editing is itself an action).
  const clipsByOwner = new Map<string, number>();
  expSnap.forEach((d) => {
    const data = d.data();
    const owner = data.ownerId as string | undefined;
    if (!owner || owner === 'system') return;
    bumpActivity(owner, Math.max(data.createdAt?.toMillis?.() ?? 0, data.updatedAt?.toMillis?.() ?? 0) || null);
    if (data.trash === true) return;
    clipsByOwner.set(owner, (clipsByOwner.get(owner) ?? 0) + 1);
  });

  // Comments per author.
  const commentsBySender = new Map<string, number>();
  commentsSnap.forEach((d) => {
    const data = d.data();
    const sender = data.senderId as string | undefined;
    if (!sender) return;
    commentsBySender.set(sender, (commentsBySender.get(sender) ?? 0) + 1);
    bumpActivity(sender, parseMillis(data.date));
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
      lastActivityMillis: data.lastSignIn?.toMillis?.() ?? lastActivityByUser.get(id) ?? null,
      clips: clipsByOwner.get(id) ?? 0,
      comments: commentsBySender.get(id) ?? 0,
    };
  });

  users.sort((a, b) => (b.createdAtMillis ?? 0) - (a.createdAtMillis ?? 0));
  return { users, roleCounts };
}

// `updatedAt` is written by the edit/clone paths (serverTimestamp) but isn't on ExperimentDoc; surface
// it here so admin views can show "last updated".
export type AdminExperimentRow = ExperimentDoc & { id: string; updatedAt?: Timestamp };

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

/** Experiments a staff member has taken down (`trashedByStaff == true`) — the Restore surface, since
 *  these are excluded from every normal listing. Single-field equality, so no composite index. */
export async function listTakenDownExperiments(): Promise<AdminExperimentRow[]> {
  const snap = await getDocs(query(collection(firebaseDatabase, 'experiments'), where('trashedByStaff', '==', true)));
  const docs = snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id }));
  docs.sort((a, b) => (b.takedownAt?.toMillis?.() ?? 0) - (a.takedownAt?.toMillis?.() ?? 0));
  return docs;
}
