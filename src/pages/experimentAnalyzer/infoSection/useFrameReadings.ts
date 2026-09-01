import { useEffect, useRef, useState } from 'react';
import { Experiment, ExperimentType, Thermometer } from '../../../types';
import useCommonStore from '../../../stores/common';
import { fetchRecordingFrameBuffer } from '../../../utils/recordingFrame';
import { getThermometerValue } from '../../../utils/temperatureReader';

/** One probe as an overlay needs it: where it sits, what to call it, and what it read on THAT frame. */
export interface FrameProbeReading {
  id: string;
  /** The probe's own name, or its positional default T1..Tn. */
  label: string;
  x: number;
  y: number;
  /** Celsius at this frame; null when the frame's data could not be read. */
  value: number | null;
  aiPlaced: boolean;
  /** Index in thermometersId — the series colour follows it, as on the player. */
  index: number;
  measuringAreaType?: Thermometer['measuringAreaType'];
  measuringAreaWidth?: number;
  measuringAreaHeight?: number;
}

/**
 * Read every probe's temperature at each of the given frames.
 *
 * The store only ever holds the reading for the frame the player is showing, so anything that pictures
 * ANOTHER instant — a report figure, a key moment — has to go back to that frame's thermal data. A
 * recording fetches data_N.dat per frame; a video already has its whole clip in the player's showcase
 * cache. Frames are fetched once each (`requested`), and the decode itself is shared by
 * utils/thermalFrame.ts, so every probe on a frame costs one inflate between them.
 *
 * Readings are recomputed whenever the probes move, are renamed, or are added — the figure then shows
 * where the probes are NOW at that old instant, which is the same contract the key-moment cards keep.
 */
export function useFrameReadings(frameIndexes: number[], experiment: Experiment): Record<number, FrameProbeReading[]> {
  const isVideo = experiment.sourceType === ExperimentType.Video;
  const recordingId = experiment.recordingId;
  const videoThermal = useCommonStore((s) => (isVideo ? s.showcaseThermalCache.get(experiment.id) : undefined));
  const thermometerMap = useCommonStore((s) => s.thermometerMap);
  const thermometersId = experiment.thermometersId;

  const [frameBufs, setFrameBufs] = useState<Record<number, ArrayBuffer | null>>({});
  // Frames already asked for on this mount. Without it a resolving fetch changes `needKey`, the effect
  // re-runs, and every still-in-flight frame is downloaded again — an O(n^2) cascade (same guard the
  // key-moment cards need).
  const requested = useRef<Set<number>>(new Set());

  // Frame indices are per-clip, so another experiment's must never be served from this cache.
  useEffect(() => {
    setFrameBufs({});
    requested.current = new Set();
  }, [experiment.id]);

  const wanted = [...new Set(frameIndexes)];
  const need = isVideo || !recordingId ? [] : wanted.filter((fi) => frameBufs[fi] === undefined);
  const needKey = need.join(',');
  useEffect(() => {
    if (!recordingId || need.length === 0) return;
    need.forEach((fi) => {
      if (requested.current.has(fi)) return;
      requested.current.add(fi);
      fetchRecordingFrameBuffer(recordingId, fi)
        .then((buf) => setFrameBufs((b) => ({ ...b, [fi]: buf })))
        .catch(() => setFrameBufs((b) => ({ ...b, [fi]: null })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needKey, recordingId]);

  // The probe geometry these readings were taken with. A plain signature so a per-frame `value` change
  // (which churns on every played frame) can't retrigger the recompute — only a real edit does.
  const probes: FrameProbeReading[] = (thermometersId ?? []).flatMap((id, i) => {
    const t = thermometerMap.get(id);
    if (!t) return [];
    return [
      {
        id,
        label: t.name?.trim() || `T${i + 1}`,
        x: t.x,
        y: t.y,
        value: null,
        aiPlaced: t.aiPlaced === true,
        index: i,
        measuringAreaType: t.measuringAreaType,
        measuringAreaWidth: t.measuringAreaWidth,
        measuringAreaHeight: t.measuringAreaHeight,
      },
    ];
  });
  const probeSig = probes
    .map(
      (p) =>
        `${p.id}:${p.label}:${p.x}:${p.y}:${p.measuringAreaType ?? ''}:${p.measuringAreaWidth ?? ''}:${p.measuringAreaHeight ?? ''}`,
    )
    .join('|');
  const framesKey = wanted.join(',');

  const [readings, setReadings] = useState<Record<number, FrameProbeReading[]>>({});
  useEffect(() => {
    const { thermometerMap: map } = useCommonStore.getState();
    const live = (thermometersId ?? []).flatMap((id, i) => {
      const t = map.get(id);
      return t ? [{ id, t, i }] : [];
    });
    const out: Record<number, FrameProbeReading[]> = {};
    if (live.length > 0) {
      (framesKey ? framesKey.split(',').map(Number) : []).forEach((fi) => {
        const raw = isVideo ? videoThermal?.[fi] : frameBufs[fi];
        out[fi] = live.map(({ id, t, i }) => {
          let value: number | null = null;
          if (raw) {
            try {
              value = getThermometerValue(raw, t);
            } catch {
              value = null; // an undecodable frame shows the marker without a reading
            }
          }
          return {
            id,
            label: t.name?.trim() || `T${i + 1}`,
            x: t.x,
            y: t.y,
            value,
            aiPlaced: t.aiPlaced === true,
            index: i,
            measuringAreaType: t.measuringAreaType,
            measuringAreaWidth: t.measuringAreaWidth,
            measuringAreaHeight: t.measuringAreaHeight,
          };
        });
      });
    }
    setReadings(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framesKey, probeSig, videoThermal, frameBufs, isVideo]);

  return readings;
}
