/*
 * A teacher's actions on one class, as a ⋮ menu and the dialogs behind it — share the join info,
 * allow joining, change the password, rename, delete — so the My Classes cards and the class page
 * offer the same things the same way (the app's useClassActions). Share Join Info first shows what
 * will go out — the class number, the password and the message itself — and sends it only on
 * Share (user 2026-11-02): the browser's share sheet where there is one, the clipboard otherwise.
 */

import { useState } from 'react';
import { Button, Dropdown, Form, Input, Modal, Typography, message, type MenuProps } from 'antd';
import { EllipsisVertical } from 'lucide-react';
import { MENU_ICONS } from '../menuIcons';
import { ClassInfo } from '../../classroom/types';
import { deleteClass, fetchClassPassword, renameClass, setJoinOpen } from '../../classroom/classroomApi';
import ChangeClassPasswordModal from './ChangeClassPasswordModal';

/** The message students get — the same words the app shares. */
const joinInfoMessage = (info: ClassInfo, password: string) =>
  `Join "${info.name}" in Infrared Explorer\nClass number: ${info.classNumber}\nPassword: ${password}`;

const ClassActionsMenu = ({
  info,
  withJoining = true,
  onChanged,
  onDeleted,
}: {
  info: ClassInfo;
  /** The Allow Joining row; off where the page has its own switch. */
  withJoining?: boolean;
  /** A rename or a joining change went through. */
  onChanged: (patch: Partial<ClassInfo>) => void;
  /** The class is gone. */
  onDeleted: () => void;
}) => {
  const [sharing, setSharing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  const items: MenuProps['items'] = [
    { key: 'share', label: 'Share Join Info', icon: MENU_ICONS.share },
    ...(withJoining ? [{ key: 'joining', label: info.joinOpen ? 'Stop Accepting Students' : 'Accept Students' }] : []),
    { key: 'password', label: 'Change Password', icon: MENU_ICONS.rename },
    { key: 'rename', label: 'Rename Class', icon: MENU_ICONS.rename },
    { type: 'divider' as const },
    { key: 'delete', label: 'Delete Class', icon: MENU_ICONS.delete, danger: true },
  ];

  const onClick: MenuProps['onClick'] = ({ key, domEvent }) => {
    domEvent.stopPropagation();
    if (key === 'share') {
      fetchClassPassword(info.id)
        .then((p) => {
          if (p == null) message.error("Couldn't read the join password.");
          else setSharing(p);
        })
        .catch(() => message.error("Couldn't read the join password."));
    } else if (key === 'joining') {
      const v = !info.joinOpen;
      setJoinOpen(info.id, v)
        .then(() => onChanged({ joinOpen: v }))
        .catch((e) => message.error((e as Error)?.message || "Couldn't update."));
    } else if (key === 'password') {
      setChangingPassword(true);
    } else if (key === 'rename') {
      setName(info.name);
      setRenaming(true);
    } else if (key === 'delete') {
      Modal.confirm({
        title: 'Delete this class?',
        content: 'This permanently deletes the class and the reports students handed in, and cannot be undone.',
        okText: 'Delete',
        okButtonProps: { danger: true },
        cancelText: 'Cancel',
        onOk: () =>
          deleteClass(info.id)
            .then(() => {
              message.success('Class deleted');
              onDeleted();
            })
            .catch((e) => message.error((e as Error)?.message || "Couldn't delete the class.")),
      });
    }
  };

  const share = async () => {
    if (sharing == null) return;
    const text = joinInfoMessage(info, sharing);
    setSharing(null);
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch {
        // cancelled, or no sheet after all: fall through to the clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      message.success('Join info copied. Paste it to your students.');
    } catch {
      message.error("Couldn't copy the join info.");
    }
  };

  const rename = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await renameClass(info.id, trimmed);
      onChanged({ name: trimmed });
      setRenaming(false);
    } catch (e) {
      message.error((e as Error)?.message || "Couldn't rename the class.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span onClick={(e) => e.stopPropagation()}>
      <Dropdown menu={{ items, onClick }} trigger={['click']} placement="bottomRight">
        <Button type="text" icon={<EllipsisVertical size={18} />} aria-label="Class menu" />
      </Dropdown>

      <Modal
        open={sharing != null}
        title="Share Join Info"
        okText="Share"
        onOk={share}
        onCancel={() => setSharing(null)}
        width={440}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 8, margin: '12px 0' }}>
          <span style={{ color: 'var(--ifi-grey)' }}>Class number</span>
          <Typography.Text strong copyable style={{ letterSpacing: 2 }}>
            {info.classNumber}
          </Typography.Text>
          <span style={{ color: 'var(--ifi-grey)' }}>Password</span>
          <Typography.Text strong copyable style={{ letterSpacing: 1 }}>
            {sharing ?? ''}
          </Typography.Text>
        </div>
        <pre
          style={{
            margin: 0,
            padding: '10px 12px',
            background: 'var(--ifi-panel)',
            border: '1px solid #e8e8e8',
            borderRadius: 8,
            whiteSpace: 'pre-wrap',
            fontFamily: 'inherit',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {sharing != null ? joinInfoMessage(info, sharing) : ''}
        </pre>
      </Modal>

      <Modal
        open={renaming}
        title="Rename class"
        okText="Rename"
        okButtonProps={{ loading: busy, disabled: !name.trim() }}
        onOk={rename}
        onCancel={() => setRenaming(false)}
        width={440}
        destroyOnHidden
      >
        <Form layout="vertical" requiredMark={false} onFinish={rename}>
          <Form.Item label="Class name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
          </Form.Item>
        </Form>
      </Modal>

      <ChangeClassPasswordModal classId={info.id} open={changingPassword} onClose={() => setChangingPassword(false)} />
    </span>
  );
};

export default ClassActionsMenu;
