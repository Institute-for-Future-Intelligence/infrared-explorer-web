/**
 * A picture with a view's Process settings on it, made OFF THE PAGE — what the player asks for every frame
 * of a view that was processed in the capture app (pictureAdjust/doc.ts reads the settings off the
 * experiment; pictureAdjust/adjustFrameJob.ts is the work, and says what the recipe is).
 *
 * The picture goes in as the blob the player already has for the frame — the stored render, the painted
 * infrared picture, the synthesized Blended one — and comes back as a blob the same way, so it is cached,
 * shown, captured and made a thumbnail of exactly as the frame it stands in for.
 *
 * In workers, like the Blended frames (utils/blendedFrame.ts; utils/jobPool has the rules): a frame takes
 * one about 20 ms (35 for a 1080 × 1440 one), so one worker keeps up with any playback speed and the
 * second is for a slower machine. Each holds CanvasKit — 7 MB of WebAssembly, fetched when the first
 * processed frame is asked for and not before — and a WebGL context of its own. Where a worker cannot do
 * it the page does, with its own copy.
 *
 * Where NOTHING can (no WebGL at all), every job would fail the same way after the same wait: after a few
 * in a row this stops trying for the rest of the session, and the caller shows its pictures as stored.
 */
import { JobPool, JobReply, PoolWorker, createJobPool } from '../utils/jobPool';
import type { AdjustFrameJob } from './adjustFrameJob';
import { PictureAdjust, isAdjusted } from './core/pictureAdjustParams';

const WORKERS = 2;

/** Failures in a row after which processing is taken as something this browser cannot do. */
const GIVE_UP_AFTER = 3;

function spawn(): PoolWorker<AdjustFrameJob, Blob> | null {
  if (
    typeof Worker !== 'function' ||
    typeof OffscreenCanvas !== 'function' ||
    typeof createImageBitmap !== 'function'
  ) {
    return null;
  }
  const worker = new Worker(new URL('./adjustFrame.worker.ts', import.meta.url), { type: 'module' });
  const handle: PoolWorker<AdjustFrameJob, Blob> = {
    post: (id, job) => worker.postMessage({ id, job }),
    onReply: null,
    onCrash: null,
    terminate: () => worker.terminate(),
  };
  worker.onmessage = (e: MessageEvent<JobReply<Blob>>) => handle.onReply?.(e.data);
  worker.onerror = () => handle.onCrash?.();
  worker.onmessageerror = () => handle.onCrash?.();
  return handle;
}

let pool: JobPool<AdjustFrameJob, Blob> | null = null;
let failedInARow = 0;
let madeOne = false;

/**
 * Whether a processed picture has been made in this session. Until one has, the next waits for CanvasKit
 * to be fetched and started; the player shows the picture as made meanwhile.
 */
export const adjustedFramesYet = (): boolean => madeOne;

/** False once processing has been given up on for this session (see the header). */
export const canAdjustFrames = (): boolean => failedInARow < GIVE_UP_AFTER;

/**
 * `picture` with `adjust` on it: a JPEG blob of the picture's size (settings that change nothing hand
 * `picture` itself back). Rejects when the picture cannot be decoded or the recipe cannot be run here —
 * the caller shows `picture` itself.
 */
export function adjustedFrameBlob(picture: Blob, adjust: PictureAdjust): Promise<Blob> {
  if (!isAdjusted(adjust)) return Promise.resolve(picture);
  if (!canAdjustFrames()) return Promise.reject(new Error('Processed pictures cannot be made in this browser.'));
  if (!pool) {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    pool = createJobPool<AdjustFrameJob, Blob>({
      size: Math.max(1, Math.min(WORKERS, cores - 1)),
      spawn,
      // (Its own chunk: the page carries CanvasKit's loader only if it ever has to do this itself.)
      runHere: (job) => import('./adjustFrameJob').then((m) => m.makeAdjustedFrame(job)),
    });
  }
  return pool.run({ picture, adjust }).then(
    (blob) => {
      failedInARow = 0;
      madeOne = true;
      return blob;
    },
    (e) => {
      failedInARow += 1;
      throw e;
    },
  );
}
