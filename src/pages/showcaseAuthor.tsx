import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Avatar as AntAvatar, Empty, Result, Spin } from 'antd';
import { collection, getDocs, query, where } from 'firebase/firestore';
import styled from 'styled-components';
import { StarFilled } from '@ant-design/icons';
import { firebaseDatabase } from '../services/firebase';
import { ExperimentDoc, ExperimentSubjects, Visibility } from '../types';
import ExperimentGrid from '../components/card/experimentGrid';
import { SUBJECT_META } from '../components/card/subjectMeta';
import SubjectFilter, { SubjectFilterValue } from '../components/subjectFilter';
import SortMenu, { SORT_OPTIONS, SortValue, compareExperiments } from '../components/sortMenu';
import ShareLinks from './experimentAnalyzer/infoSection/shareLinks';
import BackToTop from '../components/backToTop';

/*
 * Read-only showcase page for a seeded-showcase author at /showcase/authors/:author (author is the
 * URL-encoded `author` string on the experiment docs). The seeded showcases all share
 * ownerId:'system' (they have no usersPublic doc / mongoId), so a single /users/system profile would
 * mix the six different contributors under one arbitrary name. Instead we group by the author string:
 * this page lists every PUBLIC system experiment credited to one author. It's a pure gallery — no
 * identity doc, so no bio/avatar/pins/edit; the header shows the name (as an initial avatar) and the
 * aggregate view/rating stats over the listed clips.
 */

type ExperimentCard = ExperimentDoc & { id: string };

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

// A showcase gallery is finished, all-public work, so "Recently updated" and "By visibility" are
// both noise here (mirrors the user-profile gallery).
const AUTHOR_SORT_OPTIONS = SORT_OPTIONS.filter((o) => o.key !== 'updated' && o.key !== 'visibility').map((o) =>
  o.key === 'newest' ? { ...o, label: 'Newest' } : o,
);

// Iron-colormap band, echoing the thermal palette of the recordings the page showcases (matches
// the user-profile banner).
const Banner = styled.div`
  height: 76px;
  border-radius: 10px;
  background: linear-gradient(105deg, #23103f, #6b2280 32%, #b23a3f 58%, #e0662a 78%, #f4a71f 96%);
`;

const HeaderRow = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 20px;
  flex-wrap: wrap;
  padding: 0 20px;
  margin-top: -34px;
  margin-bottom: 8px;

  .profile-avatar {
    flex: none;
    border: 4px solid #fff;
    background: #6b2280;
    font-size: 34px;
  }
`;

const Info = styled.div`
  flex: 1;
  min-width: 240px;
  padding-top: 38px;

  h2 {
    margin: 0;
    font-size: 20px;
  }
  .stat-line {
    color: var(--ifi-grey, #8c8c8c);
    font-size: 13px;
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    b {
      color: var(--ifi-ink, #262626);
    }
  }
`;

const Actions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 42px;
`;

const ShowcaseAuthor = () => {
  const { author: authorParam } = useParams<{ author: string }>();
  const author = authorParam ? decodeURIComponent(authorParam) : '';

  const [experiments, setExperiments] = useState<ExperimentCard[]>([]);
  const [loading, setLoading] = useState(true);

  const [subject, setSubject] = useState<SubjectFilterValue>('all');
  const [sort, setSort] = useState<SortValue>('newest');

  useEffect(() => {
    if (!author) return;
    let cancelled = false;
    setLoading(true);
    const run = async () => {
      try {
        // Equality-only (no orderBy) so no composite index is needed and legacy docs missing
        // createdAt aren't silently dropped; the visibility == 'public' filter keeps the query
        // within what the rules allow for anonymous visitors.
        const q = query(
          collection(firebaseDatabase, 'experiments'),
          where('ownerId', '==', 'system'),
          where('author', '==', author),
          where('visibility', '==', Visibility.Public),
          where('trash', '==', false),
        );
        const snap = await getDocs(q);
        const docs = snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id }));
        docs.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
        if (!cancelled) setExperiments(docs);
      } catch (e) {
        console.error('failed to load showcase author experiments', e);
        if (!cancelled) setExperiments([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [author]);

  const totalViews = experiments.reduce((n, e) => n + (e.viewCount ?? 0), 0);
  const ratingCount = experiments.reduce((n, e) => n + (e.ratingCount ?? 0), 0);
  const ratingAvg = ratingCount ? experiments.reduce((n, e) => n + (e.ratingSum ?? 0), 0) / ratingCount : 0;

  const availableSubjects = useMemo(() => {
    const present = new Set(
      experiments.map((s) => s.subject).filter((s): s is ExperimentSubjects => !!s && !!SUBJECT_META[s]),
    );
    return SUBJECT_ORDER.filter((s) => present.has(s));
  }, [experiments]);

  const visible = useMemo(
    () => experiments.filter((s) => subject === 'all' || s.subject === subject).sort(compareExperiments(sort)),
    [experiments, subject, sort],
  );

  if (!author) return null;

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (experiments.length === 0) {
    return (
      <Result
        status="404"
        title="Author not found"
        subTitle="No public showcases are credited to this author."
        extra={<Link to="/">Back to home</Link>}
      />
    );
  }

  const initial = author.trim().charAt(0).toUpperCase();

  return (
    <div className="user-profile-page">
      <Banner />
      <HeaderRow>
        <AntAvatar className="profile-avatar" size={88}>
          {initial}
        </AntAvatar>
        <Info>
          <h2>{author}</h2>
          <div className="stat-line">
            <span>
              <b>{experiments.length}</b> showcase{experiments.length === 1 ? '' : 's'}
            </span>
            {totalViews > 0 && (
              <span>
                <b>{totalViews}</b> view{totalViews === 1 ? '' : 's'}
              </span>
            )}
            {ratingCount > 0 && (
              <span>
                <StarFilled style={{ color: '#fadb14' }} /> <b>{ratingAvg.toFixed(1)}</b> ({ratingCount} rating
                {ratingCount === 1 ? '' : 's'})
              </span>
            )}
          </div>
        </Info>
        <Actions>
          <ShareLinks title={`${author} on Infrared Explorer`} />
        </Actions>
      </HeaderRow>

      {visible.length === 0 ? (
        <Empty style={{ marginTop: 48 }} description="No showcases match this filter." />
      ) : (
        <>
          <div className="home-toolbar">
            <SortMenu value={sort} onChange={setSort} options={AUTHOR_SORT_OPTIONS} />
            {availableSubjects.length > 0 && (
              <SubjectFilter value={subject} subjects={availableSubjects} onChange={setSubject} />
            )}
          </div>
          {/* showAuthor off: every card here is by the same person, so the credit is redundant. */}
          <ExperimentGrid items={visible} showAuthor={false} />
        </>
      )}

      <BackToTop />
    </div>
  );
};

export default ShowcaseAuthor;
