/**
 * Tests for the sign-in identity decision (which users doc a claimless sign-in is bound to).
 *
 * Every refusal pinned here is a way to end up holding someone else's mongoId claim, and every bind
 * is a legitimate sign-in that must keep working. A test that starts failing because a check was
 * "simplified" is telling you an account can be taken over again.
 *
 * Docs are built the way the server leaves them: a bound doc's authUid has its own uidMap row
 * (`mappedUids`), an unclaimed one has none. The plants are the shapes an owner could write on their
 * own doc before the users allowlist rules.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EMAIL_MATCHES,
  authUidsToLookUp,
  classifyProfile,
  decideSignInIdentity,
  profileIdOf,
  purgeProfileByAuthUid,
  purgeProfileByEmail,
  type EmailMatchedProfile,
  type PriorAuthRecord,
  type SignInIdentityInput,
} from './signInIdentity';

const CALLER = 'uid-caller';
const EMAIL = 'student@example.com';
const MIGRATED = '60a1b2c3d4e5f60718293a4b';
const VICTIM = '5fb99060cd30210004704d8c';
const OTHER = '68c7f1e2a3b4c5d6e7f80910';

/** An unclaimed doc: id field = doc id, no authUid, no uidMap row. */
const doc = (docId: string, extra: Partial<EmailMatchedProfile> = {}): EmailMatchedProfile => ({
  docId,
  idField: docId,
  authUid: undefined,
  mappedUids: [],
  ...extra,
});
/** A doc a server bind left bound to `authUid` (which therefore has its uidMap row). */
const bound = (docId: string, authUid: string, extra: Partial<EmailMatchedProfile> = {}): EmailMatchedProfile =>
  doc(docId, { authUid, mappedUids: [authUid], ...extra });

function input(over: Partial<SignInIdentityInput> = {}): SignInIdentityInput {
  return {
    uid: CALLER,
    email: EMAIL,
    emailVerified: true,
    matches: [],
    truncated: false,
    priorAuth: new Map(),
    ...over,
  };
}

const prior = (entries: Record<string, PriorAuthRecord>) => new Map(Object.entries(entries));
const GONE: PriorAuthRecord = { exists: false };
const live = (email: string, emailVerified = true): PriorAuthRecord => ({ exists: true, email, emailVerified });

describe('decideSignInIdentity: the email must be verified', () => {
  it('refuses an unverified email before looking at any profile, even an unclaimed one', () => {
    for (const emailVerified of [false, undefined, 'true', 1, null]) {
      const d = decideSignInIdentity(input({ emailVerified, matches: [doc(MIGRATED)] }));
      assert.equal(d.kind, 'refuse');
      assert.equal(d.kind === 'refuse' && d.reason, 'email-unverified');
      assert.equal(d.kind === 'refuse' && d.code, 'failed-precondition');
    }
  });

  it('refuses an unverified email with no match rather than provisioning a profile filed under it', () => {
    const d = decideSignInIdentity(input({ emailVerified: false }));
    assert.equal(d.kind === 'refuse' && d.reason, 'email-unverified');
  });

  it('refuses a token with no email at all', () => {
    for (const email of [undefined, null, '', '   ', 42]) {
      const d = decideSignInIdentity(input({ email }));
      assert.equal(d.kind === 'refuse' && d.reason, 'no-email');
    }
  });
});

