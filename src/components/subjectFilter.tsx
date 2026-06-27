import { ExperimentSubjects } from '../types';
import { SUBJECT_META } from './card/subjectMeta';

/** Selected value of the home subject filter: a specific discipline, or "all" (no filter). */
export type SubjectFilterValue = ExperimentSubjects | 'all';

interface Props {
  value: SubjectFilterValue;
  /** Which subject chips to render — usually only the disciplines present in the loaded data. */
  subjects: ExperimentSubjects[];
  onChange: (value: SubjectFilterValue) => void;
}

/**
 * YouTube-style horizontal chip row that filters the home grid by subject. The leading "All" chip
 * clears the filter; the rest mirror the coloured card badges (icon + label) from SUBJECT_META.
 */
const SubjectFilter = ({ value, subjects, onChange }: Props) => {
  const chips: { key: SubjectFilterValue; label: string; icon?: string }[] = [
    { key: 'all', label: 'All' },
    ...subjects.map((s) => ({ key: s, label: SUBJECT_META[s]?.label ?? s, icon: SUBJECT_META[s]?.icon })),
  ];

  return (
    <div className="subject-filter">
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          className={`subject-chip${value === c.key ? ' active' : ''}`}
          aria-pressed={value === c.key}
          onClick={() => onChange(c.key)}
        >
          {c.icon && <span className="subject-chip-icon">{c.icon}</span>}
          {c.label}
        </button>
      ))}
    </div>
  );
};

export default SubjectFilter;
