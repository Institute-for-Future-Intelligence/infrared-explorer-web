import { useState } from 'react';
import { Modal, Form, Input, Typography, message } from 'antd';
import { changeClassPassword } from '../../classroom/classroomApi';

interface Props {
  classId: string;
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}

/** Teacher changes the class join password. The old password stops working immediately. */
const ChangeClassPasswordModal = ({ classId, open, onClose, onChanged }: Props) => {
  const [form] = Form.useForm<{ newPassword: string }>();
  const [loading, setLoading] = useState(false);

  const handleOk = async () => {
    try {
      const { newPassword } = await form.validateFields();
      setLoading(true);
      await changeClassPassword(classId, newPassword);
      message.success(
        'Password updated. The old password stops working immediately — share the new one with your students.',
      );
      form.resetFields();
      onChanged?.();
      onClose();
    } catch (err) {
      const e = err as { errorFields?: unknown; message?: string };
      if (!e.errorFields) message.error(e.message || 'Failed to reset');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="Change join password"
      open={open}
      confirmLoading={loading}
      onOk={handleOk}
      okText="Reset"
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        The old password can't be recovered. After you set a new one, <b>the old password stops working immediately</b>;
        students already in the class are unaffected.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="newPassword"
          label="New password"
          rules={[
            { required: true, message: 'Enter a new password' },
            { min: 4, max: 100, message: 'Password must be 4–100 characters' },
          ]}
        >
          <Input.Password placeholder="Students enter this to join" autoFocus />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default ChangeClassPasswordModal;
