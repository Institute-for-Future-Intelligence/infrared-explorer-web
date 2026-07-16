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
  Annotation,
  Experiment,
  ExperimentDoc,
  ExperimentSubjects,
  ExperimentType,
  Segment,
  StoredKeyMoment,
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

/** Set an experiment's subject — the single predefined, filterable label (owner-only). */
export async function updateSubject(expId: string, subject: ExperimentSubjects | null): Promise<void> {
  await updateDoc(doc(firebaseDatabase, `experiments/${expId}`), { subject, updatedAt: serverTimestamp() });
}

/**
 * Persist the owner's key-moment chapters (owner-only; rules allow arbitrary owner field writes). Stores
 * only { recordingIndex, tSeconds, label } — never the in-memory thumbnail (a full-frame data URL, which
 * would balloon the doc). A blank label is dropped so no `undefined` reaches Firestore.
 */
export async function saveKeyMoments(expId: string, keyMoments: StoredKeyMoment[]): Promise<void> {
  const clean = keyMoments.map((m) => {
    const stored: StoredKeyMoment = { recordingIndex: m.recordingIndex, tSeconds: m.tSeconds };
    if (m.label && m.label.trim()) stored.label = m.label.trim();
    return stored;
  });
  await updateDoc(doc(firebaseDatabase, `experiments/${expId}`), { keyMoments: clean, updatedAt: serverTimestamp() });
}

/**
 * Change an experiment's visibility (owner-only). Thermometer/annotation sub-docs carry a
 * redundant `visibility` field (list rules cannot get() the parent), so they are updated in the
 * same pass — otherwise a newly public experiment's thermometers would stay unreadable to
 * viewers, whose load query filters `visibility in [public, unlisted]`. Rules are not filters:
 * even the owner's sub-doc list reads must be constrained (`ownerId == me`) to be provable,
 * matching the owner branch of the analyzer's loads. The parent doc is written LAST — it is the
 * access gate, so a sub-doc failure can't leave the experiment re-tiered while the UI reports
 * failure.
 */
export async function updateVisibility(expId: string, user: User, visibility: Visibility): Promise<void> {
  const [thermometers, annotations] = await Promise.all([
    getDocs(query(collection(firebaseDatabase, `experiments/${expId}/thermometers`), where('ownerId', '==', user.id))),
    getDocs(query(collection(firebaseDatabase, `experiments/${expId}/annotations`), where('ownerId', '==', user.id))),
  ]);
  await Promise.all([...thermometers.docs, ...annotations.docs].map((d) => updateDoc(d.ref, { visibility })));
  await updateDoc(doc(firebaseDatabase, `experiments/${expId}`), { visibility, updatedAt: serverTimestamp() });
}

/**
 * Feature (or un-feature) an experiment on the site homepage. Staff-only, and only on the
 * caller's OWN experiments — the Firestore rules enforce both (a non-staff/non-owner write is
 * rejected). The homepage query is `featured == true && visibility == 'public'`, so featuring
 * requires the experiment to be public: if it isn't yet, promote it first (via updateVisibility,
 * which also mirrors the sub-doc visibility) so the rule's "featured ⇒ public" check passes and
 * viewers can actually read it. Un-featuring leaves visibility untouched. Returns whether the
 * experiment was promoted to public as a side effect, so the UI can say so.
 */
