import { Atom, Dna, FlaskConical, type LucideIcon } from 'lucide-react';
import { ExperimentSubjects } from '../../types';

export interface SubjectMeta {
  label: string;
  /** Emoji glyph — legacy consumers (analyzer subject tag, related list, multi-filter) still render
   *  this as a plain string. Homepage-facing surfaces (card badge, subject filter) use `Icon`. */
  icon: string;
  /** lucide icon component — the emoji replacement. Render as `<meta.Icon />`. */
  Icon: LucideIcon;
  /** Discipline colour, two-tier: `color` for fill/stroke/icon, `colorText` for label text on a
   *  light film (clears AA), `film` for the light selected background, `glow` for the icon tint on a
   *  dark thumbnail (where the main colour would sink into matching pseudocolour). */
  color: string;
  colorText: string;
  film: string;
  glow: string;
}

/** Icon + label + colour per subject discipline, shared by the card badge, subject filter, and the
 *  related-experiments list. */
export const SUBJECT_META: Record<string, SubjectMeta> = {
  [ExperimentSubjects.Physics]: {
    label: 'Physics',
    icon: '⚛',
    Icon: Atom,
    color: 'var(--ifi-phys)',
    colorText: 'var(--ifi-phys-text)',
    film: 'var(--ifi-phys-film)',
    glow: 'var(--ifi-phys-glow)',
  },
  [ExperimentSubjects.Chemistry]: {
    label: 'Chemistry',
    icon: '🧪',
    Icon: FlaskConical,
    color: 'var(--ifi-chem)',
    colorText: 'var(--ifi-chem-text)',
    film: 'var(--ifi-chem-film)',
    glow: 'var(--ifi-chem-glow)',
  },
  [ExperimentSubjects.Biology]: {
    label: 'Biology',
    icon: '🧬',
    Icon: Dna,
    color: 'var(--ifi-bio)',
    colorText: 'var(--ifi-bio-text)',
    film: 'var(--ifi-bio-film)',
    glow: 'var(--ifi-bio-glow)',
  },
};
