/**
 * Geometry solver for the 3D digital twin (docs/digital-twin-plan.md §6): turns the model's per-object
 * boxes (fractions of the photo) into metre-scale positions on a table plane, using only things we
 * know for certain — the FLIR camera's field of view and the nominal size of common lab glassware —
 * plus the camera pitch (from the model's category until the capture app records the real angle).
 *
 * Deterministic and cheap, so it runs client-side every time the twin tab opens; the model's answer is
 * what gets persisted, not this.
 *
 * Frames. World: +y up, the support surface is the plane y = 0, the camera sits at `position` on the
 * y axis looking along −z pitched DOWN by `pitchDeg`. Camera: three.js convention (+x right, +y up, the
 * view direction is −z). Pixels: the canonical 120×160 portrait thermal grid, u rightwards, v downwards
 * — boxes are fractions, so any 3:4 frame gives the same numbers.
 */
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from './constants';
import { STREET_VIEW_HFOV, STREET_VIEW_VFOV } from './streetViewPano';
import type { TwinEdits, TwinObject, TwinObjectKind, TwinScene } from '../types';

export type Vec3 = [number, number, number];
const deg = (d: number) => (d * Math.PI) / 180;

export interface TwinIntrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/** Pinhole intrinsics from the FLIR field of view (portrait: 43° across the 120-px width, 55° down the
 *  160-px height). fx ≈ fy ≈ 153 px — the pixels are square to within 1 %, a useful sanity check. */
export function twinIntrinsics(width = IR_ARRAY_WIDTH, height = IR_ARRAY_HEIGHT): TwinIntrinsics {
  return {
    fx: width / 2 / Math.tan(deg(STREET_VIEW_HFOV) / 2),
    fy: height / 2 / Math.tan(deg(STREET_VIEW_VFOV) / 2),
    cx: width / 2,
    cy: height / 2,
    width,
    height,
  };
}

export interface TwinCamera extends TwinIntrinsics {
  pitchDeg: number; // downward tilt of the view direction below horizontal
  position: Vec3;
}

/** Rotate about the x axis by `a` radians (right-handed). */
export const rotX = (p: Vec3, a: number): Vec3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
};

/** Camera-frame point → world. The camera's −z (view) axis maps to (0, −sin θ, −cos θ): pitched down. */
export const camToWorld = (p: Vec3, cam: TwinCamera): Vec3 => {
  const r = rotX(p, -deg(cam.pitchDeg));
  return [r[0] + cam.position[0], r[1] + cam.position[1], r[2] + cam.position[2]];
};

export const worldToCam = (p: Vec3, cam: TwinCamera): Vec3 =>
  rotX([p[0] - cam.position[0], p[1] - cam.position[1], p[2] - cam.position[2]], deg(cam.pitchDeg));

/** Rotate `p` about the unit `axis` by `a` radians (Rodrigues, right-handed). */
export const rotAxis = (p: Vec3, axis: Vec3, a: number): Vec3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const [kx, ky, kz] = axis;
  const dot = kx * p[0] + ky * p[1] + kz * p[2];
  return [
    p[0] * c + (ky * p[2] - kz * p[1]) * s + kx * dot * (1 - c),
    p[1] * c + (kz * p[0] - kx * p[2]) * s + ky * dot * (1 - c),
    p[2] * c + (kx * p[1] - ky * p[0]) * s + kz * dot * (1 - c),
  ];
};

/** World point → pixel (u right, v down) and depth along the view axis; null when behind the camera. */
export function projectWorld(p: Vec3, cam: TwinCamera): { u: number; v: number; depth: number } | null {
  const c = worldToCam(p, cam);
  const depth = -c[2];
  if (depth <= 1e-6) return null;
  return { u: cam.cx + (cam.fx * c[0]) / depth, v: cam.cy - (cam.fy * c[1]) / depth, depth };
}

/** The camera-frame direction through pixel (u, v), scaled so z = −1 (multiply by depth for the point). */
export const pixelRay = (u: number, v: number, k: TwinIntrinsics): Vec3 => [(u - k.cx) / k.fx, -(v - k.cy) / k.fy, -1];

// ---------------------------------------------------------------------------------------------------
// Priors

/** Camera tilt per model category, until the capture app writes the measured pitch into meta.json. */
export const PITCH_DEG: Record<TwinScene['camera']['pitch'], number> = {
  level: 0,
  slightly_above: 15,
  high_angle: 40,
  top_down: 80,
};

