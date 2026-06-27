import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Spin } from 'antd';
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import Card from '../components/card/card';
import CardListWrapper from '../components/card/cardListWrapper';
import { SUBJECT_META } from '../components/card/subjectMeta';
import SubjectFilter, { SubjectFilterValue } from '../components/subjectFilter';
import Footer from '../components/footer';
import SiteShareStats from '../components/siteShareStats';
import useCommonStore from '../stores/common';
import { ExperimentDoc, ExperimentSubjects } from '../types';

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

type ShowcaseCard = ExperimentDoc & { id: string };

const HomePage = () => {
  const navigate = useNavigate();
  const [showcases, setShowcases] = useState<ShowcaseCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [subject, setSubject] = useState<SubjectFilterValue>('all');

  // Search lives in the global header (rendered on the home page only); the term + suggestion list are
  // kept in the store so the header box and this grid share them.
  const term = useCommonStore((state) => state.homeSearchTerm);
  const setHomeSearchTerm = useCommonStore((state) => state.setHomeSearchTerm);
  const setHomeSearchItems = useCommonStore((state) => state.setHomeSearchItems);

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

  // Publish the loaded experiments to the header search's autocomplete (option value = id, label = title).
  useEffect(() => {
    setHomeSearchItems(showcases.map((s) => ({ id: s.id, label: s.displayName })));
  }, [showcases, setHomeSearchItems]);

  // Reset the shared search when leaving the home page so a stale term doesn't linger.
  useEffect(() => {
    return () => {
      setHomeSearchTerm('');
      setHomeSearchItems([]);
    };
  }, [setHomeSearchTerm, setHomeSearchItems]);

  // Subject chips to offer: only the disciplines actually present in the loaded experiments, in the
  // fixed badge order — so an empty "Biology" filter never shows when nothing is tagged Biology.
  const availableSubjects = useMemo(() => {
    const present = new Set(
      showcases.map((s) => s.subject).filter((s): s is ExperimentSubjects => !!s && !!SUBJECT_META[s]),
    );
    return SUBJECT_ORDER.filter((s) => present.has(s));
  }, [showcases]);

  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase();
    return showcases.filter((s) => {
      if (subject !== 'all' && s.subject !== subject) return false;
      if (!q) return true;
      return [s.displayName, s.author, s.description, s.subject].some((f) => (f ?? '').toLowerCase().includes(q));
    });
  }, [showcases, term, subject]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div>
      {/* One toolbar row: subject filter chips on the left, share buttons + site stats on the right. */}
      <div className="home-toolbar">
        {availableSubjects.length > 0 && (
          <SubjectFilter value={subject} subjects={availableSubjects} onChange={setSubject} />
        )}
        <div className="home-toolbar-share">
          <SiteShareStats />
        </div>
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
