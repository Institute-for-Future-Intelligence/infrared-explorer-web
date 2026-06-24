import { useEffect, useState } from 'react';
import useCommonStore from '../stores/common';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import { ExperimentDoc, User } from '../types';
import OwnedExperimentGrid from '../components/card/ownedExperimentGrid';

type ExperimentCard = ExperimentDoc & { id: string };

const MyExperimentsList = () => {
  const user = useCommonStore((state) => state.user);
  const [experiments, setExperiments] = useState<ExperimentCard[]>([]);

  useEffect(() => {
    if (!user) return;
    const fetchExperiments = async (user: User) => {
      const q = query(
        collection(firebaseDatabase, 'experiments'),
        where('ownerId', '==', user.id),
        where('trash', '==', false),
      );
      const snap = await getDocs(q);
      const docs = snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id }));
      // Newest-first by the server-set `createdAt` timestamp. Sorted client-side to avoid a
      // composite index and to tolerate legacy docs missing `createdAt`.
      docs.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
      setExperiments(docs);
    };
    fetchExperiments(user);
  }, [user]);

  if (!user) return <div>Please sign in to see your experiments.</div>;

  return <OwnedExperimentGrid items={experiments} setItems={setExperiments} />;
};

export default MyExperimentsList;
