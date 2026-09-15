/**
 * Who may ask for an AI lab report, and how often — the decisions, kept out of index.ts so they can be
 * read and tested without the Firestore plumbing around them.
 *
 * The report used to be staff-only (an @intofuture.org email). It is now open to every signed-in account
 * (app repo docs/proposals/ai-open-access.md), and what an account's email decides is its TIER:
 *  - staff (a verified @intofuture.org address): no quota and no server-side consent check. The website
 *    has no consent dialog and is not changing, so enforcing one here would switch its AI buttons off;
 *  - private (everyone else): a recorded agreement to send the data to a third-party provider
 *    (users/{mongoId}/consents/aiThirdParty, written by the app), and three quotas — per account per hour,
 *    per account per day, and one daily total across all personal accounts, which is the cost ceiling.
 * A suspended account (uploadsSuspendedAt, set from the moderation queue) loses AI with its uploads.
 *
 * The quota numbers live in config/aiLimits so staff can change them from the console without a deploy;
 * missing or malformed values fall back to the defaults below.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpsError, type CallableRequest, type CallableResponse } from 'firebase-functions/v2/https';

export type AiTier = 'staff' | 'private';

/** Bump when the disclosure the app shows changes in substance (a new provider, a new kind of data):
 *  every personal account is then asked again. Keep in step with the app's src/lib/aiConsent.ts. */
export const AI_CONSENT_VERSION = 1;
export const AI_CONSENT_DOC_ID = 'aiThirdParty';
/** The prefix the app recognises to reopen its consent checkbox instead of showing an error. */
export const AI_CONSENT_REQUIRED = 'AI_CONSENT_REQUIRED';

const STAFF_EMAIL_SUFFIX = '@intofuture.org';

/**
 * Appended to every lab-report system prompt. The Terms already forbid using the app for body temperature
 * or medical, health or veterinary purposes; this keeps the report from offering such a judgement anyway
 * when a person or an animal is in the frame, or when the owner's notes ask for one.
 */
export const AI_SAFETY_RULE =
  'Do not make medical, body-temperature, health or veterinary judgements. When people or animals appear, describe only heat-transfer physics — surface temperatures, emissivity, ambient conditions — never their health or condition.';

export function withAiSafetyRule(systemPrompt: string): string {
  return `${systemPrompt}\n\n${AI_SAFETY_RULE}`;
}

/** Staff only with a VERIFIED company address: an unverified email is a claim anyone can type. */
export function aiTierOf(token: { email?: unknown; email_verified?: unknown }): AiTier {
  const email = typeof token.email === 'string' ? token.email.toLowerCase() : '';
  return token.email_verified === true && email.endsWith(STAFF_EMAIL_SUFFIX) ? 'staff' : 'private';
}

export interface AiAccessDenial {
  code: 'permission-denied' | 'failed-precondition';
  message: string;
}

/**
 * The access decision, in the order the checks run (each later fact is only read when the earlier checks
 * passed — see requireAiAccess). `consentVersion` is ignored for staff.
 */
export function aiAccessDenial(facts: {
  emailVerified: boolean;
  tier: AiTier;
  suspended: boolean;
  consentVersion: number | null;
}): AiAccessDenial | null {
  // Google and Apple sign-in always verify; this is for a future email-and-password sign-in.
  if (!facts.emailVerified) {
    return { code: 'permission-denied', message: "Verify your account's email address to use AI." };
  }
  if (facts.suspended) return { code: 'permission-denied', message: 'AI is unavailable for this account.' };
  if (facts.tier === 'private' && (facts.consentVersion == null || facts.consentVersion < AI_CONSENT_VERSION)) {
    return {
      code: 'failed-precondition',
      message: `${AI_CONSENT_REQUIRED}: Agree to send this data to the AI provider first.`,
    };
  }
  return null;
}

/** A consent document's version, or null when it is absent or not a number. */
export function consentVersionOf(data: { version?: unknown } | undefined): number | null {
  return typeof data?.version === 'number' && Number.isFinite(data.version) ? data.version : null;
}

/** The little of Firestore requireAiAccess reads through — the Admin SDK instance satisfies it. */
export interface AiAccessDb {
  doc(path: string): { get(): Promise<{ data(): Record<string, unknown> | undefined }> };
}

/**
 * Throws the HttpsError for a caller who may not generate a report; returns their tier otherwise. Runs
 * after requireMongoId and before anything is loaded or charged. The consent document is read only for a
 * personal account.
 */
export async function requireAiAccess(
  db: AiAccessDb,
  token: { email?: unknown; email_verified?: unknown },
  mongoId: string,
): Promise<{ tier: AiTier }> {
  const tier = aiTierOf(token);
  const emailVerified = token.email_verified === true;
  // The email check needs no read, so it runs before the two below are spent on a caller it refuses.
  const early = aiAccessDenial({ emailVerified, tier, suspended: false, consentVersion: AI_CONSENT_VERSION });
  if (early) throw new HttpsError(early.code, early.message);

  const [user, consent] = await Promise.all([
    db.doc(`users/${mongoId}`).get(),
    tier === 'private' ? db.doc(`users/${mongoId}/consents/${AI_CONSENT_DOC_ID}`).get() : Promise.resolve(null),
  ]);
  const denial = aiAccessDenial({
    emailVerified,
    tier,
    suspended: user.data()?.uploadsSuspendedAt != null,
    consentVersion: consent ? consentVersionOf(consent.data()) : null,
  });
  if (denial) throw new HttpsError(denial.code, denial.message);
  return { tier };
}

