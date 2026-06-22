import { useEffect, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import { ExperimentDoc, User } from '../types';
import useCommonStore from '../stores/common';
import ExperimentGrid from '../components/card/experimentGrid';
import { setTrash } from '../services/experiments';

type ExperimentCard = ExperimentDoc & { id: string };

/** My untrimmed (raw) clips — isRaw === true. Trash is filtered client-side to avoid a 3-field index. */
const Raw = () => {
  const user = useCommonStore((state) => state.user);
  const [experiments, setExperiments] = useState<ExperimentCard[]>([]);

  useEffect(() => {
    if (!user) return;
    const fetchRaw = async (user: User) => {
      const q = query(
        collection(firebaseDatabase, 'experiments'),
        where('ownerId', '==', user.id),
        where('isRaw', '==', true),
      );
      const snap = await getDocs(q);
      setExperiments(snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id })).filter((e) => !e.trash));
    };
    fetchRaw(user);
  }, [user]);

  const handleDelete = async (expId: string) => {
    try {
      await setTrash(expId, true);
      setExperiments((prev) => prev.filter((e) => e.id !== expId));
    } catch (err) {
      console.error('failed to move to trash', err);
    }
  };

  if (!user) return <div>Please sign in to see your raw data.</div>;

  return <ExperimentGrid items={experiments} onDelete={handleDelete} />;
};

export default Raw;
