import { useState } from 'react';
import { Input, Modal, message } from 'antd';
import type { MenuProps } from 'antd';
import ExperimentGrid, { GridItem } from './experimentGrid';
import { renameExperiment, setTrash } from '../../services/experiments';
import { changeVisibility } from '../visibilityControl';
import ShareDialog from '../shareDialog';
import { MENU_ICONS } from '../menuIcons';
import { experimentShareUrl } from '../../utils/urls';
import { buildFeatureMenuItem, changeFeatured } from '../featureControl';
import { Visibility } from '../../types';
import { isStaff } from '../../utils/staff';
import useCommonStore from '../../stores/common';
import type { CaptureTime } from '../../utils/captureTime';
import type { MultiSelect } from '../../hooks/useMultiSelect';

interface Props<T extends GridItem> {
  items: T[];
  setItems: React.Dispatch<React.SetStateAction<T[]>>;
  // When each clip was shot (hooks/useCaptureTimes, over the page's whole list so a copy finds its
  // original even when a filter hides it); the cards then show it in place of the updated date.
  captureTimes?: ReadonlyMap<string, CaptureTime | null>;
  // The page's multi-select (hooks/useMultiSelect). While it is selecting, a click checks the card and
  // the per-card menus give way to OwnedSelectionBar's bulk actions.
  sel?: MultiSelect<unknown>;
}

/**
 * Experiment grid for an owner's own clips: each card carries a dropdown menu laid out as My
 * Experiments' ⋮ (Open in new tab / Rename / Share… / Select, a divider, Move to trash), with
 * confirm + toast feedback. Share…
 * — and a click on the card's visibility badge — opens the Share panel (components/shareDialog):
 * the tiers and the recording's link, as every kind has it (user's call 2026-10-19).
 */
function OwnedExperimentGrid<T extends GridItem>({ items, setItems, captureTimes, sel }: Props<T>) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const staff = isStaff(useCommonStore((state) => state.user));
  // The recording whose Share panel is up; read live from the list so its tier follows each write.
  const [sharingId, setSharingId] = useState<string | null>(null);
  const sharing = sharingId ? (items.find((it) => it.id === sharingId) ?? null) : null;

  const doRename = async () => {
    const name = renameText.trim();
    if (!renamingId || !name) return;
    const id = renamingId;
    try {
      await renameExperiment(id, name);
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, displayName: name } : it)));
      message.success('Renamed');
    } catch (e) {
      console.error('failed to rename', e);
      message.error('Failed to rename');
    } finally {
      setRenamingId(null);
    }
  };

  const moveToTrash = (id: string) =>
    Modal.confirm({
      title: 'Move this to the trash?',
      okText: 'Move to trash',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await setTrash(id, true);
          setItems((prev) => prev.filter((it) => it.id !== id));
          message.success('Moved to trash');
        } catch (e) {
          console.error('failed to move to trash', e);
          message.error('Failed to move to trash');
        }
      },
    });

  // Persist the new tier, then patch the item in place — grids that group by visibility (the
  // profile page's tabs) re-derive their groups from the updated list, so the card moves tabs.
  // Demoting a featured clip below Public also un-features it (changeVisibility handles the
  // write); patch that too so the card's star badge and the Admin menu item follow.
  const setItemVisibility = async (id: string, visibility: Visibility) => {
    const res = await changeVisibility(id, visibility, items.find((it) => it.id === id)?.featured);
    if (res) {
      setItems((prev) =>
        prev.map((it) => (it.id === id ? { ...it, visibility, featured: res.unfeatured ? false : it.featured } : it)),
      );
    } else {
      throw new Error('Could not change the sharing.');
    }
  };

  // Staff feature/un-feature their own homepage showcase. Featuring may promote the experiment to
  // Public (setFeatured mirrors that back), so patch both flags from the result.
  const setItemFeatured = async (id: string, featured: boolean, currentVisibility: Visibility | undefined) => {
    const res = await changeFeatured(id, featured, currentVisibility);
    if (res) {
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, featured, visibility: res.visibility } : it)));
    }
  };

  const buildMenu = (item: GridItem): MenuProps['items'] => [
    {
      key: 'open',
      label: 'Open in new tab',
      icon: MENU_ICONS.open,
      onClick: () => window.open(`${window.location.origin}/experiments/${item.id}`, '_blank'),
    },
    {
      key: 'rename',
      icon: MENU_ICONS.rename,
      label: 'Rename',
      onClick: () => {
        setRenamingId(item.id);
        setRenameText(item.displayName);
      },
    },
    // Rows loaded from ExperimentDoc always carry visibility; guard for shapes that don't.
    ...(item.visibility
      ? [{ key: 'share', label: 'Share…', icon: MENU_ICONS.share, onClick: () => setSharingId(item.id) }]
      : []),
    // Select: starts the page's multi-select with this card ticked, as My Experiments' ⋮ does.
    ...(sel
      ? [
          {
            key: 'select',
            label: 'Select',
            icon: MENU_ICONS.select,
            onClick: () => {
              sel.start();
              sel.toggle(item.id, false);
            },
          },
        ]
      : []),
    // Staff-only privileged actions, grouped under an "Admin" submenu so it reads as admin-exclusive.
    // Currently just the homepage showcase toggle (rules enforce staff + owner).
    ...(staff
      ? [
          {
            key: 'admin',
            icon: MENU_ICONS.admin,
            label: 'Admin',
            children: [
              buildFeatureMenuItem(!!item.featured, (next) => setItemFeatured(item.id, next, item.visibility)),
            ],
          },
        ]
      : []),
    { type: 'divider' },
    {
      key: 'trash',
      label: 'Move to trash',
      icon: MENU_ICONS.delete,
      danger: true,
      onClick: () => moveToTrash(item.id),
    },
  ];

  return (
    <>
      <ExperimentGrid
        items={items}
        buildMenu={buildMenu}
        showUpdated
        showAuthor={false}
        showVisibility
        onShare={setSharingId}
        captureTimes={captureTimes}
        selecting={sel?.selecting}
        selectedIds={sel?.selected}
        onSelect={sel?.toggle}
      />
      {sharing && sharing.visibility && (
        <ShareDialog
          open
          title="Share Recording"
          kind="recording"
          current={sharing.visibility}
          url={experimentShareUrl(sharing.id)}
          linkTitle={sharing.displayName}
          onVisibility={(v) => setItemVisibility(sharing.id, v)}
          onClose={() => setSharingId(null)}
        />
      )}
      <Modal
        title="Rename"
        open={renamingId !== null}
        onOk={doRename}
        onCancel={() => setRenamingId(null)}
        okText="Save"
        destroyOnHidden
      >
        <Input
          value={renameText}
          onChange={(e) => setRenameText(e.target.value)}
          onPressEnter={doRename}
          placeholder="New title"
          autoFocus
        />
      </Modal>
    </>
  );
}

export default OwnedExperimentGrid;
