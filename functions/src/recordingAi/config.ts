/*
 * Constants of the analyzer's recording AI (Ask AI and AI Report on the app's AI flow; see
 * docs/analyzer-ai-app-flow-plan.md). The turn constants take the app's values (its functions/src/
 * config.ts and turn.ts) so a conversation behaves the same on both sides.
 */

/** The tools the browser runs over the recording's frames (src/labProjects/browserTools.ts BROWSER_TOOLS). */
export const BROWSER_TOOLS = ['look', 'run_code'] as const;

/** The server tools an Ask AI thread declares: it never writes the report (decision A: the report is a run of its own). */
export const THREAD_SERVER_TOOLS = ['view'] as const;

/** The server tools a report run declares. */
export const RUN_SERVER_TOOLS = ['view', 'write_report'] as const;

/** Model calls one request may make before it hands back with `limit`. */
export const MAX_MODEL_CALLS_PER_INVOCATION = 10;

/** Rough context budget (tokens) before older turns are folded into a summary; the summary keeps the last KEEP_RECENT_TURNS. */
export const CONTEXT_BUDGET_TOKENS = 300_000;
export const KEEP_RECENT_TURNS = 40;

/** A request holds a conversation's lock this long at most; a crashed one frees it after this. */
export const LOCK_STALE_MS = 9 * 60 * 1000;

/** A report run's documents outlive the report they wrote by this long (Firestore TTL on `expireAt`), for a look back. */
export const RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Characters of a user message that are kept. */
export const MAX_TEXT = 8000;
/** Characters of a browser tool result's text that are kept (run_code prints up to 20,000, plus a returned value). */
export const MAX_RESULT_TEXT = 150_000;
/** Images one input may carry: the overview's sheets plus the moments. */
export const MAX_IMAGES_PER_INPUT = 48;
export const MAX_IMAGE_B64 = 6 * 1024 * 1024;
/** Moments (player captures) one message may attach — the analyzer's chip tray holds three. */
export const MAX_MOMENTS = 3;
/** Characters of the overview's text that are kept. */
export const MAX_OVERVIEW_TEXT = 40_000;

/** The owner's notes for a report run (the client's textarea stops at the same length). */
export const REPORT_NOTES_MAX = 1000;
/** A report's Markdown, written by the model or edited by the owner. */
export const REPORT_MARKDOWN_MAX = 100_000;
/** Figures of a report that come back to the model with it as pictures, at most (the app's REPORT_FIGURES_BACK). */
export const REPORT_FIGURES_BACK = 12;
