import { ExperimentSubjects } from '../../types';

/** Icon + label per subject discipline, shared by the card badge and the related-experiments list. */
export const SUBJECT_META: Record<string, { label: string; icon: string }> = {
  [ExperimentSubjects.Physics]: { label: 'Physics', icon: '⚛' },
  [ExperimentSubjects.Chemistry]: { label: 'Chemistry', icon: '🧪' },
  [ExperimentSubjects.Biology]: { label: 'Biology', icon: '🧬' },
};
