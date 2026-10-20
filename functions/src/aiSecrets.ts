/*
 * The AI providers' keys, in Secret Manager (defineSecret) like SMTP_USER / SMTP_PASS; they never reach a
 * client. One module so index.ts, recordingAi/ and labCore/secrets.ts bind the same params (defining a
 * secret twice would register it twice). All optional: the functions deploy without them, and a model
 * whose key is unset fails at call time with a plain message.
 */
import { defineSecret } from 'firebase-functions/params';

export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
// Keys for the OpenAI-compatible third-party models. DeepSeek, OpenAI (ChatGPT) and xAI (Grok) all speak
// the same /chat/completions API, so one selectable model each rides the shared OpenAI-compatible path.
export const DEEPSEEK_API_KEY = defineSecret('DEEPSEEK_API_KEY');
export const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
export const XAI_API_KEY = defineSecret('XAI_API_KEY');
// Google AI Studio (Gemini) key. Gemini exposes an OpenAI-compatible endpoint, so it rides the same path.
export const GOOGLE_API_KEY = defineSecret('GOOGLE_API_KEY');

/** The keys the chat models the website offers need (every provider but Anthropic). */
export const CHAT_SECRETS = [DEEPSEEK_API_KEY, OPENAI_API_KEY, XAI_API_KEY, GOOGLE_API_KEY];
