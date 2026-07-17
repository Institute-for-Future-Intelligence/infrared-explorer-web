import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Spin } from 'antd';
import { SortAscendingOutlined } from '@ant-design/icons';
import { Clock, Lock } from 'lucide-react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import Card from '../components/card/card';
import CardListWrapper from '../components/card/cardListWrapper';
import { SUBJECT_META } from '../components/card/subjectMeta';
import HeroBoard from '../components/home/heroBoard';
import HomeRow from '../components/home/homeRow';
import PoolTabs, { HomePool } from '../components/home/poolTabs';
import SubjectFilter, { SubjectFilterValue } from '../components/subjectFilter';
import SortMenu, { SORT_OPTIONS, SortValue, compareExperiments } from '../components/sortMenu';
import Footer from '../components/footer';
import BackToTop from '../components/backToTop';
import EmptyState from '../components/emptyState';
import { usePersistentState } from '../hooks/usePersistentState';
import { useViewHistory } from '../hooks/useExperimentLists';
import { useCommunityExperiments } from '../hooks/useCommunityExperiments';
import useCommonStore from '../stores/common';
import { getSiteStats, SiteStats } from '../services/stats';
import { buildHomeLayout, ShowcaseCard } from '../utils/homeLayout';
import { ExperimentSubjects } from '../types';
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

