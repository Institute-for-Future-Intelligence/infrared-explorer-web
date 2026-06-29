import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Collapse, Empty, Popconfirm, Switch, Tag, Typography, Card, Space, message } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import useThumbnail from '../card/useThumbnail';
import { useIsMobile } from '../../hooks/useIsMobile';
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

const formatDue = (a: Assignment) => (a.dueAt?.toDate ? `Due ${a.dueAt.toDate().toLocaleString()}` : 'No due date');

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
  const isMobile = useIsMobile();
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
      <div style={{ display: 'flex', gap: 12, ...(isMobile && { flexDirection: 'column' }) }}>
        <div style={{ flex: 1 }}>
          <Space>
            <Typography.Text strong>{assignment.title}</Typography.Text>
            {!assignment.open && <Tag>Closed</Tag>}
            {isPastDue && <Tag color="red">Past due</Tag>}
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
              {grade.score != null && <Tag color="green">Score {grade.score}</Tag>}
              {grade.comment && <Typography.Text type="secondary">{grade.comment}</Typography.Text>}
            </div>
          )}
        </div>
        <div style={{ width: isMobile ? '100%' : 120, textAlign: isMobile ? 'left' : 'right' }}>
          {submission ? (
            <>
              {thumb && (
                <img
                  src={thumb}
                  onClick={() => navigate(`/experiments/${submission.expId}`)}
                  style={{
                    width: isMobile ? 'min(120px, 100%)' : 120,
                    height: 72,
                    objectFit: 'cover',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                />
              )}
              <div style={{ marginTop: 6 }}>
                <Space size={4}>
                  <Button size="small" onClick={() => setSubmitOpen(true)} disabled={submitLocked}>
                    Resubmit
                  </Button>
                  <Popconfirm
                    title="Withdraw your submission?"
                    disabled={submitLocked}
                    onConfirm={async () => {
                      await unsubmit(classId, assignment.id, user.id);
                      reload();
                    }}
                    okText="Withdraw"
                    cancelText="Cancel"
                  >
                    <Button size="small" danger type="text" disabled={submitLocked}>
                      Withdraw
                    </Button>
                  </Popconfirm>
                </Space>
              </div>
            </>
          ) : (
            <Button type="primary" size="small" onClick={() => setSubmitOpen(true)} disabled={submitLocked}>
              {isPastDue ? 'Past due' : 'Submit'}
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
            New assignment
          </Button>
        </div>
        {assignments.length === 0 ? (
          <Empty description="No assignments yet." />
        ) : (
          <Collapse
            items={assignments.map((a) => ({
              key: a.id,
              label: (
                <Space>
                  <Typography.Text strong>{a.title}</Typography.Text>
                  {!a.open && <Tag>Closed</Tag>}
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
                    checkedChildren="Open"
                    unCheckedChildren="Closed"
                    onChange={(v) => updateAssignment(classId, a.id, { open: v })}
                  />
                  <Popconfirm
                    title="Delete this assignment?"
                    description="This also deletes all submissions for this assignment."
                    onConfirm={() => {
                      deleteAssignment(classId, a.id).then(() => message.success('Deleted'));
                    }}
                    okText="Delete"
                    cancelText="Cancel"
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
  if (assignments.length === 0) return <Empty description="The teacher hasn't posted any assignments yet." />;
  return (
    <div>
      {assignments.map((a) => (
        <StudentAssignmentCard key={a.id} classId={classId} user={user} assignment={a} />
      ))}
    </div>
  );
};

export default AssignmentList;
