import { useState } from 'react';
import { Input, Modal, message } from 'antd';
import type { MenuProps } from 'antd';
import ExperimentGrid, { GridItem } from './experimentGrid';
import { renameExperiment, setTrash } from '../../services/experiments';

interface Props<T extends GridItem> {
  items: T[];
  setItems: React.Dispatch<React.SetStateAction<T[]>>;
}

/**
 * Experiment grid for an owner's own clips: each card carries a dropdown menu
 * (Change title / Open in new tab / Move to trash), with confirm + toast feedback.
 */
function OwnedExperimentGrid<T extends GridItem>({ items, setItems }: Props<T>) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

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
    { type: 'divider' },
    { key: 'trash', label: 'Move to trash', danger: true, onClick: () => moveToTrash(item.id) },
  ];

  return (
    <>
      <ExperimentGrid items={items} buildMenu={buildMenu} />
      <Modal
        title="Change title"
        open={renamingId !== null}
        onOk={doRename}
        onCancel={() => setRenamingId(null)}
        okText="Save"
        destroyOnClose
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
