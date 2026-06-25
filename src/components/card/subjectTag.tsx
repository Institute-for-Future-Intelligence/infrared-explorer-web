import { ExperimentSubjects } from '../../types';
import { SUBJECT_META } from './subjectMeta';

/** A small coloured subject badge (Physics / Chemistry / Biology). Renders nothing for N/A. */
const SubjectTag = ({ subject }: { subject?: ExperimentSubjects | null }) => {
  const meta = subject ? SUBJECT_META[subject] : undefined;
  if (!meta) return null;
  return (
    <span
      style={{
        position: 'absolute',
        top: 8,
        left: 8,
        zIndex: 2,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 12px',
        fontSize: 13,
        fontWeight: 500,
        borderRadius: 8,
        color: 'white',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        pointerEvents: 'none',
      }}
    >
      <span>{meta.icon}</span>
      {meta.label}
    </span>
  );
};

export default SubjectTag;
