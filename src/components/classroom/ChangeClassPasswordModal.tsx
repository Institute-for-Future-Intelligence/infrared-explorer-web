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
      message.success('密码已更新。旧密码立即失效，请把新密码发给学生。');
      form.resetFields();
      onChanged?.();
      onClose();
    } catch (err) {
      const e = err as { errorFields?: unknown; message?: string };
      if (!e.errorFields) message.error(e.message || '重置失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="修改加入密码"
      open={open}
      confirmLoading={loading}
      onOk={handleOk}
      okText="重置"
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        原密码无法找回。设置一个新密码后，<b>旧密码立即失效</b>，已加入的学生不受影响。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="newPassword"
          label="新密码"
          rules={[
            { required: true, message: '请输入新密码' },
            { min: 4, max: 100, message: '密码 4–100 位' },
          ]}
        >
          <Input.Password placeholder="学生加入时需要输入" autoFocus />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default ChangeClassPasswordModal;
