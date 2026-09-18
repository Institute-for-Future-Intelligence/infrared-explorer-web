/*
 * Street View normaliser — flatten a `streetviews/{svId}` Firestore doc into the
 * `StreetView` the web map + viewer consume. Ported from the app's
 * lib/streetViewBrowse.ts::toStreetViewMarker, adapted to the web Firestore SDK
 * (location is a GeoPoint instance, createdAt a Timestamp — not the app's decoded
 * REST shapes). Handles BOTH producer shapes: legacy seed (top-level
 * azimuthDeg[]/pitchDeg[]/neighbors) and app upload (shots[]). See
 * docs/street-view-web-plan.md §2.
 */

import { GeoPoint, Timestamp } from 'firebase/firestore';
import type { DocumentData, DocumentSnapshot } from 'firebase/firestore';
import { Visibility } from '../types';
import type { StreetView, StreetViewNeighbor } from '../types';

/**
 * What the map page should do with `?sv=` on this pass.
 *
 *  - `wait`       — the set isn't loaded yet; decide when it is.
 *  - `forget`     — there is no link; a later ?sv=, even the same one, counts as new.
 *  - `ignore`     — this link has already been acted on once. Deliberately NOT the same as
 *                   "the viewer is open": closing the viewer is an urgent state update while
 *                   the URL is rewritten inside a React transition (RouterProvider
 *                   v7_startTransition), so for one render the address still says ?sv=<id>
 *                   with nothing open. Without this the page read that as a link to follow
 *                   and re-opened what the reader had just shut — the two-click close.
 *  - `remember`   — the viewer is already showing it (opened from a marker or a neighbour
 *                   jump, with the link only following); mark it so the close above is quiet.
 *  - `open`       — a link nobody has followed yet: resolve it and show it.
 */
export type DeepLinkAction = 'wait' | 'forget' | 'ignore' | 'remember' | 'open';

export function deepLinkAction(args: {
  /** The ?sv= on the address now (null when absent). */
  deepLinkId: string | null;
  /** Whether the public set is still loading. */
  loading: boolean;
  /** The street view the viewer is showing, if any. */
  selectedId: string | null;
  /** The last ?sv= this page opened or acknowledged. */
  openedId: string | null;
}): DeepLinkAction {
  const { deepLinkId, loading, selectedId, openedId } = args;
  if (!deepLinkId) return 'forget';
  if (loading) return 'wait';
  if (openedId === deepLinkId) return 'ignore';
  if (selectedId === deepLinkId) return 'remember';
  return 'open';
}

/** Coerce a field to a finite-number array (Firestore numbers arrive mixed). */
function numberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    if (typeof x === 'number' && Number.isFinite(x)) out.push(x);
  }
  return out;
}

/** Read `neighbors` (array of {azimuthDeg, svId}) off a doc. */
function readNeighbors(v: unknown): StreetViewNeighbor[] {
  if (!Array.isArray(v)) return [];
  const out: StreetViewNeighbor[] = [];
  for (const n of v) {
    if (
      n &&
      typeof n === 'object' &&
      typeof (n as { svId?: unknown }).svId === 'string' &&
      typeof (n as { azimuthDeg?: unknown }).azimuthDeg === 'number'
    ) {
      const nn = n as { azimuthDeg: number; svId: string };
      out.push({ azimuthDeg: nn.azimuthDeg, svId: nn.svId });
    }
  }
  return out;
}

/** A GeoPoint instance, or any {latitude, longitude} object (emulator/REST), or null. */
function readLatLng(loc: unknown): { lat: number; lng: number } | null {
  if (loc instanceof GeoPoint) return { lat: loc.latitude, lng: loc.longitude };
  if (loc && typeof loc === 'object') {
    const o = loc as { latitude?: unknown; longitude?: unknown };
    if (typeof o.latitude === 'number' && typeof o.longitude === 'number') {
      return { lat: o.latitude, lng: o.longitude };
    }
  }
  return null;
}

/**
 * Map a `streetviews` snapshot to a StreetView, or null when it lacks a usable
 * location. Reads per-frame orientation from `azimuthDeg`/`pitchDeg` number arrays
 * (seed + hydrate shape); falls back to `shots[]` (app-upload shape). The map query
 * projects the heavy arrays away, so on a light doc these are empty until the full
 * doc is hydrated on click.
 */
export function toStreetView(snap: DocumentSnapshot<DocumentData>): StreetView | null {
  const f = snap.data();
  if (!f) return null;
  const ll = readLatLng(f.location);
  if (!ll) return null;

  let azimuthDeg = numberArray(f.azimuthDeg);
  let pitchDeg = numberArray(f.pitchDeg);
  if (azimuthDeg.length === 0 && Array.isArray(f.shots)) {
    // Legacy app-upload shots[] = [{index, azimuthDeg, pitchDeg}].
    const shots = f.shots as Array<Record<string, unknown>>;
    azimuthDeg = shots.map((s) => (typeof s.azimuthDeg === 'number' ? s.azimuthDeg : 0));
    pitchDeg = shots.map((s) => (typeof s.pitchDeg === 'number' ? s.pitchDeg : 0));
  }
  const frameCount = typeof f.frameCount === 'number' && f.frameCount > 0 ? f.frameCount : azimuthDeg.length;

  const sourceType: 'single' | 'pano' =
    f.sourceType === 'single' || f.sourceType === 'pano' ? f.sourceType : frameCount > 1 ? 'pano' : 'single';

  const createdAt = f.createdAt instanceof Timestamp ? f.createdAt : undefined;
  const date = f.date instanceof Timestamp ? f.date : undefined;

  return {
    svId: snap.id,
    ownerId: typeof f.ownerId === 'string' ? f.ownerId : '',
    // Legacy seed docs predate both fields; an absent visibility is public (that is what the
    // seed always was) and an absent trash is not trashed.
    visibility: (f.visibility as StreetView['visibility']) ?? Visibility.Public,
    trash: f.trash === true,
    hiddenByReports: f.hiddenByReports === true,
    lat: ll.lat,
    lng: ll.lng,
    title: typeof f.displayName === 'string' && f.displayName ? f.displayName : snap.id,
    author: typeof f.author === 'string' ? f.author : '',
    sourceType,
    frameCount,
    palette: typeof f.palette === 'string' ? f.palette : undefined,
    thermalUnit: typeof f.thermalUnit === 'string' ? f.thermalUnit : undefined,
    azimuthDeg,
    pitchDeg,
    neighbors: readNeighbors(f.neighbors),
    capturedAt: (createdAt ?? date)?.toMillis(),
    virUrl: typeof f.virUrl === 'string' ? f.virUrl : undefined,
    streamUrl: typeof f.streamUrl === 'string' ? f.streamUrl : undefined,
    videoDurationSec: typeof f.videoDurationSec === 'number' ? f.videoDurationSec : undefined,
    panoUrl: typeof f.panoUrl === 'string' ? f.panoUrl : undefined,
    panoSpanDeg: typeof f.panoSpanDeg === 'number' ? f.panoSpanDeg : undefined,
    panoTempUrl: typeof f.panoTempUrl === 'string' ? f.panoTempUrl : undefined,
    panoTempW: typeof f.panoTempW === 'number' ? f.panoTempW : undefined,
    panoTempH: typeof f.panoTempH === 'number' ? f.panoTempH : undefined,
    tMin: typeof f.tMin === 'number' ? f.tMin : undefined,
    tMax: typeof f.tMax === 'number' ? f.tMax : undefined,
  };
}
