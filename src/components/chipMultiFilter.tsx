import { Fragment, ReactNode } from 'react';

export interface FilterChip {
  key: string;
  label: string;
  icon?: ReactNode;
  /** Draw a thin separator before this chip (used to divide facet groups within one row). */
  divider?: boolean;
}

interface Props {
  chips: FilterChip[];
  /** Selected chip keys; an empty array means "no filter" (show everything), so "All" is active. */
  selected: string[];
  onChange: (next: string[]) => void;
  ariaLabel?: string;
}

/**
 * Multi-select chip row (the combined subject + visibility filter on My Experiments). The leading
 * "All" chip clears every selection; each other chip toggles independently. A chip may carry a
 * `divider` to visually separate facet groups. Reuses the subject-chip pill styling.
 */
const ChipMultiFilter = ({ chips, selected, onChange, ariaLabel }: Props) => {
  const toggle = (key: string) =>
    onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);

  return (
    <div className="chip-filter" role="group" aria-label={ariaLabel}>
      <button
        type="button"
        className={`subject-chip${selected.length === 0 ? ' active' : ''}`}
        aria-pressed={selected.length === 0}
        onClick={() => onChange([])}
      >
        All
      </button>
      {chips.map((c) => (
        <Fragment key={c.key}>
          {c.divider && <span className="chip-divider" aria-hidden="true" />}
          <button
            type="button"
            className={`subject-chip${selected.includes(c.key) ? ' active' : ''}`}
            aria-pressed={selected.includes(c.key)}
            onClick={() => toggle(c.key)}
          >
            {c.icon && <span className="subject-chip-icon">{c.icon}</span>}
            {c.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
};

export default ChipMultiFilter;
