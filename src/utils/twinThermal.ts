/**
 * Heat-map projection for the 3D digital twin (docs/digital-twin-plan.md §8): paint each vertex of a
 * placed prop with the temperature the thermal camera measured where that vertex appears in the frame.
 *
 * A vertex the camera can see (its normal faces the camera) is MEASURED: project it into the frame and
 * read the pixel. A vertex on the far side is INFERRED: read the pixel at its mirror image across the
 * plane through the object's axis facing the camera (vertical for anything that stands; leaning with a
 * held prop) — for a body of revolution that is the point at the same height and radius on the visible
 * silhouette, i.e. the "sweep the profile around the axis" completion the plan describes; for a box it
 * is the matching point on the front face. The two are kept apart (`measured`) so the view can show
 * inference for what it is.
 *
 * Pixels are the canonical 120×160 thermal grid; `registration` is the visible→thermal offset (in those
 * pixels) once the server measures it, zero until then.
 */
import type { TwinCamera, Vec3 } from './twinSolver';
import { projectWorld } from './twinSolver';

export interface ThermalSource {
  temps: ArrayLike<number>; // Celsius, row-major width×height
  width: number;
  height: number;
  min: number; // frame range that maps to the palette (AGC: this frame's own min/max)
  max: number;
  registration?: { dx: number; dy: number } | null;
  /** Display map from plateauEqualization — palette position per 256th of min..max; linear when absent. */
  map?: Float32Array;
  /** The room's temperature (ambientOutsideBoxes): undefined = fall back to the frame median; null =
   *  unknown (a close-up), so no read is ever discarded as the wall. */
  ambientC?: number | null;
}

/** The slice of the palette the FLIR SDK's render actually uses: its AGC keeps headroom at both ends, so
 *  a frame's coldest pixel is deep purple rather than black and its hottest orange-yellow rather than
 *  white. Calibrated with SDK_AGC_PLATEAU / SDK_AGC_LINEAR below against the SDK's own data_N.png
 *  renders of three frames of a pouring clip (pixel → nearest palette colour → position, per
 *  temperature): pixel RMS 0.021 of the palette, against 0.175 for a linear min→max mapping. */
export const SDK_PALETTE_RANGE: readonly [number, number] = [0.15, 0.8];
export const SDK_AGC_PLATEAU = 0.008;
export const SDK_AGC_LINEAR = 0.4;

/**
 * Per-frame display mapping that reproduces the FLIR SDK's histogram AGC, which produced the palette
 * render the player shows beside the twin: a 256-bin histogram of the frame between min and max, each
 * bin capped at `plateau` of the pixels so a large uniform background cannot claim most of the palette,
 * and the running sum as the palette position — blended `linearWeight` with the plain linear mapping so
 * a temperature step never lands on an empty stretch of the palette — then squeezed into `range`. A
 * linear min→max mapping paints a hand-warm bottle in a frame with a kettle the same near-black purple
 * as the wall behind it; this gives the few warm pixels the palette room the render gives them.
 * Returns 256 non-decreasing palette positions (range[0] at min … range[1] at max), one per bin:
 * bin = floor((c − min) / (max − min) · 255).
 */
export function plateauEqualization(
  temps: ArrayLike<number>,
  min: number,
  max: number,
  plateau = SDK_AGC_PLATEAU,
  linearWeight = SDK_AGC_LINEAR,
  range: readonly [number, number] = SDK_PALETTE_RANGE,
): Float32Array {
  const map = new Float32Array(256);
  const [lo, hi] = range;
  const span = max - min;
  const hist = new Float64Array(256);
  let n = 0;
  if (span > 1e-9) {
    for (let i = 0; i < temps.length; i++) {
      const c = temps[i];
      if (!(c > -100)) continue; // the truncated-frame sentinel, or NaN
      let b = Math.floor(((c - min) / span) * 255);
      if (b < 0) b = 0;
      else if (b > 255) b = 255;
      hist[b]++;
      n++;
    }
  }
  if (n === 0) {
    for (let i = 0; i < 256; i++) map[i] = lo + (hi - lo) * (i / 255);
    return map;
  }
  const cap = Math.max(1, plateau * n);
  let total = 0;
  for (let i = 0; i < 256; i++) {
    if (hist[i] > cap) hist[i] = cap;
    total += hist[i];
  }
  // Exclusive running sum, so the bottom bin maps to the range's start and the top bin's own pixels
  // are the last step.
  const denom = total - hist[255] > 0 ? total - hist[255] : total;
  let cum = 0;
  for (let i = 0; i < 256; i++) {
    const cdf = Math.min(1, cum / denom);
    map[i] = lo + (hi - lo) * ((1 - linearWeight) * cdf + linearWeight * (i / 255));
    cum += hist[i];
  }
  map[255] = hi;
  return map;
}

