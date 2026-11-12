import { useEffect, useRef } from 'react';
import useCommonStore from '../../../stores/common';
import { useSaveCopy } from '../../../components/saveCopy';
import { Experiment, Thermometer } from '../../../types';

/**
 * The analyzer's Save as…: saves the current experiment into a new unlisted, user-owned copy and opens
 * it — the shared save-a-copy flow (components/saveCopy: naming dialog, sign-in prompt for signed-out
 * viewers), fed the analyzer's live sandbox edits so the copy keeps the viewer's thermometers /
 * annotations / transects rather than re-reading the unedited Firestore source.
 *
 * `open` starts it — the ⋮ menu's Save as… row (analyzerSettingsMenu.tsx), which is where the action
 * lives since 2026-11-12, as an experiment's does on its page; it was a button of its own in the title
 * row before. Offered to everyone, on someone else's recording and one's own alike (user's call
 * 2026-10-19). Render `dialogs` once beside the menu.
 */
export function useSaveToMyExperiments(experiment: Experiment) {
  const { request, dialogs } = useSaveCopy({
    getLive: (id) => {
      // Thermometers come from the store keyed by the experiment's (live) id list; annotations are
      // mirrored there by <Annotations>; the T(r) transects live on the store's experiment (undefined if
      // never touched → clone falls back to the source's).
      const store = useCommonStore.getState();
      const thermometers = (experiment.thermometersId ?? [])
        .map((tid) => store.thermometerMap.get(tid))
        .filter((t): t is Thermometer => !!t);
      return {
        thermometers,
        annotations: store.analyzerAnnotations.get(id),
        profileLines: store.experimentMap.get(id)?.profileLines,
      };
    },
  });

  const open = () => request({ id: experiment.id, displayName: experiment.displayName });

  // The workspace's sandbox banner shares this single dialog rather than rendering its own: its "Save
  // as" link bumps openSaveCopyRequest, which opens the dialog (or the sign-in prompt) here. Each nonce
  // is consumed exactly once, and whatever nonce already exists at mount counts as consumed: saving
  // navigates to the new copy, which remounts the caller (the player tree is keyed by experiment id)
  // with the old request still in the store — re-firing it there would reopen the naming dialog on the
  // fresh copy and loop (save → navigate → dialog → save …).
  const openSaveCopyRequest = useCommonStore((state) => state.openSaveCopyRequest);
  const consumedSaveCopyNonce = useRef(useCommonStore.getState().openSaveCopyRequest?.nonce ?? 0);
  useEffect(() => {
    if (!openSaveCopyRequest || openSaveCopyRequest.nonce <= consumedSaveCopyNonce.current) return;
    consumedSaveCopyNonce.current = openSaveCopyRequest.nonce;
    open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSaveCopyRequest]);

  return { open, dialogs };
}
