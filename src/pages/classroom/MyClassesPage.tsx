import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Empty, Spin, Typography } from 'antd';
import { PlusOutlined, LoginOutlined } from '@ant-design/icons';
import useCommonStore from '../../stores/common';
import { ClassInfo } from '../../classroom/types';
import { fetchJoinedClasses, fetchTaughtClasses } from '../../classroom/classroomApi';
import CreateClassModal from '../../components/classroom/CreateClassModal';
import JoinClassModal from '../../components/classroom/JoinClassModal';
import ClassCard from '../../components/classroom/ClassCard';
import { useIsMobile, useIsPhone } from '../../hooks/useIsMobile';

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div style={{ marginBottom: 28 }}>
    <Typography.Title level={5}>{title}</Typography.Title>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>{children}</div>
  </div>
);

const MyClassesPage = () => {
  const user = useCommonStore((s) => s.user);
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const isPhone = useIsPhone();
  // On phones a full-width card; on tablet/phone cap at 260 but allow shrinking; desktop stays 260.
  const cardWidth = isPhone ? '100%' : isMobile ? 'min(260px, 100%)' : 260;
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

  if (!user) return <div style={{ padding: 24 }}>Please sign in to view your classes.</div>;

  return (
    <div style={{ padding: isMobile ? '24px 12px' : 24, maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button icon={<LoginOutlined />} onClick={() => setJoinOpen(true)}>
            Join class
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            Create class
          </Button>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : taught.length === 0 && joined.length === 0 ? (
        <Empty description="No classes yet. Create one, or join with a class number + password." />
      ) : (
        <>
          {taught.length > 0 && (
            <Section title="Classes I teach">
              {taught.map((c) => (
                <ClassCard
                  key={c.id}
                  info={c}
                  taught
                  cardWidth={cardWidth}
                  onOpen={() => navigate(`/classroom/${c.id}`)}
                />
              ))}
            </Section>
          )}
          {joined.length > 0 && (
            <Section title="Classes I joined">
              {joined.map((c) => (
                <ClassCard
                  key={c.id}
                  info={c}
                  taught={false}
                  cardWidth={cardWidth}
                  onOpen={() => navigate(`/classroom/${c.id}`)}
                />
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
