/*
 * The model's view of a recording conversation for one call: the system prompt (the app's fixed text in
 * its recording setting, then where things stand), and the turns as OpenAI-style messages — the app's
 * functions/src/context.ts, rewritten for one recording: there is no plan and no drawings, the overview
 * is the recording's own, and a user message may carry the moments the user attached in the player.
 *
 * Pictures cost tokens on every call, so only the images produced since the user's last message (what
 * the model asked to see in this run, and the moments the user sent) travel as pixels; older ones are
 * named by id and caption, and `view` brings any of them back.
 */
import { SAFETY_RULE } from '../labCore/config';
import type { ChatContentPart, ChatMessage } from '../labCore/llm';
import { basePrompt } from '../labCore/prompt';
import type { ImageDoc, NoteRec } from '../labCore/store';
import { describeSelection } from '../twinBuilding';
import { imageBytes, type RecTurnDoc } from './store';

const dataUrl = (mime: string, b64: string) => `data:${mime};base64,${b64}`;

/** Bytes already in memory for images made in this invocation. */
export type FreshBytes = Map<string, string>;

async function imagePart(doc: Pick<ImageDoc, 'id' | 'path' | 'mime'>, fresh: FreshBytes): Promise<ChatContentPart> {
  const b64 = fresh.get(doc.id) ?? (await imageBytes(doc)).b64;
  return { type: 'image_url', image_url: { url: dataUrl(doc.mime, b64) } };
}

const describeImage = (doc: Pick<ImageDoc, 'id' | 'caption'>): string => `[image ${doc.id}: ${doc.caption}]`;

/** The report as the experiment has it, as the model is told of it. */
export interface ReportInContext {
  title: string;
  text: string;
  by: 'ai' | 'user';
  at: number;
  images: { id: string; caption: string }[];
}

