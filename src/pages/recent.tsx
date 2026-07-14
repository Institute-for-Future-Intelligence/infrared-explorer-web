import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore';
import type { Timestamp } from 'firebase/firestore';
import { firebaseDatabase } from '../services/firebase';
import useCommonStore from '../stores/common';
import ExperimentGrid, { GridItem } from '../components/card/experimentGrid';
import { SUBJECT_META } from '../components/card/subjectMeta';
import SubjectFilter, { SubjectFilterValue } from '../components/subjectFilter';
import RecencyFilter, { RecencyValue } from '../components/recencyFilter';
import ListSearch, { matchesSearch } from '../components/listSearch';
import BackToTop from '../components/backToTop';
import { usePersistentState } from '../hooks/usePersistentState';
import { ExperimentSubjects } from '../types';

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

// History rows carry the view time so the recency filter can narrow the grid client-side.
interface HistoryItem extends GridItem {
  viewedMs: number;
}

const Recent = () => {
  const user = useCommonStore((state) => state.user);
  const [items, setItems] = useState<HistoryItem[]>([]);
  // Recency + subject filters persist across visits (localStorage); the search term stays transient.
  // "Viewed within the last N days" window; 'all' = no bound.
  const [within, setWithin] = usePersistentState<RecencyValue>('recent.within', 'all');
  const [subject, setSubject] = usePersistentState<SubjectFilterValue>('recent.subject', 'all');
  // Free-text search over the loaded history (title / author / description / subject).
  const [term, setTerm] = useState('');

  useEffect(() => {
    if (!user) return;
    const fetchRecent = async () => {
      // Pull a deeper slice than we show so the recency filter has rows to work over, not just the last 24.
      const q = query(
        collection(firebaseDatabase, `users/${user.id}/history`),
        orderBy('viewedAt', 'desc'),
        limit(200),
      );
      const snap = await getDocs(q);
      setItems(
        snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            thumbnailURL: data.thumbnailURL ?? '',
            displayName: data.displayName ?? '',
            subject: (data.subject as ExperimentSubjects | null) ?? null,
            author: data.author ?? '',
            // Absent on snapshots written before the field existed → author renders unlinked.
            ownerId: (data.ownerId as string | undefined) ?? undefined,
            description: data.description ?? '',
            duration: typeof data.duration === 'number' ? data.duration : undefined,
            createdAt: (data.createdAt as Timestamp | null) ?? null,
            updatedAt: (data.updatedAt as Timestamp | null) ?? null,
            viewedMs: data.viewedAt?.toMillis?.() ?? 0,
          };
        }),
      );
    };
    fetchRecent();
  }, [user]);

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
