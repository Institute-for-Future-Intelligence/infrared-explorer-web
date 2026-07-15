import { ExperimentSubjects } from '../../types';
import { SUBJECT_META } from './subjectMeta';

/** A small coloured subject badge (Physics / Chemistry / Biology). Renders nothing for N/A. */
const SubjectTag = ({ subject }: { subject?: ExperimentSubjects | null }) => {
  const meta = subject ? SUBJECT_META[subject] : undefined;
  if (!meta) return null;
  // Static (not absolutely positioned): the card lays this out in a flex row alongside the other
  // status badges, so they share one aligned row.
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 26,
        padding: '0 12px',
        fontSize: 13,
        fontWeight: 500,
        borderRadius: 8,
        color: 'white',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        whiteSpace: 'nowrap',
      }}
    >
      <span>{meta.icon}</span>
      {meta.label}
    </span>
  );
};

export default SubjectTag;
