/**
 * A recording's twin build as a conversation (docs/digital-twin-plan.md §44.2, §44.8): the
 * camera-motion check's line, the thread — the model's words, its tool steps and the pictures its
 * tools return, drawn by the Ask AI thread's own Conversation — the notices (stopped, failed, saved)
 * and, when the owner may write, a box to tell the AI what to change — about the parts they selected in
 * the view, which go with the message (§28, §44.10) — and the conversation goes on and the next finish
 * replaces the twin. The thread keeps every round — the owner's messages and the model's replies — but
 * the model's steps show only while it works: once the twin is saved they go, and the reply stays
 * (§44.10). The build form shows it in place of the form while a build runs (the card is the build,
 * §28.6); under a twin on screen it is About's conversation.
 */
import { useState } from 'react';
import { Alert, Button, Input } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';
import type { Experiment, TwinSelectionItem } from '../../../../types';
import useCommonStore from '../../../../stores/common';
import { isDeveloper } from '../../../../utils/staff';
import Conversation from '../../ai/RecordingReplies';
import { TWIN_INSTRUCTIONS_MAX } from '../twinModels';
import { dismissTwinAgentOutcome, sendTwinAgentMessage, useTwinAgentView } from './twinAgentRunner';

/** The line over the box while something is selected (§28.7): how many things the message is about. */
const selectedCount = (n: number) => `${n} ${n === 1 ? 'part' : 'parts'} selected in the view`;

const TwinAgentThread = ({
  experiment,
  hadTwin,
  canSend = false,
  selection = [],
  onSent,
}: {
  experiment: Experiment;
  hadTwin: boolean;
  /** The owner may write to the agent (a twin on screen, nothing else running). */
  canSend?: boolean;
  /** What the owner selected in the view (§44.10): goes with the next message, which is about it. */
  selection?: TwinSelectionItem[];
  /** A message went: the host clears the selection it carried. */
  onSent?: () => void;
}) => {
  const expId = experiment.id;
  const v = useTwinAgentView(expId);
  // Error details are for the developer's account alone (user, 2026-10-30): the tool failures in the steps,
  // and what a failed build said. Anyone else sees that it did not finish, and a camera that moved as is.
  const developer = isDeveloper(useCommonStore((s) => s.user));
  const errorLine = !v.error ? null : developer || v.motion?.kind === 'moved' ? v.error : 'The build did not finish.';
  const [draft, setDraft] = useState('');
  const dismiss = () => dismissTwinAgentOutcome(expId);
  // The opening message shows as the owner's request alone (twinAgentRunner): with none, no bubble.
  // Nor the model's turns of a round that saved a twin: About tells what it built and assumed.
  const turns = v.turns.filter(
    (t) => (t.role !== 'user' || t.text?.trim() || t.selection?.length) && !v.hiddenSeqs.includes(t.seq),
  );
  const conversation = v.running || v.turns.length > 0 || !!v.outgoing;
  const send = () => {
    const text = draft.trim();
    if (!text || v.running) return;
    setDraft('');
    void sendTwinAgentMessage(experiment, text, selection);
    onSent?.();
  };
  return (
    <div className="twin-agent">
      {v.running && v.progress && (
        <div className="twin-status twin-status-live">
          <LoadingOutlined spin />
          <span>{v.progress}</span>
        </div>
      )}
      {conversation && (
        <div className="twin-agent-thread">
          <Conversation
            turns={turns}
            images={v.images}
            model={v.model}
            live={{ running: v.running, liveText: v.liveText, status: v.status, preview: null }}
            outgoing={v.outgoing}
            showFailures={developer}
            keepSteps={false}
            // The twin is saved: the steps go now, while the model still writes its closing words.
            hideSteps={v.finished}
            onOpenImage={(i) => window.open(i.url, '_blank', 'noopener')}
          />
        </div>
      )}
      {v.stopped && (
        <Alert
          type="info"
          showIcon
          closable
          message={hadTwin ? 'Stopped — the twin was left as it was.' : 'Stopped — nothing was built.'}
          onClose={dismiss}
        />
      )}
      {errorLine && <Alert type="error" showIcon closable message={errorLine} onClose={dismiss} />}
      {/* No notice when the twin is saved (user, 2026-10-29): the viewer showing it says so. */}
      {canSend && !v.running && (
        <div className="twin-revise-compose twin-agent-compose">
          <div className="twin-revise-lead">
            {v.turns.length
              ? 'Tell the AI what to change; click parts in the view to say which.'
              : 'Tell the AI what to change: it measures the recording and builds the twin again. Click parts in the view to say which.'}
          </div>
          {selection.length > 0 && (
            <div className="twin-revise-selected" aria-live="polite">
              {selectedCount(selection.length)}
            </div>
          )}
          <Input.TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoSize={{ minRows: 2, maxRows: 6 }}
            maxLength={TWIN_INSTRUCTIONS_MAX}
            placeholder={selection.length > 0 ? 'Say what to change about the selected parts.' : undefined}
            aria-label="What to change about the twin"
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter starts a new line — never while an input method is composing (the
              // Enter that picks a Chinese or Japanese candidate; Safari reports it with keyCode 229).
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="twin-revise-links">
            <Button type="primary" size="small" disabled={!draft.trim()} onClick={send}>
              Send
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default TwinAgentThread;
