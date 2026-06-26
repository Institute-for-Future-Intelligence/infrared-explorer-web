import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Collapse, Empty, Popconfirm, Switch, Tag, Typography, Card, Space, message } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import useThumbnail from '../card/useThumbnail';
import { Assignment, Grade, Submission } from '../../classroom/types';
import { User } from '../../types';
import {
  deleteAssignment,
  fetchGrade,
  fetchMySubmission,
  subscribeAssignments,
  unsubmit,
  updateAssignment,
} from '../../classroom/classroomApi';
import SubmissionGrid from './SubmissionGrid';
import CreateAssignmentModal from './CreateAssignmentModal';
import SubmitToAssignmentModal from './SubmitToAssignmentModal';

interface Props {
  classId: string;
  user: User;
  isTeacher: boolean;
}

const formatDue = (a: Assignment) => (a.dueAt?.toDate ? `截止 ${a.dueAt.toDate().toLocaleString()}` : '无截止');

/** One student-facing assignment card: shows their submission status + submit/withdraw. */
const StudentAssignmentCard = ({
  classId,
  user,
  assignment,
}: {
  classId: string;
  user: User;
  assignment: Assignment;
}) => {
  const navigate = useNavigate();
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [grade, setGrade] = useState<Grade | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const thumb = useThumbnail(submission?.thumbnailURL ?? '');

  const reload = useCallback(async () => {
    const [sub, g] = await Promise.all([
      fetchMySubmission(classId, assignment.id, user.id),
      fetchGrade(classId, assignment.id, user.id),
    ]);
    setSubmission(sub);
    setGrade(g);
  }, [classId, assignment.id, user.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Past-due assignments are locked: no (re)submit, no withdraw.
  const isPastDue = !!assignment.dueAt?.toDate && assignment.dueAt.toDate().getTime() < Date.now();
  const submitLocked = !assignment.open || isPastDue;

  return (
    <Card size="small" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <Space>
            <Typography.Text strong>{assignment.title}</Typography.Text>
            {!assignment.open && <Tag>已关闭</Tag>}
            {isPastDue && <Tag color="red">已截止</Tag>}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatDue(assignment)}
            </Typography.Text>
          </Space>
          {assignment.description && (
            <Typography.Paragraph type="secondary" style={{ fontSize: 13, margin: '6px 0 0' }}>
              {assignment.description}
            </Typography.Paragraph>
          )}
          {grade && (grade.score != null || grade.comment) && (
            <div style={{ marginTop: 6, fontSize: 13 }}>
              {grade.score != null && <Tag color="green">得分 {grade.score}</Tag>}
              {grade.comment && <Typography.Text type="secondary">{grade.comment}</Typography.Text>}
            </div>
          )}
        </div>
        <div style={{ width: 120, textAlign: 'right' }}>
          {submission ? (
            <>
              {thumb && (
                <img
                  src={thumb}
                  onClick={() => navigate(`/experiments/${submission.expId}`)}
                  style={{ width: 120, height: 72, objectFit: 'cover', borderRadius: 4, cursor: 'pointer' }}
                />
              )}
              <div style={{ marginTop: 6 }}>
                <Space size={4}>
                  <Button size="small" onClick={() => setSubmitOpen(true)} disabled={submitLocked}>
                    重新提交
                  </Button>
                  <Popconfirm
                    title="撤回提交？"
                    disabled={submitLocked}
                    onConfirm={async () => {
                      await unsubmit(classId, assignment.id, user.id);
                      reload();
                    }}
                    okText="撤回"
                    cancelText="取消"
                  >
                    <Button size="small" danger type="text" disabled={submitLocked}>
                      撤回
                    </Button>
                  </Popconfirm>
                </Space>
              </div>
            </>
          ) : (
            <Button type="primary" size="small" onClick={() => setSubmitOpen(true)} disabled={submitLocked}>
              {isPastDue ? '已截止' : '提交'}
            </Button>
          )}
        </div>
      </div>
      <SubmitToAssignmentModal
        classId={classId}
        assignmentId={assignment.id}
        assignmentTitle={assignment.title}
        user={user}
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onSubmitted={reload}
      />
    </Card>
  );
};

const AssignmentList = ({ classId, user, isTeacher }: Props) => {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => subscribeAssignments(classId, setAssignments), [classId]);

  if (isTeacher) {
    return (
      <>
        <div style={{ marginBottom: 12 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建作业
          </Button>
        </div>
        {assignments.length === 0 ? (
          <Empty description="还没有作业。" />
        ) : (
          <Collapse
            items={assignments.map((a) => ({
              key: a.id,
              label: (
                <Space>
                  <Typography.Text strong>{a.title}</Typography.Text>
                  {!a.open && <Tag>已关闭</Tag>}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {formatDue(a)}
                  </Typography.Text>
                </Space>
              ),
              extra: (
                <Space onClick={(e) => e.stopPropagation()}>
                  <Switch
                    size="small"
                    checked={a.open}
                    checkedChildren="收"
                    unCheckedChildren="停"
                    onChange={(v) => updateAssignment(classId, a.id, { open: v })}
                  />
                  <Popconfirm
                    title="删除作业？"
                    description="将一并删除该作业下的所有提交。"
                    onConfirm={() => {
                      deleteAssignment(classId, a.id).then(() => message.success('已删除'));
                    }}
                    okText="删除"
                    cancelText="取消"
                  >
                    <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ),
              children: (
                <>
                  {a.description && (
                    <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
                      {a.description}
                    </Typography.Paragraph>
                  )}
                  <SubmissionGrid classId={classId} assignmentId={a.id} />
                </>
              ),
            }))}
          />
        )}
        <CreateAssignmentModal classId={classId} open={createOpen} onClose={() => setCreateOpen(false)} />
      </>
    );
  }

  // Student view
  if (assignments.length === 0) return <Empty description="老师还没有布置作业。" />;
  return (
    <div>
      {assignments.map((a) => (
        <StudentAssignmentCard key={a.id} classId={classId} user={user} assignment={a} />
      ))}
    </div>
  );
};

export default AssignmentList;
