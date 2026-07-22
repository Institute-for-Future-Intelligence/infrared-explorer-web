import { Fragment, useEffect, useRef, useState, type ComponentType, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, ConfigProvider, Input, Tooltip, type GetRef } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  LoadingOutlined,
  MinusOutlined,
  RobotOutlined,
  SendOutlined,
} from '@ant-design/icons';
import Draggable, { type DraggableData, type DraggableEvent, type DraggableProps } from 'react-draggable';
import styled from 'styled-components';
import useCommonStore from '../../stores/common';
import { isStaff } from '../../utils/staff';
import { markdownToHtml } from '../../utils/markdown';
import { useIsPhone } from '../../hooks/useIsMobile';
import { useAgentChat } from './useAgentChat';

// react-draggable's props are all flagged required under this TS setup; the codebase casts to a partial
// component type (mirrors thermometer.tsx) so only the props we pass are required.
const DraggableBox = Draggable as unknown as ComponentType<Partial<DraggableProps>>;

// Default width/height of the floating panel (also used to seed its bottom-right start position).
const PANEL_W = 380;
const PANEL_H = 560;

// Fixed bottom-right container that holds the collapsed FAB. The open panel is itself position:fixed, so
// it floats free of this box (dragged/resized). z-index sits above the page/header (10) but at the
// sidebar/cookie tier so app modals still stack over it.
const Root = styled.div`
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;

  .ai-fab {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
  }

  .ai-panel {
    position: fixed;
    display: flex;
    flex-direction: column;
    width: ${PANEL_W}px;
    height: min(${PANEL_H}px, calc(100dvh - 120px));
    min-width: 300px;
    min-height: 340px;
    max-width: 96vw;
    max-height: 90dvh;
    background: var(--ifi-panel);
    border: 1px solid #ededed;
    border-radius: 14px;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.2);
    overflow: hidden;
  }
  /* Desktop/tablet: draggable (by the header) + resizable from the bottom-right corner. Draggable's
     transform positions it, so anchor at top-left and let resize grow it down-right. */
  .ai-panel.floating {
    top: 0;
    left: 0;
    resize: both;
  }
  /* Phone: a fixed bottom sheet filling most of the screen — no drag/resize. */
  .ai-panel.mobile {
    left: 12px;
    bottom: 12px;
    width: calc(100vw - 24px);
    height: calc(100dvh - 90px);
  }

  .ai-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: var(--ifi-teal);
    color: #fff;
    cursor: move;
  }
  .ai-head .ai-title {
    flex: 1;
    font-weight: 600;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ai-head .ant-btn {
    color: #fff;
    cursor: pointer;
  }
  .ai-head .ant-btn:hover {
    color: #eafafa;
  }

  .ai-thread {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 14px;
    color: var(--ifi-ink);
  }
  .ai-empty {
    color: #999;
    font-size: 13px;
    margin: auto 4px;
    text-align: center;
  }

  .ai-msg {
    max-width: 85%;
    padding: 8px 11px;
    border-radius: 12px;
    line-height: 1.45;
    word-break: break-word;
  }
  .ai-msg.user {
    align-self: flex-end;
    background: #e6f4f4;
    border-bottom-right-radius: 4px;
    white-space: pre-wrap;
  }
  .ai-msg.assistant {
    align-self: flex-start;
    background: #f5f5f5;
    border-bottom-left-radius: 4px;
  }
  .ai-msg.error {
    background: #fff1f0;
    color: #cf1322;
  }
  /* Markdown answer body — tightened so it reads cleanly in the narrow column (matches qaPanel). */
  .ai-msg.assistant p {
    margin: 4px 0;
  }
  .ai-msg.assistant p:first-child {
    margin-top: 0;
  }
  .ai-msg.assistant p:last-child {
    margin-bottom: 0;
  }
  .ai-msg.assistant ul,
  .ai-msg.assistant ol {
    margin: 4px 0;
    padding-left: 20px;
  }
  .ai-msg.assistant h4,
  .ai-msg.assistant h5 {
    margin: 8px 0 4px;
  }
  .ai-msg.assistant code {
    background: #ececec;
    padding: 0 4px;
    border-radius: 4px;
  }
  .ai-msg.assistant a {
    color: var(--ifi-teal-dark);
    text-decoration: underline;
    cursor: pointer;
  }

  /* Tool-activity chip: what the assistant is doing (open experiment, read data, …). */
  .ai-tool {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--ifi-text-tertiary);
    padding: 0 2px;
  }
  .ai-tool.done .ai-tool-ic {
    color: var(--ifi-teal);
  }
  .ai-tool.error {
    color: #cf1322;
  }

  .ai-thinking {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #999;
    font-size: 13px;
  }

  .ai-foot {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid #f0f0f0;
  }
  .ai-foot .ant-input {
    border-radius: 8px;
  }
  .ai-cmd-btn {
    flex: 0 0 auto;
    height: 32px;
    min-width: 30px;
    padding: 0 8px;
    font-weight: 700;
    color: var(--ifi-text-secondary);
  }

  /* Slash-command menu, floating above the input. */
  .ai-foot-wrap {
    position: relative;
  }
  .ai-cmd-menu {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: calc(100% - 2px);
    max-height: 240px;
    overflow-y: auto;
    background: var(--ifi-panel);
    border: 1px solid #e6e6e6;
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
    padding: 4px;
    z-index: 5;
  }
  .ai-cmd-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
  }
  .ai-cmd-item.active {
    background: #e6f4f4;
  }
  .ai-cmd-name {
    font-weight: 600;
    color: var(--ifi-teal-dark);
    font-size: 13px;
    white-space: nowrap;
  }
  .ai-cmd-desc {
    color: var(--ifi-text-tertiary);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Section header inside the command menu (e.g. "Model", "Commands"), mirroring the app's palette. */
  .ai-cmd-group {
    padding: 6px 8px 2px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ifi-text-tertiary);
  }
  .ai-cmd-group:not(:first-child) {
    border-top: 1px solid #f0f0f0;
    margin-top: 4px;
  }
`;

