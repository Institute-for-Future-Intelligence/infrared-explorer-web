import { useMemo, useState } from 'react';
import useCommonStore from '../stores/common';
import ExperimentGrid from '../components/card/experimentGrid';
import { SUBJECT_META } from '../components/card/subjectMeta';
import SubjectFilter, { SubjectFilterValue } from '../components/subjectFilter';
import RecencyFilter, { RecencyValue } from '../components/recencyFilter';
import ListSearch, { matchesSearch } from '../components/listSearch';
import BackToTop from '../components/backToTop';
import { usePersistentState } from '../hooks/usePersistentState';
import { useViewHistory } from '../hooks/useExperimentLists';
import { ExperimentSubjects } from '../types';

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

const Recent = () => {
  const user = useCommonStore((state) => state.user);
  // Pull a deeper slice than we show so the recency filter has rows to work over, not just the last 24.
  const { items } = useViewHistory(user, 200);
  // Recency + subject filters persist across visits (localStorage); the search term stays transient.
  // "Viewed within the last N days" window; 'all' = no bound.
  const [within, setWithin] = usePersistentState<RecencyValue>('recent.within', 'all');
  const [subject, setSubject] = usePersistentState<SubjectFilterValue>('recent.subject', 'all');
  // Free-text search over the loaded history (title / author / description / subject).
  const [term, setTerm] = useState('');

  // Subject chips to offer: only the disciplines actually present in the history, in the fixed badge
  // order — so an empty "Biology" chip never shows when nothing viewed is tagged Biology.
  const availableSubjects = useMemo(() => {
    const present = new Set(
      items.map((s) => s.subject).filter((s): s is ExperimentSubjects => !!s && !!SUBJECT_META[s]),
    );
    return SUBJECT_ORDER.filter((s) => present.has(s));
  }, [items]);

  // Earliest view time to keep: "viewed within N days" → now − N days. 'all' leaves it open.
  const sinceMs = within === 'all' ? null : Date.now() - within * 24 * 60 * 60 * 1000;
  const shown = useMemo(
    () =>
      items
        .filter((it) => subject === 'all' || it.subject === subject)
        .filter((it) => sinceMs === null || it.viewedMs >= sinceMs)
        .filter((it) => matchesSearch(it, term)),
    [items, subject, sinceMs, term],
  );

  if (!user) return <div>Please sign in to see your recent experiments.</div>;

  return (
    <div>
      {/* Recency + subject filters aligned with the card grid's inset, matching All Experiments. */}
      <div className="experiment-filters">
        <RecencyFilter value={within} onChange={setWithin} />
        {availableSubjects.length > 0 && (
          <SubjectFilter value={subject} subjects={availableSubjects} onChange={setSubject} />
        )}
        <ListSearch value={term} onChange={setTerm} />
      </div>
      <ExperimentGrid items={shown} showUpdated />
      <BackToTop />
    </div>
  );
};

export default Recent;
