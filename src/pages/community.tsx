import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Spin, message } from 'antd';
import { Pencil } from 'lucide-react';
import Card from '../components/card/card';
import CardListWrapper from '../components/card/cardListWrapper';
import type { CardCuration } from '../components/home/curationControls';
import TakedownModal from '../components/home/takedownModal';
import Footer from '../components/footer';
import BackToTop from '../components/backToTop';
import EmptyState from '../components/emptyState';
import { useCommunityExperiments } from '../hooks/useCommunityExperiments';
import { changeFeatured } from '../components/featureControl';
import { takedownExperiment } from '../services/curation';
import useCommonStore from '../stores/common';
import type { ShowcaseCard } from '../utils/homeLayout';
import { isStaff } from '../utils/staff';
import { authorProfilePath } from '../utils/helpers';

/**
 * Community (/community) — every explorer's public experiments, newest first. Its own page (in the
 * sidebar under Home) rather than a tab buried below the homepage's curated shelves: an open,
 * unaudited feed kept one deliberate click away from the staff-picked front page.
 *
 * A thin feed by design — grid + Load more, no hero/rows (those are editorial tools that belong to
 * the Showcase). Staff get a Manage toggle that reveals per-card, IMMEDIATE actions: Feature (adds to
 * the homepage Showcase right away — no draft, unlike the homepage's Curate mode) and Take down.
 */
const Community = () => {
  const navigate = useNavigate();
  const openExperiment = (id: string) => navigate(`/experiments/${id}`);
  const user = useCommonStore((state) => state.user);
  const staff = isStaff(user);
  const community = useCommunityExperiments(true);
  const [managing, setManaging] = useState(false);
  const [takedownTarget, setTakedownTarget] = useState<ShowcaseCard | null>(null);

  // Feature a community experiment onto the homepage Showcase — immediate (no draft). On success it
  // becomes featured and thus leaves this (non-featured) feed, so drop it from the list.
  const featureToShowcase = async (card: ShowcaseCard) => {
    const res = await changeFeatured(card.id, true, card.visibility);
    if (res) community.removeItem(card.id);
  };

  const confirmTakedown = async (reason: string) => {
    const card = takedownTarget;
    setTakedownTarget(null);
    if (!card || !user) return;
    community.removeItem(card.id);
    try {
      await takedownExperiment(card.id, reason, user);
      message.success('Taken down — removed from the site.');
    } catch (e) {
      console.error('failed to take down', e);
      message.error('Could not take it down. Reload and try again.');
    }
  };

  const buildCuration = (card: ShowcaseCard): CardCuration | undefined => {
    if (!managing || !staff) return undefined;
    return {
      featured: false, // community cards are, by definition, not featured
      heroRank: undefined,
      canPin: false, // hero pinning lives in the homepage's Curate mode
      onToggleFeatured: (next) => {
        if (next) void featureToShowcase(card);
      },
      onTogglePin: () => {},
      onTakedown: () => setTakedownTarget(card),
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

  return (
    <div className={`community-page${managing ? ' is-curating' : ''}`}>
      {staff && (
        <div className="home-staff-bar">
          <button
            type="button"
            className={`curate-toggle${managing ? ' active' : ''}`}
            aria-pressed={managing}
            onClick={() => setManaging((m) => !m)}
          >
            <Pencil size={16} strokeWidth={2} aria-hidden />
            {managing ? 'Done' : 'Manage'}
          </button>
        </div>
      )}

      <div className="home-section-head community-head">
        <div className="community-head-text">
          <h2 className="home-section-title">Community</h2>
          <p className="pool-sub">The latest from all explorers — newest first</p>
        </div>
        {community.items.length > 0 && (
          <span className="home-result-count mono">
            {community.items.length}
            {community.hasMore ? '+' : ''} loaded
          </span>
        )}
      </div>

      {renderBody()}

      <Footer />
      <BackToTop />

      <TakedownModal target={takedownTarget} onCancel={() => setTakedownTarget(null)} onConfirm={confirmTakedown} />
    </div>
  );
};

export default Community;
