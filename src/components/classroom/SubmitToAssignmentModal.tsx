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
      message.warning('请选择一个工作区中的实验');
      return;
    }
    try {
      setLoading(true);
      await submitExperimentById(classId, assignmentId, user, item.expId);
      message.success('已提交');
      setSelected(undefined);
      onSubmitted?.();
      onClose();
    } catch (err) {
      message.error((err as { message?: string }).message || '提交失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={`提交到：${assignmentTitle}`}
      open={open}
      confirmLoading={loading}
      onOk={handleOk}
      okText="提交"
      okButtonProps={{ disabled: items.length === 0 }}
      onCancel={() => {
        setSelected(undefined);
        onClose();
      }}
      destroyOnHidden
    >
      {items.length === 0 ? (
        <Empty description="工作区里还没有实验。先从上方“教学材料”复制一份到工作区，修改后再提交。" />
      ) : (
        <Select
          showSearch
          style={{ width: '100%' }}
          placeholder="从我的工作区选择"
          value={selected}
          onChange={setSelected}
          optionFilterProp="label"
          options={items.map((i) => ({ value: i.id, label: i.title || '(未命名)' }))}
        />
      )}
    </Modal>
  );
};

export default SubmitToAssignmentModal;
