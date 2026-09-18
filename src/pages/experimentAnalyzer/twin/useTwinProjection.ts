/**
 * The registered photos of a scene twin, loaded for the viewer frame to project (docs/digital-twin-plan.md
 * §18.8): for every photo that reached the model with a fitted camera (registeredPhotos), its thermal
 * frame (recordings/<id>/data_N.dat, N the stored photo number), decoded, masked — the unreadable pixels
 * and, outdoors, the sky — and packed with its camera as the frame's `photos` (utils/twinProjection.ts).
 *
 * The frames load together and arrive together; one that fails to load or decode is left out (with a
 * warning), never fatal — its faces keep their one value. A new record cancels a load in flight. The
 * load is keyed on what the projection is made of — the registered photos, their cameras and
 * registrations, the sky cut — not on the record object, which Firestore hands over afresh with every
 * snapshot of the experiment: an unrelated change to the experiment must not reload the frames, flash the
 * projection off and on, or make the frame redraw its depth maps.
 */
import { useEffect, useMemo, useState } from 'react';
import type { TwinBuildingThermal, TwinSubjectKind } from '../../../types';
import { fetchRecordingFrameBufferCached } from '../../../utils/recordingFrame';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { plateauEqualization } from '../../../utils/twinThermal';
import {
  THERMAL_H,
  THERMAL_W,
  TWIN_PROJECTION_MAX,
  type TwinProjectionPhoto,
  type TwinShot,
  maskTemps,
  photoLabel,
  projectionPhotos,
  registeredPhotos,
  type SkyReading,
  skyCut,
  skyReading,
} from '../../../utils/twinProjection';

export interface TwinProjection {
  /** What the frame is sent: the registered photos whose frames loaded — empty while they load, and for
   *  a record without registered photos. The same array until the projection's inputs change. */
  photos: TwinProjectionPhoto[];
  loading: boolean;
  /** What the sky read across the loaded frames (the median of each frame's skyTemperature), °C, for
   *  the viewer's background; null while loading, for an interior, and when no frame shows sky. */
  skyTempC: number | null;
  /** Each loaded photo's own sky reading (skyReading), by photo number, for the photo the colours follow. */
  sky: ReadonlyMap<number, SkyReading>;
  /** Each loaded photo's own colour mapping, by photo number: the frame's min and max (its valid pixels,
   *  the sky included, as the SDK's AGC takes them) and plateauEqualization's palette position per 256th
   *  of that range — what paints the model in the photo's own colours (photoMatchedPalette). */
  agc: ReadonlyMap<number, PhotoAgc>;
}

export interface PhotoAgc {
  min: number;
  max: number;
  map: Float32Array;
}

/** A frame's range as the SDK's AGC takes it: every pixel with a value (the sentinel aside), the sky too. */
function frameAgc(temps: ArrayLike<number>): PhotoAgc | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < temps.length; i++) {
    const c = temps[i];
    if (!(c > -100)) continue;
    if (c < min) min = c;
    if (c > max) max = c;
  }
  if (!Number.isFinite(min) || !(max > min)) return null;
  return { min, max, map: plateauEqualization(temps, min, max) };
}

const NO_PHOTOS: TwinProjectionPhoto[] = [];
const NO_AGC: ReadonlyMap<number, PhotoAgc> = new Map();
const NO_SKY: ReadonlyMap<number, SkyReading> = new Map();

/**
 * `subjectKind` decides whether the frames are cut at the skyline (maskTemps' flood from the top edge).
 * A room has no sky: the top of its pictures is ceiling, wall or a window — surfaces of the model — and
 * whatever of them reads colder than the cut and touches the top edge (a cold ceiling, an air outlet, a
 * window at night) would be flooded away and never projected, so an interior is masked for unreadable
 * pixels only. An apparatus keeps the flood: there it strips the background from a hot device's outline.
 */
export function useTwinProjection(
  recordingId: string | undefined,
  thermal: TwinBuildingThermal | null | undefined,
  shot: TwinShot,
  subjectKind: TwinSubjectKind | undefined,
): TwinProjection {
  // Everything the projection is made of, as one string ('' when there is nothing to project).
  const signature = useMemo(() => {
    const registered = registeredPhotos(thermal).slice(0, TWIN_PROJECTION_MAX);
    if (!recordingId || !registered.length) return '';
    return JSON.stringify({
      recordingId,
      shot,
      cut: subjectKind === 'interior' ? null : skyCut(thermal),
      photos: registered.map(({ photo, camera }) => [photo.photo, photo.picture, photo.registration, camera]),
    });
  }, [recordingId, thermal, shot, subjectKind]);
  const [loaded, setLoaded] = useState<{
    signature: string;
    photos: TwinProjectionPhoto[];
    skyTempC: number | null;
    sky: Map<number, SkyReading>;
    agc: Map<number, PhotoAgc>;
  } | null>(null);

  useEffect(() => {
    if (!signature || !recordingId) return;
    let cancelled = false;
    const cut = subjectKind === 'interior' ? null : skyCut(thermal);
    const wanted = registeredPhotos(thermal).slice(0, TWIN_PROJECTION_MAX);
    void Promise.all(
      wanted.map(async ({ photo }): Promise<[number, Float32Array, SkyReading | null, PhotoAgc | null] | null> => {
        try {
          const frame = getDecodedFrame(await fetchRecordingFrameBufferCached(recordingId, photo.photo));
          if (!frame.complete || frame.width !== THERMAL_W || frame.height !== THERMAL_H)
            throw new Error('the thermal frame is incomplete');
          // `frame.temps` is shared across the analyzer: maskTemps returns a new array.
          return [
            photo.photo,
            maskTemps(frame.temps, THERMAL_W, THERMAL_H, cut),
            skyReading(frame.temps, THERMAL_W, THERMAL_H, cut),
            frameAgc(frame.temps),
          ];
        } catch (e) {
          console.warn(`twin: the thermal data of ${photoLabel(photo.photo, shot)} could not be loaded`, e);
          return null;
        }
      }),
    ).then((frames) => {
      if (cancelled) return;
      const got = frames.filter((f): f is [number, Float32Array, SkyReading | null, PhotoAgc | null] => !!f);
      const temps = new Map(got.map(([photo, grid]) => [photo, grid]));
      const sky = new Map<number, SkyReading>();
      for (const [photo, , s] of got) if (s) sky.set(photo, s);
      const skies = [...sky.values()].map((s) => s.median).sort((a, b) => a - b);
      const skyTempC = skies.length ? skies[skies.length >> 1] : null;
      const agc = new Map<number, PhotoAgc>();
      for (const [photo, , , a] of got) if (a) agc.set(photo, a);
      setLoaded({ signature, photos: projectionPhotos(thermal, temps, shot), skyTempC, sky, agc });
    });
    return () => {
      cancelled = true;
    };
    // Keyed on the signature alone (see above): it changes whenever the record's registered photos,
    // cameras, registrations or sky cut (none for an interior) do, and with the recording and the
    // picture word.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const current = loaded && loaded.signature === signature ? loaded : null;
  return {
    photos: current ? current.photos : NO_PHOTOS,
    loading: !!signature && !current,
    skyTempC: current ? current.skyTempC : null,
    sky: current ? current.sky : NO_SKY,
    agc: current ? current.agc : NO_AGC,
  };
}
