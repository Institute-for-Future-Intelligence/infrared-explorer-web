import { useState } from 'react';
import { Button, Form, Input, message } from 'antd';
import { submitContact } from '../services/contact';

const Contact = () => {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const onFinish = async (values: { name: string; email: string; message: string }) => {
    setSubmitting(true);
    try {
      await submitContact(values.name, values.email, values.message);
      message.success('Thanks! Your message has been sent.');
      form.resetFields();
    } catch (e) {
      console.error('failed to submit contact', e);
      message.error('Sorry, the message could not be sent. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '8px 16px' }}>
      <Form form={form} layout="vertical" onFinish={onFinish}>
        <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Please enter your name.' }]}>
          <Input placeholder="Your name" />
        </Form.Item>
        <Form.Item
          name="email"
          label="Email"
          rules={[
            { required: true, message: 'Please enter your email.' },
            { type: 'email', message: 'Please enter a valid email.' },
          ]}
        >
          <Input placeholder="you@example.com" />
        </Form.Item>
        <Form.Item name="message" label="Message" rules={[{ required: true, message: 'Please enter a message.' }]}>
          <Input.TextArea rows={5} placeholder="How can we help?" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={submitting}>
            Send
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default Contact;
