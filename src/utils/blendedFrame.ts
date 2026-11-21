/**
 * The synthesized Blended frame of a recording, made OFF THE PAGE — what the player and the lightbox ask
 * for a frame whose upload has no mix_N.jpg (utils/msxSynth is the recipe, utils/blendedFrameJob the
 * work).
 *
 * Why off the page (2026-11-20). Making one frame on the main thread — paint the infrared picture, encode
 * it as a PNG, decode it and the visible frame, read both back, blend, encode a JPEG — took about 145 ms on
 * a fast desktop, most of it holding the thread: 8 frames a second at best, for a camera-timed take that
 * plays 8.3. Measured in headless Chrome with a stand-in for the player's loop (a frame due every 120 ms,
 * nine asked for ahead), Blended playback had the page blocked for 3.7 of 8.6 seconds, in stretches of up
 * to 200 ms, and one frame in ten never reached the screen. In workers the same sixty frames all came up
 * on time and the page was never held (no task over 50 ms) — and the pictures are the same, byte for byte.
 *
 * Where the browser has no worker that can do it (no OffscreenCanvas, no createImageBitmap, a worker that
 * will not start) the frame is made on the page as before — utils/jobPool has the rules.
 */
import type { BlendedFrameJob } from './blendedFrameJob';
import { makeBlendedFrame } from './blendedFrameJob';
import { JobPool, JobReply, PoolWorker, createJobPool } from './jobPool';
import { getDecodedFrame } from './thermalFrame';

export type { BlendedFrameJob, BlendedInfrared } from './blendedFrameJob';

/**
 * The most workers started. A frame takes a worker about 100 ms on a fast desktop (decoding the visible
 * frame 15, painting 10, reading back 8, the blend 35, the JPEG 27): one makes about 12 a second there and
 * two about 20 (measured), against the 8.3 a camera-timed take plays at. The rest are for a slower
 * machine, and for a take played faster than it was shot. A worker is started only when a job waits with
 * every one busy, and never more of them than the machine has cores to spare.
 */
const WORKERS = 4;

function spawn(): PoolWorker<BlendedFrameJob, Blob> | null {
  if (
    typeof Worker !== 'function' ||
    typeof OffscreenCanvas !== 'function' ||
    typeof createImageBitmap !== 'function'
  ) {
    return null;
  }
  const worker = new Worker(new URL('./blendedFrame.worker.ts', import.meta.url), { type: 'module' });
  const handle: PoolWorker<BlendedFrameJob, Blob> = {
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

let pool: JobPool<BlendedFrameJob, Blob> | null = null;

/** The frame's Blended render: a JPEG blob, the infrared picture's size. Rejects when a picture cannot be decoded. */
export function blendedFrameBlob(job: BlendedFrameJob): Promise<Blob> {
  if (!pool) {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    pool = createJobPool<BlendedFrameJob, Blob>({
      size: Math.max(1, Math.min(WORKERS, cores - 1)),
      spawn,
      // (The page reads the same .dat for the sensors: its cached decode.)
      runHere: (j) => makeBlendedFrame(j, getDecodedFrame),
    });
  }
  return pool.run(job);
}
