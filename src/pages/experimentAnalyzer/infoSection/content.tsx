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
//
// Height: the owner gets a comfortable fixed edit area (20vh–40vh with its own scroll); a viewer's
// box hugs its content so a short description no longer reserves ~20vh of dead space before the
// Comments divider. $editable is transient (styled-components consumes it, not forwarded to the DOM).
// The mobile override in App.css (.experiment-analyzer .experiment-description) is more specific and
// still wins, so the owner's box also grows naturally on phones.
const Editable = styled(ContentEditable)<{ $editable: boolean }>`
  font-size: 15px;
  line-height: 1.6;
  white-space: pre-wrap;
  ${({ $editable }) =>
    $editable
      ? `
    overflow-y: auto;
    height: 50%;
    min-height: 20vh;
    max-height: 40vh;
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

// Turn bare URLs into clickable links for the read-only viewer. We only do this when the box is NOT
// editable: the editable owner keeps the raw plain text so a save never persists injected <a> markup.
// rel="noopener noreferrer" so the opened page can't reach back via window.opener.
const URL_REGEX = /(https?:\/\/[^\s<]+)/g;
const linkify = (text: string) =>
  text.replace(URL_REGEX, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

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
      $editable={editable}
      html={editable ? html : linkify(html)}
      disabled={!editable}
      data-placeholder={editable ? 'WRITE HERE' : ''}
      onChange={handleChange}
      onBlur={flush}
      style={{ paddingLeft: editable ? '4px' : '0px', color: 'black' }}
    />
  );
};

export default Content;
