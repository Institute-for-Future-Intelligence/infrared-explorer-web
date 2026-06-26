import { useEffect, useState } from 'react';
import { Modal, InputNumber, Input, message } from 'antd';
import { fetchGrade, setGrade } from '../../classroom/classroomApi';

interface Props {
  classId: string;
  assignmentId: string;
  studentUid: string;
  studentName: string;
  open: boolean;
  onClose: () => void;
}

/** Teacher-only private grade + comment for one submission. */
const GradeModal = ({ classId, assignmentId, studentUid, studentName, open, onClose }: Props) => {
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetchGrade(classId, assignmentId, studentUid).then((g) => {
      setScore(g?.score ?? null);
      setComment(g?.comment ?? '');
    });
  }, [open, classId, assignmentId, studentUid]);

  const handleOk = async () => {
    try {
      setLoading(true);
      await setGrade(classId, assignmentId, studentUid, { score, comment });
      message.success('Grade saved');
      onClose();
    } catch (err) {
      message.error((err as { message?: string }).message || 'Failed to save');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={`Grade: ${studentName}`}
      open={open}
      confirmLoading={loading}
      onOk={handleOk}
      okText="Save"
      onCancel={onClose}
      destroyOnHidden
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div style={{ marginBottom: 4 }}>Score</div>
          <InputNumber value={score} onChange={setScore} min={0} max={100} style={{ width: 160 }} placeholder="0–100" />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>Comment (visible only to the student)</div>
          <Input.TextArea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={2000} />
        </div>
      </div>
    </Modal>
  );
};

export default GradeModal;
