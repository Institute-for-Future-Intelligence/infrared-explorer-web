import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import { ExperimentDoc, ExperimentSubjects, User } from '../types';
import useCommonStore from '../stores/common';
import OwnedExperimentGrid from '../components/card/ownedExperimentGrid';
import { SUBJECT_META } from '../components/card/subjectMeta';
import SubjectFilter, { SubjectFilterValue } from '../components/subjectFilter';
import SortMenu, { SortValue, compareExperiments } from '../components/sortMenu';
import ListSearch, { matchesSearch } from '../components/listSearch';

type ExperimentCard = ExperimentDoc & { id: string };

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

/** My untrimmed (raw) clips — isRaw === true. Trash is filtered client-side to avoid a 3-field index. */
const Raw = () => {
  const user = useCommonStore((state) => state.user);
  const [experiments, setExperiments] = useState<ExperimentCard[]>([]);
  const [subject, setSubject] = useState<SubjectFilterValue>('all');
  const [sort, setSort] = useState<SortValue>('updated');
  // Free-text search over the loaded list (title / author / description / subject).
  const [term, setTerm] = useState('');

  useEffect(() => {
    if (!user) return;
    const fetchRaw = async (user: User) => {
      const q = query(
        collection(firebaseDatabase, 'experiments'),
        where('ownerId', '==', user.id),
        where('isRaw', '==', true),
      );
      const snap = await getDocs(q);
      setExperiments(snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id })).filter((e) => !e.trash));
    };
    fetchRaw(user);
  }, [user]);

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
    </div>
  );
};

export default Raw;
