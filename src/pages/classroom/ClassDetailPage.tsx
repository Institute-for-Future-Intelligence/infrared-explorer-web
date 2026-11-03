/*
 * One class, as its teacher sees it (the minimal classroom, 2026-11-02): the name, the class
 * number, the join password, whether students may still join, the ⋮ with the rest (share the join
 * info, change the password, rename, delete — ClassActionsMenu), and the reports students handed
 * in, each opening on its own page. No roster, no materials, no assignments: the member count on
 * the My Classes card is all the teacher sees of who joined. A student never lands here.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Empty, List, Spin, Switch, Typography, message } from 'antd';
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import useCommonStore from '../../stores/common';
import { ClassInfo, ClassReport } from '../../classroom/types';
import { fetchClass, fetchClassReports, setJoinOpen } from '../../classroom/classroomApi';
import { cachedReports, forgetReports, rememberReports } from '../../classroom/reportsCache';
import ClassActionsMenu from '../../components/classroom/ClassActionsMenu';
import ClassPasswordField from '../../components/classroom/ClassPasswordField';
import { useIsMobile } from '../../hooks/useIsMobile';

const ClassDetailPage = () => {
  const { classId } = useParams<{ classId: string }>();
  const user = useCommonStore((s) => s.user);
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [info, setInfo] = useState<ClassInfo | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'denied'>('loading');
  const [reports, setReports] = useState<ClassReport[] | null>(classId ? cachedReports(classId) : null);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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

  const isTeacher = !!info && !!user && info.teacherUid === user.id;

  const loadReports = useCallback(async () => {
    if (!classId) return;
    setRefreshing(true);
    try {
      const list = await fetchClassReports(classId);
      setReports(list);
      setReportsError(null);
      rememberReports(classId, list);
    } catch (e) {
      setReportsError((e as Error)?.message || 'Could not load the reports.');
      setReports((prev) => prev ?? []);
    } finally {
      setRefreshing(false);
    }
  }, [classId]);

  useEffect(() => {
    if (isTeacher) loadReports();
  }, [isTeacher, loadReports]);

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
  if (!isTeacher)
    return (
      <div style={{ padding: 24 }}>
        <Button type="link" icon={<ArrowLeftOutlined />} onClick={() => navigate('/classroom')}>
          My Classes
        </Button>
        <div style={{ marginTop: 16 }}>Only the teacher of this class can open it here.</div>
      </div>
    );

  return (
    <div className="classroom-page" style={{ padding: isMobile ? '24px 12px' : 24, maxWidth: 1100, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          justifyContent: 'space-between',
          alignItems: isMobile ? 'flex-start' : 'center',
          gap: isMobile ? 8 : 12,
          margin: '8px 0 16px',
        }}
      >
        <Typography.Title level={3} style={{ margin: 0 }}>
          {info.name}
        </Typography.Title>
        <div
          style={{
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            alignItems: isMobile ? 'flex-start' : 'center',
            gap: isMobile ? 12 : 16,
            flexWrap: 'wrap',
          }}
        >
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
              checked={info.joinOpen}
              onChange={(v) =>
                setJoinOpen(classId, v)
                  .then(() => setInfo({ ...info, joinOpen: v }))
                  .catch((e) => message.error((e as Error)?.message || "Couldn't update."))
              }
            />
          </span>
          <ClassActionsMenu
            info={info}
            withJoining={false}
            onChanged={(p) => setInfo({ ...info, ...p })}
            onDeleted={() => {
              forgetReports(classId);
              navigate('/classroom');
            }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 24 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Reports{reports && reports.length ? ` (${reports.length})` : ''}
        </Typography.Title>
        <Button type="text" icon={<ReloadOutlined />} loading={refreshing} onClick={loadReports}>
          Refresh
        </Button>
      </div>
      {reportsError && (
        <Typography.Text type="danger" style={{ display: 'block', marginTop: 8 }}>
          {reportsError}
        </Typography.Text>
      )}
      {reports == null ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : reports.length === 0 ? (
        <Empty
          style={{ marginTop: 24 }}
          description="No reports yet. Students submit a report from an experiment's page, in the app or here."
        />
      ) : (
        <List
          style={{ marginTop: 8 }}
          dataSource={reports}
          renderItem={(r) => (
            <List.Item
              style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/classroom/${classId}/reports/${r.projectId}`)}
            >
              <List.Item.Meta
                title={r.title || 'Untitled report'}
                description={
                  <span style={{ fontSize: 12, color: '#888' }}>
                    {r.studentName || 'Student'} · {new Date(r.submittedAt).toLocaleString()}
                  </span>
                }
              />
            </List.Item>
          )}
        />
      )}
    </div>
  );
};

export default ClassDetailPage;
