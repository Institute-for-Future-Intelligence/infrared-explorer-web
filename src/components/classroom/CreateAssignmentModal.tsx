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
      message.success('作业已创建');
      form.resetFields();
      onClose();
    } catch (err) {
      const e = err as { errorFields?: unknown; message?: string };
      if (!e.errorFields) message.error(e.message || '创建失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="新建作业"
      open={open}
      confirmLoading={loading}
      onOk={handleOk}
      okText="创建"
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }, { max: 200 }]}>
          <Input placeholder="如：加热曲线观察" autoFocus />
        </Form.Item>
        <Form.Item name="description" label="说明">
          <Input.TextArea rows={3} placeholder="作业要求（可选）" maxLength={2000} />
        </Form.Item>
        <Form.Item name="dueAt" label="截止时间">
          <DatePicker showTime style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default CreateAssignmentModal;