export interface ObjectPose {
  position: Vec3; // bottom centre, world
  yawRad: number;
  /** Lean applied after the yaw: `tiltRad` about the unit `tiltAxis` (the layout's view axis), through
   *  the bottom centre. Absent / 0 = upright. */
  tiltRad?: number;
  tiltAxis?: Vec3;
  /** Half-extent used to reject samples that fall outside the object's box in the frame (+ margin). */
  bbox: { x: number; y: number; w: number; h: number };
  /** A body of revolution: its temperature is taken to vary with height, not around it (a thin wall
   *  conducts around a ring far faster than up it), so the height profile read on the visible side
   *  completes whatever the camera never saw — the back, and the part outside the frame. */
  revolve?: boolean;
  /** Vertices [0, revolvedUntil) are the revolved surface; the rest (a spout, a handle, a bulb) stay out
   *  of the height profile. Absent = the whole body. */
  revolvedUntil?: number;
}

/** Row-major 3×3 rotation = R_tilt(axis, tilt) · R_yaw(y, yaw), the local→world rotation of a prop. */
function poseRotation(pose: ObjectPose): Float64Array {
  const cy = Math.cos(pose.yawRad);
  const sy = Math.sin(pose.yawRad);
  // R_yaw: x' = x cos + z sin; y' = y; z' = −x sin + z cos.
  const yaw = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const t = pose.tiltRad ?? 0;
  if (!t || !pose.tiltAxis) return Float64Array.from(yaw);
  const [kx, ky, kz] = pose.tiltAxis;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const oc = 1 - c;
  // Rodrigues rotation matrix about the unit axis.
  const tilt = [
    c + kx * kx * oc,
    kx * ky * oc - kz * s,
    kx * kz * oc + ky * s,
    ky * kx * oc + kz * s,
    c + ky * ky * oc,
    ky * kz * oc - kx * s,
    kz * kx * oc - ky * s,
    kz * ky * oc + kx * s,
    c + kz * kz * oc,
  ];
  const m = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) {
      m[r * 3 + col] = tilt[r * 3] * yaw[col] + tilt[r * 3 + 1] * yaw[3 + col] + tilt[r * 3 + 2] * yaw[6 + col];
    }
  }
  return m;
}

export interface VertexTemps {
  /** Palette position per vertex: through the source's display map (SDK_PALETTE_RANGE) when it has one,
   *  else the plain 0..1 linear position between min and max. Unknown vertices take the object mean. */
  t01: Float32Array;
  measured: Uint8Array; // 1 = read at the vertex itself, 0 = inferred / filled
  meanC: number | null; // mean Celsius over the measured vertices
  maxC: number | null;
  measuredCount: number;
  /** Celsius per vertex as painted — measured, mirrored, from the height profile, or the object mean;
   *  NaN only when nothing at all could be read for the object. */
  tempC: Float32Array;
}

const BBOX_MARGIN = 0.06; // fraction of the frame the sample may fall outside the model's box
/** Only a read within this of ambient (°C) can be the wall or table seen past the prop's silhouette,
 *  or the halo the thermal image draws around every object; a read further from ambient is real. */
const BG_NEAR_C = 1.2;
/** A read this far from ambient "stands out": the object's level is taken from such reads when enough
 *  of them exist, so a thin object mostly hidden behind its own halo still reads as itself. */
const BG_DISTINCT_C = 3.0;
const FAR_MODE_FRACTION = 0.35;
/** For a reference level near ambient (a room-temperature bottle), a read is the wall only when it
 *  lies beyond ambient from the reference by more than this. */
const RING_TOL_C = 0.8;
/** Height bands of the profile a body of revolution is completed from; a band needs this many front
 *  reads, and this share of its vertices read, before its own level counts (a few halo pixels must
 *  not define a ring). */
