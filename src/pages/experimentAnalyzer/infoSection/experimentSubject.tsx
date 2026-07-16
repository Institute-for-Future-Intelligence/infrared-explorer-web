import { Tag } from 'antd';
import useCommonStore from '../../../stores/common';
import { updateSubject } from '../../../services/experiments';
import { Experiment, ExperimentSubjects } from '../../../types';
import { SUBJECT_META } from '../../../components/card/subjectMeta';
import IconLabelSelect from '../../../components/iconLabelSelect';

interface Props {
  experiment: Experiment;
}

// Pickable subjects, in the same order as the card badges / home filter chips.
const SUBJECT_OPTIONS: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

// Icon + label for one subject, laid out as a flex row so the emoji icon sits vertically centred with
// the text. A bare "⚛ Physics" string lets the emoji ride its own (tall) baseline — misaligning it
// against the label AND inflating the dropdown rows' line boxes. lineHeight:1 trims that emoji line
// box; IconLabelSelect centres the whole span in the closed selector box.
const subjectLabel = (s: ExperimentSubjects) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, lineHeight: 1 }}>
    <span aria-hidden>{SUBJECT_META[s].icon}</span>
    {SUBJECT_META[s].label}
  </span>
);

/**
 * The experiment's subject, shown in the analyzer's "Subject" fact row. Subject is the app's single,
 * predefined, filterable label — the same field that drives the home filter chips, the card badge and
 * search — so this just surfaces it and lets the owner change it.
 *
 * The owner gets a dropdown picker in the same style as the Visibility select sitting below it (small
 * size, min-width, popup free of the box width): pick one of the fixed subjects, or clear it to leave
 * the experiment unclassified. Everyone else sees a read-only tag badge. Persists via updateSubject and
 * patches the cached experiment so the change shows immediately (mirrors VisibilitySelect).
 */
const ExperimentSubject = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const editable = !!user && user.id === experiment.ownerId;
  const { subject } = experiment;
  const meta = subject ? SUBJECT_META[subject] : undefined; // undefined for null / legacy "N/A"

  // A viewer looking at an unclassified experiment sees nothing (no empty row).
  if (!editable && !meta) return null;

  const persist = (next: ExperimentSubjects | null) => {
    updateSubject(experiment.id, next).catch((e) => console.error('failed to update subject', e));
    const exp = useCommonStore.getState().experimentMap.get(experiment.id);
    if (exp) useCommonStore.getState().setExperiment(experiment.id, { ...exp, subject: next });
  };

  // ---- viewer / non-owner: read-only badge ----
  if (!editable) {
    return <Tag style={{ marginInlineEnd: 0 }}>{meta!.icon + ' ' + meta!.label}</Tag>;
  }

  // ---- owner: a dropdown picker mirroring the Visibility select ----
  // Show the current subject only when it maps to a real option (a legacy "N/A" falls through to the
  // placeholder). allowClear lets the owner unset it — onChange fires with undefined, persisted as null.
  return (
    <IconLabelSelect<ExperimentSubjects>
      size="small"
      value={subject && meta ? subject : undefined}
      placeholder="Add a subject"
      allowClear
      onChange={(v) => persist(v ?? null)}
      popupMatchSelectWidth={false}
      aria-label="Subject"
      style={{ minWidth: 132 }}
      options={SUBJECT_OPTIONS.map((s) => ({ value: s, label: subjectLabel(s) }))}
    />
  );
};

export default ExperimentSubject;
