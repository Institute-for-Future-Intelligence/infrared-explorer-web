/*
 * The conversation of a project, as the app's Discuss tab draws it: the
 * user's turns on the right (the captures sent with them as tiles, then
 * their words), and the AI's turns run together into replies
 * (core/replies.ts) — each with the steps that got to the answer (the AI's
 * running words, the frames it looked at, the code it ran) folded under one
 * line, then what the steps made for the user (pictures, the plan, the
 * report), then the answer. A note (the plan edited, a capture removed) and
 * an older event turn are one grey line each.
 *
 * On the owner's page the thread ends with the run in motion (runner.ts
 * RunView): the message on its way, the reply as it streams, the status row
 * (core/runStatus.ts words it), a plan or report being written, and after a
 * failure the error with Try Again. A shared page shows none of that but
 * the owner's AI at work.
 *
 * What a failed call answered is shown to one account only (the app's user
 * decision ㊿); anyone else sees nothing of the call.
 */

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button, Spin } from 'antd';
import { ChevronDown, ChevronRight, Clock, FileText, Play, Sparkles } from 'lucide-react';
import styled from 'styled-components';
import { captureNumbers } from '../core/captureNumbers';
import { modelNameOf } from '../core/models';
import { discussRows, replyParts, replyProducts, replyWritesReport, stepsSummary } from '../core/replies';
import { workingLabel } from '../core/runStatus';
import type { ProjectBundle, ProjectImage, StoredToolCall, Take, Turn } from '../core/types';
import { parseArgs } from '../format';
import MarkdownView from '../MarkdownView';
import type { RunView } from '../runner';
import type { CloudThumbState } from '../useCloudThumbs';
import PictureCard from './PictureCard';
import ReportCard from './ReportCard';

const Thread = styled.div`
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 18px 18px;

  .dc-user {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    margin-left: 12%;
  }
  .dc-user-name {
    font-size: 12px;
    color: var(--ifi-text-tertiary);
  }
  .dc-bubble {
    max-width: 100%;
    padding: 9px 13px;
    border-radius: 14px 14px 4px 14px;
    background: var(--ifi-teal-film);
    color: var(--ifi-ink);
    font-size: 15px;
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
    font-size: 14px;
  }
  .dc-bubble.dc-outgoing {
    opacity: 0.7;
  }

  /* the captures a message carried: the phone's tiles, a number on each */
  .dc-tiles {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }
  .dc-tile-cell {
    display: block;
    color: inherit;
    text-decoration: none;
  }
  .dc-tile {
    position: relative;
    border-radius: 10px;
    overflow: hidden;
    background: var(--ifi-fill-1);
  }
  .dc-tile img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  a.dc-tile-cell:hover .dc-tile {
    box-shadow: 0 0 0 2px var(--ifi-teal);
  }
  .dc-tile-blank {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: 8px;
    text-align: center;
    color: var(--ifi-text-tertiary);
    font-size: 12px;
    line-height: 1.3;
  }
  .dc-tile-blank b {
    font-weight: 600;
    color: var(--ifi-text-secondary);
  }
  .dc-tile-n {
    position: absolute;
    top: 6px;
    right: 6px;
    min-width: 20px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    line-height: 18px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .dc-tile-kind {
    position: absolute;
    left: 6px;
    bottom: 6px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 18px;
    padding: 0 6px 0 5px;
    border-radius: 9px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font-size: 11px;
    font-weight: 600;
    line-height: 18px;
    pointer-events: none;
  }
  .dc-tile-name {
    margin-top: 4px;
    font-size: 12px;
    line-height: 1.3;
    color: var(--ifi-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dc-ai {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-right: 6%;
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
    width: 20px;
    height: 20px;
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
    font-size: 13px;
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
    font-size: 13px;
    color: var(--ifi-text-tertiary);
  }
  .dc-tool-link {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: 13px;
    color: var(--ifi-teal-dark);
    cursor: pointer;
  }
  .dc-tool-failed {
    font-size: 12.5px;
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
    width: 84px;
    height: 84px;
    object-fit: cover;
  }

  .dc-line {
    align-self: center;
    font-size: 12.5px;
    color: var(--ifi-text-tertiary);
    text-align: center;
  }
  .dc-line button {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: var(--ifi-teal-dark);
    cursor: pointer;
  }
  .dc-empty {
    padding: 40px 16px;
    text-align: center;
    color: var(--ifi-text-tertiary);
    font-size: 15px;
  }
  .dc-busy {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: var(--ifi-text-tertiary);
  }
  .dc-preview {
    font-size: 13px;
    line-height: 1.45;
    color: var(--ifi-text-tertiary);
    white-space: pre-wrap;
    word-break: break-word;
    display: -webkit-box;
    -webkit-line-clamp: 6;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .dc-error {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 12px;
    font-size: 13px;
    line-height: 1.45;
    color: var(--ifi-danger);
  }
`;

