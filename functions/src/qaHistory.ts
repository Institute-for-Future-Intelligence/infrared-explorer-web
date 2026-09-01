/**
 * The conversation so far, as it comes back from the browser with a follow-up question.
 *
 * Q&A used to be one-shot: every question reached the model alone, so "why?" or "what about the second
 * one?" had nothing to refer to. The panel now replays the earlier turns, which means untrusted text —
 * the student's own questions, and answers the model wrote earlier — is fed back into a prompt. Hence
 * this: a hard cap on how many turns and how much of each survive, and a shape the caller cannot bend
 * into anything but alternating user/assistant text.
 *
 * The caps are deliberately mean. History is context for a follow-up, not a transcript to reason over:
 * the authoritative numbers ride on the CURRENT turn, and a long replayed thread would crowd them out
 * (and be billed for again on every question).
 */

/** How many earlier turns reach the model, newest last. Older ones are dropped, not summarized. */
export const QA_HISTORY_TURNS = 6;
/** Per-turn character caps. An earlier answer is there to be referred back to, not re-read in full. */
export const QA_HISTORY_QUESTION_CHARS = 500;
export const QA_HISTORY_ANSWER_CHARS = 2000;
/** Attached-moment times carried per turn (the images themselves are never re-sent). */
export const QA_HISTORY_MOMENTS = 3;

/** One earlier exchange, ready to expand into a user/assistant message pair. */
export interface QaHistoryTurn {
  question: string;
  answer: string;
  /** When that question's attached moments were, in seconds. Their images are not repeated. */
  momentTimes: number[];
}

/** Clip to `max` characters on a word boundary where there is one nearby, marking the cut so the model
 *  doesn't read a truncated answer as a complete one. */
function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > max * 0.8 ? cut.slice(0, lastSpace) : cut}… [earlier answer truncated]`;
}

/**
 * Normalize the client's replayed thread: keep only turns that have both a question and an answer, cap
 * their number and length, and reduce each moment list to a few finite times. Anything malformed is
 * dropped rather than repaired — a bad entry costs a follow-up its context, never the answer itself.
 */
export function sanitizeQaHistory(value: unknown): QaHistoryTurn[] {
  if (!Array.isArray(value)) return [];
  const out: QaHistoryTurn[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const { question, answer, momentTimes } = raw as {
      question?: unknown;
      answer?: unknown;
      momentTimes?: unknown;
    };
    if (typeof question !== 'string' || typeof answer !== 'string') continue;
    const q = clip(question, QA_HISTORY_QUESTION_CHARS);
    const a = clip(answer, QA_HISTORY_ANSWER_CHARS);
    if (!q || !a) continue; // a turn missing either half is not an exchange
    out.push({
      question: q,
      answer: a,
      momentTimes: (Array.isArray(momentTimes) ? momentTimes : [])
        .map((t) => Number(t))
        .filter((t) => Number.isFinite(t) && t >= 0)
        .slice(0, QA_HISTORY_MOMENTS)
        .map((t) => Number(t.toFixed(1))),
    });
  }
  // Newest turns win when the client sends more than the cap — the follow-up is about what just happened.
  return out.slice(-QA_HISTORY_TURNS);
}
