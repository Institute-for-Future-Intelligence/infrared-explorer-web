import { useCallback, useEffect, useRef } from 'react';
import useCommonStore from '../../stores/common';
import { saveView } from '../../services/experiments';
import type { Experiment, SavedView } from '../../types';

// How long a part of the view has to rest before it's written — playback moves the playhead several
// times a second, and one write per pause in the motion is plenty (a leave flushes whatever is pending).
const WRITE_DELAY_MS = 1000;

/**
 * The owner's writer for the experiment's saved view (ExperimentDoc.savedView): where they leave the
 * analyzer — the playhead frame, the 3D surface — is what everyone else opens, so each move is written
 * back to the doc. Returns `write(patch)`: patches merge, and are held until the view has rested for a
 * second and the clip is not playing (a running clip writes nothing until it pauses or ends); whatever
 * is still pending is written when the player unmounts (or the page is hidden — best effort there, the
 * SDK may not get the write out before a closing tab is gone).
 *
 * Ownership is read at write time, not at mount: the session resolves after the player mounts (the
 * owner would otherwise look like a visitor for the first moves), and the owner may sign out mid-visit.
 * A non-owner's moves are sandbox state, never written — a reload returns them to the owner's view, like
 * their thermometer edits. One writer per part (the player's, the surface's): each writes its own field
 * path (saveView), so they never overwrite each other.
 */
export const useSavedViewWriter = (experiment: Experiment) => {
  const expId = experiment.id;
  const ownerId = experiment.ownerId;
  const pendingRef = useRef<SavedView | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `final`: write even while playing — the player is going away, this is the frame it leaves on.
  const flush = useCallback(
    (final: boolean) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      const patch = pendingRef.current;
      if (!patch) return;
      const state = useCommonStore.getState();
      if (!final && state.playerPlaying) {
        // Still rolling: wait for the pause rather than write a frame the clip has already left.
        timerRef.current = setTimeout(() => flush(false), WRITE_DELAY_MS);
        return;
      }
      pendingRef.current = null;
      if (!state.user || state.user.id !== ownerId) return;
      saveView(expId, patch).catch((e) => console.error('failed to save the view', e));
    },
    [expId, ownerId],
  );

  useEffect(() => {
    const onHide = () => flush(true);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      flush(true);
    };
  }, [flush]);

  return useCallback(
    (patch: SavedView) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => flush(false), WRITE_DELAY_MS);
    },
    [flush],
  );
};
