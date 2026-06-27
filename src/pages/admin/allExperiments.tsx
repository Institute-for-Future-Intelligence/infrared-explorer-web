import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Spin } from 'antd';
import useCommonStore from '../../stores/common';
import { isStaff } from '../../utils/staff';
import { AdminExperimentRow, listAllExperiments } from '../../services/admin';
import Card from '../../components/card/card';
import CardListWrapper from '../../components/card/cardListWrapper';

// Admin → "List All Experiments" (telelab parity: client/src/pages/clipList/recentExperiments.tsx).
// Unlike telelab — which capped non-superusers at 64 server-side — this page is staff-only, so it
// loads every experiment (all owners, all visibilities) and reveals them in pages via "More".

const INCREMENT = 64;

const AllExperiments = () => {
  const user = useCommonStore((state) => state.user);
  const navigate = useNavigate();
  const [experiments, setExperiments] = useState<AdminExperimentRow[]>([]);
  const [visible, setVisible] = useState(INCREMENT);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isStaff(user)) return;
    setLoading(true);
    listAllExperiments()
      .then(setExperiments)
      .finally(() => setLoading(false));
  }, [user]);

  if (!isStaff(user)) return <div style={{ padding: 24 }}>You do not have access to this page.</div>;

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  const total = experiments.length;
  const shown = experiments.slice(0, visible);
  const hasMore = visible < total;

  return (
    <div>
      <p style={{ textAlign: 'center', fontStyle: 'italic', marginTop: 8 }}>
        {total > 0 ? `We found ${total} experiments.` : 'No experiments found.'}
      </p>

      <CardListWrapper>
        {shown.map((exp) => (
          <Card
            key={exp.id}
            id={exp.id}
            url={exp.thumbnailURL}
            displayName={exp.displayName}
            subject={exp.subject}
            author={exp.author}
            description={exp.description}
            ratingSum={exp.ratingSum}
            ratingCount={exp.ratingCount}
            viewCount={exp.viewCount}
            commentCount={exp.commentCount}
            onOpen={(id) => navigate(`/experiments/${id}`)}
          />
        ))}
      </CardListWrapper>

      {hasMore && (
        <div style={{ textAlign: 'center', margin: '12px 0 24px' }}>
          <Button type="primary" onClick={() => setVisible((v) => v + INCREMENT)}>
            More
          </Button>
        </div>
      )}
    </div>
  );
};

export default AllExperiments;
