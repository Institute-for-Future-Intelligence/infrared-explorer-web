import { useEffect, useRef, useState } from 'react';
import ContentEditable, { ContentEditableEvent } from 'react-contenteditable';
import { Button } from 'antd';
import { CheckOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import styled from 'styled-components';
import useCommonStore from '../../../stores/common';
import { updateDescription } from '../../../services/experiments';

interface Props {
  expId: string;
  /** The section's current text (the description, the findings, …). */
  value: string;
  ownerId?: string;
  /** Persist the edited text (defaults to the description writer). */
  onSave?: (expId: string, value: string) => Promise<void>;
  /** Which cached-experiment field to patch on save, so the store reflects the edit immediately. */
  storeField?: 'description' | 'findings';
  /** Edit-box placeholder shown while the owner is editing an empty box. */
  placeholder?: string;
  /** Owner trigger labels: the add-when-empty text (also its title), the edit text, and the edit title. */
  addLabel?: string;
  editLabel?: string;
  editTitle?: string;
}

// "WRITE HERE" is a CSS placeholder (not real content) so it never gets saved into the
// description; :empty matches whenever the box has no text. We only feed the placeholder while
// the owner is editing — a read-only render (viewer, or the owner's own display mode) gets none.
//
// Height: now that the analyzer scrolls the whole page (the description lives below the fold, not in a
// fixed-height panel), the editable box grows with its content and rides the page scroll — a comfortable
// min-height for a fresh edit, no max clamp. A read-only box hugs its content. $editable is transient
// (styled-components consumes it, not forwarded to the DOM).
const Editable = styled(ContentEditable)<{ $editable: boolean }>`
  font-size: 15px;
  line-height: 1.6;
  white-space: pre-wrap;
  /* pre-wrap only breaks at whitespace, so a long unbreakable token (a spaceless string, a pasted
     path/formula) would overflow the panel and trigger a horizontal scrollbar. Force such runs to
     break so the text stays inside the box. */
  overflow-wrap: break-word;
  ${({ $editable }) =>
    $editable
      ? `
    overflow-y: visible;
    height: auto;
    min-height: 140px;
    max-height: none;
  `
      : `
    overflow-y: visible;
    height: auto;
    min-height: 0;
    max-height: none;
  `}
  &:empty::before {
    content: attr(data-placeholder);
    color: gray;
  }
  a {
    color: var(--ifi-teal-dark);
    text-decoration: underline;
    word-break: break-word;
  }
`;

// The owner's always-visible, low-key entry into edit mode, sitting just under the read-only text
// (or standing alone as "Add a description" when there's none yet). Muted by default so it never
// competes with the content, brightening to the brand blue on hover — discoverable without a
// hover-hunt, and the same control whether or not a description exists.
const EditTrigger = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  padding: 2px 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  font-size: 13px;
  line-height: 1.4;
  color: var(--ifi-text-tertiary);
  cursor: pointer;
  transition:
    color 0.2s,
    background 0.2s;
  &:hover {
    color: #1677ff;
    background: rgba(0, 0, 0, 0.04);
  }
`;

// Cancel + Save, right-aligned under the edit box.
const ActionRow = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
`;

// Turn bare URLs into clickable links for the read-only render. We only do this when the box is NOT
// editable: the editable owner keeps the raw plain text so a save never persists injected <a> markup.
// rel="noopener noreferrer" so the opened page can't reach back via window.opener.
const URL_REGEX = /(https?:\/\/[^\s<]+)/g;
const linkify = (text: string) =>
  text.replace(URL_REGEX, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

// Whether the content is visually empty. A contenteditable can leave HTML-only leftovers (a stray <br>,
// an empty <div>) after the box is cleared — a non-empty string that renders blank — so a plain
// `!s.trim()` would read them as "has content" and show the Edit prompt over an empty section. Strip
// tags + &nbsp; before trimming so a blank section shows the same "add" prompt as one that never had any.
const isBlankContent = (s: string) =>
  !s
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .trim();

const Content = ({
  expId,
  value,
  ownerId,
  onSave = updateDescription,
  storeField = 'description',
  placeholder = 'WRITE HERE',
  addLabel = 'Add a description',
  editLabel = 'Edit',
  editTitle = 'Edit description',
}: Props) => {
  const user = useCommonStore((state) => state.user);
  const isOwner = !!user && user.id === ownerId;

  // The rendered html is React state (the canonical react-contenteditable pattern): keeping it in
  // sync with what the box shows lets the caret survive typing (its shouldComponentUpdate skips the
  // DOM write when html already equals innerHTML) AND lets an external value change — e.g. the
  // analyzer re-fetching the experiment on entry — actually re-render the box. A ref would never
  // reflect that post-mount update, so the old text would linger until a full remount.
  const [html, setHtml] = useState(value);
  // The last value we persisted, so a flush only writes when the text actually changed. Also the
  // value Cancel reverts an in-progress draft back to.
  const saved = useRef(value);

  // Owners start on a read-only view of their description and opt into editing, instead of sitting
  // permanently in the edit box. Content is keyed by experiment id upstream, so this resets to the
  // display view whenever the analyzer navigates to a different experiment (a fresh remount).
  const [editing, setEditing] = useState(false);
  const editRef = useRef<HTMLDivElement>(null);

  // Re-sync when the value prop changes (different experiment, or a fresh fetch of this one).
  useEffect(() => {
    setHtml(value);
    saved.current = value;
  }, [value]);

  // Focus the box and drop the caret at the end when entering edit mode, so the owner can type
  // straight away instead of having to click into it first.
  useEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editing]);

  // Persist the current edit (idempotent: the `saved` guard skips an unchanged write). Also patch
  // the cached experiment in the store so the card list and the analyzer (which both read from
  // experimentMap) show the new text immediately, instead of lagging a navigation behind Firestore.
  const flush = () => {
    if (!isOwner) return;
    const next = html.trim();
    // Compare trimmed-to-trimmed. `saved.current` seeds from the raw description, which may carry
    // surrounding whitespace/newlines; a bare `next === saved.current` would then read an untouched
    // view as a change and fire updateDescription on mere open→close — bumping `updatedAt` (via
    // serverTimestamp) and floating the clip to the top of the owner's "Recently updated" list.
    // Only a real edit to the text should write.
    if (next === saved.current.trim()) return;
    saved.current = next;
    onSave(expId, next).catch((err) => console.error('failed to save section', err));
    const exp = useCommonStore.getState().experimentMap.get(expId);
    if (exp) useCommonStore.getState().setExperiment(expId, { ...exp, [storeField]: next });
  };

  const handleChange = (e: ContentEditableEvent) => setHtml(e.target.value);

  // Save on unmount as a safety net, not the primary path: clicking a link to leave the analyzer
  // removes the box from the DOM, and browsers don't reliably fire `blur` then — so an in-progress
  // draft is committed rather than lost. Save/Cancel are the explicit, in-session controls; there is
  // deliberately no save-on-blur, so Cancel can revert a draft without a blur beating it to a write.
  // flushRef keeps the cleanup pointed at the latest html closure.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);

  const save = () => {
    flush();
    setEditing(false);
  };

  // Discard the draft: revert to the last persisted text and return to the display view.
  const cancel = () => {
    setHtml(saved.current);
    setEditing(false);
  };

  // Shared read-only render (viewer, and the owner's display mode): linkified, hugs its content.
  const readOnly = (
    <Editable
      className="experiment-description"
      $editable={false}
      html={linkify(html)}
      disabled
      data-placeholder=""
      onChange={handleChange}
      style={{ paddingLeft: '0px', color: 'black' }}
    />
  );

  // ---- viewer / non-owner: read-only only (nothing for a blank-but-nonempty leftover) ----
  if (!isOwner) return isBlankContent(html) ? null : readOnly;

  // ---- owner, edit mode: the editable box + Cancel / Save ----
  if (editing) {
    return (
      <div>
        <Editable
          className="experiment-description"
          $editable
          innerRef={editRef}
          html={html}
          disabled={false}
          data-placeholder={placeholder}
          onChange={handleChange}
          style={{ paddingLeft: '4px', color: 'black' }}
        />
        <ActionRow>
          <Button size="small" onClick={cancel}>
            Cancel
          </Button>
          <Button type="primary" size="small" icon={<CheckOutlined />} onClick={save}>
            Save
          </Button>
        </ActionRow>
      </div>
    );
  }

  // ---- owner, display: the text (when any) + an always-visible Edit / Add-a-description trigger ----
  const empty = isBlankContent(html);
  return (
    <div>
      {!empty && readOnly}
      <EditTrigger type="button" title={empty ? addLabel : editTitle} onClick={() => setEditing(true)}>
        {empty ? <PlusOutlined /> : <EditOutlined />}
        {empty ? addLabel : editLabel}
      </EditTrigger>
    </div>
  );
};

export default Content;
