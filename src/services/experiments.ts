import { addDoc, collection, deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { firebaseDatabase } from './firebase';
import { Experiment, ExperimentType, Segment, TemperatureUnit, User, Visibility } from '../types';
import useCommonStore from '../stores/common';

/** Move an experiment to / out of the trash (owner-only; trash is a flag, not a separate collection). */
export async function setTrash(expId: string, trash: boolean): Promise<void> {
  await updateDoc(doc(firebaseDatabase, `experiments/${expId}`), { trash, updatedAt: serverTimestamp() });
}

/** Edit a comment's text (owner-only under the rules: senderId == mongoId). */
export async function updateComment(expId: string, commentId: string, content: string): Promise<void> {
  await updateDoc(doc(firebaseDatabase, `experiments/${expId}/comments/${commentId}`), { content });
}

/** Delete a comment (owner-only). A Function cascades to its replies. */
export async function deleteComment(expId: string, commentId: string): Promise<void> {
  await deleteDoc(doc(firebaseDatabase, `experiments/${expId}/comments/${commentId}`));
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
    visibility: Visibility.Private,
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
          visibility: Visibility.Private,
        });
      }
    }
  }

  return ref.id;
}
