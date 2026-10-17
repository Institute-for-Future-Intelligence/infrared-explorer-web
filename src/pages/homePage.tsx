import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal, Spin, message } from 'antd';
import { Globe, Pencil } from 'lucide-react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import Card from '../components/card/card';
import CardListWrapper from '../components/card/cardListWrapper';
import { SUBJECT_META } from '../components/card/subjectMeta';
import type { CardCuration } from '../components/home/curationControls';
import HeroBoard from '../components/home/heroBoard';
import HeroTray from '../components/home/heroTray';
import HomeRow from '../components/home/homeRow';
import TakedownModal from '../components/home/takedownModal';
import SubjectFilter, { SubjectFilterValue } from '../components/subjectFilter';
import SortMenu, { SORT_OPTIONS, SortValue, compareExperiments } from '../components/sortMenu';
import BackToTop from '../components/backToTop';
import EmptyState from '../components/emptyState';
import { usePersistentState } from '../hooks/usePersistentState';
import { useCommunityExperiments } from '../hooks/useCommunityExperiments';
import { useHeroConfig } from '../hooks/useHeroConfig';
import useCommonStore from '../stores/common';
import { getSiteStats, SiteStats } from '../services/stats';
import { publishCuration } from '../services/curation';
import type { HeroFocus } from '../services/homeConfig';
import { buildHomeLayout, ShowcaseCard } from '../utils/homeLayout';
import { ExperimentSubjects } from '../types';
import { isStaff } from '../utils/staff';
import { authorProfilePath } from '../utils/helpers';
import { PRIVACY_URL, TERMS_URL } from '../utils/urls';
import { useCommunityProjects } from '../labProjects/useCommunityProjects';
import CommunityProjectCard from '../labProjects/components/CommunityProjectCard';
import type { CommunityProject } from '../labProjects/core/types';

/** One card of the "From the community" row: a public experiment or a public AI project, with the
 *  time the merge sorts on (newest first). */
type CommunityPreviewItem =
  | { kind: 'experiment'; at: number; card: ShowcaseCard }
  | { kind: 'project'; at: number; project: CommunityProject };

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

