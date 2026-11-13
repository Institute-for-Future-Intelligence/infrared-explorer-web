/*
 * The conversation of a project, as the app's Discuss tab draws it: the
 * user's turns on the right (the captures sent with them as tiles, then
 * their words; a photo's tile opens in the Lightbox with the thread's other
 * pictures, a recording's in the analyzer), and the AI's turns run together
 * into replies
 * (core/replies.ts) — each with the steps that got to the answer (the AI's
 * running words, the frames it looked at, the code it ran) folded under one
 * line, then what the steps made for the user (pictures, the plan, the
 * report), then the answer. The frames it looked at are thumbnails in the
 * steps and no part of the thread's pictures: one opens among the frames of
 * its own look (the app's user decision, 2026-11-10). A note (the plan
 * edited, a capture removed) and an older event turn are one grey line each.
 *
 * On the owner's page the thread ends with the run in motion (runner.ts
 * RunView): the message on its way, the reply as it streams, the status row
 * (core/runStatus.ts words it), a plan or report being written, and after a
 * failure the error with Try Again. A shared page shows none of that but
 * the owner's AI at work. There each of the user's messages also carries two
 * small buttons under its right end (they show on hover): Copy, and Delete
 * from Here — the message goes with everything after it (the app's Discuss
 * has the same on a long press; the page does the deleting, `onDeleteFrom`).
 *
 * What a failed call answered is shown to one account only (the app's user
 * decision ㊿); anyone else sees nothing of the call.
 */

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button, Spin, message } from 'antd';
import { ChevronDown, ChevronRight, Clock, FileText, Play, Sparkles } from 'lucide-react';
import styled from 'styled-components';
import { MENU_ICONS } from '../../components/menuIcons';
import { captureNames, removedCaptureName, type CaptureName } from '../core/captureNumbers';
import { modelNameOf } from '../core/models';
import {
  discussRows,
  lookedMoments,
  replyParts,
  replyProducts,
  replyWritesReport,
  stepsSummary,
  type LookedMoment,
} from '../core/replies';
import { workingLabel } from '../core/runStatus';
import type { ProjectBundle, ProjectImage, StoredToolCall, Take, Turn } from '../core/types';
import { parseArgs } from '../format';
import MarkdownView from '../MarkdownView';
import { capturePhoto, turnTakeIds } from '../discussViewer';
import type { RunView } from '../runner';
import type { CloudThumbState } from '../useCloudThumbs';
import { useNewTabLink } from '../../hooks/useNavTrail';
import type { LightboxPicture } from './Lightbox';
import PictureCard from './PictureCard';
import ReportCard from './ReportCard';

