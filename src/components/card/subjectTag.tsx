import { ExperimentSubjects } from '../../types';
import { SUBJECT_META } from './subjectMeta';

/** Compact subject badge (Physics / Chemistry / Biology) for the card's top-left corner. Renders
 *  nothing for N/A. "Lightbox" styling: a 26px night-blue glass square so it reads on any
 *  pseudocolour thumbnail, a 1px discipline-colour stroke, and a lucide icon tinted in the
 *  discipline's lifted glow (the main colour would sink into matching pseudocolour). Icon-only; the
 *  label rides along in the title/aria for accessibility. */
const SubjectTag = ({ subject }: { subject?: ExperimentSubjects | null }) => {
  const meta = subject ? SUBJECT_META[subject] : undefined;
  if (!meta) return null;
  const { Icon } = meta;
  return (
    <span
      className="card-subject-badge"
      title={meta.label}
      aria-label={meta.label}
      style={{ border: `1px solid ${meta.color}` }}
    >
      <Icon size={15} strokeWidth={1.75} color={meta.glow} aria-hidden />
    </span>
  );
};

export default SubjectTag;