export interface Setting {
  kind: 'thread' | 'run';
  mode?: 'revise' | 'rewrite';
  recording: { expId: string; title: string; kind: 'recording' | 'time-lapse recording' | 'photo set' };
  /** The experiment's current report: for a revise run its whole text; otherwise named only. */
  report: ReportInContext | null;
  summary: string | null;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** Where things stand, rebuilt for every model call (the app's stateSection, for one recording). */
export function stateSection(s: Setting): string {
  const lines: string[] = [
    '',
    'Where things stand',
    `- Recording: "${s.recording.title}", a ${s.recording.kind}. Its id, the take your tools read, is ${s.recording.expId}.`,
  ];
  if (s.kind === 'run') {
    if (s.mode === 'revise' && s.report) {
      lines.push(
        `- Report ("${s.report.title}"), ${s.report.by === 'user' ? 'last edited by the user' : 'written by you'} ${fmtDate(
          s.report.at,
        )}, as it now reads — the user asked for it to be revised:`,
      );
      lines.push('<report>', s.report.text, '</report>');
      if (s.report.images.length > 0) {
        lines.push(
          '- Pictures the current report embeds (id, caption), which view can show you and the revised report can keep:',
        );
        for (const i of s.report.images) lines.push(`  - ${i.id}: ${i.caption}`);
      }
    } else if (s.report) {
      lines.push('- Report: an earlier report exists and is to be replaced from scratch; it is not shown to you.');
    } else {
      lines.push('- Report: not written yet.');
    }
  } else if (s.report) {
    lines.push(
      `- Report ("${s.report.title}"): written ${fmtDate(s.report.at)}${
        s.report.by === 'user' ? ', since edited by the user' : ''
      }. The user reads it under AI Report; it is written and revised in a run of its own, not in this conversation.`,
    );
  } else {
    lines.push(
      '- Report: none yet. It is written in a run of its own when the user presses Generate Report, not in this conversation.',
    );
  }
  if (s.summary) lines.push('', 'Summary of the earlier part of the conversation', s.summary);
  return lines.join('\n');
}

export function systemPrompt(s: Setting): string {
  return `${basePrompt('web', 'recording')}\n${stateSection(s)}\n\n${SAFETY_RULE}`;
}

/** A note (something the user did outside the conversation), as the model reads it — the app's noteText. */
export function noteText(note: NoteRec): string {
  switch (note.type) {
    case 'planEdited':
      return `The user edited the plan themselves. What changed (- removed, + added, … unchanged):\n${note.diff}`;
    case 'reportEdited':
      return `The user edited the report themselves${
        note.title ? `; it is now titled “${note.title}”` : ''
      }. The report as it now reads is under "Where things stand". What changed (- removed, + added, … unchanged):\n${note.diff}`;
    case 'takeRemoved':
      return `The user removed take ${note.takeId}${note.n != null ? ` (Capture ${note.n})` : ''} ("${note.name}") from the experiment.`;
  }
}

/** What a user turn says, as the model reads it: their words, or the button they pressed (with their notes). */
export function userText(t: RecTurnDoc): string {
  if (t.request === 'report') {
    const asked = '[App] The owner asked for the report with the Generate Report button in the AI Report tab.';
    return t.text?.trim() ? `${asked}\n\n[App] The owner's notes for the report: ${t.text.trim()}` : asked;
  }
  return t.text ?? '';
}

/** Index of the turn that started the current run (the last user message). */
export function runStartIndex(turns: RecTurnDoc[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user' || turns[i].role === 'event') return i;
  }
  return 0;
}

/** The recording's overview and its sheets, as a user turn carried them: the text, then the pictures. */
async function overviewParts(
  event: NonNullable<RecTurnDoc['event']>,
  byId: Map<string, ImageDoc>,
  current: boolean,
  fresh: FreshBytes,
): Promise<ChatContentPart[]> {
  const parts: ChatContentPart[] = [
    {
      type: 'text',
      text: `[App] The recording's overview, computed from the stored data in the browser:\n${event.takes
        .map((k) => k.overview)
        .join('\n\n')}`,
    },
  ];
  for (const id of event.imageIds) {
    const doc = byId.get(id);
    if (!doc) continue;
    if (current) {
      parts.push({ type: 'text', text: describeImage(doc) });
      parts.push(await imagePart(doc, fresh));
    } else {
      parts.push({ type: 'text', text: `${describeImage(doc)} (use view to see it again)` });
    }
  }
  return parts;
}

/** The moments the user attached to a message: their captures of the player, each with the time it shows. */
async function momentParts(
  ids: string[],
  byId: Map<string, ImageDoc>,
  current: boolean,
  fresh: FreshBytes,
): Promise<ChatContentPart[]> {
  const docs = ids.map((id) => byId.get(id)).filter((d): d is ImageDoc => d != null);
  if (docs.length === 0) return [];
  const parts: ChatContentPart[] = [
    {
      type: 'text',
      text: `[App] The user attached ${docs.length === 1 ? 'a moment' : `${docs.length} moments`} from the player — the frame as they see it, with their sensors, notes and lines drawn on${
        current ? ':' : ' (use view to see them again):'
      }`,
    },
  ];
  for (const d of docs) {
    parts.push({ type: 'text', text: describeImage(d) });
    if (current) parts.push(await imagePart(d, fresh));
  }
  return parts;
}

export async function buildMessages(
  setting: Setting,
  turns: RecTurnDoc[],
  images: ImageDoc[],
  fresh: FreshBytes,
  /** Another conversation's system prompt (TurnToolset); left out, the recording AI's. */
  system?: string,
): Promise<ChatMessage[]> {
  const byId = new Map(images.map((i) => [i.id, i]));
  const messages: ChatMessage[] = [{ role: 'system', content: system ?? systemPrompt(setting) }];
  const start = runStartIndex(turns);

  const toolTurns = new Map<string, RecTurnDoc>();
  for (const t of turns) {
    if (t.role === 'tool' && t.callId) toolTurns.set(t.callId, t);
  }

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const current = i >= start;
    if (t.role === 'user') {
      const said = userText(t);
      const parts: ChatContentPart[] = said.trim() ? [{ type: 'text', text: said }] : [];
      // A twin build's message carries what the owner selected in the twin's view (§44.10): named as the
      // revision note names a selection, so the model finds each in the program.
      if (t.selection && t.selection.length > 0) {
        parts.push({
          type: 'text',
          text: `[App] The owner selected in the twin's view, before writing: ${t.selection.map(describeSelection).join('; ')}. The message is about ${t.selection.length === 1 ? 'that' : 'those'} unless it plainly says otherwise — find each in the program by its part, size and position.`,
        });
      }
      if (t.event && t.event.takes.length > 0) parts.push(...(await overviewParts(t.event, byId, current, fresh)));
      if (t.momentImageIds && t.momentImageIds.length > 0) {
        parts.push(...(await momentParts(t.momentImageIds, byId, current, fresh)));
      }
      messages.push(
        parts.length === 1 && parts[0].type === 'text'
          ? { role: 'user', content: parts[0].text }
          : { role: 'user', content: parts },
      );
    } else if (t.role === 'note' && t.note) {
      messages.push({ role: 'user', content: `[App] ${noteText(t.note)}` });
    } else if (t.role === 'assistant') {
      const calls = t.toolCalls ?? [];
      messages.push({
        role: 'assistant',
        content: t.text ?? '',
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.args || '{}' },
                ...(c.signature ? { extra_content: { google: { thought_signature: c.signature } } } : {}),
              })),
            }
          : {}),
      });
      // Every call needs its result right after the assistant message. A call with none (the browser never
      // returned it, or the user moved on) is closed as cancelled so the conversation stays well-formed.
      const pictures: ChatContentPart[] = [];
      for (const c of calls) {
        const r = toolTurns.get(c.id);
        if (!r) {
          messages.push({
            role: 'tool',
            tool_call_id: c.id,
            content: 'No result: this call was not completed (the browser did not return it, or the user moved on).',
          });
          continue;
        }
        const listed = (r.result?.imageIds ?? []).map((id) => byId.get(id)).filter((d): d is ImageDoc => d != null);
        const suffix =
          listed.length > 0
            ? `\nImages: ${listed.map(describeImage).join(' ')}${current ? '' : ' (use view to see them again)'}`
            : '';
        messages.push({
          role: 'tool',
          tool_call_id: c.id,
          content: `${r.ok === false ? 'Failed: ' : ''}${r.result?.text ?? ''}${suffix}`,
        });
        if (current) {
          for (const d of listed) {
            pictures.push({ type: 'text', text: describeImage(d) });
            pictures.push(await imagePart(d, fresh));
          }
        }
      }
      if (pictures.length > 0) {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: '[App] Images returned by the tools above:' }, ...pictures],
        });
      }
    }
    // Tool turns are emitted with their assistant message above; event turns do not occur here.
  }
  return messages;
}

