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
 * Saves the current experiment into a new unlisted, user-owned copy (references only, no thermal
 * binary is duplicated; see cloneExperimentById) and opens it. Clicking opens a confirm dialog
 * prefilled with a default name so the user can rename the copy before it is created.
 *
 * For someone else's experiment it acts as "Save to My Experiments"; on your own experiment the
 * same clone is a "Save as New Experiment" (duplicate). Hidden when signed out.
 */
const SaveToMyExperiments = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  if (!user) return null;

  const isOwner = user.id === experiment.ownerId;
  const label = isOwner ? 'Save as New Experiment' : 'Save to My Experiments';

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
      message.success(isOwner ? 'Saved as a new experiment.' : 'Saved to your experiments.');
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
      <Tooltip title={label}>
        <SaveButton
          type="text"
          icon={<FolderAddOutlined />}
          onClick={openDialog}
          aria-label={label}
          style={{ flexShrink: 0 }}
        />
      </Tooltip>

      <Modal
        title={label}
        open={open}
        onOk={handleSave}
        onCancel={() => setOpen(false)}
        okText="Save"
        okButtonProps={{ loading: saving, disabled: !name.trim() }}
        destroyOnHidden
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
