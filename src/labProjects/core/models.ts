/*
 * What the models of a project's conversation are called in the app: the one
 * that wrote a reply, and the one that wrote the report. Both come from what
 * each assistant turn records about itself, not from the project's current
 * pick — a project from before there was a pick may have fallen back to
 * another model.
 */

import type {Turn} from './types';

/** What the model that wrote an assistant turn is called: the server's label, or (an older server) its bare model name. */
export function modelNameOf(turn: Turn): string | undefined {
  return turn.modelLabel ?? (turn.model ? turn.model.slice(turn.model.indexOf('/') + 1) : undefined);
}

/**
 * What the model that wrote the project's report is called: the one whose
 * reply made the write_report call the report came from. Each call replaces
 * the report, so it is the last one; a call the server refused (an empty
 * report) wrote nothing. Null when the conversation holds no such call.
 */
export function reportModelName(turns: Turn[]): string | null {
  const refused = new Set(turns.filter(t => t.role === 'tool' && t.ok === false).map(t => t.callId));
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === 'assistant' && t.toolCalls?.some(c => c.name === 'write_report' && !refused.has(c.id))) {
      return modelNameOf(t) ?? null;
    }
  }
  return null;
}
