import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { agentChat, AgentContentBlock, AgentMessage } from '../../services/ai';
import { buildAgentContext, enabledToolsFor, executeAgentTool } from './agentTools';

// One rendered item in the chat thread. Tool chips show what the assistant is doing (open experiment,
// read data, …); user/assistant are the visible turns; error is a failed turn.
export type ChatItem =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string }
  | { id: number; kind: 'tool'; label: string; state: 'running' | 'done' | 'error' }
  | { id: number; kind: 'error'; text: string };

// Client-side guard against a runaway tool loop (the server also caps cost via the rate limit).
const MAX_ROUNDS = 6;

const toolLabel = (name: string, input: Record<string, unknown>): string => {
  switch (name) {
    case 'search_experiments':
      return `Searching experiments: “${String(input.query ?? '')}”`;
    case 'list_my_experiments':
      return 'Listing your experiments';
    case 'open_experiment':
      return 'Opening experiment';
    case 'list_thermometers':
      return 'Reading thermometers';
    case 'read_experiment_data':
      return 'Reading experiment data';
    case 'add_thermometer':
      return 'Adding a thermometer';
    case 'rename_thermometer':
      return 'Renaming a thermometer';
    case 'select_thermometer':
      return 'Selecting a thermometer';
    case 'remove_thermometer':
    case 'remove_all_thermometers':
      return 'Removing thermometers';
    case 'set_temperature_unit':
      return 'Changing the temperature unit';
    case 'seek_to_time':
      return 'Seeking the playhead';
    case 'set_playback':
      return String(input.playing) === 'true' || input.playing === true ? 'Starting playback' : 'Pausing playback';
    case 'navigate_to':
      return `Opening ${String(input.page ?? 'page').replace(/_/g, ' ')}`;
    case 'list_annotations':
      return 'Reading annotations';
    case 'add_annotation':
      return 'Adding an annotation';
    case 'edit_annotation':
      return 'Editing an annotation';
    case 'remove_annotation':
      return 'Removing an annotation';
    default:
      return `Running ${name}`;
  }
};

const agentErrorMessage = (err: unknown): string => {
  const code = (err as { code?: string })?.code;
  if (code === 'functions/resource-exhausted') return 'Usage limit reached. Please try again later.';
  if (code === 'functions/permission-denied') return 'The Lab Assistant is only available to intofuture.org accounts.';
  return (err as { message?: string })?.message || 'Something went wrong. Please try again.';
};

const isText = (b: AgentContentBlock): b is Extract<AgentContentBlock, { type: 'text' }> => b.type === 'text';
const isToolUse = (b: AgentContentBlock): b is Extract<AgentContentBlock, { type: 'tool_use' }> =>
  b.type === 'tool_use';

/**
 * Drives the Lab Assistant turn loop. `apiRef` holds the canonical Anthropic-shaped transcript (the
 * model's source of truth); `items` is the rendered view. On send: append the user message, then loop —
 * call agentChat, render any text, execute any tool_use blocks in the browser, send tool_result blocks
 * back — until the assistant returns a plain-text answer (or MAX_ROUNDS is hit). The widget stays mounted
 * in Layout, so the ref+state survive navigation (e.g. when a tool opens an experiment).
 */
export function useAgentChat() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const apiRef = useRef<AgentMessage[]>([]);
  const idRef = useRef(0);
  const nextId = () => (idRef.current += 1);

  const push = (item: ChatItem) => setItems((prev) => [...prev, item]);
  const setToolState = (id: number, state: 'done' | 'error') =>
    setItems((prev) => prev.map((it) => (it.id === id && it.kind === 'tool' ? { ...it, state } : it)));

  const clear = useCallback(() => {
    apiRef.current = [];
    setItems([]);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      push({ id: nextId(), kind: 'user', text: trimmed });
      apiRef.current.push({ role: 'user', content: trimmed });
      setBusy(true);
      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const ctx = buildAgentContext();
          // Stream the answer text into a single assistant bubble, created on the first delta and updated
          // in place as it grows. A pure tool_use turn streams nothing (the bubble is never created).
          let streamItemId: number | null = null;
          const onText = (full: string) => {
            if (streamItemId === null) {
              const id = nextId();
              streamItemId = id;
              setItems((prev) => [...prev, { id, kind: 'assistant', text: full }]);
            } else {
              const id = streamItemId;
              setItems((prev) =>
                prev.map((it) => (it.id === id && it.kind === 'assistant' ? { ...it, text: full } : it)),
              );
            }
          };
          const turn = await agentChat(apiRef.current, ctx, enabledToolsFor(ctx), onText);
          apiRef.current.push({ role: 'assistant', content: turn.content });

          // Reconcile the streamed bubble with the final joined text (covers any trailing delta), or drop
          // an empty bubble for a pure tool_use turn.
          const answer = turn.content
            .filter(isText)
            .map((b) => b.text)
            .join('\n')
            .trim();
          if (streamItemId !== null) {
            const id = streamItemId;
            if (answer) {
              setItems((prev) =>
                prev.map((it) => (it.id === id && it.kind === 'assistant' ? { ...it, text: answer } : it)),
              );
            } else {
              setItems((prev) => prev.filter((it) => it.id !== id));
            }
          } else if (answer) {
            push({ id: nextId(), kind: 'assistant', text: answer });
          }

          const toolUses = turn.content.filter(isToolUse);
          if (toolUses.length === 0) break; // plain-text answer -> done

          // Execute each requested tool in order, rendering a chip and collecting its tool_result.
          const resultBlocks: AgentContentBlock[] = [];
          for (const tu of toolUses) {
            const input = (tu.input ?? {}) as Record<string, unknown>;
            const chipId = nextId();
            push({ id: chipId, kind: 'tool', label: toolLabel(tu.name, input), state: 'running' });
            const res = await executeAgentTool(tu.name, input, { navigate });
            setToolState(chipId, res.isError ? 'error' : 'done');
            resultBlocks.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: res.content,
              ...(res.isError ? { is_error: true } : {}),
            });
          }
          apiRef.current.push({ role: 'user', content: resultBlocks });

          if (round === MAX_ROUNDS - 1) {
            push({ id: nextId(), kind: 'error', text: 'Stopped after several steps. Ask me to continue if needed.' });
          }
        }
      } catch (err) {
        push({ id: nextId(), kind: 'error', text: agentErrorMessage(err) });
      } finally {
        setBusy(false);
      }
    },
    [busy, navigate],
  );

  return { items, busy, send, clear };
}
