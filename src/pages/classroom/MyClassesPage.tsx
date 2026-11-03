/*
 * "My Classes" — the classes this account teaches, with Create and each card's ⋮ (share the join
 * info, accept students, change the password, rename, delete — ClassActionsMenu, the class page's
 * menu too). Reached from the sidebar and the Me hub once the user has said they teach (Settings ›
 * Classes; user 2026-11-02: the entry shows for nobody else). A student has no list: they enrol in
 * Settings › Classes and submit from an experiment's page.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Empty, Spin } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import useCommonStore from '../../stores/common';
import { ClassInfo } from '../../classroom/types';
import { fetchTaughtClasses } from '../../classroom/classroomApi';
import { teacherRoleOf, useTeacherRole } from '../../classroom/teacherRole';
import CreateClassModal from '../../components/classroom/CreateClassModal';
import ClassCard from '../../components/classroom/ClassCard';
import ClassActionsMenu from '../../components/classroom/ClassActionsMenu';
import { useIsMobile, useIsPhone } from '../../hooks/useIsMobile';

const MyClassesPage = () => {
  const user = useCommonStore((s) => s.user);
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const isPhone = useIsPhone();
  const teacher = useTeacherRole(user?.id);
  // On phones a full-width card; on tablet/phone cap at 260 but allow shrinking; desktop stays 260.
  const cardWidth = isPhone ? '100%' : isMobile ? 'min(260px, 100%)' : 260;
  const [taught, setTaught] = useState<ClassInfo[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const reload = useCallback(async () => {
    if (!user) return;
    try {
      setTaught(await fetchTaughtClasses(user.id));
    } catch (e) {
      console.error('[classroom] failed to load taught classes', e);
      setTaught((prev) => prev ?? []);
    }
  }, [user]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (!user) return <div style={{ padding: 24 }}>Please sign in to view your classes.</div>;
  // The role is read once per account; until it is known the page waits rather than flashing the note.
  if (teacherRoleOf(user.id) == null)
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    );
  if (!teacher)
    return (
      <div style={{ padding: 24, maxWidth: 640, margin: '0 auto' }}>
        <Empty
          description={
            <span>
              Classes are for teachers. Turn on <b>I'm a teacher</b> in <Link to="/settings">Settings › Classes</Link>{' '}
              to create one.
            </span>
          }
        />
      </div>
    );

  const patch = (classId: string, p: Partial<ClassInfo> | null) =>
    setTaught((prev) =>
      prev
        ? p == null
          ? prev.filter((c) => c.id !== classId)
          : prev.map((c) => (c.id === classId ? { ...c, ...p } : c))
        : prev,
    );

  return (
    <div style={{ padding: isMobile ? '24px 12px' : 24, maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          Create class
        </Button>
      </div>

      {taught == null ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : taught.length === 0 ? (
        <Empty description="No classes yet. Create one, then share its number and password with your students." />
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          {taught.map((c) => (
            <ClassCard
              key={c.id}
              info={c}
              cardWidth={cardWidth}
              onOpen={() => navigate(`/classroom/${c.id}`)}
              menu={<ClassActionsMenu info={c} onChanged={(p) => patch(c.id, p)} onDeleted={() => patch(c.id, null)} />}
            />
          ))}
        </div>
      )}

      <CreateClassModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false);
          navigate(`/classroom/${id}`);
        }}
      />
    </div>
  );
};

export default MyClassesPage;
