import { useCallback, useEffect, useState } from 'react';
import { Modal, message } from 'antd';
import type { MenuProps } from 'antd';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import { ExperimentDoc } from '../types';
import useCommonStore from '../stores/common';
import { deleteExperiment, setTrash } from '../services/experiments';
import ExperimentGrid, { GridItem } from '../components/card/experimentGrid';

type TrashedExperiment = ExperimentDoc & { id: string };

const Trash = () => {
  const user = useCommonStore((state) => state.user);
  const [items, setItems] = useState<TrashedExperiment[]>([]);

  const fetchTrash = useCallback(async (uid: string) => {
    const q = query(
      collection(firebaseDatabase, 'experiments'),
      where('ownerId', '==', uid),
      where('trash', '==', true),
    );
    const snap = await getDocs(q);
    setItems(snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id })));
  }, []);

  useEffect(() => {
    if (user) fetchTrash(user.id);
  }, [user, fetchTrash]);

  const restore = async (id: string) => {
    try {
      await setTrash(id, false);
      setItems((prev) => prev.filter((i) => i.id !== id));
      message.success('Restored');
    } catch (err) {
      console.error('failed to restore', err);
      message.error('Failed to restore');
    }
  };

  const removeForever = (id: string) =>
    Modal.confirm({
      title: 'Delete this forever?',
      content: 'This cannot be undone.',
      okText: 'Delete forever',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await deleteExperiment(id);
          setItems((prev) => prev.filter((i) => i.id !== id));
          message.success('Deleted');
        } catch (err) {
          console.error('failed to delete', err);
          message.error('Failed to delete');
        }
      },
    });

  const buildMenu = (item: GridItem): MenuProps['items'] => [
    { key: 'restore', label: 'Restore', onClick: () => restore(item.id) },
    { type: 'divider' },
    { key: 'delete', label: 'Delete forever', danger: true, onClick: () => removeForever(item.id) },
  ];

  if (!user) return <div>Please sign in to view your trash.</div>;

  return items.length === 0 ? (
    <div style={{ padding: 16 }}>Trash is empty</div>
  ) : (
    <ExperimentGrid items={items} buildMenu={buildMenu} />
  );
};

export default Trash;
