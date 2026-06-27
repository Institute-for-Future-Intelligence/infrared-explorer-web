import Rating from './rating';
import { Experiment } from '../../../types';
import ShareLinks from './shareLinks';
import Content from './content';
import styled from 'styled-components';
import dayjs from 'dayjs';
import useCommonStore from '../../../stores/common';

interface DescriptionProps {
  experiment: Experiment | undefined;
}

const Bold = styled.span`
  font-weight: bold;
`;

const Description = ({ experiment }: DescriptionProps) => {
  const user = useCommonStore((state) => state.user);

  if (!experiment) return null;

  const { id, viewCount = 0, description, date, duration, ownerId, author } = experiment;

  // Credit the author when viewing someone else's experiment; the owner already knows it's theirs.
  const showAuthor = !!author && ownerId !== user?.id;

  return (
    <div>
      <Rating viewCount={viewCount} />

      <ShareLinks title={description} />

      <div style={{ fontSize: '14px', paddingBottom: '12px' }}>
        {showAuthor && (
          <>
            <Bold>Author</Bold>: {author}
            <br />
          </>
        )}
        <Bold>Date</Bold>: {dayjs(date).format('MM/DD/YYYY hh:mm a')}
        <br />
        <Bold>Duration</Bold>: {duration} seconds
        <br />
      </div>

      <Content key={id} expId={id} description={description} ownerId={ownerId} />
    </div>
  );
};

export default Description;
