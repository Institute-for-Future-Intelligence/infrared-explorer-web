import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input, Modal, message } from 'antd';
import type { MenuProps } from 'antd';
import useCommonStore from '../stores/common';
import { cloneExperimentById, type CloneLiveState } from '../services/experiments';
import { useSignInGate } from './signInGate';
import { MENU_ICONS } from './menuIcons';

/** The little a save needs to know about its source: which doc, and what the copy is first called after. */
export interface SaveCopyTarget {
  id: string;
  displayName?: string;
}

/** Mirrors cloneExperimentById's default so the prefilled name matches what a blank save would make. */
export const defaultCopyName = (target: SaveCopyTarget) => `Copy of ${target.displayName ?? ''}`.trim();

/**
 * What every save-a-copy control is called, whoever's the source and whether or not the viewer is
 * signed in (user's call 2026-10-19: one "Save as…" everywhere, the Experiments' menus included). The
 * dialog it opens says what it makes; signed out, the sign-in prompt says why it needs an account.
 */
export const SAVE_AS_LABEL = 'Save as…';
/** The naming dialog's heading — the Experiments' Save as… says "Save as New Experiment". */
export const SAVE_AS_RECORDING_HEADING = 'Save as New Recording';

interface Options {
  /**
   * The analyzer's live sandbox edits (thermometers / annotations / transects) for the source, so a
   * save from inside the analyzer keeps what the viewer changed. Card grids have none and omit it.
   */
  getLive?: (id: string) => CloneLiveState | undefined;
}

/**
 * The "save a copy" flow shared by the analyzer's Save-as button and the card menus on public grids:
 * clone the source into a new unlisted, user-owned recording (references only, no thermal binary is
 * duplicated; see cloneExperimentById) and open it.
 *
 * `request(target)` starts it. Signed in, a naming dialog opens prefilled with a default name so the
 * user can rename the copy before it is created. Signed out, an explanatory sign-in prompt opens first
 * (components/signInGate); once they sign in, the naming dialog opens automatically — the write still
 * waits for their confirm, so nothing is saved behind their back.
 *
 * Render `dialogs` once in the tree that calls `request`.
 */
export function useSaveCopy({ getLive }: Options = {}) {
  const navigate = useNavigate();
  // The source being saved; null = no dialog open.
  const [target, setTarget] = useState<SaveCopyTarget | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const signInGate = useSignInGate({
    title: 'Sign in to save',
    text: getLive
      ? 'Saving a copy — including your thermometer and annotation changes — needs an account. Sign in to continue, then name your copy.'
      : 'Saving a copy to your recordings needs an account. Sign in to continue, then name your copy.',
  });

  const request = (t: SaveCopyTarget) =>
    signInGate.gate(() => {
      setName(defaultCopyName(t));
      setTarget(t);
    });

  // The actual clone. Reads the user fresh from the store (not the render closure) so the post-sign-in
  // save — whose triggering click happened while signed out — uses the just-arrived account.
  const performSave = async () => {
    const u = useCommonStore.getState().user;
    const title = name.trim();
    if (!u || !target || !title || saving) return;
    setSaving(true);
    try {
      // The twin itself (twinScene) is copied by the clone server-side.
      const { id: newId, twinCopyFailed } = await cloneExperimentById(target.id, u, title, getLive?.(target.id));
      message.success('Saved as a new recording.');
      // Everything else is on the copy; say plainly that the 3D twin is the one thing that is not,
      // rather than leaving them to find an empty 3D Twin tab. No promise of a rebuild: building a twin
      // is not open to every owner, but saving again is, and makes a fresh attempt at the copy.
      if (twinCopyFailed) message.warning('The 3D model could not be copied — save again to retry.');
      setTarget(null);
      navigate(`/experiments/${newId}`);
    } catch (e) {
      console.error('failed to save a copy of the recording', e);
      message.error('Could not save this recording. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const dialogs: ReactNode = (
    <>
      <Modal
        title={SAVE_AS_RECORDING_HEADING}
        open={!!target}
        onOk={performSave}
        onCancel={() => setTarget(null)}
        okText="Save"
        okButtonProps={{ loading: saving, disabled: !name.trim() }}
        destroyOnHidden
      >
        <p style={{ marginTop: 0, color: 'var(--ifi-grey)' }}>Name your copy:</p>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={performSave}
          placeholder="Recording name"
          maxLength={120}
          autoFocus
        />
      </Modal>
      {signInGate.dialog}
    </>
  );

  return { request, dialogs };
}

/**
 * A card options-menu entry for the flow, with the icon every Save as… row shows (components/menuIcons).
 */
export const buildSaveCopyMenuItem = (
  target: SaveCopyTarget,
  request: (t: SaveCopyTarget) => void,
): NonNullable<MenuProps['items']>[number] => ({
  key: 'save-copy',
  icon: MENU_ICONS.saveAs,
  label: SAVE_AS_LABEL,
  onClick: () => request(target),
});

/**
 * The ⋮ of a public recording's card wherever the open feed shows it — Community's Recordings tab and
 * the home page's "From the community" row — so the two menus never drift apart: Open in new tab and
 * Save as…, the same rows as a public experiment's card (labProjects CommunityProjectCard).
 */
export const buildRecordingCardMenu = (
  target: SaveCopyTarget,
  request: (t: SaveCopyTarget) => void,
): MenuProps['items'] => [
  {
    key: 'open',
    label: 'Open in new tab',
    icon: MENU_ICONS.open,
    onClick: () => window.open(`${window.location.origin}/experiments/${target.id}`, '_blank'),
  },
  buildSaveCopyMenuItem(target, request),
];