describe('decideSignInIdentity: legitimate sign-ins keep working', () => {
  it('provisions a brand-new user when nothing matches the verified email', () => {
    assert.deepEqual(decideSignInIdentity(input()), { kind: 'provision' });
  });

  it("binds a migrated user's first sign-in to their unclaimed doc", () => {
    const d = decideSignInIdentity(input({ matches: [doc(MIGRATED)] }));
    assert.equal(d.kind, 'bind');
    assert.equal(d.kind === 'bind' && d.mongoId, MIGRATED);
    assert.equal(d.kind === 'bind' && d.via, 'unclaimed');
    assert.equal(d.kind === 'bind' && d.previousAuthUid, null);
    assert.deepEqual(d.kind === 'bind' && d.duplicates, []);
  });

  it('binds a doc with no id field (the doc id is the mongoId)', () => {
    const d = decideSignInIdentity(input({ matches: [doc(MIGRATED, { idField: undefined })] }));
    assert.equal(d.kind === 'bind' && d.mongoId, MIGRATED);
  });

  it('answers a second call (token not yet refreshed) with the same doc', () => {
    for (const mappedUids of [[CALLER], []]) {
      const d = decideSignInIdentity(input({ matches: [doc(OTHER, { authUid: CALLER, mappedUids })] }));
      assert.equal(d.kind === 'bind' && d.mongoId, OTHER);
      assert.equal(d.kind === 'bind' && d.via, 'self');
    }
  });

  it('prefers the doc already bound to this login over another doc with the same email', () => {
    const d = decideSignInIdentity(input({ matches: [doc(MIGRATED), bound(OTHER, CALLER)] }));
    assert.equal(d.kind === 'bind' && d.mongoId, OTHER);
  });

  it("does not count the caller's own uidMap row against an unclaimed doc", () => {
    const d = decideSignInIdentity(input({ matches: [doc(MIGRATED, { mappedUids: [CALLER] })] }));
    assert.equal(d.kind === 'bind' && d.via, 'unclaimed');
  });

  it('rebinds after the previous auth record was deleted (same person, new uid)', () => {
    const d = decideSignInIdentity(
      input({ matches: [bound(MIGRATED, 'uid-gone')], priorAuth: prior({ 'uid-gone': GONE }) }),
    );
    assert.equal(d.kind === 'bind' && d.mongoId, MIGRATED);
    assert.equal(d.kind === 'bind' && d.via, 'prior-deleted');
    assert.equal(d.kind === 'bind' && d.previousAuthUid, 'uid-gone');
  });

  it('rebinds a doc whose whole history of logins is gone (deleted, rebound, deleted again)', () => {
    const d = decideSignInIdentity(
      input({
        matches: [bound(MIGRATED, 'uid-2', { mappedUids: ['uid-1', 'uid-2'] })],
        priorAuth: prior({ 'uid-1': GONE, 'uid-2': GONE }),
      }),
    );
    assert.equal(d.kind === 'bind' && d.via, 'prior-deleted');
  });

  it('rebinds when the previous auth record is alive with the same verified email (case-insensitive)', () => {
    const d = decideSignInIdentity(
      input({
        matches: [bound(MIGRATED, 'uid-apple', { mappedUids: ['uid-old', 'uid-apple'] })],
        priorAuth: prior({ 'uid-apple': live('Student@Example.com'), 'uid-old': GONE }),
      }),
    );
    assert.equal(d.kind === 'bind' && d.via, 'prior-same-email');
  });
});

