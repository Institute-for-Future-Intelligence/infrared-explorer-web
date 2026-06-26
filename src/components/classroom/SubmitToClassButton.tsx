import { useEffect, useState } from 'react';
import { Button, Modal, Select, Empty, message } from 'antd';
import { SendOutlined } from '@ant-design/icons';
import { Experiment, User } from '../../types';
import { Assignment, ClassInfo } from '../../classroom/types';
import { fetchAssignments, fetchJoinedClasses, submitToAssignment } from '../../classroom/classroomApi';

interface Props {
  experiment: Experiment;
  user: User;
}

/**
 * "Submit to a class assignment" entry shown on the analyzer for the experiment's owner.
 * Pick one of the student's joined classes, then an open assignment, then submit.
 */
const SubmitToClassButton = ({ experiment, user }: Props) => {
  const [open, setOpen] = useState(false);
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [classId, setClassId] = useState<string | undefined>();
  const [assignmentId, setAssignmentId] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetchJoinedClasses(user.id).then(setClasses);
  }, [open, user.id]);

  useEffect(() => {
    setAssignmentId(undefined);
    setAssignments([]);
    if (!classId) return;
    fetchAssignments(classId).then((list) => setAssignments(list.filter((a) => a.open)));
  }, [classId]);

  const handleOk = async () => {
    if (!classId || !assignmentId) {
      message.warning('请选择班级和作业');
      return;
    }
    try {
      setLoading(true);
      await submitToAssignment(classId, assignmentId, user, {
        id: experiment.id,
        displayName: experiment.displayName,
        thumbnailURL: experiment.thumbnailURL,
        duration: experiment.duration,
        recordingId: experiment.recordingId,
        sourceType: experiment.sourceType,
      });
      message.success('已提交到班级作业');
      setOpen(false);
      setClassId(undefined);
      setAssignmentId(undefined);
    } catch (err) {
      message.error((err as { message?: string }).message || '提交失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button icon={<SendOutlined />} onClick={() => setOpen(true)} size="small">
        提交到班级
      </Button>
      <Modal
        title="提交到班级作业"
        open={open}
        confirmLoading={loading}
        onOk={handleOk}
        okText="提交"
        okButtonProps={{ disabled: !classId || !assignmentId }}
        onCancel={() => setOpen(false)}
        destroyOnHidden
      >
        {classes.length === 0 ? (
          <Empty description="你还没有加入任何班级。" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Select
              style={{ width: '100%' }}
              placeholder="选择班级"
              value={classId}
              onChange={setClassId}
              options={classes.map((c) => ({ value: c.id, label: c.name }))}
            />
            <Select
              style={{ width: '100%' }}
              placeholder={classId ? '选择作业' : '请先选择班级'}
              value={assignmentId}
              onChange={setAssignmentId}
              disabled={!classId}
              notFoundContent="该班级暂无可提交的作业"
              options={assignments.map((a) => ({ value: a.id, label: a.title }))}
            />
          </div>
        )}
      </Modal>
    </>
  );
};

export default SubmitToClassButton;
