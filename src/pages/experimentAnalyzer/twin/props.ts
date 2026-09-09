/**
 * Parametric lab props for the 3D digital twin (docs/digital-twin-plan.md §7). Every prop is built from
 * a few primitives with its origin at the bottom centre and +y up, sized from the solver's metres, so
 * the same beaker code draws a 50 mL and a 1000 mL one. No external model assets: a lathe profile is a
 * dozen numbers, and the whole library is a few kilobytes in the lazy three.js chunk.
 *
 * `body` is the surface the heat map is painted on (one merged geometry per prop); `liquid` is the
 * contents, drawn from the fill level; `extras` are things that never take the thermal paint (a flame).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { KETTLE_SHAPE, type PlacedObject } from '../../../utils/twinSolver';
import type { TwinObjectKind } from '../../../types';

export interface PropExtra {
  geometry: THREE.BufferGeometry;
  color: string;
  emissive?: string;
  opacity?: number;
}

export interface PropParts {
  body: THREE.BufferGeometry;
  /** Body vertices [0, revolvedUntil) are the revolved shell; the rest are struts, spouts, handles,
   *  bulbs — parts the heat-map's height profile must neither be built from nor applied to. */
  revolvedUntil: number;
  liquid: THREE.BufferGeometry | null;
  liquidColor: string;
  extras: PropExtra[];
  baseColor: string;
  opacity: number; // realistic-mode opacity (glass and plastic are see-through)
  metalness: number;
}

type Profile = [number, number][]; // [radius, y] pairs, bottom → top

const SEGMENTS = 40;

/** The heat map is painted per vertex and interpolated across triangles, so a ring spacing coarser than
 *  the features in the frame (a water line, a hot base) would smear a narrow band up the whole body
 *  or miss it between two rings. Profiles are densified to this ring spacing before revolving. */
const PAINT_STEP_M = 0.003;

/** Insert points along a profile so consecutive rings are at most PAINT_STEP_M apart; the original
 *  corners stay, so the silhouette and its normals are unchanged. */