// ---------------------------------------------------------------------------------------------------------
// Quotas
// ---------------------------------------------------------------------------------------------------------

export interface AiLimits {
  /** Reports per personal account per rolling hour. */
  privateHourly: number;
  /** Reports per personal account per rolling 24 hours. */
  privateDaily: number;
  /** Reports across ALL personal accounts per UTC day — the cost ceiling. */
  privateGlobalDaily: number;
}

export const DEFAULT_AI_LIMITS: Readonly<AiLimits> = { privateHourly: 10, privateDaily: 30, privateGlobalDaily: 200 };

export const AI_HOUR_MS = 60 * 60 * 1000;
export const AI_DAY_MS = 24 * AI_HOUR_MS;
/** aiRateLimits/{mongoId} outlives the 24-hour window it tracks by a margin (TTL on expireAt). */
export const AI_RATE_DOC_TTL_MS = 26 * AI_HOUR_MS;
/** aiGlobal/{yyyymmdd} is kept a week past its day, for a look back at recent totals. */
export const AI_GLOBAL_DOC_TTL_MS = 8 * AI_DAY_MS;
/** A staff account is never refused; past this many calls in an hour, a log line says so (a runaway script). */
export const AI_STAFF_BURST_COUNT = 200;

/** config/aiLimits → limits. Each field must be a positive integer; anything else takes its default. */
export function parseAiLimits(data: unknown): AiLimits {
  const d = (data ?? {}) as Record<string, unknown>;
  const pick = (key: keyof AiLimits): number => {
    const v = d[key];
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : DEFAULT_AI_LIMITS[key];
  };
  return {
    privateHourly: pick('privateHourly'),
    privateDaily: pick('privateDaily'),
    privateGlobalDaily: pick('privateGlobalDaily'),
  };
}

/**
 * config/aiLimits, re-read at most once a minute per instance. A failed read keeps the last good limits
 * (the defaults before there were any) and tries again on the next call instead of waiting out the minute.
 */
export function createAiLimitsCache(
  load: () => Promise<unknown>,
  opts: { ttlMs?: number; now?: () => number } = {},
): () => Promise<AiLimits> {
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let cached: AiLimits | null = null;
  let loadedAt = 0;
  return async () => {
    if (cached && now() - loadedAt < ttlMs) return cached;
    try {
      cached = parseAiLimits(await load());
      loadedAt = now();
      return cached;
    } catch (err) {
      console.warn('config/aiLimits unreadable, using the last known limits', err);
      return cached ?? { ...DEFAULT_AI_LIMITS };
    }
  };
}

/** The UTC day a global counter belongs to, as its document id: 20260915. */
export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '');
}

/** 00:00 UTC of the day nowMs falls in. The global counter's day starts here and ends a day later. */
export function utcDayStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export type AiRateWindow = 'hour' | 'day' | 'global';

