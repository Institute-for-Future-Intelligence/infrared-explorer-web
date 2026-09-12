/**
 * Frame selection for the walk-around ("orbit") twin of a recording (docs/digital-twin-plan.md §18.6 C5).
 *
 * A fixed-camera recording is analysed from ONE frame (twinScene.ts); a recording whose camera walked
 * around the subject is instead treated like a photo set — a handful of frames from different
 * standpoints go to the scene-program model (twinBuilding.ts). Which handful matters: the frames must
 * be sharp enough to read geometry from, and they must show DIFFERENT standpoints — eight frames of the
 * same view teach the model nothing the first did not. Both are judged without a model call:
 *
 *   - sharpness: the variance of the Laplacian of the downscaled visible photo (motion blur and a lost
 *     focus flatten it);
 *   - novelty: how far a frame has to be shifted to match an already chosen frame (nccShift, the
 *     registration estimator), judged on TWO pictures of it — the thermal edge map and the visible
 *     photo's luma — and taking the LARGER of the two shifts. A small shift with a strong correlation
 *     in both is the same view again; a large shift, or no correlation at all, in either is a new
 *     standpoint. The thermal edges alone are not enough: a centred, roughly symmetric subject (a
 *     kettle on a hot plate, a beaker, a column) looks the same in the thermal frame from every side,
 *     so a genuine walk around it registers with a near-zero shift — while the visible photo, with the
 *     bench, the room and the handle behind it, changes with every step.
 *
 * The same estimator also refuses a clip that never moved: when every frame aligns with the first
 * within the fixed-camera limit in BOTH pictures, the user picked the wrong mode and the fixed-camera
 * twin will serve them better. Pure and dependency-free apart from twinRegistration's edge tools; the
 * caller loads and decodes the frames.
 */
import { gradientMagnitude, nccShift, normalizeEdges, resampleGray, type Gray } from './twinRegistration';

/** The thermal grid the edge maps live on. */
export const ORBIT_GRID_WIDTH = 120;
export const ORBIT_GRID_HEIGHT = 160;
/** The grid the visible photo's luma is kept on: half the thermal grid each way, so the visible check
 *  costs a quarter of the thermal one and its shifts scale to thermal px by a whole factor of two. */
export const ORBIT_LUMA_WIDTH = 60;
export const ORBIT_LUMA_HEIGHT = 80;
const LUMA_TO_THERMAL_PX = ORBIT_GRID_WIDTH / ORBIT_LUMA_WIDTH;

/** How many frames the model is shown at most; below ORBIT_MIN_FRAMES the walk is too short to describe
 *  a standpoint per side, but the caller still proceeds — a partial orbit is a legitimate set. */
export const ORBIT_WANT_FRAMES = 8;
export const ORBIT_MIN_FRAMES = 6;

/** Two frames whose edge maps align within this shift (thermal px) with a trustworthy correlation are
 *  the same standpoint: the second is a duplicate. Half the fixed-camera limit. */
export const ORBIT_MIN_SHIFT_PX = 6;
/** Search window for the novelty check, each way. A shift past it reads as "no match" — a new view. */
export const ORBIT_SEARCH_PX = 8;
/** Below this peak correlation two edge maps do not depict the same view (they are novel to each other),
 *  whatever the shift estimate says. */
export const ORBIT_MIN_NCC_SCORE = 0.3;
/** The same gate for the visible lumas, set higher: two visible photos of one standpoint correlate far
 *  better than two thermal frames do (edge-rich pictures, no sensor drift — 0.85 and up with a hand's
 *  jitter), while the subject alone, centred in every frame of a walk around it, correlates its own
 *  edges at about 0.4 from any side. Below this the room behind the subject has moved on. */
export const ORBIT_MIN_LUMA_NCC_SCORE = 0.5;
/** A clip whose frames ALL align with the first within this shift (thermal px) is a fixed camera — the
 *  same figure as the client's STABLE_MAX_SHIFT_PX gate (src/utils/twinStability.ts), so the two modes
 *  meet at one line: what the fixed-camera twin would accept, the orbit twin refuses. */
export const ORBIT_FIXED_CAMERA_MAX_SHIFT_PX = 12;
/** Search window when measuring the whole clip's motion against its first frame. */
export const ORBIT_MOTION_SEARCH_PX = 16;

