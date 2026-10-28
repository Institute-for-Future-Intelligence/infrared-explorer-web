import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Modal, Spin, message } from 'antd';
import styled from 'styled-components';
import { FlaskConical, Images, Pencil } from 'lucide-react';
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
import { buildRecordingCardMenu, useSaveCopy } from '../components/saveCopy';
import CommunityProjectsSection from '../labProjects/components/CommunityProjectsSection';
import { useCommunityProjects } from '../labProjects/useCommunityProjects';
import { setProjectFeatured } from '../labProjects/api';
import type { CommunityProject } from '../labProjects/core/types';

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
/** Community's two feeds: public experiments, and public AI projects. The tab rides in `?tab=` so a link opens it. */
type CommunityTab = 'experiments' | 'projects';

/**
 * The page's head: the two feeds as a segmented control, a line saying what the open one holds, and
 * (staff) the Manage controls at the right — one row instead of a staff bar, a tab
 * strip and a subtitle stacked on top of each other. Wraps to two rows on a narrow window.
 */
const FeedHead = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 20px;
  padding: 8px 56px 0;
  margin-bottom: 24px;

  .feed-switch {
    display: inline-flex;
    flex: none;
    padding: 4px;
    gap: 2px;
    border-radius: 999px;
    background: var(--ifi-fill-1);
  }
  .feed-switch button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 38px;
    padding: 0 18px 0 14px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: var(--ifi-text-secondary);
    font: inherit;
    font-size: 14px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color var(--ifi-dur-fast) var(--ifi-ease-out),
      color var(--ifi-dur-fast) var(--ifi-ease-out),
      box-shadow var(--ifi-dur-fast) var(--ifi-ease-out);
  }
  .feed-switch button:hover {
    color: var(--ifi-ink);
  }
  .feed-switch button:focus-visible {
    outline: 2px solid var(--ifi-teal);
    outline-offset: 2px;
  }
  .feed-switch button[aria-selected='true'] {
    background: var(--ifi-panel);
    color: var(--ifi-ink);
    font-weight: 600;
    box-shadow:
      0 1px 2px rgba(0, 0, 0, 0.06),
      0 2px 8px rgba(0, 0, 0, 0.06);
  }
  .feed-switch svg {
    flex: none;
    color: var(--ifi-text-tertiary);
    transition: color var(--ifi-dur-fast) var(--ifi-ease-out);
  }
  .feed-switch button[aria-selected='true'] svg {
    color: var(--ifi-teal-dark);
  }
  .feed-sub {
    flex: 1 1 220px;
    min-width: 0;
    margin: 0;
    font-size: 13px;
    color: var(--ifi-text-tertiary);
  }
  .feed-tools {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 10px;
    margin-left: auto;
  }

  @media (max-width: 768px) {
    padding: 4px 16px 0;
    margin-bottom: 16px;
    .feed-switch {
      width: 100%;
    }
    .feed-switch button {
      flex: 1;
      justify-content: center;
    }
  }
