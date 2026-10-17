/*
 * The message box at the bottom of Discuss: a "+" (one row, Add from My
 * Experiments — the website has no camera), a text area (Enter sends,
 * Shift+Enter breaks the line, 8000 characters as the server takes), Send,
 * and Stop while a turn runs. The captures waiting to go with the next
 * message sit in a tray above the box (AttachmentTray, given as `tray`);
 * captures alone, with no words, can be sent. Above them: the quota line
 * when the account is near its limit (core/types quotaLine), and the reason
 * the box is off when it is. Up and Down step through the messages already
 * sent in the project, as in a terminal (see onKeyDown).
 */

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Dropdown, Input } from 'antd';
import { Plus, SendHorizontal, Square } from 'lucide-react';
import styled from 'styled-components';

const Box = styled.div`
  flex: none;
  padding: 8px 12px 10px;
  border-top: 1px solid var(--ifi-stroke-1);
  background: var(--ifi-panel);

  .cp-quota,
  .cp-blocked {
    padding: 0 6px 6px;
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--ifi-text-tertiary);
  }
  .cp-blocked {
    color: var(--ifi-text-secondary);
  }
  .cp-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .cp-row .ant-input {
    flex: 1;
    font-size: 15px;
    line-height: 1.45;
    resize: none;
  }
`;

const Composer = ({
  value,
  onChange,
  history,
  onSend,
  onStop,
  onAddFromExperiments,
  canAttach,
  tray,
  running,
  canSend,
  blocked,
  quotaLine,
}: {
  value: string;
  onChange: (v: string) => void;
  /** The words of the messages sent so far, oldest first. */
  history: string[];
  onSend: () => void;
  onStop: () => void;
  /** Open the picker of the account's experiments. */
  onAddFromExperiments: () => void;
  /** A capture may be added right now. */
  canAttach: boolean;
  /** The captures waiting to go with the message (AttachmentTray), or nothing. */
  tray?: ReactNode;
  running: boolean;
  canSend: boolean;
  /** Why nothing can be sent right now (the box is off with this line), or null. */
  blocked: string | null;
  quotaLine: string | null;
}) => {
  // The sent message on show (its place in `history`) and what was in the
  // box before the first step back, which Down past the newest brings back.
  const recall = useRef<{ index: number; draft: string } | null>(null);
  const step = (dir: -1 | 1) => {
    const r = recall.current;
    if (dir < 0) {
      const index = r ? r.index - 1 : history.length - 1;
      if (index >= 0) {
        recall.current = { index, draft: r ? r.draft : value };
        onChange(history[index]);
      }
    } else if (r) {
      if (r.index + 1 < history.length) {
        recall.current = { ...r, index: r.index + 1 };
        onChange(history[r.index + 1]);
      } else {
        recall.current = null;
        onChange(r.draft);
      }
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) {
        onSend();
      }
      return;
    }
    const up = e.key === 'ArrowUp';
    if (
      (!up && e.key !== 'ArrowDown') ||
      e.shiftKey ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey ||
      e.nativeEvent.isComposing ||
      history.length === 0
    ) {
      return;
    }
    // While a recalled message stands as it came back, every press steps on.
    const r = recall.current;
    if (r && value === history[r.index]) {
      e.preventDefault();
      step(up ? -1 : 1);
      return;
    }
    // Edited (or sent, or cleared): what is in the box is the text now.
    recall.current = null;
    // Up steps back only once the caret cannot go any higher — an empty box,
    // or the top line, soft-wrapped lines included: the key moves the caret
    // as usual, and if it stayed put, the previous message comes up.
    if (up) {
      const el = e.currentTarget;
      const { selectionStart, selectionEnd } = el;
      window.setTimeout(() => {
        if (el.selectionStart === selectionStart && el.selectionEnd === selectionEnd) {
          step(-1);
        }
      });
    }
  };
  return (
    <Box>
      {quotaLine && !running && <div className="cp-quota">{quotaLine}</div>}
      {blocked && <div className="cp-blocked">{blocked}</div>}
      {tray}
      <div className="cp-row">
        <Dropdown
          trigger={['click']}
          disabled={!canAttach}
          menu={{
            items: [{ key: 'experiments', label: 'Add from My Recordings' }],
            onClick: ({ key }) => {
              if (key === 'experiments') {
                onAddFromExperiments();
              }
            },
          }}
        >
          <Button icon={<Plus size={16} />} disabled={!canAttach} aria-label="Add Captures" title="Add Captures" />
        </Dropdown>
        <Input.TextArea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Write a message"
          maxLength={8000}
          autoSize={{ minRows: 1, maxRows: 6 }}
          disabled={blocked != null}
          aria-label="Message"
        />
        {running ? (
          <Button icon={<Square size={15} />} onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button type="primary" icon={<SendHorizontal size={15} />} disabled={!canSend} onClick={onSend}>
            Send
          </Button>
        )}
      </div>
    </Box>
  );
};

export default Composer;
