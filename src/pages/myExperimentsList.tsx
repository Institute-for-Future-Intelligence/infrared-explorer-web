import { useEffect, useState } from 'react';
import useCommonStore from '../stores/common';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import { ExperimentDoc, User } from '../types';
import Card from '../components/card/card';
import CardListWrapper from '../components/card/cardListWrapper';
import { useNavigate } from 'react-router-dom';
import { setTrash } from '../services/experiments';

type ExperimentCard = ExperimentDoc & { id: string };

const MyExperimentsList = () => {
  const user = useCommonStore((state) => state.user);
  const [experiments, setExperiments] = useState<ExperimentCard[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    if (!user) return;
    const fetchExperiments = async (user: User) => {
      const q = query(
        collection(firebaseDatabase, 'experiments'),
        where('ownerId', '==', user.id),
        where('trash', '==', false),
      );
      const snap = await getDocs(q);
      setExperiments(snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id })));
    };
    fetchExperiments(user);
  }, [user]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    const expId = (e.target as any).id;
    if (expId) {
      navigate(`/experiments/${expId}`);
    }
  };

  const handleDelete = async (expId: string) => {
    try {
      await setTrash(expId, true);
      setExperiments((prev) => prev.filter((e) => e.id !== expId));
    } catch (err) {
      console.error('failed to move to trash', err);
    }
  };

  return (
    <CardListWrapper onClick={handleClick}>
      {experiments.map((exp) => (
        <Card key={exp.id} id={exp.id} url={exp.thumbnailURL} displayName={exp.displayName} onDelete={handleDelete} />
      ))}
    </CardListWrapper>
  );
};

export default MyExperimentsList;
