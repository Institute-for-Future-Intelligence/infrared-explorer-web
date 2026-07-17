import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal, Spin, message } from 'antd';
import { SortAscendingOutlined } from '@ant-design/icons';
import { Clock, Lock, Pencil } from 'lucide-react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import Card from '../components/card/card';
import CardListWrapper from '../components/card/cardListWrapper';
import { SUBJECT_META } from '../components/card/subjectMeta';
import type { CardCuration } from '../components/home/curationControls';
import HeroBoard from '../components/home/heroBoard';
import HeroTray from '../components/home/heroTray';
import HomeRow from '../components/home/homeRow';
import PoolTabs, { HomePool } from '../components/home/poolTabs';
import TakedownModal from '../components/home/takedownModal';
import SubjectFilter, { SubjectFilterValue } from '../components/subjectFilter';
import SortMenu, { SORT_OPTIONS, SortValue, compareExperiments } from '../components/sortMenu';
import Footer from '../components/footer';
import BackToTop from '../components/backToTop';
import EmptyState from '../components/emptyState';
import { usePersistentState } from '../hooks/usePersistentState';
import { useViewHistory } from '../hooks/useExperimentLists';
import { useCommunityExperiments } from '../hooks/useCommunityExperiments';
import { useHeroConfig } from '../hooks/useHeroConfig';
import useCommonStore from '../stores/common';
import { getSiteStats, SiteStats } from '../services/stats';
import { publishCuration, takedownExperiment } from '../services/curation';
import { buildHomeLayout, ShowcaseCard } from '../utils/homeLayout';
import { ExperimentSubjects } from '../types';
import { isStaff } from '../utils/staff';
import { authorProfilePath } from '../utils/helpers';

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

