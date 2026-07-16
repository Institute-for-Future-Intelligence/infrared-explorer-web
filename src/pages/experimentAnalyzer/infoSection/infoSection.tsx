import { Divider } from 'antd';
import { useState } from 'react';
import { Experiment } from '../../../types';
import CommentList from './commentList';
import RelatedList from './relatedList';

interface InfoSectionProps {
  experiment: Experiment;
}

// The analyzer's below-the-fold content: the comment thread (left) and related experiments (right) side
// by side. The experiment's identity (title + subject), its description, and its engagement stats
// (views / rating) all live in the workspace beside the player, so only this genuinely secondary
// social / discovery content sits below the fold. `#comments` anchors the footer's scroll jump here.
const InfoSection = ({ experiment }: InfoSectionProps) => {
  // Initial count from the load-time snapshot; CommentList reports live changes (add/delete/reply).
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const commentCount = liveCount ?? (experiment.commentsId ? experiment.commentsId.length : 0);

  return (
    <div className="analyzer-info">
      <div className="analyzer-info-cols">
        <section id="comments" className="analyzer-comments">
          {/* orientationMargin 0 flushes the label to the left edge so it lines up with the avatars. */}
          <Divider orientation="left" orientationMargin={0}>
            <span style={{ fontSize: 18, fontWeight: 700 }}>
              {commentCount > 0 ? `Comments (${commentCount})` : 'Comments'}
            </span>
          </Divider>
          <CommentList commentIds={experiment.commentsId ?? []} onCountChange={setLiveCount} />
        </section>

        <aside className="analyzer-related">
          <Divider orientation="left" orientationMargin={0}>
            <span style={{ fontSize: 18, fontWeight: 700 }}>Related</span>
          </Divider>
          <RelatedList experiment={experiment} />
        </aside>
      </div>
    </div>
  );
};

export default InfoSection;