export async function setFeatured(
  expId: string,
  user: User,
  featured: boolean,
  currentVisibility?: Visibility,
): Promise<{ promotedToPublic: boolean }> {
  let promotedToPublic = false;
  if (featured && currentVisibility !== Visibility.Public) {
    await updateVisibility(expId, user, Visibility.Public);
    promotedToPublic = true;
  }
  await updateDoc(doc(firebaseDatabase, `experiments/${expId}`), { featured, updatedAt: serverTimestamp() });
  return { promotedToPublic };
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
  options: { markCustomThermometers?: boolean } = {},
): Promise<void> {
  const expFields: Record<string, unknown> = { graphsOptions, updatedAt: serverTimestamp() };
  // Video sources re-derive their thermometers from the .wrk preset on load unless the doc is flagged
  // `customThermometers`; once the owner saves an edited set into the subcollection we set the flag so
  // load reads the subcollection instead (mirrors cloneExperimentById's videoHasCustomThermometers).
  // Recordings always read the subcollection, so the flag is a harmless no-op for them.
  if (options.markCustomThermometers) expFields.customThermometers = true;
  await updateDoc(doc(firebaseDatabase, `experiments/${expId}`), expFields);
  await Promise.all([
    ...thermometers.map((t) =>
      setDoc(doc(firebaseDatabase, `experiments/${expId}/thermometers/${t.id}`), {
        id: t.id,
        name: t.name ?? null,
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
  // createdAt/updatedAt are server-set Timestamps that live on the doc and ride along when the
  // analyzer spreads ExperimentDoc into the runtime Experiment — read them via the doc shape.
  const docFields = experiment as unknown as ExperimentDoc;
  await setDoc(doc(firebaseDatabase, `users/${user.id}/history/${experiment.id}`), {
    viewedAt: serverTimestamp(),
    displayName: experiment.displayName,
    thumbnailURL: experiment.thumbnailURL ?? '',
    subject: experiment.subject ?? null,
    author: experiment.author ?? '',
    // Lets the Recent page link the author line to the owner's profile. Snapshots written
    // before this field existed simply render an unlinked author until the next view.
    ownerId: experiment.ownerId ?? null,
    description: experiment.description ?? '',
    duration: experiment.duration ?? null,
    createdAt: docFields.createdAt ?? null,
    updatedAt: docFields.updatedAt ?? null,
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
 * Copy an experiment's annotations into a freshly cloned copy. Unlike thermometers — which only
 * recording-sourced experiments keep in a subcollection — annotations live in a subcollection for
 * EVERY source type, so this runs for any clone. Reads only the publicly readable (public/unlisted)
 * source notes, matching the annotations' read rule so cloning someone else's experiment isn't
 * permission-denied, then re-owns each note to the new owner as unlisted (mirroring the copy's
 * visibility) under the same doc id.
 */
async function copyAnnotations(sourceExpId: string, newExpId: string, user: User): Promise<void> {
  const annos = await getDocs(
    query(
      collection(firebaseDatabase, `experiments/${sourceExpId}/annotations`),
      where('visibility', 'in', [Visibility.Public, Visibility.Unlisted]),
    ),
  ).catch(() => null);
  if (!annos) return;
  await Promise.all(
    annos.docs.map((d) => {
      const a = d.data();
      return setDoc(doc(firebaseDatabase, `experiments/${newExpId}/annotations/${d.id}`), {
        ...a,
        ownerId: user.id,
        visibility: Visibility.Unlisted,
      });
    }),
  );
}

/**
 * Live (in-analyzer) edits to copy into a clone instead of re-reading the Firestore source —
 * so the viewer's local sandbox changes (moved / added / deleted thermometers, edited notes) are
 * preserved. Omitted (classroom copies made outside the analyzer) → fall back to the source copy.
 */
export interface CloneLiveState {
  thermometers?: Thermometer[];
  annotations?: Annotation[];
}

/** Persist live thermometer placements to a clone — the same whitelist as saveAnalysis (the
 *  frame-dependent `value` is intentionally not stored). */
async function writeThermometers(newExpId: string, thermometers: Thermometer[], user: User): Promise<void> {
  await Promise.all(
    thermometers.map((t) =>
      setDoc(doc(firebaseDatabase, `experiments/${newExpId}/thermometers/${t.id}`), {
        id: t.id,
        x: t.x,
        y: t.y,
        unit: t.unit,
        measuringAreaType: t.measuringAreaType ?? null,
        measuringAreaWidth: t.measuringAreaWidth ?? null,
        measuringAreaHeight: t.measuringAreaHeight ?? null,
        ownerId: user.id,
        visibility: Visibility.Unlisted,
      }),
    ),
  );
}

/** Persist live annotations to a clone, re-owned and unlisted under the same doc id. Omits any
 *  undefined optional field (Firestore rejects undefined values). */
async function writeAnnotations(newExpId: string, annotations: Annotation[], user: User): Promise<void> {
  await Promise.all(
    annotations.map((a) => {
      const data: Record<string, unknown> = {
        x: a.x,
        y: a.y,
        note: a.note,
        ownerId: user.id,
        visibility: Visibility.Unlisted,
      };
      if (a.dx !== undefined) data.dx = a.dx;
      if (a.dy !== undefined) data.dy = a.dy;
      if (a.time !== undefined) data.time = a.time;
      return setDoc(doc(firebaseDatabase, `experiments/${newExpId}/annotations/${a.id}`), data);
    }),
  );
}

/**
 * Clone an experiment into a new unlisted, user-owned doc given only the source id — fetching
 * the source doc straight from Firestore. References only — no thermal binary is duplicated.
 * `live` carries the analyzer's in-memory thermometers/annotations so a "Save to My Experiments"
 * keeps the viewer's local edits; without it (the classroom workspace copying a teacher's material)
 * thermometers and annotations are copied from the Firestore source instead.
 */
export async function cloneExperimentById(
  sourceExpId: string,
  user: User,
  title?: string,
  live?: CloneLiveState,
): Promise<string> {
  const srcSnap = await getDoc(doc(firebaseDatabase, `experiments/${sourceExpId}`));
  if (!srcSnap.exists()) throw new Error('Source experiment not found.');
  const src = srcSnap.data() as ExperimentDoc;

  const segments = src.segments?.length ? src.segments : null;
  const sourceType = src.sourceType ?? ExperimentType.Recording;
  // A video clone keeps its thermometers in the subcollection — and is flagged so load reads them
  // instead of re-deriving the defaults from the .wrk preset — whenever the analyzer hands over its
  // live placements (snapshotting the viewer's edits, even an empty set if they deleted them all),
  // or the source video was itself already saved with custom thermometers.
  const videoHasCustomThermometers =
    sourceType === ExperimentType.Video && (live?.thermometers !== undefined || src.customThermometers === true);
  const data: Record<string, unknown> = {
    sourceType,
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
    // Provenance marker: this doc is a copy, so it must NOT count as an original recording on the
    // Raw Data page (which filters on sourceType + absence of clonedFrom, not on isRaw alone).
    clonedFrom: sourceExpId,
    ratingSum: 0,
    ratingCount: 0,
    viewCount: 0,
    commentCount: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (src.name) data.name = src.name;
  if (src.recordingId) data.recordingId = src.recordingId;
  if (videoHasCustomThermometers) data.customThermometers = true;
  // Carry the owner's chapters. recordingIndex is recording-frame space, so a full copy keeps them valid;
  // out-of-range ones (after a re-trim) are just hidden by the strip's reachability filter.
  if (src.keyMoments?.length) data.keyMoments = src.keyMoments;

  const ref = await addDoc(collection(firebaseDatabase, 'experiments'), data);

  // Thermometers: recording sources always keep them in a subcollection; video sources keep them
  // only when flagged above (else they re-derive from the .wrk preset on load). Either way, take the
  // analyzer's live placements (local edits included) when provided, else copy the source's readable
  // subcollection placements.
  if (sourceType === ExperimentType.Recording || videoHasCustomThermometers) {
    if (live?.thermometers) {
      await writeThermometers(ref.id, live.thermometers, user);
    } else {
      const therms = await getDocs(
        query(
          collection(firebaseDatabase, `experiments/${sourceExpId}/thermometers`),
          where('visibility', 'in', [Visibility.Public, Visibility.Unlisted]),
        ),
      ).catch(() => null);
      if (therms) {
        await Promise.all(
          therms.docs.map((d) =>
            setDoc(doc(firebaseDatabase, `experiments/${ref.id}/thermometers/${d.id}`), {
              ...d.data(),
              ownerId: user.id,
              visibility: Visibility.Unlisted,
            }),
          ),
        );
      }
    }
  }

  // Annotations belong to every source type: take the analyzer's live notes (local edits included)
  // when provided, else copy the source's readable notes.
  if (live?.annotations) {
    await writeAnnotations(ref.id, live.annotations, user);
  } else {
    await copyAnnotations(sourceExpId, ref.id, user);
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
    // Provenance marker: this doc is a copy/clip, so it must NOT count as an original recording on
    // the Raw Data page (which filters on sourceType + absence of clonedFrom, not on isRaw alone).
    clonedFrom: source.id,
    ratingSum: 0,
    ratingCount: 0,
    viewCount: 0,
    commentCount: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (source.name) data.name = source.name;
  if (source.recordingId) data.recordingId = source.recordingId;
  // Carry the owner's chapters (recording-frame space). A trimmed clip may drop some of them out of
  // range, but the strip's reachability filter hides those rather than seeking to the wrong frame.
  if (source.keyMoments?.length) data.keyMoments = source.keyMoments;

  const ref = await addDoc(collection(firebaseDatabase, 'experiments'), data);

  // Recording-sourced experiments keep thermometers in a subcollection; copy the live placements
  // from the analyzer store (local edits included). Video experiments derive thermometers from the
  // .wrk preset on load, so there is nothing to copy.
  if (source.sourceType === ExperimentType.Recording) {
    const thermometerMap = useCommonStore.getState().thermometerMap;
    const thermometers = (source.thermometersId ?? [])
      .map((tid) => thermometerMap.get(tid))
      .filter((t): t is Thermometer => !!t);
    await writeThermometers(ref.id, thermometers, user);
  }

  // Annotations belong to every source type: use the analyzer's live notes (local edits included),
  // falling back to the source's readable notes if none were mirrored.
  const liveAnnotations = useCommonStore.getState().analyzerAnnotations.get(source.id);
  if (liveAnnotations) {
    await writeAnnotations(ref.id, liveAnnotations, user);
  } else {
    await copyAnnotations(source.id, ref.id, user);
  }

  return ref.id;
}
