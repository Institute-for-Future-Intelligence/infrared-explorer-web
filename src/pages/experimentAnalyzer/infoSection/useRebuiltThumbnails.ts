import { useEffect, useState } from 'react';
import { Experiment, ExperimentType } from '../../../types';
import useCommonStore from '../../../stores/common';
import { fetchRecordingFrameDataUrl } from '../../../utils/recordingFrame';
import { renderThermalFrameThumbnail } from '../../../utils/thermalThumbnail';

/**
 * Rebuild thumbnails for persisted moments that hydrate with only a frame index (no image) — the Q&A
 * history turns and the key-moment timeline. Returns a map keyed by recordingIndex; '' means the rebuild
 * was tried and failed, so the caller keeps its flat pill. A moment that already carries its own `thumbnail`
 * is skipped (the caller prefers `m.thumbnail || thumbs[m.recordingIndex]`).
 *
 *  - Recordings fetch the server-rendered data_N.png through the Storage SDK (CORS-safe).
 *  - Videos have no per-frame image, but their .vir thermal frames are already in the player's showcase
 *    cache, so the frame is colourised (renderThermalFrameThumbnail) instead of fetched.
 *
 * Resets when experiment.id changes — frame indices are per-clip and another clip reuses them. Shared by
 * KeyMoments and the Q&A panel so both rebuild identically (this is the single source of the logic).
 */
export function useRebuiltThumbnails(
  moments: { recordingIndex: number; thumbnail?: string }[],
  experiment: Experiment,
): Record<number, string> {
  const isVideo = experiment.sourceType === ExperimentType.Video;
  const recordingId = experiment.recordingId;
  const videoThermal = useCommonStore((s) => (isVideo ? s.showcaseThermalCache.get(experiment.id) : undefined));
  const [thumbs, setThumbs] = useState<Record<number, string>>({});

  // A navigation to another experiment must not carry this one's thumbnails over (keyed by frame index,
  // which another clip reuses).
  useEffect(() => {
    setThumbs({});
  }, [experiment.id]);

  // Recordings: fetch the server-rendered data_N.png for each moment still missing a thumbnail.
  const needRec =
    isVideo || !recordingId
      ? []
      : moments.filter((m) => !m.thumbnail && thumbs[m.recordingIndex] === undefined).map((m) => m.recordingIndex);
  const needRecKey = needRec.join(',');
  useEffect(() => {
    if (!recordingId || needRec.length === 0) return;
    let cancelled = false;
    needRec.forEach((ri) => {
      fetchRecordingFrameDataUrl(recordingId, ri)
        .then((url) => !cancelled && setThumbs((t) => ({ ...t, [ri]: url })))
        .catch(() => !cancelled && setThumbs((t) => ({ ...t, [ri]: '' })));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needRecKey, recordingId]);

  // Videos: colourise each moment's .vir frame once the thermal data has loaded into the player's cache.
  // Synchronous (a 120×160 canvas), so no cancellation needed; a frame index out of range is skipped.
  const needVid =
    isVideo && videoThermal
      ? moments
          .filter((m) => !m.thumbnail && thumbs[m.recordingIndex] === undefined && !!videoThermal[m.recordingIndex])
          .map((m) => m.recordingIndex)
      : [];
  const needVidKey = needVid.join(',');
  useEffect(() => {
    if (!videoThermal || needVid.length === 0) return;
    const rendered: Record<number, string> = {};
    needVid.forEach((ri) => {
      rendered[ri] = renderThermalFrameThumbnail(videoThermal[ri]);
    });
    setThumbs((t) => ({ ...t, ...rendered }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needVidKey, videoThermal]);

  return thumbs;
}
