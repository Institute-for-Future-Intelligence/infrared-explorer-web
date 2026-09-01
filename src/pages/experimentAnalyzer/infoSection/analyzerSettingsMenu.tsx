import { Button, Dropdown, Modal, message } from 'antd';
import type { MenuProps } from 'antd';
import { DeleteOutlined, MoreOutlined, UndoOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import styled from 'styled-components';
import { Experiment, Visibility } from '../../../types';
import useCommonStore from '../../../stores/common';
import { isStaff } from '../../../utils/staff';
import { buildVisibilityMenuItem, changeVisibility } from '../../../components/visibilityControl';
import { buildFeatureMenuItem, changeFeatured } from '../../../components/featureControl';
import { setTrash } from '../../../services/experiments';

// A bare ⋮ (no text label) is easy to miss at the light placeholder grey the text buttons beside it
// use, so it gets the darker primary ink, a larger glyph, AND a stroke on the icon's paths to fatten
// the three dots (SVG icons ignore font-weight, so a same-colour stroke is how you embolden them) —
// teal on hover, matching Share / Save as.
const TriggerButton = styled(Button)`
  color: var(--ifi-ink);

  .anticon {
    font-size: 22px;
  }
  .anticon svg {
    stroke: currentColor;
    stroke-width: 48;
  }

  &:not(:disabled):hover {
    color: var(--ifi-teal) !important;
  }
`;

interface Props {
  experiment: Experiment;
}

/**
 * Owner-only overflow (⋮) menu in the analyzer header carrying the experiment's owner actions:
 *   Visibility    — the Private / Link only / Public tier (any owner).
 *   Showcase      — the homepage-showcase toggle (staff-and-owner; mirrors the Firestore rules). Shares
 *                   buildFeatureMenuItem with the My Experiments card menu so both name it identically.
 *   Move to trash — the destructive one, set apart below a divider (any owner); on an already
 *                   trashed experiment (opened from the Trash page) it becomes Restore instead.
 * These used to sit as inline controls in the Info tab's facts list; consolidating them into one
 * settings menu beside Share / Save as keeps the facts read-only and puts the owner's "who can see
 * this" decisions in one place. Each change persists itself (with toasts) via the shared
 * change* helpers, then syncs the cached experiment so the menu and any later auto-save agree —
 * both flags move together (demoting below Public un-features; featuring promotes to Public).
 */
const AnalyzerSettingsMenu = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const setExperiment = useCommonStore((state) => state.setExperiment);
  const navigate = useNavigate();

  const isOwner = !!user && user.id === experiment.ownerId;
  // Nothing in here is offered to a viewer — render no trigger at all. An owner always gets the menu,
  // even on a legacy doc carrying no `visibility` to change: the trash action alone earns the ⋮.
  if (!isOwner) return null;

  const { id, visibility, featured, ownerId } = experiment;
  const showHomepage = isStaff(user) && ownerId === user.id;

  const setVisibility = async (v: Visibility) => {
    const res = await changeVisibility(id, v, featured);
    if (res) setExperiment(id, { ...experiment, visibility: v, featured: res.unfeatured ? false : !!featured });
  };
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
      title: 'Move this experiment to the trash?',
      content: 'It leaves your experiments and links to it stop working. You can restore it from Trash.',
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
    // Legacy docs can carry no visibility at all — then the menu is just the trash action.
    ...(visibility ? [buildVisibilityMenuItem(visibility, setVisibility)] : []),
    // Staff-only homepage-showcase toggle, set apart by a divider so it reads as the privileged action.
    // Same shared item the owner card menus use — one flag, one wording, in one place.
    ...(showHomepage ? [{ type: 'divider' as const }, buildFeatureMenuItem(!!featured, setHomepage)] : []),
    { type: 'divider' as const },
    experiment.trash
      ? { key: 'restore', icon: <UndoOutlined />, label: 'Restore from trash', onClick: restore }
      : { key: 'trash', icon: <DeleteOutlined />, label: 'Move to trash', danger: true, onClick: moveToTrash },
  ];

  return (
    <Dropdown menu={{ items }} trigger={['click']} placement="bottomRight">
      <TriggerButton
        type="text"
        icon={<MoreOutlined />}
        aria-label="Experiment settings"
        title="Settings"
        style={{ flexShrink: 0 }}
      />
    </Dropdown>
  );
};

export default AnalyzerSettingsMenu;
