import { useState } from 'react';
import { Modal, Form, Input, message } from 'antd';
import { joinClass } from '../../classroom/classroomApi';

interface Props {
  open: boolean;
  onClose: () => void;
  onJoined: (classId: string) => void;
}

/** Join a class by number + password (validated server-side by the joinClass callable). */
const JoinClassModal = ({ open, onClose, onJoined }: Props) => {
  const [form] = Form.useForm<{ classNumber: string; password: string }>();
  const [loading, setLoading] = useState(false);

  const handleOk = async () => {
    try {
      const { classNumber, password } = await form.validateFields();
      setLoading(true);
      const res = await joinClass(classNumber.trim(), password);
      if (res.alreadyMember) message.info("You're already in this class.");
      else message.success('Joined!');
      onJoined(res.classId);
    } catch (err) {
      const e = err as { errorFields?: unknown; message?: string };
      if (!e.errorFields) message.error(e.message || "Couldn't join. Check the class number and password.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="Join class"
      open={open}
      confirmLoading={loading}
      onOk={handleOk}
      okText="Join"
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      afterClose={() => form.resetFields()}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="classNumber" label="Class number" rules={[{ required: true, message: 'Enter class number' }]}>
          <Input placeholder="The 6-digit number from your teacher" autoFocus />
        </Form.Item>
        <Form.Item name="password" label="Password" rules={[{ required: true, message: 'Enter password' }]}>
          <Input.Password placeholder="The join password from your teacher" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default JoinClassModal;
