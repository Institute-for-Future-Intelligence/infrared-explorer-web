import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal, Spin, message } from 'antd';
import { Pencil } from 'lucide-react';
import Card from '../components/card/card';
import CardListWrapper from '../components/card/cardListWrapper';
import type { CardCuration } from '../components/home/curationControls';
import TakedownModal from '../components/home/takedownModal';
import BackToTop from '../components/backToTop';
import EmptyState from '../components/emptyState';
import { useCommunityExperiments } from '../hooks/useCommunityExperiments';
import { publishCuration } from '../services/curation';
import useCommonStore from '../stores/common';
import type { ShowcaseCard } from '../utils/homeLayout';
import { isStaff } from '../utils/staff';
import { authorProfilePath } from '../utils/helpers';

/**
 * Community (/community) — every explorer's public experiments, newest first, including the ones staff
 * have featured onto the Showcase (being picked for the front page doesn't take an experiment out of
 * the open feed). Its own page (in the sidebar under Home) rather than a tab buried below the
 * homepage's curated shelves: an open, unaudited feed kept one deliberate click away from the
 * staff-picked front page.
 *
 * A thin feed by design — grid + Load more, no hero/rows (those are editorial tools that belong to
 * the Showcase). Staff get a Manage mode: a DRAFT session (mirroring the homepage) where featuring a
 * card onto the Showcase (or removing one from it) and taking one down are STAGED, previewed live on
 * the cards, then applied in one atomic batch on Save & publish — or dropped on Cancel. Nothing hits
 * the site until publish.
 */
