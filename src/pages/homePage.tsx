import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AutoComplete, Spin } from 'antd';
import { collection, doc, documentId, getDoc, getDocs, query, where } from 'firebase/firestore';
import { chunk } from 'lodash';
import { firebaseDatabase } from '../services/firebase';
import Card from '../components/card/card';
import CardListWrapper from '../components/card/cardListWrapper';
import Footer from '../components/footer';
import { ExperimentDoc } from '../types';

type ShowcaseCard = ExperimentDoc & { id: string };

const HomePage = () => {
  const navigate = useNavigate();
  const [showcases, setShowcases] = useState<ShowcaseCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [term, setTerm] = useState('');

  useEffect(() => {
    // The homepage is curated by config/homepage.items (an ordered list of experiment ids),
    // editable in one place. We fetch exactly those experiments and render them in that order.
    const fetchHomepage = async () => {
      try {
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
      } finally {
        setLoading(false);
      }
    };
    fetchHomepage();
  }, []);

  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return showcases;
    return showcases.filter((s) =>
      [s.displayName, s.author, s.description, s.subject].some((f) => (f ?? '').toLowerCase().includes(q)),
    );
  }, [showcases, term]);

  // Title suggestions for the autocomplete dropdown.
  const options = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return [];
    return showcases
      .filter((s) => (s.displayName ?? '').toLowerCase().includes(q))
      .slice(0, 8)
      .map((s) => ({ value: s.displayName }));
  }, [showcases, term]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 16px' }}>
        <AutoComplete
          options={options}
          value={term}
          onChange={setTerm}
          allowClear
          style={{ width: 360, maxWidth: '80vw' }}
          placeholder="Search experiments by title, author, subject…"
        />
      </div>

      <CardListWrapper>
        {filtered.map((showcase) => (
          <Card
            key={showcase.id}
            id={showcase.id}
            url={showcase.thumbnailURL}
            displayName={showcase.displayName}
            subject={showcase.subject}
            author={showcase.author}
            description={showcase.description}
            ratingSum={showcase.ratingSum}
            ratingCount={showcase.ratingCount}
            viewCount={showcase.viewCount}
            onOpen={(id) => navigate(`/experiments/${id}`)}
          />
        ))}
      </CardListWrapper>

      <Footer />
    </div>
  );
};

export default HomePage;
