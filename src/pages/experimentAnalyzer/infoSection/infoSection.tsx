import { Tabs, TabsProps } from 'antd';
import Description from './description';
import { Experiment } from '../../../types';
import CommentList from './commentList';
import RelatedList from './relatedList';

interface InfoSectionProps {
  experiment: Experiment;
}

const InfoSection = ({ experiment }: InfoSectionProps) => {
  const commentCount = experiment.commentsId ? experiment.commentsId.length : 0;

  const items: TabsProps['items'] = [
    {
      key: '1',
      label: 'Description',
      children: <Description experiment={experiment} />,
    },
  ];

  if (experiment.commentsId) {
    items.push({
      key: '2',
      label: 'Comment' + (commentCount > 0 ? `s(${commentCount})` : ''),
      children: <CommentList commentIds={experiment.commentsId} />,
    });
  }

  if (experiment.recordingId) {
    items.push({
      key: '3',
      label: 'Related',
      children: <RelatedList recordingId={experiment.recordingId} currentId={experiment.id} />,
    });
  }

  return <Tabs defaultActiveKey="1" items={items} />;
};

export default InfoSection;
