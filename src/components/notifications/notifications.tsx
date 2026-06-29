import { useEffect, useState } from 'react';
import { Badge, Dropdown, MenuProps } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { collection, doc, getDocs, limit, orderBy, query, updateDoc } from 'firebase/firestore';
import { useNavigate } from 'react-router-dom';
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

/** Header bell: shows unread count and the user's recent notifications (written by Functions). */
const Notifications = ({ user }: { user: User }) => {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [items, setItems] = useState<NotificationItem[]>([]);

  const fetchNotifications = async () => {
    try {
      const q = query(
        collection(firebaseDatabase, `users/${user.id}/notifications`),
        orderBy('date', 'desc'),
        limit(20),
      );
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

  const label = (n: NotificationItem) =>
    `${n.fromName} ${n.type === 'comment' ? 'commented on' : 'rated'} your experiment`;

  const menuItems: MenuProps['items'] = items.length
    ? items.map((n) => ({
        key: n.id,
        onClick: () => onClickItem(n),
        label: (
          <div
            style={{
              // Cap to the viewport on mobile so the bottom-right popup doesn't overflow the edge.
              maxWidth: isMobile ? 'calc(100vw - 32px)' : 280,
              whiteSpace: 'normal',
              padding: '2px 0',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: n.read ? 'normal' : 600 }}>{label(n)}</div>
            <div style={{ fontSize: 11, color: '#999' }}>{n.date}</div>
          </div>
        ),
      }))
    : [{ key: 'empty', label: 'No notifications', disabled: true }];

  return (
    <Dropdown
      menu={{ items: menuItems }}
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
