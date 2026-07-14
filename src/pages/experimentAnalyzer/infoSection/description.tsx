import { RatingStars, useRatings } from './rating';
import { Experiment } from '../../../types';
import ShareLinks from './shareLinks';
import Content from './content';
import styled from 'styled-components';
import dayjs from 'dayjs';
import { Link } from 'react-router-dom';
import useCommonStore from '../../../stores/common';
import { formatDuration } from '../../../utils/helpers';
import { VisibilitySelect } from '../../../components/visibilityControl';
import { FeatureToggle } from '../../../components/featureControl';
import { isStaff } from '../../../utils/staff';

interface DescriptionProps {
  experiment: Experiment | undefined;
}

// Author/Date/Duration as a real definition list: a two-column grid aligns the values, the muted
// labels sit in their own column (label and value no longer share size/weight), and assistive tech
// reads it as structured term/description pairs instead of one <br>-separated text run.
const MetaList = styled.dl`
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  font-size: 14px;
  line-height: 1.2;

  dt {
    color: var(--ifi-text-tertiary);
    font-weight: 400;
  }
  dd {
    margin: 0;
    color: #262626;
  }
`;

// Rate + Share, one compact row placed after the facts: the stars and their view/rating counts sit
// together at the left, the share icons at the right. flex-wrap lets the share group drop to a second
// line on the narrowest panels while the stars + counts stay together.
const ActionBar = styled.div`
  margin-top: 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;

  .ant-rate {
    font-size: 18px;
  }
  .ant-rate-star:not(:last-child) {
    margin-inline-end: 4px;
  }
`;

// Stars + the view/rating counts, kept together on one line.
const RateGroup = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
`;

const Description = ({ experiment }: DescriptionProps) => {
  const user = useCommonStore((state) => state.user);
  const setExperiment = useCommonStore((state) => state.setExperiment);
  const { rating, average, ratingCount, rate, signedIn } = useRatings();

  if (!experiment) return null;

  const { id, viewCount = 0, description, date, duration, ownerId, author, updatedAt } = experiment;

  // Credit the author when viewing someone else's experiment; the owner already knows it's theirs.
  const showAuthor = !!author && ownerId !== user?.id;
  const isOwner = ownerId === user?.id;
  // A viewer on a description-less experiment sees no empty box; the owner always gets it (it invites
  // them to write). No separate heading: this sits at the top of the already-"Description" tab.
  const showDescription = !!description || isOwner;

  // Last-edit time, shown only on the owner's own experiments (a private "you last changed this on…"
  // cue). Absent on never-edited / legacy docs, so the row only appears when there's a real value.
  const updatedDate = isOwner ? (updatedAt?.toDate?.() ?? null) : null;

  // Passive metrics (a fact about the experiment's reception), shown up top with the other facts.
  // The rating count appends once the fetch resolves; views show immediately.
  const viewsPart = `${viewCount} view${viewCount === 1 ? '' : 's'}`;
  const hasRatings = !!ratingCount && ratingCount > 0;
  const ratingsPart =
    ratingCount === null
      ? ''
      : hasRatings
        ? ` · ${ratingCount} rating${ratingCount === 1 ? '' : 's'}`
        : ' · no ratings yet';

  return (
    <div>
      {/* Description first — it's the point of the panel — then the facts/metrics, then the
          rate + share actions. */}
      {showDescription && (
        <div style={{ marginBottom: 16 }}>
          <Content key={id} expId={id} description={description} ownerId={ownerId} />
        </div>
      )}

      <MetaList>
        {showAuthor && (
          <>
            <dt>Author</dt>
            {/* System showcases have no profile page; real owners' names link to theirs. */}
            <dd>{ownerId && ownerId !== 'system' ? <Link to={`/users/${ownerId}`}>{author}</Link> : author}</dd>
          </>
        )}
        <dt>Published</dt>
        <dd title={dayjs(date).format('MM/DD/YYYY hh:mm a')}>{dayjs(date).format('MMM D, YYYY')}</dd>
        {updatedDate && (
          <>
            <dt>Updated</dt>
            <dd title={dayjs(updatedDate).format('MM/DD/YYYY hh:mm a')}>{dayjs(updatedDate).format('MMM D, YYYY')}</dd>
          </>
        )}
        <dt>Duration</dt>
        <dd title={`${duration} seconds`}>{formatDuration(duration)}</dd>
        {/* Owner-only visibility picker — deciding right after recording/analyzing is the natural
            moment, so it lives here as well as in the card menus. The store copy is synced so a
            later auto-save (which passes experiment.visibility) writes the new tier. */}
        {isOwner && experiment.visibility && (
          <>
            <dt>Visibility</dt>
            <dd>
              <VisibilitySelect
                expId={id}
                value={experiment.visibility}
                onChanged={(v) => setExperiment(id, { ...experiment, visibility: v })}
              />
            </dd>
          </>
        )}
        {/* Staff-only: feature this experiment on the site homepage (also promotes it to Public).
            Syncs both flags into the store so the Visibility picker above and a later auto-save
            see the promotion. */}
        {isOwner && isStaff(user) && (
          <>
            <dt>Homepage</dt>
            <dd>
              <FeatureToggle
                expId={id}
                ownerId={ownerId}
                featured={!!experiment.featured}
                visibility={experiment.visibility}
                onChanged={({ featured, visibility }) => setExperiment(id, { ...experiment, featured, visibility })}
              />
            </dd>
          </>
        )}
      </MetaList>

      <ActionBar>
        <RateGroup>
          {rating !== null && <RatingStars rating={rating} rate={rate} signedIn={signedIn} />}
          {hasRatings && average !== null && (
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ifi-text-secondary)' }}>
              {average.toFixed(1)}
            </span>
          )}
          <span className="rating-meta">
            {viewsPart}
            {ratingsPart}
          </span>
        </RateGroup>
        <ShareLinks title={description} />
      </ActionBar>
    </div>
  );
};

export default Description;
