/*
 * The ⋯ menu in a project's title row, for the owner: Rename, Share…, AI
 * Usage (not for staff, who have no limit) and Delete Project — the app's
 * corner menu less the phone's Upload to Cloud (a project the website shows
 * is on the cloud already). The dialogs each row opens live here too (Rename
 * and the delete words shared with the list's cards, ProjectDialogs.tsx),
 * except the Share panel: the page holds it, since the share chip in the
 * title's facts (ShareChip.tsx) opens it as well.
 */

import { useState } from 'react';
import { Button, Dropdown, Modal, type MenuProps } from 'antd';
import { Ellipsis, Info, Pencil, Share2, Trash2 } from 'lucide-react';
import styled from 'styled-components';
import { isEmptyProject } from '../core/empty';
import type { Project, ProjectBundle } from '../core/types';
import { DELETE_PROJECT_MESSAGE, RenameProjectDialog } from './ProjectDialogs';

const Usage = styled.div`
  white-space: pre-line;
  font-size: 14.5px;
  line-height: 1.5;
  color: var(--ifi-ink);
`;

const ProjectMenu = ({
  project,
  bundle,
  staff,
  onRename,
  onShare,
  onDelete,
  onUsage,
}: {
  project: Project;
  bundle: ProjectBundle;
  /** A staff account: no AI Usage row. */
  staff: boolean;
  onRename: (title: string) => Promise<void>;
  /** Opens the page's Share panel. */
  onShare: () => void;
  onDelete: () => Promise<void>;
  /** The AI Usage dialog's message, fresh from the server. */
  onUsage: () => Promise<string>;
}) => {
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [usage, setUsage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const empty = isEmptyProject(bundle);

  const items: MenuProps['items'] = [
    { key: 'rename', label: 'Rename', icon: <Pencil size={14} /> },
    // an empty project is not kept once the page is left: nothing to share
    { key: 'share', label: 'Share…', icon: <Share2 size={14} />, disabled: empty },
    ...(staff ? [] : [{ key: 'usage', label: 'AI Usage', icon: <Info size={14} /> }]),
    { type: 'divider' as const },
    { key: 'delete', label: 'Delete Project', icon: <Trash2 size={14} />, danger: true },
  ];
  const onClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'rename') {
      setRenaming(true);
    } else if (key === 'share') {
      onShare();
    } else if (key === 'usage') {
      onUsage().then(setUsage);
    } else if (key === 'delete') {
      setConfirmDelete(true);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await onDelete();
      setConfirmDelete(false);
    } catch (e) {
      Modal.error({ title: 'Could not delete the project', content: (e as Error)?.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dropdown menu={{ items, onClick }} trigger={['click']} placement="bottomRight">
        <Button type="text" icon={<Ellipsis size={18} />} aria-label="Project menu" />
      </Dropdown>
      <RenameProjectDialog
        open={renaming}
        initial={project.title}
        onClose={() => setRenaming(false)}
        onRename={onRename}
      />
      <Modal
        open={confirmDelete}
        title="Delete project?"
        okText="Delete"
        okButtonProps={{ danger: true, loading: busy }}
        onOk={remove}
        onCancel={() => setConfirmDelete(false)}
        width={440}
      >
        {DELETE_PROJECT_MESSAGE}
      </Modal>
      <Modal
        open={usage != null}
        title="AI Usage"
        onCancel={() => setUsage(null)}
        footer={[
          <Button key="ok" type="primary" onClick={() => setUsage(null)}>
            OK
          </Button>,
        ]}
        width={440}
      >
        <Usage>{usage ?? ''}</Usage>
      </Modal>
    </>
  );
};

export default ProjectMenu;
