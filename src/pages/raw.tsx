import { useMemo, useState } from 'react';
import useCommonStore from '../stores/common';
import OwnedExperimentGrid from '../components/card/ownedExperimentGrid';
import OwnedSelectionBar from '../components/card/ownedSelectionBar';
import SortMenu, { SortValue, compareExperiments } from '../components/sortMenu';
import ListSearch, { matchesSearch } from '../components/listSearch';
import { SelectButton } from '../components/selectionBar';
import BackToTop from '../components/backToTop';
import { usePersistentState } from '../hooks/usePersistentState';
import { useMultiSelect } from '../hooks/useMultiSelect';
import { useRawExperiments } from '../hooks/useExperimentLists';
import { useCaptureTimes } from '../hooks/useCaptureTimes';

/**
 * My original recordings — the raw captures from the mobile app, NOT copies (the query semantics
 * live in useRawExperiments, shared with the Me hub's row).
 */
const Raw = () => {
  const user = useCommonStore((state) => state.user);
  const { items: experiments, setItems: setExperiments } = useRawExperiments(user);
  // When each recording was shot (originals all, so no source lookups).
  const captureTimes = useCaptureTimes(experiments);
  // The sort persists across visits (localStorage); the search term stays transient.
  const [sort, setSort] = usePersistentState<SortValue>('raw.sort', 'updated');
  // Free-text search over the loaded list (title / author / description / subject).
  const [term, setTerm] = useState('');

  // Apply the search filter, then sort the survivors by the chosen order. Sorting is client-side over
  // the already-loaded list. The grid's rename/trash mutations still target the full `experiments` list.
  const visible = useMemo(
    () => experiments.filter((s) => matchesSearch(s, term)).sort(compareExperiments(sort)),
    [experiments, sort, term],
  );

  // Multi-select. While selecting, the sort / search band gives way to the selection bar, so the
  // visible list can't change under the selection.
  const sel = useMultiSelect(visible);

  if (!user) return <div>Please sign in to see your raw data.</div>;

  return (
    <div className="my-experiments-page">
      {sel.selecting ? (
        <OwnedSelectionBar sel={sel} setItems={setExperiments} />
      ) : (
        <div className="home-toolbar">
          <SortMenu value={sort} onChange={setSort} />
          <ListSearch value={term} onChange={setTerm} />
          <div className="list-toolbar-actions">
            <SelectButton onClick={sel.start} disabled={visible.length === 0} />
          </div>
        </div>
      )}
      <OwnedExperimentGrid items={visible} setItems={setExperiments} captureTimes={captureTimes} sel={sel} />
      <BackToTop />
    </div>
  );
};

export default Raw;