`;

const FEED_SUB: Record<CommunityTab, string> = {
  experiments: 'The latest from all explorers, newest first.',
  projects: 'Experiments explorers have made public, newest first.',
};

const Community = () => {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab: CommunityTab = params.get('tab') === 'projects' ? 'projects' : 'experiments';
  // the Projects feed loads when first opened, then stays mounted so switching back keeps its pages
  const [projectsSeen, setProjectsSeen] = useState(tab === 'projects');
  if (tab === 'projects' && !projectsSeen) setProjectsSeen(true);
  const pickTab = (key: CommunityTab) => {
    const next = new URLSearchParams(params);
    if (key === 'projects') next.set('tab', 'projects');
    else next.delete('tab');
    setParams(next, { replace: true });
  };
  const openExperiment = (id: string) => navigate(`/experiments/${id}`);
  const user = useCommonStore((state) => state.user);
  const staff = isStaff(user);
  const community = useCommunityExperiments(true);
  // The Experiments feed: loads when its tab is first opened, then keeps its pages (projectsSeen).
  const projects = useCommunityProjects(projectsSeen);
  // "Save as…" from a card's menu: the shared save-a-copy flow (naming dialog, sign-in
  // prompt when signed out), cloning straight from the source doc — no analyzer sandbox here.
  const saveCopy = useSaveCopy();

  // Manage draft: featured flips (id → featured, held only while the draft value differs from the
  // live one — the feed holds Showcase cards too, so a flip can go either way) and takedowns
  // (id → reason). Not persisted (moderation is a task, not a preference); applied in one batch on
  // publish.
  const [managing, setManaging] = useState(false);
  const [draftFeatured, setDraftFeatured] = useState<Record<string, boolean>>({});
  const [draftTakedown, setDraftTakedown] = useState<Map<string, string>>(() => new Map());
  const [publishing, setPublishing] = useState(false);
  const [takedownTarget, setTakedownTarget] = useState<ShowcaseCard | null>(null);
  // Showcase picks staged on the Experiments tab (project id → featured, held only while it differs
  // from the live value). Published through the app's labProjectFeature, one call per flip, after the
  // recordings' batch — a flip that fails stays staged.
  const [draftProjectFeatured, setDraftProjectFeatured] = useState<Record<string, boolean>>({});
  const pendingCount =
    Object.keys(draftFeatured).length + draftTakedown.size + Object.keys(draftProjectFeatured).length;

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
  // A project's Showcase pick; toggling back to its live value drops the entry (nothing to publish).
  const toggleProjectFeatured = (project: CommunityProject, next: boolean) => {
    setDraftProjectFeatured((m) => {
      const copy = { ...m };
      if (next === !!project.featured) delete copy[project.id];
      else copy[project.id] = next;
      return copy;
    });
  };

  // ── Draft lifecycle ──
  const enterManage = () => {
    setDraftFeatured({});
    setDraftTakedown(new Map());
    setDraftProjectFeatured({});
    setManaging(true);
  };
  const exitManage = () => {
    setManaging(false);
    setDraftFeatured({});
    setDraftTakedown(new Map());
    setDraftProjectFeatured({});
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
      const takedowns = [...draftTakedown.entries()].map(([id, reason]) => ({ id, reason }));
      if (featuredChanges.length > 0 || takedowns.length > 0) {
        await publishCuration(
          featuredChanges,
          null, // no hero board on the Community page
          takedowns,
          user,
        );
        // Taken-down cards leave the feed. Featured flips keep their card here (the feed overlaps the
        // Showcase) and only update its flag, so the star is right if Manage is reopened — no refetch.
        draftTakedown.forEach((_, id) => community.removeItem(id));
        featuredChanges.forEach(({ id, featured }) => community.setFeatured(id, featured));
      }
      // The projects' picks are the app server's (labProjectFeature), one call each, outside the batch:
      // the ones that fail stay staged, with the rest of the draft already published.
      const projectFlips = Object.entries(draftProjectFeatured);
      const results = await Promise.allSettled(projectFlips.map(([id, featured]) => setProjectFeatured(id, featured)));
      const failed: Record<string, boolean> = {};
      results.forEach((r, i) => {
        const [id, featured] = projectFlips[i];
        if (r.status === 'fulfilled') projects.setFeatured(id, featured);
        else {
          console.error('failed to publish a project pick', id, r.reason);
          failed[id] = featured;
        }
      });
      const failedCount = Object.keys(failed).length;
      if (failedCount > 0) {
        setDraftFeatured({});
        setDraftTakedown(new Map());
        setDraftProjectFeatured(failed);
        message.error(
          `${failedCount} experiment${failedCount === 1 ? '' : 's'} could not be updated (an experiment must be public to join the Showcase). The rest is published — try again.`,
        );
        return;
      }
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
          ? 'Some recordings changed since they loaded. Exit Manage and reopen to refresh, then try again.'
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

  // A project card's overlay: the Showcase star only — no hero pin (the hero holds recordings), no
  // takedown (a project's is the app server's).
  const buildProjectCuration = (project: CommunityProject): CardCuration | undefined => {
    if (!managing || !staff) return undefined;
    return {
      featured: draftProjectFeatured[project.id] ?? !!project.featured,
      canPin: false,
      canTakedown: false,
      onToggleFeatured: (next) => toggleProjectFeatured(project, next),
      onTogglePin: () => {},
      onTakedown: () => {},
    };
  };

  // Each card's ⋮ menu: open elsewhere, or keep a copy (the home page's community row shows the same).
  // Hidden in Manage mode, where the curation overlay owns the same top-right corner.
  const buildMenu = (card: ShowcaseCard) =>
    managing ? undefined : buildRecordingCardMenu({ id: card.id, displayName: card.displayName }, saveCopy.request);

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
        menuItems={buildMenu(card)}
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
          title="Couldn't load community recordings"
          hint="Something went wrong reaching the community gallery. Try again."
          action={{ label: 'Retry', onClick: community.retry }}
        />
      );
    }
    if (community.items.length === 0) {
      return (
        <EmptyState
          title="No community recordings yet"
          hint="Public recordings will appear here as explorers share them."
          action={user ? { label: 'Go to My Recordings', onClick: () => navigate('/myExperimentsList') } : undefined}
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
      <FeedHead>
        <div className="feed-switch" role="tablist" aria-label="Community feeds">
          <button
            type="button"
            role="tab"
            id="feed-tab-experiments"
            aria-controls="feed-panel-experiments"
            aria-selected={tab === 'experiments'}
            onClick={() => pickTab('experiments')}
          >
            <Images size={17} strokeWidth={1.9} aria-hidden />
            Recordings
          </button>
          <button
            type="button"
            role="tab"
            id="feed-tab-projects"
            aria-controls="feed-panel-projects"
            aria-selected={tab === 'projects'}
            onClick={() => pickTab('projects')}
          >
            <FlaskConical size={17} strokeWidth={1.9} aria-hidden />
            Experiments
          </button>
        </div>
        <p className="feed-sub">{FEED_SUB[tab]}</p>
        {/* Staff Manage mode, over both feeds: a DRAFT session. Stage features / takedowns on recordings
            and Showcase picks on experiments, preview live, then Save & publish (the recordings in one
            atomic batch, the experiments one call each) or Cancel. Nothing is applied until publish. */}
        {staff && (
          <div className="feed-tools">
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
      </FeedHead>

      {/* The page name lives in the header bar (PAGE_TITLES → "Community"). Two feeds: the experiments,
          and the AI projects their owners made public (the app repository's
          docs/proposals/ai-projects-web.md §3.6). */}
      <div
        role="tabpanel"
        id="feed-panel-experiments"
        aria-labelledby="feed-tab-experiments"
        hidden={tab !== 'experiments'}
      >
        {renderBody()}
      </div>
      {projectsSeen && (
        <div role="tabpanel" id="feed-panel-projects" aria-labelledby="feed-tab-projects" hidden={tab !== 'projects'}>
          <CommunityProjectsSection bare projects={projects} curation={buildProjectCuration} />
        </div>
      )}

      <BackToTop />

      {/* Save-a-copy naming dialog / sign-in prompt, shared by every card's menu. */}
      {saveCopy.dialogs}

      {/* Take down reason picker — its confirm STAGES the takedown into the draft (not immediate). */}
      <TakedownModal target={takedownTarget} onCancel={() => setTakedownTarget(null)} onConfirm={stageTakedown} />
    </div>
  );
};

export default Community;