// ------------------------------------------------------------------ pieces

/** Heads each reply and names the model that answered (plain "AI" when it is not known). */
const AiLabel = ({ model }: { model?: string | null }) => (
  <span className="dc-ai-label">
    <span className="dc-ai-badge">
      <Sparkles size={12} />
    </span>
    {model || 'AI'}
  </span>
);

interface CaptureEntry {
  takeId: string;
  take: Take | null;
  name: string;
  n: number | null;
}

/**
 * The captures sent with a message, as the phone's tiles: one capture is a
 * big tile, several are smaller; its number top right, a Video / Time-lapse
 * badge bottom left on a recording (a photo has none), its name under it.
 * One with a cloud copy shows that copy's thumbnail and opens in the
 * analyzer; one on the owner's phone only is a grey square that says so; one
 * since removed from the project says that.
 */
const CaptureTiles = ({ entries, cloud }: { entries: CaptureEntry[]; cloud: Map<string, CloudThumbState> }) => {
  if (entries.length === 0) {
    return null;
  }
  const size = entries.length === 1 ? 168 : 104;
  return (
    <div className="dc-tiles">
      {entries.map((e) => {
        const state = e.take ? cloud.get(e.takeId) : undefined;
        const thumb = state?.kind === 'ready' ? state.thumb : null;
        const blank = !e.take ? (
          <span>Removed from the experiment</span>
        ) : state == null || state.kind === 'missing' ? (
          <>
            <b>On your phone only</b>
            <span>Upload it from the app</span>
          </>
        ) : state.kind === 'unavailable' ? (
          <span>Not available right now</span>
        ) : null;
        const body = (
          <>
            <div className="dc-tile" style={{ width: size, height: size }}>
              {thumb?.thumbnailUrl ? (
                <img src={thumb.thumbnailUrl} alt="" loading="lazy" />
              ) : (
                <div className="dc-tile-blank">{blank}</div>
              )}
              {e.n != null && <span className="dc-tile-n">#{e.n}</span>}
              {e.take?.source === 'recording' && (
                <span className="dc-tile-kind">
                  {e.take.timelapse ? <Clock size={11} /> : <Play size={11} fill="currentColor" />}
                  {e.take.timelapse ? 'Time-lapse' : 'Video'}
                </span>
              )}
            </div>
            <div className="dc-tile-name" style={{ width: size }} title={e.name}>
              {e.name}
            </div>
          </>
        );
        return thumb ? (
          <Link key={e.takeId} className="dc-tile-cell" to={`/experiments/${thumb.expId}`} title={e.name}>
            {body}
          </Link>
        ) : (
          <div key={e.takeId} className="dc-tile-cell" title={e.name}>
            {body}
          </div>
        );
      })}
    </div>
  );
};

const Thumbs = ({
  ids,
  images,
  onOpen,
}: {
  ids: string[];
  images: ProjectImage[];
  onOpen: (i: ProjectImage) => void;
}) => {
  const list = ids.map((id) => images.find((i) => i.id === id)).filter((i): i is ProjectImage => i != null);
  if (list.length === 0) {
    return null;
  }
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

interface ActivityProps {
  call: StoredToolCall;
  result: Turn | undefined;
  /** The reply is still being made. */
  live: boolean;
  /** Drawn among a reply's steps: what the call made shows with the answer, so here one line says it was made. */
  step?: boolean;
  /** False in a reply that writes the report (core/replies replyWritesReport): not even a look's frames show. */
  pictures?: boolean;
  bundle: ProjectBundle;
  showFailures: boolean;
  onOpenImage: (i: ProjectImage) => void;
  onOpenReport: () => void;
  onOpenPlan: () => void;
}

/** One tool call, as the app's ToolActivity says it. */
const ToolActivity = ({
  call,
  result,
  live,
  step = false,
  pictures = true,
  bundle,
  showFailures,
  onOpenImage,
  onOpenReport,
  onOpenPlan,
}: ActivityProps) => {
  const args = parseArgs(call.args);
  const takeName = (id: unknown) => bundle.project.takes.find((t) => t.takeId === id)?.name ?? 'the capture';
  const failed = result != null && result.ok === false;
  if (failed) {
    return showFailures ? (
      <div className="dc-tool-failed">{`${call.name.replace(/_/g, ' ')} did not work: ${result?.result?.text ?? ''}`}</div>
    ) : null;
  }
  if (live && !result && (call.name === 'draw' || call.name === 'write_plan' || call.name === 'chart')) {
    return null;
  }
  const imageIds = result?.result?.imageIds ?? [];
  const named = (what: string, caption: string | undefined) => (caption ? `${what}: ${caption}` : what);
  const line = (text: string) => <div className="dc-tool">{text}</div>;
  switch (call.name) {
    case 'write_plan':
      if (step) {
        return line(result ? 'Wrote the plan' : 'Writing the plan…');
      }
      return result ? (
        <button type="button" className="dc-tool-link" onClick={onOpenPlan}>
          Updated the plan · View
        </button>
      ) : (
        line('Writing the plan…')
      );
    case 'draw': {
      const img = imageIds.length > 0 ? bundle.images.find((i) => i.id === imageIds[0]) : undefined;
      const caption = img?.caption ?? (typeof args.caption === 'string' ? args.caption : undefined);
      if (!img || step) {
        return line(result ? named('Drew a picture', caption) : `Drawing: ${caption ?? ''}…`);
      }
      return <PictureCard image={img} onOpen={onOpenImage} />;
    }
    case 'suggest_shot':
      return line(`Suggested what to shoot: “${String(args.title ?? '')}”`);
    case 'set_title':
      return line(`Named the experiment “${String(args.title ?? '')}”`);
    case 'view':
      return line('Looked at the pictures again');
    case 'look': {
      const times = Array.isArray(args.times) ? args.times.length : 1;
      return (
        <div>
          {line(`Looked at ${takeName(args.takeId)}${times > 1 ? ` at ${times} moments` : ''}`)}
          {pictures ? <Thumbs ids={imageIds} images={bundle.images} onOpen={onOpenImage} /> : null}
        </div>
      );
    }
    case 'measure':
      return line(`Measured ${takeName(args.takeId)}`);
    case 'chart': {
      const img = imageIds.length > 0 ? bundle.images.find((i) => i.id === imageIds[0]) : undefined;
      if (!img || step) {
        return line(result ? named('Drew a chart', img?.caption) : 'Drawing a chart…');
      }
      return <PictureCard image={img} onOpen={onOpenImage} />;
    }
    case 'place_sensors': {
      const n = Array.isArray(args.sensors) ? args.sensors.length : 0;
      return line(`Placed ${n === 1 ? 'a sensor' : `${n} sensors`} on ${takeName(args.takeId)}`);
    }
    case 'run_code': {
      const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : '';
      const what = purpose ? `: ${purpose}` : '';
      return (
        <div>
          {line(result ? `Ran code${what}` : `Running code${what}…`)}
          {step ? null : <Thumbs ids={imageIds} images={bundle.images} onOpen={onOpenImage} />}
        </div>
      );
    }
    case 'write_report':
      if (step) {
        return line(result ? 'Wrote the report' : 'Writing the report…');
      }
      return (
        <ReportCard
          title={String(args.title ?? 'Report')}
          markdown={typeof args.markdown === 'string' ? args.markdown : ''}
          images={bundle.images}
          writtenAt={result ? result.at : null}
          onOpen={onOpenReport}
        />
      );
    default:
      return null;
  }
};

/**
 * One reply of the AI (core/replies.ts): its label, the folded steps, what they made, the answer.
 * A reply that writes the report shows the report and no picture on the way to it.
 */
const Reply = ({
  turns,
  askedForReport,
  results,
  live,
  bundle,
  expanded,
  onToggle,
  showFailures,
  onOpenImage,
  onOpenReport,
  onOpenPlan,
}: {
  turns: Turn[];
  /** The user's turn it answers is Generate Report (core/replies discussRows). */
  askedForReport: boolean;
  results: ReadonlyMap<string, Turn>;
  live: boolean;
  bundle: ProjectBundle;
  /** The user opened (true) or closed (false) the steps; undefined: open while the answer is still to come. */
  expanded: boolean | undefined;
  onToggle: (open: boolean) => void;
  showFailures: boolean;
  onOpenImage: (i: ProjectImage) => void;
  onOpenReport: () => void;
  onOpenPlan: () => void;
}) => {
  const { steps, answer } = replyParts(turns, live);
  const products = replyProducts(steps, results, bundle.images, answer, askedForReport);
  const forReport = replyWritesReport(turns, askedForReport);
  const takeName = (id: unknown) => bundle.project.takes.find((t) => t.takeId === id)?.name ?? 'the capture';
  const open = expanded ?? (live && answer == null);
  const tool = (c: StoredToolCall, step: boolean) => (
    <ToolActivity
      key={c.id}
      call={c}
      result={results.get(c.id)}
      live={live}
      step={step || forReport}
      pictures={!forReport}
      bundle={bundle}
      showFailures={showFailures}
      onOpenImage={onOpenImage}
      onOpenReport={onOpenReport}
      onOpenPlan={onOpenPlan}
    />
  );
  return (
    <div className="dc-ai">
      <AiLabel model={modelNameOf(turns[0])} />
      {steps.length > 0 && (
        <div className="dc-steps">
          <button
            type="button"
            className="dc-steps-head"
            onClick={() => onToggle(!open)}
            aria-expanded={open}
            aria-label={open ? 'Hide the steps' : 'Show the steps'}
          >
            {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <span>{stepsSummary(steps, takeName)}</span>
          </button>
          {open && (
            <div className="dc-steps-body">
              {steps.map((t) => (
                <div key={t.seq} className="dc-step">
                  {t.text?.trim() ? (
                    <MarkdownView markdown={t.text} images={bundle.images} onOpenImage={onOpenImage} compact />
                  ) : null}
                  {(t.toolCalls ?? []).map((c) => tool(c, true))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {products.map((p) => {
        if (p.kind === 'picture') {
          return <PictureCard key={`${p.call.id}-${p.image.id}`} image={p.image} onOpen={onOpenImage} />;
        }
        if (p.kind === 'plan') {
          return (
            <button key={p.call.id} type="button" className="dc-tool-link" onClick={onOpenPlan}>
              Updated the plan · View
            </button>
          );
        }
        const args = parseArgs(p.call.args);
        return (
          <ReportCard
            key={p.call.id}
            title={String(args.title ?? 'Report')}
            markdown={typeof args.markdown === 'string' ? args.markdown : ''}
            images={bundle.images}
            writtenAt={p.writtenAt}
            onOpen={onOpenReport}
          />
        );
      })}
      {answer?.text?.trim() ? (
        <MarkdownView markdown={answer.text} images={bundle.images} onOpenImage={onOpenImage} compact />
      ) : null}
      {/* the report it wrote shows above, with what the steps made, while it is the project's report */}
      {(answer?.toolCalls ?? []).filter((c) => c.name !== 'write_report').map((c) => tool(c, false))}
    </div>
  );
};

// ------------------------------------------------------------------ thread

const Discuss = ({
  bundle,
  ownerName,
  showFailures,
  cloud,
  run = null,
  empty,
  onRetry,
  onOpenImage,
  onOpenPlan,
  onOpenReport,
}: {
  bundle: ProjectBundle;
  /** Whose words the user's side holds: null on the owner's own page ("you"), the owner's name on a shared one. */
  ownerName: string | null;
  showFailures: boolean;
  cloud: Map<string, CloudThumbState>;
  /** The run in motion on the owner's page; null on a shared one. */
  run?: RunView | null;
  /** What an owner's empty thread shows instead of the plain sentence (the question and the model picker). */
  empty?: ReactNode;
  /** Try Again after a failed request. */
  onRetry?: () => void;
  onOpenImage: (i: ProjectImage) => void;
  onOpenPlan: () => void;
  onOpenReport: () => void;
}) => {
  const rows = useMemo(() => discussRows(bundle.turns), [bundle.turns]);
  const results = useMemo(() => {
    const m = new Map<string, Turn>();
    for (const t of bundle.turns) {
      if (t.role === 'tool' && t.callId) {
        m.set(t.callId, t);
      }
    }
    return m;
  }, [bundle.turns]);
  const numbers = useMemo(() => captureNumbers(bundle.project.takes), [bundle.project.takes]);
  // captures since removed, by id, for the tiles of the messages that carried them
  const removed = useMemo(() => {
    const m = new Map<string, { name: string; n?: number }>();
    for (const t of bundle.turns) {
      if (t.role === 'note' && t.note?.type === 'takeRemoved') {
        m.set(t.note.takeId, { name: t.note.name, n: t.note.n });
      }
    }
    return m;
  }, [bundle.turns]);
  // the replies whose steps the reader opened or closed, by row key; the rest stay folded
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  const entriesOf = (turn: Turn): CaptureEntry[] => {
    const ids: string[] = [];
    for (const a of turn.attachments ?? []) {
      ids.push(a.takeId);
    }
    for (const k of turn.event?.takes ?? []) {
      ids.push(k.takeId);
    }
    return [...new Set(ids)].map((id) => {
      const take = bundle.project.takes.find((t) => t.takeId === id) ?? null;
      const gone = removed.get(id);
      return {
        takeId: id,
        take,
        name: take?.name ?? gone?.name ?? 'A capture',
        n: numbers.get(id) ?? gone?.n ?? null,
      };
    });
  };
  const who = ownerName ?? 'You';
  const captureWord = (n: number | undefined, name: string) => (n != null ? `Capture ${n}` : name);

  const busy = bundle.project.busy;
  const running = run?.running ?? false;
  const outgoing = running ? run?.outgoing : null;
  // the last thing drawn is the AI's: the live block needs no label of its own
  const lastIsAi = !outgoing && bundle.turns.length > 0 && bundle.turns[bundle.turns.length - 1].role === 'assistant';
  // a picked model answers alone; a project without a pick may fall back, so its reply names the model once it lands
  const liveModel = bundle.project.chatModel?.key != null ? bundle.project.chatModel.label : null;
  const busyLine = ownerName
    ? "The owner's AI is still working. This page looks again in a moment."
    : 'The AI is still working on this experiment (maybe from the app). This page looks again in a moment.';

  return (
    <Thread>
      {rows.length === 0 &&
        !busy &&
        !running &&
        (empty ?? <div className="dc-empty">Nothing has been said in this experiment yet.</div>)}
      {rows.map((row, index) => {
        if (row.kind === 'reply') {
          return (
            <Reply
              key={row.key}
              turns={row.turns}
              askedForReport={row.askedForReport}
              results={results}
              live={(busy || running) && !outgoing && index === rows.length - 1}
              bundle={bundle}
              expanded={opened[row.key]}
              onToggle={(show) => setOpened((prev) => ({ ...prev, [row.key]: show }))}
              showFailures={showFailures}
              onOpenImage={onOpenImage}
              onOpenReport={onOpenReport}
              onOpenPlan={onOpenPlan}
            />
          );
        }
        const item = row.turn;
        if (item.role === 'user' && item.request === 'report') {
          return (
            <div key={row.key} className="dc-user">
              <span className="dc-bubble dc-request">
                <FileText size={15} />
                Generate Report
              </span>
            </div>
          );
        }
        if (item.role === 'user') {
          const entries = entriesOf(item);
          const words = item.text?.trim() ? item.text : null;
          return (
            <div key={row.key} className="dc-user">
              {ownerName && <span className="dc-user-name">{ownerName}</span>}
              <CaptureTiles entries={entries} cloud={cloud} />
              {words != null && <div className="dc-bubble">{words}</div>}
            </div>
          );
        }
        if (item.role === 'event') {
          const entries = entriesOf(item);
          return (
            <div key={row.key} className="dc-line">
              {entries.length > 0
                ? `Added ${entries.map((e) => (e.n != null ? `Capture ${e.n}` : e.name)).join(', ')}`
                : 'Added captures'}
            </div>
          );
        }
        if (item.role === 'note') {
          if (item.note?.type === 'planEdited') {
            return (
              <div key={row.key} className="dc-line">
                {who} edited the plan ·{' '}
                <button type="button" onClick={onOpenPlan}>
                  View
                </button>
              </div>
            );
          }
          if (item.note?.type === 'reportEdited') {
            return (
              <div key={row.key} className="dc-line">
                {who} edited the report ·{' '}
                <button type="button" onClick={onOpenReport}>
                  View
                </button>
              </div>
            );
          }
          if (item.note?.type === 'takeRemoved') {
            return (
              <div key={row.key} className="dc-line">
                {`Removed ${captureWord(item.note.n, item.note.name)}${item.note.n != null ? ` (${item.note.name})` : ''}`}
              </div>
            );
          }
        }
        return <Fragment key={row.key} />;
      })}
      {outgoing?.text ? (
        // the message on its way, until the server has it
        <div className="dc-user">
          <div className="dc-bubble dc-outgoing">{outgoing.text}</div>
        </div>
      ) : null}
      {running && run ? (
        <div className="dc-ai">
          {!lastIsAi && <AiLabel model={liveModel} />}
          {run.liveText ? (
            <MarkdownView markdown={run.liveText} images={bundle.images} onOpenImage={onOpenImage} compact />
          ) : null}
          {run.preview ? <div className="dc-preview">{run.preview.text.slice(-600)}</div> : null}
          <div className="dc-busy">
            <Spin size="small" />
            <span>{workingLabel(run, busy)}</span>
          </div>
        </div>
      ) : busy ? (
        <div className="dc-ai">
          {!lastIsAi && <AiLabel model={liveModel} />}
          <div className="dc-busy">
            <Spin size="small" />
            <span>{busyLine}</span>
          </div>
        </div>
      ) : null}
      {run?.error && !running ? (
        <div className="dc-error">
          <span>{run.error}</span>
          {run.canRetry && onRetry && (
            <Button size="small" onClick={onRetry}>
              Try Again
            </Button>
          )}
        </div>
      ) : null}
    </Thread>
  );
};

export default Discuss;
