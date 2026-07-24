/**
 * Evenly-spaced downsample of a clip's frames for the T(t)/scatter/histogram/profile charts. Both players
 * feed the SAME sampled set to every chart, and the set is re-decoded on a chart rebuild, so it is kept
 * within the decoded-frame LRU (getDecodedFrame CACHE_CAP) by the per-source point caps in constants.ts.
 *
 * Returns the chosen frame indices AND the integer `step` (stride) between them: the line chart maps a
 * sample back to a time as `index * step * secondPerFrame`, so `step` must stay an integer stride and match
 * how the players built LineplotData before this was factored out (resolves the old
 * `// todo: sample function`). Behaviour is identical to the previous inline
 * `maxPoints = min(limit, total); step = floor(total / maxPoints)` loops.
 */
export const sampleFrameIndices = (total: number, maxPoints: number): { indices: number[]; step: number } => {
  if (total <= 0) return { indices: [], step: 1 };
  const points = Math.max(1, Math.min(maxPoints, total));
  const step = Math.max(1, Math.floor(total / points));
  const indices = Array.from({ length: points }, (_, i) => Math.min(total - 1, i * step));
  return { indices, step };
};
