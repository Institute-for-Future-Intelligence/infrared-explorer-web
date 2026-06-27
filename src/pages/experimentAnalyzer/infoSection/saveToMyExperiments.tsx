import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import useCommonStore from '../../../stores/common';
import { cloneExperimentById } from '../../../services/experiments';
import { Experiment } from '../../../types';

interface Props {
  experiment: Experiment;
}

/**
 * "Save to My Experiments" — clones the current experiment into a new unlisted, user-owned copy
 * (references only, no thermal binary is duplicated; see cloneExperimentById) and opens it.
 *
 * Shown only to a signed-in user who does not already own this experiment — copying your own
 * experiment to yourself is meaningless, so owners just see the edit affordances instead.
 */
const SaveToMyExperiments = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);

  if (!user || user.id === experiment.ownerId) return null;

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const newId = await cloneExperimentById(experiment.id, user);
      message.success('Saved to your experiments.');
      navigate(`/experiments/${newId}`);
    } catch (e) {
      console.error('failed to save experiment to my experiments', e);
      message.error('Could not save this experiment. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Button
      type="primary"
      size="small"
      icon={<SaveOutlined />}
      loading={saving}
      onClick={handleSave}
      style={{ backgroundColor: 'var(--ifi-teal)', flexShrink: 0 }}
    >
      Save to My Experiments
    </Button>
  );
};

export default SaveToMyExperiments;
