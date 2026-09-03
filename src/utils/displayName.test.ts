/**
 * Behaviour + parity tests for the default display name.
 *
 * Parity matters here for the same reason it does for the report descriptor: the name is minted by
 * the Cloud Function when a user is provisioned and re-derived in the browser whenever a profile
 * read comes back without one. The two live in separate builds with no shared package, so a drift
 * would show up as an account silently renaming itself between the server's version and the
 * client's — never as a loud failure.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDisplayName as serverDefault } from '../../functions/src/displayName';
import { defaultDisplayName, isPrivateRelayEmail, userDisplayName } from './displayName';

const MONGO_ID = '66f0a1b2c3d4e5f60718293f';

describe('isPrivateRelayEmail', () => {
  it('recognizes Apple relay addresses regardless of case', () => {
    assert.equal(isPrivateRelayEmail('kd9x2mq4h7@privaterelay.appleid.com'), true);
    assert.equal(isPrivateRelayEmail('KD9X2MQ4H7@PrivateRelay.AppleID.com'), true);
  });

  it('leaves real addresses alone', () => {
    assert.equal(isPrivateRelayEmail('john.doe@intofuture.org'), false);
    assert.equal(isPrivateRelayEmail(null), false);
    assert.equal(isPrivateRelayEmail(undefined), false);
  });
});

describe('defaultDisplayName', () => {
  it('reads a name out of a real address', () => {
    assert.equal(defaultDisplayName('john.doe@intofuture.org', MONGO_ID), 'John Doe');
    assert.equal(defaultDisplayName('john_doe+ie@gmail.com', MONGO_ID), 'John Doe');
    assert.equal(defaultDisplayName('xiaotong@intofuture.org', MONGO_ID), 'Xiaotong');
    assert.equal(defaultDisplayName('McKay@intofuture.org', MONGO_ID), 'McKay');
  });

  it('never turns an Apple relay address into a name', () => {
    const name = defaultDisplayName('kd9x2mq4h7@privaterelay.appleid.com', MONGO_ID);
    assert.equal(name, 'Explorer 293F');
    assert.ok(!name.includes('kd9x2mq4h7'));
  });

  it('falls back to the identity key when there is no usable address', () => {
    assert.equal(defaultDisplayName(null, MONGO_ID), 'Explorer 293F');
    assert.equal(defaultDisplayName('', MONGO_ID), 'Explorer 293F');
    assert.equal(defaultDisplayName('12345@example.com', MONGO_ID), 'Explorer 293F');
    // Two nameless accounts get different names — the whole point of seeding from the id.
    assert.notEqual(defaultDisplayName(null, MONGO_ID), defaultDisplayName(null, '66f0a1b2c3d4e5f607182940'));
  });

  it('is never empty and never too long for the usersPublic rule (120 chars)', () => {
    assert.equal(defaultDisplayName(null, ''), 'Explorer');
    assert.ok(defaultDisplayName(`${'a'.repeat(200)}@example.com`, MONGO_ID).length <= 120);
  });
});

describe('userDisplayName', () => {
  it('prefers the saved nickname, then the provider name, then the default', () => {
    assert.equal(userDisplayName({ displayName: 'Ada', email: 'ada@example.com', id: MONGO_ID }), 'Ada');
    assert.equal(userDisplayName({ displayName: '  ', email: 'ada@example.com', id: MONGO_ID }), 'Ada');
    assert.equal(userDisplayName({ displayName: null, email: null, id: MONGO_ID }), 'Explorer 293F');
  });
});

describe('client/server parity', () => {
  it('derives the same name in both builds', () => {
    const cases: [string | null, string][] = [
      ['john.doe@intofuture.org', MONGO_ID],
      ['kd9x2mq4h7@privaterelay.appleid.com', MONGO_ID],
      [null, MONGO_ID],
      [null, ''],
      ['12345@example.com', '66f0a1b2c3d4e5f607182940'],
    ];
    for (const [email, seed] of cases) {
      assert.equal(defaultDisplayName(email, seed), serverDefault(email, seed), `email=${email} seed=${seed}`);
    }
  });
});
