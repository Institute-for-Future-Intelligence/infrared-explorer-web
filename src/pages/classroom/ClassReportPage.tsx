/*
 * One report a student handed in to a class, as the teacher reads it: the copy the class keeps
 * (the app's functions/src/classroom.ts ClassReportDoc), drawn by the project page's own Report
 * tab in its viewer form, under who handed it in and when. The teacher sees the report and nothing
 * of the experiment it came from (user's call 2026-11-02). Painted from the class page's cached
 * list when it was opened from there; fetched on a cold open.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Spin, Typography } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import useCommonStore from '../../stores/common';
import { ClassReport } from '../../classroom/types';
import { fetchClassReports } from '../../classroom/classroomApi';
import { cachedReports, rememberReports } from '../../classroom/reportsCache';
import ReportTab from '../../labProjects/components/ReportTab';
import Lightbox from '../../labProjects/components/Lightbox';
import type { ProjectImage } from '../../labProjects/core/types';
import { useIsMobile } from '../../hooks/useIsMobile';

const ClassReportPage = () => {
  const { classId, projectId } = useParams<{ classId: string; projectId: string }>();
  const user = useCommonStore((s) => s.user);
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [report, setReport] = useState<ClassReport | null>(
    () => (classId ? cachedReports(classId)?.find((r) => r.projectId === projectId) : null) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ image: ProjectImage; list: ProjectImage[] } | null>(null);

  useEffect(() => {
    if (report || !classId || !projectId || !user) return;
    let cancelled = false;
    fetchClassReports(classId)
      .then((list) => {
        if (cancelled) return;
        rememberReports(classId, list);
        const found = list.find((r) => r.projectId === projectId) ?? null;
        if (found) setReport(found);
        else setError('This report is no longer in the class.');
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error)?.message || 'Could not load the report.');
      });
    return () => {
      cancelled = true;
    };
  }, [classId, projectId, report, user]);

  // The Report tab reads project pictures; the copy's pictures become those (no storage path).
  const images = useMemo<ProjectImage[]>(
    () =>
      (report?.images ?? []).map((i) => ({
        id: i.id,
        kind: i.kind,
        path: '',
        mime: i.mime,
        caption: i.caption,
        url: i.url,
        at: i.at,
      })),
    [report],
  );
  const project = useMemo(
    () =>
      report
        ? { report: { title: report.title, markdown: report.markdown, at: report.writtenAt, by: report.by } }
        : null,
    [report],
  );

  if (!user) return <div style={{ padding: 24 }}>Please sign in.</div>;

  return (
    <div className="classroom-page" style={{ padding: isMobile ? '24px 12px' : 24, maxWidth: 900, margin: '0 auto' }}>
      <Button
        type="link"
        icon={<ArrowLeftOutlined />}
        onClick={() => navigate(`/classroom/${classId}`)}
        style={{ paddingLeft: 0 }}
      >
        Back to class
      </Button>
      {report && project ? (
        <>
          <div style={{ margin: '8px 0 16px' }}>
            <Typography.Text strong>{report.studentName || 'Student'}</Typography.Text>
            <div style={{ fontSize: 12, color: '#888' }}>Submitted {new Date(report.submittedAt).toLocaleString()}</div>
          </div>
          <ReportTab
            project={project}
            images={images}
            author={report.studentName || null}
            model={report.model || null}
            readOnly
            onOpenImage={(image) => setViewer({ image, list: images })}
          />
          <Lightbox image={viewer?.image ?? null} images={viewer?.list ?? []} onClose={() => setViewer(null)} />
        </>
      ) : error ? (
        <div style={{ marginTop: 16 }}>{error}</div>
      ) : (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      )}
    </div>
  );
};

export default ClassReportPage;
