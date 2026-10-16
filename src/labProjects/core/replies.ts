/*
 * How Discuss reads the AI's turns as replies (docs/proposals/
 * ai-experiment-projects.md, decision ㊻). Everything the AI said and did
 * between two things the user did is one reply. Its last turn is the answer;
 * the turns before it are the steps that got there — the AI's running words,
 * the frames it looked at, what it measured, the code it ran — which fold
 * away under one line once the answer is in. What the steps made for the
 * user (a drawing, a chart, the pictures its code drew, the plan, the report)
 * belongs with the answer, not with the steps — except in a reply that writes
 * the report, which shows the report alone (replyWritesReport).
 *
 * Pure; tested in __tests__/labProjectsReplies.test.ts.
 */

import {markdownImageIds} from './markdown';
import type {ProjectImage, StoredToolCall, Turn} from './types';

export type DiscussRow =
  | {kind: 'turn'; key: string; turn: Turn}
  /** `askedForReport`: the user's turn the reply answers is Generate Report. */
  | {kind: 'reply'; key: string; turns: Turn[]; askedForReport: boolean};

/**
 * Discuss's rows, top to bottom: each of the user's turns on its own, and the
 * AI's turns that run together as one reply. Tool turns are not rows (the
 * calls that made them are drawn with their reply).
 */
export function discussRows(turns: Turn[]): DiscussRow[] {
  const rows: DiscussRow[] = [];
  let askedForReport = false;
  for (const t of turns) {
    if (t.role === 'tool') {
      continue;
    }
    if (t.role === 'assistant') {
      const last = rows[rows.length - 1];
      if (last?.kind === 'reply') {
        last.turns.push(t);
      } else {
        rows.push({kind: 'reply', key: `reply-${t.seq}`, turns: [t], askedForReport});
      }
    } else {
      if (t.role === 'user' || t.role === 'event') {
        askedForReport = t.request === 'report';
      }
      rows.push({kind: 'turn', key: String(t.seq), turn: t});
    }
  }
  return rows;
}

/**
 * The reply writes the report: the user asked for it with Generate Report,
 * or the AI wrote it. Such a reply shows the report and no other picture
 * (user, 2026-10-16): the frames the AI looked at and what its code drew on
 * the way were the way to the report, which carries the ones that count.
 * Generate Report is known before the AI does anything, so none of its
 * pictures shows and then goes; a report asked for in words is known once
 * the AI starts writing it.
 */
export function replyWritesReport(turns: Turn[], askedForReport: boolean): boolean {
  return askedForReport || turns.some(t => (t.toolCalls ?? []).some(c => c.name === 'write_report'));
}

/**
 * The write_report call the project's report comes from now: the last one
 * the server took. Each call replaces the report and no version is kept
 * (decision ⑲), so Discuss shows this one only — the report as it is, once
 * (user, 2026-10-16) — and an earlier call, in the same reply or another,
 * shows as the step it was. `results`: every tool turn of the project, by call.
 */
export function currentReportCallId(results: ReadonlyMap<string, Turn>): string | null {
  let current: Turn | null = null;
  for (const r of results.values()) {
    if (r.name === 'write_report' && r.ok !== false && (current == null || r.seq > current.seq)) {
      current = r;
    }
  }
  return current?.callId ?? null;
}

/** A reply still being made ends on a turn that asked for tools: the answer has not come yet. */
export function replyUnfinished(turns: Turn[]): boolean {
  const last = turns[turns.length - 1];
  return last != null && (last.toolCalls?.length ?? 0) > 0;
}

/**
 * A reply's parts: the steps and the answer. The answer is the last turn —
 * the model stops calling tools when it has it — unless the reply is still
 * being made (`live`) and its last turn asked for tools: then every turn is
 * a step and the answer is still to come. A reply that was cut short keeps
 * its last turn as the answer, tools and all.
 */
export function replyParts(turns: Turn[], live: boolean): {steps: Turn[]; answer: Turn | null} {
  if (turns.length === 0) {
    return {steps: [], answer: null};
  }
  if (live && replyUnfinished(turns)) {
    return {steps: turns, answer: null};
  }
  return {steps: turns.slice(0, -1), answer: turns[turns.length - 1]};
}