/** Working-distance range per model hint, metres along the view axis. */
export const DISTANCE_RANGE_M: Record<TwinScene['camera']['distanceHint'], [number, number]> = {
  close: [0.2, 0.5],
  medium: [0.5, 1.5],
  far: [1.5, 4],
};

export interface NominalSpec {
  label: string;
  heightM: number;
  widthM: number; // diameter for a body of revolution, footprint width otherwise
  /** Flat things (a gauze, a dish) have no usable height in the photo: range them by width instead. */
  byWidth?: boolean;
}

/** Nominal sizes of common lab equipment (plan §7). Real sizes vary by maker; these are the ordinary
 *  classroom items, and the label is what the twin shows for the chosen spec. */
export const NOMINAL_SIZES: Partial<Record<TwinObjectKind, NominalSpec[]>> = {
  beaker: [
    { label: '50 mL', heightM: 0.06, widthM: 0.042 },
    { label: '100 mL', heightM: 0.07, widthM: 0.05 },
    { label: '250 mL', heightM: 0.095, widthM: 0.07 },
    { label: '400 mL', heightM: 0.11, widthM: 0.08 },
    { label: '600 mL', heightM: 0.125, widthM: 0.09 },
    { label: '1000 mL', heightM: 0.145, widthM: 0.105 },
  ],
  erlenmeyer_flask: [
    { label: '125 mL', heightM: 0.11, widthM: 0.07 },
    { label: '250 mL', heightM: 0.14, widthM: 0.085 },
    { label: '500 mL', heightM: 0.18, widthM: 0.105 },
  ],
  test_tube: [{ label: '16 × 150 mm', heightM: 0.15, widthM: 0.016 }],
  test_tube_rack: [{ label: '6-place', heightM: 0.08, widthM: 0.2 }],
  graduated_cylinder: [
    { label: '100 mL', heightM: 0.25, widthM: 0.03 },
    { label: '250 mL', heightM: 0.32, widthM: 0.04 },
  ],
  // A pouring kettle is usually part-way out of the frame, so its box says little about its size; one
  // ordinary spec keeps it kettle-sized (body diameter — the handle and spout add to the footprint).
  kettle: [{ label: 'electric kettle', heightM: 0.22, widthM: 0.16 }],
  petri_dish: [{ label: '90 mm', heightM: 0.015, widthM: 0.09, byWidth: true }],
  alcohol_lamp: [{ label: 'alcohol lamp', heightM: 0.09, widthM: 0.08 }],
  bunsen_burner: [{ label: 'Bunsen burner', heightM: 0.14, widthM: 0.07 }],
  candle: [{ label: 'candle', heightM: 0.1, widthM: 0.02 }],
  hot_plate: [{ label: 'hot plate', heightM: 0.08, widthM: 0.18 }],
  tripod: [{ label: 'tripod', heightM: 0.2, widthM: 0.15 }],
  wire_gauze: [{ label: 'wire gauze', heightM: 0.003, widthM: 0.15, byWidth: true }],
  ring_stand: [{ label: 'ring stand', heightM: 0.6, widthM: 0.15 }],
  clamp: [{ label: 'clamp', heightM: 0.05, widthM: 0.12, byWidth: true }],
  thermometer: [{ label: 'thermometer', heightM: 0.3, widthM: 0.008 }],
};

/** Fallback heights (m) for kinds without a nominal table, used when the model gave no size. */
const DEFAULT_HEIGHT_M: Partial<Record<TwinObjectKind, number>> = {
  bottle: 0.22,
  cup: 0.1,
  kettle: 0.22,
  pot: 0.15,
  metal_block: 0.05,
  ice: 0.03,
  hand: 0.18,
  person: 1.7,
  phone: 0.15,
  laptop: 0.02,
  screen: 0.3,
  other: 0.1,
};

/** Every kind, in the order the correction picker lists them (apparatus first, then containers,
 *  heat sources, stands, misc, and last the people/device kinds). Mirrors TWIN_OBJECT_KINDS server-side. */
export const TWIN_KIND_LIST: readonly TwinObjectKind[] = [
  'beaker',
  'erlenmeyer_flask',
  'test_tube',
  'test_tube_rack',
  'graduated_cylinder',
  'petri_dish',
  'bottle',
  'cup',
  'kettle',
  'pot',
  'alcohol_lamp',
  'bunsen_burner',
  'candle',
  'hot_plate',
  'tripod',
  'wire_gauze',
  'ring_stand',
  'clamp',
  'thermometer',
  'metal_block',
  'ice',
  'other',
  'hand',
  'person',
  'phone',
  'laptop',
  'screen',
];

