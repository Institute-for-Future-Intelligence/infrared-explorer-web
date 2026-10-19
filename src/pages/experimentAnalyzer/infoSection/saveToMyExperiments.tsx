import { useEffect, useRef } from 'react';
import { Button, Tooltip } from 'antd';
import { FolderPlus } from 'lucide-react';
import styled from 'styled-components';
import useCommonStore from '../../../stores/common';
import { SAVE_AS_LABEL, useSaveCopy } from '../../../components/saveCopy';
import { Experiment, Thermometer } from '../../../types';

interface Props {
  experiment: Experiment;
  /** Icon-only (drop the "Save as" text) — the Tooltip then carries the action's name, so narrow
      headers lose no meaning, only width. */
  compact?: boolean;
}

// Quiet grey by default, teal on hover — matches the ShareMenu trigger beside it so the header actions
// (Share · Save as) read as one restrained toolbar rather than competing with the experiment title.
const SaveButton = styled(Button)`
  color: var(--ifi-grey);

  &:not(:disabled):hover {
    color: var(--ifi-teal) !important;
  }
`;

/**
 * Saves the current experiment into a new unlisted, user-owned copy and opens it — the shared
 * save-a-copy flow (components/saveCopy: naming dialog, sign-in prompt for signed-out viewers), fed
 * the analyzer's live sandbox edits so the copy keeps the viewer's thermometers / annotations /
 * transects rather than re-reading the unedited Firestore source.
 *
 * Called "Save as" for everyone — on someone else's recording and one's own alike (user's call
 * 2026-10-19), with the folder-plus icon every Save as… shows.
 */
const SaveToMyExperiments = ({ experiment, compact }: Props) => {
  const { request, dialogs } = useSaveCopy({
    getLive: (id) => {
      // Thermometers come from the store keyed by the experiment's (live) id list; annotations are
      // mirrored there by <Annotations>; the T(l) transects live on the store's experiment (undefined if
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

  const handleClick = () => request({ id: experiment.id, displayName: experiment.displayName });

  // The workspace's sandbox banner shares this single dialog rather than rendering its own: its "Save
  // as" link bumps openSaveCopyRequest, which opens the dialog (or the sign-in prompt) here. Each nonce
  // is consumed exactly once, and whatever nonce already exists at mount counts as consumed: saving
  // navigates to the new copy, which remounts this component (the player tree is keyed by experiment
  // id) with the old request still in the store — re-firing it there would reopen the naming dialog on
  // the fresh copy and loop (save → navigate → dialog → save …).
  const openSaveCopyRequest = useCommonStore((state) => state.openSaveCopyRequest);
  const consumedSaveCopyNonce = useRef(useCommonStore.getState().openSaveCopyRequest?.nonce ?? 0);
  useEffect(() => {
    if (!openSaveCopyRequest || openSaveCopyRequest.nonce <= consumedSaveCopyNonce.current) return;
    consumedSaveCopyNonce.current = openSaveCopyRequest.nonce;
    handleClick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSaveCopyRequest]);

  return (
    <>
      <Tooltip title={compact ? SAVE_AS_LABEL : undefined}>
        <SaveButton
          type="text"
          icon={<FolderPlus size={16} strokeWidth={1.75} />}
          onClick={handleClick}
          aria-label={SAVE_AS_LABEL}
          style={{ flexShrink: 0 }}
        >
          {compact ? null : 'Save as'}
        </SaveButton>
      </Tooltip>
      {dialogs}
    </>
  );
};

export default SaveToMyExperiments;
