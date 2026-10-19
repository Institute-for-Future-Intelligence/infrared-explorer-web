/*
 * Community's "AI Project" section (the app repository's
 * docs/proposals/ai-projects-web.md §3.6, lab-project-sharing.md §9.2): the
 * projects their owners made public, newest first, in the same card grid as
 * the experiments above it, with a Load more that follows the server's
 * cursor. Needs no account. Lives under the experiments feed on
 * pages/community.tsx; the page's own heading is the header bar's, so this
 * section carries its own title.
 */

import { Spin } from 'antd';
import { FlaskConical } from 'lucide-react';
import styled from 'styled-components';
import CardListWrapper from '../../components/card/cardListWrapper';
import { useCommunityProjects } from '../useCommunityProjects';
import { useSaveProjectCopy } from '../useSaveProjectCopy';
import CommunityProjectCard from './CommunityProjectCard';

const Section = styled.section<{ $bare: boolean }>`
  margin-top: ${(p) => (p.$bare ? '0' : '48px')};

  .lp-community-sub {
    margin: 4px 0 20px;
    padding: 0 56px;
    font-size: 13px;
    color: var(--ifi-text-tertiary);
  }
  .lp-community-empty {
    padding: 8px 56px 0;
    font-size: 13.5px;
    color: var(--ifi-text-secondary);
  }
  .lp-community-empty button {
    margin-left: 8px;
    padding: 0;
    border: none;
    background: none;
    color: var(--ifi-teal-dark);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .lp-community-loading {
    display: flex;
    justify-content: center;
    padding: 64px 0;
  }
  @media (max-width: 768px) {
    .lp-community-sub,
    .lp-community-empty {
      padding-left: 16px;
      padding-right: 16px;
    }
  }
`;

/**
 * `bare`: the section is the content of Community's AI Project tab, whose
 * label already names it — no heading of its own.
 */
const CommunityProjectsSection = ({ bare = false }: { bare?: boolean }) => {
  const projects = useCommunityProjects(true);
  // Save to My Experiments from a card's menu; its sign-in prompt is rendered once, below the grid.
  const saveCopy = useSaveProjectCopy();

  const body = () => {
    if (projects.loading && projects.items.length === 0) {
      return (
        <div className="lp-community-loading">
          <Spin />
        </div>
      );
    }
    if (projects.error && projects.items.length === 0) {
      return (
        <p className="lp-community-empty">
          Could not load the public experiments.
          <button type="button" onClick={projects.retry}>
            Retry
          </button>
        </p>
      );
    }
    if (projects.items.length === 0) {
      return <p className="lp-community-empty">No public experiments yet.</p>;
    }
    return (
      <>
        <CardListWrapper>
          {projects.items.map((p) => (
            <CommunityProjectCard key={p.id} project={p} onSave={saveCopy.save} />
          ))}
        </CardListWrapper>
        {projects.hasMore && (
          <div className="home-loadmore-wrap">
            <button type="button" className="home-loadmore" onClick={projects.loadMore} disabled={projects.loadingMore}>
              {projects.loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </>
    );
  };

  return (
    <Section aria-label="Experiments" $bare={bare}>
      {!bare && (
        <div className="home-section-head">
          <h2 className="home-section-title">
            <FlaskConical size={19} strokeWidth={1.75} color="var(--ifi-teal-dark)" aria-hidden />
            Experiments
          </h2>
        </div>
      )}
      {!bare && <p className="lp-community-sub">Experiments people have made public, newest first.</p>}
      {body()}
      {saveCopy.dialog}
    </Section>
  );
};

export default CommunityProjectsSection;
