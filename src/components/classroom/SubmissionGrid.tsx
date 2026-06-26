import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, message } from 'antd';
import { StarOutlined, FormOutlined } from '@ant-design/icons';
import Card from '../card/card';
import CardListWrapper from '../card/cardListWrapper';
import { Submission } from '../../classroom/types';
import { promoteToShowcase, subscribeSubmissions } from '../../classroom/classroomApi';
import GradeModal from './GradeModal';

interface Props {
  classId: string;
  assignmentId: string;
}

/** Teacher's live grid of all submissions for one assignment, with promote + grade actions. */
const SubmissionGrid = ({ classId, assignmentId }: Props) => {
  const navigate = useNavigate();
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [grading, setGrading] = useState<Submission | null>(null);

  useEffect(() => subscribeSubmissions(classId, assignmentId, setSubmissions), [classId, assignmentId]);

  const handlePromote = async (sub: Submission) => {
    try {
      await promoteToShowcase(classId, assignmentId, sub.studentUid);
      message.success('已精选到展示墙');
    } catch (err) {
      message.error((err as { message?: string }).message || '精选失败');
    }
  };

  if (submissions.length === 0) return <Empty description="还没有提交。" />;

  return (
    <>
      <CardListWrapper>
        {submissions.map((sub) => (
          <Card
            key={sub.studentUid}
            id={sub.expId}
            url={sub.thumbnailURL}
            displayName={sub.title}
            author={sub.studentName}
            duration={sub.duration}
            createdAt={sub.submittedAt ?? null}
            onOpen={(id) => navigate(`/experiments/${id}`)}
            menuItems={[
              { key: 'promote', label: '精选到展示墙', icon: <StarOutlined />, onClick: () => handlePromote(sub) },
              { key: 'grade', label: '评分', icon: <FormOutlined />, onClick: () => setGrading(sub) },
            ]}
          />
        ))}
      </CardListWrapper>
      {grading && (
        <GradeModal
          classId={classId}
          assignmentId={assignmentId}
          studentUid={grading.studentUid}
          studentName={grading.studentName}
          open={!!grading}
          onClose={() => setGrading(null)}
        />
      )}
    </>
  );
};

export default SubmissionGrid;
