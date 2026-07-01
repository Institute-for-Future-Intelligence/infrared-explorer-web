import { httpsCallable } from 'firebase/functions';
import { collection, deleteDoc, doc, getDocs, query, where } from 'firebase/firestore';
import { firebaseFunctions, firebaseDatabase } from './firebase';
import { KeyframeCard, KeyframeRequest, QaModel, Thermometer, Visibility } from '../types';

/**
 * Generate a physics-grounded lab-report DRAFT for an experiment via the generateLabReport callable.
 * The function reads the experiment's real thermal data server-side (the Claude key never reaches the
 * client) and returns Markdown text the caller pre-fills into the editable description box. Currently
 * supports recording-based experiments; throws (failed-precondition) for video showcases.
 */
export async function generateLabReport(expId: string): Promise<string> {
  const fn = httpsCallable<{ expId: string }, { report: string }>(firebaseFunctions, 'generateLabReport');
  const res = await fn({ expId });
  return res.data.report;
}

/**
 * Generate per-moment AI "cards" for student-curated key frames via the generateKeyframeNotes callable.
 * One call analyzes the whole batch (each moment vs the previous one) server-side and persists a card
 * per moment to experiments/{expId}/keyframes. Each `keyframes` entry must carry a non-empty `reason`
 * (the server rejects moments without one). Recording-based experiments only; owner + staff gated.
 */
export async function generateKeyframeNotes(expId: string, keyframes: KeyframeRequest[]): Promise<KeyframeCard[]> {
  const fn = httpsCallable<{ expId: string; keyframes: KeyframeRequest[] }, { cards: KeyframeCard[] }>(
    firebaseFunctions,
    'generateKeyframeNotes',
  );
  const res = await fn({ expId, keyframes });
  return res.data.cards;
}

/**
 * Answer a free-form question about an experiment via the answerExperimentQuestion streaming callable.
 * The function grounds the model on the real thermal data server-side (whole-clip summary + existing
 * report + each attached moment's frame/readings) and streams a Markdown answer back token by token:
 * `onText` is called with the full accumulated text on every delta so the UI can render as it grows.
 * Resolves with the final answer. `moments` are optional (time-agnostic by default), in recording-frame
 * space, capped at 3 server-side. `model` selects Sonnet/Opus. Owner + staff gated, recording-based
 * experiments only. Nothing is persisted (session-only thread).
 */
export async function answerExperimentQuestionStream(
  expId: string,
  question: string,
  moments: { recordingIndex: number; tSeconds: number }[],
  model: QaModel,
  onText: (fullText: string) => void,
): Promise<string> {
  const fn = httpsCallable<
    { expId: string; question: string; moments: { recordingIndex: number; tSeconds: number }[]; model: QaModel },
    { answer: string },
    { text: string }
  >(firebaseFunctions, 'answerExperimentQuestion');
  const { stream, data } = await fn.stream({ expId, question, moments, model });
  let acc = '';
  for await (const chunk of stream) {
    if (chunk?.text) {
      acc += chunk.text;
      onText(acc);
    }
  }
  const final = await data;
  return final?.answer ?? acc;
}

/** A persisted Q&A turn from experiments/{expId}/qaTurns (private to the asker). Moments carry only
 *  recordingIndex + tSeconds — the thumbnail isn't stored (rebuilt as a labelled chip on load). */
export interface StoredQaTurn {
  question: string;
  answer: string;
  model: QaModel;
  moments: { recordingIndex: number; tSeconds: number }[];
  createdAt: number;
}

/**
 * Load the caller's own saved Q&A turns for an experiment, oldest first. "Rules are not filters": the
 * qaTurns read rule is userId-scoped, so the query MUST filter userId == the viewer (mirrors
 * loadKeyframeCards). Sorted client-side to avoid a composite where+orderBy index.
 */
export async function loadQaTurns(expId: string, userId: string): Promise<StoredQaTurn[]> {
  const coll = collection(firebaseDatabase, `experiments/${expId}/qaTurns`);
  const snap = await getDocs(query(coll, where('userId', '==', userId)));
  const turns: StoredQaTurn[] = [];
  snap.forEach((d) => {
    const data = d.data();
    const moments = Array.isArray(data.moments) ? data.moments : [];
    turns.push({
      question: data.question ?? '',
      answer: data.answer ?? '',
      model: data.model === 'opus' ? 'opus' : 'sonnet',
      moments: moments.map((m: { recordingIndex?: number; tSeconds?: number }) => ({
        recordingIndex: Number(m.recordingIndex),
        tSeconds: Number(m.tSeconds),
      })),
      createdAt: (data.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0,
    });
  });
  return turns.sort((a, b) => a.createdAt - b.createdAt);
}

/** Delete all of the caller's saved Q&A turns for an experiment (the rules allow deleting own turns). */
export async function clearQaTurns(expId: string, userId: string): Promise<void> {
  const coll = collection(firebaseDatabase, `experiments/${expId}/qaTurns`);
  const snap = await getDocs(query(coll, where('userId', '==', userId)));
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
}

/**
 * Load the saved AI key-frame cards for an experiment, sorted chronologically (by recordingIndex).
 * "Rules are not filters": the keyframes read rule depends on per-doc visibility/ownerId, so the list
 * query must be constrained to match it (own docs, or public/unlisted) — mirroring fetchThermometers.
 */
export async function loadKeyframeCards(
  expId: string,
  ownerId: string | undefined,
  viewerId: string | undefined,
): Promise<KeyframeCard[]> {
  const coll = collection(firebaseDatabase, `experiments/${expId}/keyframes`);
  const q =
    viewerId && viewerId === ownerId
      ? query(coll, where('ownerId', '==', viewerId))
      : query(coll, where('visibility', 'in', [Visibility.Public, Visibility.Unlisted]));
  const snap = await getDocs(q);
  const cards: KeyframeCard[] = [];
  snap.forEach((d) => {
    const data = d.data();
    cards.push({
      recordingIndex: data.recordingIndex,
      tSeconds: data.tSeconds,
      reason: data.reason ?? '',
      reasonVerdict: data.reasonVerdict,
      whatChanged: data.whatChanged ?? '',
      mechanism: data.mechanism ?? '',
      oneNumber: data.oneNumber ?? '',
      thermoSig: data.thermoSig ?? '',
    });
  });
  return cards.sort((a, b) => a.recordingIndex - b.recordingIndex);
}

/** Owner-only delete of one saved card (the security rules allow the owner to delete; clients can't write). */
export async function deleteKeyframeCard(expId: string, recordingIndex: number): Promise<void> {
  await deleteDoc(doc(firebaseDatabase, `experiments/${expId}/keyframes/${recordingIndex}`));
}

/**
 * Signature of probe geometry, used to flag a card as stale once a thermometer is moved.
 * MUST stay byte-identical to the server's thermoSig in functions/src/index.ts generateKeyframeNotes:
 *   thermometers sorted by id; each "id:x4:y4:type:w:h"; joined by '|'. Excludes per-frame `value`.
 */
export function keyframeThermoSig(thermometers: Thermometer[]): string {
  return thermometers
    .map(
      (t) =>
        `${t.id}:${(t.x ?? 0).toFixed(4)}:${(t.y ?? 0).toFixed(4)}:${t.measuringAreaType ?? 'point'}:${
          t.measuringAreaWidth ?? ''
        }:${t.measuringAreaHeight ?? ''}`,
    )
    .sort()
    .join('|');
}
