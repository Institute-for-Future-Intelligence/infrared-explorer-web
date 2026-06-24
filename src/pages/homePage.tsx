import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AutoComplete, Spin } from 'antd';
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
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
    // Homepage lists every public experiment newest-first, ordered by the server-set `createdAt`
    // timestamp (set on both seeded showcases and user clones). `date` is a free-form localized
    // string and does not sort chronologically, so it must not be used as the order key.
    const fetchHomepage = async () => {
      try {
        const snap = await getDocs(
          query(
            collection(firebaseDatabase, 'experiments'),
            where('visibility', '==', 'public'),
            where('trash', '==', false),
            orderBy('createdAt', 'desc'),
          ),
        );
        setShowcases(snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id })));
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

  // Suggestions for the autocomplete dropdown. With no term entered, list every showcase in card
  // display order so clicking the box reveals the full catalog (the dropdown scrolls). Option values
  // are ids (unique even when titles repeat) with the title shown as the label; selecting one opens
  // that experiment.
  const options = useMemo(() => {
    const q = term.trim().toLowerCase();
    const matches = q ? showcases.filter((s) => (s.displayName ?? '').toLowerCase().includes(q)) : showcases;
    return matches.map((s) => ({ value: s.id, label: s.displayName }));
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
          onSelect={(id: string) => navigate(`/experiments/${id}`)}
          filterOption={false}
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
            commentCount={showcase.commentCount}
            onOpen={(id) => navigate(`/experiments/${id}`)}
          />
        ))}
      </CardListWrapper>

      <Footer />
    </div>
  );
};

export default HomePage;