const GREETING =
  'Hi! I’m your Lab Assistant. Ask me about thermal physics or tell me what to do — e.g. “open the ice-cube experiment” or “how did the temperature change in this clip?” Type / for commands.';

// Slash commands (Claude-Code style): quick shortcuts shown when the user types "/" or clicks the button.
// `send` fires a fixed prompt immediately; `fill` drops a prompt prefix in the input to complete; `action`
// runs a local widget action. These are natural-language shortcuts the agent handles with its tools.
interface SlashCommand {
  name: string;
  description: string;
  group?: string; // section header shown above the first command of each group
  send?: string;
  fill?: string;
  action?: 'clear';
}
const COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: 'What can the Lab Assistant do?',
    group: 'Commands',
    send: 'What can you help me with? List your main abilities briefly.',
  },
  { name: 'search', description: 'Search experiments by keyword', fill: 'Find experiments about ' },
  { name: 'open', description: 'Open an experiment by name', fill: 'Open the experiment ' },
  { name: 'my-experiments', description: 'Go to my experiments', send: 'Go to my experiments.' },
  { name: 'recent', description: 'Go to recently viewed', send: 'Go to recently viewed experiments.' },
  { name: 'classroom', description: 'Go to the classroom', send: 'Go to the classroom.' },
  { name: 'home', description: 'Go to the home gallery', send: 'Go to the home gallery.' },
  {
    name: 'data',
    description: 'Summarize this experiment’s data',
    send: 'Summarize how the temperatures changed in this experiment, with the key numbers.',
  },
  { name: 'thermometers', description: 'List the thermometers', send: 'List the thermometers on this experiment.' },
  { name: 'add-thermometer', description: 'Add a thermometer', fill: 'Add a thermometer ' },
  { name: 'seek', description: 'Jump to a time', fill: 'Jump to ' },
  { name: 'play', description: 'Play the video', send: 'Play the video.' },
  { name: 'pause', description: 'Pause playback', send: 'Pause.' },
  { name: 'unit', description: 'Switch temperature unit (°C / °F)', fill: 'Switch the temperature unit to ' },
  { name: 'annotate', description: 'Add an annotation', fill: 'Add an annotation: ' },
  { name: 'annotations', description: 'List the annotations', send: 'List the annotations.' },
  { name: 'clear', description: 'Clear this conversation', action: 'clear' },
];

/**
 * Lab Assistant chat widget, mounted once in the app Layout so it floats on every page. It runs an agent
 * turn loop (useAgentChat) that can navigate + read data via client-side tools and render Markdown
 * answers. On desktop/tablet the panel is a draggable (by its header) + resizable (bottom-right corner)
 * floating window; on phones it's a fixed bottom sheet. Staff-gated (intofuture.org) — renders nothing
 * for everyone else. The conversation lives in the hook's state/ref; the Layout stays mounted across
 * navigation, so the thread survives route changes (e.g. when the assistant opens an experiment).
 */
