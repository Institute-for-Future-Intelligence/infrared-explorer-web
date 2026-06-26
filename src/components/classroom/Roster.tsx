import { useEffect, useState } from 'react';
import { List, Button, Popconfirm, Typography, Empty } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { ClassMember } from '../../classroom/types';
import { removeMember, subscribeMembers } from '../../classroom/classroomApi';

interface Props {
  classId: string;
  isTeacher: boolean;
}

const formatDate = (ts?: { toDate?: () => Date } | null) => (ts?.toDate ? ts.toDate().toLocaleString() : '—');

/** Class roster. Teacher sees per-student detail + a remove action. */
const Roster = ({ classId, isTeacher }: Props) => {
  const [members, setMembers] = useState<ClassMember[]>([]);

  useEffect(() => subscribeMembers(classId, setMembers), [classId]);

  if (members.length === 0) return <Empty description="还没有学生加入。" />;

  return (
    <List
      header={<Typography.Text type="secondary">{members.length} 名学生</Typography.Text>}
      dataSource={members}
      renderItem={(m) => (
        <List.Item
          actions={
            isTeacher
              ? [
                  <Popconfirm
                    key="remove"
                    title="移除该学生？"
                    description="只删除其成员身份，不删除其实验。"
                    onConfirm={() => removeMember(classId, m.uid)}
                    okText="移除"
                    cancelText="取消"
                  >
                    <Button danger type="text" icon={<DeleteOutlined />} />
                  </Popconfirm>,
                ]
              : undefined
          }
        >
          <List.Item.Meta
            title={m.displayName || '(未命名)'}
            description={
              isTeacher ? (
                <span style={{ fontSize: 12, color: '#888' }}>
                  {m.email} · 提交 {m.submissionCount ?? 0} · 最近活跃 {formatDate(m.lastActiveAt)}
                </span>
              ) : null
            }
          />
        </List.Item>
      )}
    />
  );
};

export default Roster;