/** Kinds the twin never draws — they are people and devices, not apparatus — but keeps in the list. */
export const NON_RENDERED_KINDS: ReadonlySet<TwinObjectKind> = new Set(['hand', 'person', 'phone', 'laptop', 'screen']);

/** Bodies of revolution: the heat map may be completed around the axis from the visible silhouette. */
export const REVOLVE_KINDS: ReadonlySet<TwinObjectKind> = new Set([
  'beaker',
  'erlenmeyer_flask',
  'test_tube',
  'graduated_cylinder',
  'bottle',
  'cup',
  'kettle',
  'pot',
  'petri_dish',
  'alcohol_lamp',
  'bunsen_burner',
  'candle',
  'thermometer',
]);

// ---------------------------------------------------------------------------------------------------
// Held objects

/** The kettle prop's spout, as fractions of its radius (x) and height (y) — shared with props.ts so
 *  the solver can put the spout tip exactly where the pour goes. */
export const KETTLE_SHAPE = { spoutBaseX: 0.9, spoutBaseY: 0.74, spoutTipX: 1.32, spoutTipY: 0.98 } as const;

/**
 * Where a held object meets what it is held over, in the prop's own frame (origin at the bottom
 * centre, +y up, +x toward the target): a kettle's spout tip, a thermometer's bulb, otherwise the rim
 * on the target's side. `gapM` is how far above the target's mouth that point sits (negative = dipped in).
 */
export function holdAnchor(
  kind: TwinObjectKind,
  heightM: number,
  widthM: number,
  targetHeightM: number,
): { local: Vec3; gapM: number; reachM: number } {
  const r = widthM / 2;
  switch (kind) {
    case 'kettle':
      // reachM: how far the spout tip sticks out past the plinth (1.05 r) — the body must stay that
      // much short of the target's rim.
      return {
        local: [r * KETTLE_SHAPE.spoutTipX, heightM * KETTLE_SHAPE.spoutTipY, 0],
        gapM: 0.02,
        reachM: (KETTLE_SHAPE.spoutTipX - 1.05) * r,
      };
    case 'thermometer':
      return { local: [0, 0, 0], gapM: -0.5 * targetHeightM, reachM: Infinity };
    default:
      return { local: [r, heightM, 0], gapM: 0.03, reachM: 0 };
  }
}

// ---------------------------------------------------------------------------------------------------
// Sizing

export interface ChosenSize {
  spec: string | null;
  heightM: number;
  widthM: number;
  depthM: number; // distance along the view axis implied by the size and the box
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Pick the real size of an object and hence its distance. With a nominal table the spec whose implied
 * distance best fits the model's distance hint (and, secondarily, the model's own size estimate) wins;
 * without one the model's estimate is used, with the box's aspect standing in for a missing width.
 */
export function chooseSize(
  o: TwinObject,
  hint: TwinScene['camera']['distanceHint'],
  k: TwinIntrinsics,
  specLabel?: string,
): ChosenSize {
  const hPx = Math.max(1, o.bbox.h * k.height);
  const wPx = Math.max(1, o.bbox.w * k.width);
  const [lo, hi] = DISTANCE_RANGE_M[hint];
  const mid = Math.sqrt(lo * hi);
  const specs = NOMINAL_SIZES[o.kind];
  // An owner-chosen spec wins outright (they can see the real thing).
  const forced = specLabel && specs ? specs.find((s) => s.label === specLabel) : undefined;
  if (forced) {
    const depthM = forced.byWidth ? (k.fx * forced.widthM) / wPx : (k.fy * forced.heightM) / hPx;
    return { spec: forced.label, heightM: forced.heightM, widthM: forced.widthM, depthM };
  }
  if (specs && specs.length) {
    // Score: a spec whose implied distance falls OUTSIDE the hint's range is penalised by how far
    // outside (log-ratio to the nearest bound); inside the range the hint says nothing more, and the
    // model's own size estimate decides, with a small pull toward the range's middle to break ties.
    let best: ChosenSize | null = null;
    let bestScore = Infinity;
    for (const s of specs) {
      const depthM = s.byWidth ? (k.fx * s.widthM) / wPx : (k.fy * s.heightM) / hPx;
      let score = depthM < lo ? Math.log(lo / depthM) : depthM > hi ? Math.log(depthM / hi) : 0;
      if (o.sizeCm.height > 0) score += Math.abs(Math.log(s.heightM / (o.sizeCm.height / 100)));
      score += 0.1 * Math.abs(Math.log(depthM / mid));
      if (score < bestScore) {
        bestScore = score;
        best = { spec: s.label, heightM: s.heightM, widthM: s.widthM, depthM };
      }
    }
    return best!;
  }
  const heightM = o.sizeCm.height > 0 ? clamp(o.sizeCm.height / 100, 0.01, 2) : (DEFAULT_HEIGHT_M[o.kind] ?? 0.1);
  const aspectW = heightM * (wPx / hPx); // fx ≈ fy, so the box aspect is the object's aspect
  const widthM = o.sizeCm.width > 0 ? clamp((o.sizeCm.width / 100 + aspectW) / 2, 0.005, 2) : clamp(aspectW, 0.005, 2);
  return { spec: null, heightM, widthM, depthM: (k.fy * heightM) / hPx };
}

