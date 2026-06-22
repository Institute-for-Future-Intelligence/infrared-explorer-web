import { useCallback, useEffect, useState } from 'react';
import { List } from 'antd';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import { ExperimentDoc } from '../types';
import useCommonStore from '../stores/common';
import { deleteExperiment, setTrash } from '../services/experiments';

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
    } catch (err) {
      console.error('failed to restore', err);
    }
  };

  const removeForever = async (id: string) => {
    try {
      await deleteExperiment(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      console.error('failed to delete', err);
    }
  };

  if (!user) return <div>Please sign in to view your trash.</div>;

  return (
    <List
      header={<b>Trash</b>}
      locale={{ emptyText: 'Trash is empty' }}
      dataSource={items}
      renderItem={(item) => (
        <List.Item
          actions={[
            <a key="restore" onClick={() => restore(item.id)}>
              Restore
            </a>,
            <a key="delete" style={{ color: 'red' }} onClick={() => removeForever(item.id)}>
              Delete forever
            </a>,
          ]}
        >
          <List.Item.Meta title={item.displayName} description={item.date} />
        </List.Item>
      )}
    />
  );
};

export default Trash;
