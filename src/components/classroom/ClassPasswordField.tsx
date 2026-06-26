import { useCallback, useEffect, useState } from 'react';
import { Button, Typography } from 'antd';
import { EyeOutlined, EyeInvisibleOutlined, EditOutlined } from '@ant-design/icons';
import { fetchClassPassword } from '../../classroom/classroomApi';
import ChangeClassPasswordModal from './ChangeClassPasswordModal';

/**
 * Teacher-only inline password display: masked by default, revealed on click (eye), copyable
 * when shown, and editable (pencil → modal). Reads classSecrets, which the rules gate to the
 * class's teacher.
 */
const ClassPasswordField = ({ classId }: { classId: string }) => {
  const [password, setPassword] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(() => {
    fetchClassPassword(classId)
      .then(setPassword)
      .catch(() => setPassword(null));
  }, [classId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      密码：
      {revealed ? (
        <Typography.Text strong copyable={{ text: password ?? '' }} style={{ letterSpacing: 1 }}>
          {password ?? '——'}
        </Typography.Text>
      ) : (
        <Typography.Text strong style={{ letterSpacing: 2 }}>
          ••••••
        </Typography.Text>
      )}
      <Button
        type="text"
        size="small"
        icon={revealed ? <EyeInvisibleOutlined /> : <EyeOutlined />}
        onClick={() => setRevealed((v) => !v)}
        title={revealed ? '隐藏' : '显示'}
      />
      <Button type="text" size="small" icon={<EditOutlined />} onClick={() => setEditOpen(true)} title="修改密码" />
      <ChangeClassPasswordModal
        classId={classId}
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onChanged={() => {
          setRevealed(true);
          load();
        }}
      />
    </span>
  );
};

export default ClassPasswordField;
