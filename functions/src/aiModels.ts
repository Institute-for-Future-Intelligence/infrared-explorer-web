/*
 * The chat models the website's AI surfaces offer, and how a client's model key resolves: the table the
 * Q&A / report callables, the Lab Assistant, the twin and the analyzer's recording AI (recordingAi/)
 * share. Moved out of index.ts on 2026-10-19 so recordingAi/ can import it without a cycle.
 */

// The model each key stands for — provider + the vendor's model id. The provider decides the call path
// (see the provider `vision` flag in index.ts). The concrete model ids are slugs of the product's model
// names — adjust here if a vendor's real id differs. The Claude (Anthropic) entries are retained but no
// longer offered by the client picker; they keep the anthropic call path wired (re-add one to MODEL_KEYS
// in src/types.ts to surface Claude again).
export const QA_MODELS = {
  sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  opus: { provider: 'anthropic', model: 'claude-opus-4-8' },
  // GPT-6 Luna since 2026-10-16, in place of GPT-5.6 Luna ('gpt56') and GPT-5.2 ('gpt52'), now retired
  // (RETIRED_MODEL_KEYS). On /v1/chat/completions it takes function tools only with reasoning_effort
  // 'none', as GPT-5.6 Luna did (checked 2026-10-16), so toolCallExtras stands as it is.
  gpt6luna: { provider: 'openai', model: 'gpt-6-luna' },
  // Gemini 3.8 Flash since 2026-11-02, in place of Gemini 2.5 Pro ('gemini', now retired:
  // RETIRED_MODEL_KEYS) — better and cheaper. Its tool calls carry thought signatures that must go back
  // with them (index.ts withGeminiSignatures; labCore/llm.ts wireMessages).
  gemini38flash: { provider: 'google', model: 'gemini-3.8-flash' },
  // Grok 4.7 since 2026-10-16, in place of Grok 4.5 ('grok', now retired: RETIRED_MODEL_KEYS); same
  // request shapes (tools, images, json_schema, streamed usage — checked that day).
  grok47: { provider: 'xai', model: 'grok-4.7' },
  // DeepSeek's alias for its newest Flash model, which DeepSeek moves on its own (V4.1 Flash since
  // 2026-09-10); it reads images. Named "DeepSeek Flash" with no version since 2026-10-30. The one DeepSeek
  // entry since V4-Pro and V4-Flash were merged into it (2026-09-11, see RETIRED_MODEL_KEYS), and the
  // building twin's default (TWIN_BUILDING_MODEL_KEY).
  deepseek: { provider: 'deepseek', model: 'deepseek-flash' },
} as const;
export type QaModelKey = keyof typeof QA_MODELS;
// Model keys currently OFFERED to clients — mirrors MODEL_KEYS in src/types.ts. The deprecated Claude keys
// (sonnet/opus) are deliberately EXCLUDED: their Anthropic call path stays wired in QA_MODELS/AGENT_MODELS,
// but a (possibly stale) client can no longer select them — an unknown/deprecated key falls back to the
// default. This stops an old localStorage 'sonnet'/'opus' from silently invoking (paid) Claude.
export const OFFERED_MODEL_KEYS = ['gpt6luna', 'gemini38flash', 'grok47', 'deepseek'] as const;
export type OfferedModelKey = (typeof OFFERED_MODEL_KEYS)[number];
// Keys the client offered before and may still send — a tab opened before the picker changed, or a stale
// localStorage value. DeepSeek V4-Pro and V4-Flash were merged into 'deepseek' (2026-09-11), so a request
// naming either still gets DeepSeek rather than silently falling back to the default vendor. GPT-5.6 Luna
// and GPT-5.2 were retired into GPT-6 Luna the same way (2026-10-16) — the app builds already in stores
// send 'gpt56' for every report. Grok 4.5 ('grok') went into Grok 4.7 ('grok47') the same day, and
// Gemini 2.5 Pro ('gemini') into Gemini 3.8 Flash ('gemini38flash') on 2026-11-02 — the app builds in the
// stores send 'gemini' when a user picked Gemini. Mirrors RETIRED_MODELS in src/types.ts.
export const RETIRED_MODEL_KEYS: Record<string, OfferedModelKey> = {
  deepseekPro: 'deepseek',
  deepseekFlash: 'deepseek',
  gpt56: 'gpt6luna',
  gpt52: 'gpt6luna',
  grok: 'grok47',
  gemini: 'gemini38flash',
};
// The vendor ids of the retired models, for stored records that name their model only by id (twins from
// before the owner chose, §20).
export const RETIRED_MODEL_IDS: Record<string, OfferedModelKey> = {
  'gpt-5.6-luna': 'gpt6luna',
  'gpt-5.2': 'gpt6luna',
  'grok-4.5': 'grok47',
  'gemini-2.5-pro': 'gemini38flash',
};
// The offered key a client's model value names: an offered key as is, a retired one as its successor,
// anything else null (the caller substitutes its default). Array membership and an own-property lookup
// (NOT `in` on a model map, which would also match inherited Object.prototype names or the deprecated
// sonnet/opus entries) — a crafted value resolves to the default. Serves both the Q&A/report and agent
// callables (identical key sets). Typed as the whole key set rather than the offered five, so the callers'
// wired-but-unoffered anthropic branches still type-check.
export const offeredModelKey = (v: unknown): QaModelKey | null => {
  if (typeof v !== 'string') return null;
  if ((OFFERED_MODEL_KEYS as readonly string[]).includes(v)) return v as OfferedModelKey;
  return Object.prototype.hasOwnProperty.call(RETIRED_MODEL_KEYS, v) ? RETIRED_MODEL_KEYS[v] : null;
};
// Fallback when the client omits / sends an unknown model key, for the Q&A and report callables. Mirrors
// DEFAULT_MODEL in src/types.ts. The Lab Assistant (agentChat) has its own default — DEFAULT_AGENT_MODEL_KEY.
export const DEFAULT_MODEL_KEY: QaModelKey = 'gpt6luna';
