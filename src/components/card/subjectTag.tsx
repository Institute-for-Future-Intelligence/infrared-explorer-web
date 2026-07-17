import { ExperimentSubjects } from '../../types';
import { SUBJECT_META } from './subjectMeta';

/** A small subject badge (Physics / Chemistry / Biology) for the card's top-left corner. Renders
 *  nothing for N/A. "Lightbox" styling: night-blue glass so it reads on any pseudocolour thumbnail,
 *  a 1px discipline-colour stroke, and a lucide icon tinted in the discipline's lifted glow (the
 *  main colour would sink into matching pseudocolour). */
const SubjectTag = ({ subject }: { subject?: ExperimentSubjects | null }) => {
  const meta = subject ? SUBJECT_META[subject] : undefined;
  if (!meta) return null;
  const { Icon } = meta;
  // Static (not absolutely positioned): the card lays this out in a flex row alongside the other
  // status badges, so they share one aligned row.
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 26,
        padding: '0 10px 0 8px',
        fontSize: 13,
        fontWeight: 600,
        borderRadius: 8,
        color: '#fff',
        background: 'rgba(11, 16, 38, 0.72)',
        border: `1px solid ${meta.color}`,
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={15} strokeWidth={1.75} color={meta.glow} aria-hidden />
      {meta.label}
    </span>
  );
};

export default SubjectTag;
