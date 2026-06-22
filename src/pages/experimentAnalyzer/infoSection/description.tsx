import Rating from './rating';
import { Experiment } from '../../../types';
import ShareLinks from './shareLinks';
import Content from './content';
import styled from 'styled-components';
import dayjs from 'dayjs';

interface DescriptionProps {
  experiment: Experiment | undefined;
}

const Bold = styled.span`
  font-weight: bold;
`;

const Description = ({ experiment }: DescriptionProps) => {
  if (!experiment) return null;

  const { viewCount = 0, description, date, duration, ownerId } = experiment;

  return (
    <div>
      <Rating viewCount={viewCount} />

      <ShareLinks title={description} />

      <div style={{ fontSize: '14px', paddingBottom: '12px' }}>
        <Bold>Date</Bold>: {dayjs(date).format('MM/DD/YYYY hh:mm a')}
        <br />
        <Bold>Duration</Bold>: {duration} seconds
        <br />
      </div>

      <Content description={description} ownerId={ownerId} />
    </div>
  );
};

export default Description;
