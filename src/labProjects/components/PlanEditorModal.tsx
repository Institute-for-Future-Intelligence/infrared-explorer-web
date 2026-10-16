/*
 * The user's own edit of the plan, laid out as it reads — headings, lists,
 * tables and pictures, edited in place (the app's PlanEditorModal; the page
 * is core/planEditor.ts markdownToEditorHtml, the way back planEditorDom.ts;
 * the user never sees Markdown). A picture can be taken out with its ×
 * button. Saving replaces the plan (marked as the user's), and the server
 * puts a note of what changed into the conversation, which the AI reads on
 * its next turn. Discard leaves without saving; leaving any other way (×,
 * Esc, the mask) with unsaved edits asks whether to save them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal } from 'antd';
import styled from 'styled-components';
import { markdownToEditorHtml } from '../core/planEditor';
import type { ProjectImage } from '../core/types';
import { editorMarkdown } from '../planEditorDom';

const Editor = styled.div`
  min-height: 50vh;
  max-height: 70vh;
  overflow-y: auto;
  padding: 12px 14px 30vh;
  border: 1px solid var(--ifi-stroke-2);
  border-radius: 8px;
  outline: none;
  color: var(--ifi-ink);
  font-size: 15px;
  line-height: 1.55;
  word-wrap: break-word;

  &:focus {
    border-color: var(--ifi-teal);
  }
  &:empty::before {
    content: attr(data-placeholder);
    color: var(--ifi-text-tertiary);
  }
  h1 {
    font-size: 22px;
    line-height: 1.3;
    margin: 16px 0 8px;
  }
  h2 {
    font-size: 18px;
    line-height: 1.3;
    margin: 14px 0 6px;
  }
  h3,
  h4,
  h5,
  h6 {
    font-size: 16px;
    margin: 12px 0 6px;
  }
  p {
    margin: 0 0 10px;
  }
  ul,
  ol {
    margin: 0 0 10px;
    padding-left: 24px;
  }
  li {
    margin: 2px 0;
  }
  table {
    border-collapse: collapse;
    margin: 0 0 12px;
    width: 100%;
  }
  th,
  td {
    border: 1px solid var(--ifi-stroke-2);
    padding: 6px;
    text-align: left;
    vertical-align: top;
  }
  th {
    background: var(--ifi-fill-1);
  }
  figure {
    position: relative;
    margin: 8px 0 14px;
  }
  figure img {
    display: block;
    max-width: 100%;
    max-height: 360px;
    border-radius: 8px;
    background: var(--ifi-fill-1);
  }
  figcaption {
    color: var(--ifi-text-tertiary);
    font-size: 13px;
    margin-top: 4px;
  }
  figure .rm {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: 15px;
    background: rgba(11, 16, 38, 0.65);
    color: #fff;
    font-size: 20px;
    line-height: 30px;
    padding: 0;
    cursor: pointer;
  }
  pre {
    background: var(--ifi-fill-1);
    padding: 10px;
    border-radius: 6px;
    white-space: pre-wrap;
    font-family: var(--ifi-font-mono);
    font-size: 13px;
    line-height: 1.4;
  }
  blockquote {
    margin: 0 0 10px;
    padding-left: 12px;
    border-left: 3px solid var(--ifi-stroke-2);
    color: var(--ifi-text-secondary);
  }
  code {
    background: var(--ifi-fill-1);
    border-radius: 4px;
    padding: 0 4px;
    font-family: var(--ifi-font-mono);
  }
  a {
    color: var(--ifi-teal-dark);
  }
  hr {
    border: 0;
    border-top: 1px solid var(--ifi-stroke-1);
    margin: 14px 0;
  }
`;

const ErrorLine = styled.div`
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--ifi-danger);
`;

const PlanEditorModal = ({
  open,
  initial,
  images,
  onSave,
  onClose,
}: {
  open: boolean;
  initial: string;
  /** The project's pictures, to show the ones the plan contains. */
  images: ProjectImage[];
  onSave: (markdown: string) => Promise<void>;
  onClose: () => void;
}) => {
  const editor = useRef<HTMLDivElement | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (open) {
      setDirty(false);
      setBusy(false);
      setError(null);
      setAsking(false);
    }
  }, [open]);

  // The page is built when the editor's node mounts (destroyOnClose: a fresh
  // node each opening), so typing never reloads it.
  const latest = useRef({ initial, images });
  latest.current = { initial, images };
  const attach = useCallback((el: HTMLDivElement | null) => {
    editor.current = el;
    if (el) {
      el.innerHTML = markdownToEditorHtml(latest.current.initial, latest.current.images);
      try {
        document.execCommand('defaultParagraphSeparator', false, 'p');
      } catch {
        // an older browser: divs are read as paragraphs anyway
      }
    }
  }, []);

  const touch = () => setDirty(true);
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const b = (e.target as Element).closest?.('.rm');
    if (b) {
      e.preventDefault();
      b.closest('figure')?.remove();
      touch();
    }
  };

  const save = () => {
    const el = editor.current;
    if (!el || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    onSave(editorMarkdown(el))
      .then(onClose)
      .catch((e) => setError((e as Error)?.message ?? 'Could not save the plan.'))
      .finally(() => setBusy(false));
  };

  // ×, Esc, the mask: straight out when nothing changed, else ask about the edits.
  const leave = () => {
    if (busy) {
      return;
    }
    if (dirty) {
      setAsking(true);
    } else {
      onClose();
    }
  };

  return (
    <>
      <Modal
        open={open}
        title="Edit Plan"
        onCancel={leave}
        width={820}
        destroyOnClose
        closable={!busy}
        footer={[
          <Button key="discard" onClick={onClose} disabled={busy}>
            Discard
          </Button>,
          <Button key="save" type="primary" onClick={save} disabled={!dirty} loading={busy}>
            Save
          </Button>,
        ]}
      >
        {error && <ErrorLine>{error}</ErrorLine>}
        <Editor
          ref={attach}
          contentEditable
          suppressContentEditableWarning
          data-placeholder="Write the plan"
          onInput={touch}
          onClick={onClick}
          aria-label="Plan"
        />
      </Modal>
      <Modal
        open={asking}
        title="Save changes to the plan?"
        okText="Save"
        cancelText="Discard"
        closable={false}
        maskClosable={false}
        keyboard={false}
        onOk={() => {
          setAsking(false);
          save();
        }}
        onCancel={() => {
          setAsking(false);
          onClose();
        }}
      >
        Your edits have not been saved.
      </Modal>
    </>
  );
};

export default PlanEditorModal;
