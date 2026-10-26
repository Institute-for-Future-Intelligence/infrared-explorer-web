/*
 * Shim for the app repository's functions/src/config.ts: the few constants and types the synced files
 * beside this one import (prompt.ts, toolSchemas.ts, llm.ts). Mirrored by hand — the app's config.ts
 * also holds that codebase's Firestore-backed model configuration and quotas, which the website has its
 * own of (aiModels.ts, aiAccess.ts). Keep the values equal to the app's: its config.ts is the source,
 * and a value that drifts means the same prompt behaves differently on the two sides.
 *
 * Not synced (scripts/sync-lab-core.mjs leaves it alone); see SOURCE.md.
 */

/** The one hard rule on what the model may say — the same words as the website's report rule. */
export { AI_SAFETY_RULE as SAFETY_RULE } from '../aiAccess';

/** Output cap for one model call. A report is written as a tool argument. */
export const MAX_OUTPUT_TOKENS = 12000;

/** How hard OpenAI's models think on a turn with tools (the Responses API's `reasoning.effort`). */
export const OPENAI_REASONING_EFFORT: 'low' | 'medium' | 'high' = 'high';

/** OpenAI's models may search the web on a turn with tools (hosted `web_search`); on trial since 2026-10-16. */
export const OPENAI_WEB_SEARCH = true;

export type ChatProvider = 'openai' | 'google' | 'xai' | 'deepseek';
export type ImageProvider = 'openai' | 'google';

export interface ChatModelSpec {
  provider: ChatProvider;
  model: string;
}
