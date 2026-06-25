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

  items.push({
    key: '3',
    label: 'Related',
    // Keyed by id so navigating between experiments refetches the related list for the new one.
    children: <RelatedList key={experiment.id} experiment={experiment} />,
  });

  return <Tabs defaultActiveKey="1" items={items} />;
};

export default InfoSection;
