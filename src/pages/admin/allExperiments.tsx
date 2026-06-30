import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Button, Spin } from 'antd';
import useCommonStore from '../../stores/common';
import { isStaff } from '../../utils/staff';
import { AdminExperimentRow, listAllExperiments } from '../../services/admin';
import Card from '../../components/card/card';
import CardListWrapper from '../../components/card/cardListWrapper';
import { SUBJECT_META } from '../../components/card/subjectMeta';
import SubjectMultiFilter from '../../components/subjectMultiFilter';
import SortMenu, { SortValue, compareExperiments } from '../../components/sortMenu';
import RecencyFilter, { RecencyValue } from '../../components/recencyFilter';
import ListSearch, { matchesSearch } from '../../components/listSearch';
import BackToTop from '../../components/backToTop';
import { usePersistentState } from '../../hooks/usePersistentState';
import { ExperimentSubjects } from '../../types';

// Admin → "List All Experiments" (telelab parity: client/src/pages/clipList/recentExperiments.tsx).
// Unlike telelab — which capped non-superusers at 64 server-side — this page is staff-only, so it
// loads every experiment (all owners, all visibilities) and reveals them in pages via "More".

const INCREMENT = 64;

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

const AllExperiments = () => {
  const user = useCommonStore((state) => state.user);
  const navigate = useNavigate();
  // Optional owner scope: present when arrived via a user's "Clips" count on the All Users page.
  const { ownerId } = useParams<{ ownerId?: string }>();
  const location = useLocation();
  const [experiments, setExperiments] = useState<AdminExperimentRow[]>([]);
  const [visible, setVisible] = useState(INCREMENT);
  const [loading, setLoading] = useState(true);
  // Sort + subject + recency filters persist across visits (localStorage); the search term stays transient.
  // Multi-select subject filter; an empty array means "no filter" (show every subject).
  const [subjects, setSubjects] = usePersistentState<ExperimentSubjects[]>('admin.experiments.subjects', []);
  const [sort, setSort] = usePersistentState<SortValue>('admin.experiments.sort', 'updated');
  // "Updated within the last N days" window; 'all' = no bound. Filters on last-edit time (createdAt fallback).
  const [within, setWithin] = usePersistentState<RecencyValue>('admin.experiments.within', 'all');
  // Free-text search over the scoped list (title / author / description / subject).
  const [term, setTerm] = useState('');

  useEffect(() => {
    if (!isStaff(user)) return;
    setLoading(true);
    listAllExperiments()
      .then(setExperiments)
      .finally(() => setLoading(false));
  }, [user]);

  // Reset the page window when the scope or any filter changes (e.g. switching owners, narrowing dates, searching).
  useEffect(() => setVisible(INCREMENT), [ownerId, subjects, within, term]);

  const scoped = useMemo(
    () => (ownerId ? experiments.filter((e) => e.ownerId === ownerId) : experiments),
    [experiments, ownerId],
  );

  // Subject chips to offer: only the disciplines actually present in the scoped list, in the fixed
  // badge order — so an empty "Biology" filter never shows when nothing is tagged Biology.
  const availableSubjects = useMemo(() => {
    const present = new Set(
      scoped.map((s) => s.subject).filter((s): s is ExperimentSubjects => !!s && !!SUBJECT_META[s]),
    );
    return SUBJECT_ORDER.filter((s) => present.has(s));
  }, [scoped]);

  // Last-edit time used by the "updated within" window — falls back to createdAt for legacy/un-edited
  // docs, mirroring the "Recently updated" sort so the filter and that order agree.
  const updatedMillis = (e: AdminExperimentRow) => (e.updatedAt ?? e.createdAt)?.toMillis?.() ?? 0;

  // Earliest update time to keep: "updated within N days" → now − N days. 'all' leaves it open.
  const sinceMs = within === 'all' ? null : Date.now() - within * 24 * 60 * 60 * 1000;

  // Apply the subject + recency + search filters, then sort client-side, mirroring the home grid's ordering options.
  const sorted = useMemo(
    () =>
      scoped
        .filter((e) => subjects.length === 0 || (!!e.subject && subjects.includes(e.subject)))
        .filter((e) => sinceMs === null || updatedMillis(e) >= sinceMs)
        .filter((e) => matchesSearch(e, term))
        .sort(compareExperiments(sort)),
    [scoped, subjects, sort, sinceMs, term],
  );

  // Owner's name for the header: prefer the name passed via navigation state (we already had it in
  // the Users table), then fall back to an experiment's author, then the raw id.
  const ownerName = (location.state as { displayName?: string } | null)?.displayName || scoped[0]?.author || ownerId;

  if (!isStaff(user)) return <div style={{ padding: 24 }}>You do not have access to this page.</div>;

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  const total = sorted.length;
  const shown = sorted.slice(0, visible);
  const hasMore = visible < total;

  const countText = ownerId
    ? total > 0
      ? `${ownerName} has ${total} experiment${total === 1 ? '' : 's'}.`
      : `${ownerName} has no experiments.`
    : total > 0
      ? `We found ${total} experiments.`
      : 'No experiments found.';

  return (
    <div>
      {/* Sort + subject chips on the far left (aligned with the card grid's inset), count on the same row. */}
      <div className="experiment-filters">
        <SortMenu value={sort} onChange={setSort} />
        <RecencyFilter value={within} onChange={setWithin} />
        {availableSubjects.length > 0 && (
          <SubjectMultiFilter value={subjects} subjects={availableSubjects} onChange={setSubjects} />
        )}
        <span style={{ fontStyle: 'italic' }}>{countText}</span>
        <ListSearch value={term} onChange={setTerm} />
      </div>

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
            createdAt={exp.createdAt}
            updatedAt={exp.updatedAt}
            duration={exp.duration}
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

      <BackToTop />
    </div>
  );
};

export default AllExperiments;
