import { useMemo, useState } from 'react';
import { RightOutlined } from '@ant-design/icons';
import useCommonStore from '../stores/common';
import { Visibility } from '../types';
import OwnedExperimentGrid from '../components/card/ownedExperimentGrid';
import OwnedSelectionBar from '../components/card/ownedSelectionBar';
import { VISIBILITY_OPTIONS } from '../components/visibilityControl';
import ChipMultiFilter, { FilterChip } from '../components/chipMultiFilter';
import ScrollRow from '../components/scrollRow';
import SortMenu, { SortValue, compareExperiments } from '../components/sortMenu';
import ListSearch, { matchesSearch } from '../components/listSearch';
import { SelectButton } from '../components/selectionBar';
import BackToTop from '../components/backToTop';
import { usePersistentState } from '../hooks/usePersistentState';
import { useMultiSelect } from '../hooks/useMultiSelect';
import { useOwnedExperiments } from '../hooks/useExperimentLists';
import { useCaptureTimes } from '../hooks/useCaptureTimes';

// Section order when grouping by visibility: most open first.
const TIER_ORDER: Visibility[] = [Visibility.Public, Visibility.Unlisted, Visibility.Private];

const MyExperimentsList = () => {
  const user = useCommonStore((state) => state.user);
  const { items: experiments, setItems: setExperiments } = useOwnedExperiments(user);
  // When each one was shot, worked out over the whole list (not the filtered view), so a copy still
  // finds its original when a filter hides the original.
  const captureTimes = useCaptureTimes(experiments);
  // A multi-select filter over the visibility chips (persisted; the subject chips that used to share
  // the row are gone — no discipline filter anywhere since 2026-10-28, so a stale subject key in the
  // stored selection is ignored); search is transient. Empty = unfiltered ("All").
  const [filters, setFilters] = usePersistentState<string[]>('myExperiments.filters', []);
  const [sort, setSort] = usePersistentState<SortValue>('myExperiments.sort', 'newest');
  const [term, setTerm] = useState('');
  // Which visibility sections are collapsed (only used while sorting "By visibility"). Transient.
  const [collapsed, setCollapsed] = useState<Partial<Record<Visibility, boolean>>>({});

  // Per-tier counts (a missing visibility counts as Link only, the default tier for saved clips).
  const visibilityCounts = useMemo(() => {
    const counts: Record<Visibility, number> = {
      [Visibility.Public]: 0,
      [Visibility.Unlisted]: 0,
      [Visibility.Private]: 0,
    };
    for (const e of experiments) counts[e.visibility ?? Visibility.Unlisted] += 1;
    return counts;
  }, [experiments]);
  // Visibility chips, labelled with their count. Only offered when the clips actually span 2+ tiers
  // (filtering by the single present tier would be a no-op).
  const chips: FilterChip[] =
    VISIBILITY_OPTIONS.filter((o) => visibilityCounts[o.value] > 0).length >= 2
      ? VISIBILITY_OPTIONS.filter((o) => visibilityCounts[o.value] > 0).map((o) => ({
          key: o.value,
          label: `${o.label} ${visibilityCounts[o.value]}`,
          icon: <o.icon size={14} strokeWidth={2} aria-hidden />,
        }))
      : [];

  // The visibility tier keys: only those count in the stored selection.
  const visibilityKeys = new Set<string>(VISIBILITY_OPTIONS.map((o) => o.value));
  const selectedVisibilities = filters.filter((f) => visibilityKeys.has(f));

  // Visibility + search filter. The selection is OR within the tiers, AND with the search.
  const filtered = useMemo(
    () =>
      experiments.filter(
        (e) =>
          (selectedVisibilities.length === 0 || selectedVisibilities.includes(e.visibility ?? Visibility.Unlisted)) &&
          matchesSearch(e, term),
      ),
    // selectedVisibilities derives from `filters`; depend on it to avoid re-splitting churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [experiments, filters, term],
  );

  const groupByVisibility = sort === 'visibility';

  // Flat sorted list (every sort except "By visibility").
  const sorted = useMemo(() => filtered.slice().sort(compareExperiments(sort)), [filtered, sort]);

  // Grouped: one section per non-empty tier (Public / Link only / Private), newest-first within each.
  const sections = useMemo(
    () =>
      TIER_ORDER.map((tier) => ({
        tier,
        items: filtered
          .filter((e) => (e.visibility ?? Visibility.Unlisted) === tier)
          .sort(compareExperiments('newest')),
      })).filter((g) => g.items.length > 0),
    [filtered],
  );

  // The cards on screen, in display order — what multi-select works over. A collapsed section's cards
  // are out of it, so Select all and the bulk actions never reach a card that isn't showing. While
  // selecting, the sort / filter / search band gives way to the selection bar, so this can't be
  // re-sorted or re-filtered under the selection.
  const shown = useMemo(
    () => (groupByVisibility ? sections.filter((g) => !collapsed[g.tier]).flatMap((g) => g.items) : sorted),
    [groupByVisibility, sections, collapsed, sorted],
  );
  const sel = useMultiSelect(shown);

  if (!user) return <div>Please sign in to see your recordings.</div>;

  return (
    <div className="my-experiments-page">
      {sel.selecting ? (
        <OwnedSelectionBar sel={sel} setItems={setExperiments} />
      ) : (
        <div className="home-toolbar">
          <SortMenu value={sort} onChange={setSort} />
          <ScrollRow ariaLabel="Filter recordings">
            {chips.length > 0 && <ChipMultiFilter chips={chips} selected={filters} onChange={setFilters} />}
          </ScrollRow>
          <ListSearch value={term} onChange={setTerm} />
          <div className="list-toolbar-actions">
            <SelectButton onClick={sel.start} disabled={shown.length === 0} />
          </div>
        </div>
      )}

      {groupByVisibility ? (
        sections.map(({ tier, items }) => {
          const opt = VISIBILITY_OPTIONS.find((o) => o.value === tier);
          const isCollapsed = !!collapsed[tier];
          return (
            <section className="visibility-section" key={tier}>
              <button
                type="button"
                className="visibility-section-header"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((c) => ({ ...c, [tier]: !c[tier] }))}
              >
                <RightOutlined className={`visibility-section-chevron${isCollapsed ? '' : ' open'}`} />
                {opt && <opt.icon size={14} strokeWidth={2} aria-hidden />}
                <span className="visibility-section-label">{opt?.label}</span>
                <span className="visibility-section-count">{items.length}</span>
              </button>
              {!isCollapsed && (
                <OwnedExperimentGrid items={items} setItems={setExperiments} captureTimes={captureTimes} sel={sel} />
              )}
            </section>
          );
        })
      ) : (
        <OwnedExperimentGrid items={sorted} setItems={setExperiments} captureTimes={captureTimes} sel={sel} />
      )}

      <BackToTop />
    </div>
  );
};

export default MyExperimentsList;
