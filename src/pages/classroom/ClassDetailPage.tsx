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

  if (!user) return <div style={{ padding: 24 }}>请先登录。</div>;
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
          返回我的班级
        </Button>
        <div style={{ marginTop: 16 }}>无权访问该班级，或班级不存在。</div>
      </div>
    );

  const isTeacher = info.teacherUid === user.id;

  const handleCopyToWorkspace = (material: ShowcaseItem) =>
    copyMaterialToWorkspace(classId, user, material)
      .then(() => message.success('已复制到工作区，可在“我的工作区”中修改后提交'))
      .catch((e) => message.error((e as { message?: string }).message || '复制失败'));

  const classroomTab = (
    <div>
      <MaterialsSection
        classId={classId}
        user={user}
        isTeacher={isTeacher}
        onCopyToWorkspace={isTeacher ? undefined : handleCopyToWorkspace}
      />
      <Typography.Title level={5}>作业</Typography.Title>
      <AssignmentList classId={classId} user={user} isTeacher={isTeacher} />
      {!isTeacher && (
        <div style={{ marginTop: 24 }}>
          <WorkspaceSection classId={classId} user={user} />
        </div>
      )}
    </div>
  );

  const tabs = [
    { key: 'classroom', label: '课堂', children: classroomTab },
    { key: 'showcase', label: '展示墙', children: <ShowcaseGrid classId={classId} isTeacher={isTeacher} /> },
    { key: 'roster', label: '名单', children: <Roster classId={classId} isTeacher={isTeacher} /> },
  ];

  return (
    <div className="classroom-page" style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <Button
        type="link"
        icon={<ArrowLeftOutlined />}
        onClick={() => navigate('/classroom')}
        style={{ paddingLeft: 0 }}
      >
        我的班级
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
          {info.name} {isTeacher ? <Tag color="blue">老师</Tag> : <Tag>学生</Tag>}
        </Typography.Title>

        {isTeacher ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <Typography.Text>
              班级号码：
              <Typography.Text strong copyable style={{ letterSpacing: 2 }}>
                {info.classNumber}
              </Typography.Text>
            </Typography.Text>
            <ClassPasswordField classId={classId} />
            <span>
              允许加入{' '}
              <Switch
                size="small"
                defaultChecked={info.joinOpen}
                onChange={(v) => setJoinOpen(classId, v).then(() => setInfo({ ...info, joinOpen: v }))}
              />
            </span>
            <Popconfirm
              title="删除班级？"
              description="将永久删除名单、作业、提交和展示墙，且不可恢复。"
              onConfirm={() =>
                deleteClass(classId).then(() => {
                  message.success('班级已删除');
                  navigate('/classroom');
                })
              }
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
            >
              <Button danger icon={<DeleteOutlined />}>
                删除班级
              </Button>
            </Popconfirm>
          </div>
        ) : (
          <Popconfirm
            title="退出班级？"
            onConfirm={() =>
              leaveClass(classId, user.id).then(() => {
                message.success('已退出班级');
                navigate('/classroom');
              })
            }
            okText="退出"
            cancelText="取消"
          >
            <Button>退出班级</Button>
          </Popconfirm>
        )}
      </div>

      <Tabs defaultActiveKey="classroom" items={tabs} />
    </div>
  );
};

export default ClassDetailPage;
