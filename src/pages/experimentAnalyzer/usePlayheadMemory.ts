import { useCallback, useRef, useState } from 'react';
import type { Experiment } from '../../types';
import { useSavedViewWriter } from './useSavedViewWriter';

/**
 * The frame an experiment's playhead opens on, and the owner's moves of it — part of the saved view
 * (ExperimentDoc.savedView.frame, see useSavedViewWriter): where the owner stopped the clip is where it
 * opens for everyone, the owner on a return visit included. The index is the player's own frame index
 * (a recording's player index, a photo set's capture slot, a video's .vir frame).
 *
 * `saved` is read once, when the player mounts (the player clamps it to the clip, and falls back to its
 * own opening frame when there's none). `remember(index)` records a move; `remember(null)` forgets the
 * spot, so the clip opens from the beginning again (a video played to its end). A non-owner's moves are
 * never written — their playhead is sandbox state, like their thermometer edits.
 */
export const usePlayheadMemory = (experiment: Experiment) => {
  const [saved] = useState(() => {
    const v = experiment.savedView?.frame;
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
  });
  const write = useSavedViewWriter(experiment);
  // The frame last handed to the writer (the saved one to begin with), so opening on the saved frame —
  // which reports a move like any other — and a seek that lands where it already was write nothing.
  const lastRef = useRef<number | null>(saved);
  const remember = useCallback(
    (index: number | null) => {
      if (index === lastRef.current) return;
      lastRef.current = index;
      write({ frame: index });
    },
    [write],
  );
  return { saved, remember };
};
