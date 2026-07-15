import { useMemo, useState } from 'react';
import { ExperimentSubjects } from '../types';
import useCommonStore from '../stores/common';
import OwnedExperimentGrid from '../components/card/ownedExperimentGrid';
import { SUBJECT_META } from '../components/card/subjectMeta';
import SubjectFilter, { SubjectFilterValue } from '../components/subjectFilter';
import SortMenu, { SortValue, compareExperiments } from '../components/sortMenu';
import ListSearch, { matchesSearch } from '../components/listSearch';
import BackToTop from '../components/backToTop';
import { usePersistentState } from '../hooks/usePersistentState';
import { useRawExperiments } from '../hooks/useExperimentLists';

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

/**
 * My original recordings — the raw captures from the mobile app, NOT copies (the query semantics
 * live in useRawExperiments, shared with the Me hub's row).
 */
const Raw = () => {
  const user = useCommonStore((state) => state.user);
  const { items: experiments, setItems: setExperiments } = useRawExperiments(user);
  // Sort + subject filter persist across visits (localStorage); the search term stays transient.
  const [subject, setSubject] = usePersistentState<SubjectFilterValue>('raw.subject', 'all');
  const [sort, setSort] = usePersistentState<SortValue>('raw.sort', 'updated');
  // Free-text search over the loaded list (title / author / description / subject).
  const [term, setTerm] = useState('');

  // Subject chips to offer: only the disciplines actually present in the loaded experiments, in the
  // fixed badge order — so an empty "Biology" filter never shows when nothing is tagged Biology.
  const availableSubjects = useMemo(() => {
    const present = new Set(
      experiments.map((s) => s.subject).filter((s): s is ExperimentSubjects => !!s && !!SUBJECT_META[s]),
    );
    return SUBJECT_ORDER.filter((s) => present.has(s));
  }, [experiments]);

  // Apply the subject + search filters, then sort the survivors by the chosen order. Sorting is
  // client-side over the already-loaded list. The grid's rename/trash mutations still target the full
  // `experiments` list.
  const visible = useMemo(
    () =>
      experiments
        .filter((s) => (subject === 'all' || s.subject === subject) && matchesSearch(s, term))
        .sort(compareExperiments(sort)),
    [experiments, subject, sort, term],
  );

  if (!user) return <div>Please sign in to see your raw data.</div>;

  return (
    <div className="my-experiments-page">
      <div className="home-toolbar">
        <SortMenu value={sort} onChange={setSort} />
        {availableSubjects.length > 0 && (
          <SubjectFilter value={subject} subjects={availableSubjects} onChange={setSubject} />
        )}
        <ListSearch value={term} onChange={setTerm} />
      </div>
      <OwnedExperimentGrid items={visible} setItems={setExperiments} />
      <BackToTop />
    </div>
  );
};

export default Raw;