/** The refusal text the app shows as it is. Waits round UP, so "in 1 minute" is never early. */
export function aiRateLimitMessage(window: AiRateWindow, limit: number, waitMs: number): string {
  if (window === 'global') return 'AI reports are busy today. Please try again tomorrow.';
  if (window === 'hour') {
    const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
    return `You've used this hour's ${limit} AI reports. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  }
  const hours = Math.max(1, Math.ceil(waitMs / AI_HOUR_MS));
  return `You've used today's ${limit} AI reports. Try again in ${hours} ${hours === 1 ? 'hour' : 'hours'}.`;
}

/** aiRateLimits/{mongoId}. `count`/`windowStart` predate the tiers; a document without the day fields
 *  simply starts a fresh day window. */
export interface AiRateDoc {
  count?: unknown;
  windowStart?: unknown;
  dayCount?: unknown;
  dayStart?: unknown;
}

function openWindow(start: unknown, count: unknown, nowMs: number, windowMs: number): { start: number; count: number } {
  if (typeof start === 'number' && nowMs - start < windowMs) {
    return { start, count: typeof count === 'number' && count > 0 ? count : 0 };
  }
  return { start: nowMs, count: 0 };
}

export type AiRateCharge =
  | {
      ok: true;
      user: { count: number; windowStart: number; dayCount: number; dayStart: number };
      /** The new all-personal-accounts total for today; null for staff, who are not counted in it. */
      globalCalls: number | null;
      /** Set when a staff account has just passed AI_STAFF_BURST_COUNT in its hour. */
      staffBurst: number | null;
    }
  | { ok: false; window: AiRateWindow; message: string };

/**
 * One call's charge against the counters as read in the transaction. A personal account over more than one
 * limit is told about the one that clears LAST — that is when a retry can actually succeed; naming the
 * hour while the day is also spent would send them back in twenty minutes to be refused again.
 */
export function planAiRateCharge(input: {
  tier: AiTier;
  nowMs: number;
  user: AiRateDoc | undefined;
  /** Today's aiGlobal privateCalls (ignored for staff). */
  globalCalls: unknown;
  limits: AiLimits;
}): AiRateCharge {
  const { tier, nowMs, limits } = input;
  const hour = openWindow(input.user?.windowStart, input.user?.count, nowMs, AI_HOUR_MS);
  const day = openWindow(input.user?.dayStart, input.user?.dayCount, nowMs, AI_DAY_MS);
  const globalNow = typeof input.globalCalls === 'number' && input.globalCalls > 0 ? input.globalCalls : 0;

  if (tier === 'private') {
    const blocked: { window: AiRateWindow; limit: number; retryAt: number }[] = [];
    if (hour.count >= limits.privateHourly) {
      blocked.push({ window: 'hour', limit: limits.privateHourly, retryAt: hour.start + AI_HOUR_MS });
    }
    if (day.count >= limits.privateDaily) {
      blocked.push({ window: 'day', limit: limits.privateDaily, retryAt: day.start + AI_DAY_MS });
    }
    if (globalNow >= limits.privateGlobalDaily) {
      blocked.push({ window: 'global', limit: limits.privateGlobalDaily, retryAt: utcDayStartMs(nowMs) + AI_DAY_MS });
    }
    if (blocked.length > 0) {
      const last = blocked.reduce((a, b) => (b.retryAt > a.retryAt ? b : a));
      return {
        ok: false,
        window: last.window,
        message: aiRateLimitMessage(last.window, last.limit, last.retryAt - nowMs),
      };
    }
  }

  const count = hour.count + 1;
  return {
    ok: true,
    user: { count, windowStart: hour.start, dayCount: day.count + 1, dayStart: day.start },
    globalCalls: tier === 'private' ? globalNow + 1 : null,
    staffBurst: tier === 'staff' && count > AI_STAFF_BURST_COUNT ? count : null,
  };
}

/** A consumed slot: which windows it was taken from, so a refund never eats from a newer one. */
export interface AiRateSlot {
  mongoId: string;
  tier: AiTier;
  windowStart: number;
  dayStart: number;
  /** The aiGlobal day the call was counted in; null for staff. */
  globalDay: string | null;
}

/**
 * What to give back for a slot whose work never reached a provider. Each counter is decremented only while
 * it is still the window the slot was taken from (a rolled window already forgot the call), and never below
 * zero. Nulls mean "leave it".
 */
export function planAiRefund(
  slot: AiRateSlot,
  user: AiRateDoc | undefined,
  globalCalls: unknown,
  nowMs: number,
): { user: { count?: number; dayCount?: number } | null; globalCalls: number | null } {
  const patch: { count?: number; dayCount?: number } = {};
  if (user && user.windowStart === slot.windowStart && typeof user.count === 'number' && user.count > 0) {
    patch.count = user.count - 1;
  }
  if (user && user.dayStart === slot.dayStart && typeof user.dayCount === 'number' && user.dayCount > 0) {
    patch.dayCount = user.dayCount - 1;
  }
  const global =
    slot.globalDay != null && slot.globalDay === utcDayKey(nowMs) && typeof globalCalls === 'number' && globalCalls > 0
      ? globalCalls - 1
      : null;
  return { user: Object.keys(patch).length > 0 ? patch : null, globalCalls: global };
}

// ---------------------------------------------------------------------------------------------------------
// Usage tags
// ---------------------------------------------------------------------------------------------------------

/**
 * Per-invocation fields for the `ai_usage` log lines. The report's model calls log their token counts deep
 * inside shared helpers that know nothing about the caller, so the tier rides in an AsyncLocalStorage scope
 * opened around the callable instead of being threaded through every signature. `run` (not `enterWith`)
 * keeps the scope to this invocation's own async tree — concurrent requests on one instance never see each
 * other's tags.
 */
const usageScope = new AsyncLocalStorage<Record<string, unknown>>();

/** Wraps an onCall handler. Typed for exactly that shape, so the handler's parameters keep their types; the
 *  request data defaults to any, as onCall's own does. */
export function withAiUsageScope<T = any, R = unknown>(
  handler: (request: CallableRequest<T>, response?: CallableResponse) => R,
): (request: CallableRequest<T>, response?: CallableResponse) => R {
  return (request, response) => usageScope.run({}, () => handler(request, response));
}

/** Adds fields to the current scope's usage lines; a no-op outside withAiUsageScope. */
export function tagAiUsage(tags: Record<string, unknown>): void {
  const store = usageScope.getStore();
  if (store) Object.assign(store, tags);
}

export function aiUsageTags(): Record<string, unknown> {
  return { ...(usageScope.getStore() ?? {}) };
}