// Order experiments newest-created first by default (see the `home.sort` default below);
// "Recently updated" stays available as the other time order. The homepage is all-public, so
// "By visibility" would be a no-op — drop only that.
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
  const [sort, setSort] = usePersistentState<SortValue>('home.sort', 'newest');

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

  // Staff Manage mode: an in-page WYSIWYG DRAFT session. Not persisted (curation is a task, not a
  // preference). Feature/pin/reorder AND takedown edits all go to a local draft (draftFeatured maps
  // id→featured for touched cards; draftHeroIds is the working hero order; draftTakedown maps id→reason
  // for staged removals) and only hit Firestore on Save & publish, as one atomic batch — so nothing is
  // half-applied and Cancel discards everything. The published hero order is read-only here.
  const staff = isStaff(user);
  const { heroIds, heroFocus } = useHeroConfig();
  const [curating, setCurating] = useState(false);
  const [draftFeatured, setDraftFeatured] = useState<Record<string, boolean>>({});
  const [draftHeroIds, setDraftHeroIds] = useState<string[]>([]);
  // Working copy of the hero thumbnails' framing (expId → object-position %), edited by dragging a
  // tile's image in Reposition mode.
  const [draftHeroFocus, setDraftHeroFocus] = useState<Record<string, HeroFocus>>({});
  const [draftTakedown, setDraftTakedown] = useState<Map<string, string>>(() => new Map());
  const [publishing, setPublishing] = useState(false);
  // Card whose takedown-reason modal is open (its confirm stages the takedown into the draft).
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

  // Filter state (Showcase only — the Community feed lives on its own page now).
  const searchActive = !!term.trim();
  const subjectActive = subject !== 'all';
  const filtering = subjectActive || searchActive;

  // A small "From the community" preview row is the head of both Community feeds — the public
  // experiments and the public AI projects, merged newest first (an experiment by createdAt, a project
  // by when it went public) and cut to 12; "See all" opens /community, where they're the two tabs.
  // Featured experiments stay in (a card may therefore also appear in the hero / shelves / collection
  // grid on this page — that's the Showcase overlapping the open feed, by design). Only fetched while
  // browsing (not while filtering the showcase).
  const community = useCommunityExperiments(!filtering);
  const communityProjects = useCommunityProjects(!filtering);
  // The projects come from a callable (a cold start can be slow); the row waits for its first page to
  // settle — loaded, empty or failed — so project cards don't shuffle into a row already on screen.
  // A failed load just leaves the row to the experiments.
  const projectsSettled =
    !communityProjects.loading &&
    (communityProjects.items.length > 0 || communityProjects.error || !communityProjects.hasMore);
  const communityPreview = useMemo<CommunityPreviewItem[]>(() => {
    const merged: CommunityPreviewItem[] = [
      ...community.items.map((card) => ({
        kind: 'experiment' as const,
        at: card.createdAt ? card.createdAt.toMillis() : 0,
        card,
      })),
      ...communityProjects.items.map((project) => ({ kind: 'project' as const, at: project.publicAt, project })),
    ];
    return merged.sort((a, b) => b.at - a.at).slice(0, 12);
  }, [community.items, communityProjects.items]);

  // When a subject filter re-lays out the page (curated shelves appear/disappear), keep the showcase
  // section in view rather than snapping to the top. useLayoutEffect runs before paint, so the
  // re-anchoring is invisible — no flash of the hero. Gated by a ref so it only fires for those
  // deliberate toggles, not for every subject change (e.g. restoring persisted state on mount).
  useLayoutEffect(() => {
    if (!restoreShowcaseRef.current) return;
    restoreShowcaseRef.current = false;
    document.getElementById('all-experiments')?.scrollIntoView({ block: 'start' });
  }, [subject]);

  // ── Curate draft: while curating, everything the page renders comes from the draft, so the curator
  // previews exactly what publishing will show visitors. Homepage Curate is Showcase-only now — it
  // reorders the hero and removes showcase cards; ADDING a community experiment happens on the
  // Community page (immediate), so the draft never gains cards, only drops them. ──
  const effectiveHeroIds = curating ? draftHeroIds : heroIds;
  const effectiveHeroFocus = curating ? draftHeroFocus : heroFocus;
  const isFeatured = useCallback(
    (c: ShowcaseCard) => (curating ? (draftFeatured[c.id] ?? !!c.featured) : !!c.featured),
    [curating, draftFeatured],
  );

  // The showcase pool as the draft has it: the loaded featured pool minus any the draft un-featured.
  const effectiveShowcases = useMemo(() => {
    if (!curating) return showcases;
    const removed = new Set(
      Object.entries(draftFeatured)
        .filter(([, feat]) => !feat)
        .map(([id]) => id),
    );
    return showcases.filter((s) => !removed.has(s.id));
  }, [curating, showcases, draftFeatured]);

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

  // Curated hero + rows: in-memory slices; hero order honours the (draft or published) pins. A card
  // staged for takedown is dropped from this preview so it can't headline the hero as it's being
  // removed — it stays in the flat grid below (marked "Will remove") so the removal is still undoable.
  const layoutSource = useMemo(
    () => (draftTakedown.size ? effectiveShowcases.filter((s) => !draftTakedown.has(s.id)) : effectiveShowcases),
    [effectiveShowcases, draftTakedown],
  );
  const layout = useMemo(() => buildHomeLayout(layoutSource, effectiveHeroIds), [layoutSource, effectiveHeroIds]);

  const showcaseIdSet = useMemo(() => new Set(effectiveShowcases.map((s) => s.id)), [effectiveShowcases]);
  const pinnedCards = useMemo(() => {
    const byId = new Map(effectiveShowcases.map((s) => [s.id, s]));
    return effectiveHeroIds.map((id) => byId.get(id)).filter((c): c is ShowcaseCard => !!c);
  }, [effectiveShowcases, effectiveHeroIds]);

  // Unpublished changes: featured flips + staged takedowns that differ from the live value, plus a
  // hero-order change and one per re-framed thumbnail.
  const heroChanged = draftHeroIds.length !== heroIds.length || draftHeroIds.some((id, i) => id !== heroIds[i]);
  const focusChangedCount = curating
    ? new Set([...Object.keys(heroFocus), ...Object.keys(draftHeroFocus)]).size -
      Object.keys(heroFocus).filter(
        (id) => draftHeroFocus[id]?.x === heroFocus[id].x && draftHeroFocus[id]?.y === heroFocus[id].y,
      ).length
    : 0;
  const pendingCount =
    Object.keys(draftFeatured).length + draftTakedown.size + (curating && heroChanged ? 1 : 0) + focusChangedCount;

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
  // Centred (50/50) is the default, so it's stored as "no entry" rather than an explicit point.
  const setHeroFocus = (id: string, focus: HeroFocus | null) =>
    setDraftHeroFocus((m) => {
      const copy = { ...m };
      if (!focus || (focus.x === 50 && focus.y === 50)) delete copy[id];
      else copy[id] = focus;
      return copy;
    });

  // ── Staged takedown (part of the draft — applied on publish, discarded on Cancel) ──
  const stageTakedown = (reason: string) => {
    const card = takedownTarget;
    setTakedownTarget(null);
    if (!card) return;
    setDraftTakedown((m) => new Map(m).set(card.id, reason));
    // A card being removed can't stay pinned or carry a pending feature flip.
    setDraftHeroIds((ids) => ids.filter((x) => x !== card.id));
    setDraftFeatured((m) => {
      if (!(card.id in m)) return m;
      const copy = { ...m };
      delete copy[card.id];
      return copy;
    });
  };
  const unstageTakedown = (id: string) =>
    setDraftTakedown((m) => {
      const n = new Map(m);
      n.delete(id);
      return n;
    });

  // ── Draft lifecycle ──
  const enterCurate = () => {
    setDraftHeroIds(heroIds);
    setDraftHeroFocus(heroFocus);
    setDraftFeatured({});
    setDraftTakedown(new Map());
    setCurating(true);
  };
  const exitCurate = () => {
    setCurating(false);
    setDraftFeatured({});
    setDraftHeroIds([]);
    setDraftHeroFocus({});
    setDraftTakedown(new Map());
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
    const takedowns = [...draftTakedown.entries()].map(([id, reason]) => ({ id, reason }));
    if (featuredChanges.length === 0 && takedowns.length === 0 && !heroChanged && focusChangedCount === 0) {
      exitCurate();
      return;
    }
    if (!user) return;
    setPublishing(true);
    try {
      await publishCuration(featuredChanges, draftHeroIds, takedowns, user, draftHeroFocus);
      // Commit the draft's pool locally so the published view is right without a refetch (heroIds
      // reconciles via its snapshot): drop the taken-down cards from every view, then keep the draft's
      // featured removals.
      const gone = new Set(draftTakedown.keys());
      setShowcases(effectiveShowcases.filter((s) => !gone.has(s.id)));
      gone.forEach((id) => community.removeItem(id));
      // A card stays in the Community feed whether or not it's featured; flip its flag there so its
      // "From the community" card renders the new state without a refetch.
      featuredChanges.forEach(({ id, featured }) => community.setFeatured(id, featured));
      message.success('Homepage published.');
      exitCurate();
    } catch (e) {
      console.error('failed to publish curation', e);
      const code = (e as { code?: string })?.code;
      const stale = code === 'permission-denied' || code === 'not-found';
      message.error(
        stale
          ? 'Some recordings changed since they loaded. Exit Manage and reopen to refresh, then try again.'
          : 'Could not publish. Your draft is kept — try again.',
      );
    } finally {
      setPublishing(false);
    }
  };

  // The whole top region (hero + curated rows) is cut from the featured pool and
  // collapses only while filtering (an active subject/search narrows the page to a flat result grid).
  const showCurated = !filtering && layout.hero.length > 0;
  // A preview of the Community feed on the front page (the split's other half: give it a window here,
  // the full feed on /community). Hidden while filtering or curating the showcase.
  const showCommunityPreview = !curating && !filtering && projectsSettled && communityPreview.length >= 4;

  // Toolbar subject chips: flag the change so the layout effect re-anchors to the showcase section
  // once the curated shelves re-render (clearing to "All" brings them back and would otherwise
  // shove the grid down out of view).
  const filterBySubject = (next: SubjectFilterValue) => {
    restoreShowcaseRef.current = true;
    setSubject(next);
  };

  const buildCuration = (card: ShowcaseCard): CardCuration | undefined => {
    if (!curating || !staff) return undefined;
    const featured = isFeatured(card);
    const rank = effectiveHeroIds.indexOf(card.id);
    return {
      featured,
      heroRank: rank >= 0 ? rank + 1 : undefined,
      canPin: featured && showcaseIdSet.has(card.id),
      pendingTakedown: draftTakedown.has(card.id),
      onToggleFeatured: (nextFeatured) => toggleFeatured(card, nextFeatured),
      onTogglePin: () => togglePin(card.id),
      onTakedown: () => setTakedownTarget(card),
      onUndoTakedown: () => unstageTakedown(card.id),
    };
  };

  const renderCard = (card: ShowcaseCard, curatable = false) => {
    const authorHref = authorProfilePath(card.ownerId, card.author);
    return (
      <Card
        key={card.id}
        id={card.id}
        url={card.thumbnailURL}
        displayName={card.displayName}
        subject={card.subject}
        author={card.author}
        description={card.description}
        ratingSum={card.ratingSum}
        ratingCount={card.ratingCount}
        viewCount={card.viewCount}
        commentCount={card.commentCount}
        createdAt={card.createdAt}
        duration={card.duration}
        sourceType={card.sourceType}
        photoCount={card.photoCount}
        timelapse={card.timelapse}
        onOpen={openExperiment}
        onAuthorClick={authorHref ? () => navigate(authorHref) : undefined}
        curation={curatable ? buildCuration(card) : undefined}
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
            ? 'Try clearing the subject filter or search to see all recordings.'
            : 'No recordings are featured on the homepage yet.'
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
      <CardListWrapper>{visible.map((c) => renderCard(c, true))}</CardListWrapper>
    );

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
          title="Couldn't load recordings"
          hint="Something went wrong reaching the gallery. Check your connection and try again."
          action={{ label: 'Retry', onClick: () => void fetchHomepage() }}
        />
      </div>
    );
  }

  return (
    <div className={`home-page${curating ? ' is-curating' : ''}`}>
      {/* Staff-only Manage mode. A DRAFT session: feature / un-feature the showcase, reorder the hero,
          and stage takedowns, previewing live, then Save & publish (one atomic batch) or Cancel — all
          changes go through publish. Only staff see it (rules enforce the writes server-side regardless). */}
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
              Manage
            </button>
          )}
        </div>
      )}

      {showCurated && (
        <>
          <HeroBoard
            items={layout.hero}
            onOpen={openExperiment}
            valueProp={user ? undefined : 'Explore real infrared recordings from classrooms worldwide.'}
            curating={curating}
            heroIds={effectiveHeroIds}
            focus={effectiveHeroFocus}
            onReorder={reorderHero}
            onUnpin={unpinHero}
            onFocusChange={setHeroFocus}
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
              Explore <span className="mono">{stats.experiments.toLocaleString()}</span> real infrared recordings from{' '}
              <span className="mono">{stats.users.toLocaleString()}</span> explorers.
            </p>
          )}
        </>
      )}

      {/* From the community — a window onto the open feeds, experiments and AI projects mixed (full
          lists on /community). The first row under the hero, ahead of the curated shelves; "See all"
          navigates to the Community page. */}
      {showCommunityPreview && (
        <HomeRow
          title="From the community"
          icon={<Globe size={19} strokeWidth={1.75} color="var(--ifi-teal-dark)" aria-hidden />}
          onSeeAll={() => navigate('/community')}
        >
          {communityPreview.map((item) =>
            item.kind === 'experiment' ? (
              renderCard(item.card)
            ) : (
              <CommunityProjectCard key={`project-${item.project.id}`} project={item.project} />
            ),
          )}
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
                {row.items.map((c) => renderCard(c, true))}
              </HomeRow>
            );
          })}
        </>
      )}

      <section id="all-experiments" className={`home-all${filtering ? ' home-all--flush' : ''}`}>
        <div className="home-section-head home-all-head">
          <h2 className="home-section-title">{filtering ? 'Results' : 'Explore the collection'}</h2>
        </div>

        {/* Toolbar: sort + subject chips + result count. */}
        <div className="home-toolbar-sentinel" ref={sentinelRef} />
        <div className={`home-bar${stuck ? ' is-stuck' : ''}`}>
          <SortMenu value={sort} onChange={setSort} options={HOME_SORT_OPTIONS} />
          {availableSubjects.length > 0 && (
            <SubjectFilter value={subject} subjects={availableSubjects} onChange={filterBySubject} />
          )}
          <span className="home-result-count mono">{visible.length} recordings</span>
        </div>

        {renderShowcaseGrid()}
      </section>

      {/* Legal links: the homepage is the first page a visitor lands on, signed in or not (see
          .home-footer for why they live here). */}
      <footer className="home-footer">
        <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">
          Terms of Service
        </a>
        <span className="home-footer-sep" aria-hidden="true">
          ·
        </span>
        <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
          Privacy Policy
        </a>
      </footer>

      <BackToTop />

      {/* Immediate staff takedown — a reason picker, confirmed. Governance, so it applies at once (not
          part of the draft). */}
      {/* Take down reason picker — its confirm STAGES the takedown into the draft (applied on publish). */}
      <TakedownModal target={takedownTarget} onCancel={() => setTakedownTarget(null)} onConfirm={stageTakedown} />
    </div>
  );
};

export default HomePage;
