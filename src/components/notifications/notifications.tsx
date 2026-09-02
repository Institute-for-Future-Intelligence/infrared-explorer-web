import { MouseEvent, useEffect, useState } from 'react';
import { Badge, Button, Dropdown, MenuProps, Modal, message } from 'antd';
import { BellOutlined, CheckOutlined, CloseOutlined, DeleteOutlined } from '@ant-design/icons';
import {
  DocumentReference,
  WriteBatch,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { useNavigate } from 'react-router-dom';
import styled from 'styled-components';
import { firebaseDatabase } from '../../services/firebase';
import { User } from '../../types';
import { useIsMobile } from '../../hooks/useIsMobile';

interface NotificationItem {
  id: string;
  fromName: string;
  type: 'comment' | 'rating';
  expId: string;
  read: boolean;
  date: string;
}

// How many notifications the panel lists, and how many docs one sweep (mark all read / clear all)
// touches per batch — Firestore caps a WriteBatch at 500 writes, so stay under it and loop until
// the collection is exhausted. The backlog can be longer than the panel shows, and a "clear all"
// that left invisible leftovers behind — with a badge that refused to drop to zero — would read as
// a bug rather than as a page size.
const PAGE_SIZE = 20;
const SWEEP_SIZE = 300;

// The ✕ stays in the row instead of appearing on hover: this menu is reachable on touch, where
// there is no hover to reveal it. Muted grey so it never competes with the notification text,
// turning danger red only when it is about to be pressed.
const Row = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 2px 0;

  .notif-delete {
    flex: none;
    margin-top: -2px;
    color: #bbb;

    &:not(:disabled):hover {
      color: #ff4d4f;
    }
  }
`;

const HeaderRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 2px 0;

  .notif-heading {
    font-size: 12px;
    font-weight: 600;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .notif-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .notif-actions .ant-btn {
    font-size: 12px;
    padding: 0 6px;
  }
`;

/** Header bell: shows unread count and the user's recent notifications (written by Functions). */
const Notifications = ({ user }: { user: User }) => {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [items, setItems] = useState<NotificationItem[]>([]);

  const notifications = () => collection(firebaseDatabase, `users/${user.id}/notifications`);

  const fetchNotifications = async () => {
    try {
      const q = query(notifications(), orderBy('date', 'desc'), limit(PAGE_SIZE));
      const snap = await getDocs(q);
      setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<NotificationItem, 'id'>) })));
    } catch (e) {
      console.error('failed to fetch notifications', e);
    }
  };

  useEffect(() => {
    fetchNotifications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  const unread = items.filter((n) => !n.read).length;

  const onClickItem = async (n: NotificationItem) => {
    try {
      if (!n.read) {
        await updateDoc(doc(firebaseDatabase, `users/${user.id}/notifications/${n.id}`), { read: true });
        setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      }
    } catch (e) {
      console.error('failed to mark notification read', e);
    }
    navigate(`/experiments/${n.expId}`);
  };

  /** Dismiss one notification: it leaves the list immediately, and comes back only if the write failed. */
  const onDelete = async (n: NotificationItem) => {
    setItems((prev) => prev.filter((x) => x.id !== n.id));
    try {
      await deleteDoc(doc(firebaseDatabase, `users/${user.id}/notifications/${n.id}`));
    } catch (e) {
      console.error('failed to delete notification', e);
      message.error('Could not delete that notification.');
      fetchNotifications();
    }
  };

  /**
   * Run `apply` over the whole collection rather than the page on screen, SWEEP_SIZE docs per batch
   * until none are left. `unreadOnly` narrows it to what mark-all-read actually has to touch.
   */
  const sweep = async (apply: (batch: WriteBatch, ref: DocumentReference) => void, unreadOnly = false) => {
    for (;;) {
      const q = unreadOnly
        ? query(notifications(), where('read', '==', false), limit(SWEEP_SIZE))
        : query(notifications(), limit(SWEEP_SIZE));
      const snap = await getDocs(q);
      if (snap.empty) return;
      const batch = writeBatch(firebaseDatabase);
      snap.docs.forEach((d) => apply(batch, d.ref));
      await batch.commit();
      if (snap.size < SWEEP_SIZE) return;
    }
  };

  const onMarkAllRead = async () => {
    setItems((prev) => prev.map((x) => ({ ...x, read: true })));
    try {
      await sweep((batch, ref) => batch.update(ref, { read: true }), true);
    } catch (e) {
      console.error('failed to mark all notifications read', e);
      message.error('Could not mark everything read.');
      fetchNotifications();
    }
  };

  // Clearing is the only irreversible action in here — a notification has no trash to be restored
  // from — so it asks first, the way the app's other destructive menu items do.
  const onClearAll = () =>
    Modal.confirm({
      title: 'Clear all notifications?',
      content: 'They are removed for good. The comments and ratings themselves are untouched.',
      okText: 'Clear all',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await sweep((batch, ref) => batch.delete(ref));
          setItems([]);
        } catch (e) {
          console.error('failed to clear notifications', e);
          message.error('Could not clear your notifications.');
          fetchNotifications();
        }
      },
    });

  const label = (n: NotificationItem) =>
    `${n.fromName} ${n.type === 'comment' ? 'commented on' : 'rated'} your experiment`;

  // Every control added here acts on the list in place, so swallow the click: without this the menu
  // item underneath would navigate to the experiment and the dropdown would close, hiding the very
  // change the button just made.
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  const headerItems: MenuProps['items'] = [
    {
      key: 'header',
      type: 'group',
      label: (
        <HeaderRow
          onClick={stop}
          style={{ maxWidth: isMobile ? 'calc(100vw - 32px)' : 320, justifyContent: isMobile ? 'flex-end' : undefined }}
        >
          {/* The two actions come first on a phone: the heading is what gets dropped when the row
              is too narrow for both, since the bell already says what this menu is. */}
          {!isMobile && <span className="notif-heading">Notifications</span>}
          <span className="notif-actions">
            <Button
              type="text"
              size="small"
              icon={<CheckOutlined />}
              disabled={!unread}
              onClick={(e) => {
                stop(e);
                onMarkAllRead();
              }}
            >
              Mark all read
            </Button>
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              disabled={!items.length}
              onClick={(e) => {
                stop(e);
                onClearAll();
              }}
            >
              Clear all
            </Button>
          </span>
        </HeaderRow>
      ),
    },
    { key: 'header-divider', type: 'divider' },
  ];

  const listItems: MenuProps['items'] = items.length
    ? items.map((n) => ({
        key: n.id,
        onClick: () => onClickItem(n),
        label: (
          <Row
            style={{
              // Cap to the viewport on mobile so the bottom-right popup doesn't overflow the edge.
              maxWidth: isMobile ? 'calc(100vw - 32px)' : 320,
              whiteSpace: 'normal',
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: n.read ? 'normal' : 600 }}>{label(n)}</div>
              <div style={{ fontSize: 11, color: '#999' }}>{n.date}</div>
            </span>
            <Button
              className="notif-delete"
              type="text"
              size="small"
              icon={<CloseOutlined />}
              title="Delete"
              aria-label="Delete notification"
              onClick={(e) => {
                stop(e);
                onDelete(n);
              }}
            />
          </Row>
        ),
      }))
    : [{ key: 'empty', label: 'No notifications', disabled: true }];

  return (
    <Dropdown
      menu={{ items: [...headerItems, ...listItems] }}
      trigger={['click']}
      placement="bottomRight"
      onOpenChange={(open) => open && fetchNotifications()}
    >
      <Badge count={unread} size="small" offset={[-2, 2]}>
        <BellOutlined style={{ fontSize: 20, color: '#666', cursor: 'pointer' }} />
      </Badge>
    </Dropdown>
  );
};

export default Notifications;
