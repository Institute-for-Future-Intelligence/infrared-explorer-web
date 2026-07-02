import { Divider, Tabs, TabsProps } from 'antd';
import { useEffect, useState } from 'react';
import Description from './description';
import { Experiment, ExperimentType } from '../../../types';
import CommentList from './commentList';
import RelatedList from './relatedList';
import AiReport from './aiReport';
import QaPanel from './qaPanel';
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
  const isRecording = experiment.sourceType === ExperimentType.Recording;

  // The active tab is controlled so the player can request a jump to it (below).
  // Player -> here: a right-click "Ask about this moment" jumps to the Analysis tab so the new chip shows.
  const openAnalysisTabRequest = useCommonStore((state) => state.openAnalysisTabRequest);
  const [activeKey, setActiveKey] = useState('1');

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
              {/* orientationMargin 0 flushes the label to the left edge so it lines up with the
                  comment avatars below it. The font styles go on a span around the text (not the
                  Divider's style prop, which targets the root, not antd's .ant-divider-inner-text). */}
              <Divider orientation="left" orientationMargin={0}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>
                  {commentCount > 0 ? `Comments (${commentCount})` : 'Comments'}
                </span>
              </Divider>
              <CommentList commentIds={experiment.commentsId} onCountChange={setLiveCount} />
            </>
          )}
        </>
      ),
    },
  ];

  // AI tabs: restricted to intofuture.org staff (server enforces the same). The free-form Q&A ("Ask
  // AI") shows for ANY staff on a recording experiment — a non-owner's thread lives only in their
  // browser (localStorage), never uploaded. The whole-clip report ("AI Report") stays owner-or-has-
  // report. Both keyed by id so switching experiments resets each panel.
  if (staff && isRecording) {
    items.push({
      key: '5',
      label: 'Ask AI',
      children: <QaPanel key={experiment.id} experiment={experiment} />,
    });
  }
  if (staff && (isOwner || experiment.aiReport)) {
    items.push({
      key: '4',
      label: 'AI Report',
      children: <AiReport key={experiment.id} experiment={experiment} />,
    });
  }

  items.push({
    key: '3',
    label: 'Related',
    // Keyed by id so navigating between experiments refetches the related list for the new one.
    children: <RelatedList key={experiment.id} experiment={experiment} />,
  });

  // Clamp to a tab that still exists — navigating to an experiment without the Analysis/AI Report tab
  // while it was selected falls back to Description.
  const effectiveKey = (items ?? []).some((i) => i.key === activeKey) ? activeKey : '1';
  // Jump to the Analysis tab when the player requests it (right-click "Ask about this moment"), but only
  // if that tab exists for this viewer. Keyed on the request object so each nonce bump fires once.
  useEffect(() => {
    if (openAnalysisTabRequest && items.some((i) => i?.key === '5')) setActiveKey('5');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAnalysisTabRequest]);

  // info-tabs: CSS (App.css) makes the tabs fill the panel height so a tab's content (the Q&A panel)
  // can stretch to the bottom instead of leaving dead space.
  return <Tabs activeKey={effectiveKey} onChange={setActiveKey} items={items} className="info-tabs" />;
};

export default InfoSection;
