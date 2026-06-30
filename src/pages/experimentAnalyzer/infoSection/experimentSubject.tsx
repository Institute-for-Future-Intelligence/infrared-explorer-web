import { useEffect, useState } from 'react';
import { Select, Tag } from 'antd';
import { CheckOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
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

const labelOf = (s: ExperimentSubjects) => `${SUBJECT_META[s].icon} ${SUBJECT_META[s].label}`;

// Keep the edit pencil hidden until the row is hovered, then fade it in — mirrors the title's
// affordance (experimentTitle.tsx). opacity (not display) reserves its space so nothing shifts.
const Row = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 24px;
  margin-bottom: 8px;

  .subject-edit {
    opacity: 0;
    transition: opacity 0.2s;
  }
  &:hover .subject-edit,
  &:focus-within .subject-edit {
    opacity: 1;
  }
  /* No hover on touch — keep the pencil visible so the tag still reads as editable. */
  @media (hover: none) {
    .subject-edit {
      opacity: 1;
    }
  }
`;

const IconButton = styled.button`
  border: none;
  background: transparent;
  padding: 2px;
  line-height: 1;
  cursor: pointer;
  color: rgba(0, 0, 0, 0.45);
  &:hover {
    color: #1677ff;
  }
`;

/**
 * The experiment's subject, shown as a tag just under the analyzer title. Subject is the app's
 * single, predefined, filterable label — the same field that already drives the home filter chips,
 * the card badge, and the search match — so this just surfaces it on the analyzer and lets the owner
 * edit it.
 *
 * Display is always a normal tag badge (never a dropdown). The owner gets a hover-revealed edit
 * pencil; clicking it enters edit mode, where the tag becomes deletable (×) and — once empty — a
 * picker lets them add one from the fixed list (one tag max for now). Persists via updateSubject and
 * patches the cached experiment so the change shows immediately (mirrors experimentTitle.tsx).
 */
const ExperimentSubject = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const [editing, setEditing] = useState(false);

  // Navigating to another experiment must not carry an open editor over.
  useEffect(() => setEditing(false), [experiment.id]);

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
    return (
      <Row>
        <Tag style={{ marginInlineEnd: 0 }}>{meta!.icon + ' ' + meta!.label}</Tag>
      </Row>
    );
  }

  // ---- owner, edit mode: delete the current tag (×) and/or add one from the list ----
  if (editing) {
    return (
      <Row>
        {meta ? (
          <Tag
            closable
            // preventDefault so antd doesn't auto-hide it; state is the source of truth. Deleting
            // drops to the picker on the next render so a replacement can be added straight away.
            onClose={(e) => {
              e.preventDefault();
              persist(null);
            }}
            style={{ marginInlineEnd: 0 }}
          >
            {meta.icon + ' ' + meta.label}
          </Tag>
        ) : (
          <Select<ExperimentSubjects>
            autoFocus
            defaultOpen
            placeholder="Select a tag"
            size="small"
            style={{ minWidth: 150 }}
            onChange={(v) => {
              persist(v);
              setEditing(false);
            }}
            options={SUBJECT_OPTIONS.map((s) => ({ value: s, label: labelOf(s) }))}
          />
        )}
        <IconButton title="Done" onClick={() => setEditing(false)}>
          <CheckOutlined />
        </IconButton>
      </Row>
    );
  }

  // ---- owner, display: a normal tag badge + hover-revealed edit pencil ----
  return (
    <Row>
      {meta ? (
        <>
          <Tag style={{ marginInlineEnd: 0 }}>{meta.icon + ' ' + meta.label}</Tag>
          <IconButton className="subject-edit" title="Edit tag" onClick={() => setEditing(true)}>
            <EditOutlined />
          </IconButton>
        </>
      ) : (
        <Tag
          icon={<PlusOutlined />}
          onClick={() => setEditing(true)}
          style={{ background: '#fff', borderStyle: 'dashed', cursor: 'pointer', marginInlineEnd: 0 }}
        >
          Add tag
        </Tag>
      )}
    </Row>
  );
};

export default ExperimentSubject;
