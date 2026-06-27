import { Typography } from 'antd';
import styled from 'styled-components';
import useCommonStore from '../../../stores/common';
import { renameExperiment } from '../../../services/experiments';
import { Experiment } from '../../../types';
import SaveToMyExperiments from './saveToMyExperiments';

const { Title } = Typography;

// Lay the title and the "Save to My Experiments" action on one row: title takes the available
// space (and wraps), the button stays pinned to the right and is visible across all info tabs.
const TitleWrapper = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;

  .ant-typography {
    flex: 1;
  }
  // Keep the edit pencil hidden until the owner hovers the title, then fade it in with a
  // comfortable gap from the text. Using opacity (not display) reserves the icon's space so
  // the title doesn't shift sideways when the pencil appears.
  .ant-typography-edit {
    margin-inline-start: 16px;
    opacity: 0;
    transition: opacity 0.2s;
  }
  &:hover .ant-typography-edit {
    opacity: 1;
  }
`;

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
    <TitleWrapper>
      <Title
        level={4}
        style={{ marginTop: 8, marginBottom: 4 }}
        editable={editable ? { onChange: handleChange, tooltip: 'Edit title', triggerType: ['icon'] } : false}
      >
        {experiment.displayName || 'Untitled experiment'}
      </Title>
      <SaveToMyExperiments experiment={experiment} />
    </TitleWrapper>
  );
};

export default ExperimentTitle;