// Order experiments by their last-edit time by default (see the `home.sort` default below) so a
// freshly-revised experiment floats back up; "Recently created" stays available as the other time
// order. The homepage is all-public, so "By visibility" would be a no-op — drop only that.
const HOME_SORT_OPTIONS = SORT_OPTIONS.filter((o) => o.key !== 'visibility');

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
  const [sort, setSort] = usePersistentState<SortValue>('home.sort', 'updated');
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
  // Toggling the subject filter shows/hides the curated shelves above the grid, shifting the whole
  // page. This flags a toolbar-driven filter change so we can re-anchor the view to the showcase
  // section afterwards (see the layout effect below) instead of letting it snap to the hero at top.
  const restoreShowcaseRef = useRef(false);

  // Staff Curate mode: an in-page WYSIWYG DRAFT session. Not persisted (curation is a task, not a
  // preference). Feature/pin/reorder edits go to a local draft (draftFeatured maps id→featured for
  // touched cards; draftHeroIds is the working hero order) and only hit Firestore on Save & publish,
  // as one atomic batch — so visitors never see a half-applied homepage. Takedown is separate
  // (immediate, below). The published hero order is read-only here.
  const staff = isStaff(user);
  const heroIds = useHeroConfig();
  const [curating, setCurating] = useState(false);
  const [draftFeatured, setDraftFeatured] = useState<Record<string, boolean>>({});
  const [draftHeroIds, setDraftHeroIds] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  // Takedown reason modal target (governance, not part of the draft).
  const [takedownTarget, setTakedownTarget] = useState<ShowcaseCard | null>(null);

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

  // When a toolbar filter or pool switch re-lays out the page (curated shelves appear/disappear), keep
  // the showcase section in view rather than snapping to the top. useLayoutEffect runs before paint,
  // so the re-anchoring is invisible — no flash of the hero. Gated by a ref so it only fires for those
  // deliberate toggles, not for every subject/pool change (e.g. restoring persisted state on mount).
  useLayoutEffect(() => {
    if (!restoreShowcaseRef.current) return;
    restoreShowcaseRef.current = false;
    document.getElementById('all-experiments')?.scrollIntoView({ block: 'start' });
  }, [subject, effectivePool]);

  // ── Curate draft: while curating, everything the page renders comes from the draft, so the curator
  // previews exactly what publishing will show visitors. ──
  // Any card the draft might reference (showcase or community), for resolving ids.
  const cardIndex = useMemo(() => {
    const m = new Map<string, ShowcaseCard>();
    showcases.forEach((s) => m.set(s.id, s));
    community.items.forEach((c) => m.set(c.id, c));
    return m;
  }, [showcases, community.items]);

  const effectiveHeroIds = curating ? draftHeroIds : heroIds;
  const isFeatured = useCallback(
    (c: ShowcaseCard) => (curating ? (draftFeatured[c.id] ?? !!c.featured) : !!c.featured),
    [curating, draftFeatured],
  );

  // The showcase pool as the draft has it: start from the loaded featured pool, drop draft-unfeatured
  // cards, add draft-featured community cards. Everything downstream re-sorts, so order here is moot.
  const effectiveShowcases = useMemo(() => {
    if (!curating) return showcases;
    const map = new Map(showcases.map((s) => [s.id, s]));
    for (const [id, feat] of Object.entries(draftFeatured)) {
      if (feat) {
        if (!map.has(id)) {
          const c = cardIndex.get(id);
          if (c) map.set(id, { ...c, featured: true });
        }
      } else {
        map.delete(id);
      }
    }
    return [...map.values()];
  }, [curating, showcases, draftFeatured, cardIndex]);

  // Subject chips to offer: only the disciplines actually present, in the fixed badge order.
  const availableSubjects = useMemo(() => {
    const present = new Set(
      effectiveShowcases.map((s) => s.subject).filter((s): s is ExperimentSubjects => !!s && !!SUBJECT_META[s]),
    );
    return SUBJECT_ORDER.filter((s) => present.has(s));
  }, [effectiveShowcases]);

  // Apply the subject filter + search term, then sort. Client-side over the loaded list.
  const visible = useMemo(() => {
    const q = term.trim().toLowerCase();
    const matches = effectiveShowcases.filter((s) => {
      if (subject !== 'all' && s.subject !== subject) return false;
      if (!q) return true;
      return [s.displayName, s.author, s.description, s.subject].some((f) => (f ?? '').toLowerCase().includes(q));
    });
    return matches.sort(compareExperiments(sort));
  }, [effectiveShowcases, term, subject, sort]);

  // Curated hero + rows: in-memory slices; hero order honours the (draft or published) pins.
  const layout = useMemo(
    () => buildHomeLayout(effectiveShowcases, effectiveHeroIds),
    [effectiveShowcases, effectiveHeroIds],
  );

  const showcaseIdSet = useMemo(() => new Set(effectiveShowcases.map((s) => s.id)), [effectiveShowcases]);
  const pinnedCards = useMemo(() => {
    const byId = new Map(effectiveShowcases.map((s) => [s.id, s]));
    return effectiveHeroIds.map((id) => byId.get(id)).filter((c): c is ShowcaseCard => !!c);
  }, [effectiveShowcases, effectiveHeroIds]);

  // Unpublished changes: featured flips that differ from the live value, plus a hero-order change.
  const heroChanged = draftHeroIds.length !== heroIds.length || draftHeroIds.some((id, i) => id !== heroIds[i]);
  const pendingCount = Object.keys(draftFeatured).length + (curating && heroChanged ? 1 : 0);

  // ── Draft edit ops (local only — no writes until publish) ──
  const toggleFeatured = (card: ShowcaseCard, next: boolean) => {
    setDraftFeatured((m) => {
      const copy = { ...m };
      if (next === !!card.featured) delete copy[card.id];
      else copy[card.id] = next;
      return copy;
    });
    if (!next) setDraftHeroIds((ids) => ids.filter((x) => x !== card.id));
  };
  const togglePin = (id: string) => {
    if (draftHeroIds.includes(id)) setDraftHeroIds(draftHeroIds.filter((x) => x !== id));
    else if (draftHeroIds.length >= 5) message.info('The hero holds 5 — remove one first.');
    else setDraftHeroIds([...draftHeroIds, id]);
  };
  const unpinHero = (id: string) => setDraftHeroIds(draftHeroIds.filter((x) => x !== id));
  const moveHero = (id: string, dir: -1 | 1) => {
    const i = draftHeroIds.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= draftHeroIds.length) return;
    const next = [...draftHeroIds];
    [next[i], next[j]] = [next[j], next[i]];
    setDraftHeroIds(next);
  };
  // Dragging reorders the visible hero slots and pins the whole set ("what you arrange is what
  // everyone sees").
  const reorderHero = (ids: string[]) => setDraftHeroIds(ids);

  // ── Immediate staff takedown (governance — not part of the draft, can't be undone by Cancel) ──
  const confirmTakedown = async (reason: string) => {
    const card = takedownTarget;
    setTakedownTarget(null);
    if (!card || !user) return;
    setShowcases((prev) => prev.filter((s) => s.id !== card.id)); // drop from every view at once
    community.removeItem(card.id);
    setDraftHeroIds((ids) => ids.filter((x) => x !== card.id));
    setDraftFeatured((m) => {
      const copy = { ...m };
      delete copy[card.id];
      return copy;
    });
    try {
      await takedownExperiment(card.id, reason, user);
      message.success('Taken down — removed from the site.');
    } catch (e) {
      console.error('failed to take down', e);
      message.error('Could not take it down. Reload and try again.');
    }
  };

  // ── Draft lifecycle ──
  const enterCurate = () => {
    setDraftHeroIds(heroIds);
    setDraftFeatured({});
    setCurating(true);
  };
  const exitCurate = () => {
    setCurating(false);
    setDraftFeatured({});
    setDraftHeroIds([]);
  };
  const cancelCurate = () => {
    if (pendingCount === 0) {
      exitCurate();
      return;
    }
    Modal.confirm({
      title: 'Discard changes?',
      content: `${pendingCount} unpublished change${pendingCount === 1 ? '' : 's'} will be lost.`,
      okText: 'Discard',
      okButtonProps: { danger: true },
      onOk: exitCurate,
    });
  };
  const publishDraft = async () => {
    const featuredChanges = Object.entries(draftFeatured).map(([id, featured]) => ({ id, featured }));
    if (featuredChanges.length === 0 && !heroChanged) {
      exitCurate();
      return;
    }
    setPublishing(true);
    try {
      await publishCuration(featuredChanges, draftHeroIds);
      // Commit the draft's pool locally so the published view is right without a refetch (heroIds
      // reconciles via its snapshot).
      setShowcases(effectiveShowcases);
      message.success('Homepage published.');
      exitCurate();
    } catch (e) {
      console.error('failed to publish curation', e);
      message.error('Could not publish. Your draft is kept — try again.');
    } finally {
      setPublishing(false);
    }
  };

  // The whole top region (hero + Continue watching + curated rows) is the site's front page and is
  // POOL-INVARIANT: the Showcase / Community tabs swap only the grid below them, leaving everything
  // above the tabs identical. It's cut from the featured pool and collapses only while filtering
  // (an active subject/search narrows the page to a flat result grid).
  const showCurated = !filtering && layout.hero.length > 0;
  const showContinue = !curating && !filtering && !!user && continueItems.length >= 4;

  // Toolbar subject chips: flag the change so the layout effect re-anchors to the showcase section
  // once the curated shelves re-render (clearing to "All" brings them back and would otherwise
  // shove the grid down out of view).
  const filterBySubject = (next: SubjectFilterValue) => {
    restoreShowcaseRef.current = true;
    setSubject(next);
  };

  const selectPool = (p: HomePool) => {
    if (p === 'community') {
      // Community isn't searchable / subject-filterable in v1, so clear both when entering it. If a
      // filter was active the curated shelves were collapsed; clearing it brings them back above the
      // tabs, so re-anchor to the section. Otherwise the top is unchanged (only the grid below swaps)
      // — leave the scroll position alone so there's no jump.
      if (filtering) restoreShowcaseRef.current = true;
      setSubject('all');
      setHomeSearchTerm('');
    }
    setPool(p);
  };

  const buildCuration = (card: ShowcaseCard, poolKind: HomePool): CardCuration | undefined => {
    if (!curating || !staff) return undefined;
    const featured = isFeatured(card);
    const rank = effectiveHeroIds.indexOf(card.id);
    return {
      featured,
      heroRank: rank >= 0 ? rank + 1 : undefined,
      canPin: poolKind === 'showcase' && featured && showcaseIdSet.has(card.id),
      onToggleFeatured: (nextFeatured) => toggleFeatured(card, nextFeatured),
      onTogglePin: () => togglePin(card.id),
      onTakedown: () => setTakedownTarget(card),
    };
  };

  const renderCard = (showcase: ShowcaseCard, poolKind: HomePool) => {
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
        curation={buildCuration(showcase, poolKind)}
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
      <CardListWrapper>{visible.map((c) => renderCard(c, 'showcase'))}</CardListWrapper>
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
        <CardListWrapper>{community.items.map((c) => renderCard(c, 'community'))}</CardListWrapper>
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
    <div className={`home-page${curating ? ' is-curating' : ''}`}>
      {/* Staff-only Curate mode. A DRAFT session: feature / un-feature / take down any experiment and
          reorder the hero, previewing live, then Save & publish (one atomic batch) or Cancel. Only
          staff see it (rules enforce the writes server-side regardless). */}
      {staff && (
        <div className="home-staff-bar">
          {curating ? (
            <>
              <span className="curate-pill">
                {pendingCount > 0
                  ? `Draft — ${pendingCount} pending change${pendingCount === 1 ? '' : 's'}. Visitors still see the live homepage.`
                  : 'Draft — no changes yet.'}
              </span>
              <button type="button" className="curate-cancel" onClick={cancelCurate} disabled={publishing}>
                Cancel
              </button>
              <button
                type="button"
                className="curate-save"
                onClick={publishDraft}
                disabled={publishing || pendingCount === 0}
              >
                {publishing ? 'Publishing…' : 'Save & publish'}
              </button>
            </>
          ) : (
            <button type="button" className="curate-toggle" onClick={enterCurate}>
              <Pencil size={16} strokeWidth={2} aria-hidden />
              Curate
            </button>
          )}
        </div>
      )}

      {showCurated && (
        <>
          <HeroBoard
            items={layout.hero}
            onOpen={openExperiment}
            valueProp={user ? undefined : 'Explore real infrared experiments from classrooms worldwide.'}
            curating={curating}
            heroIds={effectiveHeroIds}
            onReorder={reorderHero}
            onUnpin={unpinHero}
          />
          {curating && (
            <HeroTray
              pinned={pinnedCards}
              autoCount={Math.max(0, layout.hero.length - pinnedCards.length)}
              onMove={moveHero}
              onRemove={unpinHero}
            />
          )}
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
                {row.items.map((c) => renderCard(c, 'showcase'))}
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
            <SubjectFilter value={subject} subjects={availableSubjects} onChange={filterBySubject} />
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

      {/* Immediate staff takedown — a reason picker, confirmed. Governance, so it applies at once (not
          part of the draft). */}
      <TakedownModal target={takedownTarget} onCancel={() => setTakedownTarget(null)} onConfirm={confirmTakedown} />
    </div>
  );
};

export default HomePage;
