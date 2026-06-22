import Rating from './rating';
import { Experiment } from '../../../types';
import ShareLinks from './shareLinks';
import Content from './content';
import styled from 'styled-components';
import dayjs from 'dayjs';
import { Button } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useCommonStore from '../../../stores/common';
import { cloneExperiment } from '../../../services/experiments';

interface DescriptionProps {
  experiment: Experiment | undefined;
}

const Bold = styled.span`
  font-weight: bold;
`;

const Description = ({ experiment }: DescriptionProps) => {
  const user = useCommonStore((state) => state.user);
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);

  if (!experiment) return null;

  const { viewCount = 0, description, date, duration, ownerId, disallowCopy } = experiment;

  const handleSaveCopy = async () => {
    if (!user || saving) return;
    setSaving(true);
    try {
      const newId = await cloneExperiment(experiment, user);
      navigate(`/experiments/${newId}`);
    } catch (e) {
      console.error('failed to save a copy', e);
    } finally {
      setSaving(false);
    }
  };

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

      {user && !disallowCopy && (
        <Button size="small" loading={saving} onClick={handleSaveCopy} style={{ marginBottom: '12px' }}>
          Save a copy
        </Button>
      )}

      <Content description={description} ownerId={ownerId} />
    </div>
  );
};

export default Description;
