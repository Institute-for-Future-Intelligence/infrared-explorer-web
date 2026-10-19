/*
 * The dialogs the owner's project actions share between the project's ⋮
 * menu (ProjectMenu.tsx) and the cards of the AI Project list
 * (pages/labProjects/ProjectsPage.tsx): Rename (whose box Save as… reuses to
 * name the copy), and the words Delete Project asks with — the app's
 * (ProjectsScreen's DELETE_MESSAGE / DELETE_MANY_MESSAGE).
 */

import { useState } from 'react';
import { Input, Modal } from 'antd';
import { shownTitle } from '../core/empty';

export const DELETE_PROJECT_MESSAGE =
  'The conversation, the plan, the pictures and the report are deleted. Your recordings and photos stay in the gallery.';
export const DELETE_PROJECTS_MESSAGE =
  'Their conversations, plans, pictures and reports are deleted. Your recordings and photos stay in the gallery.';

/**
 * Rename: the box opens with the current name as the screen shows it (shownTitle); left as it is, the
 * stored name is kept. A failure is shown and the box stays open. Save as… asks for the copy's name
 * with the same box, under its own heading, button and failure title.
 */
export const RenameProjectDialog = ({
  open,
  initial,
  onClose,
  onRename,
  heading = 'Rename',
  okText = 'Rename',
  failTitle = 'Could not rename the experiment',
}: {
  open: boolean;
  /** The current name, put in the box each time it opens. */
  initial: string;
  onClose: () => void;
  /** Rejects with a message to show. */
  onRename: (title: string) => Promise<void>;
  heading?: string;
  okText?: string;
  failTitle?: string;
}) => {
  const [title, setTitle] = useState(shownTitle(initial));
  const [busy, setBusy] = useState(false);
  // the box takes the name as it opens, and only then: a name the AI gives meanwhile does not clear what is typed
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTitle(shownTitle(initial));
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
      await onRename(t === shownTitle(initial) ? initial : t);
      onClose();
    } catch (e) {
      Modal.error({ title: failTitle, content: (e as Error)?.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={heading}
      okText={okText}
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
        placeholder="Experiment name"
        autoFocus
      />
    </Modal>
  );
};
