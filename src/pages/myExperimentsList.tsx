import { useMemo, useState } from 'react';
import { RightOutlined } from '@ant-design/icons';
import useCommonStore from '../stores/common';
import { ExperimentSubjects, Visibility } from '../types';
import OwnedExperimentGrid from '../components/card/ownedExperimentGrid';
import OwnedSelectionBar from '../components/card/ownedSelectionBar';
import { SUBJECT_META } from '../components/card/subjectMeta';
import { VISIBILITY_OPTIONS } from '../components/visibilityControl';
import ChipMultiFilter, { FilterChip } from '../components/chipMultiFilter';
import ScrollRow from '../components/scrollRow';
import SortMenu, { SORT_OPTIONS, SortValue, compareExperiments } from '../components/sortMenu';
import ListSearch, { matchesSearch } from '../components/listSearch';
import { SelectButton } from '../components/selectionBar';
import BackToTop from '../components/backToTop';
import { usePersistentState } from '../hooks/usePersistentState';
import { useMultiSelect } from '../hooks/useMultiSelect';
import { useOwnedExperiments } from '../hooks/useExperimentLists';
import { useCaptureTimes } from '../hooks/useCaptureTimes';

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

// Section order when grouping by visibility: most open first.
const TIER_ORDER: Visibility[] = [Visibility.Public, Visibility.Unlisted, Visibility.Private];

// "Recently created" is the default order here (see the `myExperiments.sort` default below), so it
// leads the menu; the rest keep the shared order.
const MY_SORT_OPTIONS = [
  ...SORT_OPTIONS.filter((o) => o.key === 'newest'),
  ...SORT_OPTIONS.filter((o) => o.key !== 'newest'),
];

const MyExperimentsList = () => {
  const user = useCommonStore((state) => state.user);
  const { items: experiments, setItems: setExperiments } = useOwnedExperiments(user);
  // When each one was shot, worked out over the whole list (not the filtered view), so a copy still
  // finds its original when a filter hides the original.
  const captureTimes = useCaptureTimes(experiments);
  // One combined multi-select filter over subject + visibility chips (persisted); search is
  // transient. Empty = unfiltered ("All"). Subject and visibility keys never collide, so they share
  // one selection array and are partitioned back out for filtering.
  const [filters, setFilters] = usePersistentState<string[]>('myExperiments.filters', []);
  const [sort, setSort] = usePersistentState<SortValue>('myExperiments.sort', 'newest');
  const [term, setTerm] = useState('');
  // Which visibility sections are collapsed (only used while sorting "By visibility"). Transient.
  const [collapsed, setCollapsed] = useState<Partial<Record<Visibility, boolean>>>({});

  // Subject chips to offer: only the disciplines actually present in the loaded experiments, in the
  // fixed badge order.
  const availableSubjects = useMemo(() => {
    const present = new Set(
      experiments.map((s) => s.subject).filter((s): s is ExperimentSubjects => !!s && !!SUBJECT_META[s]),
    );
    return SUBJECT_ORDER.filter((s) => present.has(s));
  }, [experiments]);
  const subjectChips: FilterChip[] = availableSubjects.map((s) => ({
    key: s,
    label: SUBJECT_META[s]?.label ?? s,
    icon: SUBJECT_META[s]?.icon,
  }));

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
  const visibilityChips: FilterChip[] =
    VISIBILITY_OPTIONS.filter((o) => visibilityCounts[o.value] > 0).length >= 2
      ? VISIBILITY_OPTIONS.filter((o) => visibilityCounts[o.value] > 0).map((o, i) => ({
          key: o.value,
          label: `${o.label} ${visibilityCounts[o.value]}`,
          icon: o.icon,
          // Separate the visibility group from the subject group when both are present.
          divider: i === 0 && subjectChips.length > 0,
        }))
      : [];

  // One combined chip row: subject chips then visibility chips.
  const chips: FilterChip[] = [...subjectChips, ...visibilityChips];

  // The visibility tier keys, used to split the combined selection back into its two facets.
  const visibilityKeys = new Set<string>(VISIBILITY_OPTIONS.map((o) => o.value));
  const selectedVisibilities = filters.filter((f) => visibilityKeys.has(f));
  const selectedSubjects = filters.filter((f) => !visibilityKeys.has(f));

  // Subject + visibility + search filter. Within a facet the selection is OR; across facets it's AND.
  const filtered = useMemo(
    () =>
      experiments.filter(
        (e) =>
          (selectedSubjects.length === 0 || (e.subject != null && selectedSubjects.includes(e.subject))) &&
          (selectedVisibilities.length === 0 || selectedVisibilities.includes(e.visibility ?? Visibility.Unlisted)) &&
          matchesSearch(e, term),
      ),
    // selectedSubjects/selectedVisibilities derive from `filters`; depend on it to avoid re-splitting churn.
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
          <SortMenu value={sort} onChange={setSort} options={MY_SORT_OPTIONS} />
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
                {opt?.icon}
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
