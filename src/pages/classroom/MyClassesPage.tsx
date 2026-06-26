import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Empty, Spin, Tag, Typography } from 'antd';
import { PlusOutlined, LoginOutlined, TeamOutlined } from '@ant-design/icons';
import useCommonStore from '../../stores/common';
import { ClassInfo } from '../../classroom/types';
import { fetchJoinedClasses, fetchTaughtClasses } from '../../classroom/classroomApi';
import CreateClassModal from '../../components/classroom/CreateClassModal';
import JoinClassModal from '../../components/classroom/JoinClassModal';

const ClassCard = ({ info, taught, onOpen }: { info: ClassInfo; taught: boolean; onOpen: () => void }) => (
  <Card hoverable onClick={onOpen} style={{ width: 260 }} styles={{ body: { padding: 16 } }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <Typography.Text strong ellipsis style={{ fontSize: 16 }}>
        {info.name}
      </Typography.Text>
      {taught ? <Tag color="blue">老师</Tag> : <Tag>学生</Tag>}
    </div>
    <div style={{ marginTop: 8, color: '#888', fontSize: 13 }}>
      <TeamOutlined /> {info.memberCount ?? 0} 人
      {taught && <span style={{ marginLeft: 12 }}>号码 {info.classNumber}</span>}
    </div>
  </Card>
);

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div style={{ marginBottom: 28 }}>
    <Typography.Title level={5}>{title}</Typography.Title>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>{children}</div>
  </div>
);

const MyClassesPage = () => {
  const user = useCommonStore((s) => s.user);
  const navigate = useNavigate();
  const [taught, setTaught] = useState<ClassInfo[]>([]);
  const [joined, setJoined] = useState<ClassInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);

  const reload = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    // Settle independently so one query failing (e.g. a missing index) can't blank the other
    // list or surface as an uncaught rejection.
    const [t, j] = await Promise.allSettled([fetchTaughtClasses(user.id), fetchJoinedClasses(user.id)]);
    if (t.status === 'fulfilled') setTaught(t.value);
    else console.error('[classroom] failed to load taught classes', t.reason);
    if (j.status === 'fulfilled') setJoined(j.value);
    else console.error('[classroom] failed to load joined classes', j.reason);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (!user) return <div style={{ padding: 24 }}>请先登录以查看你的班级。</div>;

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          我的班级
        </Typography.Title>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button icon={<LoginOutlined />} onClick={() => setJoinOpen(true)}>
            加入班级
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            创建班级
          </Button>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : taught.length === 0 && joined.length === 0 ? (
        <Empty description="还没有班级。创建一个，或用班级号码 + 密码加入。" />
      ) : (
        <>
          {taught.length > 0 && (
            <Section title="我教的班级">
              {taught.map((c) => (
                <ClassCard key={c.id} info={c} taught onOpen={() => navigate(`/classroom/${c.id}`)} />
              ))}
            </Section>
          )}
          {joined.length > 0 && (
            <Section title="我加入的班级">
              {joined.map((c) => (
                <ClassCard key={c.id} info={c} taught={false} onOpen={() => navigate(`/classroom/${c.id}`)} />
              ))}
            </Section>
          )}
        </>
      )}

      <CreateClassModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false);
          navigate(`/classroom/${id}`);
        }}
      />
      <JoinClassModal
        open={joinOpen}
        onClose={() => setJoinOpen(false)}
        onJoined={(id) => {
          setJoinOpen(false);
          navigate(`/classroom/${id}`);
        }}
      />
    </div>
  );
};

export default MyClassesPage;
