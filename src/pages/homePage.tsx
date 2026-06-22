import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, doc, documentId, getDoc, getDocs, query, where } from 'firebase/firestore';
import { chunk } from 'lodash';
import { firebaseDatabase } from '../services/firebase';
import Card from '../components/card/card';
import CardListWrapper from '../components/card/cardListWrapper';
import { ExperimentDoc } from '../types';

type ShowcaseCard = ExperimentDoc & { id: string };

const HomePage = () => {
  const navigate = useNavigate();
  const [showcases, setShowcases] = useState<ShowcaseCard[]>([]);

  useEffect(() => {
    // The homepage is curated by config/homepage.items (an ordered list of experiment ids),
    // editable in one place. We fetch exactly those experiments and render them in that order.
    // (Empty until scripts/feature.mjs init has populated it.)
    const fetchHomepage = async () => {
      const cfg = await getDoc(doc(firebaseDatabase, 'config', 'homepage'));
      const ids: string[] = cfg.exists() ? (cfg.data().items ?? []) : [];
      if (!ids.length) {
        setShowcases([]);
        return;
      }
      const byId = new Map<string, ShowcaseCard>();
      await Promise.all(
        // Firestore allows up to 30 values per `in` query.
        chunk(ids, 30).map(async (group) => {
          const snap = await getDocs(
            query(collection(firebaseDatabase, 'experiments'), where(documentId(), 'in', group)),
          );
          snap.forEach((d) => byId.set(d.id, { ...(d.data() as ExperimentDoc), id: d.id }));
        }),
      );
      setShowcases(ids.map((id) => byId.get(id)).filter((x): x is ShowcaseCard => !!x));
    };
    fetchHomepage();
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
