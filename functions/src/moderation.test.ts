/**
 * Tests for the street-view moderation decisions.
 *
 * What is pinned here is not "the code runs" but the set of promises the scheme makes to
 * two different audiences: a store reviewer (one report from a real account hides a real
 * panorama, immediately) and the map itself (nothing a stranger can do empties it). Each
 * gate below corresponds to a way one person could otherwise clear the map, so a test that
 * starts failing because a gate was "simplified" is telling you something.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_HIDE_GLOBAL_PER_HOUR,
  AUTO_HIDE_PER_REPORTER_24H,
  FALSE_REPORT_LIMIT,
  MAX_REPORT_DETAILS,
  NEW_ACCOUNT_MS,
  REPORT_FOLLOW_UP_MAX,
  appendFollowUp,
  followUpCount,
  followUpsSince,
  lastFollowUp,
  parseReportInput,
  reportDocId,
  reporterKeyDigest,
  reporterWeight,
  shouldAutoHide,
  subjectSafe,
  withinWindow,
} from './moderation';

const NOW = 1_756_000_000_000;

const established = {
  isVerifiedUser: true,
  falseReports: 0,
  accountCreatedAtMs: NOW - 30 * 24 * 60 * 60 * 1000,
  hasOwnUploads: false,
  nowMs: NOW,
};

const hideable = {
  weight: 1 as const,
  ownerId: '5fb99060cd30210004704d8c',
  alreadyReviewedKept: false,
  alreadyHidden: false,
  reporterHides24h: 0,
  globalHidesThisHour: 0,
};

describe('parseReportInput', () => {
  it('defaults to reporting the panorama and keeps the trimmed details', () => {
    const parsed = parseReportInput({ svId: ' abc123 ', reason: 'privacy', details: '  a face  ' });
    assert.equal(parsed.targetType, 'streetview');
    assert.equal(parsed.svId, 'abc123');
    assert.equal(parsed.details, 'a face');
  });

  it('accepts an author report, which is the half of the Play requirement content reports miss', () => {
    const parsed = parseReportInput({ targetType: 'author', authorId: 'abc', reason: 'spam' });
    assert.equal(parsed.targetType, 'author');
    assert.equal(parsed.authorId, 'abc');
  });

  it('accepts an experiment report — the other thing a user publishes — and needs its id', () => {
    const parsed = parseReportInput({ targetType: 'experiment', expId: ' exp1 ', reason: 'inappropriate' });
    assert.equal(parsed.targetType, 'experiment');
    assert.equal(parsed.expId, 'exp1');
    assert.equal(parsed.svId, undefined);
    assert.throws(() => parseReportInput({ targetType: 'experiment', reason: 'spam' }), /expId/i);
    // A street-view id does not stand in for the missing experiment id.
    assert.throws(() => parseReportInput({ targetType: 'experiment', svId: 'sv1', reason: 'spam' }), /expId/i);
  });

  it('holds an experiment id to the same shape rules as a street-view id', () => {
    assert.throws(() => parseReportInput({ targetType: 'experiment', expId: 'a/b', reason: 'spam' }), /id/i);
    assert.throws(() => parseReportInput({ targetType: 'experiment', expId: 'x'.repeat(201), reason: 'spam' }), /id/i);
  });

  it('refuses a reason outside the list, so the admin queue has a fixed vocabulary', () => {
    assert.throws(() => parseReportInput({ svId: 'a', reason: 'because-i-said-so' }), /reason/i);
  });

  it('insists on a sentence when the reason is "something else"', () => {
    assert.throws(() => parseReportInput({ svId: 'a', reason: 'other' }), /describe/i);
    assert.doesNotThrow(() => parseReportInput({ svId: 'a', reason: 'other', details: 'wrong city' }));
  });

  it('refuses an id containing a slash — that would address a different collection', () => {
    assert.throws(() => parseReportInput({ svId: 'a/b', reason: 'spam' }), /id/i);
  });

  it('refuses details long enough to be a payload rather than a description', () => {
    assert.throws(() => parseReportInput({ svId: 'a', reason: 'spam', details: 'x'.repeat(501) }), /shorten/i);
  });
});

describe('reportDocId', () => {
  it('never puts the reporter key in the path', () => {
    const key = 'u:5fb99060cd30210004704d8c';
    const id = reportDocId({ targetType: 'streetview', svId: 'sv1' }, key);
    assert.ok(id);
    assert.ok(!id!.includes('5fb99060cd30210004704d8c'));
    assert.ok(id!.startsWith('sv1_'));
  });

  it('gives the same reporter the same id for the same target, so a re-report replaces', () => {
    const a = reportDocId({ targetType: 'streetview', svId: 'sv1' }, 'u:me');
    const b = reportDocId({ targetType: 'streetview', svId: 'sv1' }, 'u:me');
    assert.equal(a, b);
  });

  it('separates author reports from panorama reports', () => {
    const id = reportDocId({ targetType: 'author', authorId: 'owner1' }, 'u:me');
    assert.ok(id!.startsWith('author__owner1_'));
    // Firestore rejects ids matching __.*__; this one only has the double underscore inside.
    assert.ok(!/^__.*__$/.test(id!));
  });

  it('keeps an experiment report apart from a panorama with the same id, but de-duplicates against itself', () => {
    const key = 'u:5fb99060cd30210004704d8c';
    const exp = reportDocId({ targetType: 'experiment', expId: 'same' }, key);
    const sv = reportDocId({ targetType: 'streetview', svId: 'same' }, key);
    const author = reportDocId({ targetType: 'author', authorId: 'same' }, key);
    assert.ok(exp!.startsWith('experiment__same_'));
    assert.notEqual(exp, sv);
    assert.notEqual(exp, author);
    assert.equal(exp, reportDocId({ targetType: 'experiment', expId: 'same' }, key));
    assert.ok(!exp!.includes('5fb99060cd30210004704d8c'), 'reporter key must not appear in the path');
  });

  it('has no id for a guest — there is no identity worth de-duplicating on', () => {
    assert.equal(reportDocId({ targetType: 'streetview', svId: 'sv1' }, null), null);
  });

  it('digests differ per key', () => {
    assert.notEqual(reporterKeyDigest('u:a'), reporterKeyDigest('u:b'));
  });
});

describe('appendFollowUp', () => {
  const prior = { reason: 'inappropriate', details: 'the teacher wrote something cruel' };
  const entry = { reason: 'privacy' as const, details: 'and it names my address', reporterWeight: 1 as const };

  it('keeps a repeat report on the open one instead of dropping it', () => {
    const rows = appendFollowUp(prior, entry, NOW);
    assert.ok(rows);
    assert.equal(rows!.length, 1);
    assert.deepEqual(rows![0], {
      reason: 'privacy',
      details: 'and it names my address',
      reporterWeight: 1,
      createdAt: NOW,
    });
  });

  it('appends after the ones already there, oldest first, and never rewrites them', () => {
    const first = appendFollowUp(prior, entry, NOW)!;
    const second = appendFollowUp({ ...prior, followUps: first }, { ...entry, details: 'a third thing' }, NOW + 1000)!;
    assert.equal(second.length, 2);
    assert.deepEqual(second[0], first[0]);
    assert.equal(second[1].details, 'a third thing');
    assert.equal(second[1].createdAt, NOW + 1000);
  });

  it('refuses a repeat that says exactly what the last one said — a double tap, not new words', () => {
    // Against the report itself when there are no follow-ups yet…
    assert.equal(appendFollowUp(prior, { ...entry, reason: 'inappropriate', details: prior.details }, NOW), null);
    // …and against the newest follow-up once there is one.
    const rows = appendFollowUp(prior, entry, NOW)!;
    assert.equal(appendFollowUp({ ...prior, followUps: rows }, entry, NOW + 1000), null);
    // The same words under a different reason are a different report.
    assert.ok(appendFollowUp({ ...prior, followUps: rows }, { ...entry, reason: 'spam' }, NOW + 1000));
  });

  it('stops at the cap rather than letting one report become a chat channel', () => {
    let rows = appendFollowUp(prior, entry, NOW)!;
    for (let i = 1; i < REPORT_FOLLOW_UP_MAX; i += 1) {
      const next = appendFollowUp({ ...prior, followUps: rows }, { ...entry, details: `more ${i}` }, NOW + i);
      assert.ok(next, `follow-up ${i + 1} should fit`);
      rows = next;
    }
    assert.equal(rows.length, REPORT_FOLLOW_UP_MAX);
    assert.equal(appendFollowUp({ ...prior, followUps: rows }, { ...entry, details: 'one too many' }, NOW), null);
  });

  it('holds a follow-up to the same length limit as the report itself', () => {
    const rows = appendFollowUp(prior, { ...entry, details: 'x'.repeat(MAX_REPORT_DETAILS + 200) }, NOW)!;
    assert.equal(rows[0].details.length, MAX_REPORT_DETAILS);
  });

  it('starts a list on a report written before follow-ups existed, whatever the field holds', () => {
    assert.equal(appendFollowUp({ reason: 'spam', details: '' }, entry, NOW)!.length, 1);
    assert.equal(appendFollowUp({ followUps: 'not an array' }, entry, NOW)!.length, 1);
    assert.equal(appendFollowUp(null, entry, NOW)!.length, 1);
  });

  it('counts and finds the newest one — what the staff e-mail is about', () => {
    assert.equal(followUpCount(null), 0);
    assert.equal(followUpCount({ followUps: 'nonsense' }), 0);
    assert.equal(lastFollowUp({}), null);
    const rows = appendFollowUp(
      { ...prior, followUps: appendFollowUp(prior, entry, NOW)! },
      { ...entry, details: 'and again' },
      NOW + 1,
    )!;
    assert.equal(followUpCount({ followUps: rows }), 2);
    assert.equal(lastFollowUp({ followUps: rows })?.createdAt, NOW + 1);
  });
});

describe('followUpsSince', () => {
  // Staff mail is one per target per hour, and the hour a follow-up runs into was opened by
  // the report it hangs on — so "the newest addition" is not what the next mail owes. This is
  // what stops the words the throttle swallowed from reaching nobody.
  const rows = [
    { reason: 'spam' as const, details: 'first', reporterWeight: 1 as const, createdAt: NOW },
    { reason: 'spam' as const, details: 'second', reporterWeight: 1 as const, createdAt: NOW + 5_000 },
  ];

  it('hands back what was added after the last mail, and nothing the last mail carried', () => {
    assert.deepEqual(
      followUpsSince({ followUps: rows }, NOW).map((f) => f.details),
      ['second'],
    );
    assert.deepEqual(followUpsSince({ followUps: rows }, NOW + 5_000), []);
  });

  it('hands back everything when no mail has gone out about this target yet', () => {
    assert.equal(followUpsSince({ followUps: rows }, null).length, 2);
    assert.deepEqual(followUpsSince(null, null), []);
    assert.deepEqual(followUpsSince({ followUps: 'nonsense' }, null), []);
  });

  it('leaves out a row with no usable timestamp rather than mailing it out for ever', () => {
    assert.deepEqual(followUpsSince({ followUps: [{ ...rows[0], createdAt: undefined }] }, NOW - 1), []);
  });
});

describe('reporterWeight', () => {
  it('trusts an established, verified account', () => {
    assert.equal(reporterWeight(established).weight, 1);
  });

  it('gives a guest or an unverified address no weight', () => {
    assert.equal(reporterWeight({ ...established, isVerifiedUser: false }).weight, 0);
  });

  it('stops trusting an account staff have overruled enough times', () => {
    assert.equal(reporterWeight({ ...established, falseReports: FALSE_REPORT_LIMIT }).weight, 0);
    assert.equal(reporterWeight({ ...established, falseReports: FALSE_REPORT_LIMIT - 1 }).weight, 1);
  });

  it('gives a brand-new account with nothing of its own no weight', () => {
    const fresh = { ...established, accountCreatedAtMs: NOW - NEW_ACCOUNT_MS / 2 };
    assert.equal(reporterWeight(fresh).weight, 0);
    // …but a newcomer who has published something has a stake in the map.
    assert.equal(reporterWeight({ ...fresh, hasOwnUploads: true }).weight, 1);
  });

  it('treats an account with no recorded creation date as established, not as a suspect', () => {
    assert.equal(reporterWeight({ ...established, accountCreatedAtMs: null }).weight, 1);
  });
});

describe('shouldAutoHide', () => {
  it('hides on a single weighted report — the response a reviewer has to be able to see', () => {
    assert.equal(shouldAutoHide(hideable).hide, true);
  });

  it('does nothing on a report that carries no weight', () => {
    assert.equal(shouldAutoHide({ ...hideable, weight: 0 }).hide, false);
  });

  it('leaves the seeded panoramas alone — they are our own content, not UGC', () => {
    assert.equal(shouldAutoHide({ ...hideable, ownerId: 'system' }).hide, false);
  });

  it('never re-hides something staff reviewed and kept', () => {
    assert.equal(shouldAutoHide({ ...hideable, alreadyReviewedKept: true }).hide, false);
  });

  it('caps how much one reporter can hide in a day', () => {
    assert.equal(shouldAutoHide({ ...hideable, reporterHides24h: AUTO_HIDE_PER_REPORTER_24H }).hide, false);
    assert.equal(shouldAutoHide({ ...hideable, reporterHides24h: AUTO_HIDE_PER_REPORTER_24H - 1 }).hide, true);
  });

  it('stops hiding site-wide once the hour looks like a bombing run', () => {
    assert.equal(shouldAutoHide({ ...hideable, globalHidesThisHour: AUTO_HIDE_GLOBAL_PER_HOUR }).hide, false);
  });

  it('is idempotent on something already hidden', () => {
    assert.equal(shouldAutoHide({ ...hideable, alreadyHidden: true }).hide, false);
  });
});

describe('subjectSafe', () => {
  it('folds newlines out of a user string before it reaches a mail header', () => {
    assert.equal(subjectSafe('a\r\nBcc: x@y'), 'a Bcc: x@y');
  });

  it('truncates rather than letting a 200-char title become the subject', () => {
    assert.equal(subjectSafe('x'.repeat(100), 10).length, 10);
  });
});

describe('withinWindow', () => {
  it('is false for a missing or stale window start', () => {
    assert.equal(withinWindow(undefined, NOW, 1000), false);
    assert.equal(withinWindow(NOW - 2000, NOW, 1000), false);
    assert.equal(withinWindow(NOW - 500, NOW, 1000), true);
  });
});
