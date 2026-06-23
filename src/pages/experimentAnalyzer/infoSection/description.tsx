import Rating from './rating';
import { Experiment, ExperimentType, Thermometer, Visibility } from '../../../types';
import ShareLinks from './shareLinks';
import Content from './content';
import styled from 'styled-components';
import dayjs from 'dayjs';
import { Button, message } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useCommonStore from '../../../stores/common';
import { cloneExperiment, saveAnalysis } from '../../../services/experiments';

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
  const [savingAnalysis, setSavingAnalysis] = useState(false);

  if (!experiment) return null;

  const { viewCount = 0, description, date, duration, ownerId, disallowCopy } = experiment;
  // Persisting the analysis only round-trips for recording-sourced clips (video thermometers
  // load from the .wrk preset, not the Firestore subcollection).
  const canSaveAnalysis = !!user && user.id === ownerId && experiment.sourceType === ExperimentType.Recording;

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

  const handleSaveAnalysis = async () => {
    if (!user || savingAnalysis) return;
    setSavingAnalysis(true);
    try {
      const { thermometerMap } = useCommonStore.getState();
      const thermometers = (experiment.thermometersId ?? [])
        .map((id) => thermometerMap.get(id))
        .filter((t): t is Thermometer => !!t);
      await saveAnalysis(
        experiment.id,
        user,
        thermometers,
        experiment.graphsOptions ?? [],
        experiment.visibility ?? Visibility.Private,
      );
      message.success('Analysis saved');
    } catch (e) {
      console.error('failed to save analysis', e);
      message.error('Failed to save analysis');
    } finally {
      setSavingAnalysis(false);
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
        <Button size="small" loading={saving} onClick={handleSaveCopy} style={{ marginBottom: '12px', marginRight: 8 }}>
          Save a copy
        </Button>
      )}
      {canSaveAnalysis && (
        <Button size="small" loading={savingAnalysis} onClick={handleSaveAnalysis} style={{ marginBottom: '12px' }}>
          Save analysis
        </Button>
      )}

      <Content description={description} ownerId={ownerId} />
    </div>
  );
};

export default Description;