/** One sampled recording frame as the selector sees it. */
export interface OrbitCandidate {
  index: number; // recording frame index (1-based, as stored)
  sharpness: number; // laplacianVariance of the visible photo; larger is sharper
  edges: Float32Array; // thermalEdgeMap of the frame: normalised edges on the 120×160 grid
  /** visibleLuma of the frame's visible photo: normalised grey on the 60×80 grid, or null when the
   *  photo could not be decoded — the frame is then judged on its thermal edges alone. */
  luma: Float32Array | null;
}

/** The thermal frame's edge map, normalised, as the novelty check compares it. */
export function thermalEdgeMap(
  temps: ArrayLike<number>,
  width = ORBIT_GRID_WIDTH,
  height = ORBIT_GRID_HEIGHT,
): Float32Array {
  const data = temps instanceof Float32Array ? temps : Float32Array.from(temps as ArrayLike<number>);
  return normalizeEdges(gradientMagnitude({ data, width, height })).data;
}

/**
 * Variance of the 4-neighbour Laplacian over the interior of a grey image — the usual no-reference
 * sharpness figure: edges give the Laplacian large values of both signs, blur shrinks them toward
 * zero. Meant for a downscaled photo (a few hundred px across) so sensor noise does not pass for detail
 * and the cost is trivial.
 */
export function laplacianVariance(gray: Gray): number {
  const { width: w, height: h, data } = gray;
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const l = data[i - 1] + data[i + 1] + data[i - w] + data[i + w] - 4 * data[i];
      sum += l;
      sum2 += l * l;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return Math.max(0, sum2 / n - mean * mean);
}

/** The visible photo's luma as the novelty check compares it: the grey picture (any size) downscaled to
 *  the 60×80 luma grid and normalised to zero mean and unit variance, so exposure changes between
 *  frames do not register as motion. */
export function visibleLuma(gray: Gray): Float32Array {
  return normalizeEdges(resampleGray(gray, ORBIT_LUMA_WIDTH, ORBIT_LUMA_HEIGHT)).data;
}

const asGray = (edges: Float32Array): Gray => ({ data: edges, width: ORBIT_GRID_WIDTH, height: ORBIT_GRID_HEIGHT });
const asLuma = (luma: Float32Array): Gray => ({ data: luma, width: ORBIT_LUMA_WIDTH, height: ORBIT_LUMA_HEIGHT });

/** The luma is correlated as an edge map, like the thermal frame, so a shift is read from where things
 *  are and not from how bright they are. Computed once per luma: the selector compares each pair once
 *  but each candidate many times. */
const lumaEdgeCache = new WeakMap<Float32Array, Gray>();
function lumaEdges(luma: Float32Array): Gray {
  let edges = lumaEdgeCache.get(luma);
  if (!edges) {
    edges = normalizeEdges(gradientMagnitude(asLuma(luma)));
    lumaEdgeCache.set(luma, edges);
  }
  return edges;
}

/** The shift that aligns two edge maps when they correlate, capped at `unmatched` — which also stands in
 *  for "no correlation at all": two views that share no edges are as novel to each other as views can be. */
function edgeDistance(a: Gray, b: Gray, searchPx: number, unmatched: number, minScore: number): number {
  const e = nccShift(a, b, searchPx);
  if (e.score < minScore) return unmatched;
  return Math.min(unmatched, Math.hypot(e.dx, e.dy));
}

/** What standpointDistance compares: a candidate, or just its two pictures. */
export type OrbitView = Pick<OrbitCandidate, 'edges' | 'luma'>;

/**
 * How far apart two frames' standpoints are, in thermal px: the LARGER of the shift that aligns their
 * thermal edge maps and the shift that aligns their visible lumas (scaled to thermal px), each read as
 * `unmatched` (a stand-in for "further than the window") when the pair does not correlate. Taking the
 * larger means two frames are the same standpoint only when BOTH pictures say so — the thermal frame of
 * a symmetric subject says so from every side, the visible photo behind it does not. A frame without a
 * luma is judged on its thermal edges alone.
 */
