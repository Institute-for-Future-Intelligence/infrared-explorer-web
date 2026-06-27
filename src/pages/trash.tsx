import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, message } from 'antd';
import type { MenuProps } from 'antd';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import { ExperimentDoc, ExperimentSubjects } from '../types';
import useCommonStore from '../stores/common';
import { deleteExperiment, setTrash } from '../services/experiments';
import ExperimentGrid, { GridItem } from '../components/card/experimentGrid';
import { SUBJECT_META } from '../components/card/subjectMeta';
import SubjectFilter, { SubjectFilterValue } from '../components/subjectFilter';
import SortMenu, { SortValue, compareExperiments } from '../components/sortMenu';
import ListSearch, { matchesSearch } from '../components/listSearch';
import BackToTop from '../components/backToTop';

type TrashedExperiment = ExperimentDoc & { id: string };

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

const Trash = () => {
  const user = useCommonStore((state) => state.user);
  const [items, setItems] = useState<TrashedExperiment[]>([]);
  const [subject, setSubject] = useState<SubjectFilterValue>('all');
  const [sort, setSort] = useState<SortValue>('updated');
  // Free-text search over the loaded list (title / author / description / subject).
  const [term, setTerm] = useState('');

  const fetchTrash = useCallback(async (uid: string) => {
    const q = query(
      collection(firebaseDatabase, 'experiments'),
      where('ownerId', '==', uid),
      where('trash', '==', true),
    );
    const snap = await getDocs(q);
    setItems(snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id })));
  }, []);

  useEffect(() => {
    if (user) fetchTrash(user.id);
  }, [user, fetchTrash]);

  const restore = async (id: string) => {
    try {
      await setTrash(id, false);
      setItems((prev) => prev.filter((i) => i.id !== id));
      message.success('Restored');
    } catch (err) {
      console.error('failed to restore', err);
      message.error('Failed to restore');
    }
  };

  const removeForever = (id: string) =>
    Modal.confirm({
      title: 'Delete this forever?',
      content: 'This cannot be undone.',
      okText: 'Delete forever',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await deleteExperiment(id);
          setItems((prev) => prev.filter((i) => i.id !== id));
          message.success('Deleted');
        } catch (err) {
          console.error('failed to delete', err);
          message.error('Failed to delete');
        }
      },
    });

  const buildMenu = (item: GridItem): MenuProps['items'] => [
    { key: 'restore', label: 'Restore', onClick: () => restore(item.id) },
    { type: 'divider' },
    { key: 'delete', label: 'Delete forever', danger: true, onClick: () => removeForever(item.id) },
  ];

  // Subject chips to offer: only the disciplines actually present in the loaded items, in the fixed
  // badge order — so an empty "Biology" filter never shows when nothing is tagged Biology.
  const availableSubjects = useMemo(() => {
    const present = new Set(
      items.map((s) => s.subject).filter((s): s is ExperimentSubjects => !!s && !!SUBJECT_META[s]),
    );
    return SUBJECT_ORDER.filter((s) => present.has(s));
  }, [items]);

  // Apply the subject + search filters, then sort client-side. Restore/delete mutations still target `items`.
  const visible = useMemo(
    () =>
      items
        .filter((s) => (subject === 'all' || s.subject === subject) && matchesSearch(s, term))
        .sort(compareExperiments(sort)),
    [items, subject, sort, term],
  );

  if (!user) return <div>Please sign in to view your trash.</div>;

  return items.length === 0 ? (
    <div style={{ padding: 16 }}>Trash is empty</div>
  ) : (
    <div className="my-experiments-page">
      <div className="home-toolbar">
        <SortMenu value={sort} onChange={setSort} />
        {availableSubjects.length > 0 && (
          <SubjectFilter value={subject} subjects={availableSubjects} onChange={setSubject} />
        )}
        <ListSearch value={term} onChange={setTerm} />
      </div>
      <ExperimentGrid items={visible} buildMenu={buildMenu} />
      <BackToTop />
    </div>
  );
};

export default Trash;
