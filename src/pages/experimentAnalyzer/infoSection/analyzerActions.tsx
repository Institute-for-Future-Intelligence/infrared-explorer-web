import styled from 'styled-components';
import { CommunityScore, YourRating, useRatings } from './rating';
import { Experiment } from '../../../types';

interface Props {
  experiment: Experiment;
}

// The experiment's engagement row: view count, comment count (a scroll link down to the comments
// below the fold), the read-only community rating score, and — for everyone but the owner — the
// viewer's own interactive rating (teal). The community average is shown as text (never as
// pretend-clickable stars), so a rater's own stars can hold what they picked instead of snapping to
// the average. It sits pinned to the bottom of the Info tab (below the description) as the panel's
// footer, so these identity stats land on the first screen. Sharing is NOT duplicated here — the
// single Share affordance lives in the workspace header (ShareMenu beside the title). Uses the shared
// useRatings hook (one mount, reading the doc's Function-maintained aggregates).
const Bar = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 20px;

  .rating-score {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 15px;
  }
  .your-rating {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .ant-rate {
    font-size: 18px;
  }
  .ant-rate-star:not(:last-child) {
    margin-inline-end: 4px;
  }
  /* Comment count reads as the same de-emphasized metric as the view count, but is a real button that
     smooth-scrolls the page down to the comments section (an anchor href can't — the app is on a hash
     router, so "#comments" would be parsed as a route). */
  .engagement-link {
    appearance: none;
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    cursor: pointer;
  }
  .engagement-link:hover {
    text-decoration: underline;
  }
`;

// Smooth-scroll the page (the .content container, which is what actually scrolls) to the comments
// section. #comments already exists below the fold (see InfoSection); scrollIntoView resolves against
// the nearest scrollable ancestor, so no manual offset math is needed.
const scrollToComments = () =>
  document.getElementById('comments')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

const AnalyzerActions = ({ experiment }: Props) => {
  const { average, ratingCount, myRating, rate, isOwner, signedIn } = useRatings(experiment);

  const viewCount = experiment.viewCount ?? 0;
  const viewsPart = `${viewCount} view${viewCount === 1 ? '' : 's'}`;
  const commentCount = experiment.commentsId?.length ?? 0;

  return (
    <Bar>
      <span className="rating-meta">{viewsPart}</span>
      <button type="button" className="rating-meta engagement-link" onClick={scrollToComments}>
        {commentCount} comment{commentCount === 1 ? '' : 's'}
      </button>
      <CommunityScore average={average} ratingCount={ratingCount} />
      {!isOwner && <YourRating myRating={myRating} rate={rate} signedIn={signedIn} />}
    </Bar>
  );
};

export default AnalyzerActions;
