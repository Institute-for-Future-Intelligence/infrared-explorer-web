import { useCallback, useEffect, useRef, useState } from 'react';
import { readViewerPref, writeViewerPref } from '../../utils/viewerPrefs';

// How long the playhead has to rest before it's written — playback moves it several times a second, and
// one write per pause in the motion is plenty (a leave or a reload flushes whatever is still pending).
const WRITE_DELAY_MS = 400;

/**
 * Where this viewer left an experiment's playhead, so a reload or a return visit picks up on the same
 * frame — the player's own frame index (a recording's player index, a photo set's capture slot, a
 * video's .vir frame). Kept in this browser per experiment (viewerPrefs), like a video site's "resume":
 * it's how far this person got, not part of the experiment, so it's never written to its doc.
 *
 * `saved` is read once, when the player mounts (the player clamps it to the clip, and falls back to its
 * own opening frame when there's none). `remember(index)` records a move; `remember(null)` forgets the
 * spot, so the next visit starts from the beginning again (a video played to its end).
 */
export const usePlayheadMemory = (expId: string) => {
  const key = `playhead.${expId}`;
  const [saved] = useState(() => {
    const v = readViewerPref<unknown>(key, null);
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
  });

  // The move waiting to be written: a frame, null to forget, undefined when there's nothing pending.
  const pendingRef = useRef<number | null | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (pendingRef.current === undefined) return;
    writeViewerPref(key, pendingRef.current ?? undefined);
    pendingRef.current = undefined;
  }, [key]);

  // A leave (the player unmounts) or a reload / tab close (pagehide — React doesn't unmount then) writes
  // the last move straight away instead of losing it to the delay.
  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);

  const remember = useCallback(
    (index: number | null) => {
      pendingRef.current = index;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, WRITE_DELAY_MS);
    },
    [flush],
  );

  return { saved, remember };
};
