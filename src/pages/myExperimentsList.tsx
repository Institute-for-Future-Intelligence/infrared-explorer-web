import { useMemo, useState } from 'react';
import { RightOutlined } from '@ant-design/icons';
import useCommonStore from '../stores/common';
import { ExperimentSubjects, Visibility } from '../types';
import OwnedExperimentGrid from '../components/card/ownedExperimentGrid';
import { SUBJECT_META } from '../components/card/subjectMeta';
import { VISIBILITY_OPTIONS } from '../components/visibilityControl';
import ChipMultiFilter, { FilterChip } from '../components/chipMultiFilter';
import ScrollRow from '../components/scrollRow';
import SortMenu, { SortValue, compareExperiments } from '../components/sortMenu';
import ListSearch, { matchesSearch } from '../components/listSearch';
import BackToTop from '../components/backToTop';
import { usePersistentState } from '../hooks/usePersistentState';
import { useOwnedExperiments } from '../hooks/useExperimentLists';

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

// Section order when grouping by visibility: most open first.
const TIER_ORDER: Visibility[] = [Visibility.Public, Visibility.Unlisted, Visibility.Private];

const MyExperimentsList = () => {
  const user = useCommonStore((state) => state.user);
  const { items: experiments, setItems: setExperiments } = useOwnedExperiments(user);
  // One combined multi-select filter over subject + visibility chips (persisted); search is
  // transient. Empty = unfiltered ("All"). Subject and visibility keys never collide, so they share
  // one selection array and are partitioned back out for filtering.
  const [filters, setFilters] = usePersistentState<string[]>('myExperiments.filters', []);
  const [sort, setSort] = usePersistentState<SortValue>('myExperiments.sort', 'updated');
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

  if (!user) return <div>Please sign in to see your experiments.</div>;

  return (
    <div className="my-experiments-page">
      <div className="home-toolbar">
        <SortMenu value={sort} onChange={setSort} />
        <ScrollRow ariaLabel="Filter experiments">
          {chips.length > 0 && <ChipMultiFilter chips={chips} selected={filters} onChange={setFilters} />}
        </ScrollRow>
        <ListSearch value={term} onChange={setTerm} />
      </div>

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
              {!isCollapsed && <OwnedExperimentGrid items={items} setItems={setExperiments} />}
            </section>
          );
        })
      ) : (
        <OwnedExperimentGrid items={sorted} setItems={setExperiments} />
      )}

      <BackToTop />
    </div>
  );
};

export default MyExperimentsList;
