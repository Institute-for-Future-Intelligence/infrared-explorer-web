/*
 * The dialogs the owner's project actions share between the project's ⋯
 * menu (ProjectMenu.tsx) and the cards of the AI Project list
 * (pages/labProjects/ProjectsPage.tsx): Rename, and the words Delete Project
 * asks with — the app's (ProjectsScreen's DELETE_MESSAGE / DELETE_MANY_MESSAGE).
 */

import { useState } from 'react';
import { Input, Modal } from 'antd';

export const DELETE_PROJECT_MESSAGE =
  'The conversation, the plan, the pictures and the report are deleted. Your recordings and photos stay in the gallery.';
export const DELETE_PROJECTS_MESSAGE =
  'Their conversations, plans, pictures and reports are deleted. Your recordings and photos stay in the gallery.';

/** Rename: the box opens with the current name; a failure is shown and the box stays open. */
export const RenameProjectDialog = ({
  open,
  initial,
  onClose,
  onRename,
}: {
  open: boolean;
  /** The current name, put in the box each time it opens. */
  initial: string;
  onClose: () => void;
  /** Rejects with a message to show. */
  onRename: (title: string) => Promise<void>;
}) => {
  const [title, setTitle] = useState(initial);
  const [busy, setBusy] = useState(false);
  // the box takes the name as it opens, and only then: a name the AI gives meanwhile does not clear what is typed
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTitle(initial);
      setBusy(false);
    }
  }

  const rename = async () => {
    const t = title.trim();
    if (!t || busy) {
      return;
    }
    setBusy(true);
    try {
      await onRename(t);
      onClose();
    } catch (e) {
      Modal.error({ title: 'Could not rename the project', content: (e as Error)?.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Rename"
      okText="Rename"
      onOk={rename}
      onCancel={onClose}
      okButtonProps={{ disabled: !title.trim(), loading: busy }}
      width={420}
      destroyOnHidden
    >
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onPressEnter={rename}
        maxLength={120}
        placeholder="Project name"
        autoFocus
      />
    </Modal>
  );
};
