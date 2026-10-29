/**
 * The twin's heat map following the player (docs/digital-twin-plan.md §43.3). A recording filmed from a
 * still camera has one camera for every frame, so the registered frame's camera (livePhotoOf) projects
 * ANY frame: whenever the player shows another frame, that frame's temperatures are fetched, masked as
 * the registered frame's were (useTwinProjection's maskTemps) and sent to the viewer frame as a
 * `frameTemps` message, which rewrites one cell of its temps atlas and nothing else. The player's
 * thermometers go along as `markers`, read on that same frame exactly as the player reads them
 * (getThermometerValue: a point, or the average over a measuring area), so the label on the model and
 * the label on the picture agree to the hundredth.
 *
 * The playhead is read straight off the store (playerRecordingIndex, written by the player on every
 * frame), by subscription rather than by a selector in the viewer: at 5 fps a selector would render the
 * whole viewer five times a second for a message only this hook sends.
 *
 * Frames are read through the shared cache (fetchRecordingFrameBufferCached, keyed by recording index,
 * bounded) and the next few are asked for ahead, so a frame is usually in memory by the time the playhead
 * reaches it. A frame that fails to load is skipped: the model keeps the last one painted. A newer
 * request cancels an older one still in flight (the playhead moved on), so frames never arrive out of
 * order.
 *
 * `resend` is bumped by the viewer whenever the frame's own copy may have been replaced — a photos
 * message after a build — so the current frame goes up again.
 *
 * With `palette` (the player's palette for the recording), every frame also carries its own colours —
 * the scale and palette the player shows it in. The recording stores no scale, but the player's picture
 * of the frame (data_N.png, the FLIR SDK's render) and the frame's temperatures are pixel-aligned, so the
 * table the SDK painted that frame through is measured from the two (utils/frameColourTable.ts) and sent
 * as the measured scale and palette for that frame: the model shows the picture's colours for the same
 * temperatures. When the render cannot be read, the SDK's mapping is reproduced instead (frameAgc, the
 * mapping useTwinProjection uses for a registered photo) over `palette`. Without `palette`, the frames go
 * up bare and the viewer frame keeps the scale the panel set (one scale for the whole recording, §43.5).
 */
import { useEffect, useRef } from 'react';
import type { Thermometer, TwinSubjectKind } from '../../../types';
import useCommonStore from '../../../stores/common';
import { frameColourTable } from '../../../utils/frameColourTable';
import { fetchRecordingFrameBufferCached } from '../../../utils/recordingFrame';
import { fetchRecordingRenderPixelsCached } from '../../../utils/recordingRender';
import { getThermometerValue } from '../../../utils/temperatureReader';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import {
  THERMAL_H,
  THERMAL_W,
  type TwinFrameTempsMessage,
  type TwinMarker,
  type TwinMarkersMessage,
  maskTemps,
} from '../../../utils/twinProjection';
import { photoMatchedPalette } from '../../../utils/twinSceneThermal';
import { frameAgc } from './useTwinProjection';

/** How many frames ahead of the playhead are fetched while following: two seconds at 5 fps. */
const PREFETCH_AHEAD = 10;
/** How many renders (data_N.png, far heavier than a .dat) are fetched ahead when the colours follow. */
const PREFETCH_RENDERS_AHEAD = 5;

export interface LiveThermometer {
  id: string;
  name: string; // what the label says: the probe's own name or its positional default
  thermometer: Pick<Thermometer, 'x' | 'y' | 'measuringAreaType' | 'measuringAreaWidth' | 'measuringAreaHeight'>;
}

export interface LiveTwinFrameOptions {
  /** Off: nothing is fetched or sent; the viewer's photos message stands. */
  enabled: boolean;
  recordingId: string | undefined;
  /** The registered photo whose camera every frame goes through. */
  livePhoto: number | null;
  lastFrame: number; // the recording's last frame index (1-based), for the prefetch
  cut: number | null; // the sky cut the registered frames were masked with (null: none)
  subjectKind: TwinSubjectKind | undefined;
  thermometers: LiveThermometer[];
  unit: 'C' | 'F';
  resend: number;
  /** The player's palette (256 colours cold → hot): each frame goes up in the player's own colours for
   *  it — measured from its render, or failing that this palette through the SDK's mapping. Null: the
   *  frames go up bare and the panel's scale stands. */
  palette: readonly string[] | null;
  post: (msg: TwinFrameTempsMessage | TwinMarkersMessage) => void;
}