const densify = (profile: Profile): Profile => {
  const out: Profile = [profile[0]];
  for (let i = 1; i < profile.length; i++) {
    const [r0, y0] = profile[i - 1];
    const [r1, y1] = profile[i];
    const n = Math.min(64, Math.max(1, Math.ceil(Math.hypot(r1 - r0, y1 - y0) / PAINT_STEP_M)));
    for (let k = 1; k <= n; k++) out.push([r0 + ((r1 - r0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  return out;
};

const lathe = (profile: Profile, segments = SEGMENTS): THREE.BufferGeometry =>
  new THREE.LatheGeometry(
    densify(profile).map(([r, y]) => new THREE.Vector2(Math.max(0, r), y)),
    segments,
  );

/** Height segments so a cylinder's rings are as dense as a lathe's (the paint is per vertex). */
const ringsFor = (h: number) => Math.max(1, Math.min(200, Math.ceil(h / PAINT_STEP_M)));

const cylinder = (rTop: number, rBottom: number, h: number, y0: number, x = 0, z = 0): THREE.BufferGeometry =>
  new THREE.CylinderGeometry(rTop, rBottom, h, 24, ringsFor(h)).translate(x, y0 + h / 2, z);

const box = (w: number, h: number, d: number, y0: number, x = 0, z = 0): THREE.BufferGeometry =>
  new THREE.BoxGeometry(w, h, d).translate(x, y0 + h / 2, z);

const ringFlat = (radius: number, tube: number, y: number, x = 0, z = 0): THREE.BufferGeometry =>
  new THREE.TorusGeometry(radius, tube, 10, 32).rotateX(Math.PI / 2).translate(x, y, z);

const sphere = (r: number, y: number): THREE.BufferGeometry => new THREE.SphereGeometry(r, 20, 14).translate(0, y, 0);

const cone = (r: number, h: number, y0: number): THREE.BufferGeometry =>
  new THREE.ConeGeometry(r, h, 16).translate(0, y0 + h / 2, 0);

/** A cylinder from point a to point b (a strut, a leg). */
const strut = (a: THREE.Vector3, b: THREE.Vector3, r: number): THREE.BufferGeometry => {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r, r, len, 10, ringsFor(len));
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  g.applyQuaternion(q);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
};

/** A strut that narrows from radius rA at a to rB at b (a spout, a neck). */
const taperedStrut = (a: THREE.Vector3, b: THREE.Vector3, rA: number, rB: number): THREE.BufferGeometry => {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(rB, rA, len, 14, ringsFor(len));
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  g.applyQuaternion(q);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
};

/** Merge into one geometry (the thermal paint wants a single vertex list per prop). Geometries from the
 *  primitives above all carry position/normal/uv, which is what mergeGeometries requires. */
const merge = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => {
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  if (!merged) return new THREE.BufferGeometry();
  return merged;
};

/** Radius of a profile at height y (linear between its points), for a liquid surface. */
const radiusAt = (profile: Profile, y: number): number => {
  for (let i = 1; i < profile.length; i++) {
    const [r0, y0] = profile[i - 1];
    const [r1, y1] = profile[i];
    if (y >= Math.min(y0, y1) && y <= Math.max(y0, y1)) {
      if (y1 === y0) return Math.max(r0, r1);
      return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
    }
  }
  return profile[profile.length - 1][0];
};

/** The contents of a lathe-shaped container filled to height `hf`: the wall profile shrunk a little,
 *  closed flat on top. */
const latheFill = (profile: Profile, hf: number): THREE.BufferGeometry | null => {
  if (hf <= 0.002) return null;
  const inner: Profile = [[0, 0.001]];
  for (const [r, y] of profile) if (y > 0.001 && y < hf) inner.push([r * 0.94, y]);
  inner.push([radiusAt(profile, hf) * 0.94, hf], [0, hf]);
  return lathe(inner);
};

const MATERIAL_COLOR: Record<PlacedObject['material'], { color: string; opacity: number; metalness: number }> = {
  glass: { color: '#dcefff', opacity: 0.42, metalness: 0.05 },
  plastic: { color: '#bfe3c6', opacity: 0.6, metalness: 0.02 },
  metal: { color: '#b8bec6', opacity: 1, metalness: 0.75 },
  ceramic: { color: '#f1efe9', opacity: 1, metalness: 0.05 },
  wood: { color: '#b98a5a', opacity: 1, metalness: 0 },
  paper: { color: '#f4f1e8', opacity: 1, metalness: 0 },
  liquid: { color: '#8fc7ff', opacity: 0.55, metalness: 0 },
  organic: { color: '#a6c48a', opacity: 1, metalness: 0 },
  other: { color: '#a3a8ae', opacity: 1, metalness: 0.1 },
};

const KIND_COLOR: Partial<Record<TwinObjectKind, { color: string; opacity?: number; metalness?: number }>> = {
  ice: { color: '#dff4ff', opacity: 0.7 },
  candle: { color: '#fff4d6' },
  hot_plate: { color: '#3b3f44', metalness: 0.4 },
  tripod: { color: '#6d7278', metalness: 0.7 },
  ring_stand: { color: '#6d7278', metalness: 0.7 },
  wire_gauze: { color: '#8a8f95', metalness: 0.5 },
  bunsen_burner: { color: '#8a8f95', metalness: 0.6 },
  alcohol_lamp: { color: '#dcefff', opacity: 0.42 },
  thermometer: { color: '#eef4ff', opacity: 0.8 },
  test_tube_rack: { color: '#c9a978' },
};

const liquidColorFor = (content: string): string => {
  const c = content.toLowerCase();
  if (/oil/.test(c)) return '#e8c34a';
  if (/milk/.test(c)) return '#f5f2ea';
  if (/ethanol|alcohol|spirit/.test(c)) return '#bfe2ff';
  if (/juice|coffee|tea/.test(c)) return '#b8743a';
  return '#4f9cf5';
};

const FLAME = { color: '#ffb347', emissive: '#ff7a1a', opacity: 0.85 };

/** Build the geometry for one placed object. Everything is in metres, origin at the bottom centre. */
export function buildProp(o: PlacedObject): PropParts {
  const H = Math.max(0.003, o.heightM);
  const D = Math.max(0.004, o.widthM);
  const r = D / 2;
  let body: THREE.BufferGeometry;
  let liquid: THREE.BufferGeometry | null = null;
  const extras: PropExtra[] = [];
  const fillH = Math.min(0.95, Math.max(0, o.fillLevel)) * H;
  // −1 = the whole body is the revolved shell; merged props set it to the shell's vertex count.
  let revolvedUntil = -1;

  switch (o.kind) {
    case 'beaker': {
      const p: Profile = [
        [0, 0],
        [r * 0.98, 0],
        [r, 0.02 * H],
        [r, 0.95 * H],
        [r * 1.05, H],
      ];
      body = lathe(p);
      liquid = latheFill(p, fillH);
      break;
    }
    case 'erlenmeyer_flask': {
      const p: Profile = [
        [0, 0],
        [r, 0],
        [r, 0.15 * H],
        [r * 0.28, 0.72 * H],
        [r * 0.28, 0.9 * H],
        [r * 0.33, H],
      ];
      body = lathe(p);
      liquid = latheFill(p, Math.min(fillH, 0.7 * H));
      break;
    }
    case 'test_tube': {
      const p: Profile = [[0, 0]];
      for (let i = 1; i <= 5; i++) {
        const a = (i / 5) * (Math.PI / 2);
        p.push([r * Math.sin(a), r * (1 - Math.cos(a))]);
      }
      p.push([r, H]);
      body = lathe(p);
      liquid = latheFill(p, fillH);
      break;
    }
    case 'graduated_cylinder': {
      const p: Profile = [
        [0, 0],
        [r * 2.2, 0],
        [r * 2.2, 0.03 * H],
        [r, 0.035 * H],
        [r, 0.97 * H],
        [r * 1.15, H],
      ];
      body = lathe(p);
      liquid = latheFill(p, Math.max(fillH, 0));
      break;
    }
    case 'bottle': {
      const p: Profile = [
        [0, 0],
        [r * 0.95, 0],
        [r, 0.05 * H],
        [r, 0.68 * H],
        [r * 0.45, 0.8 * H],
        [r * 0.45, 0.97 * H],
        [r * 0.5, H],
      ];
      body = lathe(p);
      liquid = latheFill(p, fillH);
      break;
    }
    case 'cup': {
      const p: Profile = [
        [0, 0],
        [r * 0.85, 0],
        [r, H],
      ];
      body = lathe(p);
      liquid = latheFill(p, fillH);
      break;
    }
    case 'pot': {
      const p: Profile = [
        [0, 0],
        [r, 0],
        [r, H],
      ];
      body = lathe(p);
      liquid = latheFill(p, fillH);
      break;
    }
    case 'kettle': {
      // An electric kettle: a plinth, a gently tapered cylindrical body, a domed lid, a short spout at
      // the front-top (+x, where the solver points it at whatever it pours into — KETTLE_SHAPE is shared
      // so the spout tip lands where the solver anchors it) and a handle at the back.
      const K = KETTLE_SHAPE;
      const p: Profile = [
        [0, 0],
        [r * 1.05, 0],
        [r * 1.05, 0.05 * H],
        [r * 0.96, 0.06 * H],
        [r, 0.14 * H],
        [r * 0.93, 0.78 * H],
        [r * 0.8, 0.82 * H],
        [r * 0.8, 0.86 * H],
        [r * 0.55, 0.9 * H],
        [r * 0.4, 0.96 * H],
        [r * 0.14, H],
        [0, H],
      ];
      // A short, wide pouring spout: broad where it leaves the shoulder, narrowing to the tip.
      const spoutBase = new THREE.Vector3(r * K.spoutBaseX, H * K.spoutBaseY, 0);
      const spoutTip = new THREE.Vector3(r * K.spoutTipX, H * K.spoutTipY, 0);
      const spout = taperedStrut(spoutBase, spoutTip, r * 0.22, r * 0.11);
      const lip = sphere(r * 0.11, 0).translate(spoutTip.x, spoutTip.y, 0);
      const hr = r * 0.07;
      const h0 = new THREE.Vector3(-r * 0.9, 0.3 * H, 0);
      const h1 = new THREE.Vector3(-r * 1.4, 0.5 * H, 0);
      const h2 = new THREE.Vector3(-r * 1.3, 0.95 * H, 0);
      const h3 = new THREE.Vector3(-r * 0.45, 0.9 * H, 0); // ends inside the lid dome (0.55 r there)
      const handle = [
        strut(h0, h1, hr),
        strut(h1, h2, hr),
        strut(h2, h3, hr),
        sphere(hr, 0).translate(h1.x, h1.y, 0),
        sphere(hr, 0).translate(h2.x, h2.y, 0),
      ];
      const shell = lathe(p);
      revolvedUntil = shell.getAttribute('position').count;
      body = merge([shell, spout, lip, ...handle]);
      liquid = latheFill(p, Math.min(fillH, 0.75 * H));
      break;
    }
    case 'petri_dish': {
      body = lathe([
        [0, 0],
        [r, 0],
        [r, H],
      ]);
      liquid = latheFill(
        [
          [0, 0],
          [r, 0],
          [r, H],
        ],
        fillH,
      );
      break;
    }
    case 'alcohol_lamp': {
      const p: Profile = [
        [0, 0],
        [r * 0.9, 0],
        [r, 0.35 * H],
        [r * 0.7, 0.65 * H],
        [r * 0.3, 0.72 * H],
        [r * 0.3, 0.85 * H],
      ];
      const shell = lathe(p);
      revolvedUntil = shell.getAttribute('position').count;
      body = merge([shell, cylinder(r * 0.05, r * 0.05, 0.12 * H, 0.85 * H)]);
      liquid = latheFill(p, Math.min(fillH || 0.35 * H, 0.6 * H));
      extras.push({ geometry: cone(r * 0.14, 0.45 * H, 0.93 * H), ...FLAME });
      break;
    }
    case 'bunsen_burner': {
      const p: Profile = [
        [0, 0],
        [r, 0],
        [r, 0.12 * H],
        [r * 0.35, 0.14 * H],
        [r * 0.35, 0.2 * H],
        [r * 0.13, 0.22 * H],
        [r * 0.13, H],
      ];
      body = lathe(p);
      extras.push({ geometry: cone(r * 0.12, 0.4 * H, H), color: '#7cc4ff', emissive: '#3b8bff', opacity: 0.8 });
      break;
    }
    case 'candle': {
      body = lathe([
        [0, 0],
        [r, 0],
        [r, H],
      ]);
      extras.push({ geometry: cone(r * 0.8, Math.max(0.02, 0.25 * H), H), ...FLAME });
      break;
    }
    case 'hot_plate': {
      body = merge([box(D, 0.85 * H, D * 0.85, 0), cylinder(r * 0.88, r * 0.88, 0.15 * H, 0.85 * H)]);
      break;
    }
    case 'tripod': {
      const legs: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
        legs.push(
          strut(
            new THREE.Vector3(r * Math.cos(a), 0, r * Math.sin(a)),
            new THREE.Vector3(r * 0.92 * Math.cos(a), H, r * 0.92 * Math.sin(a)),
            0.005,
          ),
        );
      }
      body = merge([...legs, ringFlat(r * 0.9, 0.005, H)]);
      break;
    }
    case 'wire_gauze': {
      body = box(D, Math.max(0.003, H), D, 0);
      break;
    }
    case 'ring_stand': {
      const base = box(D, 0.012, D * 0.6, 0);
      const rod = cylinder(0.006, 0.006, H, 0.012, 0, -D * 0.2);
      const ring = ringFlat(0.035, 0.005, 0.6 * H, 0, 0.02);
      body = merge([base, rod, ring]);
      break;
    }
    case 'clamp': {
      body = box(D, H, 0.03, 0);
      break;
    }
    case 'thermometer': {
      const rr = Math.max(r, 0.003);
      const stem = cylinder(rr, rr, H, 0);
      revolvedUntil = stem.getAttribute('position').count;
      body = merge([stem, sphere(rr * 1.6, rr * 1.6)]);
      break;
    }
    case 'test_tube_rack': {
      body = box(D, H, D * 0.4, 0);
      break;
    }
    default: {
      // metal_block, ice, other, and the people/device kinds (which the scene never draws anyway).
      body = box(D, H, D * 0.6, 0);
    }
  }

  const mat = MATERIAL_COLOR[o.material] ?? MATERIAL_COLOR.other;
  const kindOverride = KIND_COLOR[o.kind];
  return {
    body,
    revolvedUntil: revolvedUntil < 0 ? (body.getAttribute('position')?.count ?? 0) : revolvedUntil,
    liquid,
    liquidColor: liquidColorFor(o.content),
    extras,
    baseColor: kindOverride?.color ?? mat.color,
    opacity: kindOverride?.opacity ?? mat.opacity,
    metalness: kindOverride?.metalness ?? mat.metalness,
  };
}

/** Human label for a kind ("erlenmeyer_flask" → "Erlenmeyer flask"). */
export const kindLabel = (kind: TwinObjectKind): string => {
  const words = kind.replace(/_/g, ' ');
  return kind === 'erlenmeyer_flask' ? 'Erlenmeyer flask' : kind === 'bunsen_burner' ? 'Bunsen burner' : words;
};
