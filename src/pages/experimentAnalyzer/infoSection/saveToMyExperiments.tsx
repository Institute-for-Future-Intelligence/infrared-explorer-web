import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Input, Modal, Tooltip, message } from 'antd';
import { FolderAddOutlined } from '@ant-design/icons';
import styled from 'styled-components';
import useCommonStore from '../../../stores/common';
import { cloneExperimentById } from '../../../services/experiments';
import { Experiment } from '../../../types';

interface Props {
  experiment: Experiment;
}

// Quiet by default (grey outline), teal on hover — mirrors the restraint of the title's edit
// pencil so the action is discoverable without competing with the experiment title beside it.
// Borderless icon button (no circle): just the glyph until hovered.
const SaveButton = styled(Button)`
  color: var(--ifi-grey);

  &:not(:disabled):hover {
    color: var(--ifi-teal) !important;
  }
`;

/** Mirrors cloneExperimentById's default so the prefilled name matches what a blank save would make. */
const defaultName = (experiment: Experiment) => `Copy of ${experiment.displayName ?? ''}`.trim();

/**
 * "Save to My Experiments" — clones the current experiment into a new unlisted, user-owned copy
 * (references only, no thermal binary is duplicated; see cloneExperimentById) and opens it.
 *
 * Clicking opens a confirm dialog prefilled with a default name so the user can rename the copy
 * before it is created. Shown only to a signed-in user who does not already own this experiment —
 * copying your own experiment to yourself is meaningless, so owners just see the edit affordances.
 */
const SaveToMyExperiments = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  if (!user || user.id === experiment.ownerId) return null;

  const openDialog = () => {
    setName(defaultName(experiment));
    setOpen(true);
  };

  const handleSave = async () => {
    const title = name.trim();
    if (!title || saving) return;
    setSaving(true);
    try {
      const newId = await cloneExperimentById(experiment.id, user, title);
      message.success('Saved to your experiments.');
      setOpen(false);
      navigate(`/experiments/${newId}`);
    } catch (e) {
      console.error('failed to save experiment to my experiments', e);
      message.error('Could not save this experiment. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Tooltip title="Save to My Experiments">
        <SaveButton
          type="text"
          icon={<FolderAddOutlined />}
          onClick={openDialog}
          aria-label="Save to My Experiments"
          style={{ flexShrink: 0 }}
        />
      </Tooltip>

      <Modal
        title="Save to My Experiments"
        open={open}
        onOk={handleSave}
        onCancel={() => setOpen(false)}
        okText="Save"
        okButtonProps={{ loading: saving, disabled: !name.trim() }}
        destroyOnClose
      >
        <p style={{ marginTop: 0, color: 'var(--ifi-grey)' }}>Name your copy:</p>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={handleSave}
          placeholder="Experiment name"
          maxLength={120}
          autoFocus
        />
      </Modal>
    </>
  );
};

export default SaveToMyExperiments;
