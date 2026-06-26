import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { firebaseDatabase } from './firebase';
import {
  Experiment,
  ExperimentDoc,
  ExperimentType,
  Segment,
  TemperatureUnit,
  Thermometer,
  User,
  Visibility,
} from '../types';
import useCommonStore from '../stores/common';

/** Move an experiment to / out of the trash (owner-only; trash is a flag, not a separate collection). */
export async function setTrash(expId: string, trash: boolean): Promise<void> {
  await updateDoc(doc(firebaseDatabase, `experiments/${expId}`), { trash, updatedAt: serverTimestamp() });
}

/** Rename an experiment's title (owner-only; rules permit changing displayName). */
export async function renameExperiment(expId: string, displayName: string): Promise<void> {
  await updateDoc(doc(firebaseDatabase, `experiments/${expId}`), { displayName, updatedAt: serverTimestamp() });
}

/** Edit an experiment's description (owner-only; rules permit changing description). */
export async function updateDescription(expId: string, description: string): Promise<void> {
  await updateDoc(doc(firebaseDatabase, `experiments/${expId}`), { description, updatedAt: serverTimestamp() });
}

/** Edit a comment's text (owner-only under the rules: senderId == mongoId). */
export async function updateComment(expId: string, commentId: string, content: string): Promise<void> {
  await updateDoc(doc(firebaseDatabase, `experiments/${expId}/comments/${commentId}`), { content });
}

/** Delete a comment (owner-only). A Function cascades to its replies. */
export async function deleteComment(expId: string, commentId: string): Promise<void> {
  await deleteDoc(doc(firebaseDatabase, `experiments/${expId}/comments/${commentId}`));
}

/** Add an image annotation (owner-only). visibility mirrors the experiment so viewers can read it. */
export async function addAnnotation(
  expId: string,
  user: User,
  annotation: { x: number; y: number; dx?: number; dy?: number; note: string; time?: { start: number; end: number } },
  visibility: Visibility = Visibility.Unlisted,
): Promise<string> {
  const ref = await addDoc(collection(firebaseDatabase, `experiments/${expId}/annotations`), {
    ...annotation,
    ownerId: user.id,
    visibility,
  });
  return ref.id;
}

/** Edit an annotation's note text, position, offset or time window (owner-only). */
export async function updateAnnotation(
  expId: string,
  annotationId: string,
  fields: Partial<{ x: number; y: number; dx: number; dy: number; note: string; time: { start: number; end: number } }>,
): Promise<void> {
  await updateDoc(doc(firebaseDatabase, `experiments/${expId}/annotations/${annotationId}`), fields);
}

/** Delete an annotation (owner-only). */
export async function deleteAnnotation(expId: string, annotationId: string): Promise<void> {
  await deleteDoc(doc(firebaseDatabase, `experiments/${expId}/annotations/${annotationId}`));
}

/**
 * Persist the current analysis (graph options + thermometer positions/areas) for an owned,
 * recording-sourced experiment. Thermometers are stored in the subcollection that the analyzer
 * reads on load; the frame-dependent `value` is intentionally not persisted. Thermometers removed
 * in-memory are passed in `deletedThermometerIds` so their subcollection docs are reconciled away —
 * otherwise a deleted thermometer would reappear on the next load.
 */
export async function saveAnalysis(
  expId: string,
  user: User,
  thermometers: Thermometer[],
  graphsOptions: number[],
  visibility: Visibility = Visibility.Unlisted,
  deletedThermometerIds: string[] = [],
): Promise<void> {
  await updateDoc(doc(firebaseDatabase, `experiments/${expId}`), { graphsOptions, updatedAt: serverTimestamp() });
  await Promise.all([
    ...thermometers.map((t) =>
      setDoc(doc(firebaseDatabase, `experiments/${expId}/thermometers/${t.id}`), {
        id: t.id,
        x: t.x,
        y: t.y,
        unit: t.unit,
        measuringAreaType: t.measuringAreaType ?? null,
        measuringAreaWidth: t.measuringAreaWidth ?? null,
        measuringAreaHeight: t.measuringAreaHeight ?? null,
        ownerId: user.id,
        visibility,
      }),
    ),
    ...deletedThermometerIds.map((id) => deleteDoc(doc(firebaseDatabase, `experiments/${expId}/thermometers/${id}`))),
  ]);
}

/**
 * Record that the user viewed an experiment, into users/{uid}/history/{expId} (doc id == expId,
 * so re-viewing dedupes and bumps viewedAt). A denormalized snapshot lets the Recent page render
 * without re-reading each experiment.
 */
export async function recordHistory(user: User, experiment: Experiment): Promise<void> {
  await setDoc(doc(firebaseDatabase, `users/${user.id}/history/${experiment.id}`), {
    viewedAt: serverTimestamp(),
    displayName: experiment.displayName,
    thumbnailURL: experiment.thumbnailURL ?? '',
    sourceType: experiment.sourceType ?? null,
    recordingId: experiment.recordingId ?? null,
  });
}

/**
 * Permanently delete an experiment doc (owner-only). Note: Firestore does not cascade to
 * subcollections — thermometers/comments/ratings are orphaned. A recursive-delete Function
 * is the proper cleanup; tracked for a later phase.
 */
