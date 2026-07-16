import styled from 'styled-components';
import { RatingStars, useRatings } from './rating';
import ShareLinks from './shareLinks';
import { Experiment } from '../../../types';

interface Props {
  experiment: Experiment;
}

// The YouTube-style action row that sits directly under the player (with the title/subject): the
// interactive rating stars + their average, the passive view/rating counts, and the share icons.
// Lifted out of the Description panel — previously these were buried inside a tab, now they're the
// first thing beside the video. Uses the shared useRatings hook (single fetch, keyed on the URL expId).
const Bar = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-top: 4px;

  .ant-rate {
    font-size: 18px;
  }
  .ant-rate-star:not(:last-child) {
    margin-inline-end: 4px;
  }
`;

const RateGroup = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
`;

const AnalyzerActions = ({ experiment }: Props) => {
  const { rating, average, ratingCount, rate, signedIn } = useRatings();

  const viewCount = experiment.viewCount ?? 0;
  const viewsPart = `${viewCount} view${viewCount === 1 ? '' : 's'}`;
  const hasRatings = !!ratingCount && ratingCount > 0;
  const ratingsPart =
    ratingCount === null
      ? ''
      : hasRatings
        ? ` · ${ratingCount} rating${ratingCount === 1 ? '' : 's'}`
        : ' · no ratings yet';

  return (
    <Bar>
      <RateGroup>
        {/* Views · ratings first (far left), then the interactive stars + average. */}
        <span className="rating-meta">
          {viewsPart}
          {ratingsPart}
        </span>
        {rating !== null && <RatingStars rating={rating} rate={rate} signedIn={signedIn} />}
        {hasRatings && average !== null && (
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ifi-text-secondary)' }}>
            {average.toFixed(1)}
          </span>
        )}
      </RateGroup>
      <ShareLinks title={experiment.description} />
    </Bar>
  );
};

export default AnalyzerActions;
