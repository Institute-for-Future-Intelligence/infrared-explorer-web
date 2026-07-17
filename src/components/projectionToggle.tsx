import { useState } from 'react';
import { Tooltip } from 'antd';
import { Presentation } from 'lucide-react';

/**
 * Classroom "projection mode" toggle. On a projector at the back of a K12 classroom the normal
 * layout is too small and dense; this bumps card/heading sizes, widens the grid tracks, and hides
 * the sidebar + chat FAB (all via `html[data-projection]` + CSS). Persisted to localStorage and
 * restored before first paint in main.tsx.
 */
const ProjectionToggle = () => {
  const [on, setOn] = useState(() => document.documentElement.dataset.projection === 'on');

  const toggle = () => {
    const next = !on;
    setOn(next);
    if (next) {
      document.documentElement.dataset.projection = 'on';
      localStorage.setItem('ui.projection', 'on');
    } else {
      delete document.documentElement.dataset.projection;
      localStorage.removeItem('ui.projection');
    }
  };

  return (
    <Tooltip title={on ? 'Exit projection mode' : 'Projection mode (bigger, for classrooms)'}>
      <button
        type="button"
        className={`projection-toggle${on ? ' active' : ''}`}
        aria-pressed={on}
        aria-label="Toggle projection mode"
        onClick={toggle}
      >
        <Presentation size={20} strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
  );
};

export default ProjectionToggle;
