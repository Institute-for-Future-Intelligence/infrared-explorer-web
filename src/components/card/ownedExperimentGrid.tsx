import { useState } from 'react';
import { Input, Modal, message } from 'antd';
import type { MenuProps } from 'antd';
import ExperimentGrid, { GridItem } from './experimentGrid';
import { renameExperiment, setTrash } from '../../services/experiments';
import { buildVisibilityMenuItem, changeVisibility } from '../visibilityControl';
import { buildFeatureMenuItem, changeFeatured } from '../featureControl';
import { Visibility } from '../../types';
import { isStaff } from '../../utils/staff';
import useCommonStore from '../../stores/common';

interface Props<T extends GridItem> {
  items: T[];
  setItems: React.Dispatch<React.SetStateAction<T[]>>;
}

/**
 * Experiment grid for an owner's own clips: each card carries a dropdown menu
 * (Change title / Open in new tab / Visibility / Move to trash), with confirm + toast feedback.
 */
function OwnedExperimentGrid<T extends GridItem>({ items, setItems }: Props<T>) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const staff = isStaff(useCommonStore((state) => state.user));

  const doRename = async () => {
    const name = renameText.trim();
    if (!renamingId || !name) return;
    const id = renamingId;
    try {
      await renameExperiment(id, name);
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, displayName: name } : it)));
      message.success('Title changed');
    } catch (e) {
      console.error('failed to rename', e);
      message.error('Failed to change title');
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
  const setItemVisibility = async (id: string, visibility: Visibility) => {
    if (await changeVisibility(id, visibility)) {
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, visibility } : it)));
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
      key: 'rename',
      label: 'Change title',
      onClick: () => {
        setRenamingId(item.id);
        setRenameText(item.displayName);
      },
    },
    {
      key: 'open',
      label: 'Open in new tab',
      onClick: () => window.open(`${window.location.origin}/#/experiments/${item.id}`, '_blank'),
    },
    // Rows loaded from ExperimentDoc always carry visibility; guard for shapes that don't.
    ...(item.visibility
      ? [{ type: 'divider' } as const, buildVisibilityMenuItem(item.visibility, (v) => setItemVisibility(item.id, v))]
      : []),
    // Staff-only: feature this experiment on the site homepage (rules enforce staff + owner).
    ...(staff
      ? [buildFeatureMenuItem(!!item.featured, (next) => setItemFeatured(item.id, next, item.visibility))]
      : []),
    { type: 'divider' },
    { key: 'trash', label: 'Move to trash', danger: true, onClick: () => moveToTrash(item.id) },
  ];

  return (
    <>
      <ExperimentGrid items={items} buildMenu={buildMenu} showUpdated showAuthor={false} />
      <Modal
        title="Change title"
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
