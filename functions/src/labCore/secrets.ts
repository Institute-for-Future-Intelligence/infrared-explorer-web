/*
 * Shim for the app repository's functions/src/secrets.ts: `apiKeyFor`, as the synced llm.ts imports it,
 * over the website's own Secret Manager params (../aiSecrets.ts — the same secret names as the app's,
 * which is why the two codebases can share one Secret Manager). Not synced; see SOURCE.md.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import { DEEPSEEK_API_KEY, GOOGLE_API_KEY, OPENAI_API_KEY, XAI_API_KEY } from '../aiSecrets';
import type { ChatProvider, ImageProvider } from './config';

/** A key with stray quotes or whitespace removed (a value pasted with them would 401). */
function clean(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

export function apiKeyFor(provider: ChatProvider | ImageProvider): string {
  let raw = '';
  try {
    switch (provider) {
      case 'openai':
        raw = OPENAI_API_KEY.value();
        break;
      case 'google':
        raw = GOOGLE_API_KEY.value();
        break;
      case 'xai':
        raw = XAI_API_KEY.value();
        break;
      case 'deepseek':
        raw = DEEPSEEK_API_KEY.value();
        break;
    }
  } catch {
    raw = '';
  }
  const key = clean(raw ?? '');
  if (!key) {
    throw new HttpsError('failed-precondition', `The ${provider} model is not configured on the server.`);
  }
  return key;
}