const HomePage = () => {
  const navigate = useNavigate();
  const openExperiment = useCallback((id: string) => navigate(`/experiments/${id}`), [navigate]);
  const [showcases, setShowcases] = useState<ShowcaseCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [stats, setStats] = useState<SiteStats | null>(null);
  // Sort + subject filter are remembered across visits (localStorage); search is intentionally not
  // (the shared header term is cleared on leave below).
  const [subject, setSubject] = usePersistentState<SubjectFilterValue>('home.subject', 'all');
  const [sort, setSort] = usePersistentState<SortValue>('home.sort', 'newest');
  // Which bottom pool is showing: the staff-curated Showcase, or the open Community. Remembered
  // across visits like the other browse prefs.
  const [pool, setPool] = usePersistentState<HomePool>('home.pool', 'showcase');

  // Search lives in the global header (rendered on the home page only); the term + suggestion list are
  // kept in the store so the header box and this grid share them.
  const term = useCommonStore((state) => state.homeSearchTerm);
  const setHomeSearchTerm = useCommonStore((state) => state.setHomeSearchTerm);
  const setHomeSearchItems = useCommonStore((state) => state.setHomeSearchItems);
  const user = useCommonStore((state) => state.user);

  // Sticky-toolbar shadow: a 1px sentinel just above the toolbar; when it scrolls out of the
  // content viewport the toolbar is "stuck", so we raise its glass + shadow.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(false);

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
      setShowcases(snap.docs.map((d) => ({ ...(d.data() as ShowcaseCard), id: d.id })));
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

  // Site stats ("N users · M experiments") power the hero's social-proof line. Best-effort.
  useEffect(() => {
    getSiteStats()
      .then(setStats)
      .catch((e) => console.error('failed to load site stats', e));
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

  // Raise the toolbar's shadow once it sticks (sentinel leaves the scroll viewport).
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const root = sentinel.closest('.content');
    const io = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting), {
      root,
      rootMargin: '0px 0px 0px 0px',
    });
    io.observe(sentinel);
    return () => io.disconnect();
  }, [loading]);

  // Subject chips to offer: only the disciplines actually present in the loaded experiments, in the
  // fixed badge order — so an empty "Biology" filter never shows when nothing is tagged Biology.
  const availableSubjects = useMemo(() => {
    const present = new Set(
      showcases.map((s) => s.subject).filter((s): s is ExperimentSubjects => !!s && !!SUBJECT_META[s]),
    );
    return SUBJECT_ORDER.filter((s) => present.has(s));
  }, [showcases]);

  // Apply the subject filter + search term, then sort the survivors by the chosen order. Sorting is
  // client-side over the already-loaded list (the homepage fetches every featured experiment at once).
  const visible = useMemo(() => {
    const q = term.trim().toLowerCase();
    const matches = showcases.filter((s) => {
      if (subject !== 'all' && s.subject !== subject) return false;
      if (!q) return true;
      return [s.displayName, s.author, s.description, s.subject].some((f) => (f ?? '').toLowerCase().includes(q));
    });
    return matches.sort(compareExperiments(sort));
  }, [showcases, term, subject, sort]);

  // Curated hero + rows are an in-memory slice of the pool (zero extra queries).
  const layout = useMemo(() => buildHomeLayout(showcases), [showcases]);

  // "Continue watching" — the signed-in viewer's recent history (a separate source from the featured
  // pool, so it isn't deduped against the curated rows). Snapshots with a blank thumbnail never
  // resolve, so drop them up front.
  const history = useViewHistory(user, 12);
  const continueItems = useMemo(() => history.items.filter((i) => i.thumbnailURL), [history.items]);

  // Pool + filter state. Subject filter and search are Showcase-only in v1, so an active search
  // forces Showcase to be the effective pool (its results come from the showcase list).
  const searchActive = !!term.trim();
  const subjectActive = subject !== 'all';
  const filtering = subjectActive || searchActive;
  const effectivePool: HomePool = searchActive ? 'showcase' : pool;
  const isCommunity = effectivePool === 'community';

  // Community pool (lazy: only fetches once its tab is the effective pool).
  const community = useCommunityExperiments(isCommunity);

  // Curated shelves (hero + rows + Continue watching) belong to the Showcase browse experience: shown
  // only on Showcase, and not while a filter/search has narrowed things to a result grid.
  const showCurated = effectivePool === 'showcase' && !filtering && layout.hero.length > 0;
  const showContinue = effectivePool === 'showcase' && !filtering && !!user && continueItems.length >= 4;

  const selectPool = (p: HomePool) => {
    // Community isn't searchable / subject-filterable in v1, so clear both when entering it.
    if (p === 'community') {
      setSubject('all');
      setHomeSearchTerm('');
    }
    setPool(p);
  };

  const renderCard = (showcase: ShowcaseCard) => {
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
        onOpen={openExperiment}
        onAuthorClick={authorHref ? () => navigate(authorHref) : undefined}
      />
    );
  };

  // "See all" on a curated row jumps to the full grid: subject rows set the subject filter (which
  // collapses the shelves to that discipline); Trending / Top rated set the matching sort and scroll
  // down without collapsing.
  const seeAll = (row: { subject?: ExperimentSubjects; key: string }) => {
    if (row.subject) {
      setSubject(row.subject);
    } else if (row.key === 'trending') {
      setSort('views');
    } else if (row.key === 'toprated') {
      setSort('rating');
    }
    document.getElementById('all-experiments')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const renderShowcaseGrid = () =>
    visible.length === 0 ? (
      <EmptyState
        title="No heat signatures found"
        hint={
          filtering
            ? 'Try clearing the subject filter or search to see all experiments.'
            : 'No experiments are featured on the homepage yet.'
        }
        action={
          filtering
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
      <CardListWrapper>{visible.map(renderCard)}</CardListWrapper>
    );

  const renderCommunity = () => {
    if (community.loading && community.items.length === 0) {
      return (
        <div className="home-pool-loading">
          <Spin size="large" />
        </div>
      );
    }
    if (community.error && community.items.length === 0) {
      return (
        <EmptyState
          title="Couldn't load community experiments"
          hint="Something went wrong reaching the community gallery. Try again."
          action={{ label: 'Retry', onClick: community.retry }}
        />
      );
    }
    if (community.items.length === 0) {
      return (
        <EmptyState
          title="No community experiments yet"
          hint="Set one of your experiments to Public and it'll be the first to show up here."
          action={user ? { label: 'Go to My Experiments', onClick: () => navigate('/myExperimentsList') } : undefined}
        />
      );
    }
    return (
      <>
        <CardListWrapper>{community.items.map(renderCard)}</CardListWrapper>
        {community.hasMore && (
          <div className="home-loadmore-wrap">
            <button
              type="button"
              className="home-loadmore"
              onClick={community.loadMore}
              disabled={community.loadingMore}
            >
              {community.loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </>
    );
  };

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
      {showCurated && (
        <>
          <HeroBoard
            items={layout.hero}
            onOpen={openExperiment}
            valueProp={user ? undefined : 'Explore real infrared experiments from classrooms worldwide.'}
          />
          {stats && (
            <p className="home-social-proof">
              Explore <span className="mono">{stats.experiments.toLocaleString()}</span> real infrared experiments from{' '}
              <span className="mono">{stats.users.toLocaleString()}</span> explorers.
            </p>
          )}
        </>
      )}

      {/* Continue watching — signed-in only, part of the Showcase browse experience. "See all" goes
          to the History page. */}
      {showContinue && (
        <HomeRow
          title="Continue watching"
          icon={<Clock size={19} strokeWidth={1.75} color="var(--ifi-teal-dark)" aria-hidden />}
          onSeeAll={() => navigate('/recent')}
        >
          {continueItems.map((item) => {
            const authorHref = authorProfilePath(item.ownerId, item.author);
            return (
              <Card
                key={item.id}
                id={item.id}
                url={item.thumbnailURL}
                displayName={item.displayName}
                subject={item.subject}
                author={item.author}
                description={item.description}
                createdAt={item.createdAt}
                duration={item.duration}
                onOpen={openExperiment}
                onAuthorClick={authorHref ? () => navigate(authorHref) : undefined}
              />
            );
          })}
        </HomeRow>
      )}

      {showCurated && (
        <>
          {layout.rows.map((row) => {
            const meta = row.subject ? SUBJECT_META[row.subject] : undefined;
            const RowIcon = meta?.Icon;
            return (
              <HomeRow
                key={row.key}
                title={row.title}
                icon={RowIcon ? <RowIcon size={19} strokeWidth={1.75} color={meta!.color} aria-hidden /> : undefined}
                onSeeAll={() => seeAll(row)}
              >
                {row.items.map(renderCard)}
              </HomeRow>
            );
          })}
        </>
      )}

      <section id="all-experiments" className="home-all">
        {/* Showcase (staff-curated) | Community (all public) — replaces the old, misleading
            "All experiments" heading. */}
        <PoolTabs pool={effectivePool} onChange={selectPool} />

        {/* Toolbar: sort + subject chips + result count. Community locks the sort to Newest (it's a
            server-side orderBy) and hides the subject chips (client-side faceting over paginated data
            would read as broken/partial results). */}
        <div className="home-toolbar-sentinel" ref={sentinelRef} />
        <div className={`home-bar${stuck ? ' is-stuck' : ''}`}>
          {isCommunity ? (
            <button type="button" className="sort-button is-locked" disabled title="Community is sorted by newest">
              <SortAscendingOutlined />
              Newest
              <Lock size={12} strokeWidth={2} aria-hidden />
            </button>
          ) : (
            <SortMenu value={sort} onChange={setSort} options={HOME_SORT_OPTIONS} />
          )}
          {!isCommunity && availableSubjects.length > 0 && (
            <SubjectFilter value={subject} subjects={availableSubjects} onChange={setSubject} />
          )}
          <span className="home-result-count mono">
            {isCommunity
              ? `${community.items.length}${community.hasMore ? '+' : ''} loaded`
              : `${visible.length} experiments`}
          </span>
        </div>

        {isCommunity ? renderCommunity() : renderShowcaseGrid()}
      </section>

      <Footer />

      <BackToTop />
    </div>
  );
};

export default HomePage;
