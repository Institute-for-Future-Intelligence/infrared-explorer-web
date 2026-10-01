import { type CSSProperties } from 'react';
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import { Plus } from 'lucide-react';
import styled from 'styled-components';
import useCommonStore from '../../../stores/common';
import { updateSubject } from '../../../services/experiments';
import { Experiment, ExperimentSubjects } from '../../../types';
import { SUBJECT_META } from '../../../components/card/subjectMeta';

interface Props {
  experiment: Experiment;
}

// Pickable subjects, in the same order as the card badges / home filter chips.
const SUBJECT_OPTIONS: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

// The subject as a small discipline-coloured pill — the same lucide icon and colour the card badge and
// the home filter chips use, so the analyzer names the discipline in the grid's own voice rather than
// with an emoji tag or a bordered form control. 24px tall so it sits level with the plain-text facts
// beside it in the Info tab's facts strip. --chip-c / -t / -f (icon, text, film) are set inline per
// subject, as the home chips do; the defaults are a neutral ink pill.
const Chip = styled.button`
  --chip-c: var(--ifi-ink);
  --chip-t: var(--ifi-ink);
  --chip-f: rgba(0, 0, 0, 0.05);
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px 0 8px;
  border: 1px solid color-mix(in srgb, var(--chip-c) 35%, transparent);
  border-radius: 12px;
  background: var(--chip-f);
  color: var(--chip-t);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: default;
  transition:
    border-color var(--ifi-dur-fast) var(--ifi-ease-out),
    background-color var(--ifi-dur-fast) var(--ifi-ease-out),
    color var(--ifi-dur-fast) var(--ifi-ease-out);

  .chip-icon {
    display: inline-flex;
    color: var(--chip-c);
  }
  /* The owner's caret: small and quiet, the only sign the pill opens a menu. */
  .chip-caret {
    font-size: 9px;
    opacity: 0.55;
  }

  &.editable {
    cursor: pointer;
  }
  &.editable:hover {
    border-color: color-mix(in srgb, var(--chip-c) 70%, transparent);
  }
  &:focus-visible {
    outline: 2px solid var(--ifi-teal);
    outline-offset: 2px;
  }

  /* No subject yet (owner only): a dashed ghost pill that invites one, teal on hover like the panel's
     other quiet actions. */
  &.ghost {
    border: 1px dashed var(--ifi-stroke-2);
    background: transparent;
    color: var(--ifi-text-tertiary);
    font-weight: 500;
  }
  &.ghost:hover {
    border-color: var(--ifi-teal);
    color: var(--ifi-teal-dark);
    background: var(--ifi-teal-film);
  }
`;

const chipVars = (s: ExperimentSubjects): CSSProperties =>
  ({
    '--chip-c': SUBJECT_META[s].color,
    '--chip-t': SUBJECT_META[s].colorText,
    '--chip-f': SUBJECT_META[s].film,
  }) as CSSProperties;

// A menu row: the discipline's icon in its colour, then the name.
const menuLabel = (s: ExperimentSubjects) => {
  const { Icon, label, color } = SUBJECT_META[s];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <Icon size={14} strokeWidth={2} color={color} aria-hidden />
      {label}
    </span>
  );
};

/**
 * The experiment's subject, shown as the "Subject" fact in the analyzer's Info tab. Subject is the app's
 * single, predefined, filterable label — the same field that drives the home filter chips, the card badge
 * and search — so this just surfaces it and lets the owner change it.
 *
 * Everyone sees the discipline pill. The owner's pill carries a caret and opens a dropdown: pick one of
 * the fixed subjects, or clear it to leave the experiment unclassified; with no subject yet the owner
 * gets a dashed "Add subject" pill instead. Persists via updateSubject and patches the cached experiment
 * so the change shows immediately. A viewer of an unclassified experiment sees nothing (the fact is left
 * out, see description.tsx).
 */
const ExperimentSubject = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const editable = !!user && user.id === experiment.ownerId;
  const { subject } = experiment;
  // undefined for null / legacy "N/A" — those read as "no subject".
  const meta = subject ? SUBJECT_META[subject] : undefined;

  if (!editable && !meta) return null;

  // ---- viewer / non-owner: the pill, read-only ----
  if (!editable) {
    const { Icon, label } = meta!;
    return (
      <Chip as="span" style={chipVars(subject!)}>
        <span className="chip-icon">
          <Icon size={13} strokeWidth={2.25} aria-hidden />
        </span>
        {label}
      </Chip>
    );
  }

  const persist = (next: ExperimentSubjects | null) => {
    updateSubject(experiment.id, next).catch((e) => console.error('failed to update subject', e));
    const exp = useCommonStore.getState().experimentMap.get(experiment.id);
    if (exp) useCommonStore.getState().setExperiment(experiment.id, { ...exp, subject: next });
  };

  // ---- owner: the pill opens a menu of the fixed subjects (+ Clear once one is set) ----
  const items: MenuProps['items'] = [
    ...SUBJECT_OPTIONS.map((s) => ({ key: s, label: menuLabel(s) })),
    ...(meta ? [{ type: 'divider' as const }, { key: 'clear', label: 'Clear subject' }] : []),
  ];
  const menu: MenuProps = {
    items,
    selectable: true,
    selectedKeys: meta && subject ? [subject] : [],
    onClick: ({ key }) => persist(key === 'clear' ? null : (key as ExperimentSubjects)),
  };

  if (!meta) {
    return (
      <Dropdown menu={menu} trigger={['click']} placement="bottomLeft">
        <Chip type="button" className="editable ghost" aria-haspopup="menu" aria-label="Add a subject">
          <span className="chip-icon">
            <Plus size={13} strokeWidth={2.25} aria-hidden />
          </span>
          Add subject
        </Chip>
      </Dropdown>
    );
  }

  const { Icon, label } = meta;
  return (
    <Dropdown menu={menu} trigger={['click']} placement="bottomLeft">
      <Chip
        type="button"
        className="editable"
        style={chipVars(subject!)}
        aria-haspopup="menu"
        aria-label={`Subject: ${label}. Change`}
        title="Change subject"
      >
        <span className="chip-icon">
          <Icon size={13} strokeWidth={2.25} aria-hidden />
        </span>
        {label}
        <DownOutlined className="chip-caret" aria-hidden />
      </Chip>
    </Dropdown>
  );
};

export default ExperimentSubject;
