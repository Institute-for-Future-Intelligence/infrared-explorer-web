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
      if (res.alreadyMember) message.info('你已经在这个班级里了。');
      else message.success('加入成功！');
      onJoined(res.classId);
    } catch (err) {
      const e = err as { errorFields?: unknown; message?: string };
      if (!e.errorFields) message.error(e.message || '加入失败，请检查班级号码和密码。');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="加入班级"
      open={open}
      confirmLoading={loading}
      onOk={handleOk}
      okText="加入"
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      afterClose={() => form.resetFields()}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="classNumber" label="班级号码" rules={[{ required: true, message: '请输入班级号码' }]}>
          <Input placeholder="老师提供的 6 位号码" autoFocus />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password placeholder="老师提供的加入密码" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default JoinClassModal;
