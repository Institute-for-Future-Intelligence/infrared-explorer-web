import styled from 'styled-components';
import { CommunityScore, YourRating, useRatings } from './rating';
import { Experiment } from '../../../types';

interface Props {
  experiment: Experiment;
}

// The action row below the fold: view count, the read-only community rating score, and — for
// everyone but the owner — the viewer's own interactive rating (teal). The community average is
// shown as text (never as pretend-clickable stars), so a rater's own stars can hold what they picked
// instead of snapping to the average. Sharing is NOT duplicated here — the single Share affordance
// lives in the workspace header (ShareMenu beside the title). Uses the shared useRatings hook.
const Bar = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 20px;
  margin-top: 4px;

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
`;

const AnalyzerActions = ({ experiment }: Props) => {
  const { average, ratingCount, myRating, rate, isOwner, signedIn } = useRatings(experiment);

  const viewCount = experiment.viewCount ?? 0;
  const viewsPart = `${viewCount} view${viewCount === 1 ? '' : 's'}`;

  return (
    <Bar>
      <span className="rating-meta">{viewsPart}</span>
      <CommunityScore average={average} ratingCount={ratingCount} />
      {!isOwner && <YourRating myRating={myRating} rate={rate} signedIn={signedIn} />}
    </Bar>
  );
};

export default AnalyzerActions;
