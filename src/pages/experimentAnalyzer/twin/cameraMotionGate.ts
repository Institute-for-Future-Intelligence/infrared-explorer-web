/**
 * Did the camera stand still? The check a recording's twin build runs before the agent starts
 * (docs/digital-twin-plan.md §39, §44.3, §44.11): the motion gate over the clip's thermal frames, the
 * visible photos of the frames that drifted past the limit (was it the camera, or the only thing in the
 * picture?), and, when the camera holds still, the photos of a few frames against the stillest one's
 * (utils/twinCameraMotion). A camera that moved — around the subject, or just drifting — gets no twin:
 * the agent builds through one camera that every frame of the recording goes through, so the recording
 * must have been made with one. The frames whose picture differs from the stillest frame's (something
 * being carried in, a hand, an empty bench before the experiment) are reported as such, for the agent.
 *
 * The frames are read from Storage here; the arithmetic is utils/twinStability and
 * utils/twinCameraMotion. `onProgress` gets one line at a time for the form; `signal` is the owner's Stop.
 */
import { getBlob, ref } from 'firebase/storage';
import type { Experiment, FrameRange } from '../../../types';
import { firebaseStorage } from '../../../services/firebase';
import { fetchRecordingFrameBufferCached } from '../../../utils/recordingFrame';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from '../../../utils/constants';
import { lastFrameIndexOf } from '../../../utils/frameTime';
import {
  STABLE_MAX_SHIFT_PX,
  assessStability,
  changedFrameRanges,
  changedSampleIndices,
  excuseStability,
  stabilitySampleIndices,
} from '../../../utils/twinStability';
import {
  type VisibleMotion,
  assessVisibleMotion,
  cameraMotionKind,
  neighbourIndex,
  objectMotionFrames,
  visibleCheckIndices,
} from '../../../utils/twinCameraMotion';
import { grayFromRgba } from '../../../../functions/src/twinRegistration';
import { visibleLuma } from '../../../../functions/src/twinOrbit';

/** Parallel Storage reads while sampling frames. */
const FETCH_POOL = 4;
/** A frame's visible photo is drawn this wide before the motion check takes its luma — the width the
 *  server measures it at (TWIN_ORBIT_SHARPNESS_WIDTH in functions/src/index.ts). */
const VISIBLE_CHECK_WIDTH = 240;

/** What the check found, as the agent's first message and the twin record tell it (plan §44.3). */
export interface CameraMotion {
  kind: 'fixed' | 'moved';
  /** How far the picture drifts from the stillest frame, thermal pixels — the camera's own drift, once
   *  the frames where something in the picture moved have been set aside. */
  maxShiftPx: number;
  /** The stillest frame (1-based). */
  referenceIndex: number;
  /** When the photos had a say: how many were compared with the stillest frame's, how many showed
   *  another standpoint. */
  photosCompared?: number;
  photosMoved?: number;
  /** Where the recording shows a different scene from the stillest frame (§44.11): things being placed,
   *  moved or taken away, or the bench before anything was on it. Empty when every sampled frame
   *  matches. */
  changedFrames: FrameRange[];
  /** How many sampled frames drifted in the thermal picture but not in the photo — something moved in
   *  front of a still camera. */
  objectFrames: number;
}

