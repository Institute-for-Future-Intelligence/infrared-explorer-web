import { Dropdown, Modal, message } from 'antd';
import type { MenuProps } from 'antd';
import { useNavigate } from 'react-router-dom';
import { Experiment } from '../../../types';
import useCommonStore from '../../../stores/common';
import { isStaff } from '../../../utils/staff';
import { buildFeatureMenuItem, changeFeatured } from '../../../components/featureControl';
import { setTrash } from '../../../services/experiments';
import { MENU_ICONS } from '../../../components/menuIcons';
import MoreButton from '../../../components/moreButton';
import { SAVE_AS_LABEL } from '../../../components/saveCopy';
import { useSaveToMyExperiments } from './useSaveToMyExperiments';
import { EMBEDDED } from '../../../utils/embedded';

interface Props {
  experiment: Experiment;
  /** Opens the title's inline editor (the owner's Rename row; absent for a viewer). */
  onRename?: () => void;
  /** Opens the Share panel (the owner's Share… row; absent for a viewer and a legacy doc without a tier). */
  onShare?: () => void;
}

/**
 * The ⋮ menu that ends the analyzer's title row, with the rows an experiment's has on its page
 * (labProjects ProjectMenu) and a recording's card has in My Recordings, in the same order, so the
 * two pages' title rows read alike (user's call 2026-11-12):
 *   Rename        — the owner; opens the title's inline editor, as the pencil beside the title does.
 *   Save as…      — everyone, signed out too: a private copy under a new name (useSaveToMyExperiments).
 *                   It was a button of its own in the row; a viewer's menu is this row alone, as on
 *                   someone else's experiment.
 *   Share…        — the owner; the Share panel, as the tier button to the left of the ⋮ opens.
 *   Admin ›       — staff, on their own recording: the homepage-showcase toggle (buildFeatureMenuItem,
 *                   the one item the card menus use too; mirrors the Firestore rules).
 *   Move to trash — the owner; the destructive one, set apart below a divider. On an already trashed
 *                   recording (opened from the Trash page) it becomes Restore instead.
 * Each change persists itself (with toasts) via the shared change* helpers, then syncs the cached
 * experiment so the menu and any later auto-save agree — both flags move together (demoting below
 * Public un-features; featuring promotes to Public).
 */
const AnalyzerSettingsMenu = ({ experiment, onRename, onShare }: Props) => {
  const user = useCommonStore((state) => state.user);
  const setExperiment = useCommonStore((state) => state.setExperiment);
  const navigate = useNavigate();
  const saveAs = useSaveToMyExperiments(experiment);

  const isOwner = !!user && user.id === experiment.ownerId;
  const { id, visibility, featured } = experiment;
  const showHomepage = isOwner && isStaff(user);

  const setHomepage = async (next: boolean) => {
    const res = await changeFeatured(id, next, visibility);
    if (res) setExperiment(id, { ...experiment, featured: next, visibility: res.visibility });
  };

  /*
   * Delete, the way the rest of the app deletes: a SOFT delete, identical to "Move to trash" on a My
   * Experiments card — the doc gets `trash: true`, leaves every owner list and stops resolving for
   * anyone holding the link, and can be restored (or destroyed for good) from the Trash page. Nothing
   * is left to analyze afterwards, so leave for My Experiments instead of sitting on the page the
   * owner just removed.
   */
  const moveToTrash = () =>
    Modal.confirm({
      title: 'Move this recording to the trash?',
      content: 'It leaves your recordings and links to it stop working. You can restore it from Trash.',
      okText: 'Move to trash',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await setTrash(id, true);
          message.success('Moved to trash');
          navigate('/myExperimentsList');
        } catch (e) {
          console.error('failed to move experiment to trash', e);
          message.error('Failed to move to trash');
        }
      },
    });

  // The Trash page's cards open the analyzer too, so an already-trashed experiment can be on screen —
  // offer it the way back rather than a no-op "move to trash". Stay on the page (the experiment is
  // restored, not gone) and patch the cached doc so the item flips back.
  const restore = async () => {
    try {
      await setTrash(id, false);
      setExperiment(id, { ...experiment, trash: false });
      message.success('Restored');
    } catch (e) {
      console.error('failed to restore experiment', e);
      message.error('Failed to restore');
    }
  };

  const items: MenuProps['items'] = [
    ...(isOwner && onRename
      ? [{ key: 'rename', icon: MENU_ICONS.rename, label: 'Rename', onClick: () => onRename() }]
      : []),
    { key: 'saveAs', icon: MENU_ICONS.saveAs, label: SAVE_AS_LABEL, onClick: () => saveAs.open() },
    ...(isOwner && onShare
      ? [{ key: 'share', icon: MENU_ICONS.share, label: 'Share…', onClick: () => onShare() }]
      : []),
    // Staff-only, grouped under "Admin" so it reads as the privileged action — the same submenu, with
    // the same one item, as the card menus and an experiment's page have.
    ...(showHomepage
      ? [
          {
            key: 'admin',
            icon: MENU_ICONS.admin,
            label: 'Admin',
            children: [buildFeatureMenuItem(!!featured, setHomepage)],
          },
        ]
      : []),
    ...(isOwner
      ? [
          { type: 'divider' as const },
          experiment.trash
            ? { key: 'restore', icon: MENU_ICONS.restore, label: 'Restore from trash', onClick: restore }
            : { key: 'trash', icon: MENU_ICONS.delete, label: 'Move to trash', danger: true, onClick: moveToTrash },
        ]
      : []),
  ];

  // An embedded window (utils/embedded.ts) has no ⋮: the article around it is not the place to rename,
  // copy or trash the recording. The Save as dialogs stay, for the link in the workspace's note about
  // changes that stay on this page.
  return (
    <>
      {!EMBEDDED && (
        <Dropdown menu={{ items }} trigger={['click']} placement="bottomRight">
          <MoreButton aria-label="Recording menu" />
        </Dropdown>
      )}
      {saveAs.dialogs}
    </>
  );
};

export default AnalyzerSettingsMenu;
