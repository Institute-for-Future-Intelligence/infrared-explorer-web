import { useEffect, useState } from 'react';
import { Modal, Select, Empty, message } from 'antd';
import { User } from '../../types';
import { WorkspaceItem } from '../../classroom/types';
import { fetchWorkspace, submitExperimentById } from '../../classroom/classroomApi';

interface Props {
  classId: string;
  assignmentId: string;
  assignmentTitle: string;
  user: User;
  open: boolean;
  onClose: () => void;
  onSubmitted?: () => void;
}

/**
 * Student picks one of their workspace items (copied from a teacher's material, then edited)
 * to submit to an assignment. Submissions are constrained to workspace work, not the student's
 * whole experiment library.
 */
const SubmitToAssignmentModal = ({
  classId,
  assignmentId,
  assignmentTitle,
  user,
  open,
  onClose,
  onSubmitted,
}: Props) => {
  const [items, setItems] = useState<WorkspaceItem[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetchWorkspace(classId, user.id).then(setItems);
  }, [open, classId, user.id]);

  const handleOk = async () => {
    const item = items.find((i) => i.id === selected);
    if (!item) {
      message.warning('Please select an experiment from your workspace');
      return;
    }
    try {
      setLoading(true);
      await submitExperimentById(classId, assignmentId, user, item.expId);
      message.success('Submitted');
      setSelected(undefined);
      onSubmitted?.();
      onClose();
    } catch (err) {
      message.error((err as { message?: string }).message || 'Failed to submit');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={`Submit to: ${assignmentTitle}`}
      open={open}
      confirmLoading={loading}
      onOk={handleOk}
      okText="Submit"
      okButtonProps={{ disabled: items.length === 0 }}
      onCancel={() => {
        setSelected(undefined);
        onClose();
      }}
      destroyOnHidden
    >
      {items.length === 0 ? (
        <Empty description='No experiments in your workspace yet. Copy a material from "Teaching materials" above to your workspace, edit it, then submit.' />
      ) : (
        <Select
          showSearch
          style={{ width: '100%' }}
          placeholder="Select from my workspace"
          value={selected}
          onChange={setSelected}
          optionFilterProp="label"
          options={items.map((i) => ({ value: i.id, label: i.title || '(untitled)' }))}
        />
      )}
    </Modal>
  );
};

export default SubmitToAssignmentModal;
