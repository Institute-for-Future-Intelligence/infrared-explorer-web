/*
 * Agreeing to send a project's data to a third-party AI provider before the
 * first turn — the website's version of the app's lib/labProjects/consent.ts
 * (that one keeps its note in AsyncStorage; the logic is the same).
 *
 * The record is the server's: labProjectsConsent/{uid}, written through the
 * labProjectConsent callable. labProjectTurn refuses a non-staff account
 * without it ("AI_CONSENT_REQUIRED: …"), and the runner answers that by
 * forgetting the local note and asking again. Staff are not checked
 * server-side, but the page asks them once all the same, as the app does.
 *
 * The local note only saves the round-trip: it is keyed by account and
 * version, and a note for an older version is no note at all.
 */

import { recordConsent } from './api';

/** Bump to re-ask everyone. Must match the app's consent.ts and functions/src/config.ts CONSENT_VERSION. */
export const CONSENT_VERSION = 1;

/** The prefix labProjectTurn's refusal starts with (functions/src/access.ts). */
export const CONSENT_REQUIRED = 'AI_CONSENT_REQUIRED';

const storageKey = (uid: string): string => `labProjects.consent.${uid || 'anon'}`;

/** The company behind a model, from the label the project page shows ("GPT-5.6" → OpenAI). */
export function providerNameFor(modelLabel: string | null | undefined): string {
  const l = (modelLabel ?? '').toLowerCase();
  if (l.includes('gpt') || l.includes('openai')) {
    return 'OpenAI';
  }
  if (l.includes('gemini') || l.includes('google')) {
    return 'Google';
  }
  if (l.includes('grok')) {
    return 'xAI';
  }
  if (l.includes('deepseek')) {
    return 'DeepSeek';
  }
  return modelLabel?.trim() || 'the AI provider';
}

/** True when the refusal is the server asking for the agreement rather than reporting a failure. */
export function isConsentRequired(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.startsWith(CONSENT_REQUIRED);
}

/** Whether this account's note says it agreed to the current version. */
export function hasProjectConsent(uid: string): boolean {
  try {
    const raw = localStorage.getItem(storageKey(uid));
    const version = raw ? (JSON.parse(raw) as { version?: unknown }).version : null;
    return typeof version === 'number' && version >= CONSENT_VERSION;
  } catch {
    return false;
  }
}

/** Record the agreement on the server, then note it locally. A failed call throws and notes nothing. */
export async function recordProjectConsent(uid: string): Promise<void> {
  await recordConsent();
  try {
    localStorage.setItem(storageKey(uid), JSON.stringify({ version: CONSENT_VERSION }));
  } catch {
    // the server has the record; the next turn simply asks the server again
  }
}

/** Forget the local note: the server said there is no agreement on file. */
export function forgetProjectConsent(uid: string): void {
  try {
    localStorage.removeItem(storageKey(uid));
  } catch {
    // nothing to forget
  }
}
