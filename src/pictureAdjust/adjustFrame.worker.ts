/**
 * The worker that puts Process settings on a picture (pictureAdjust/adjustFrame.ts starts it and talks to
 * it; pictureAdjust/adjustFrameJob.ts is the work). One message in — { id, job } — one out: { id, result }
 * with the picture's JPEG blob, or { id, error }.
 */
import { AdjustFrameJob, makeAdjustedFrame } from './adjustFrameJob';

// (The app is compiled against the DOM's types, where `self` is a window: only what a worker's scope
// shares with one is used, and its one-argument postMessage is named here.)
const scope = self as unknown as { postMessage(message: unknown): void };

self.addEventListener('message', (e: MessageEvent<{ id: number; job: AdjustFrameJob }>) => {
  const { id, job } = e.data;
  makeAdjustedFrame(job).then(
    (result) => scope.postMessage({ id, result }),
    (err) => scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) }),
  );
});
