import { useEffect, useRef, useState } from 'react';
import { Button, Input, InputRef, Tooltip, Typography } from 'antd';
import { CheckOutlined, CloseOutlined, EditOutlined } from '@ant-design/icons';
import styled from 'styled-components';
import useCommonStore from '../../../stores/common';
import { renameExperiment } from '../../../services/experiments';
import { Experiment } from '../../../types';
import SaveToMyExperiments from './saveToMyExperiments';
import ShareMenu from '../../../components/shareMenu';
import { experimentShareUrl } from '../../../utils/urls';

const { Title } = Typography;

// Lay the title and the right-pinned actions (copy link + save) on one row: the title takes the
// available space, the buttons stay pinned to the right.
const TitleWrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;

  // Keep the edit pencil hidden until the owner hovers the title, then fade it in. Using opacity
  // (not display) reserves its space so the title doesn't shift sideways when the pencil appears.
  .title-edit {
    opacity: 0;
    transition: opacity 0.2s;
  }
  &:hover .title-edit,
  &:focus-within .title-edit {
    opacity: 1;
  }
  /* Touch devices have no hover, so a hover-only pencil is invisible to the owner there — keep it
     shown so the title still reads as editable. */
  @media (hover: none) {
    .title-edit {
      opacity: 1;
    }
  }
`;

// The right-pinned icon actions (copy link + save), packed tight together — a small gap keeps them
// reading as one toolbar while TitleWrapper's larger gap holds them off the title.
const ActionGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
`;

// Display: the title text + a hover-revealed edit pencil sitting just after it.
const HeadingGroup = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;

  .ant-typography {
    margin: 0;
    min-width: 0;
  }
`;

// Edit: a compact editor block (~480px, not the whole row) — the input fills it, Save / Cancel sit
// to its right. Shrinks on narrow panels but never grows to span the full width.
const EditRow = styled.div`
  flex: 0 1 480px;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
`;

// Muted pencil that brightens to the brand blue on hover — mirrors the subject editor's affordance.
const EditPencil = styled.button`
  border: none;
  background: transparent;
  padding: 2px;
  line-height: 1;
  cursor: pointer;
  color: rgba(0, 0, 0, 0.45);
  flex-shrink: 0;
  &:hover {
    color: #1677ff;
  }
`;

interface Props {
  experiment: Experiment;
}

/**
 * The experiment's title (`displayName`) shown at the top of the analyzer's info panel.
 * The owner can edit it inline (a hover-revealed pencil opens a single-line editor with explicit
 * Save / Cancel); everyone else sees static text. Edits the human title only — never `name`, which
 * is the internal videostore slug.
 */
const ExperimentTitle = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const editable = !!user && user.id === experiment.ownerId;

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(experiment.displayName ?? '');
  const inputRef = useRef<InputRef>(null);
  const editRowRef = useRef<HTMLDivElement>(null);

  // Reset the draft and close the editor when navigating to another experiment or when this title
  // is renamed elsewhere, so a stale draft never carries over.
  useEffect(() => {
    setValue(experiment.displayName ?? '');
    setEditing(false);
  }, [experiment.id, experiment.displayName]);

  // Drop the caret at the end when entering edit mode so the owner can tweak straight away.
  useEffect(() => {
    if (editing) inputRef.current?.focus({ cursor: 'end' });
  }, [editing]);

  // Confirm the edit: persist a real change (rules-permitted rename service, then patch the cached
  // experiment so the new title shows immediately wherever the store is read — card lists, header,
  // this panel — instead of lagging a navigation behind Firestore, mirroring content.tsx's flush).
  // An empty or unchanged draft writes nothing and just snaps back to the current title. Used by the
  // Save button, Enter, and clicking away.
  const commit = () => {
    const next = value.trim();
    if (next && next !== experiment.displayName) {
      renameExperiment(experiment.id, next).catch((e) => console.error('failed to rename experiment', e));
      const exp = useCommonStore.getState().experimentMap.get(experiment.id);
      if (exp) useCommonStore.getState().setExperiment(experiment.id, { ...exp, displayName: next });
      setValue(next);
    } else {
      setValue(experiment.displayName ?? '');
    }
    setEditing(false);
  };

  // Discard the draft: revert to the persisted title and leave edit mode.
  const cancel = () => {
    setValue(experiment.displayName ?? '');
    setEditing(false);
  };

  // ---- owner, edit mode: single-line input + explicit Save / Cancel ----
  if (editing) {
    return (
      <TitleWrapper>
        <EditRow ref={editRowRef}>
          <Input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onPressEnter={commit}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel();
            }}
            onBlur={(e) => {
              // Clicking away confirms. But when focus lands on our own Save / Cancel buttons, let
              // their click handlers run instead — so hitting Cancel still cancels rather than the
              // blur committing first.
              if (editRowRef.current?.contains(e.relatedTarget as Node | null)) return;
              commit();
            }}
            placeholder="Experiment title"
            maxLength={120}
            style={{ flex: 1, minWidth: 0, fontSize: 16, fontWeight: 500 }}
          />
          <Tooltip title="Save">
            <Button
              type="primary"
              icon={<CheckOutlined />}
              onClick={commit}
              disabled={!value.trim()}
              aria-label="Save title"
            />
          </Tooltip>
          <Tooltip title="Cancel">
            <Button icon={<CloseOutlined />} onClick={cancel} aria-label="Cancel" />
          </Tooltip>
        </EditRow>
      </TitleWrapper>
    );
  }

  // ---- display: the title + (owner) a hover-revealed edit pencil, with the right-pinned actions ----
  return (
    <TitleWrapper>
      <HeadingGroup>
        <Title level={4} style={{ margin: 0 }}>
          {experiment.displayName || 'Untitled experiment'}
        </Title>
        {editable && (
          <EditPencil
            className="title-edit"
            type="button"
            title="Edit title"
            aria-label="Edit title"
            onClick={() => setEditing(true)}
          >
            <EditOutlined />
          </EditPencil>
        )}
      </HeadingGroup>
      <ActionGroup>
        <ShareMenu
          url={experimentShareUrl(experiment.id)}
          title={experiment.displayName || 'Infrared Explorer'}
          visibility={experiment.visibility}
        />
        <SaveToMyExperiments experiment={experiment} />
      </ActionGroup>
    </TitleWrapper>
  );
};

export default ExperimentTitle;