describe('decideSignInIdentity: the takeover shapes are refused', () => {
  it("never mints the id FIELD: a doc naming the victim's mongoId is not bound", () => {
    // users/ATTACKER { email: <fresh address the attacker signs in with>, id: <victim> }
    const d = decideSignInIdentity(input({ matches: [doc(OTHER, { idField: VICTIM })] }));
    assert.equal(d.kind, 'refuse');
    assert.equal(d.kind === 'refuse' && d.reason, 'anomalous-profile');
    assert.deepEqual(d.kind === 'refuse' && d.skipped, [{ docId: OTHER, class: 'id-mismatch' }]);
    assert.ok(d.kind === 'refuse' && !d.message.includes(VICTIM) && !d.message.includes(OTHER));
  });

  it('does not bind an id-mismatch doc even when it is bound to the caller', () => {
    const d = decideSignInIdentity(input({ matches: [bound(OTHER, CALLER, { idField: VICTIM })] }));
    assert.equal(d.kind === 'refuse' && d.reason, 'anomalous-profile');
  });

  it('treats a non-string id field as a mismatch', () => {
    for (const idField of [123, '', { $oid: MIGRATED }, [MIGRATED]]) {
      assert.equal(decideSignInIdentity(input({ matches: [doc(MIGRATED, { idField })] })).kind, 'refuse');
    }
  });

  it('refuses a doc bound to another live login with a different email (squatted address)', () => {
    // users/ATTACKER { email: <a future user's address> } still bound to the attacker's own live uid.
    const d = decideSignInIdentity(
      input({
        matches: [bound(OTHER, 'uid-attacker')],
        priorAuth: prior({ 'uid-attacker': live('attacker@example.net') }),
      }),
    );
    assert.equal(d.kind === 'refuse' && d.reason, 'bound-to-other-account');
    assert.deepEqual(d.kind === 'refuse' && d.skipped, [{ docId: OTHER, class: 'other-account' }]);
  });

  it("refuses a planted unclaimed doc: authUid deleted, but the planter's uidMap row still names it", () => {
    // users/ATTACKER { email: <a future user's address>, authUid: <removed> } — looks like a migrated profile.
    for (const attacker of [live('attacker@example.net'), GONE, live(EMAIL)]) {
      const d = decideSignInIdentity(
        input({
          matches: [doc(OTHER, { mappedUids: ['uid-attacker'] })],
          priorAuth: prior({ 'uid-attacker': attacker }),
        }),
      );
      assert.equal(d.kind === 'refuse' && d.reason, 'anomalous-profile');
      assert.deepEqual(d.kind === 'refuse' && d.skipped, [{ docId: OTHER, class: 'binding-stripped' }]);
    }
  });

  it('refuses a planted doc whose authUid names a throwaway login no server bind ever recorded', () => {
    // users/ATTACKER { email: <future user>, authUid: <a login the attacker created and deleted> }
    const d = decideSignInIdentity(
      input({
        matches: [doc(OTHER, { authUid: 'uid-throwaway', mappedUids: ['uid-attacker'] })],
        priorAuth: prior({ 'uid-throwaway': GONE, 'uid-attacker': live('attacker@example.net') }),
      }),
    );
    assert.equal(d.kind === 'refuse' && d.reason, 'anomalous-profile');
    assert.deepEqual(d.kind === 'refuse' && d.skipped, [{ docId: OTHER, class: 'binding-not-on-record' }]);
    // Same with no uidMap row at all.
    const bare = decideSignInIdentity(
      input({ matches: [doc(OTHER, { authUid: 'uid-throwaway' })], priorAuth: prior({ 'uid-throwaway': GONE }) }),
    );
    assert.equal(bare.kind === 'refuse' && bare.reason, 'anomalous-profile');
  });

  it('refuses a doc whose bound login is gone while another login uidMap maps to it is still live', () => {
    const d = decideSignInIdentity(
      input({
        matches: [bound(OTHER, 'uid-second', { mappedUids: ['uid-attacker', 'uid-second'] })],
        priorAuth: prior({ 'uid-second': GONE, 'uid-attacker': live('attacker@example.net') }),
      }),
    );
    assert.equal(d.kind === 'refuse' && d.reason, 'bound-to-other-account');
    assert.deepEqual(d.kind === 'refuse' && d.skipped, [{ docId: OTHER, class: 'held-by-other-account' }]);
  });

  it('fails closed when a uidMap login on the doc was not looked up', () => {
    const d = decideSignInIdentity(
      input({
        matches: [bound(MIGRATED, 'uid-gone', { mappedUids: ['uid-unknown', 'uid-gone'] })],
        priorAuth: prior({ 'uid-gone': GONE }),
      }),
    );
    assert.equal(d.kind === 'refuse' && d.reason, 'bound-to-other-account');
  });

  it('refuses when the other live login has the same email but unverified', () => {
    const d = decideSignInIdentity(
      input({ matches: [bound(MIGRATED, 'uid-x')], priorAuth: prior({ 'uid-x': live(EMAIL, false) }) }),
    );
    assert.equal(d.kind === 'refuse' && d.reason, 'bound-to-other-account');
  });

  it('fails closed when a bound authUid was not looked up', () => {
    const d = decideSignInIdentity(input({ matches: [bound(MIGRATED, 'uid-unknown')] }));
    assert.equal(d.kind === 'refuse' && d.reason, 'bound-to-other-account');
  });

  it('refuses a malformed authUid', () => {
    for (const authUid of ['', 7, { uid: CALLER }]) {
      const d = decideSignInIdentity(input({ matches: [doc(MIGRATED, { authUid })] }));
      assert.equal(d.kind === 'refuse' && d.reason, 'anomalous-profile');
    }
  });

  it('does not provision a duplicate when every match is ineligible', () => {
    const d = decideSignInIdentity(
      input({
        matches: [bound(MIGRATED, 'uid-x'), doc(OTHER, { idField: VICTIM })],
        priorAuth: prior({ 'uid-x': live('x@example.com') }),
      }),
    );
    assert.equal(d.kind, 'refuse');
    assert.equal(d.kind === 'refuse' && d.reason, 'bound-to-other-account');
    assert.equal(d.kind === 'refuse' && d.skipped.length, 2);
  });
});