export type ReplyProduct =
  | {kind: 'picture'; call: StoredToolCall; image: ProjectImage}
  | {kind: 'plan'; call: StoredToolCall}
  | {kind: 'report'; call: StoredToolCall; writtenAt: number};

/**
 * What the steps made for the user, in the order made: each drawing and
 * chart, the pictures the AI's code drew, the plan it wrote and the report —
 * less any picture the answer shows itself, which would show twice. A call
 * that failed made nothing. A reply that writes the report (replyWritesReport)
 * made no picture to show, and its report shows only while it is the
 * project's report (currentReportCallId) — from the answer too, when the
 * reply was cut short on that call.
 */
export function replyProducts(
  steps: Turn[],
  results: ReadonlyMap<string, Turn>,
  images: ProjectImage[],
  answer: Turn | null,
  askedForReport = false,
): ReplyProduct[] {
  const byId = new Map(images.map(i => [i.id, i]));
  const shown = new Set(markdownImageIds(answer?.text ?? ''));
  const forReport = replyWritesReport(answer ? [...steps, answer] : steps, askedForReport);
  const currentReport = currentReportCallId(results);
  const out: ReplyProduct[] = [];
  const pictures = (call: StoredToolCall, ids: string[]) => {
    if (forReport) {
      return;
    }
    for (const id of ids) {
      const image = byId.get(id);
      if (image && !shown.has(id)) {
        shown.add(id);
        out.push({kind: 'picture', call, image});
      }
    }
  };
  for (const t of steps) {
    for (const call of t.toolCalls ?? []) {
      const result = results.get(call.id);
      if (!result || result.ok === false) {
        continue;
      }
      const ids = result.result?.imageIds ?? [];
      switch (call.name) {
        case 'draw':
        case 'chart':
          pictures(call, ids.slice(0, 1));
          break;
        case 'run_code':
          pictures(call, ids);
          break;
        case 'write_plan':
          out.push({kind: 'plan', call});
          break;
        case 'write_report':
          if (call.id === currentReport) {
            out.push({kind: 'report', call, writtenAt: result.at});
          }
          break;
        default:
          break;
      }
    }
  }
  for (const call of answer?.toolCalls ?? []) {
    const result = results.get(call.id);
    if (call.name === 'write_report' && call.id === currentReport && result) {
      out.push({kind: 'report', call, writtenAt: result.at});
    }
  }
  return out;
}

/**
 * The pictures a reply's steps keep to themselves: the frames the AI looked
 * at (shown where it looked) — none in a reply that writes the report.
 */
export function stepPictureIds(call: StoredToolCall, result: Turn | undefined, forReport = false): string[] {
  return call.name === 'look' && !forReport ? result?.result?.imageIds ?? [] : [];
}

function phrase(call: StoredToolCall, takeName: (id: unknown) => string): string {
  let args: Record<string, unknown> = {};
  try {
    const v = JSON.parse(call.args || '{}');
    args = v && typeof v === 'object' ? v : {};
  } catch {
    // no arguments to read
  }
  switch (call.name) {
    case 'look':
      return `Looked at ${takeName(args.takeId)}`;
    case 'measure':
      return `Measured ${takeName(args.takeId)}`;
    case 'chart':
      return 'Drew a chart';
    case 'draw':
      return 'Drew a picture';
    case 'run_code':
      return 'Ran code';
    case 'place_sensors':
      return 'Placed sensors';
    case 'write_plan':
      return 'Wrote the plan';
    case 'write_report':
      return 'Wrote the report';
    case 'set_title':
      return 'Named the project';
    case 'view':
      return 'Looked at pictures';
    case 'suggest_shot':
      return 'Suggested a shot';
    default: {
      const words = call.name.replace(/_/g, ' ');
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}

/**
 * One line saying what the steps did, each thing once with a count when it
 * was done more than once: "Looked at Capture 1 · Ran code ×3 · Drew a chart".
 */
export function stepsSummary(steps: Turn[], takeName: (id: unknown) => string): string {
  const counts = new Map<string, number>();
  for (const t of steps) {
    for (const call of t.toolCalls ?? []) {
      const p = phrase(call, takeName);
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    return 'Thought it over';
  }
  return [...counts.entries()].map(([p, n]) => (n > 1 ? `${p} ×${n}` : p)).join(' · ');
}
