/**
 * Tests for flagging an AI lab report (aiReportFlags.ts).
 *
 * What matters: a flag can only be about something the reporter can actually read (a private experiment
 * answers a stranger like a missing one), the same person re-flagging the same text replaces their flag
 * rather than stacking a second one, a regenerated report is a new thing to flag, and the flag keeps
 * enough of the report for staff to judge it after the report itself has changed or gone. And the staff email
 * is coalesced, so a few accounts' flags cannot flood the inbox or spend the shared SMTP quota.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase-admin/firestore';
import { REPORT_EMAIL_THROTTLE_MS, rateLimitKeyHash } from './moderation';
import {
  AI_FLAG_EMAIL_EXCERPT,
  AI_FLAG_MAIL_PER_HOUR,
  AI_FLAG_MAIL_TOTAL_ID,
  AI_FLAG_RATE_MAX,
  AI_FLAG_RATE_WINDOW_MS,
  AI_FLAG_REPORT_TEXT_MAX,
  AI_FLAG_RETENTION_MS,
  aiFlagDocId,
  aiFlagEmail,
  aiFlagMailThrottleId,
  aiFlagRateKey,
  aiFlagReasonLabel,
  aiFlagRefileUpdate,
  buildAiFlagDoc,
  canFlagExperiment,
  hasAiReport,
  parseAiFlagInput,
  planAiFlagMail,
  planAiFlagRateCharge,
  reportAtMillis,
} from './aiReportFlags';

const NOW = 1_757_930_000_000;
const OWNER = '5fb99060cd30210004704d8c';
const VIEWER = '64a1f0c2e4b0a1b2c3d4e5f6';

describe('parseAiFlagInput', () => {
  it('accepts a well-formed flag, trimmed', () => {
    assert.deepEqual(parseAiFlagInput({ expId: ' e1 ', reason: 'inaccurate', details: '  wrong units \n' }), {
      expId: 'e1',
      reason: 'inaccurate',
      details: 'wrong units',
    });
    assert.deepEqual(parseAiFlagInput({ expId: 'e1', reason: 'inappropriate' }), {
      expId: 'e1',
      reason: 'inappropriate',
      details: '',
    });
  });

  it('refuses a missing or path-shaped experiment id', () => {
    assert.throws(() => parseAiFlagInput({ reason: 'other', details: 'x' }), /Missing expId/);
    assert.throws(() => parseAiFlagInput({ expId: 'a/b', reason: 'inaccurate' }), /Bad id/);
    assert.throws(() => parseAiFlagInput({ expId: 'x'.repeat(201), reason: 'inaccurate' }), /Bad id/);
    assert.throws(() => parseAiFlagInput(null), /Missing expId/);
  });

  it('only takes the three AI reasons', () => {
    assert.throws(() => parseAiFlagInput({ expId: 'e1', reason: 'privacy' }), /Pick a reason/);
    assert.throws(() => parseAiFlagInput({ expId: 'e1' }), /Pick a reason/);
  });

  it('needs a description for "Something else", and bounds every description', () => {
    assert.throws(
      () => parseAiFlagInput({ expId: 'e1', reason: 'other', details: '   ' }),
      /Please describe the problem\./,
    );
    assert.throws(
      () => parseAiFlagInput({ expId: 'e1', reason: 'other', details: 42 }),
      /Please describe the problem\./,
    );
    assert.equal(parseAiFlagInput({ expId: 'e1', reason: 'other', details: 'x'.repeat(500) }).details.length, 500);
    assert.throws(() => parseAiFlagInput({ expId: 'e1', reason: 'inaccurate', details: 'x'.repeat(501) }), /shorten/);
  });
});

describe('aiFlagReasonLabel', () => {
  it('matches the app’s wording', () => {
    assert.equal(aiFlagReasonLabel('inappropriate'), 'Inappropriate or offensive');
    assert.equal(aiFlagReasonLabel('inaccurate'), 'Inaccurate or misleading');
    assert.equal(aiFlagReasonLabel('other'), 'Something else');
  });
});

describe('aiFlagDocId', () => {
  it('is one document per reporter per version of the report', () => {
    const id = aiFlagDocId('e1', VIEWER, 1234);
    assert.match(id, /^e1__[0-9a-f]{24}__1234$/);
    assert.equal(aiFlagDocId('e1', VIEWER, 1234), id);
    assert.notEqual(aiFlagDocId('e1', OWNER, 1234), id);
    assert.notEqual(aiFlagDocId('e1', VIEWER, 5678), id);
  });

  it('does not spell out the reporter', () => {
    assert.ok(!aiFlagDocId('e1', VIEWER, 1).includes(VIEWER));
  });
});

describe('aiFlagRateKey', () => {
  it('keeps flags out of the street-view reporting budget', () => {
    assert.equal(aiFlagRateKey(VIEWER), `ai:${VIEWER}`);
    assert.notEqual(rateLimitKeyHash(aiFlagRateKey(VIEWER)), rateLimitKeyHash(`u:${VIEWER}`));
  });
});

describe('canFlagExperiment', () => {
  it('follows the experiments read rule', () => {
    assert.equal(canFlagExperiment({ visibility: 'public', ownerId: OWNER }, VIEWER), true);
    assert.equal(canFlagExperiment({ visibility: 'unlisted', ownerId: OWNER }, VIEWER), true);
    assert.equal(canFlagExperiment({ visibility: 'private', ownerId: OWNER }, VIEWER), false);
    assert.equal(canFlagExperiment({ ownerId: OWNER }, VIEWER), false);
    assert.equal(canFlagExperiment(undefined, VIEWER), false);
  });

  it('lets the owner flag their own report, whatever the visibility', () => {
    assert.equal(canFlagExperiment({ visibility: 'private', ownerId: OWNER }, OWNER), true);
  });
});

describe('hasAiReport', () => {
  it('needs report text', () => {
    assert.equal(hasAiReport({ aiReport: '# Report' }), true);
    assert.equal(hasAiReport({ aiReport: '   ' }), false);
    assert.equal(hasAiReport({}), false);
  });
});

describe('reportAtMillis', () => {
  it('reads what aiReportAt can be, and 0 for an old report without one', () => {
    assert.equal(reportAtMillis(Timestamp.fromMillis(NOW)), NOW);
    assert.equal(reportAtMillis(new Date(NOW)), NOW);
    assert.equal(reportAtMillis(NOW), NOW);
    assert.equal(reportAtMillis({ toMillis: () => NOW }), NOW);
    assert.equal(reportAtMillis(undefined), 0);
    assert.equal(reportAtMillis('yesterday'), 0);
  });
});

describe('buildAiFlagDoc', () => {
  const reportAt = Timestamp.fromMillis(NOW - 60_000);
  const exp = {
    displayName: 'Cooling mug',
    ownerId: OWNER,
    visibility: 'public',
    aiReport: 'x'.repeat(AI_FLAG_REPORT_TEXT_MAX + 50),
    aiReportModel: 'gpt56',
    aiReportAt: reportAt,
  };

  it('snapshots the report and who filed it', () => {
    const doc = buildAiFlagDoc({
      expId: 'e1',
      exp,
      input: { expId: 'e1', reason: 'inaccurate', details: 'wrong' },
      reporterId: VIEWER,
      nowMs: NOW,
    });
    assert.deepEqual(Object.keys(doc).sort(), [
      'createdAt',
      'details',
      'expId',
      'expOwnerId',
      'expTitle',
      'expireAt',
      'reason',
      'reportAt',
      'reportModel',
      'reportText',
      'reporterId',
      'reporterIsOwner',
      'status',
      'updatedAt',
    ]);
    assert.equal(doc.expTitle, 'Cooling mug');
    assert.equal(doc.expOwnerId, OWNER);
    assert.equal(doc.reportModel, 'gpt56');
    assert.equal(doc.reportAt, reportAt);
    assert.equal((doc.reportText as string).length, AI_FLAG_REPORT_TEXT_MAX);
    assert.equal(doc.reporterId, VIEWER);
    assert.equal(doc.reporterIsOwner, false);
    assert.equal(doc.status, 'open');
    assert.equal((doc.createdAt as Timestamp).toMillis(), NOW);
    assert.equal((doc.updatedAt as Timestamp).toMillis(), NOW);
    assert.equal((doc.expireAt as Timestamp).toMillis(), NOW + AI_FLAG_RETENTION_MS);
  });

  it('marks an owner flagging their own report, and survives a sparse experiment', () => {
    const doc = buildAiFlagDoc({
      expId: 'e2',
      exp: { ownerId: OWNER, aiReport: 'r' },
      input: { expId: 'e2', reason: 'other', details: 'why' },
      reporterId: OWNER,
      nowMs: NOW,
    });
    assert.equal(doc.reporterIsOwner, true);
    assert.equal(doc.expTitle, 'e2');
    assert.equal(doc.reportModel, null);
    assert.equal(doc.reportAt, null);
  });
});

describe('aiFlagRefileUpdate', () => {
  it('replaces only the reporter’s words and the update time', () => {
    const patch = aiFlagRefileUpdate({ expId: 'e1', reason: 'other', details: 'more' }, NOW);
    assert.deepEqual(Object.keys(patch).sort(), ['details', 'reason', 'updatedAt']);
    assert.equal((patch.updatedAt as Timestamp).toMillis(), NOW);
  });
});

describe('planAiFlagRateCharge', () => {
  it('allows ten flags an hour', () => {
    const first = planAiFlagRateCharge(undefined, NOW);
    assert.equal(first?.count, 1);
    assert.equal(first?.windowStart, NOW);
    const tenth = planAiFlagRateCharge({ count: AI_FLAG_RATE_MAX - 1, windowStart: NOW - 1000 }, NOW);
    assert.equal(tenth?.count, AI_FLAG_RATE_MAX);
    assert.equal(tenth?.windowStart, NOW - 1000);
    assert.equal(planAiFlagRateCharge({ count: AI_FLAG_RATE_MAX, windowStart: NOW - 1000 }, NOW), null);
  });

  it('starts over once the hour has passed', () => {
    const next = planAiFlagRateCharge({ count: AI_FLAG_RATE_MAX, windowStart: NOW - AI_FLAG_RATE_WINDOW_MS }, NOW);
    assert.equal(next?.count, 1);
    assert.equal(next?.windowStart, NOW);
    assert.ok((next?.expireAt.toMillis() ?? 0) > NOW + AI_FLAG_RATE_WINDOW_MS);
  });
});

describe('aiFlagEmail', () => {
  it('gives staff the report, the reason and where to act', () => {
    const { subject, text } = aiFlagEmail(
      'e1__abc__123',
      {
        expId: 'e1',
        expTitle: 'Cooling\nmug',
        reason: 'inappropriate',
        details: 'rude',
        reporterIsOwner: false,
        reportModel: 'grok',
        reportText: 'y'.repeat(AI_FLAG_EMAIL_EXCERPT + 10),
      },
      'infrared-explorer',
    );
    assert.equal(subject, '[AI report flagged] Cooling mug');
    assert.ok(text.includes('Reason: Inappropriate or offensive'));
    assert.ok(text.includes('Details: rude'));
    assert.ok(text.includes('Filed by: another viewer'));
    assert.ok(text.includes(`${'y'.repeat(AI_FLAG_EMAIL_EXCERPT)}…`));
    assert.ok(!text.includes('y'.repeat(AI_FLAG_EMAIL_EXCERPT + 1)));
    assert.ok(text.includes('https://ie.intofuture.org/experiments/e1'));
    assert.ok(
      text.includes(
        'https://console.firebase.google.com/project/infrared-explorer/firestore/databases/-default-/data/~2FaiReportFlags~2Fe1__abc__123',
      ),
    );
    assert.ok(text.includes('The full queue is aiReportFlags where status == "open".'));
    assert.ok(!text.includes('Not emailed'));
  });

  it('says what the throttle held back since the last email', () => {
    const { text } = aiFlagEmail('e1__abc__123', { expId: 'e1', reason: 'other' }, 'p', { experiment: 1, cap: 3 });
    assert.ok(text.includes('Not emailed since the last email about this experiment: 1 flag.'));
    assert.ok(text.includes(`Not emailed because more than ${AI_FLAG_MAIL_PER_HOUR} were due in an hour: 3 flags.`));
  });
});

describe('planAiFlagMail', () => {
  type Doc = Record<string, unknown>;
  // Firestore's merge, for the two throttle docs the trigger writes.
  function flag(docs: Map<string, Doc>, expId: string, nowMs: number) {
    const expKey = aiFlagMailThrottleId(expId);
    const plan = planAiFlagMail(docs.get(expKey), docs.get(AI_FLAG_MAIL_TOTAL_ID), nowMs);
    docs.set(expKey, { ...docs.get(expKey), ...plan.experimentWrite });
    if (plan.totalWrite) docs.set(AI_FLAG_MAIL_TOTAL_ID, { ...docs.get(AI_FLAG_MAIL_TOTAL_ID), ...plan.totalWrite });
    return plan;
  }

  it('keeps its buckets apart from street-view mail and from each other', () => {
    assert.equal(aiFlagMailThrottleId('abc'), 'aiflag_abc');
    assert.notEqual(aiFlagMailThrottleId('all'), AI_FLAG_MAIL_TOTAL_ID);
  });

  it('emails once per experiment per hour, and reports the rest on the next email', () => {
    const docs = new Map<string, Doc>();
    assert.equal(flag(docs, 'e1', NOW).send, true);
    const held = flag(docs, 'e1', NOW + 60_000);
    assert.equal(held.send, false);
    assert.equal(held.totalWrite, null, 'a flag held for its experiment does not use up the total');
    flag(docs, 'e1', NOW + 120_000);
    assert.equal(docs.get(AI_FLAG_MAIL_TOTAL_ID)?.sent, 1);

    const next = flag(docs, 'e1', NOW + REPORT_EMAIL_THROTTLE_MS);
    assert.equal(next.send, true);
    assert.equal(next.heldForExperiment, 2);
    assert.equal(docs.get(aiFlagMailThrottleId('e1'))?.suppressed, 0);
    assert.ok((next.experimentWrite.expireAt as Timestamp).toMillis() > NOW + 2 * REPORT_EMAIL_THROTTLE_MS);
  });

  it('holds flags past the hourly total without shutting their experiments out', () => {
    const docs = new Map<string, Doc>();
    for (let i = 0; i < AI_FLAG_MAIL_PER_HOUR; i++) assert.equal(flag(docs, `e${i}`, NOW + i).send, true);
    const capped = flag(docs, 'late', NOW + 100);
    assert.equal(capped.send, false);
    flag(docs, 'later', NOW + 200);
    assert.equal(docs.get(AI_FLAG_MAIL_TOTAL_ID)?.suppressed, 2);
    assert.equal(docs.get(aiFlagMailThrottleId('late'))?.windowStart, undefined);

    // The next hour: the held experiment mails on its next flag, and that email counts both kinds of hold.
    const after = flag(docs, 'late', NOW + REPORT_EMAIL_THROTTLE_MS);
    assert.equal(after.send, true);
    assert.equal(after.heldForExperiment, 1);
    assert.equal(after.heldByCap, 2);
    assert.deepEqual(
      { sent: docs.get(AI_FLAG_MAIL_TOTAL_ID)?.sent, suppressed: docs.get(AI_FLAG_MAIL_TOTAL_ID)?.suppressed },
      { sent: 1, suppressed: 0 },
    );
  });

  it('reads junk counters as empty', () => {
    const plan = planAiFlagMail({ windowStart: 'x', suppressed: -4 }, { windowStart: NOW, sent: 'many' }, NOW);
    assert.equal(plan.send, true);
    assert.equal(plan.heldForExperiment, 0);
    assert.deepEqual(Object.keys(plan.totalWrite ?? {}).sort(), ['expireAt', 'sent']);
    assert.equal(plan.totalWrite?.sent, 1);
  });
});
