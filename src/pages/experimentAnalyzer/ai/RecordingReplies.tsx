/*
 * A recording conversation as the analyzer draws it — the Projects page's Discuss (src/labProjects/
 * components/Discuss.tsx), for one recording in the analyzer's side column: the user's turns on the
 * right (the moments they attached as small frames, then their words), the AI's turns run together into
 * replies (src/labProjects/core/replies.ts) — the steps that got to the answer (the frames it looked
 * at, the code it ran) folded under one line, then the pictures the steps made, then the answer — and
 * the run in motion at the end (the reply as it streams, the status row, the report being written).
 * Shared by the Ask AI tab (a thread) and the AI Report tab (a run's progress).
 */
import { useMemo, useState } from 'react';
import { Spin } from 'antd';
import { ChevronDown, ChevronRight, FileText, Sparkles } from 'lucide-react';
import styled from 'styled-components';
import {
  discussRows,
  replyParts,
  replyProducts,
  replyWritesReport,
  stepsSummary,
} from '../../../labProjects/core/replies';
import { statusLabel } from '../../../labProjects/core/runStatus';
import type { StoredToolCall, Turn } from '../../../labProjects/core/types';
import { parseArgs } from '../../../labProjects/format';
import MarkdownView from '../../../labProjects/MarkdownView';
import PictureCard from '../../../labProjects/components/PictureCard';
import type { RecImage, RecTurn } from '../../../services/recordingAi';
import { modelLabel, isModelKey, isRetiredModelKey, type QaModel } from '../../../types';

const Thread = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 14px;

  .dc-user {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    margin-left: 10%;
  }
  .dc-bubble {
    max-width: 100%;
    padding: 7px 11px;
    border-radius: 12px 12px 4px 12px;
    background: var(--ifi-teal-film);
    color: var(--ifi-ink);
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .dc-bubble.dc-request {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--ifi-fill-1);
    color: var(--ifi-text-secondary);
    font-size: 13px;
  }
  .dc-bubble.dc-outgoing {
    opacity: 0.7;
  }
  .dc-notes {
    font-size: 12.5px;
    color: var(--ifi-text-tertiary);
    white-space: pre-wrap;
    text-align: right;
  }
  /* the moments a message carried: small frames with the time under each */
  .dc-moments {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
  }
  .dc-moments button {
    padding: 0;
    border: 1px solid var(--ifi-stroke-1);
    border-radius: 6px;
    overflow: hidden;
    background: var(--ifi-fill-1);
    cursor: zoom-in;
    line-height: 0;
  }
  .dc-moments img {
    width: 64px;
    height: 48px;
    object-fit: cover;
  }

  .dc-ai {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-right: 4%;
    min-width: 0;
  }
  .dc-ai-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--ifi-text-tertiary);
  }
  .dc-ai-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 999px;
    background: var(--ifi-teal-fill);
    color: #fff;
  }
  .dc-steps {
    border-left: 2px solid var(--ifi-stroke-1);
    padding-left: 10px;
  }
  .dc-steps-head {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
    border: 0;
    background: none;
    color: var(--ifi-text-tertiary);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
    text-align: left;
  }
  .dc-steps-head:hover {
    color: var(--ifi-text-secondary);
  }
  .dc-steps-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 6px 0 2px;
  }
  .dc-step {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .dc-tool {
    font-size: 12.5px;
    color: var(--ifi-text-tertiary);
  }
  .dc-tool-failed {
    font-size: 12px;
    color: var(--ifi-danger);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .dc-thumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
  }
  .dc-thumbs button {
    padding: 0;
    border: 1px solid var(--ifi-stroke-1);
    border-radius: 6px;
    overflow: hidden;
    background: var(--ifi-fill-1);
    cursor: zoom-in;
    line-height: 0;
  }
  .dc-thumbs img {
    width: 72px;
    height: 72px;
    object-fit: cover;
  }
  .dc-line {
    align-self: center;
    font-size: 12px;
    color: var(--ifi-text-tertiary);
    text-align: center;
  }
  .dc-busy {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--ifi-text-tertiary);
  }
  .dc-preview {
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--ifi-text-tertiary);
    white-space: pre-wrap;
    word-break: break-word;
    display: -webkit-box;
    -webkit-line-clamp: 6;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