describe('decideSignInIdentity: several docs share the email', () => {
  it('binds the lowest doc id of several clean unclaimed docs (migration duplicates) and reports the rest', () => {
    const d = decideSignInIdentity(input({ matches: [doc(OTHER), doc(MIGRATED), doc(VICTIM)] }));
    assert.equal(d.kind === 'bind' && d.mongoId, VICTIM);
    assert.equal(d.kind === 'bind' && d.via, 'unclaimed');
    assert.deepEqual(d.kind === 'bind' && d.duplicates, [MIGRATED, OTHER]);
  });

  it("a planted squat on a migrated user's address does not lock them out of their own doc", () => {
    const d = decideSignInIdentity(
      input({
        matches: [doc(VICTIM, { mappedUids: ['uid-attacker'] }), doc(MIGRATED)],
        priorAuth: prior({ 'uid-attacker': live('attacker@example.net') }),
      }),
    );
    assert.equal(d.kind === 'bind' && d.mongoId, MIGRATED);
    assert.deepEqual(d.kind === 'bind' && d.skipped, [{ docId: VICTIM, class: 'binding-stripped' }]);
    assert.deepEqual(d.kind === 'bind' && d.duplicates, []);
  });

  it('refuses an unclaimed doc plus one whose login is gone (a split profile)', () => {
    const d = decideSignInIdentity(
      input({ matches: [doc(MIGRATED), bound(OTHER, 'uid-gone')], priorAuth: prior({ 'uid-gone': GONE }) }),
    );
    assert.equal(d.kind === 'refuse' && d.reason, 'ambiguous-profiles');
  });

  it('refuses two docs both bound to the caller', () => {
    const d = decideSignInIdentity(input({ matches: [bound(MIGRATED, CALLER), bound(OTHER, CALLER)] }));
    assert.equal(d.kind === 'refuse' && d.reason, 'ambiguous-profiles');
  });

  it('binds the one eligible doc and reports the ineligible ones', () => {
    const d = decideSignInIdentity(
      input({
        matches: [doc(OTHER, { idField: VICTIM }), doc(MIGRATED), bound(VICTIM, 'uid-v')],
        priorAuth: prior({ 'uid-v': live('victim@example.com') }),
      }),
    );
    assert.equal(d.kind === 'bind' && d.mongoId, MIGRATED);
    assert.deepEqual(d.kind === 'bind' && d.skipped, [
      { docId: OTHER, class: 'id-mismatch' },
      { docId: VICTIM, class: 'other-account' },
    ]);
  });

  it('refuses when the query was truncated, even with a self-bound doc among the results', () => {
    const d = decideSignInIdentity(input({ matches: [bound(MIGRATED, CALLER)], truncated: true }));
    assert.equal(d.kind === 'refuse' && d.reason, 'too-many-profiles');
    const many = Array.from({ length: MAX_EMAIL_MATCHES + 1 }, (_, i) => doc(`doc${i}`, { idField: undefined }));
    assert.equal(decideSignInIdentity(input({ matches: many })).kind, 'refuse');
  });
});