const AiChatWidget = () => {
  const user = useCommonStore((state) => state.user);
  const navigate = useNavigate();
  const isPhone = useIsPhone();
  const { items, busy, send, clear } = useAgentChat();

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  // Dragged position of the floating panel, persisted across minimize/restore (null = start bottom-right).
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const nodeRef = useRef<HTMLDivElement>(null);
  // Slash-command menu state.
  const [cmdIndex, setCmdIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false); // closed by an outside click until re-opened
  const inputRef = useRef<GetRef<typeof Input.TextArea>>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Keep the newest item in view as the thread grows / a reply lands.
  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, busy, open]);

  // Slash-command menu: shows when the input starts with "/", filtering the command list by what follows.
  const inSlash = input.startsWith('/');
  const query = inSlash ? input.slice(1).toLowerCase().trim() : '';
  const commands = inSlash
    ? COMMANDS.filter((c) => c.name.includes(query) || c.description.toLowerCase().includes(query))
    : [];
  const showMenu = inSlash && commands.length > 0 && !menuDismissed;
  const highlighted = Math.min(cmdIndex, Math.max(0, commands.length - 1));

  // Keep the highlighted command scrolled into view during keyboard navigation.
  useEffect(() => {
    if (showMenu) menuRef.current?.querySelector('.ai-cmd-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [cmdIndex, showMenu]);

  // Close the command menu on a click outside it (and outside the input row); typing / refocusing / the
  // "/" button re-open it. Deferred so the same click that opened it doesn't immediately close it.
  useEffect(() => {
    if (!showMenu) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('.ai-cmd-menu, .ai-foot')) return;
      setMenuDismissed(true);
    };
    const id = window.setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [showMenu]);

  // Staff-only for now (mirrors the server gate). Rendering nothing avoids a dead FAB for other users.
  if (!isStaff(user)) return null;

  const onSend = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    void send(text);
  };

  // Run a slash command: send a fixed prompt, drop a prompt prefix in the input to complete, or a local action.
  const pickCommand = (c: SlashCommand) => {
    if (c.action === 'clear') {
      clear();
      setInput('');
    } else if (c.send) {
      setInput('');
      void send(c.send);
    } else if (c.fill != null) {
      setInput(c.fill);
      setCmdIndex(0);
      inputRef.current?.focus();
    }
  };

  // The "/" button: open the command menu by seeding the input with a slash and focusing it.
  const openCommandMenu = () => {
    setInput('/');
    setCmdIndex(0);
    setMenuDismissed(false);
    inputRef.current?.focus();
  };

  // Experiment links in answers ([Title](/experiments/<id>), or the pre-migration #/experiments/<id>
  // form in saved threads) open in-app via the router, keeping the SPA state (and the widget) intact
  // rather than doing a full page load.
  const onThreadClick = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    const match = anchor?.getAttribute('href')?.match(/\/experiments\/([^/?#]+)/);
    if (match) {
      e.preventDefault();
      navigate(`/experiments/${match[1]}`);
    }
  };

  // Show a "Thinking…" line only while waiting for the next output — hide it once the answer is
  // streaming into an assistant bubble or a tool chip is already spinning.
  const last = items[items.length - 1];
  const showThinking = busy && (!last || last.kind === 'user' || (last.kind === 'tool' && last.state !== 'running'));

  // Start position for the floating window: the bottom-right corner (clamped on-screen).
  const startPos = () => ({
    x: Math.max(12, window.innerWidth - PANEL_W - 24),
    y: Math.max(12, window.innerHeight - PANEL_H - 24),
  });

  const panel = (
    <div className={`ai-panel ${isPhone ? 'mobile' : 'floating'}`} ref={nodeRef}>
      <div className="ai-head">
        <span className="ai-title">
          <RobotOutlined />
          Lab Assistant
        </span>
        {items.length > 0 && (
          <Tooltip title="Clear conversation">
            <Button type="text" size="small" icon={<DeleteOutlined />} onClick={clear} />
          </Tooltip>
        )}
        <Tooltip title="Minimize">
          <Button type="text" size="small" icon={<MinusOutlined />} onClick={() => setOpen(false)} />
        </Tooltip>
      </div>

      <div className="ai-thread" ref={threadRef} onClick={onThreadClick}>
        {items.length === 0 && !busy ? (
          <div className="ai-empty">{GREETING}</div>
        ) : (
          items.map((it) => {
            if (it.kind === 'user')
              return (
                <div className="ai-msg user" key={it.id}>
                  {it.text}
                </div>
              );
            if (it.kind === 'assistant')
              return (
                <div
                  className="ai-msg assistant"
                  key={it.id}
                  dangerouslySetInnerHTML={{ __html: markdownToHtml(it.text) }}
                />
              );
            if (it.kind === 'error')
              return (
                <div className="ai-msg assistant error" key={it.id}>
                  {it.text}
                </div>
              );
            // tool chip
            return (
              <div className={`ai-tool ${it.state}`} key={it.id}>
                <span className="ai-tool-ic">
                  {it.state === 'running' ? (
                    <LoadingOutlined spin />
                  ) : it.state === 'error' ? (
                    <CloseCircleOutlined />
                  ) : (
                    <CheckCircleOutlined />
                  )}
                </span>
                {it.label}
              </div>
            );
          })
        )}
        {showThinking && (
          <div className="ai-thinking">
            <LoadingOutlined spin />
            Thinking…
          </div>
        )}
      </div>

      <div className="ai-foot-wrap">
        {showMenu && (
          <div className="ai-cmd-menu" ref={menuRef}>
            {commands.map((c, i) => {
              // A section header shows above the first (visible) command of each named group.
              const showHeader = !!c.group && (i === 0 || commands[i - 1].group !== c.group);
              return (
                <Fragment key={c.name}>
                  {showHeader && <div className="ai-cmd-group">{c.group}</div>}
                  <div
                    className={`ai-cmd-item ${i === highlighted ? 'active' : ''}`}
                    onMouseEnter={() => setCmdIndex(i)}
                    onMouseDown={(e) => {
                      // Pick on mousedown + preventDefault so a `fill` command keeps input focus for typing.
                      e.preventDefault();
                      pickCommand(c);
                    }}
                  >
                    <span className="ai-cmd-name">/{c.name}</span>
                    <span className="ai-cmd-desc">{c.description}</span>
                  </div>
                </Fragment>
              );
            })}
          </div>
        )}
        <div className="ai-foot">
          <Tooltip title="Commands (/)">
            <Button className="ai-cmd-btn" size="small" onClick={openCommandMenu}>
              /
            </Button>
          </Tooltip>
          <Input.TextArea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setCmdIndex(0);
              setMenuDismissed(false);
            }}
            onFocus={() => setMenuDismissed(false)}
            placeholder="Ask me anything, or type / for commands…"
            autoSize={{ minRows: 1, maxRows: 4 }}
            onKeyDown={(e) => {
              const composing = (e.nativeEvent as { isComposing?: boolean }).isComposing;
              // While the command menu is open, the arrows navigate it and Enter/Tab picks (Esc closes).
              if (showMenu && !composing) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setCmdIndex((i) => (i + 1) % commands.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setCmdIndex((i) => (i - 1 + commands.length) % commands.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  pickCommand(commands[highlighted]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setInput('');
                  return;
                }
              }
              // Enter sends; Shift+Enter is a newline. Ignore Enter mid-IME-composition (e.g. Chinese).
              if (e.key === 'Enter' && !e.shiftKey && !composing) {
                e.preventDefault();
                onSend();
              }
            }}
          />
          <Button type="primary" icon={<SendOutlined />} loading={busy} disabled={!input.trim()} onClick={onSend} />
        </div>
      </div>
    </div>
  );

  return (
    // Tint antd's primary colour to the brand teal (matches --ifi-teal in index.css) so the FAB, the
    // send button, and the input focus ring match the app instead of antd's default blue.
    <ConfigProvider theme={{ token: { colorPrimary: 'rgba(0, 140, 140, 1)' } }}>
      <Root>
        {!open ? (
          <Tooltip title="Lab Assistant" placement="left">
            <Button type="primary" className="ai-fab" icon={<RobotOutlined />} onClick={() => setOpen(true)} />
          </Tooltip>
        ) : isPhone ? (
          panel
        ) : (
          // Drag by the header (not its buttons); keep the window within the viewport.
          <DraggableBox
            handle=".ai-head"
            cancel=".ai-head .ant-btn"
            bounds="body"
            nodeRef={nodeRef}
            defaultPosition={pos ?? startPos()}
            onStop={(_e: DraggableEvent, d: DraggableData) => setPos({ x: d.x, y: d.y })}
          >
            {panel}
          </DraggableBox>
        )}
      </Root>
    </ConfigProvider>
  );
};

export default AiChatWidget;