const RING_BINS = 40;
const RING_MIN_SAMPLES = 3;
const RING_MIN_FRACTION = 0.1;
/** The room must be visible in at least this share of the frame for its pixels to give an ambient. */
const AMBIENT_MIN_OUTSIDE = 0.25;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Median temperature of the pixels `include` admits (all of them by default), via a 256-bin histogram. */
function medianLevel(src: ThermalSource, include?: (i: number) => boolean): number | null {
  const span = src.max - src.min;
  if (!(span > 1e-9)) return null;
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < src.temps.length; i++) {
    if (include && !include(i)) continue;
    const c = src.temps[i];
    if (!(c > -100)) continue;
    let b = Math.floor(((c - src.min) / span) * 255);
    if (b < 0) b = 0;
    else if (b > 255) b = 255;
    hist[b]++;
    n++;
  }
  if (!n) return null;
  let cum = 0;
  for (let b = 0; b < 256; b++) {
    cum += hist[b];
    if (cum * 2 >= n) return Math.min(src.max, src.min + ((b + 0.5) / 255) * span);
  }
  return null;
}

/** The frame's ambient level when nothing better is known: its median (a lab frame is mostly wall and
 *  bench). Wrong for a close-up in which one object fills the frame — see ambientOutsideBoxes. */
function ambientLevel(src: ThermalSource): number | null {
  return medianLevel(src);
}

/**
 * The room's temperature as the median of the pixels outside every object's box (each grown by the
 * paint margin), or null when less than AMBIENT_MIN_OUTSIDE of the frame lies outside them — a
 * close-up says nothing about the room, and then no read is ever taken for the wall.
 */
export function ambientOutsideBoxes(
  src: ThermalSource,
  boxes: { x: number; y: number; w: number; h: number }[],
): number | null {
  const w = src.width;
  const h = src.height;
  const inside = new Uint8Array(w * h);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor((b.x - BBOX_MARGIN) * w));
    const x1 = Math.min(w - 1, Math.ceil((b.x + b.w + BBOX_MARGIN) * w));
    const y0 = Math.max(0, Math.floor((b.y - BBOX_MARGIN) * h));
    const y1 = Math.min(h - 1, Math.ceil((b.y + b.h + BBOX_MARGIN) * h));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) inside[y * w + x] = 1;
  }
  let outside = 0;
  for (let i = 0; i < inside.length; i++) if (!inside[i]) outside++;
  if (outside < AMBIENT_MIN_OUTSIDE * inside.length) return null;
  return medianLevel(src, (i) => !inside[i]);
}

/**
 * Sample the thermal frame for every vertex of one prop. `positions`/`normals` are the geometry's local
 * attributes (origin at the prop's bottom centre, +y up); the pose places it in the world the camera
 * was solved in.
 */