export function standpointDistance(a: OrbitView, b: OrbitView, searchPx = ORBIT_SEARCH_PX): number {
  const unmatched = 2 * searchPx;
  const thermal = edgeDistance(asGray(a.edges), asGray(b.edges), searchPx, unmatched, ORBIT_MIN_NCC_SCORE);
  if (thermal >= unmatched || !a.luma || !b.luma) return thermal;
  // The luma grid is coarser, so the window shrinks with it and the shift grows back by the same factor.
  const lumaSearch = Math.max(1, Math.ceil(searchPx / LUMA_TO_THERMAL_PX));
  const visible = edgeDistance(
    lumaEdges(a.luma),
    lumaEdges(b.luma),
    lumaSearch,
    unmatched / LUMA_TO_THERMAL_PX,
    ORBIT_MIN_LUMA_NCC_SCORE,
  );
  return Math.max(thermal, Math.min(unmatched, visible * LUMA_TO_THERMAL_PX));
}

/**
 * The clip's motion: the largest shift of any candidate against the FIRST, with a candidate that does not
 * correlate with it at all counting as beyond the window (it moved further than a translation can
 * describe — which for this gate is the answer, not a gap). A fixed camera keeps this within
 * ORBIT_FIXED_CAMERA_MAX_SHIFT_PX in both the thermal and the visible picture; a walk around the subject
 * blows through it within a few frames in at least one of them.
 */
export function totalMotion(candidates: OrbitCandidate[], searchPx = ORBIT_MOTION_SEARCH_PX): number {
  if (candidates.length < 2) return 0;
  const first = candidates[0];
  let worst = 0;
  for (let i = 1; i < candidates.length; i++) {
    worst = Math.max(worst, standpointDistance(first, candidates[i], searchPx));
    if (worst >= 2 * searchPx) break; // already unmatched: nothing larger to find
  }
  return worst;
}

export interface OrbitSelection {
  picked: OrbitCandidate[]; // in recording order (photo 1 = the earliest), at most `want`
  duplicates: number; // candidates set aside as the same standpoint as one already chosen
}

/**
 * Pick the frames the model will see (§18.6 C5): greedy — the sharpest frame first, then repeatedly the
 * frame that adds the most new standpoint (its distance to the nearest chosen frame, capped at the
 * window) with sharpness as the tie-breaker, never a frame within `minShiftPx` of one already chosen.
 * Stops at `want` or when only duplicates remain, so a slow half-orbit yields fewer, distinct frames
 * rather than eight near-copies. The result is returned in recording order because the prompt numbers
 * the pictures 1..N in the order sent and makes "photo 1" define the subject's front — so the front is
 * the side the walk started from.
 */
export function selectOrbitFrames(opts: {
  candidates: OrbitCandidate[];
  want?: number;
  minShiftPx?: number;
  searchPx?: number;
}): OrbitSelection {
  const { candidates } = opts;
  const want = opts.want ?? ORBIT_WANT_FRAMES;
  const minShiftPx = opts.minShiftPx ?? ORBIT_MIN_SHIFT_PX;
  const searchPx = opts.searchPx ?? ORBIT_SEARCH_PX;
  if (!candidates.length || want <= 0) return { picked: [], duplicates: 0 };
  const maxSharp = Math.max(1e-9, ...candidates.map((c) => c.sharpness));
  const sharp = candidates.map((c) => c.sharpness / maxSharp);
  const cap = 2 * searchPx;

  let firstIdx = 0;
  for (let i = 1; i < candidates.length; i++) if (sharp[i] > sharp[firstIdx]) firstIdx = i;
  const pickedIdx = [firstIdx];
  // Distance from each candidate to its nearest picked frame; refined against each newly picked frame
  // only, so every pair is correlated at most once.
  const novelty = candidates.map(() => Infinity);
  const taken = candidates.map(() => false);
  taken[firstIdx] = true;
  let duplicates = 0;
  let newest = firstIdx;
  while (pickedIdx.length < want) {
    for (let i = 0; i < candidates.length; i++) {
      if (taken[i]) continue;
      novelty[i] = Math.min(novelty[i], standpointDistance(candidates[newest], candidates[i], searchPx));
      if (novelty[i] < minShiftPx) {
        taken[i] = true;
        duplicates++;
      }
    }
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      if (taken[i]) continue;
      const score = Math.min(novelty[i], cap) / cap + 0.5 * sharp[i];
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) break;
    taken[best] = true;
    pickedIdx.push(best);
    newest = best;
  }
  const picked = pickedIdx.map((i) => candidates[i]).sort((a, b) => a.index - b.index);
  return { picked, duplicates };
}