const fmt = (c: number, unit: 'C' | 'F') =>
  unit === 'F' ? `${((c * 9) / 5 + 32).toFixed(1)} °F` : `${c.toFixed(2)} °C`;

export function useLiveTwinFrame(o: LiveTwinFrameOptions): void {
  const { enabled, recordingId, livePhoto, lastFrame, cut, subjectKind, thermometers, unit, resend, palette, post } = o;
  // The newest request wins: an older fetch that resolves later is dropped.
  const latest = useRef(0);
  useEffect(() => {
    if (!enabled || !recordingId || livePhoto === null) return;
    let alive = true; // false once this effect is torn down: a fetch still in flight then says nothing
    let last: number | null = null;
    const show = (index: number) => {
      const ticket = ++latest.current;
      void (async () => {
        let buffer: ArrayBuffer;
        let pixels: Uint8ClampedArray | null = null;
        try {
          [buffer, pixels] = await Promise.all([
            fetchRecordingFrameBufferCached(recordingId, index),
            palette ? fetchRecordingRenderPixelsCached(recordingId, index) : null,
          ]);
        } catch {
          return; // the model keeps the last frame painted
        }
        if (!alive || ticket !== latest.current) return;
        const frame = getDecodedFrame(buffer);
        if (!frame.complete || frame.width !== THERMAL_W || frame.height !== THERMAL_H) return;
        // The frame's own colours: the table its render was painted through, else the SDK's mapping
        // reproduced over the player's palette.
        let colours: { lo: number; hi: number; palette: string[] } | null = null;
        if (palette) {
          const table = pixels ? frameColourTable(frame.temps, pixels) : null;
          if (table) colours = { lo: table.min, hi: table.max, palette: table.palette };
          else {
            const agc = frameAgc(frame.temps);
            if (agc) colours = { lo: agc.min, hi: agc.max, palette: photoMatchedPalette(palette, agc.map) };
          }
        }
        post({
          type: 'frameTemps',
          photo: livePhoto,
          temps: maskTemps(frame.temps, THERMAL_W, THERMAL_H, cut, subjectKind),
          label: `frame ${index}`,
          ...(colours ?? {}),
        });
        const markers: TwinMarker[] = thermometers.map((t) => ({
          id: t.id,
          photo: livePhoto,
          gx: t.thermometer.x * THERMAL_W,
          gy: t.thermometer.y * THERMAL_H,
          value: fmt(getThermometerValue(buffer, t.thermometer), unit),
          name: t.name,
        }));
        post({ type: 'markers', markers });
      })();
      // Ahead of the playhead, fire and forget: the cache shares the promises, so a frame asked for here
      // and then shown is fetched once.
      for (let n = index + 1; n <= Math.min(lastFrame, index + PREFETCH_AHEAD); n++) {
        fetchRecordingFrameBufferCached(recordingId, n).catch(() => undefined);
        if (palette && n <= index + PREFETCH_RENDERS_AHEAD) void fetchRecordingRenderPixelsCached(recordingId, n);
      }
    };
    const onIndex = (index: number | null) => {
      if (index === null || index === last) return;
      last = index;
      show(index);
    };
    onIndex(useCommonStore.getState().playerRecordingIndex);
    const unsubscribe = useCommonStore.subscribe((state) => onIndex(state.playerRecordingIndex));
    return () => {
      unsubscribe();
      alive = false;
    };
  }, [enabled, recordingId, livePhoto, lastFrame, cut, subjectKind, thermometers, unit, resend, palette, post]);
  // Off again: the markers come down (the photos message the viewer sends restores the registered frame).
  useEffect(() => {
    if (enabled) return;
    post({ type: 'markers', markers: [] });
  }, [enabled, post]);
}
