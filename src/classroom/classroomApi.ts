import {
  addDoc,
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  arrayRemove,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { firebaseDatabase, firebaseFunctions } from '../services/firebase';
import { cloneExperimentById, renameExperiment } from '../services/experiments';
import { Experiment, ExperimentDoc, ExperimentType, User, Visibility } from '../types';
import { Assignment, ClassInfo, ClassMember, Grade, ShowcaseItem, Submission, WorkspaceItem } from './types';

const db = firebaseDatabase;

/** Quietly log a snapshot listener error (e.g. permission-denied) instead of letting it throw uncaught. */
const onSnapError = (where: string) => (e: unknown) => console.warn(`[classroom] ${where} listener error`, e);

// ---------------------------------------------------------------------------
// Callables (createClass / joinClass / promoteToShowcase)
// ---------------------------------------------------------------------------

export async function createClass(name: string, password: string): Promise<{ classId: string; classNumber: string }> {
  const fn = httpsCallable<{ name: string; password: string }, { classId: string; classNumber: string }>(
    firebaseFunctions,
    'createClass',
  );
  return (await fn({ name, password })).data;
}

export async function joinClass(
  classNumber: string,
  password: string,
): Promise<{ classId: string; joined?: boolean; alreadyMember?: boolean }> {
  const fn = httpsCallable<
    { classNumber: string; password: string },
    { classId: string; joined?: boolean; alreadyMember?: boolean }
  >(firebaseFunctions, 'joinClass');
  return (await fn({ classNumber, password })).data;
}

/** Read the class join password. Rules only allow the class's teacher to read it. */
export async function fetchClassPassword(classId: string): Promise<string | null> {
  const snap = await getDoc(doc(db, `classSecrets/${classId}`));
  return snap.exists() ? ((snap.data()?.password as string | undefined) ?? null) : null;
}

/** Teacher changes the class join password. */
export async function changeClassPassword(classId: string, newPassword: string): Promise<void> {
  const fn = httpsCallable<{ classId: string; newPassword: string }, { ok: boolean }>(
    firebaseFunctions,
    'changeClassPassword',
  );
  await fn({ classId, newPassword });
}

export async function promoteToShowcase(
  classId: string,
  assignmentId: string,
  studentUid: string,
): Promise<{ itemId: string }> {
  const fn = httpsCallable<{ classId: string; assignmentId: string; studentUid: string }, { itemId: string }>(
    firebaseFunctions,
    'promoteToShowcase',
  );
  return (await fn({ classId, assignmentId, studentUid })).data;
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export async function fetchClass(classId: string): Promise<ClassInfo | null> {
  const snap = await getDoc(doc(db, `classes/${classId}`));
  return snap.exists() ? { ...(snap.data() as ClassInfo), id: snap.id } : null;
}

/** Classes the user teaches (created). */
export async function fetchTaughtClasses(uid: string): Promise<ClassInfo[]> {
  const snap = await getDocs(query(collection(db, 'classes'), where('teacherUid', '==', uid)));
  const list = snap.docs.map((d) => ({ ...(d.data() as ClassInfo), id: d.id }));
  list.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
  return list;
}

/**
 * Classes the user joined. We gather class ids from two sources and union them, so neither a
 * stale denormalized array nor a finicky collection-group query alone can break the list:
 *   1. users/{uid}.joinedClasses — a single own-doc read (the most permissive rule), reliable.
 *   2. collectionGroup('members') where uid == me — the source of truth (membership docs),
 *      which self-heals a stale array. Wrapped in try/catch so an index/rule hiccup can't
 *      blank the list.
 * Each class is then loaded with a single getDoc (authorized by isMember/teacher on a get).
 */
export async function fetchJoinedClasses(uid: string): Promise<ClassInfo[]> {
  const ids = new Set<string>();

  try {
    const userSnap = await getDoc(doc(db, `users/${uid}`));
    for (const id of (userSnap.data()?.joinedClasses as string[] | undefined) ?? []) ids.add(id);
  } catch (e) {
    console.warn('[classroom] reading joinedClasses array failed', e);
  }

  try {
    const snap = await getDocs(query(collectionGroup(db, 'members'), where('uid', '==', uid)));
    for (const d of snap.docs) {
      const cid = d.ref.parent.parent?.id;
      if (cid) ids.add(cid);
    }
  } catch (e) {
    console.warn('[classroom] collectionGroup(members) query failed; relying on the array', e);
  }

  if (ids.size === 0) return [];
  const results = await Promise.all([...ids].map((id) => fetchClass(id).catch(() => null)));
  const classes = results.filter((c): c is ClassInfo => !!c);
  classes.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
  return classes;
}

export async function setJoinOpen(classId: string, joinOpen: boolean): Promise<void> {
  await updateDoc(doc(db, `classes/${classId}`), { joinOpen });
}

export async function renameClass(classId: string, name: string): Promise<void> {
  await updateDoc(doc(db, `classes/${classId}`), { name });
}

/** Delete a class; the onClassDeleted trigger recursively removes the subtree + secret/number docs. */
export async function deleteClass(classId: string): Promise<void> {
  await deleteDoc(doc(db, `classes/${classId}`));
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export function subscribeMembers(classId: string, cb: (members: ClassMember[]) => void): () => void {
  return onSnapshot(
    collection(db, `classes/${classId}/members`),
    (snap) => {
      const list = snap.docs.map((d) => d.data() as ClassMember);
      list.sort((a, b) => (a.joinedAt?.toMillis?.() ?? 0) - (b.joinedAt?.toMillis?.() ?? 0));
      cb(list);
    },
    onSnapError('members'),
  );
}

/** Teacher removes a member (deletes only the member doc). */
export async function removeMember(classId: string, studentUid: string): Promise<void> {
  await deleteDoc(doc(db, `classes/${classId}/members/${studentUid}`));
}

/** Student leaves a class: delete own member doc + drop the id from their own user doc. */
export async function leaveClass(classId: string, uid: string): Promise<void> {
  await deleteDoc(doc(db, `classes/${classId}/members/${uid}`));
  await updateDoc(doc(db, `users/${uid}`), { joinedClasses: arrayRemove(classId) }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export async function createAssignment(
  classId: string,
  fields: { title: string; description?: string; dueAt?: Timestamp | null; refExpId?: string | null },
): Promise<string> {
  const ref = await addDoc(collection(db, `classes/${classId}/assignments`), {
    title: fields.title,
    description: fields.description ?? '',
    dueAt: fields.dueAt ?? null,
    refExpId: fields.refExpId ?? null,
    open: true,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateAssignment(
  classId: string,
  aId: string,
  fields: Partial<Pick<Assignment, 'title' | 'description' | 'dueAt' | 'refExpId' | 'open'>>,
): Promise<void> {
  await updateDoc(doc(db, `classes/${classId}/assignments/${aId}`), fields);
}

export async function deleteAssignment(classId: string, aId: string): Promise<void> {
  await deleteDoc(doc(db, `classes/${classId}/assignments/${aId}`));
}

/** One-time fetch of a class's assignments (newest first). */
export async function fetchAssignments(classId: string): Promise<Assignment[]> {
  const snap = await getDocs(collection(db, `classes/${classId}/assignments`));
  const list = snap.docs.map((d) => ({ ...(d.data() as Assignment), id: d.id }));
  list.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
  return list;
}

export function subscribeAssignments(classId: string, cb: (assignments: Assignment[]) => void): () => void {
  return onSnapshot(
    collection(db, `classes/${classId}/assignments`),
    (snap) => {
      const list = snap.docs.map((d) => ({ ...(d.data() as Assignment), id: d.id }));
      list.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
      cb(list);
    },
    onSnapError('assignments'),
  );
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

/** Student submits (or re-submits) one experiment to an assignment (idempotent, doc id == uid). */
export async function submitToAssignment(
  classId: string,
  aId: string,
  user: User,
  experiment: Pick<Experiment, 'id' | 'displayName' | 'thumbnailURL' | 'duration'> & {
    recordingId?: string;
    sourceType?: Experiment['sourceType'];
  },
): Promise<void> {
  await setDoc(doc(db, `classes/${classId}/assignments/${aId}/submissions/${user.id}`), {
    studentUid: user.id,
    studentName: user.displayName ?? '',
    expId: experiment.id,
    recordingId: experiment.recordingId ?? null,
    sourceType: experiment.sourceType ?? null,
    title: experiment.displayName ?? '',
    thumbnailURL: experiment.thumbnailURL ?? '',
    duration: experiment.duration ?? 0,
    submittedAt: serverTimestamp(),
  });
}

/** Teacher view: live list of all submissions for one assignment. */
export function subscribeSubmissions(
  classId: string,
  aId: string,
  cb: (submissions: Submission[]) => void,
): () => void {
  return onSnapshot(
    collection(db, `classes/${classId}/assignments/${aId}/submissions`),
    (snap) => {
      const list = snap.docs.map((d) => d.data() as Submission);
      list.sort((a, b) => (b.submittedAt?.toMillis?.() ?? 0) - (a.submittedAt?.toMillis?.() ?? 0));
      cb(list);
    },
    onSnapError('submissions'),
  );
}

/** Submit by experiment id — fetches fresh experiment data so the snapshot is accurate. */
export async function submitExperimentById(classId: string, aId: string, user: User, expId: string): Promise<void> {
  const snap = await getDoc(doc(db, `experiments/${expId}`));
  if (!snap.exists()) throw new Error('Experiment not found.');
  const e = snap.data() as ExperimentDoc;
  await submitToAssignment(classId, aId, user, {
    id: expId,
    displayName: e.displayName,
    thumbnailURL: e.thumbnailURL,
    duration: e.duration,
    recordingId: e.recordingId,
    sourceType: e.sourceType,
  });
}

export async function fetchMySubmission(classId: string, aId: string, uid: string): Promise<Submission | null> {
  const snap = await getDoc(doc(db, `classes/${classId}/assignments/${aId}/submissions/${uid}`));
  return snap.exists() ? (snap.data() as Submission) : null;
}

export async function unsubmit(classId: string, aId: string, uid: string): Promise<void> {
  await deleteDoc(doc(db, `classes/${classId}/assignments/${aId}/submissions/${uid}`));
}

// ---------------------------------------------------------------------------
// Grades (teacher-only write; student reads own)
// ---------------------------------------------------------------------------

export async function setGrade(
  classId: string,
  aId: string,
  studentUid: string,
  fields: { score: number | null; comment?: string },
): Promise<void> {
  await setDoc(doc(db, `classes/${classId}/assignments/${aId}/grades/${studentUid}`), {
    studentUid,
    score: fields.score,
    comment: fields.comment ?? '',
    gradedAt: serverTimestamp(),
  });
}

export async function fetchGrade(classId: string, aId: string, studentUid: string): Promise<Grade | null> {
  const snap = await getDoc(doc(db, `classes/${classId}/assignments/${aId}/grades/${studentUid}`));
  return snap.exists() ? (snap.data() as Grade) : null;
}

// ---------------------------------------------------------------------------
// Showcase (teacher-curated, class-wide)
// ---------------------------------------------------------------------------

export function subscribeShowcase(classId: string, cb: (items: ShowcaseItem[]) => void): () => void {
  return onSnapshot(
    collection(db, `classes/${classId}/showcase`),
    (snap) => {
      const list = snap.docs.map((d) => ({ ...(d.data() as ShowcaseItem), id: d.id }));
      // Pinned first, then newest.
      list.sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0),
      );
      cb(list);
    },
    onSnapError('showcase'),
  );
}

/** Teacher posts one of their own experiments as class material (client-side write). */
export async function postMaterialToShowcase(
  classId: string,
  user: User,
  experiment: Pick<Experiment, 'id' | 'displayName' | 'thumbnailURL'> & {
    recordingId?: string;
    sourceType?: Experiment['sourceType'];
    visibility?: Visibility;
  },
): Promise<string> {
  // Make sure members can open it: bump a private exp to unlisted (teacher owns it, so this is allowed).
  if (experiment.visibility === Visibility.Private) {
    await updateDoc(doc(db, `experiments/${experiment.id}`), { visibility: Visibility.Unlisted }).catch(() => {});
  }
  const ref = await addDoc(collection(db, `classes/${classId}/showcase`), {
    kind: 'material',
    ownerUid: user.id,
    ownerName: user.displayName ?? '',
    expId: experiment.id,
    recordingId: experiment.recordingId ?? null,
    sourceType: experiment.sourceType ?? null,
    title: experiment.displayName ?? '',
    thumbnailURL: experiment.thumbnailURL ?? '',
    sourceAssignmentId: null,
    pinned: false,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function setShowcasePinned(classId: string, itemId: string, pinned: boolean): Promise<void> {
  await updateDoc(doc(db, `classes/${classId}/showcase/${itemId}`), { pinned });
}

/** Teacher renames a showcase item (e.g. a teaching material). */
export async function renameShowcaseItem(classId: string, itemId: string, title: string): Promise<void> {
  await updateDoc(doc(db, `classes/${classId}/showcase/${itemId}`), { title });
}

export async function removeShowcaseItem(classId: string, itemId: string): Promise<void> {
  await deleteDoc(doc(db, `classes/${classId}/showcase/${itemId}`));
}

// ---------------------------------------------------------------------------
// Student workspace (private to the student) — copy materials in, edit, then submit
// ---------------------------------------------------------------------------

export function subscribeWorkspace(classId: string, uid: string, cb: (items: WorkspaceItem[]) => void): () => void {
  return onSnapshot(
    query(collection(db, `classes/${classId}/workspace`), where('studentUid', '==', uid)),
    (snap) => {
      const list = snap.docs.map((d) => ({ ...(d.data() as WorkspaceItem), id: d.id }));
      list.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
      cb(list);
    },
    onSnapError('workspace'),
  );
}

/** One-time fetch of the student's workspace items (newest first). */
export async function fetchWorkspace(classId: string, uid: string): Promise<WorkspaceItem[]> {
  const snap = await getDocs(query(collection(db, `classes/${classId}/workspace`), where('studentUid', '==', uid)));
  const list = snap.docs.map((d) => ({ ...(d.data() as WorkspaceItem), id: d.id }));
  list.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
  return list;
}

async function addWorkspaceRef(
  classId: string,
  user: User,
  expId: string,
  meta: {
    title: string;
    thumbnailURL: string;
    recordingId?: string | null;
    sourceType?: ExperimentType | null;
    sourceMaterialId?: string | null;
  },
): Promise<void> {
  await addDoc(collection(db, `classes/${classId}/workspace`), {
    studentUid: user.id,
    expId,
    title: meta.title ?? '',
    thumbnailURL: meta.thumbnailURL ?? '',
    recordingId: meta.recordingId ?? null,
    sourceType: meta.sourceType ?? null,
    sourceMaterialId: meta.sourceMaterialId ?? null,
    createdAt: serverTimestamp(),
  });
}

/** Bring one of the student's own existing experiments into the class workspace (reference only). */
export async function addExperimentToWorkspace(
  classId: string,
  user: User,
  experiment: Pick<Experiment, 'id' | 'displayName' | 'thumbnailURL'> & {
    recordingId?: string;
    sourceType?: Experiment['sourceType'];
  },
): Promise<void> {
  await addWorkspaceRef(classId, user, experiment.id, {
    title: experiment.displayName,
    thumbnailURL: experiment.thumbnailURL,
    recordingId: experiment.recordingId,
    sourceType: experiment.sourceType,
  });
}

/**
 * Copy a teacher's material into the student's workspace: clone the material's experiment into a
 * new, student-owned editable copy, then add a workspace reference. Returns the new experiment id.
 */
export async function copyMaterialToWorkspace(classId: string, user: User, material: ShowcaseItem): Promise<string> {
  const newExpId = await cloneExperimentById(material.expId, user, material.title);
  await addWorkspaceRef(classId, user, newExpId, {
    title: material.title,
    thumbnailURL: material.thumbnailURL,
    recordingId: material.recordingId,
    sourceType: material.sourceType,
    sourceMaterialId: material.id,
  });
  return newExpId;
}

/** Rename a workspace item: updates the denormalized card title and the underlying experiment. */
export async function renameWorkspaceItem(
  classId: string,
  itemId: string,
  expId: string,
  title: string,
): Promise<void> {
  await Promise.all([
    updateDoc(doc(db, `classes/${classId}/workspace/${itemId}`), { title }),
    renameExperiment(expId, title),
  ]);
}

/** Remove a workspace reference (the underlying experiment stays in My Experiments). */
export async function deleteWorkspaceItem(classId: string, itemId: string): Promise<void> {
  await deleteDoc(doc(db, `classes/${classId}/workspace/${itemId}`));
}
