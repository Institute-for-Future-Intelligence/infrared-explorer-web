import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Input, Modal, Tooltip, message } from 'antd';
import { FolderAddOutlined } from '@ant-design/icons';
import styled from 'styled-components';
import useCommonStore from '../../../stores/common';
import { cloneExperimentById } from '../../../services/experiments';
import { isSignInCancelled, signIn } from '../../../services/auth';
import { Experiment, Thermometer } from '../../../types';

interface Props {
  experiment: Experiment;
  /** Icon-only (drop the "Save as" text) — the always-on Tooltip already carries the full action
      name, so narrow headers lose no meaning, only width. */
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

/** Mirrors cloneExperimentById's default so the prefilled name matches what a blank save would make. */
const defaultName = (experiment: Experiment) => `Copy of ${experiment.displayName ?? ''}`.trim();

/**
 * Saves the current experiment into a new unlisted, user-owned copy (references only, no thermal
 * binary is duplicated; see cloneExperimentById) and opens it. Clicking opens a confirm dialog
 * prefilled with a default name so the user can rename the copy before it is created.
 *
 * For someone else's experiment it acts as "Save to My Experiments"; on your own experiment the
 * same clone is a "Save as New Experiment" (duplicate). Signed-out users still see the control — the
 * audience most likely to want to keep a public experiment. Clicking it opens an explanatory sign-in
 * prompt (not a surprise OAuth popup); once they sign in, the naming dialog opens automatically so the
 * original "save" intent carries across the auth round-trip — the write still waits for their confirm.
 */
const SaveToMyExperiments = ({ experiment, compact }: Props) => {
  const user = useCommonStore((state) => state.user);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  // The explanatory sign-in prompt shown to signed-out users, and the popup-in-flight flag that drives
  // its button spinner. `resumeSaveAfterSignIn` survives the auth round-trip: set once the popup
  // resolves, consumed by the user-arrival effect below (which opens the naming dialog).
  const [signInPromptOpen, setSignInPromptOpen] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const resumeSaveAfterSignIn = useRef(false);

  const isOwner = !!user && user.id === experiment.ownerId;
  const label = !user ? 'Sign in to save a copy' : isOwner ? 'Save as New Experiment' : 'Save to My Experiments';

  // Signed out → explain first (the prompt modal below) instead of firing a surprise OAuth popup;
  // its own Sign in button carries the flow through to an automatic save.
  const handleClick = () => {
    if (!user) {
      setSignInPromptOpen(true);
      return;
    }
    setName(defaultName(experiment));
    setOpen(true);
  };

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

  // The actual clone. Reads the user fresh from the store (not the render closure) so the post-sign-in
  // auto-save — whose triggering click happened while signed out — uses the just-arrived account.
  const performSave = async (rawTitle: string) => {
    const u = useCommonStore.getState().user;
    const title = rawTitle.trim();
    if (!u || !title || saving) return;
    setSaving(true);
    try {
      // Carry the analyzer's live thermometers + annotations (the viewer's local sandbox edits) into
      // the copy, rather than re-reading the unedited Firestore source. Thermometers come from the
      // store keyed by the experiment's (live) id list; annotations are mirrored there by <Annotations>.
      const store = useCommonStore.getState();
      const thermometers = (experiment.thermometersId ?? [])
        .map((id) => store.thermometerMap.get(id))
        .filter((t): t is Thermometer => !!t);
      const annotations = store.analyzerAnnotations.get(experiment.id);
      // The viewer's live T(l) transects (undefined if never touched → clone falls back to the source's).
      const profileLines = store.experimentMap.get(experiment.id)?.profileLines;
      const newId = await cloneExperimentById(experiment.id, u, title, { thermometers, annotations, profileLines });
      message.success(u.id === experiment.ownerId ? 'Saved as a new experiment.' : 'Saved to your experiments.');
      setOpen(false);
      navigate(`/experiments/${newId}`);
    } catch (e) {
      console.error('failed to save experiment to my experiments', e);
      message.error('Could not save this experiment. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => performSave(name);

  // The prompt's Sign in button: open the provider chooser, then keep the prompt open (button still
  // spinning) until the app's auth listener hydrates the store user — signIn() resolves when the
  // provider popup does, BEFORE onAuthStateChanged finishes resolving the mongoId/profile (see
  // services/auth.ts), so the effect below is what actually completes the flow. A dismissed chooser
  // or popup just resets the button.
  const handlePromptSignIn = async () => {
    if (signingIn) return;
    setSigningIn(true);
    try {
      await signIn();
      resumeSaveAfterSignIn.current = true;
    } catch (e) {
      if (!isSignInCancelled(e)) console.error('sign-in failed', e);
      setSigningIn(false);
    }
  };

  // Resume the save the user asked for while signed out: once the store user lands, swap the sign-in
  // prompt for the naming dialog (prefilled, exactly like a signed-in click) — the write itself still
  // waits for their confirm, so nothing is saved behind their back.
  useEffect(() => {
    if (!user || !resumeSaveAfterSignIn.current) return;
    resumeSaveAfterSignIn.current = false;
    setSignInPromptOpen(false);
    setSigningIn(false);
    setName(defaultName(experiment));
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return (
    <>
      <Tooltip title={label}>
        <SaveButton
          type="text"
          icon={<FolderAddOutlined />}
          onClick={handleClick}
          aria-label={label}
          style={{ flexShrink: 0 }}
        >
          {compact ? null : 'Save as'}
        </SaveButton>
      </Tooltip>

      <Modal
        title={label}
        open={open}
        onOk={handleSave}
        onCancel={() => setOpen(false)}
        okText="Save"
        okButtonProps={{ loading: saving, disabled: !name.trim() }}
        destroyOnHidden
      >
        <p style={{ marginTop: 0, color: 'var(--ifi-grey)' }}>Name your copy:</p>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={handleSave}
          placeholder="Experiment name"
          maxLength={120}
          autoFocus
        />
      </Modal>

      {/* Signed-out path: explain that saving needs an account before any OAuth popup appears. Cancel
          (or the X) also withdraws the pending resume, so a popup that already resolved won't pop the
          naming dialog after the user changed their mind. */}
      <Modal
        title="Sign in to save"
        open={signInPromptOpen}
        onOk={handlePromptSignIn}
        onCancel={() => {
          setSignInPromptOpen(false);
          setSigningIn(false);
          resumeSaveAfterSignIn.current = false;
        }}
        okText="Sign in"
        okButtonProps={{ loading: signingIn }}
        destroyOnHidden
      >
        <p style={{ marginTop: 0 }}>
          Saving a copy — including your thermometer and annotation changes — needs an account. Sign in to continue,
          then name your copy.
        </p>
      </Modal>
    </>
  );
};

export default SaveToMyExperiments;