export function projectVertexTemps(
  positions: ArrayLike<number>,
  normals: ArrayLike<number>,
  pose: ObjectPose,
  cam: TwinCamera,
  src: ThermalSource,
): VertexTemps {
  const n = Math.floor(positions.length / 3);
  const t01 = new Float32Array(n);
  const measured = new Uint8Array(n);
  const m = poseRotation(pose);
  const span = src.max - src.min || 1;
  const map = src.map;
  const toT01 = (c: number): number => {
    const lin = (c - src.min) / span;
    if (!map) return lin;
    const b = Math.floor(lin * 255);
    return map[b < 0 ? 0 : b > 255 ? 255 : b];
  };
  const dx = src.registration?.dx ?? 0;
  const dy = src.registration?.dy ?? 0;
  const bx0 = (pose.bbox.x - BBOX_MARGIN) * src.width;
  const bx1 = (pose.bbox.x + pose.bbox.w + BBOX_MARGIN) * src.width;
  const by0 = (pose.bbox.y - BBOX_MARGIN) * src.height;
  const by1 = (pose.bbox.y + pose.bbox.h + BBOX_MARGIN) * src.height;

  // The mirror plane: through the object's bottom centre, containing its (possibly leaning) axis, and
  // facing the camera — its normal is the camera offset with the axial component removed. For an
  // upright prop that is the vertical plane perpendicular to the camera direction.
  const ax = m[1];
  const ay = m[4];
  const az = m[7]; // the prop's +y axis in the world
  let px = cam.position[0] - pose.position[0];
  let py = cam.position[1] - pose.position[1];
  let pz = cam.position[2] - pose.position[2];
  const along = px * ax + py * ay + pz * az;
  px -= along * ax;
  py -= along * ay;
  pz -= along * az;
  let pl = Math.hypot(px, py, pz);
  if (pl < 1e-9) {
    // The camera is on the axis (looking straight down into the prop): any plane through the axis
    // will do; take the horizontal direction toward the camera, or +z.
    px = cam.position[0] - pose.position[0];
    py = 0;
    pz = cam.position[2] - pose.position[2];
    pl = Math.hypot(px, pz);
    if (pl < 1e-9) {
      px = 0;
      pz = 1;
      pl = 1;
    }
  }
  px /= pl;
  py /= pl;
  pz /= pl;

  const sample = (p: Vec3): number | null => {
    const pr = projectWorld(p, cam);
    if (!pr) return null;
    // The box is in the visible frame the layout was solved from, so it is tested against the bare
    // projection; the registration and drift offsets only move the READ onto the thermal grid.
    if (pr.u < bx0 || pr.u > bx1 || pr.v < by0 || pr.v > by1) return null;
    const u = pr.u + dx;
    const v = pr.v + dy;
    const ix = Math.min(src.width - 1, Math.max(0, Math.floor(u)));
    const iy = Math.min(src.height - 1, Math.max(0, Math.floor(v)));
    const c = src.temps[iy * src.width + ix];
    return Number.isFinite(c) && c > -100 ? c : null;
  };

  // Pass 1 — read what the camera saw: a front-facing vertex at its own pixel, a back-facing one at
  // its mirror image on the visible side (a real pixel at the same height and offset from the axis).
  const tempC = new Float32Array(n).fill(NaN);
  const how = new Uint8Array(n); // 0 unknown, 1 measured, 2 mirrored, 3 from the height profile
  for (let i = 0; i < n; i++) {
    const lx = positions[i * 3];
    const ly = positions[i * 3 + 1];
    const lz = positions[i * 3 + 2];
    // Local → world (yaw about y, then the lean, then translate).
    const wx = pose.position[0] + m[0] * lx + m[1] * ly + m[2] * lz;
    const wy = pose.position[1] + m[3] * lx + m[4] * ly + m[5] * lz;
    const wz = pose.position[2] + m[6] * lx + m[7] * ly + m[8] * lz;
    const nx = normals[i * 3];
    const ny = normals[i * 3 + 1];
    const nz = normals[i * 3 + 2];
    const wnx = m[0] * nx + m[1] * ny + m[2] * nz;
    const wny = m[3] * nx + m[4] * ny + m[5] * nz;
    const wnz = m[6] * nx + m[7] * ny + m[8] * nz;
    const facing = wnx * (cam.position[0] - wx) + wny * (cam.position[1] - wy) + wnz * (cam.position[2] - wz) > 0;
    if (facing) {
      const c = sample([wx, wy, wz]);
      if (c !== null) {
        tempC[i] = c;
        how[i] = 1;
        continue;
      }
    }
    // Mirror across the plane through the object's axis facing the camera, but only for points
    // behind that plane (a front point that simply fell outside the frame stays unknown).
    const d = (wx - pose.position[0]) * px + (wy - pose.position[1]) * py + (wz - pose.position[2]) * pz;
    if (d < 0) {
      const c = sample([wx - 2 * d * px, wy - 2 * d * py, wz - 2 * d * pz]);
      if (c !== null) {
        tempC[i] = c;
        how[i] = 2;
      }
    }
  }

  // Pass 2 — what "the object" reads, and which reads are the wall behind it. `ambient` is the room:
  // the caller's estimate from the pixels outside every object's box when it has one, else the frame
  // median (null when nothing can be said — then nothing is dropped).
  const ambient = src.ambientC === undefined ? ambientLevel(src) : src.ambientC;
  const revolvedUntil = pose.revolve ? Math.min(n, pose.revolvedUntil ?? n) : 0;
  /** Robust level of a set of reads: the median of the ones that stand out from ambient when enough of
   *  them do (a thin object mostly hidden behind its own halo, a hot body behind a few wall pixels),
   *  else the median of all of them. */
  const level = (xs: number[]): number => {
    if (ambient !== null) {
      const off = xs.filter((c) => Math.abs(c - ambient) > BG_DISTINCT_C);
      if (off.length >= Math.max(RING_MIN_SAMPLES, FAR_MODE_FRACTION * xs.length)) return median(off);
    }
    return median(xs);
  };
  const frontAll: number[] = [];
  for (let i = 0; i < n; i++) if (how[i] === 1) frontAll.push(tempC[i]);
  const objLevel = frontAll.length ? level(frontAll) : null;
  const objSide = objLevel !== null && ambient !== null && objLevel < ambient ? -1 : 1;
  /** Is a read the wall / halo rather than the object it should match (`ref`)? Only a read AT ambient
   *  (± BG_NEAR_C) can be: one far from ambient is real whatever the ring says — an ice cube on a
   *  beaker, a pour hitting one side. At ambient it is the wall when the reference stands distinctly
   *  away from ambient, or, for a reference near ambient, when it lies beyond ambient from the
   *  reference by more than the ring tolerance (colder than the room, behind a room-temperature bottle). */
  const isWall = (c: number, ref: number): boolean => {
    if (ambient === null || Math.abs(c - ambient) >= BG_NEAR_C) return false;
    const side = ref > ambient ? 1 : ref < ambient ? -1 : objSide;
    const dRef = (ref - ambient) * side;
    const dC = (c - ambient) * side;
    return dC < Math.min(BG_NEAR_C, dRef - RING_TOL_C);
  };

  // Pass 3 — the height profile of a body of revolution: per height band, the level of the FRONT
  // reads on the revolved surface (a spout, handle or bulb is kept out — seen, it would outvote the
  // body's ring; unseen, it would inherit the ring's heat), bands with too few reads interpolated
  // from their neighbours, the ends held. Then each vertex: a read that is the wall behind the object
  // is dropped; whatever is unread on the revolved surface takes its band's value.
  let profile: Float64Array | null = null;
  let hMax = 0;
  for (let i = 0; i < revolvedUntil; i++) if (positions[i * 3 + 1] > hMax) hMax = positions[i * 3 + 1];
  const binOf = (ly: number) => Math.min(RING_BINS - 1, Math.max(0, Math.floor((ly / hMax) * RING_BINS)));
  if (revolvedUntil > 0 && hMax > 0) {
    const reads: number[][] = Array.from({ length: RING_BINS }, () => []);
    const verts = new Uint32Array(RING_BINS);
    for (let i = 0; i < revolvedUntil; i++) {
      const b = binOf(positions[i * 3 + 1]);
      verts[b]++;
      if (how[i] === 1) reads[b].push(tempC[i]);
    }
    const prof = new Float64Array(RING_BINS).fill(NaN);
    let any = false;
    for (let b = 0; b < RING_BINS; b++) {
      if (reads[b].length >= Math.max(RING_MIN_SAMPLES, RING_MIN_FRACTION * verts[b])) {
        prof[b] = level(reads[b]);
        any = true;
      }
    }
    if (any) {
      // Interpolate across bands without enough reads; hold the end values beyond the last one.
      let prev = -1;
      for (let b = 0; b < RING_BINS; b++) {
        if (!Number.isNaN(prof[b])) {
          if (prev < 0) for (let q = 0; q < b; q++) prof[q] = prof[b];
          else
            for (let q = prev + 1; q < b; q++)
              prof[q] = prof[prev] + ((prof[b] - prof[prev]) * (q - prev)) / (b - prev);
          prev = b;
        }
      }
      for (let q = prev + 1; q < RING_BINS; q++) prof[q] = prof[prev];
      profile = prof;
    }
  }
  for (let i = 0; i < n; i++) {
    const onRing = profile !== null && i < revolvedUntil;
    const ref = onRing && profile ? profile[binOf(positions[i * 3 + 1])] : objLevel;
    if (how[i] && ref !== null && isWall(tempC[i], ref)) {
      how[i] = 0;
      tempC[i] = NaN;
    }
    if (!how[i] && onRing && ref !== null) {
      tempC[i] = ref;
      how[i] = 3;
    }
  }

  // Stats over what was actually measured; whatever is still unknown takes the object's mean
  // (measured first, else anything read), so a prop never shows a hole; all of it stays inferred.
  let sumC = 0;
  let maxC = -Infinity;
  let count = 0;
  let sumAny = 0;
  let countAny = 0;
  for (let i = 0; i < n; i++) {
    if (how[i] === 1) {
      sumC += tempC[i];
      if (tempC[i] > maxC) maxC = tempC[i];
      count++;
    }
    if (how[i]) {
      sumAny += tempC[i];
      countAny++;
    }
  }
  const fillC = count ? sumC / count : countAny ? sumAny / countAny : null;
  for (let i = 0; i < n; i++) {
    if (!how[i] && fillC !== null) tempC[i] = fillC;
    measured[i] = how[i] === 1 ? 1 : 0;
    const t = Number.isFinite(tempC[i]) ? toT01(tempC[i]) : 0.5;
    t01[i] = t < 0 ? 0 : t > 1 ? 1 : t;
  }

  return {
    t01,
    tempC,
    measured,
    meanC: count ? sumC / count : null,
    maxC: count ? maxC : null,
    measuredCount: count,
  };
}