`;

/** What the model that wrote a turn is called: the picker's label for a key it knows, else the bare model name. */
function modelNameOfTurn(turn: Turn, fallback: QaModel): string {
  if (turn.modelLabel) return turn.modelLabel;
  if (!turn.model) return modelLabel(fallback);
  const bare = turn.model.slice(turn.model.indexOf('/') + 1);
  return isModelKey(bare) || isRetiredModelKey(bare) ? modelLabel(bare) : bare;
}

const AiLabel = ({ name }: { name: string }) => (
  <span className="dc-ai-label">
    <span className="dc-ai-badge">
      <Sparkles size={11} />
    </span>
    {name}
  </span>
);

const Thumbs = ({ ids, images, onOpen }: { ids: string[]; images: RecImage[]; onOpen: (i: RecImage) => void }) => {
  const list = ids.map((id) => images.find((i) => i.id === id)).filter((i): i is RecImage => i != null);
  if (list.length === 0) return null;
  return (
    <div className="dc-thumbs">
      {list.slice(0, 8).map((i) => (
        <button key={i.id} type="button" onClick={() => onOpen(i)} title={i.caption} aria-label={i.caption}>
          <img src={i.url} alt={i.caption} loading="lazy" />
        </button>
      ))}
    </div>
  );
};

/** One tool call, as a line (the app's ToolActivity, for the tools this conversation has). */
const ToolActivity = ({
  call,
  result,
  step,
  pictures,
  images,
  showFailures,
  onOpenImage,
}: {
  call: StoredToolCall;
  result: Turn | undefined;
  step: boolean;
  pictures: boolean;
  images: RecImage[];
  showFailures: boolean;
  onOpenImage: (i: RecImage) => void;
}) => {
  const args = parseArgs(call.args);
  if (result != null && result.ok === false) {
    return showFailures ? (
      <div className="dc-tool-failed">{`${call.name.replace(/_/g, ' ')} did not work: ${result.result?.text ?? ''}`}</div>
    ) : null;
  }
  const imageIds = result?.result?.imageIds ?? [];
  const line = (text: string) => <div className="dc-tool">{text}</div>;
  switch (call.name) {
    case 'look': {
      const times = Array.isArray(args.times) ? args.times.length : 1;
      return (
        <div>
          {line(
            result ? `Looked at the recording${times > 1 ? ` at ${times} moments` : ''}` : 'Looking at the recording…',
          )}
          {pictures ? <Thumbs ids={imageIds} images={images} onOpen={onOpenImage} /> : null}
        </div>
      );
    }
    case 'run_code': {
      const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : '';
      const what = purpose ? `: ${purpose}` : '';
      return (
        <div>
          {line(result ? `Ran code${what}` : `Running code${what}…`)}
          {step ? null : <Thumbs ids={imageIds} images={images} onOpen={onOpenImage} />}
        </div>
      );
    }
    case 'view':
      return line('Looked at the pictures again');
    case 'write_report':
      return line(result ? 'Wrote the report' : 'Writing the report…');
    default:
      return line(call.name.replace(/_/g, ' '));
  }
};

const Reply = ({
  turns,
  askedForReport,
  results,
  live,
  images,
  model,
  expanded,
  onToggle,
  showFailures,
  onOpenImage,
}: {
  turns: Turn[];
  askedForReport: boolean;
  results: ReadonlyMap<string, Turn>;
  live: boolean;
  images: RecImage[];
  model: QaModel;
  expanded: boolean | undefined;
  onToggle: (open: boolean) => void;
  showFailures: boolean;
  onOpenImage: (i: RecImage) => void;
}) => {
  const { steps, answer } = replyParts(turns, live);
  const products = replyProducts(steps, results, images, answer, askedForReport);
  const forReport = replyWritesReport(turns, askedForReport);
  const open = expanded ?? (live && answer == null);
  const tool = (c: StoredToolCall, step: boolean) => (
    <ToolActivity
      key={c.id}
      call={c}
      result={results.get(c.id)}
      step={step || forReport}
      pictures={!forReport}
      images={images}
      showFailures={showFailures}
      onOpenImage={onOpenImage}
    />
  );
  return (
    <div className="dc-ai">
      <AiLabel name={modelNameOfTurn(turns[0], model)} />
      {steps.length > 0 && (
        <div className="dc-steps">
          <button
            type="button"
            className="dc-steps-head"
            onClick={() => onToggle(!open)}
            aria-expanded={open}
            aria-label={open ? 'Hide the steps' : 'Show the steps'}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{stepsSummary(steps, () => 'the recording')}</span>
          </button>
          {open && (
            <div className="dc-steps-body">
              {steps.map((t) => (
                <div key={t.seq} className="dc-step">
                  {t.text?.trim() ? (
                    <MarkdownView markdown={t.text} images={images} onOpenImage={onOpenImage} compact />
                  ) : null}
                  {(t.toolCalls ?? []).map((c) => tool(c, true))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {products.map((p) =>
        p.kind === 'picture' ? (
          <PictureCard key={`${p.call.id}-${p.image.id}`} image={p.image} onOpen={onOpenImage} />
        ) : null,
      )}
      {answer?.text?.trim() ? (
        <MarkdownView markdown={answer.text} images={images} onOpenImage={onOpenImage} compact />
      ) : null}
      {(answer?.toolCalls ?? []).filter((c) => c.name !== 'write_report').map((c) => tool(c, false))}
    </div>
  );
};

export interface LiveState {
  running: boolean;
  liveText: string;
  status: string | null;
  preview: string | null;
}

/** The conversation's rows, and the run in motion under them. */
const Conversation = ({
  turns,
  images,
  model,
  live,
  outgoing,
  showFailures,
  onOpenImage,
  onOpenMoment,
}: {
  turns: RecTurn[];
  images: RecImage[];
  /** The model the conversation runs on, for a turn that does not name its own. */
  model: QaModel;
  live: LiveState;
  /** The user's message on its way (a thread). */
  outgoing?: { text: string } | null;
  showFailures: boolean;
  onOpenImage: (i: RecImage) => void;
  /** A moment the user attached: opens it full size. */
  onOpenMoment?: (i: RecImage) => void;
}) => {
  const rows = useMemo(() => discussRows(turns), [turns]);
  const results = useMemo(() => {
    const m = new Map<string, Turn>();
    for (const t of turns) if (t.role === 'tool' && t.callId) m.set(t.callId, t);
    return m;
  }, [turns]);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const lastIsAi = !outgoing && turns.length > 0 && turns[turns.length - 1].role === 'assistant';
  const statusText = live.liveText && !live.status ? 'Replying…' : statusLabel(live.status);
  return (
    <Thread>
      {rows.map((row, index) => {
        if (row.kind === 'reply') {
          return (
            <Reply
              key={row.key}
              turns={row.turns}
              askedForReport={row.askedForReport}
              results={results}
              live={live.running && !outgoing && index === rows.length - 1}
              images={images}
              model={model}
              expanded={opened[row.key]}
              onToggle={(show) => setOpened((prev) => ({ ...prev, [row.key]: show }))}
              showFailures={showFailures}
              onOpenImage={onOpenImage}
            />
          );
        }
        const item = row.turn as RecTurn;
        if (item.role === 'user' && item.request === 'report') {
          return (
            <div key={row.key} className="dc-user">
              <span className="dc-bubble dc-request">
                <FileText size={14} />
                Generate Report
              </span>
              {item.text?.trim() ? <div className="dc-notes">{item.text}</div> : null}
            </div>
          );
        }
        if (item.role === 'user') {
          const moments = (item.momentImageIds ?? [])
            .map((id) => images.find((i) => i.id === id))
            .filter((i): i is RecImage => i != null);
          return (
            <div key={row.key} className="dc-user">
              {moments.length > 0 && (
                <div className="dc-moments">
                  {moments.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      title={m.caption}
                      aria-label={m.caption}
                      onClick={() => (onOpenMoment ?? onOpenImage)(m)}
                    >
                      <img src={m.url} alt={m.caption} loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
              {item.text?.trim() ? <div className="dc-bubble">{item.text}</div> : null}
            </div>
          );
        }
        if (item.role === 'note' && item.note?.type === 'reportEdited') {
          return (
            <div key={row.key} className="dc-line">
              You edited the report
            </div>
          );
        }
        return null;
      })}
      {outgoing?.text ? (
        <div className="dc-user">
          <div className="dc-bubble dc-outgoing">{outgoing.text}</div>
        </div>
      ) : null}
      {live.running && (
        <div className="dc-ai">
          {!lastIsAi && <AiLabel name={modelLabel(model)} />}
          {live.liveText ? (
            <MarkdownView markdown={live.liveText} images={images} onOpenImage={onOpenImage} compact />
          ) : null}
          {live.preview ? <div className="dc-preview">{live.preview.slice(-600)}</div> : null}
          <div className="dc-busy">
            <Spin size="small" />
            <span>{statusText}</span>
          </div>
        </div>
      )}
    </Thread>
  );
};

export default Conversation;
