/**
 * The selection a revision note on a scene twin is about (docs/digital-twin-plan.md §28): items the frame
 * announced (a click on a face of a box, or on a round mesh), told apart by a key, and checked field by
 * field when they arrive from the frame (which reports on what an untrusted program built, so nothing is
 * taken on trust). A whole part (mesh and face null) is what the server also takes; nothing in the UI makes one
 * since §28.4 — the revision box's list of parts went, and it shows the selection nowhere (the frame does).
 */
import type { TwinSelectionItem } from '../types';

const FACES = new Set(['front', 'back', 'left', 'right', 'top', 'bottom']);
const LABEL_MAX = 120;
const PART_MAX = 80;
/** As many items as the server takes on one note (TWIN_NOTE_PARTS_MAX in functions/src/twinBuilding.ts). */
export const SELECTION_MAX = 24;

const finite3 = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/** An item the frame announced, checked; null when any field is not what the frame writes. */
export function validSelectionItem(raw: unknown): TwinSelectionItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.part !== 'string' || !o.part || o.part.length > PART_MAX) return null;
  const mesh = o.mesh === null || o.mesh === undefined ? null : o.mesh;
  if (mesh !== null && !(Number.isInteger(mesh) && (mesh as number) >= 0)) return null;
  const face = o.face === null || o.face === undefined ? null : o.face;
  if (face !== null && !(typeof face === 'string' && FACES.has(face))) return null;
  const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim().slice(0, LABEL_MAX) : o.part;
  return {
    part: o.part,
    mesh: mesh as number | null,
    face: face as TwinSelectionItem['face'],
    ...(typeof o.kind === 'string' && o.kind ? { kind: o.kind.slice(0, 24) } : {}),
    ...(typeof o.round === 'boolean' ? { round: o.round } : {}),
    ...(finite3(o.center) ? { center: o.center } : {}),
    ...(finite3(o.size) ? { size: o.size } : {}),
    ...(Number.isInteger(o.meshes) && (o.meshes as number) >= 1 ? { meshes: o.meshes as number } : {}),
    label,
  };
}
