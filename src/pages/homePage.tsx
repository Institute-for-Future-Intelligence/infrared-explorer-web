import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal, Spin, message } from 'antd';
import { Globe, Pencil } from 'lucide-react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import Card from '../components/card/card';
import CardListWrapper from '../components/card/cardListWrapper';
import type { CardCuration } from '../components/home/curationControls';
import HeroBoard from '../components/home/heroBoard';
import HeroTray from '../components/home/heroTray';
import HomeRow from '../components/home/homeRow';
import TakedownModal from '../components/home/takedownModal';
import SortMenu, {
  SORT_OPTIONS,
  SortValue,
  compareSortFields,
  sortFieldsOf,
  type SortFields,
} from '../components/sortMenu';
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
import { isStaff } from '../utils/staff';
import { authorProfilePath } from '../utils/helpers';
import { PRIVACY_URL, TERMS_URL } from '../utils/urls';
import { buildRecordingCardMenu, useSaveCopy } from '../components/saveCopy';
import { listFeaturedProjects, setProjectFeatured } from '../labProjects/api';
import { useCommunityProjects } from '../labProjects/useCommunityProjects';
import { useSaveProjectCopy } from '../labProjects/useSaveProjectCopy';
import CommunityProjectCard from '../labProjects/components/CommunityProjectCard';
import { shownTitle } from '../labProjects/core/empty';
import type { CommunityProject } from '../labProjects/core/types';

/** One card of the "From the community" row: a public experiment or a public AI project, with the
 *  time the merge sorts on (newest first). */
type CommunityPreviewItem =
  | { kind: 'experiment'; at: number; card: ShowcaseCard }
  | { kind: 'project'; at: number; project: CommunityProject };

/** One card of the collection grid: a featured recording, or a featured AI project, with what the
 *  sort orders read off it. */
type CollectionItem =
  | { kind: 'experiment'; card: ShowcaseCard; sort: SortFields }
  | { kind: 'project'; project: CommunityProject; sort: SortFields };

/** A project's fields for the sort orders. It has no views, ratings or comments (those orders sink it
 *  below every rated recording; ties keep the incoming order); "created" is when it was made (an older
 *  server sends none: then when it went public, which its byline shows). */
const projectSortFields = (p: CommunityProject): SortFields => ({
  createdMillis: p.createdAt ?? p.publicAt,
  updatedMillis: p.updatedAt || p.publicAt,
  viewCount: 0,
  ratingAvg: 0,
  ratingCount: 0,
  commentCount: 0,
  title: shownTitle(p.title).replace(/<[^>]*>/g, ''),
  visibilityRank: 0,
});

// Order experiments newest-created first by default (see the `home.sort` default below);
// "Recently updated" stays available as the other time order. The homepage is all-public, so
// "By visibility" would be a no-op — drop only that.
const HOME_SORT_OPTIONS = SORT_OPTIONS.filter((o) => o.key !== 'visibility');

