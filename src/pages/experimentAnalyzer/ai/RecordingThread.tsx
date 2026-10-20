/*
 * The analyzer's Ask AI tab: the user's own conversation with the AI about this recording, on the app's
 * AI flow (docs/analyzer-ai-app-flow-plan.md). The thread is the user's (one per user and recording,
 * saved on the server and restored when they come back); the model reads the recording through the
 * browser tools (look, run_code) and answers in the conversation; the moments the user attaches from the
 * player (right-click › Ask about this moment, or + Add moment) go with the next message as pictures.
 * The model is picked before the first message and fixed by it (decision C). Any signed-in viewer of the
 * recording may ask (decision E); the server gates consent and quota.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Input, Popconfirm, Select, message } from 'antd';
import styled from 'styled-components';
import { Experiment, MODEL_KEYS, MODEL_LABELS, modelLabel, type QaModel } from '../../../types';
import useCommonStore from '../../../stores/common';
import { isStaff } from '../../../utils/staff';
import { formatDuration } from '../../../utils/helpers';
import ConsentDialog from '../../../labProjects/components/ConsentDialog';
import Lightbox from '../../../labProjects/components/Lightbox';
import { providerNameFor } from '../../../labProjects/consent';
import type { ProjectImage } from '../../../labProjects/core/types';
import { clearThread, recordAiConsent, type RecImage } from '../../../services/recordingAi';
import Conversation from './RecordingReplies';
import {
  aiSupports,
  dismissConsent,
  ensureThread,
  pendingBrowserCalls,
  resendAfterConsent,
  resetThread,
  resumePending,
  retryThread,
  sendThreadMessage,
  setThreadModel,
  setThreadUnsent,
  stopThread,
  useThreadView,
} from './recordingAiRunner';

const Wrap = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  font-size: 14px;
  color: var(--ifi-ink);

  .rt-header {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 2px;
  }
  .rt-clear {
    padding: 0;
    height: auto;
    font-size: 12px;
  }
  .rt-thread {
    flex: 1;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 2px 4px 6px 0;
  }
  .rt-empty {
    color: var(--ifi-text-tertiary);
    font-size: 12.5px;
    line-height: 1.5;
    margin: 2px 0 6px;
  }
  .rt-error {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 12px;
    font-size: 12.5px;
    color: var(--ifi-danger);
    margin: 6px 0;
  }
  .rt-chips {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding: 6px 0 2px;
  }
  .rt-chip {
    position: relative;
    flex: 0 0 auto;
    width: 58px;
    border: 1px solid var(--ifi-stroke-1);
    border-radius: 8px;
    padding: 2px;
    cursor: zoom-in;
    text-align: center;
    background: none;
    font: inherit;
    color: inherit;
  }
  .rt-chip:hover {
    border-color: var(--ifi-stroke-2);
  }
  .rt-chip img {
    width: 52px;
    height: 40px;
    object-fit: cover;
    border-radius: 4px;
    display: block;
    margin: 0 auto;
    background: var(--ifi-fill-1);
  }
  .rt-chip-label {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    line-height: 1.4;
  }
  .rt-chip-x {
    position: absolute;
    top: -7px;
    right: -7px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    border: 1px solid var(--ifi-stroke-2);
    color: var(--ifi-text-secondary);
    font-size: 11px;
    line-height: 14px;
    text-align: center;
  }
  .rt-chip-x:hover {
    color: var(--ifi-danger);
    border-color: var(--ifi-danger);
  }
  .rt-row {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    margin-top: 6px;
  }
  .rt-tools {
    flex-wrap: wrap;
    align-items: center;
  }
  .rt-model-note {
    font-size: 12px;
    color: var(--ifi-text-tertiary);
  }
`;

/** The question typed but not sent, per recording — kept across tab switches (the panel remounts on each). */
const drafts = new Map<string, string>();

