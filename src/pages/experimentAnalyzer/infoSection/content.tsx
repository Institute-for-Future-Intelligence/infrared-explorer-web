import { useEffect, useRef, useState } from 'react';
import ContentEditable, { ContentEditableEvent } from 'react-contenteditable';
import styled from 'styled-components';
import useCommonStore from '../../../stores/common';
import { updateDescription } from '../../../services/experiments';

interface Props {
  expId: string;
  description: string;
  ownerId?: string;
}

// "WRITE HERE" is a CSS placeholder (not real content) so it never gets saved into the
// description; :empty matches whenever the box has no text. We only feed the placeholder for
// the owner (editable) — a viewer on a description-less experiment sees nothing, not a prompt.
const Editable = styled(ContentEditable)`
  font-size: 14px;
  white-space: pre-wrap;
  overflow-y: auto;
  height: 50%;
  min-height: 20vh;
  max-height: 40vh;
  &:empty::before {
    content: attr(data-placeholder);
    color: gray;
  }
`;

const Content = ({ expId, description, ownerId }: Props) => {
  const user = useCommonStore((state) => state.user);
  const editable = !!user && user.id === ownerId;

  // The rendered html is React state (the canonical react-contenteditable pattern): keeping it in
  // sync with what the box shows lets the caret survive typing (its shouldComponentUpdate skips the
  // DOM write when html already equals innerHTML) AND lets an external description change — e.g. the
  // analyzer re-fetching the experiment on entry — actually re-render the box. A ref would never
  // reflect that post-mount update, so the old text would linger until a full remount.
  const [html, setHtml] = useState(description);
  // The last value we persisted, so a flush only writes when the text actually changed.
  const saved = useRef(description);

  // Re-sync when the description prop changes (different experiment, or a fresh fetch of this one).
  useEffect(() => {
    setHtml(description);
    saved.current = description;
  }, [description]);

  // Persist the current edit (idempotent: the `saved` guard skips an unchanged write). Also patch
  // the cached experiment in the store so the card list and the analyzer (which both read from
  // experimentMap) show the new text immediately, instead of lagging a navigation behind Firestore.
  const flush = () => {
    if (!editable) return;
    const next = html.trim();
    if (next === saved.current) return;
    saved.current = next;
    updateDescription(expId, next).catch((err) => console.error('failed to save description', err));
    const exp = useCommonStore.getState().experimentMap.get(expId);
    if (exp) useCommonStore.getState().setExperiment(expId, { ...exp, description: next });
  };

  const handleChange = (e: ContentEditableEvent) => setHtml(e.target.value);

  // Save on unmount too, not just on blur: clicking a link to leave the analyzer removes the focused
  // box from the DOM, and browsers do NOT reliably fire `blur` then — so a blur-only save would lose
  // the last edit. flushRef keeps the cleanup pointed at the latest html/editable closure.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);

  return (
    <Editable
      className="experiment-description"
      html={html}
      disabled={!editable}
      data-placeholder={editable ? 'WRITE HERE' : ''}
      onChange={handleChange}
      onBlur={flush}
      style={{ paddingLeft: editable ? '4px' : '0px', color: 'black' }}
    />
  );
};

export default Content;
