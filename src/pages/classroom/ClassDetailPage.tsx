import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Popconfirm, Spin, Switch, Tabs, Tag, Typography, message } from 'antd';
import { ArrowLeftOutlined, DeleteOutlined } from '@ant-design/icons';
import useCommonStore from '../../stores/common';
import { ClassInfo, ShowcaseItem } from '../../classroom/types';
import {
  copyMaterialToWorkspace,
  deleteClass,
  fetchClass,
  leaveClass,
  setJoinOpen,
} from '../../classroom/classroomApi';
import Roster from '../../components/classroom/Roster';
import AssignmentList from '../../components/classroom/AssignmentList';
import ShowcaseGrid from '../../components/classroom/ShowcaseGrid';
import MaterialsSection from '../../components/classroom/MaterialsSection';
import WorkspaceSection from '../../components/classroom/WorkspaceSection';
import ClassPasswordField from '../../components/classroom/ClassPasswordField';

const ClassDetailPage = () => {
  const { classId } = useParams<{ classId: string }>();
  const user = useCommonStore((s) => s.user);
  const navigate = useNavigate();
  const [info, setInfo] = useState<ClassInfo | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'denied'>('loading');

  useEffect(() => {
    if (!classId) return;
    setState('loading');
    fetchClass(classId)
      .then((c) => {
        if (c) {
          setInfo(c);
          setState('ok');
        } else {
          setState('denied');
        }
      })
      .catch(() => setState('denied'));
  }, [classId]);

  if (!user) return <div style={{ padding: 24 }}>Please sign in.</div>;
  if (state === 'loading')
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    );
  if (state === 'denied' || !info || !classId)
    return (
      <div style={{ padding: 24 }}>
        <Button type="link" icon={<ArrowLeftOutlined />} onClick={() => navigate('/classroom')}>
          My Classes
        </Button>
        <div style={{ marginTop: 16 }}>You don't have access to this class, or it doesn't exist.</div>
      </div>
    );

  const isTeacher = info.teacherUid === user.id;

  const handleCopyToWorkspace = (material: ShowcaseItem) =>
    copyMaterialToWorkspace(classId, user, material)
      .then(() => message.success('Copied to your workspace — edit it there, then submit.'))
      .catch((e) => message.error((e as { message?: string }).message || 'Copy failed'));

  const classroomTab = (
    <div>
      <MaterialsSection
        classId={classId}
        user={user}
        isTeacher={isTeacher}
        onCopyToWorkspace={isTeacher ? undefined : handleCopyToWorkspace}
      />
      <Typography.Title level={5}>Assignments</Typography.Title>
      <AssignmentList classId={classId} user={user} isTeacher={isTeacher} />
      {!isTeacher && (
        <div style={{ marginTop: 24 }}>
          <WorkspaceSection classId={classId} user={user} />
        </div>
      )}
    </div>
  );

  const tabs = [
    { key: 'classroom', label: 'Classroom', children: classroomTab },
    { key: 'showcase', label: 'Showcase', children: <ShowcaseGrid classId={classId} isTeacher={isTeacher} /> },
    { key: 'roster', label: 'Roster', children: <Roster classId={classId} isTeacher={isTeacher} /> },
  ];

  return (
    <div className="classroom-page" style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <Button
        type="link"
        icon={<ArrowLeftOutlined />}
        onClick={() => navigate('/classroom')}
        style={{ paddingLeft: 0 }}
      >
        My Classes
      </Button>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          margin: '8px 0 16px',
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          {info.name} {isTeacher ? <Tag color="blue">Teacher</Tag> : <Tag>Student</Tag>}
        </Typography.Title>

        {isTeacher ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <Typography.Text>
              Class number:{' '}
              <Typography.Text strong copyable style={{ letterSpacing: 2 }}>
                {info.classNumber}
              </Typography.Text>
            </Typography.Text>
            <ClassPasswordField classId={classId} />
            <span>
              Allow joining{' '}
              <Switch
                size="small"
                defaultChecked={info.joinOpen}
                onChange={(v) => setJoinOpen(classId, v).then(() => setInfo({ ...info, joinOpen: v }))}
              />
            </span>
            <Popconfirm
              title="Delete this class?"
              description="This permanently deletes the roster, assignments, submissions and showcase, and cannot be undone."
              onConfirm={() =>
                deleteClass(classId).then(() => {
                  message.success('Class deleted');
                  navigate('/classroom');
                })
              }
              okText="Delete"
              okButtonProps={{ danger: true }}
              cancelText="Cancel"
            >
              <Button danger icon={<DeleteOutlined />}>
                Delete class
              </Button>
            </Popconfirm>
          </div>
        ) : (
          <Popconfirm
            title="Leave this class?"
            onConfirm={() =>
              leaveClass(classId, user.id).then(() => {
                message.success('Left the class');
                navigate('/classroom');
              })
            }
            okText="Leave"
            cancelText="Cancel"
          >
            <Button>Leave class</Button>
          </Popconfirm>
        )}
      </div>

      <Tabs defaultActiveKey="classroom" items={tabs} />
    </div>
  );
};

export default ClassDetailPage;
