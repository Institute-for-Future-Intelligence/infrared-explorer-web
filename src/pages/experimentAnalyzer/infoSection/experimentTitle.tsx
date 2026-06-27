import { Typography } from 'antd';
import useCommonStore from '../../../stores/common';
import { renameExperiment } from '../../../services/experiments';
import { Experiment } from '../../../types';

const { Title } = Typography;

interface Props {
  experiment: Experiment;
}

/**
 * The experiment's title (`displayName`) shown at the top of the analyzer's info panel.
 * The owner can edit it inline (antd's pencil affordance); everyone else sees static text.
 * Edits the human title only — never `name`, which is the internal videostore slug.
 */
const ExperimentTitle = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const editable = !!user && user.id === experiment.ownerId;

  // Persist via the rules-permitted rename service, then patch the cached experiment so the
  // new title shows immediately wherever the store is read (card lists, header, this panel)
  // instead of lagging a navigation behind Firestore — mirrors content.tsx's description flush.
  const handleChange = (value: string) => {
    const next = value.trim();
    if (!next || next === experiment.displayName) return;
    renameExperiment(experiment.id, next).catch((e) => console.error('failed to rename experiment', e));
    const exp = useCommonStore.getState().experimentMap.get(experiment.id);
    if (exp) useCommonStore.getState().setExperiment(experiment.id, { ...exp, displayName: next });
  };

  return (
    <Title
      level={4}
      style={{ marginTop: 8, marginBottom: 4 }}
      editable={editable ? { onChange: handleChange, tooltip: 'Edit title', triggerType: ['icon', 'text'] } : false}
    >
      {experiment.displayName || 'Untitled experiment'}
    </Title>
  );
};

export default ExperimentTitle;
