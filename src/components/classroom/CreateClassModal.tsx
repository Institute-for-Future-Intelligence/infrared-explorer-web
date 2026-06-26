import { useState } from 'react';
import { Modal, Form, Input, Typography, message } from 'antd';
import { createClass } from '../../classroom/classroomApi';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (classId: string) => void;
}

/** Create a class. On success the generated class number is shown so the teacher can share it. */
const CreateClassModal = ({ open, onClose, onCreated }: Props) => {
  const [form] = Form.useForm<{ name: string; password: string }>();
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState<{ classId: string; classNumber: string } | null>(null);

  const reset = () => {
    form.resetFields();
    setCreated(null);
    setLoading(false);
  };

  const handleOk = async () => {
    try {
      const { name, password } = await form.validateFields();
      setLoading(true);
      const res = await createClass(name, password);
      setCreated(res);
    } catch (err) {
      const e = err as { errorFields?: unknown; message?: string };
      if (!e.errorFields) message.error(e.message || 'Failed to create class.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="Create class"
      open={open}
      confirmLoading={loading}
      onOk={created ? () => onCreated(created.classId) : handleOk}
      okText={created ? 'Open class' : 'Create'}
      onCancel={() => {
        reset();
        onClose();
      }}
      cancelButtonProps={{ style: created ? { display: 'none' } : undefined }}
      afterClose={reset}
      destroyOnHidden
    >
      {created ? (
        <div style={{ padding: '8px 0' }}>
          <Typography.Paragraph>
            Class created! Share the <b>class number</b> below and your <b>password</b> with students so they can join.
          </Typography.Paragraph>
          <Typography.Title level={2} copyable style={{ textAlign: 'center', letterSpacing: 4 }}>
            {created.classNumber}
          </Typography.Title>
        </div>
      ) : (
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            name="name"
            label="Class name"
            rules={[{ required: true, message: 'Enter a class name' }, { max: 100 }]}
          >
            <Input placeholder="e.g. Physics P3" autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            label="Join password"
            rules={[
              { required: true, message: 'Set a join password' },
              { min: 4, max: 100, message: 'Password must be 4–100 characters' },
            ]}
          >
            <Input.Password placeholder="Students enter this to join" />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
};

export default CreateClassModal;