export async function deleteExperiment(expId: string): Promise<void> {
  await deleteDoc(doc(firebaseDatabase, `experiments/${expId}`));
}

/**
 * Clone an experiment into a new unlisted, user-owned doc given only the source id — fetching
 * the source doc and its thermometers straight from Firestore (no reliance on the analyzer's
 * in-memory thermometer store). Used by the classroom workspace to copy a teacher's material
 * into the student's own experiments. References only — no thermal binary is duplicated.
 */
export async function cloneExperimentById(sourceExpId: string, user: User, title?: string): Promise<string> {
  const srcSnap = await getDoc(doc(firebaseDatabase, `experiments/${sourceExpId}`));
  if (!srcSnap.exists()) throw new Error('Source experiment not found.');
  const src = srcSnap.data() as ExperimentDoc;

  const segments = src.segments?.length ? src.segments : null;
  const data: Record<string, unknown> = {
    sourceType: src.sourceType ?? ExperimentType.Recording,
    ownerId: user.id,
    visibility: Visibility.Unlisted,
    displayName: title?.trim() || `Copy of ${src.displayName ?? ''}`,
    author: user.displayName ?? src.author ?? '',
    description: src.description ?? '',
    subject: src.subject ?? null,
    duration: src.duration ?? 0,
    date: new Date().toLocaleString(),
    thumbnailURL: src.thumbnailURL ?? '',
    graphsOptions: src.graphsOptions ?? [],
    thermalUnit: src.thermalUnit ?? TemperatureUnit.celsius,
    trash: false,
    isRaw: !segments,
    segments,
    ratingSum: 0,
    ratingCount: 0,
    viewCount: 0,
    commentCount: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (src.name) data.name = src.name;
  if (src.recordingId) data.recordingId = src.recordingId;

  const ref = await addDoc(collection(firebaseDatabase, 'experiments'), data);

  // Recording-sourced: copy the readable thermometer placements from the source subcollection.
  if (src.sourceType === ExperimentType.Recording) {
    const therms = await getDocs(
      query(
        collection(firebaseDatabase, `experiments/${sourceExpId}/thermometers`),
        where('visibility', 'in', [Visibility.Public, Visibility.Unlisted]),
      ),
    ).catch(() => null);
    if (therms) {
      await Promise.all(
        therms.docs.map((d) => {
          const t = d.data();
          return setDoc(doc(firebaseDatabase, `experiments/${ref.id}/thermometers/${d.id}`), {
            ...t,
            ownerId: user.id,
            visibility: Visibility.Unlisted,
          });
        }),
      );
    }
  }

  return ref.id;
}

/**
 * Clone an experiment into a new private, user-owned doc. References only — no thermal binary
 * is copied; `name`/`recordingId`/`segments` point at the same Storage objects as the source.
 * Returns the new experiment id. See docs/telelab-migration.md §4 (clone = refs only).
 */
export async function cloneExperiment(
  source: Experiment,
  user: User,
  segmentsOverride?: Segment[],
  title?: string,
): Promise<string> {
  // A trimmed clip carries the new segments and is no longer "raw"; a plain copy keeps the source's.
  const segments = segmentsOverride?.length ? segmentsOverride : source.segments?.length ? source.segments : null;
  const data: Record<string, unknown> = {
    sourceType: source.sourceType ?? ExperimentType.Video,
    ownerId: user.id,
    // Clips default to unlisted so their shared links open for logged-out viewers. The
    // visibility field + Firestore rules stay in place for a future per-clip privacy toggle.
    visibility: Visibility.Unlisted,
    displayName:
      title?.trim() || (segmentsOverride?.length ? `Clip of ${source.displayName}` : `Copy of ${source.displayName}`),
    author: user.displayName ?? source.author ?? '',
    description: source.description ?? '',
    subject: source.subject ?? null,
    duration: source.duration ?? 0,
    date: new Date().toLocaleString(),
    thumbnailURL: source.thumbnailURL ?? '',
    graphsOptions: source.graphsOptions ?? [],
    thermalUnit: source.thermalUnit ?? TemperatureUnit.celsius,
    trash: false,
    isRaw: !segments,
    segments,
    ratingSum: 0,
    ratingCount: 0,
    viewCount: 0,
    commentCount: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (source.name) data.name = source.name;
  if (source.recordingId) data.recordingId = source.recordingId;

  const ref = await addDoc(collection(firebaseDatabase, 'experiments'), data);

  // Recording-sourced experiments keep thermometers in a subcollection; copy the placements.
  // Video experiments derive thermometers from the .wrk preset, so there is nothing to copy.
  if (source.sourceType === ExperimentType.Recording) {
    const thermometerMap = useCommonStore.getState().thermometerMap;
    for (const tid of source.thermometersId ?? []) {
      const t = thermometerMap.get(tid);
      if (t) {
        await setDoc(doc(firebaseDatabase, `experiments/${ref.id}/thermometers/${tid}`), {
          ...t,
          ownerId: user.id,
          // Mirror the clip's visibility (unlisted) so viewers can read the copied placements.
          visibility: Visibility.Unlisted,
        });
      }
    }
  }

  return ref.id;
}