/** Why a camera that moved gets no twin, for the owner. */
export function cameraMovedMessage(m: CameraMotion): string {
  const walked = m.photosCompared !== undefined && m.photosMoved !== undefined && m.photosMoved > 0;
  const how = walked
    ? `${m.photosMoved} of the ${m.photosCompared} photos compared show the subject from another standpoint`
    : `the picture drifts ${m.maxShiftPx} px from the stillest frame, more than the ${STABLE_MAX_SHIFT_PX} px (about 4° of pan) a still camera is allowed`;
  return `The camera moved (${how}). A digital twin is built through one camera that every frame of the recording goes through, so the camera has to stand still — keep the phone on a stand and record again.`;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** The visible photo of a recording frame as the motion check compares it (twinOrbit.visibleLuma); null
 *  when the frame has none (it never uploaded) or it cannot be decoded — the check does without it. */
async function fetchVisibleLuma(recordingId: string, index: number): Promise<Float32Array | null> {
  try {
    const blob = await getBlob(ref(firebaseStorage, `recordings/${recordingId}/vis_${index}.jpg`));
    const bitmap = await createImageBitmap(blob);
    try {
      const width = Math.min(bitmap.width, VISIBLE_CHECK_WIDTH);
      const height = Math.max(3, Math.round((bitmap.height * width) / bitmap.width));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);
      return visibleLuma(grayFromRgba(ctx.getImageData(0, 0, width, height).data, width, height));
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/** The photo of the frame, or of the frame right before or after it when that one is missing (0.2 s
 *  apart: the same standpoint, for this purpose). */
async function fetchVisibleLumaNear(
  recordingId: string,
  index: number,
  frameCount: number,
): Promise<Float32Array | null> {
  for (const i of [index, index + 1, index - 1]) {
    if (i < 1 || i > frameCount) continue;
    const luma = await fetchVisibleLuma(recordingId, i);
    if (luma) return luma;
  }
  return null;
}

/**
 * Check how the recording's camera moved: the thermal frames first (at most 120, spread over the clip);
 * then the photos of the frames that drifted past the limit, which tell a camera that moved from a
 * thing carried through a still camera's picture (§44.11); then — when the camera holds still — the
 * photos of a few more frames, as a walk around a subject that looks the same from every side in the
 * thermal frame passes the thermal gate. Throws when no frame can be read, or on Stop.
 */
export async function checkCameraMotion(
  experiment: Experiment,
  signal: AbortSignal,
  onProgress: (line: string) => void,
): Promise<CameraMotion> {
  const recordingId = experiment.recordingId!;
  const frameCount = lastFrameIndexOf(experiment) + 1;
  const indices = stabilitySampleIndices(frameCount);
  let fetched = 0;
  onProgress(`Checking camera motion… 0/${indices.length} frames`);
  const samples = await mapPool(indices, FETCH_POOL, async (index) => {
    // Stopped: the frames not yet fetched are skipped rather than read for nothing.
    if (signal.aborted) return null;
    try {
      const buf = await fetchRecordingFrameBufferCached(recordingId, index);
      const frame = getDecodedFrame(buf);
      return { index, temps: frame.temps };
    } catch {
      return null; // a missing frame just drops that sample
    } finally {
      fetched++;
      onProgress(`Checking camera motion… ${fetched}/${indices.length} frames`);
    }
  });
  signal.throwIfAborted();
  const valid = samples.filter((s): s is { index: number; temps: Float32Array } => !!s);
  if (!valid.length) throw new Error('No thermal frames could be read from this recording.');
  let stability = assessStability(valid, IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT);

  // The frames that drifted past the limit in the thermal picture: the camera, or the only thing in the
  // picture? Their photos say — the room behind stays put when the camera did.
  let reference: Float32Array | null | undefined;
  const suspects = stability.samples.filter((s) => s.shiftPx !== null && s.shiftPx > STABLE_MAX_SHIFT_PX);
  let objectFrames = 0;
  if (suspects.length) {
    onProgress(
      `Checking camera motion… comparing the photos of ${suspects.length} frame${suspects.length === 1 ? '' : 's'} that drifted`,
    );
    reference = await fetchVisibleLumaNear(recordingId, stability.referenceIndex, frameCount);
    if (reference) {
      const lumas = await mapPool(suspects, FETCH_POOL, (s) =>
        signal.aborted ? Promise.resolve(null) : fetchVisibleLumaNear(recordingId, s.index, frameCount),
      );
      signal.throwIfAborted();
      const excused = objectMotionFrames(
        reference,
        suspects.map((s, i) => ({ index: s.index, luma: lumas[i] })),
      );
      objectFrames = excused.length;
      stability = excuseStability(stability, excused);
    }
    signal.throwIfAborted();
  }

  let visible: VisibleMotion | null = null;
  if (stability.stable) {
    onProgress('Checking camera motion… comparing the photos');
    const neighbour = neighbourIndex(stability.referenceIndex, frameCount);
    const [referenceLuma, next] = await Promise.all([
      reference === undefined ? fetchVisibleLuma(recordingId, stability.referenceIndex) : Promise.resolve(reference),
      neighbour === null ? null : fetchVisibleLuma(recordingId, neighbour),
    ]);
    if (referenceLuma && next) {
      const others = visibleCheckIndices(
        valid.map((s) => s.index),
        stability.referenceIndex,
      );
      const lumas = await mapPool(others, FETCH_POOL, (index) =>
        signal.aborted ? Promise.resolve(null) : fetchVisibleLuma(recordingId, index),
      );
      visible = assessVisibleMotion(referenceLuma, next, lumas);
    }
    signal.throwIfAborted();
  }
  return {
    kind: cameraMotionKind(stability, visible) === 'fixed' ? 'fixed' : 'moved',
    maxShiftPx: Math.round(stability.maxShiftPx * 100) / 100,
    referenceIndex: stability.referenceIndex,
    ...(visible ? { photosCompared: visible.compared, photosMoved: visible.moved } : {}),
    changedFrames: changedFrameRanges(
      valid.map((s) => s.index),
      changedSampleIndices(stability),
      frameCount,
    ),
    objectFrames,
  };
}
