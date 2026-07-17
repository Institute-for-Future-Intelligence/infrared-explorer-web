import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Spin } from 'antd';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import Card from '../components/card/card';
import CardListWrapper from '../components/card/cardListWrapper';
import { SUBJECT_META } from '../components/card/subjectMeta';
import SubjectFilter, { SubjectFilterValue } from '../components/subjectFilter';
import SortMenu, { SORT_OPTIONS, SortValue, compareExperiments } from '../components/sortMenu';
import Footer from '../components/footer';
import BackToTop from '../components/backToTop';
import SiteShareStats from '../components/siteShareStats';
import EmptyState from '../components/emptyState';
import { usePersistentState } from '../hooks/usePersistentState';
import useCommonStore from '../stores/common';
import { ExperimentDoc, ExperimentSubjects } from '../types';
import { authorProfilePath } from '../utils/helpers';

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

// The public showcase is a curated gallery, not a workspace, so "Recently updated" is noise here —
// drop the edit-time option and offer only "Newest" (createdAt desc) as the time order.
// The homepage is all-public, so "By visibility" would be a no-op; drop it (and "Recently updated").
const HOME_SORT_OPTIONS = SORT_OPTIONS.filter((o) => o.key !== 'updated' && o.key !== 'visibility').map((o) =>
  o.key === 'newest' ? { ...o, label: 'Newest' } : o,
);

type ShowcaseCard = ExperimentDoc & { id: string };

const HomePage = () => {
  const navigate = useNavigate();
  const [showcases, setShowcases] = useState<ShowcaseCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Sort + subject filter are remembered across visits (localStorage); search is intentionally not
  // (the shared header term is cleared on leave below).
  const [subject, setSubject] = usePersistentState<SubjectFilterValue>('home.subject', 'all');
  const [sort, setSort] = usePersistentState<SortValue>('home.sort', 'newest');

  // Search lives in the global header (rendered on the home page only); the term + suggestion list are
  // kept in the store so the header box and this grid share them.
  const term = useCommonStore((state) => state.homeSearchTerm);
  const setHomeSearchTerm = useCommonStore((state) => state.setHomeSearchTerm);
  const setHomeSearchItems = useCommonStore((state) => state.setHomeSearchItems);

  // Homepage lists the staff-curated experiments (`featured: true`, set by staff on their own
  // experiments from the UI — see featureControl — or in bulk via the Admin SDK / scripts/feature.mjs;
  // rules enforce staff+owner and the featured⇒public invariant). Decoupled from `visibility`: users
  // publish to their own profile page by setting visibility 'public', which no longer implies a
  // spot on the homepage. The
  // visibility filter must STAY in this query — rules are not filters, and an anonymous list
  // query is only authorized when its constraints prove `visibility in [public, unlisted]` for
  // every match (featuring sets public, so the filter drops nothing except experiments their
  // owner has since un-published — which is exactly right). Equality-only on purpose: no
  // composite index to deploy, and ordering is client-side below (compareExperiments), which
  // also tolerates legacy docs missing `createdAt`.
  const fetchHomepage = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const snap = await getDocs(
        query(
          collection(firebaseDatabase, 'experiments'),
          where('featured', '==', true),
          where('visibility', '==', 'public'),
          where('trash', '==', false),
        ),
      );
      setShowcases(snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id })));
    } catch (e) {
      // A failed fetch used to leave a silent blank page; surface it with a retry instead.
      console.error('failed to load homepage experiments', e);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHomepage();
  }, [fetchHomepage]);

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

  // Apply the subject filter + search term, then sort the survivors by the chosen order. Sorting is
  // client-side over the already-loaded list (the homepage fetches every public experiment at once).
  const visible = useMemo(() => {
    const q = term.trim().toLowerCase();
    const matches = showcases.filter((s) => {
      if (subject !== 'all' && s.subject !== subject) return false;
      if (!q) return true;
      return [s.displayName, s.author, s.description, s.subject].some((f) => (f ?? '').toLowerCase().includes(q));
    });
    return matches.sort(compareExperiments(sort));
  }, [showcases, term, subject, sort]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="home-page">
        <EmptyState
          title="Couldn't load experiments"
          hint="Something went wrong reaching the gallery. Check your connection and try again."
          action={{ label: 'Retry', onClick: () => void fetchHomepage() }}
        />
      </div>
    );
  }

  return (
    <div className="home-page">
      {/* One toolbar row: sort control + subject filter chips on the left, share buttons + site stats
          on the right. The sort menu shows regardless of which subjects are present. */}
      <div className="home-toolbar">
        <SortMenu value={sort} onChange={setSort} options={HOME_SORT_OPTIONS} />
        {availableSubjects.length > 0 && (
          <SubjectFilter value={subject} subjects={availableSubjects} onChange={setSubject} />
        )}
        <div className="home-toolbar-share">
          <SiteShareStats />
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title="No heat signatures found"
          hint={
            subject !== 'all' || term.trim()
              ? 'Try clearing the subject filter or search to see all experiments.'
              : 'No experiments are featured on the homepage yet.'
          }
          action={
            subject !== 'all' || term.trim()
              ? {
                  label: 'Clear filters',
                  onClick: () => {
                    setSubject('all');
                    setHomeSearchTerm('');
                  },
                }
              : undefined
          }
        />
      ) : (
        <CardListWrapper>
          {visible.map((showcase) => {
            const authorHref = authorProfilePath(showcase.ownerId, showcase.author);
            return (
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
                createdAt={showcase.createdAt}
                duration={showcase.duration}
                onOpen={(id) => navigate(`/experiments/${id}`)}
                onAuthorClick={authorHref ? () => navigate(authorHref) : undefined}
              />
            );
          })}
        </CardListWrapper>
      )}

      <Footer />

      <BackToTop />
    </div>
  );
};

export default HomePage;
