import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input, Modal, message } from 'antd';
import type { MenuProps } from 'antd';
import { FolderPlus } from 'lucide-react';
import useCommonStore from '../stores/common';
import { cloneExperimentById, type CloneLiveState } from '../services/experiments';
import type { User } from '../types';
import { useSignInGate } from './signInGate';

/** The little a save needs to know about its source: which doc, what to call the copy, whose it is. */
export interface SaveCopyTarget {
  id: string;
  displayName?: string;
  ownerId?: string;
}

/** Mirrors cloneExperimentById's default so the prefilled name matches what a blank save would make. */
export const defaultCopyName = (target: SaveCopyTarget) => `Copy of ${target.displayName ?? ''}`.trim();

/**
 * What the action is called for this viewer: someone else's recording is saved "to My Recordings";
 * your own is duplicated "as New Recording"; signed out, the control says what it will ask for.
 */
export const saveCopyLabel = (user: User | null | undefined, ownerId?: string) =>
  !user ? 'Sign in to save a copy' : user.id === ownerId ? 'Save as New Recording' : 'Save to My Recordings';

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
  const user = useCommonStore((state) => state.user);
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
      message.success(u.id === target.ownerId ? 'Saved as a new recording.' : 'Saved to your recordings.');
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
        title={target ? saveCopyLabel(user, target.ownerId) : ''}
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
 * A card options-menu entry for the flow: the label follows the viewer (see saveCopyLabel). Its icon is
 * a 14px lucide glyph like every other card-menu item (the Experiments cards' menu), so labels line up.
 */
export const buildSaveCopyMenuItem = (
  user: User | null | undefined,
  target: SaveCopyTarget,
  request: (t: SaveCopyTarget) => void,
): NonNullable<MenuProps['items']>[number] => ({
  key: 'save-copy',
  icon: <FolderPlus size={14} />,
  label: saveCopyLabel(user, target.ownerId),
  onClick: () => request(target),
});
