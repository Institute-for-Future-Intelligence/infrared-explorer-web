import { Divider, Tabs, TabsProps } from 'antd';
import { useState } from 'react';
import Description from './description';
import { Experiment } from '../../../types';
import CommentList from './commentList';
import RelatedList from './relatedList';
import AiReport from './aiReport';
import useCommonStore from '../../../stores/common';
import { isStaff } from '../../../utils/staff';

interface InfoSectionProps {
  experiment: Experiment;
}

const InfoSection = ({ experiment }: InfoSectionProps) => {
  // Initial count from the load-time snapshot; CommentList reports live changes (add/delete/reply).
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const commentCount = liveCount ?? (experiment.commentsId ? experiment.commentsId.length : 0);

  const user = useCommonStore((state) => state.user);
  const isOwner = !!user && user.id === experiment.ownerId;
  const staff = isStaff(user);

  const items: TabsProps['items'] = [
    {
      key: '1',
      label: 'Description',
      // Comments are merged under the description (no separate Comments tab); the count moves
      // into the divider heading that introduces the comment thread.
      children: (
        <>
          <Description experiment={experiment} />
          {experiment.commentsId && (
            <>
              <Divider orientation="left" style={{ fontSize: 14 }}>
                {commentCount > 0 ? `Comments (${commentCount})` : 'Comments'}
              </Divider>
              <CommentList commentIds={experiment.commentsId} onCountChange={setLiveCount} />
            </>
          )}
        </>
      ),
    },
  ];

  // AI report tab: restricted to intofuture.org staff (server enforces the same). Staff can generate
  // on their own experiments; any experiment that already has a report shows it.
  if (staff && (isOwner || experiment.aiReport)) {
    items.push({
      key: '4',
      label: 'AI Report',
      // Keyed by id so switching experiments resets the panel to the new one's report.
      children: <AiReport key={experiment.id} experiment={experiment} />,
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