// ---------------------------------------------------------------------------------------------------
// Layout

export interface PlacedObject {
  id: string;
  kind: TwinObjectKind;
  label: string;
  spec: string | null;
  heightM: number;
  widthM: number;
  position: Vec3; // bottom centre, world
  yawRad: number; // rotation about +y so a box's front faces the camera (a held pourer's spout faces its target)
  /** Lean about the layout's view axis, radians, applied after the yaw: positive = the top toward the
   *  camera's right. 0 for anything that stands on something. */
  tiltRad: number;
  heldOver: string; // for a held object, the id of what it is held over ('' if none)
  revolve: boolean;
  rendered: boolean;
  fillLevel: number;
  content: string;
  material: TwinObject['material'];
  confidence: number;
  restingOn: string;
  thermalRole: TwinObject['thermal']['role'];
  bbox: TwinObject['bbox'];
}

export interface TwinLayout {
  camera: TwinCamera;
  /** Unit vector along the camera's view axis in the world — what a held object's tilt turns about. */
  viewDir: Vec3;
  placed: PlacedObject[];
  /** Half-size of the table drawn under the scene, metres. */
  extentM: number;
  /** Where the orbit controls look: the centre of the placed apparatus, a little above the table. */
  focus: Vec3;
  warnings: string[];
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Place every object. Each box's height (or width, for flat things) and its nominal size give the
 * distance along the view axis; the ray through the box's footprint point at that distance gives the
 * contact point in the camera frame. Objects resting on the support surface pin the camera height (the
 * median of what each implies — no prior needed); stacked objects sit on their parent's top.
 */
export interface SolveOptions {
  pitchDeg?: number;
  intrinsics?: TwinIntrinsics;
  /** Owner-chosen nominal spec per object id (a NOMINAL_SIZES label) — see applyTwinEdits. */
  specOverrides?: Record<string, string>;
}

export interface AppliedEdits {
  scene: TwinScene; // the scene with kinds / support relations replaced and hidden objects removed
  hiddenIds: string[];
  specOverrides: Record<string, string>;
  pitchDeg: number | null; // the owner's tilt override, if any
}

/**
 * Apply the owner's corrections (TwinEdits) to a model scene before solving: kind and resting-on
 * overrides replace the model's, hidden objects are dropped (anything that rested on them falls to
 * the support), and spec choices are collected for chooseSize. Pure — the stored scene is untouched.
 */
export function applyTwinEdits(scene: TwinScene, edits: TwinEdits | null | undefined): AppliedEdits {
  const objEdits = edits?.objects ?? {};
  const hiddenIds = scene.objects.filter((o) => objEdits[o.id]?.hidden).map((o) => o.id);
  const hidden = new Set(hiddenIds);
  const specOverrides: Record<string, string> = {};
  const objects: TwinObject[] = [];
  for (const o of scene.objects) {
    if (hidden.has(o.id)) continue;
    const e = objEdits[o.id];
    const restingOn = e?.restingOn ?? o.restingOn;
    objects.push({
      ...o,
      kind: e?.kind ?? o.kind,
      restingOn: restingOn !== 'support' && restingOn !== 'held' && hidden.has(restingOn) ? 'support' : restingOn,
      heldOver: o.heldOver && hidden.has(o.heldOver) ? '' : o.heldOver,
    });
    if (e?.spec) specOverrides[o.id] = e.spec;
  }
  return {
    scene: { ...scene, objects },
    hiddenIds,
    specOverrides,
    pitchDeg: typeof edits?.pitchDeg === 'number' && Number.isFinite(edits.pitchDeg) ? edits.pitchDeg : null,
  };
}

export function solveTwinLayout(scene: TwinScene, opts: SolveOptions = {}): TwinLayout {
  const k = opts.intrinsics ?? twinIntrinsics();
  const pitchDeg = opts.pitchDeg ?? PITCH_DEG[scene.camera.pitch];
  const theta = deg(pitchDeg);
  const warnings: string[] = [];

  // Pass 1: contact points in a camera-oriented frame with the camera at the origin.
  const solved = scene.objects.map((o) => {
    const size = chooseSize(o, scene.camera.distanceHint, k, opts.specOverrides?.[o.id]);
    const u = (o.bbox.x + o.bbox.w / 2) * k.width;
    const v = o.footprintY * k.height;
    const ray = pixelRay(u, v, k);
    const pCam: Vec3 = [ray[0] * size.depthM, ray[1] * size.depthM, -size.depthM];
    return { o, size, pRot: rotX(pCam, -theta) };
  });

  // Camera height: what the support-resting objects imply. Their contact points must lie on y = 0.
  // (Held objects say nothing about it — they are wherever the hand is.)
  const onSupport = solved.filter((s) => s.o.restingOn === 'support');
  let cameraY: number;
  if (onSupport.length) {
    cameraY = median(onSupport.map((s) => -s.pRot[1]));
    if (cameraY < 0.02) {
      warnings.push('The camera would be below the table; the pitch is probably steeper than assumed.');
      cameraY = 0.02;
    }
  } else {
    warnings.push('No object rests on the support surface; camera height defaulted.');
    cameraY = 0.3;
  }
  const camera: TwinCamera = { ...k, pitchDeg, position: [0, cameraY, 0] };
  const viewDir = rotX([0, 0, -1], -theta);

  // Pass 2: world positions. Support objects snap to the plane; children sit on their parent's top;
  // a held object hangs off what it is held over — its spout / rim / bulb at the target's mouth, its
  // body to whichever side the box says, leaning toward the target — or, with no target, floats where
  // its box is at the depth its size implies.
  const byId = new Map(solved.map((s) => [s.o.id, s]));
  const placedById = new Map<string, PlacedObject>();
  /** Top centre of a placed object — where a child stands on it or a pour lands — allowing for its lean. */
  const topOf = (p: PlacedObject): Vec3 => {
    const t = rotAxis([0, p.heightM, 0], viewDir, p.tiltRad);
    return [p.position[0] + t[0], p.position[1] + t[1], p.position[2] + t[2]];
  };
  const TABLE_CLEARANCE = 0.005;
  /**
   * The signed lean that puts the lowest in-frame point of a held pourer's base rim on its box's
   * bottom edge — the one edge of a cut box that still means something (a top or side cut is the
   * frame, not the object). Null when the bottom edge is itself at the frame edge, or when no lean
   * from 5° to 85° gets within a few pixels. Leans that would push the base through the table are
   * not candidates; ties go to the model's own estimate.
   */
  const fitLean = (
    s: (typeof solved)[number],
    side: number,
    modelDeg: number,
    poseFor: (lean: number) => Vec3,
  ): number | null => {
    const bottomFrac = s.o.bbox.y + s.o.bbox.h;
    if (bottomFrac > 0.98) return null;
    const bottomV = bottomFrac * k.height;
    const r = (s.size.widthM / 2) * (s.o.kind === 'kettle' ? 1.05 : 1);
    const lowestV = (lean: number): number | null => {
      const p = poseFor(lean);
      const dip = r * Math.abs(Math.sin(lean));
      if (p[1] - dip < TABLE_CLEARANCE) return null;
      const e1 = rotAxis([1, 0, 0], viewDir, lean);
      const e2 = rotAxis([0, 0, 1], viewDir, lean);
      let vMax = -Infinity;
      for (let i = 0; i < 24; i++) {
        const ph = (i / 24) * 2 * Math.PI;
        const c = Math.cos(ph) * r;
        const sn = Math.sin(ph) * r;
        const pr = projectWorld(
          [p[0] + c * e1[0] + sn * e2[0], p[1] + c * e1[1] + sn * e2[1], p[2] + c * e1[2] + sn * e2[2]],
          camera,
        );
        if (!pr || pr.u < -2 || pr.u > k.width + 2) continue;
        if (pr.v > vMax) vMax = pr.v;
      }
      return Number.isFinite(vMax) ? vMax : null;
    };
    let best: { lean: number; residual: number; score: number } | null = null;
    for (let d = 5; d <= 85; d++) {
      const lean = -side * deg(d);
      const v = lowestV(lean);
      if (v === null) continue;
      const residual = Math.abs(v - bottomV);
      const score = residual + 0.02 * Math.abs(d - modelDeg);
      if (!best || score < best.score) best = { lean, residual, score };
    }
    return best && best.residual < 6 ? best.lean : null;
  };
  const place = (s: (typeof solved)[number], path: ReadonlySet<string>): PlacedObject => {
    const cached = placedById.get(s.o.id);
    if (cached) return cached;
    // `path` is the chain of objects whose placement is waiting on this one. A restingOn / heldOver
    // that leads back into it is a loop (a model slip, or an owner's edit: "the tripod stands on the
    // beaker that stands on it"), which would otherwise stack copies into the air; the re-entered
    // object is placed as if it named nothing, with a warning.
    const via = new Set(path).add(s.o.id);
    const resolve = (id: string, relation: string): PlacedObject | null => {
      const other = byId.get(id);
      if (!other) return null;
      if (via.has(id)) {
        warnings.push(
          `${s.o.label || s.o.id} ${relation} ${other.o.label || id}, which in turn depends on it; the loop was ignored.`,
        );
        return null;
      }
      return place(other, via);
    };
    let position: Vec3;
    let tiltRad = 0;
    let yawRad: number | null = null;
    const held = s.o.restingOn === 'held';
    const parent = !held && s.o.restingOn !== 'support' ? resolve(s.o.restingOn, 'rests on') : null;
    if (parent) {
      position = topOf(parent);
    } else if (held) {
      const target = s.o.heldOver ? resolve(s.o.heldOver, 'is held over') : null;
      const uc = (s.o.bbox.x + s.o.bbox.w / 2) * k.width;
      const vc = (s.o.bbox.y + s.o.bbox.h / 2) * k.height;
      // Lean: the model's magnitude; the direction toward the target when there is one (a pour tips
      // toward what it pours into), else the model's sign (positive = top toward the image's right).
      const tiltDeg = Number.isFinite(s.o.tiltDeg) ? (s.o.tiltDeg as number) : 0;
      const magnitude = deg(Math.min(90, Math.abs(tiltDeg)));
      const modelSign = Math.sign(tiltDeg) || 1;
      if (target) {
        // Anchored on the target: the point of contact (a spout tip, a rim, a thermometer's bulb) sits
        // over the target's mouth; the body extends to whichever side of the mouth the box centre
        // lies, +x (the spout) pointing back at the target, the top leaning toward it. The box's SIZE
        // is deliberately unused — a pourer is usually part-way out of the frame, so its box is cut.
        const mouth = topOf(target);
        const mp = projectWorld(mouth, camera);
        const side = mp && uc < mp.u ? -1 : 1; // the body is to the target's left (−x) or right (+x)
        yawRad = side > 0 ? Math.PI : 0;
        const anchor = holdAnchor(s.o.kind, s.size.heightM, s.size.widthM, target.heightM);
        const l = anchor.local;
        // Something dipped in ON the target's axis (a thermometer) has no side to lean from — its box
        // centre is wherever its top went — so it keeps the lean the model saw.
        const onAxis = l[0] === 0 && l[2] === 0;
        const cy = Math.cos(yawRad);
        const sy = Math.sin(yawRad);
        // A wide target: the anchor over the mouth's CENTRE would put the pourer's body through the
        // target's rim when the spout is shorter than the mouth is wide, so back the body off along
        // its side until the spout is over the near rim instead.
        const back = Math.max(0, target.widthM / 2 - anchor.reachM);
        /** Bottom centre for a given (signed) lean, everything else held. */
        const poseFor = (lean: number): Vec3 => {
          const a = rotAxis([l[0] * cy + l[2] * sy, l[1], -l[0] * sy + l[2] * cy], viewDir, lean);
          const p: Vec3 = [mouth[0] - a[0], mouth[1] + anchor.gapM - a[1], mouth[2] - a[2]];
          if (Number.isFinite(back) && back > 0) p[0] += side * back;
          return p;
        };
        tiltRad = onAxis ? modelSign * magnitude : -side * magnitude;
        if (!onAxis) {
          // With the spout pinned over the mouth, the lean alone decides how low the body hangs, and
          // the photo says where the body's lowest point is: fit the lean to the box's bottom edge
          // rather than trust the model's guess at an angle (which runs 15–20° shallow on a pour).
          const fitted = fitLean(s, side, Math.min(90, Math.abs(tiltDeg)), poseFor);
          if (fitted !== null) tiltRad = fitted;
        }
        position = poseFor(tiltRad);
      } else {
        // Nothing to hang off: the box centre is the object's centre, at the depth its size implies —
        // kept within the distance hint, since a cut box (a pourer half out of frame) implies a
        // distance that is nonsense — and its bottom sits half a (leaning) height below.
        const [lo, hi] = DISTANCE_RANGE_M[scene.camera.distanceHint];
        const depthM = Math.min(hi, Math.max(lo, s.size.depthM));
        const ray = pixelRay(uc, vc, k);
        const centre = camToWorld([ray[0] * depthM, ray[1] * depthM, -depthM], camera);
        tiltRad = modelSign * magnitude;
        const up = rotAxis([0, 1, 0], viewDir, tiltRad);
        position = [
          centre[0] - (up[0] * s.size.heightM) / 2,
          centre[1] - (up[1] * s.size.heightM) / 2,
          centre[2] - (up[2] * s.size.heightM) / 2,
        ];
      }
      // The lowest point of the (leaning) base stays above the table: a hand does not go through it.
      // Lifting an anchored pourer raises its spout off the mouth — it then pours from higher up,
      // which is what a person does with a tall kettle over a low beaker; only a large drop is odd
      // enough to mention.
      const dip = (s.size.widthM / 2) * Math.abs(Math.sin(tiltRad));
      if (position[1] - dip < TABLE_CLEARANCE) {
        const lift = TABLE_CLEARANCE + dip - position[1];
        position[1] = TABLE_CLEARANCE + dip;
        if (target && lift > 0.08) {
          warnings.push(
            `${s.o.label || s.o.id} sits ${Math.round(lift * 100)} cm higher than its lean would put it, to stay above the table; it pours into ${target.label || target.id} from above.`,
          );
        }
      }
    } else {
      position = [s.pRot[0], 0, s.pRot[2] + 0]; // y pinned to the support plane
      position = [position[0] + camera.position[0], 0, position[2] + camera.position[2]];
    }
    if (yawRad === null) yawRad = Math.atan2(camera.position[0] - position[0], camera.position[2] - position[2]);
    const placed: PlacedObject = {
      id: s.o.id,
      kind: s.o.kind,
      label: s.o.label,
      spec: s.size.spec,
      heightM: s.size.heightM,
      widthM: s.size.widthM,
      position,
      yawRad,
      tiltRad,
      heldOver: held ? (s.o.heldOver ?? '') : '',
      revolve: REVOLVE_KINDS.has(s.o.kind),
      rendered: !NON_RENDERED_KINDS.has(s.o.kind),
      fillLevel: s.o.fill.level,
      content: s.o.fill.content,
      material: s.o.material,
      confidence: s.o.confidence,
      restingOn: s.o.restingOn,
      thermalRole: s.o.thermal.role,
      bbox: s.o.bbox,
    };
    placedById.set(s.o.id, placed);
    return placed;
  };
  const placed = solved.map((s) => place(s, new Set()));

  const drawn = placed.filter((p) => p.rendered);
  const pts = drawn.length ? drawn : placed;
  let extentM = 0.5;
  const focus: Vec3 = [0, 0.05, 0];
  if (pts.length) {
    focus[0] = pts.reduce((a, p) => a + p.position[0], 0) / pts.length;
    focus[2] = pts.reduce((a, p) => a + p.position[2], 0) / pts.length;
    focus[1] = 0.05 + pts.reduce((a, p) => a + p.position[1] + p.heightM / 2, 0) / pts.length / 2;
    const reach = Math.max(
      ...pts.map((p) => Math.hypot(p.position[0] - focus[0], p.position[2] - focus[2]) + p.widthM / 2),
    );
    extentM = Math.max(0.5, reach + 0.3);
  }
  return { camera, viewDir, placed, extentM, focus, warnings };
}