/** A moment on a chip, as a picture the lightbox can show. */
const momentPicture = (m: {
  recordingIndex: number;
  tSeconds: number;
  thumbnail: string;
  overlay?: string;
}): ProjectImage => ({
  id: `moment-${m.recordingIndex}`,
  kind: 'look',
  path: '',
  mime: 'image/png',
  caption: `t = ${formatDuration(m.tSeconds)}`,
  url: m.overlay || m.thumbnail,
  at: 0,
});

const UNAVAILABLE =
  'AI analysis isn’t available for this clip. It is an older showcase video stored as one .vir file, and the AI’s tools read a recording frame by frame in your browser, which that format doesn’t support. Recordings captured with the app and photo sets are supported.';

const RecordingThread = ({ experiment }: { experiment: Experiment }) => {
  const expId = experiment.id;
  const user = useCommonStore((s) => s.user);
  const view = useThreadView(expId);
  const attachedMoments = useCommonStore((s) => s.attachedMoments);
  const removeAttachedMoment = useCommonStore((s) => s.removeAttachedMoment);
  const clearAttachedMoments = useCommonStore((s) => s.clearAttachedMoments);
  const requestSnapshotMoment = useCommonStore((s) => s.requestSnapshotMoment);
  const setQaModel = useCommonStore((s) => s.setQaModel);
  const supported = aiSupports(experiment);

  const [question, setQuestionState] = useState(() => drafts.get(expId) ?? '');
  const setQuestion = (v: string) => {
    setQuestionState(v);
    drafts.set(expId, v);
  };
  const [lightbox, setLightbox] = useState<{ image: ProjectImage; images: ProjectImage[] } | null>(null);
  const [clearing, setClearing] = useState(false);

  // the saved thread, once per recording; then any browser calls a dropped connection left
  useEffect(() => {
    if (!user || !supported) return;
    let alive = true;
    (async () => {
      await ensureThread(expId);
      if (!alive) return;
      await resumePending(experiment, 'ask');
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expId, user?.id, supported]);

  // a message the server never got comes back to the box
  useEffect(() => {
    if (view.unsent != null) {
      setQuestion(view.unsent);
      setThreadUnsent(expId, null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.unsent]);

  // keep the newest turn (and the streaming reply) in view as it grows
  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.turns, view.liveText, view.outgoing, view.running]);

  if (!user) return <div className="rt-empty">Sign in to ask the AI about this recording.</div>;
  if (!supported) {
    return (
      <Wrap>
        <div className="rt-empty">{UNAVAILABLE}</div>
      </Wrap>
    );
  }

  const started = view.turns.length > 0 || view.running;
  const canSend = !view.running && (question.trim().length > 0 || attachedMoments.length > 0);

  const onSend = () => {
    if (!canSend) return;
    const text = question.trim();
    const moments = attachedMoments;
    setQuestion('');
    clearAttachedMoments();
    setQaModel(view.model);
    sendThreadMessage(experiment, text, moments).catch((e) => console.error('Ask AI failed', e));
  };

  const onClear = async () => {
    setClearing(true);
    try {
      await clearThread(expId);
      resetThread(expId);
    } catch (e) {
      message.error((e as Error)?.message || 'Could not clear the thread.');
    } finally {
      setClearing(false);
    }
  };

  const pending = pendingBrowserCalls(view.turns);
  const openPicture = (i: RecImage) => setLightbox({ image: i, images: view.images });

  return (
    <Wrap>
      {view.turns.length > 0 && !view.running && (
        <div className="rt-header">
          <Popconfirm
            title="Clear this recording's Ask AI thread?"
            description="Your questions, the AI's answers and the pictures it made here are deleted. The model can be picked again."
            okText="Clear"
            okButtonProps={{ danger: true, loading: clearing }}
            onConfirm={onClear}
          >
            <Button type="link" size="small" danger className="rt-clear" loading={clearing}>
              Clear thread
            </Button>
          </Popconfirm>
        </div>
      )}
      <div className="rt-thread" ref={threadRef}>
        {!started && (
          <div className="rt-empty">
            Ask anything about this recording. The AI reads its frames in your browser and answers here; attach up to 3
            moments (right-click a frame, or “+ Add moment”) to point at an instant. Your thread is saved and restored
            when you come back.
          </div>
        )}
        <Conversation
          turns={view.turns}
          images={view.images}
          model={view.model}
          live={{ running: view.running, liveText: view.liveText, status: view.status, preview: view.preview }}
          outgoing={view.outgoing}
          showFailures={isStaff(user)}
          onOpenImage={openPicture}
        />
        {view.error && !view.running && (
          <div className="rt-error">
            <span>{view.error}</span>
            {view.canRetry && (
              <Button size="small" onClick={() => retryThread(experiment)}>
                Try Again
              </Button>
            )}
          </div>
        )}
        {!view.running && !view.error && pending.length > 0 && (
          <div className="rt-error" style={{ color: 'var(--ifi-text-tertiary)' }}>
            <span>The AI was waiting for your browser when the page closed.</span>
            <Button size="small" onClick={() => resumePending(experiment, 'ask')}>
              Continue
            </Button>
          </div>
        )}
      </div>

      {attachedMoments.length > 0 && (
        <div className="rt-chips">
          {attachedMoments.map((m, i) => (
            <button
              type="button"
              className="rt-chip"
              key={m.recordingIndex}
              title="Click to enlarge"
              onClick={() => {
                const pics = attachedMoments.map(momentPicture);
                setLightbox({ image: pics[i], images: pics });
              }}
            >
              {m.thumbnail ? <img src={m.overlay || m.thumbnail} alt="" /> : <div style={{ width: 52, height: 40 }} />}
              <div className="rt-chip-label">{formatDuration(m.tSeconds)}</div>
              <span
                className="rt-chip-x"
                role="button"
                aria-label="Remove this moment"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAttachedMoment(m.recordingIndex);
                }}
              >
                ×
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="rt-row rt-tools">
        <Button
          size="small"
          onClick={() => requestSnapshotMoment()}
          disabled={attachedMoments.length >= 3}
          title="Attach the frame the player is on, with your probes and notes drawn on it"
        >
          + Add moment ({attachedMoments.length}/3)
        </Button>
        {started ? (
          <span
            className="rt-model-note"
            title="The model is fixed once a thread has started; clear the thread to pick another"
          >
            {modelLabel(view.model)}
          </span>
        ) : (
          <Select
            size="small"
            value={view.model}
            onChange={(m: QaModel) => {
              setThreadModel(expId, m);
              setQaModel(m);
            }}
            style={{ width: 172 }}
            aria-label="Model for this thread"
            options={MODEL_KEYS.map((k) => ({ value: k, label: MODEL_LABELS[k] }))}
          />
        )}
      </div>

      <div className="rt-row">
        <Input.TextArea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about this recording…"
          autoSize={{ minRows: 1, maxRows: 4 }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. Ignore Enter mid-IME-composition (e.g. Chinese).
            if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as { isComposing?: boolean }).isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        {view.running ? (
          <Button danger size="small" onClick={() => stopThread(expId)} title="Stop — the model stops too">
            Stop
          </Button>
        ) : (
          <Button type="primary" size="small" disabled={!canSend} onClick={onSend}>
            Send
          </Button>
        )}
      </div>

      <ConsentDialog
        open={view.needsConsent}
        provider={providerNameFor(modelLabel(view.model))}
        onCancel={() => dismissConsent(expId, 'ask')}
        onAgree={async () => {
          await recordAiConsent(user.id);
          void resendAfterConsent(expId, 'ask');
        }}
      />
      <Lightbox image={lightbox?.image ?? null} images={lightbox?.images ?? []} onClose={() => setLightbox(null)} />
    </Wrap>
  );
};

export default RecordingThread;
