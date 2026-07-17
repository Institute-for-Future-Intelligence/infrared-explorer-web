import { type CSSProperties } from 'react';
import { Check } from 'lucide-react';
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
 * clears the filter; the rest mirror the coloured card badges (lucide icon + label) from SUBJECT_META.
 *
 * The selected chip carries THREE signals so it reads without relying on colour alone (colour-blind
 * safe): a discipline-colour film + 1.5px stroke, a leading check, and a 600 weight. Colour keys the
 * chip to its subject (teal for "All").
 */
const SubjectFilter = ({ value, subjects, onChange }: Props) => {
  // Each chip carries its own colour as inline CSS vars (teal for "All"), so one set of CSS rules
  // styles the selected state and the palette stays sourced from SUBJECT_META alone.
  const TEAL_VARS = {
    '--chip-c': 'var(--ifi-teal)',
    '--chip-t': 'var(--ifi-teal-dark)',
    '--chip-f': 'var(--ifi-teal-film)',
  } as CSSProperties;

  return (
    <div className="subject-filter" role="group" aria-label="Filter by subject">
      <button
        type="button"
        className={`subject-chip${value === 'all' ? ' active' : ''}`}
        style={TEAL_VARS}
        aria-pressed={value === 'all'}
        onClick={() => onChange('all')}
      >
        <Check className="subject-chip-check" size={14} strokeWidth={2.5} aria-hidden />
        All
      </button>
      {subjects.map((s) => {
        const meta = SUBJECT_META[s];
        const Icon = meta?.Icon;
        const active = value === s;
        return (
          <button
            key={s}
            type="button"
            className={`subject-chip${active ? ' active' : ''}`}
            style={{ '--chip-c': meta?.color, '--chip-t': meta?.colorText, '--chip-f': meta?.film } as CSSProperties}
            aria-pressed={active}
            onClick={() => onChange(s)}
          >
            <Check className="subject-chip-check" size={14} strokeWidth={2.5} aria-hidden />
            {Icon && <Icon className="subject-chip-icon" size={15} strokeWidth={1.75} aria-hidden />}
            {meta?.label ?? s}
          </button>
        );
      })}
    </div>
  );
};

export default SubjectFilter;
