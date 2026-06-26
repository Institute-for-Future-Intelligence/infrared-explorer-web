import { useState } from 'react';
import { Modal, Form, Input, DatePicker, message } from 'antd';
import { Timestamp } from 'firebase/firestore';
import type { Dayjs } from 'dayjs';
import { createAssignment } from '../../classroom/classroomApi';

interface Props {
  classId: string;
  open: boolean;
  onClose: () => void;
}

/** Teacher creates an assignment (title + optional description + optional due date). */
const CreateAssignmentModal = ({ classId, open, onClose }: Props) => {
  const [form] = Form.useForm<{ title: string; description?: string; dueAt?: Dayjs }>();
  const [loading, setLoading] = useState(false);

  const handleOk = async () => {
    try {
      const { title, description, dueAt } = await form.validateFields();
      setLoading(true);
      await createAssignment(classId, {
        title,
        description,
        dueAt: dueAt ? Timestamp.fromDate(dueAt.toDate()) : null,
      });
      message.success('Assignment created');
      form.resetFields();
      onClose();
    } catch (err) {
      const e = err as { errorFields?: unknown; message?: string };
      if (!e.errorFields) message.error(e.message || 'Failed to create');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="New assignment"
      open={open}
      confirmLoading={loading}
      onOk={handleOk}
      okText="Create"
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="title" label="Title" rules={[{ required: true, message: 'Enter a title' }, { max: 200 }]}>
          <Input placeholder="e.g. Observing the heating curve" autoFocus />
        </Form.Item>
        <Form.Item name="description" label="Description">
          <Input.TextArea rows={3} placeholder="Assignment requirements (optional)" maxLength={2000} />
        </Form.Item>
        <Form.Item name="dueAt" label="Due date">
          <DatePicker showTime style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default CreateAssignmentModal;
