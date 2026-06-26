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
      title="创建班级"
      open={open}
      confirmLoading={loading}
      onOk={created ? () => onCreated(created.classId) : handleOk}
      okText={created ? '进入班级' : '创建'}
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
            班级创建成功！把下面的<b>班级号码</b>和你设置的<b>密码</b>发给学生加入：
          </Typography.Paragraph>
          <Typography.Title level={2} copyable style={{ textAlign: 'center', letterSpacing: 4 }}>
            {created.classNumber}
          </Typography.Title>
        </div>
      ) : (
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="name" label="班级名称" rules={[{ required: true, message: '请输入班级名称' }, { max: 100 }]}>
            <Input placeholder="如：物理 P3" autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            label="加入密码"
            rules={[
              { required: true, message: '请设置加入密码' },
              { min: 4, max: 100, message: '密码 4–100 位' },
            ]}
          >
            <Input.Password placeholder="学生加入时需要输入" />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
};

export default CreateClassModal;
