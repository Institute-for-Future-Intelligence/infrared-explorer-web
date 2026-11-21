/**
 * The worker that makes synthesized Blended frames (utils/blendedFrame.ts starts it and talks to it;
 * utils/blendedFrameJob.ts is the work). One message in — { id, job } — one out: { id, result } with the
 * frame's JPEG blob, or { id, error }.
 */
import { BlendedFrameJob, makeBlendedFrame } from './blendedFrameJob';

// (The app is compiled against the DOM's types, where `self` is a window: only what a worker's scope
// shares with one is used, and its one-argument postMessage is named here.)
const scope = self as unknown as { postMessage(message: unknown): void };

self.addEventListener('message', (e: MessageEvent<{ id: number; job: BlendedFrameJob }>) => {
  const { id, job } = e.data;
  makeBlendedFrame(job).then(
    (result) => scope.postMessage({ id, result }),
    (err) => scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) }),
  );
});
