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
  NEW_ACCOUNT_MS,
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

  it('has no id for a guest — there is no identity worth de-duplicating on', () => {
    assert.equal(reportDocId({ targetType: 'streetview', svId: 'sv1' }, null), null);
  });

  it('digests differ per key', () => {
    assert.notEqual(reporterKeyDigest('u:a'), reporterKeyDigest('u:b'));
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
