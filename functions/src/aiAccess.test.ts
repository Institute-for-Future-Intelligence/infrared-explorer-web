/**
 * Tests for who may generate an AI lab report and how often (aiAccess.ts).
 *
 * The promises pinned here face two ways. To a personal account: the refusal names the limit it hit and a
 * wait that is never too short, and a report that never reached a provider costs nothing. To the budget:
 * nothing a personal account can do gets past the consent record or the three quotas, and a staff account —
 * which the website still relies on, with no consent dialog of its own — is never refused by either.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  AI_CONSENT_VERSION,
  AI_DAY_MS,
  AI_HOUR_MS,
  AI_SAFETY_RULE,
  AI_STAFF_BURST_COUNT,
  DEFAULT_AI_LIMITS,
  aiAccessDenial,
  aiRateLimitMessage,
  aiTierOf,
  aiUsageTags,
  consentVersionOf,
  createAiLimitsCache,
  parseAiLimits,
  planAiRateCharge,
  planAiRefund,
  requireAiAccess,
  tagAiUsage,
  utcDayKey,
  utcDayStartMs,
  withAiSafetyRule,
  withAiUsageScope,
  type AiAccessDb,
  type AiRateSlot,
} from './aiAccess';

// 2026-09-15 10:00:00 UTC
const NOW = Date.UTC(2026, 8, 15, 10, 0, 0);
const MIN = 60_000;
const limits = { ...DEFAULT_AI_LIMITS };

const verified = (email: string) => ({ email, email_verified: true });

describe('aiTierOf', () => {
  it('is staff only for a verified company address', () => {
    assert.equal(aiTierOf(verified('someone@intofuture.org')), 'staff');
    assert.equal(aiTierOf(verified('Someone@IntoFuture.ORG')), 'staff');
    assert.equal(aiTierOf({ email: 'someone@intofuture.org', email_verified: false }), 'private');
    assert.equal(aiTierOf({ email: 'someone@intofuture.org' }), 'private');
  });

  it('does not mistake a lookalike domain for the company', () => {
    assert.equal(aiTierOf(verified('someone@intofuture.org.example.com')), 'private');
    assert.equal(aiTierOf(verified('someone@notintofuture.org')), 'private');
    assert.equal(aiTierOf(verified('student@gmail.com')), 'private');
    assert.equal(aiTierOf({ email_verified: true }), 'private');
  });
});

describe('aiAccessDenial', () => {
  const ok = { emailVerified: true, tier: 'private' as const, suspended: false, consentVersion: AI_CONSENT_VERSION };

  it('lets a verified, unsuspended personal account with consent through', () => {
    assert.equal(aiAccessDenial(ok), null);
    assert.equal(aiAccessDenial({ ...ok, consentVersion: AI_CONSENT_VERSION + 1 }), null);
  });

  it('checks in order: email, then suspension, then consent', () => {
    assert.deepEqual(aiAccessDenial({ ...ok, emailVerified: false, suspended: true, consentVersion: null }), {
      code: 'permission-denied',
      message: "Verify your account's email address to use AI.",
    });
    assert.deepEqual(aiAccessDenial({ ...ok, suspended: true, consentVersion: null }), {
      code: 'permission-denied',
      message: 'AI is unavailable for this account.',
    });
    assert.deepEqual(aiAccessDenial({ ...ok, consentVersion: null }), {
      code: 'failed-precondition',
      message: 'AI_CONSENT_REQUIRED: Agree to send this data to the AI provider first.',
    });
  });

  it('asks again for a consent recorded under an older version', () => {
    assert.equal(aiAccessDenial({ ...ok, consentVersion: 0 })?.code, 'failed-precondition');
  });

  it('never asks staff for consent, but still suspends them', () => {
    assert.equal(aiAccessDenial({ ...ok, tier: 'staff', consentVersion: null }), null);
    assert.equal(
      aiAccessDenial({ ...ok, tier: 'staff', suspended: true })?.message,
      'AI is unavailable for this account.',
    );
  });
});

describe('consentVersionOf', () => {
  it('reads a numeric version and nothing else', () => {
    assert.equal(consentVersionOf({ version: 1 }), 1);
    assert.equal(consentVersionOf({ version: '1' }), null);
    assert.equal(consentVersionOf({}), null);
    assert.equal(consentVersionOf(undefined), null);
  });
});

describe('requireAiAccess', () => {
  const fakeDb = (docs: Record<string, Record<string, unknown>>) => {
    const reads: string[] = [];
    const db: AiAccessDb = {
      doc: (path) => ({
        get: async () => {
          reads.push(path);
          return { data: () => docs[path] };
        },
      }),
    };
    return { db, reads };
  };
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      assert.ok(e instanceof HttpsError);
      return { code: e.code, message: e.message };
    }
    assert.fail('expected a refusal');
  };

  it('refuses an unverified email before reading anything', async () => {
    const { db, reads } = fakeDb({});
    const r = await refusal(requireAiAccess(db, { email: 'a@gmail.com', email_verified: false }, 'u1'));
    assert.equal(r.code, 'permission-denied');
    assert.deepEqual(reads, []);
  });

  it('asks a personal account without a consent record to agree', async () => {
    const { db } = fakeDb({ 'users/u1': {} });
    const r = await refusal(requireAiAccess(db, verified('a@gmail.com'), 'u1'));
    assert.equal(r.code, 'failed-precondition');
    assert.ok(r.message.startsWith('AI_CONSENT_REQUIRED'));
  });

  it('lets a personal account with consent through, and reads its consent document', async () => {
    const { db, reads } = fakeDb({ 'users/u1/consents/aiThirdParty': { version: 1 } });
    assert.deepEqual(await requireAiAccess(db, verified('a@gmail.com'), 'u1'), { tier: 'private' });
    assert.deepEqual(reads.sort(), ['users/u1', 'users/u1/consents/aiThirdParty']);
  });

  it('refuses a suspended account even with consent', async () => {
    const { db } = fakeDb({
      'users/u1': { uploadsSuspendedAt: { seconds: 1 } },
      'users/u1/consents/aiThirdParty': { version: 1 },
    });
    const r = await refusal(requireAiAccess(db, verified('a@gmail.com'), 'u1'));
    assert.deepEqual(r, { code: 'permission-denied', message: 'AI is unavailable for this account.' });
  });

  it('lets staff through without looking for a consent document', async () => {
    const { db, reads } = fakeDb({});
    assert.deepEqual(await requireAiAccess(db, verified('t@intofuture.org'), 's1'), { tier: 'staff' });
    assert.deepEqual(reads, ['users/s1']);
  });
});

describe('parseAiLimits', () => {
  it('uses the defaults for a missing document', () => {
    assert.deepEqual(parseAiLimits(undefined), { privateHourly: 10, privateDaily: 30, privateGlobalDaily: 200 });
  });

  it('takes each valid field and defaults each invalid one on its own', () => {
    assert.deepEqual(parseAiLimits({ privateHourly: 5, privateDaily: 0, privateGlobalDaily: 500 }), {
      privateHourly: 5,
      privateDaily: 30,
      privateGlobalDaily: 500,
    });
    assert.deepEqual(
      parseAiLimits({ privateHourly: 2.5, privateDaily: '40', privateGlobalDaily: -1 }),
      DEFAULT_AI_LIMITS,
    );
    assert.deepEqual(parseAiLimits({ privateHourly: Number.NaN }), DEFAULT_AI_LIMITS);
  });
});

describe('createAiLimitsCache', () => {
  it('reads at most once per minute', async () => {
    let t = 0;
    let loads = 0;
    const read = createAiLimitsCache(async () => ({ privateHourly: ++loads }), { now: () => t });
    assert.equal((await read()).privateHourly, 1);
    t = 59_999;
    assert.equal((await read()).privateHourly, 1);
    t = 60_000;
    assert.equal((await read()).privateHourly, 2);
  });

  it('keeps the last good limits through a failed read, and retries on the next call', async () => {
    let t = 0;
    let fail = false;
    let loads = 0;
    const read = createAiLimitsCache(
      async () => {
        loads++;
        if (fail) throw new Error('unavailable');
        return { privateDaily: 12 };
      },
      { now: () => t },
    );
    assert.equal((await read()).privateDaily, 12);
    fail = true;
    t = 61_000;
    assert.equal((await read()).privateDaily, 12);
    assert.equal((await read()).privateDaily, 12);
    assert.equal(loads, 3);
  });

  it('falls back to the defaults when the first read fails', async () => {
    const read = createAiLimitsCache(async () => {
      throw new Error('unavailable');
    });
    assert.deepEqual(await read(), DEFAULT_AI_LIMITS);
  });
});

describe('UTC day', () => {
  it('names and starts the day in UTC', () => {
    assert.equal(utcDayKey(NOW), '20260915');
    assert.equal(utcDayKey(Date.UTC(2026, 11, 31, 23, 59, 59)), '20261231');
    assert.equal(utcDayStartMs(NOW), Date.UTC(2026, 8, 15));
  });
});

describe('aiRateLimitMessage', () => {
  it('rounds the wait up and never says less than one', () => {
    assert.equal(
      aiRateLimitMessage('hour', 10, 22 * MIN + 1),
      "You've used this hour's 10 AI reports. Try again in 23 minutes.",
    );
    assert.equal(
      aiRateLimitMessage('hour', 10, 30_000),
      "You've used this hour's 10 AI reports. Try again in 1 minute.",
    );
    assert.equal(aiRateLimitMessage('hour', 10, 0), "You've used this hour's 10 AI reports. Try again in 1 minute.");
    assert.equal(
      aiRateLimitMessage('day', 30, 4 * AI_HOUR_MS + 1),
      "You've used today's 30 AI reports. Try again in 5 hours.",
    );
    assert.equal(aiRateLimitMessage('day', 30, AI_HOUR_MS), "You've used today's 30 AI reports. Try again in 1 hour.");
    assert.equal(aiRateLimitMessage('global', 200, 5), 'AI reports are busy today. Please try again tomorrow.');
  });
});

describe('planAiRateCharge', () => {
  const charge = (over: Partial<Parameters<typeof planAiRateCharge>[0]>) =>
    planAiRateCharge({ tier: 'private', nowMs: NOW, user: undefined, globalCalls: undefined, limits, ...over });

  it('opens both windows on a first report and counts it globally', () => {
    assert.deepEqual(charge({}), {
      ok: true,
      user: { count: 1, windowStart: NOW, dayCount: 1, dayStart: NOW },
      globalCalls: 1,
      staffBurst: null,
    });
  });

  it('treats a counter from before the tiers as a fresh day', () => {
    const r = charge({ user: { count: 4, windowStart: NOW - 10 * MIN }, globalCalls: 7 });
    assert.deepEqual(r, {
      ok: true,
      user: { count: 5, windowStart: NOW - 10 * MIN, dayCount: 1, dayStart: NOW },
      globalCalls: 8,
      staffBurst: null,
    });
  });

  it('refuses the eleventh report in an hour with the minutes left', () => {
    const r = charge({ user: { count: 10, windowStart: NOW - 37 * MIN, dayCount: 10, dayStart: NOW - 37 * MIN } });
    assert.deepEqual(r, {
      ok: false,
      window: 'hour',
      message: "You've used this hour's 10 AI reports. Try again in 23 minutes.",
    });
  });

  it('starts a new hour once the old one has passed', () => {
    const r = charge({ user: { count: 10, windowStart: NOW - AI_HOUR_MS, dayCount: 10, dayStart: NOW - AI_HOUR_MS } });
    assert.ok(r.ok);
    assert.deepEqual(r.user, { count: 1, windowStart: NOW, dayCount: 11, dayStart: NOW - AI_HOUR_MS });
  });

  it('refuses the thirty-first report in a day with the hours left', () => {
    const r = charge({
      user: { count: 2, windowStart: NOW - 5 * MIN, dayCount: 30, dayStart: NOW - 19 * AI_HOUR_MS - 1 },
    });
    assert.deepEqual(r, {
      ok: false,
      window: 'day',
      message: "You've used today's 30 AI reports. Try again in 5 hours.",
    });
  });

  it('refuses everyone once the personal accounts have used the day', () => {
    const r = charge({ globalCalls: 200 });
    assert.deepEqual(r, {
      ok: false,
      window: 'global',
      message: 'AI reports are busy today. Please try again tomorrow.',
    });
  });

  it('names the limit that clears last when more than one is spent', () => {
    const both = { count: 10, windowStart: NOW - 50 * MIN, dayCount: 30, dayStart: NOW - 2 * AI_HOUR_MS };
    const r = charge({ user: both });
    assert.equal(r.ok ? null : r.window, 'day');
    // 23:30 UTC: the hour clears at 23:40 but the global day not until midnight.
    const late = Date.UTC(2026, 8, 15, 23, 30);
    const g = charge({ nowMs: late, user: { count: 10, windowStart: late - 50 * MIN }, globalCalls: 200 });
    assert.equal(g.ok ? null : g.window, 'global');
    // 23:55 UTC: midnight comes before the hour does.
    const later = Date.UTC(2026, 8, 15, 23, 55);
    const h = charge({ nowMs: later, user: { count: 10, windowStart: later - 30 * MIN }, globalCalls: 200 });
    assert.equal(h.ok ? null : h.window, 'hour');
  });

  it('follows the configured numbers', () => {
    const tight = { privateHourly: 2, privateDaily: 3, privateGlobalDaily: 1000 };
    const r = charge({ limits: tight, user: { count: 2, windowStart: NOW - 55 * MIN } });
    assert.deepEqual(r, {
      ok: false,
      window: 'hour',
      message: "You've used this hour's 2 AI reports. Try again in 5 minutes.",
    });
  });

  it('never refuses staff, and leaves the personal total alone', () => {
    const r = planAiRateCharge({
      tier: 'staff',
      nowMs: NOW,
      user: { count: 50, windowStart: NOW - MIN, dayCount: 500, dayStart: NOW - AI_HOUR_MS },
      globalCalls: 10_000,
      limits,
    });
    assert.deepEqual(r, {
      ok: true,
      user: { count: 51, windowStart: NOW - MIN, dayCount: 501, dayStart: NOW - AI_HOUR_MS },
      globalCalls: null,
      staffBurst: null,
    });
  });

  it('flags a staff burst past the threshold', () => {
    const at = (count: number) =>
      planAiRateCharge({ tier: 'staff', nowMs: NOW, user: { count, windowStart: NOW - MIN }, globalCalls: 0, limits });
    const under = at(AI_STAFF_BURST_COUNT - 1);
    const over = at(AI_STAFF_BURST_COUNT);
    assert.equal(under.ok && under.staffBurst, null);
    assert.equal(over.ok && over.staffBurst, AI_STAFF_BURST_COUNT + 1);
  });
});

describe('planAiRefund', () => {
  const slot: AiRateSlot = {
    mongoId: 'u1',
    tier: 'private',
    windowStart: NOW - 5 * MIN,
    dayStart: NOW - 3 * AI_HOUR_MS,
    globalDay: '20260915',
  };

  it('gives back every counter the slot took', () => {
    const user = { count: 3, windowStart: slot.windowStart, dayCount: 9, dayStart: slot.dayStart };
    assert.deepEqual(planAiRefund(slot, user, 40, NOW + MIN), { user: { count: 2, dayCount: 8 }, globalCalls: 39 });
  });

  it('leaves a window that has rolled since', () => {
    const user = { count: 1, windowStart: NOW + AI_HOUR_MS, dayCount: 9, dayStart: slot.dayStart };
    assert.deepEqual(planAiRefund(slot, user, 40, NOW + AI_HOUR_MS), { user: { dayCount: 8 }, globalCalls: 39 });
    const nextDay = utcDayStartMs(NOW) + AI_DAY_MS;
    assert.deepEqual(planAiRefund(slot, user, 40, nextDay).globalCalls, null);
  });

  it('never goes below zero, and does nothing without a document', () => {
    const user = { count: 0, windowStart: slot.windowStart, dayCount: 0, dayStart: slot.dayStart };
    assert.deepEqual(planAiRefund(slot, user, 0, NOW), { user: null, globalCalls: null });
    assert.deepEqual(planAiRefund(slot, undefined, undefined, NOW), { user: null, globalCalls: null });
  });

  it('has no global counter to refund for staff', () => {
    const staff: AiRateSlot = { ...slot, tier: 'staff', globalDay: null };
    const user = { count: 3, windowStart: slot.windowStart, dayCount: 9, dayStart: slot.dayStart };
    assert.deepEqual(planAiRefund(staff, user, 40, NOW), { user: { count: 2, dayCount: 8 }, globalCalls: null });
  });
});

describe('AI_SAFETY_RULE', () => {
  it('is appended after the prompt, word for word', () => {
    assert.equal(
      AI_SAFETY_RULE,
      'Do not make medical, body-temperature, health or veterinary judgements. When people or animals appear, describe only heat-transfer physics — surface temperatures, emissivity, ambient conditions — never their health or condition.',
    );
    assert.equal(withAiSafetyRule('PROMPT'), `PROMPT\n\n${AI_SAFETY_RULE}`);
  });
});

describe('usage tags', () => {
  it('keeps each invocation’s tags to itself', async () => {
    const seen: Record<string, unknown>[] = [];
    const handler = withAiUsageScope(async (request) => {
      const { tier, delay } = request.data as { tier: string; delay: number };
      await new Promise((r) => setTimeout(r, delay));
      tagAiUsage({ tier });
      await new Promise((r) => setTimeout(r, delay));
      seen.push(aiUsageTags());
    });
    await Promise.all([
      handler({ data: { tier: 'staff', delay: 15 } } as never),
      handler({ data: { tier: 'private', delay: 5 } } as never),
    ]);
    assert.deepEqual(seen, [{ tier: 'private' }, { tier: 'staff' }]);
    assert.deepEqual(aiUsageTags(), {});
  });

  it('is a no-op outside a scope', () => {
    tagAiUsage({ tier: 'staff' });
    assert.deepEqual(aiUsageTags(), {});
  });
});
