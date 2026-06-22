import { addDoc, collection, deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { firebaseDatabase } from './firebase';
import { Experiment, ExperimentType, TemperatureUnit, User, Visibility } from '../types';
import useCommonStore from '../stores/common';

/** Move an experiment to / out of the trash (owner-only; trash is a flag, not a separate collection). */
export async function setTrash(expId: string, trash: boolean): Promise<void> {
  await updateDoc(doc(firebaseDatabase, `experiments/${expId}`), { trash, updatedAt: serverTimestamp() });
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
export async function cloneExperiment(source: Experiment, user: User): Promise<string> {
  const data: Record<string, unknown> = {
    sourceType: source.sourceType ?? ExperimentType.Video,
    ownerId: user.id,
    visibility: Visibility.Private,
    displayName: `Copy of ${source.displayName}`,
    author: user.displayName ?? source.author ?? '',
    description: source.description ?? '',
    subject: source.subject ?? null,
    duration: source.duration ?? 0,
    date: new Date().toLocaleString(),
    thumbnailURL: source.thumbnailURL ?? '',
    graphsOptions: source.graphsOptions ?? [],
    thermalUnit: source.thermalUnit ?? TemperatureUnit.celsius,
    trash: false,
    isRaw: source.isRaw ?? !source.segments?.length,
    segments: source.segments?.length ? source.segments : null,
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
