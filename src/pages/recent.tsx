import { useMemo, useState } from 'react';
import useCommonStore from '../stores/common';
import ExperimentGrid from '../components/card/experimentGrid';
import RecencyFilter, { RecencyValue } from '../components/recencyFilter';
import ListSearch, { matchesSearch } from '../components/listSearch';
import BackToTop from '../components/backToTop';
import { usePersistentState } from '../hooks/usePersistentState';
import { useViewHistory } from '../hooks/useExperimentLists';

const Recent = () => {
  const user = useCommonStore((state) => state.user);
  // Pull a deeper slice than we show so the recency filter has rows to work over, not just the last 24.
  const { items } = useViewHistory(user, 200);
  // The recency filter persists across visits (localStorage); the search term stays transient.
  // "Viewed within the last N days" window; 'all' = no bound.
  const [within, setWithin] = usePersistentState<RecencyValue>('recent.within', 'all');
  // Free-text search over the loaded history (title / author / description / subject).
  const [term, setTerm] = useState('');

  // Earliest view time to keep: "viewed within N days" → now − N days. 'all' leaves it open.
  const sinceMs = within === 'all' ? null : Date.now() - within * 24 * 60 * 60 * 1000;
  const shown = useMemo(
    () => items.filter((it) => sinceMs === null || it.viewedMs >= sinceMs).filter((it) => matchesSearch(it, term)),
    [items, sinceMs, term],
  );

  if (!user) return <div>Please sign in to see your recent recordings.</div>;

  return (
    <div>
      {/* Recency filter + search aligned with the card grid's inset, matching All Experiments. */}
      <div className="experiment-filters">
        <RecencyFilter value={within} onChange={setWithin} />
        <ListSearch value={term} onChange={setTerm} />
      </div>
      <ExperimentGrid items={shown} showUpdated />
      <BackToTop />
    </div>
  );
};

export default Recent;