const HomePage = () => {
  const navigate = useNavigate();
  const openExperiment = useCallback((id: string) => navigate(`/experiments/${id}`), [navigate]);
  const [showcases, setShowcases] = useState<ShowcaseCard[]>([]);
  // The AI projects staff put in the Showcase (the app server's labProjectCommunityList, featured):
  // they sit in the collection grid beside the recordings, not in the hero.
  const [featuredProjects, setFeaturedProjects] = useState<CommunityProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [stats, setStats] = useState<SiteStats | null>(null);
  // The sort is remembered across visits (localStorage); search is intentionally not (the shared
  // header term is cleared on leave below).
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
  // Projects taken out of the Showcase in the draft (id → false). Published through the app server's
  // labProjectFeature, one call per project, after the batch — not part of it.
  const [draftProjectFeatured, setDraftProjectFeatured] = useState<Record<string, boolean>>({});
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
  // The featured projects load alongside, from the app server; if that call fails the page still
  // renders, with the recordings alone.
  const fetchHomepage = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [snap, projects] = await Promise.all([
        getDocs(
          query(
            collection(firebaseDatabase, 'experiments'),
            where('featured', '==', true),
            where('visibility', '==', 'public'),
            where('trash', '==', false),
          ),
        ),
        listFeaturedProjects().catch((e) => {
          console.error('failed to load the featured experiments', e);
          return [] as CommunityProject[];
        }),
      ]);
      setShowcases(snap.docs.map((d) => ({ ...(d.data() as ShowcaseCard), id: d.id })));
      setFeaturedProjects(projects);
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

  // Publish the collection to the header search's autocomplete (option value = id, label = title; a
  // project names the page it opens).
  useEffect(() => {
    setHomeSearchItems([
      ...showcases.map((s) => ({ id: s.id, label: s.displayName })),
      ...featuredProjects.map((p) => ({
        id: p.id,
        label: shownTitle(p.title),
        path: `/projects/${encodeURIComponent(p.id)}`,
      })),
    ]);
  }, [showcases, featuredProjects, setHomeSearchItems]);

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

  // Filter state (Showcase only — the Community feed lives on its own page now). A search narrows
  // the page to a flat result grid.
  const filtering = !!term.trim();

  // A small "From the community" preview row is the head of both Community feeds — the public
  // experiments and the public AI projects, merged newest first (an experiment by createdAt, a project
  // by when it went public) and cut to 12; "See all" opens /community, where they're the two tabs.
  // Featured experiments stay in (a card may therefore also appear in the hero / collection grid on
  // this page — that's the Showcase overlapping the open feed, by design). Only fetched while
  // browsing (not while filtering the showcase).
  const community = useCommunityExperiments(!filtering);
  const communityProjects = useCommunityProjects(!filtering);
  // The row's cards carry Community's ⋮ menus (Open in new tab · Save as…); their dialogs render once, below.
  const saveCopy = useSaveCopy();
  const saveProjectCopy = useSaveProjectCopy();
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
  // The featured projects likewise, minus the ones the draft took out.
  const effectiveProjects = useMemo(
    () => (curating ? featuredProjects.filter((p) => draftProjectFeatured[p.id] !== false) : featuredProjects),
    [curating, featuredProjects, draftProjectFeatured],
  );

  // The collection: recordings and projects together, through the search term, in the chosen order.
  // Client-side over the loaded lists.
  const visible = useMemo<CollectionItem[]>(() => {
    const q = term.trim().toLowerCase();
    const has = (fields: (string | null | undefined)[]) =>
      !q || fields.some((f) => (f ?? '').toLowerCase().includes(q));
    const items: CollectionItem[] = [
      ...effectiveShowcases
        .filter((s) => has([s.displayName, s.author, s.description, s.subject]))
        .map((card) => ({ kind: 'experiment' as const, card, sort: sortFieldsOf(card) })),
      ...effectiveProjects
        .filter((p) => has([shownTitle(p.title), p.owner.name, p.model]))
        .map((project) => ({ kind: 'project' as const, project, sort: projectSortFields(project) })),
    ];
    const compare = compareSortFields(sort);
    return items.sort((a, b) => compare(a.sort, b.sort));
  }, [effectiveShowcases, effectiveProjects, term, sort]);
  const visibleProjectCount = useMemo(() => visible.filter((i) => i.kind === 'project').length, [visible]);
  const visibleRecordingCount = visible.length - visibleProjectCount;

  // Curated hero: an in-memory slice; hero order honours the (draft or published) pins. A card
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
  // hero-order change and one per re-framed thumbnail, plus the projects taken out.
  const heroChanged = draftHeroIds.length !== heroIds.length || draftHeroIds.some((id, i) => id !== heroIds[i]);
  const focusChangedCount = curating
    ? new Set([...Object.keys(heroFocus), ...Object.keys(draftHeroFocus)]).size -
      Object.keys(heroFocus).filter(
        (id) => draftHeroFocus[id]?.x === heroFocus[id].x && draftHeroFocus[id]?.y === heroFocus[id].y,
      ).length
    : 0;
  const pendingCount =
    Object.keys(draftFeatured).length +
    draftTakedown.size +
    (curating && heroChanged ? 1 : 0) +
    focusChangedCount +
    Object.keys(draftProjectFeatured).length;

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
  // A project here is in the Showcase (the list is the featured ones), so a flip is only ever "out";
  // back to its live value drops the entry.
  const toggleProjectFeatured = (project: CommunityProject, next: boolean) => {
    setDraftProjectFeatured((m) => {
      const copy = { ...m };
      if (next === (project.featured ?? true)) delete copy[project.id];
      else copy[project.id] = next;
      return copy;
    });
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
    setDraftProjectFeatured({});
    setCurating(true);
  };
  const exitCurate = () => {
    setCurating(false);
    setDraftFeatured({});
    setDraftHeroIds([]);
    setDraftHeroFocus({});
    setDraftTakedown(new Map());
    setDraftProjectFeatured({});
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
    const projectFlips = Object.entries(draftProjectFeatured);
    const batchEmpty =
      featuredChanges.length === 0 && takedowns.length === 0 && !heroChanged && focusChangedCount === 0;
    if (batchEmpty && projectFlips.length === 0) {
      exitCurate();
      return;
    }
    if (!user) return;
    setPublishing(true);
    try {
      if (!batchEmpty) {
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
      }
      // The projects' picks are the app server's (labProjectFeature), one call each, outside the batch:
      // a project whose call fails stays staged, the rest of the draft already published.
      const results = await Promise.allSettled(projectFlips.map(([id, featured]) => setProjectFeatured(id, featured)));
      const failed: Record<string, boolean> = {};
      const done = new Map<string, boolean>();
      results.forEach((r, i) => {
        const [id, featured] = projectFlips[i];
        if (r.status === 'fulfilled') {
          done.set(id, featured);
          communityProjects.setFeatured(id, featured);
        } else {
          console.error('failed to publish a project pick', id, r.reason);
          failed[id] = featured;
        }
      });
      setFeaturedProjects((prev) => prev.filter((p) => done.get(p.id) !== false));
      const failedCount = Object.keys(failed).length;
      if (failedCount > 0) {
        setDraftFeatured({});
        setDraftTakedown(new Map());
        setDraftHeroIds(draftHeroIds);
        setDraftProjectFeatured(failed);
        message.error(
          `${failedCount} experiment${failedCount === 1 ? '' : 's'} could not be updated. The rest is published — try again.`,
        );
        return;
      }
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

  // The hero is cut from the featured pool and collapses only while searching (a search narrows the
  // page to a flat result grid).
  const showCurated = !filtering && layout.hero.length > 0;
  // A preview of the Community feed on the front page (the split's other half: give it a window here,
  // the full feed on /community). Hidden while filtering or curating the showcase.
  const showCommunityPreview = !curating && !filtering && projectsSettled && communityPreview.length >= 4;

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
  // A project card's overlay: the Showcase star only — no hero pin (the hero holds recordings), no
  // takedown (a project's is the app server's).
  const buildProjectCuration = (project: CommunityProject): CardCuration | undefined => {
    if (!curating || !staff) return undefined;
    return {
      featured: draftProjectFeatured[project.id] ?? project.featured ?? true,
      canPin: false,
      canTakedown: false,
      onToggleFeatured: (next) => toggleProjectFeatured(project, next),
      onTogglePin: () => {},
      onTakedown: () => {},
    };
  };

  // `communityMenu`: the card is in the "From the community" row, so it gets Community's ⋮.
  const renderCard = (card: ShowcaseCard, curatable = false, communityMenu = false) => {
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
        menuItems={
          communityMenu
            ? buildRecordingCardMenu({ id: card.id, displayName: card.displayName }, saveCopy.request)
            : undefined
        }
        curation={curatable ? buildCuration(card) : undefined}
      />
    );
  };

  const renderShowcaseGrid = () =>
    visible.length === 0 ? (
      <EmptyState
        title="No heat signatures found"
        hint={
          filtering ? 'Try another search to see the whole collection.' : 'Nothing is featured on the homepage yet.'
        }
        action={filtering ? { label: 'Clear search', onClick: () => setHomeSearchTerm('') } : undefined}
      />
    ) : (
      <CardListWrapper>
        {visible.map((item) =>
          item.kind === 'experiment' ? (
            renderCard(item.card, true)
          ) : (
            <CommunityProjectCard
              key={`project-${item.project.id}`}
              project={item.project}
              onSave={saveProjectCopy.save}
              curation={buildProjectCuration(item.project)}
            />
          ),
        )}
      </CardListWrapper>
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
          lists on /community). The first row under the hero, "See all"
          navigates to the Community page. */}
      {showCommunityPreview && (
        <HomeRow
          title="From the community"
          icon={<Globe size={19} strokeWidth={1.75} color="var(--ifi-teal-dark)" aria-hidden />}
          onSeeAll={() => navigate('/community')}
        >
          {communityPreview.map((item) =>
            item.kind === 'experiment' ? (
              renderCard(item.card, false, true)
            ) : (
              <CommunityProjectCard
                key={`project-${item.project.id}`}
                project={item.project}
                onSave={saveProjectCopy.save}
              />
            ),
          )}
        </HomeRow>
      )}

      {/* The collection: every featured recording and experiment, in one grid. */}
      <section id="all-experiments" className={`home-all${filtering ? ' home-all--flush' : ''}`}>
        <div className="home-section-head home-all-head">
          <h2 className="home-section-title">{filtering ? 'Results' : 'Explore the collection'}</h2>
        </div>

        {/* Toolbar: sort + result count. */}
        <div className="home-toolbar-sentinel" ref={sentinelRef} />
        <div className={`home-bar${stuck ? ' is-stuck' : ''}`}>
          <SortMenu value={sort} onChange={setSort} options={HOME_SORT_OPTIONS} />
          <span className="home-result-count mono">
            {visibleProjectCount > 0
              ? `${visibleRecordingCount} recordings · ${visibleProjectCount} experiments`
              : `${visibleRecordingCount} recordings`}
          </span>
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

      {/* The community row's and the collection's Save as… dialogs (naming boxes, sign-in prompts). */}
      {saveCopy.dialogs}
      {saveProjectCopy.dialog}

      {/* Take down reason picker — its confirm STAGES the takedown into the draft (applied on publish). */}
      <TakedownModal target={takedownTarget} onCancel={() => setTakedownTarget(null)} onConfirm={stageTakedown} />
    </div>
  );
};

export default HomePage;