describe('helpers', () => {
  it('profileIdOf: the doc id, only when the id field agrees or is absent', () => {
    assert.equal(profileIdOf(MIGRATED, MIGRATED), MIGRATED);
    assert.equal(profileIdOf(MIGRATED, undefined), MIGRATED);
    assert.equal(profileIdOf(MIGRATED, null), MIGRATED);
    assert.equal(profileIdOf(OTHER, VICTIM), null);
  });

  it('authUidsToLookUp: every other bound uid and uidMap login, once, never the caller', () => {
    assert.deepEqual(
      authUidsToLookUp(CALLER, [
        doc('a', { authUid: 'u1' }),
        doc('b', { authUid: CALLER, mappedUids: [CALLER] }),
        doc('c', { authUid: 'u1', mappedUids: ['u1', 'u3'] }),
        doc('d'),
        doc('e', { authUid: '' }),
        doc('f', { authUid: 'u2', idField: VICTIM }),
        doc('g', { mappedUids: ['u4', CALLER, ''] }),
      ]),
      ['u1', 'u3', 'u2', 'u4'],
    );
  });

  it('classifyProfile checks the id field before anything else', () => {
    assert.equal(classifyProfile(CALLER, EMAIL, doc(OTHER, { idField: VICTIM }), new Map()), 'id-mismatch');
  });
});

describe('deleteAccount fallbacks', () => {
  const purge = (over: Partial<SignInIdentityInput>) => purgeProfileByEmail(input(over));

  it('purgeProfileByEmail needs a verified email, and then resolves nothing rather than refusing', () => {
    assert.equal(purge({ emailVerified: false, matches: [doc(MIGRATED)] }).kind, 'none');
    assert.equal(purge({ emailVerified: undefined, matches: [doc(MIGRATED)] }).kind, 'none');
    const ok = purge({ matches: [doc(MIGRATED)] });
    assert.equal(ok.kind === 'profile' && ok.mongoId, MIGRATED);
  });

  it('purgeProfileByEmail resolves exactly the profile onUserSignIn would bind', () => {
    assert.equal(purge({}).kind, 'none');
    const lowest = purge({ matches: [doc(OTHER), doc(MIGRATED)] });
    assert.equal(lowest.kind === 'profile' && lowest.mongoId, MIGRATED);
    assert.deepEqual(lowest.kind === 'profile' && lowest.duplicates, [OTHER]);
    const rebound = purge({ matches: [bound(MIGRATED, 'uid-gone')], priorAuth: prior({ 'uid-gone': GONE }) });
    assert.equal(rebound.kind === 'profile' && rebound.mongoId, MIGRATED);
    const mixed = purge({
      matches: [bound(MIGRATED, 'u', { idField: VICTIM }), doc(OTHER)],
    });
    assert.equal(mixed.kind === 'profile' && mixed.mongoId, OTHER);
  });

  it("purgeProfileByEmail leaves another login's or a tampered doc alone without blocking the deletion", () => {
    const other = purge({ matches: [bound(MIGRATED, 'u')], priorAuth: prior({ u: live('someone@example.com') }) });
    assert.equal(other.kind, 'none');
    const planted = purge({ matches: [doc(OTHER, { idField: VICTIM })] });
    assert.deepEqual(planted, { kind: 'none', skipped: [{ docId: OTHER, class: 'id-mismatch' }] });
    const stripped = purge({ matches: [doc(OTHER, { mappedUids: ['uid-attacker'] })] });
    assert.equal(stripped.kind, 'none');
  });

  it('purgeProfileByEmail refuses the deletion when the profile cannot be picked', () => {
    const split = purge({ matches: [doc(MIGRATED), bound(OTHER, 'uid-gone')], priorAuth: prior({ 'uid-gone': GONE }) });
    assert.equal(split.kind === 'refuse' && split.reason, 'ambiguous-profiles');
    assert.ok(split.kind === 'refuse' && split.message.includes('nothing was deleted'));
    assert.equal(purge({ matches: [doc(MIGRATED)], truncated: true }).kind, 'refuse');
  });

  it('purgeProfileByAuthUid never resolves to an id field that names another profile', () => {
    assert.deepEqual(purgeProfileByAuthUid([doc(OTHER, { idField: VICTIM, authUid: CALLER })]), {
      mongoId: null,
      anomalies: [OTHER],
    });
    assert.equal(purgeProfileByAuthUid([doc(OTHER, { authUid: CALLER })]).mongoId, OTHER);
    assert.equal(purgeProfileByAuthUid([]).mongoId, null);
  });

  it('purgeProfileByAuthUid resolves several bound docs to the lowest doc id', () => {
    assert.equal(
      purgeProfileByAuthUid([doc(OTHER, { authUid: CALLER }), doc(MIGRATED, { authUid: CALLER })]).mongoId,
      MIGRATED,
    );
  });
});
