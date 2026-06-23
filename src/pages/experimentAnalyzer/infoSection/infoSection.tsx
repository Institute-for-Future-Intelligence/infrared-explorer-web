import { Tabs, TabsProps } from 'antd';
import { useState } from 'react';
import Description from './description';
import { Experiment } from '../../../types';
import CommentList from './commentList';
import RelatedList from './relatedList';

interface InfoSectionProps {
  experiment: Experiment;
}

const InfoSection = ({ experiment }: InfoSectionProps) => {
  // Initial count from the load-time snapshot; CommentList reports live changes (add/delete/reply).
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const commentCount = liveCount ?? (experiment.commentsId ? experiment.commentsId.length : 0);

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
      children: <CommentList commentIds={experiment.commentsId} onCountChange={setLiveCount} />,
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
