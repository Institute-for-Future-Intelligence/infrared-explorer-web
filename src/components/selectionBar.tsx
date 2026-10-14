import type { ReactNode } from 'react';
import { SquareCheckBig, X } from 'lucide-react';
import type { MultiSelect } from '../hooks/useMultiSelect';

/** Toolbar button that puts a card list into multi-select. */
export const SelectButton = ({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) => (
  <button type="button" className="list-btn" onClick={onClick} disabled={disabled}>
    <SquareCheckBig size={15} aria-hidden />
    Select
  </button>
);

interface Props {
  sel: MultiSelect<unknown>;
  // This list's bulk actions (`.list-btn` buttons), pushed to the right edge.
  children: ReactNode;
}

/**
 * The band that takes the sort / filter / search toolbar's place while a card list is in multi-select:
 * ✕ · N selected · Select all · the page's bulk actions.
 */
const SelectionBar = ({ sel, children }: Props) => (
  <div className="home-toolbar select-bar">
    <button type="button" className="select-bar-close" onClick={sel.stop} aria-label="Exit selection">
      <X size={18} aria-hidden />
    </button>
    <span className="select-bar-count" aria-live="polite">
      {sel.chosen.length} selected
    </span>
    <button type="button" className="list-btn" onClick={sel.toggleAll} disabled={sel.total === 0}>
      {sel.allSelected ? 'Deselect all' : 'Select all'}
    </button>
    <div className="select-bar-actions">{children}</div>
  </div>
);

export default SelectionBar;
