/**
 * The fetch and cache of a camera-timed recording's frame index (utils/frameIndex.ts) — one download per
 * recording, shared by every consumer: the analyzer's player, the key-moment thumbnails, the digital
 * twin, the Experiments section's and the analyzer AI's reading of the take (labProjects/cloudTake.ts).
 *
 * A read that fails (offline, the object not there yet) resolves null and is NOT kept: it is tried
 * again, at most once every RETRY_AFTER_MS however many consumers ask (the player asks for every frame it
 * paints). Until one succeeds the consumers fall back to the take's mean rate (doc `fps`) for time and to
 * each frame's own coldest / warmest pixel for colour; when one does, a mounted `useFrameIndex` hears of
 * it and hands its component the index.
 */
import { useEffect, useState } from 'react';
import { getBytes, ref } from 'firebase/storage';
import { firebaseStorage } from '../services/firebase';
import { FRAME_INDEX_FILE, parseFrameIndexBytes, type FrameIndex } from './frameIndex';

/** How long a failed read stands before the next ask tries again. */
const RETRY_AFTER_MS = 30_000;

const inFlight = new Map<string, Promise<FrameIndex | null>>();
const loaded = new Map<string, FrameIndex>();
const failedAt = new Map<string, number>();
const listeners = new Set<(recordingId: string, index: FrameIndex) => void>();

/** The recording's frame index, fetched once; null when it could not be read (see the note above). */
export function loadFrameIndex(recordingId: string): Promise<FrameIndex | null> {
  const have = loaded.get(recordingId);
  if (have) return Promise.resolve(have);
  const pending = inFlight.get(recordingId);
  if (pending) return pending;
  const failed = failedAt.get(recordingId);
  if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return Promise.resolve(null);
  const p = getBytes(ref(firebaseStorage, `recordings/${recordingId}/${FRAME_INDEX_FILE}`))
    .then((bytes) => parseFrameIndexBytes(bytes))
    .catch(() => null)
    .then((index) => {
      if (index) {
        loaded.set(recordingId, index);
        failedAt.delete(recordingId);
        listeners.forEach((hear) => hear(recordingId, index));
      } else {
        failedAt.set(recordingId, Date.now());
      }
      return index;
    })
    .finally(() => inFlight.delete(recordingId));
  inFlight.set(recordingId, p);
  return p;
}

/** The index if it has already been read this session (no fetch): undefined when it has not. */
export const peekFrameIndex = (recordingId: string | undefined): FrameIndex | undefined =>
  recordingId ? loaded.get(recordingId) : undefined;

/**
 * The frame index of the recording a component is showing. `settled` turns true once the read has
 * finished either way (at once for a recording that is not camera-timed, which has none): a player waits
 * for it before its first paint so its clock does not change under the viewer. Should the first read
 * fail and a later one succeed, the index arrives then.
 */
export function useFrameIndex(
  recordingId: string | undefined,
  cameraTimed: boolean,
): { index: FrameIndex | null; settled: boolean } {
  const wanted = cameraTimed && recordingId ? recordingId : null;
  const [state, setState] = useState<{ id: string | null; index: FrameIndex | null; settled: boolean }>(() => ({
    id: wanted,
    index: wanted ? (loaded.get(wanted) ?? null) : null,
    settled: !wanted || loaded.has(wanted),
  }));
  useEffect(() => {
    if (!wanted) {
      setState({ id: null, index: null, settled: true });
      return;
    }
    const have = loaded.get(wanted);
    if (have) {
      setState({ id: wanted, index: have, settled: true });
      return;
    }
    let cancelled = false;
    setState({ id: wanted, index: null, settled: false });
    loadFrameIndex(wanted).then((index) => {
      if (!cancelled) setState({ id: wanted, index, settled: true });
    });
    // A later ask (the painter's, another consumer's) that succeeds where this one failed.
    const hear = (id: string, index: FrameIndex) => {
      if (!cancelled && id === wanted) setState({ id: wanted, index, settled: true });
    };
    listeners.add(hear);
    return () => {
      cancelled = true;
      listeners.delete(hear);
    };
  }, [wanted]);
  // A render between a change of recording and the effect above must not hand out the old one's index.
  return state.id === wanted ? { index: state.index, settled: state.settled } : { index: null, settled: !wanted };
}
