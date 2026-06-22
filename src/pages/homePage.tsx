import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import Card from '../components/card/card';
import CardListWrapper from '../components/card/cardListWrapper';
import { ExperimentDoc } from '../types';

type ShowcaseCard = ExperimentDoc & { id: string };

const HomePage = () => {
  const navigate = useNavigate();
  const [showcases, setShowcases] = useState<ShowcaseCard[]>([]);

  useEffect(() => {
    // Public showcases live in the merged experiments collection as ownerId === 'system'.
    // (Empty until the seed script has run — see docs/telelab-migration.md §7.)
    const fetchShowcases = async () => {
      const q = query(collection(firebaseDatabase, 'experiments'), where('ownerId', '==', 'system'));
      const snap = await getDocs(q);
      setShowcases(snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id })));
    };
    fetchShowcases();
  }, []);

  const handleClick = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    const expId = (e.target as any).id;
    if (expId) {
      navigate(`experiments/${expId}`);
    }
  };

  return (
    <CardListWrapper onClick={handleClick}>
      {showcases.map((showcase) => (
        <Card key={showcase.id} id={showcase.id} url={showcase.thumbnailURL} displayName={showcase.displayName} />
      ))}
    </CardListWrapper>
  );
};

export default HomePage;
