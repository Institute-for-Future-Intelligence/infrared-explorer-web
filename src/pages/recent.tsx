import { useEffect, useState } from 'react';
import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import useCommonStore from '../stores/common';
import ExperimentGrid, { GridItem } from '../components/card/experimentGrid';

const Recent = () => {
  const user = useCommonStore((state) => state.user);
  const [items, setItems] = useState<GridItem[]>([]);

  useEffect(() => {
    if (!user) return;
    const fetchRecent = async () => {
      const q = query(collection(firebaseDatabase, `users/${user.id}/history`), orderBy('viewedAt', 'desc'), limit(24));
      const snap = await getDocs(q);
      setItems(
        snap.docs.map((d) => {
          const data = d.data();
          return { id: d.id, thumbnailURL: data.thumbnailURL ?? '', displayName: data.displayName ?? '' };
        }),
      );
    };
    fetchRecent();
  }, [user]);

  if (!user) return <div>Please sign in to see your recent experiments.</div>;

  return <ExperimentGrid items={items} />;
};

export default Recent;
