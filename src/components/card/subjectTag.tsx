import { ExperimentSubjects } from '../../types';

const SUBJECT_META: Record<string, { label: string; icon: string; color: string }> = {
  [ExperimentSubjects.Physics]: { label: 'Physics', icon: '⚛', color: '#3b6fb6' },
  [ExperimentSubjects.Chemistry]: { label: 'Chemistry', icon: '🧪', color: '#c2410c' },
  [ExperimentSubjects.Biology]: { label: 'Biology', icon: '🧬', color: '#15803d' },
};

/** A small coloured subject badge (Physics / Chemistry / Biology). Renders nothing for N/A. */
const SubjectTag = ({ subject }: { subject?: ExperimentSubjects | null }) => {
  const meta = subject ? SUBJECT_META[subject] : undefined;
  if (!meta) return null;
  return (
    <span
      style={{
        position: 'absolute',
        top: 6,
        left: 6,
        zIndex: 2,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 8px',
        fontSize: 11,
        borderRadius: 10,
        color: 'white',
        background: meta.color,
        pointerEvents: 'none',
      }}
    >
      <span>{meta.icon}</span>
      {meta.label}
    </span>
  );
};

export default SubjectTag;