const Community = () => {
  const navigate = useNavigate();
  const openExperiment = (id: string) => navigate(`/experiments/${id}`);
  const user = useCommonStore((state) => state.user);
  const staff = isStaff(user);
  const community = useCommunityExperiments(true);

  // Manage draft: featured flips (id → featured, held only while the draft value differs from the
  // live one — the feed holds Showcase cards too, so a flip can go either way) and takedowns
  // (id → reason). Not persisted (moderation is a task, not a preference); applied in one batch on
  // publish.
  const [managing, setManaging] = useState(false);
  const [draftFeatured, setDraftFeatured] = useState<Record<string, boolean>>({});
  const [draftTakedown, setDraftTakedown] = useState<Map<string, string>>(() => new Map());
  const [publishing, setPublishing] = useState(false);
  const [takedownTarget, setTakedownTarget] = useState<ShowcaseCard | null>(null);
  const pendingCount = Object.keys(draftFeatured).length + draftTakedown.size;

  // A card is either staged for a featured flip OR staged-to-remove, never both — staging one clears
  // the other. Toggling back to the card's live value drops the entry (nothing to publish).
  const toggleFeatured = (card: ShowcaseCard, next: boolean) => {
    setDraftFeatured((m) => {
      const copy = { ...m };
      if (next === !!card.featured) delete copy[card.id];
      else copy[card.id] = next;
      return copy;
    });
    setDraftTakedown((m) => {
      if (!m.has(card.id)) return m;
      const n = new Map(m);
      n.delete(card.id);
      return n;
    });
  };
  const stageTakedown = (reason: string) => {
    const card = takedownTarget;
    setTakedownTarget(null);
    if (!card) return;
    setDraftTakedown((m) => new Map(m).set(card.id, reason));
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
  const enterManage = () => {
    setDraftFeatured({});
    setDraftTakedown(new Map());
    setManaging(true);
  };
  const exitManage = () => {
    setManaging(false);
    setDraftFeatured({});
    setDraftTakedown(new Map());
  };
  const cancelManage = () => {
    if (pendingCount === 0) {
      exitManage();
      return;
    }
    Modal.confirm({
      title: 'Discard changes?',
      content: `${pendingCount} staged change${pendingCount === 1 ? '' : 's'} will be lost.`,
      okText: 'Discard',
      okButtonProps: { danger: true },
      onOk: exitManage,
    });
  };
  const publish = async () => {
    if (pendingCount === 0 || !user) {
      exitManage();
      return;
    }
    setPublishing(true);
    try {
      const featuredChanges = Object.entries(draftFeatured).map(([id, featured]) => ({ id, featured }));
      await publishCuration(
        featuredChanges,
        null, // no hero board on the Community page
        [...draftTakedown.entries()].map(([id, reason]) => ({ id, reason })),
        user,
      );
      // Taken-down cards leave the feed. Featured flips keep their card here (the feed overlaps the
      // Showcase) and only update its flag, so the star is right if Manage is reopened — no refetch.
      draftTakedown.forEach((_, id) => community.removeItem(id));
      featuredChanges.forEach(({ id, featured }) => community.setFeatured(id, featured));
      message.success('Changes published.');
      exitManage();
    } catch (e) {
      console.error('failed to publish community moderation', e);
      // The batch is all-or-nothing: if one staged card changed since it loaded (owner made it
      // private, or deleted it), the write is rejected and nothing publishes. Point staff at a refresh
      // rather than a bare "try again" that would just fail the same way.
      const code = (e as { code?: string })?.code;
      const stale = code === 'permission-denied' || code === 'not-found';
      message.error(
        stale
          ? 'Some experiments changed since they loaded. Exit Manage and reopen to refresh, then try again.'
          : 'Could not publish. Your changes are kept — try again.',
      );
    } finally {
      setPublishing(false);
    }
  };

  const buildCuration = (card: ShowcaseCard): CardCuration | undefined => {
    if (!managing || !staff) return undefined;
    return {
      featured: draftFeatured[card.id] ?? !!card.featured, // in the Showcase, as the draft has it
      heroRank: undefined,
      canPin: false, // hero pinning lives in the homepage's Manage mode
      pendingTakedown: draftTakedown.has(card.id),
      onToggleFeatured: (next) => toggleFeatured(card, next),
      onTogglePin: () => {},
      onTakedown: () => setTakedownTarget(card),
      onUndoTakedown: () => unstageTakedown(card.id),
    };
  };

  const renderCard = (card: ShowcaseCard) => {
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
        curation={buildCuration(card)}
      />
    );
  };

  const renderBody = () => {
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
          hint="Public experiments will appear here as explorers share them."
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

  return (
    <div className={`community-page${managing ? ' is-curating' : ''}`}>
      {/* Staff Manage mode: a DRAFT session. Stage features / takedowns, preview live, then Save &
          publish (one atomic batch) or Cancel. Nothing is applied until publish. */}
      {staff && (
        <div className="home-staff-bar">
          {managing ? (
            <>
              <span className="curate-pill">
                {pendingCount > 0
                  ? `Draft — ${pendingCount} staged change${pendingCount === 1 ? '' : 's'}. Nothing is applied until you publish.`
                  : 'Draft — no changes yet.'}
              </span>
              <button type="button" className="curate-cancel" onClick={cancelManage} disabled={publishing}>
                Cancel
              </button>
              <button
                type="button"
                className="curate-save"
                onClick={publish}
                disabled={publishing || pendingCount === 0}
              >
                {publishing ? 'Publishing…' : 'Save & publish'}
              </button>
            </>
          ) : (
            <button type="button" className="curate-toggle" onClick={enterManage}>
              <Pencil size={16} strokeWidth={2} aria-hidden />
              Manage
            </button>
          )}
        </div>
      )}

      {/* The page name lives in the header bar (PAGE_TITLES → "Community"); this is just the one-line
          subtitle, shown only when there's content to describe. */}
      {community.items.length > 0 && <p className="community-sub">The latest from all explorers — newest first</p>}

      {renderBody()}

      <BackToTop />

      {/* Take down reason picker — its confirm STAGES the takedown into the draft (not immediate). */}
      <TakedownModal target={takedownTarget} onCancel={() => setTakedownTarget(null)} onConfirm={stageTakedown} />
    </div>
  );
};

export default Community;
