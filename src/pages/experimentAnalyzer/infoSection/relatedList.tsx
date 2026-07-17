import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { CalendarOutlined, ClockCircleOutlined, EyeOutlined, StarFilled } from '@ant-design/icons';
import { Empty, Spin } from 'antd';
import styled from 'styled-components';
import { firebaseDatabase } from '../../../services/firebase';
import { Experiment, ExperimentDoc, ExperimentSubjects } from '../../../types';
import { SUBJECT_META } from '../../../components/card/subjectMeta';
import useThumbnail from '../../../components/card/useThumbnail';
import { formatDuration } from '../../../utils/helpers';

type RelatedCard = ExperimentDoc & { id: string };

interface Props {
  experiment: Experiment;
}

// How many rows to fetch/rank, how deep into the recent-public pool to look, and how many to reveal at
// a time (5 shown by default, "Show more" reveals another 5).
const MAX_RELATED = 15;
const POOL_LIMIT = 60;
const RELATED_PAGE = 5;

// A subject only counts as a relatedness signal when it's a real discipline — the "not available"
// placeholder must not make two unclassified experiments look related to each other.
const realSubject = (s?: ExperimentSubjects | null) => (s && s !== ExperimentSubjects.NA ? s : null);

// Relevance score. A clip of the same recording is the strongest signal, then same subject, then
// same author; the signals stack, so e.g. same-subject-and-author outranks either one alone.
const scoreOf = (cand: RelatedCard, exp: Experiment) => {
  let score = 0;
  if (exp.recordingId && cand.recordingId === exp.recordingId) score += 4;
  const subject = realSubject(exp.subject);
  if (subject && realSubject(cand.subject) === subject) score += 2;
  if (exp.author && cand.author === exp.author) score += 1;
  return score;
};

/** Creation time in ms for sorting; legacy docs without createdAt sort last (treated as oldest). */
const timeOf = (c: RelatedCard) => (c.createdAt?.toMillis ? c.createdAt.toMillis() : 0);

/** Strip any HTML a denormalized title might carry, so the row shows plain text. */
const extractText = (html: string) => html.replace(/<[^>]*>/g, '');

const Row = styled.div`
  display: flex;
  gap: 10px;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
  &:hover {
    background: rgba(0, 0, 0, 0.04);
  }
`;

const Thumb = styled.div`
  flex: 0 0 112px;
  width: 112px;
  height: 70px;
  border-radius: 6px;
  overflow: hidden;
  background: #000;
`;

const Title = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: #000;
  line-height: 18px;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
`;

const SubLine = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #888;
`;

const Meta = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  color: #888;
`;

const SubjectChip = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.06);
  color: #555;
`;

// Full-width "Show more" affordance under the list; subtle until hovered.
const ShowMore = styled.button`
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--ifi-teal-dark, #1677ff);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
  &:hover {
    background: rgba(0, 0, 0, 0.05);
  }
`;

const RelatedRow = ({ item, onOpen }: { item: RelatedCard; onOpen: (id: string) => void }) => {
  const dataURL = useThumbnail(item.thumbnailURL);
  const ratingAvg = item.ratingCount ? item.ratingSum / item.ratingCount : 0;
  const created = item.createdAt?.toDate ? item.createdAt.toDate().toLocaleDateString() : '';
  const subjectMeta = item.subject ? SUBJECT_META[item.subject] : undefined;

  return (
    <Row onClick={() => onOpen(item.id)}>
      <Thumb>
        {dataURL && (
          <img
            src={dataURL}
            alt={extractText(item.displayName)}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        )}
      </Thumb>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Title>{extractText(item.displayName)}</Title>

        {(subjectMeta || item.author) && (
          <SubLine>
            {subjectMeta && (
              <SubjectChip>
                <span>{subjectMeta.icon}</span>
                {subjectMeta.label}
              </SubjectChip>
            )}
            {item.author && <span>by {item.author}</span>}
          </SubLine>
        )}

        <Meta>
          {created && (
            <span title="Created">
              <CalendarOutlined /> {created}
            </span>
          )}
          <span title="Length">
            <ClockCircleOutlined /> {formatDuration(item.duration)}
          </span>
          <span title="Views">
            <EyeOutlined /> {item.viewCount ?? 0}
          </span>
          <span title="Rating">
            <StarFilled style={{ color: 'var(--ifi-heat)' }} /> {item.ratingCount ? ratingAvg.toFixed(1) : '–'}
          </span>
        </Meta>
      </div>
    </Row>
  );
};

const RelatedList = ({ experiment }: Props) => {
  const navigate = useNavigate();
  const [items, setItems] = useState<RelatedCard[]>([]);
  const [loading, setLoading] = useState(true);
  // How many rows are revealed; starts at one page and grows by RELATED_PAGE on "Show more".
  const [visibleCount, setVisibleCount] = useState(RELATED_PAGE);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setVisibleCount(RELATED_PAGE); // collapse back to the first page when switching experiments

    // Recent public pool — used to rank by subject / author and, when nothing genuinely related
    // exists, to backfill. Reuses the deployed (visibility, trash, createdAt) index.
    const poolQuery: Promise<RelatedCard[]> = getDocs(
      query(
        collection(firebaseDatabase, 'experiments'),
        where('visibility', '==', 'public'),
        where('trash', '==', false),
        orderBy('createdAt', 'desc'),
        limit(POOL_LIMIT),
      ),
    )
      .then((snap) => snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id })))
      .catch(() => []);

    // Sibling clips of the same recording are usually unlisted (clones default to unlisted), so the
    // public-only pool can't surface them — query them explicitly via the deployed (recordingId,
    // visibility) index. Trash is filtered client-side below.
    const siblingQuery: Promise<RelatedCard[]> = experiment.recordingId
      ? getDocs(
          query(
            collection(firebaseDatabase, 'experiments'),
            where('recordingId', '==', experiment.recordingId),
            where('visibility', 'in', ['public', 'unlisted']),
          ),
        )
          .then((snap) => snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id })))
          .catch(() => [])
      : Promise.resolve([]);

    Promise.all([siblingQuery, poolQuery]).then(([siblings, pool]) => {
      if (cancelled) return;
      // Merge + dedupe by id, dropping self and trash.
      const byId = new Map<string, RelatedCard>();
      [...siblings, ...pool].forEach((c) => {
        if (c.id !== experiment.id && !c.trash) byId.set(c.id, c);
      });
      // Relevance decides which experiments count as related; creation time decides their order.
      const scored = [...byId.values()].map((c) => ({ c, score: scoreOf(c, experiment) }));
      const related = scored.filter((s) => s.score > 0).map((s) => s.c);
      // Only fall back to (unrelated) recent experiments when nothing genuinely related exists, so a
      // populated tab never pads real matches with noise.
      const list = related.length ? related : scored.map((s) => s.c);
      // Newest first by creation time (consistent with the rest of the app's createdAt-desc ordering).
      list.sort((a, b) => timeOf(b) - timeOf(a));
      setItems(list.slice(0, MAX_RELATED));
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [experiment.id]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
        <Spin />
      </div>
    );
  }

  if (!items.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No related experiments yet." />;
  }

  return (
    <div>
      {items.slice(0, visibleCount).map((item) => (
        <RelatedRow key={item.id} item={item} onOpen={(id) => navigate(`/experiments/${id}`)} />
      ))}
      {visibleCount < items.length && (
        <ShowMore type="button" onClick={() => setVisibleCount((c) => c + RELATED_PAGE)}>
          Show more
        </ShowMore>
      )}
    </div>
  );
};

export default RelatedList;
