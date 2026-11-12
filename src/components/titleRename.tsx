import { useEffect, useRef, useState } from 'react';
import { Button, Input, type InputRef, Tooltip } from 'antd';
import { CheckOutlined, CloseOutlined, EditOutlined } from '@ant-design/icons';
import styled from 'styled-components';

/*
 * Renaming a page's title where it stands — a recording's in the analyzer's title row
 * (experimentTitle.tsx) and an experiment's on its page (ProjectPage), the same on both: a pencil
 * after the title that shows while the row is hovered (RenamePencil under revealRenamePencil), and
 * the one-line editor it opens in the title's place (TitleEditor). The ⋮ menu's Rename row opens
 * the same editor.
 */

// Muted pencil that brightens to the brand blue on hover — mirrors the subject editor's affordance.
const Pencil = styled.button`
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

/**
 * The pencil after a title its owner can rename. Put the row it sits in under revealRenamePencil
 * (titleRenameReveal.ts), which shows it while the row is hovered.
 */
export const RenamePencil = ({ onClick }: { onClick: () => void }) => (
  <Pencil className="title-edit" type="button" title="Rename" aria-label="Rename" onClick={onClick}>
    <EditOutlined />
  </Pencil>
);

// A compact editor block (~480px, not the whole row) — the input fills it, Save / Cancel sit to its
// right. Shrinks on narrow panels but never grows to span the full width.
const EditRow = styled.div`
  flex: 0 1 480px;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
`;

/**
 * The title as a single-line input with explicit Save / Cancel, in the title's place. Enter, Save and
 * clicking away commit; Escape and Cancel discard. `onCommit` gets the trimmed draft — the caller
 * writes a real change and treats an empty or unchanged one as nothing to do — and closes the editor;
 * it is called once.
 */
export const TitleEditor = ({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  /** The title as the page shows it; the draft starts from it. */
  initial: string;
  placeholder: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) => {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<InputRef>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  // Enter closes the editor, and the input leaving the page can still report a blur: one outcome only.
  const done = useRef(false);

  // Drop the caret at the end so the owner can tweak straight away.
  useEffect(() => {
    inputRef.current?.focus({ cursor: 'end' });
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    onCommit(value.trim());
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  return (
    <EditRow ref={rowRef}>
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPressEnter={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel();
        }}
        onBlur={(e) => {
          // Clicking away confirms. But when focus lands on our own Save / Cancel buttons, let their
          // click handlers run instead — so hitting Cancel still cancels rather than the blur
          // committing first.
          if (rowRef.current?.contains(e.relatedTarget as Node | null)) return;
          commit();
        }}
        placeholder={placeholder}
        maxLength={120}
        // 22px lines keep the input 32px tall, like the title row it replaces, so editing never moves
        // what is under the row (the analyzer's tabs, and the player aligned to the content under them).
        style={{ flex: 1, minWidth: 0, fontSize: 16, lineHeight: '22px', fontWeight: 500 }}
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
  );
};