const Thread = styled.div`
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 18px 18px;
  /* a wide pane: the thread keeps the page's reading width, centred (ProjectPage's --lab-read-width) */
  padding-inline: max(18px, calc((100% - var(--lab-read-width, 100%)) / 2));

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

  /* a message's two small buttons (the owner's page), under its right end. They hang below the message, in the
     gap to the next row, so the thread is spaced the same with and without them, and show while the pointer is
     on the message; they touch its lower edge, so the pointer reaches them without leaving it. */
  .dc-user {
    position: relative;
  }
  .dc-actions {
    position: absolute;
    top: 100%;
    right: 0;
    display: flex;
    gap: 2px;
    padding-top: 2px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s;
  }
  .dc-user:hover .dc-actions,
  .dc-actions:focus-within {
    opacity: 1;
    pointer-events: auto;
  }
  .dc-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--ifi-text-tertiary);
    cursor: pointer;
  }
  .dc-action:hover:not(:disabled) {
    background: var(--ifi-fill-1);
    color: var(--ifi-ink);
  }
  .dc-action.dc-action-delete:hover:not(:disabled) {
    color: var(--ifi-danger);
  }
  .dc-action:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* nothing hovers on a touch screen: the buttons are always there, on a line of their own */
  @media (hover: none) {
    .dc-actions {
      position: static;
      margin-top: -4px;
      padding-top: 0;
      opacity: 1;
      pointer-events: auto;
    }
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
  /* a photo's tile: a button that opens it full size, as a reply's picture does */
  button.dc-tile-cell {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    text-align: left;
    cursor: zoom-in;
  }
  button.dc-tile-cell:focus-visible .dc-tile {
    outline: 2px solid var(--ifi-teal);
    outline-offset: 2px;
  }
  .dc-tile {
    display: block;
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
  a.dc-tile-cell:hover .dc-tile,
  button.dc-tile-cell:hover .dc-tile {
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
    white-space: nowrap;
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
    display: block;
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
  /*
   * A look that rendered each moment in both kinds: a row of the thermal
   * frames over a row of the visible-light ones, a moment a column, its time
   * under it. Each column is one flex item (thermal, visible, time), so a
   * pane too narrow for every moment wraps whole columns, and the next line
   * is again a thermal row over a visible-light one. The columns stand
   * closer than the two rows, which is what makes them read as rows.
   */
  .dc-moments {
    display: flex;
    flex-wrap: wrap;
    gap: 16px 4px;
    margin-top: 4px;
  }
  .dc-moment {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .dc-moment button {
    padding: 0;
    border: 1px solid var(--ifi-stroke-1);
    border-radius: 6px;
    overflow: hidden;
    background: var(--ifi-fill-1);
    cursor: zoom-in;
    line-height: 0;
  }
  /* the frames are portrait (120 × 160 with the scale beside): the whole frame, not a square cut of it */
  .dc-moment img {
    width: 72px;
    height: 96px;
    object-fit: cover;
  }
  .dc-moment-when {
    /* nearer its column than the two rows are to each other */
    margin-top: -4px;
    font-size: 12px;
    color: var(--ifi-text-tertiary);
    font-variant-numeric: tabular-nums;
  }
  .dc-thumbs-more {
    display: block;
    margin-top: 4px;
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

/**
 * The two small buttons of one of the user's messages, on the owner's page:
 * Copy (a message with words), and Delete from Here. `blocked`: why nothing
 * can be deleted right now (the AI is answering); the button is off and
 * says so on hover.
 */
const MessageActions = ({
  text,
  blocked,
  onDelete,
}: {
  text: string | null;
  blocked: string | null;
  onDelete: () => void;
}) => {
  const copy = () => {
    navigator.clipboard.writeText(text ?? '').then(
      () => message.success('Copied'),
      () => message.error('Could not copy the message.'),
    );
  };
  return (
    <div className="dc-actions">
      {text ? (
        <button type="button" className="dc-action" title="Copy" aria-label="Copy" onClick={copy}>
          {MENU_ICONS.copy}
        </button>
      ) : null}
      <button
        type="button"
        className="dc-action dc-action-delete"
        title={blocked ?? 'Delete from Here'}
        aria-label="Delete from Here"
        disabled={blocked != null}
        onClick={onDelete}
      >
        {MENU_ICONS.delete}
      </button>
    </div>
  );
};

interface CaptureEntry {
  takeId: string;
  take: Take | null;
  name: string;
  /** What the capture is called (captureNames): its tile's badge and the words for it; null without a number. */
  cap: CaptureName | null;
}

/**
 * The captures sent with a message, as the phone's tiles: one capture is a
 * big tile, several are smaller; its number top right, a Video / Time-lapse
 * badge bottom left on a recording (a photo has none), its name under it.
 * One with a cloud copy shows that copy's thumbnail: a photo opens full size
 * in the Lightbox, among the thread's pictures (discussViewer.ts), and a
 * recording opens in the analyzer, in a new tab. One on the owner's phone only is a grey
 * square that says so; one since removed from the project says that.
 */
const CaptureTiles = ({
  entries,
  cloud,
  onOpenPhoto,
}: {
  entries: CaptureEntry[];
  cloud: Map<string, CloudThumbState>;
  onOpenPhoto: (p: LightboxPicture) => void;
}) => {
  const newTabLink = useNewTabLink();
  if (entries.length === 0) {
    return null;
  }
  const size = entries.length === 1 ? 168 : 104;
  return (
    <div className="dc-tiles">
      {entries.map((e) => {
        const state = e.take ? cloud.get(e.takeId) : undefined;
        const thumb = state?.kind === 'ready' ? state.thumb : null;
        const photo = capturePhoto(e.take, e.cap?.label, state);
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
        // spans, so the same tile sits in a button, a link or a plain cell
        const body = (
          <>
            <span className="dc-tile" style={{ width: size, height: size }}>
              {thumb?.thumbnailUrl ? (
                <img src={thumb.thumbnailUrl} alt="" loading="lazy" />
              ) : (
                <span className="dc-tile-blank">{blank}</span>
              )}
              {e.cap && <span className="dc-tile-n">{e.cap.tag}</span>}
              {e.take?.source === 'recording' && (
                <span className="dc-tile-kind">
                  {e.take.timelapse ? <Clock size={11} /> : <Play size={11} fill="currentColor" />}
                  {e.take.timelapse ? 'Time-lapse' : 'Video'}
                </span>
              )}
            </span>
            <span className="dc-tile-name" style={{ width: size }} title={e.name}>
              {e.name}
            </span>
          </>
        );
        return photo ? (
          <button
            key={e.takeId}
            type="button"
            className="dc-tile-cell"
            onClick={() => onOpenPhoto(photo)}
            title={e.name}
          >
            {body}
          </button>
        ) : thumb ? (
          <Link key={e.takeId} className="dc-tile-cell" {...newTabLink(`/experiments/${thumb.expId}`)} title={e.name}>
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

/** The thumbnails a plain strip shows; the rest are a click away in the Lightbox. */
const MAX_THUMBS = 8;

const Thumbs = ({
  ids,
  images,
  moments,
  onOpen,
}: {
  ids: string[];
  images: ProjectImage[];
  /**
   * A look that rendered each moment in both kinds (core/replies lookedMoments):
   * the thermal frames in one row and the visible-light ones in a row under
   * it, a moment a column with its time at its foot (user, 2026-11-10). A
   * pane too narrow for all of them wraps whole columns (.dc-moments). Every
   * moment shows (a look renders at most 12).
   */
  moments?: LookedMoment[] | null;
  /** `among`: the pictures of this strip, in the order it shows them. */
  onOpen: (i: ProjectImage, among: ProjectImage[]) => void;
}) => {
  const list = ids.map((id) => images.find((i) => i.id === id)).filter((i): i is ProjectImage => i != null);
  if (list.length === 0) {
    return null;
  }
  const thumb = (i: ProjectImage, among: ProjectImage[]) => (
    <button key={i.id} type="button" onClick={() => onOpen(i, among)} title={i.caption} aria-label={i.caption}>
      <img src={i.url} alt={i.caption} loading="lazy" />
    </button>
  );
  const byId = new Map(list.map((i) => [i.id, i]));
  // every picture of every pair is at hand, or the strip is a plain one
  const pairs = moments?.every((m) => byId.has(m.thermal) && byId.has(m.visible)) ? moments : null;
  if (pairs) {
    // the Lightbox pages as the rows read: the thermal row through, then the visible-light one
    const rows = [...pairs.map((m) => byId.get(m.thermal)!), ...pairs.map((m) => byId.get(m.visible)!)];
    return (
      <div className="dc-moments">
        {pairs.map((m) => (
          <div key={m.thermal} className="dc-moment">
            {thumb(byId.get(m.thermal)!, rows)}
            {thumb(byId.get(m.visible)!, rows)}
            {pairs.length > 1 && <span className="dc-moment-when">{`${m.time} s`}</span>}
          </div>
        ))}
      </div>
    );
  }
  return (
    <>
      <div className="dc-thumbs">{list.slice(0, MAX_THUMBS).map((i) => thumb(i, list))}</div>
      {list.length > MAX_THUMBS && (
        // the pictures past the strip's end: a line that opens the first of them
        <button type="button" className="dc-tool-link dc-thumbs-more" onClick={() => onOpen(list[MAX_THUMBS], list)}>
          {`+${list.length - MAX_THUMBS} more`}
        </button>
      )}
    </>
  );
};

/**
 * What a report card shows for a write_report call. A call that passed `markdown` wrote the whole
 * report, and the card shows that text. One that passed `edits` changed parts of the report there
 * was and carries no text of its own: the card shows the project's report, which is what that call
 * left — a card is drawn only for the call the report comes from (core/replies currentReportCallId).
 */
const reportCardText = (
  args: Record<string, unknown>,
  report: ProjectBundle['project']['report'],
): { title: string; markdown: string } => {
  const whole = typeof args.markdown === 'string' ? args.markdown : '';
  if (whole.trim()) {
    return { title: String(args.title ?? 'Report'), markdown: whole };
  }
  return { title: String(args.title ?? report?.title ?? 'Report'), markdown: report?.markdown ?? '' };
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
  /**
   * A frame the AI looked at for itself, clicked: it is not one of the
   * thread's pictures (core/pictures discussPictureSequence), so it opens
   * among the frames of its own look, `among`.
   */
  onOpenLooked: (i: ProjectImage, among: ProjectImage[]) => void;
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
  onOpenLooked,
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
          {pictures ? (
            <Thumbs ids={imageIds} images={bundle.images} moments={lookedMoments(result)} onOpen={onOpenLooked} />
          ) : null}
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
          {...reportCardText(args, bundle.project.report)}
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
  onOpenLooked,
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
  onOpenLooked: (i: ProjectImage, among: ProjectImage[]) => void;
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
      onOpenLooked={onOpenLooked}
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
        return (
          <ReportCard
            key={p.call.id}
            {...reportCardText(parseArgs(p.call.args), bundle.project.report)}
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
  onDeleteFrom,
  deleteBlocked = null,
  onOpenImage,
  onOpenLooked,
  onOpenPhoto,
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
  /** Delete from Here on one of the user's messages (the owner's page): the page asks, then deletes it and all after it. */
  onDeleteFrom?: (turn: Turn) => void;
  /** Why nothing can be deleted right now (the AI is answering); null when it can. */
  deleteBlocked?: string | null;
  onOpenImage: (i: ProjectImage) => void;
  /** A frame the AI looked at for itself, clicked: it opens among the frames of that look, not the thread's pictures. */
  onOpenLooked: (i: ProjectImage, among: ProjectImage[]) => void;
  /** A photo the user sent, clicked: it opens where the thread's pictures do. */
  onOpenPhoto: (p: LightboxPicture) => void;
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
  const names = useMemo(() => captureNames(bundle.project), [bundle.project]);
  // captures since removed, by id, for the tiles of the messages that carried them
  const removed = useMemo(() => {
    const m = new Map<string, { name: string; cap: CaptureName | null }>();
    for (const t of bundle.turns) {
      if (t.role === 'note' && t.note?.type === 'takeRemoved') {
        m.set(t.note.takeId, { name: t.note.name, cap: removedCaptureName(t.note) });
      }
    }
    return m;
  }, [bundle.turns]);
  // the replies whose steps the reader opened or closed, by row key; the rest stay folded
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  const entriesOf = (turn: Turn): CaptureEntry[] => {
    return turnTakeIds(turn).map((id) => {
      const take = bundle.project.takes.find((t) => t.takeId === id) ?? null;
      const gone = removed.get(id);
      return {
        takeId: id,
        take,
        name: take?.name ?? gone?.name ?? 'A capture',
        cap: names.get(id) ?? gone?.cap ?? null,
      };
    });
  };
  // the buttons of one of the user's messages, where the page offers them: the last thing in the message
  const actions = (turn: Turn, text: string | null) =>
    onDeleteFrom ? <MessageActions text={text} blocked={deleteBlocked} onDelete={() => onDeleteFrom(turn)} /> : null;
  const who = ownerName ?? 'You';

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
              onOpenLooked={onOpenLooked}
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
              {actions(item, null)}
            </div>
          );
        }
        if (item.role === 'user') {
          const entries = entriesOf(item);
          const words = item.text?.trim() ? item.text : null;
          return (
            <div key={row.key} className="dc-user">
              {ownerName && <span className="dc-user-name">{ownerName}</span>}
              <CaptureTiles entries={entries} cloud={cloud} onOpenPhoto={onOpenPhoto} />
              {words != null && <div className="dc-bubble">{words}</div>}
              {actions(item, words)}
            </div>
          );
        }
        if (item.role === 'event') {
          const entries = entriesOf(item);
          return (
            <div key={row.key} className="dc-line">
              {entries.length > 0 ? `Added ${entries.map((e) => e.cap?.label ?? e.name).join(', ')}` : 'Added captures'}
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
            const cap = removedCaptureName(item.note);
            return (
              <div key={row.key} className="dc-line">
                {`Removed ${cap ? `${cap.label} (${item.note.name})` : item.note.name}`}
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