/** A rough token estimate of a message list (4 characters a token, ~800 a picture). */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  let pictures = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') chars += p.text.length;
        else pictures += 1;
      }
    }
    if (m.role === 'assistant' && m.tool_calls) {
      for (const c of m.tool_calls) chars += c.function.arguments.length;
    }
  }
  return Math.round(chars / 4) + pictures * 800;
}

/** The conversation as text, for the summary that folds its older part (the app's transcriptOf). */
export function transcriptOf(turns: RecTurnDoc[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    if (t.role === 'user') {
      lines.push(`User: ${userText(t)}`);
      if (t.event?.takes.length)
        lines.push(
          `(with it: the recording's overview ${t.event.takes.map((k) => k.overview.slice(0, 1500)).join(' | ')})`,
        );
    } else if (t.role === 'assistant') {
      if (t.text?.trim()) lines.push(`Assistant: ${t.text}`);
      for (const c of t.toolCalls ?? []) lines.push(`Assistant called ${c.name} ${c.args.slice(0, 400)}`);
    } else if (t.role === 'tool') {
      lines.push(`Result of ${t.name}: ${(t.result?.text ?? '').slice(0, 1500)}`);
    } else if (t.role === 'note' && t.note) {
      lines.push(`App note: ${noteText(t.note).slice(0, 1500)}`);
    }
  }
  return lines.join('\n');
}
