/**
 * Tests for Sign in with Apple grant revocation.
 *
 * Apple is faked at the fetch boundary, so what is pinned is the contract we hold up to it: a
 * client_secret Apple would accept (ES256 over the right claims, signed with the team key), the
 * right client id per surface, the code → refresh-token → revoke sequence, and — because this runs
 * inside account deletion — the outcomes the purge acts on: a mismatched user is never revoked, a
 * rejected client_secret is reported as OUR misconfiguration, a stale code is not.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import {
  APPLE_IOS_CLIENT_ID,
  APPLE_WEB_CLIENT_ID,
  appleClientSecret,
  decodeJwtSub,
  parseAppleRevokeRequest,
  revokeAppleGrant,
} from './appleRevoke';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const b64json = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeIdToken = (sub: string) =>
  `${b64json({ alg: 'ES256' })}.${b64json({ sub, iss: 'https://appleid.apple.com' })}.sig`;

interface Call {
  url: string;
  form: URLSearchParams;
}

/** A fetch that records every form post and answers from a per-URL script. */
function fakeApple(script: Record<string, (form: URLSearchParams) => { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const form = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url, form });
    const handler = script[url];
    assert.ok(handler, `unexpected request to ${url}`);
    const { status, body } = handler(form);
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const TOKEN = 'https://appleid.apple.com/auth/token';
const REVOKE = 'https://appleid.apple.com/auth/revoke';

describe('appleClientSecret', () => {
  it('is an ES256 JWT Apple can verify with the team key, bound to the client id', () => {
    const jwt = appleClientSecret(
      { privateKey: PEM, teamId: 'TEAM123456', keyId: 'KEY1234567', nowSec: () => 1_700_000_000 },
      'org.example.web',
    );
    const [h, p, s] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), {
      alg: 'ES256',
      kid: 'KEY1234567',
      typ: 'JWT',
    });
    assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString()), {
      iss: 'TEAM123456',
      iat: 1_700_000_000,
      exp: 1_700_000_300,
      aud: 'https://appleid.apple.com',
      sub: 'org.example.web',
    });
    const ok = crypto.verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    assert.equal(ok, true);
  });
});

describe('parseAppleRevokeRequest', () => {
  it('returns null for nothing usable', () => {
    assert.equal(parseAppleRevokeRequest(undefined), null);
    assert.equal(parseAppleRevokeRequest('code'), null);
    assert.equal(parseAppleRevokeRequest({}), null);
    assert.equal(parseAppleRevokeRequest({ accessToken: '   ' }), null);
    assert.equal(parseAppleRevokeRequest({ accessToken: 'x'.repeat(5000) }), null);
  });

  it('keeps the strings and only a known client hint', () => {
    assert.deepEqual(parseAppleRevokeRequest({ authorizationCode: ' c0de ', client: 'ios', accessToken: 7 }), {
      authorizationCode: 'c0de',
      accessToken: undefined,
      client: 'ios',
    });
    assert.deepEqual(parseAppleRevokeRequest({ accessToken: 'tok', client: 'android' }), {
      authorizationCode: undefined,
      accessToken: 'tok',
      client: undefined,
    });
  });
});

describe('decodeJwtSub', () => {
  it('reads sub from a well-formed token and null from anything else', () => {
    assert.equal(decodeJwtSub(fakeIdToken('001234.abc')), '001234.abc');
    assert.equal(decodeJwtSub('not.a.jwt.really'), null);
    assert.equal(decodeJwtSub(`${b64json({})}.${b64json({})}.x`), null);
    assert.equal(decodeJwtSub(42), null);
  });
});

describe('revokeAppleGrant', () => {
  it('exchanges a native code with the iOS client id and revokes the refresh token', async () => {
    const apple = fakeApple({
      [TOKEN]: () => ({
        status: 200,
        body: { refresh_token: 'rt-1', access_token: 'at-1', id_token: fakeIdToken('001.user') },
      }),
      [REVOKE]: () => ({ status: 200 }),
    });
    const out = await revokeAppleGrant(
      { authorizationCode: 'c0de' },
      { privateKey: PEM, fetchImpl: apple.fetchImpl },
      '001.user',
    );
    assert.deepEqual(out, { status: 'revoked', via: 'authorization_code', sub: '001.user' });
    assert.equal(apple.calls.length, 2);
    const [exchange, revoke] = apple.calls;
    assert.equal(exchange.form.get('client_id'), APPLE_IOS_CLIENT_ID);
    assert.equal(exchange.form.get('grant_type'), 'authorization_code');
    assert.equal(exchange.form.get('code'), 'c0de');
    assert.equal(exchange.form.has('redirect_uri'), false, 'native codes carry no redirect_uri');
    assert.equal(revoke.form.get('token'), 'rt-1');
    assert.equal(revoke.form.get('token_type_hint'), 'refresh_token');
    // The secret is minted for the client id it accompanies.
    const secretSub = decodeJwtSub(revoke.form.get('client_secret'));
    assert.equal(secretSub, APPLE_IOS_CLIENT_ID);
  });

  it('refuses to revoke when the code belongs to another Apple user', async () => {
    const apple = fakeApple({
      [TOKEN]: () => ({ status: 200, body: { refresh_token: 'rt-1', id_token: fakeIdToken('002.other') } }),
      [REVOKE]: () => ({ status: 200 }),
    });
    const out = await revokeAppleGrant(
      { authorizationCode: 'c0de' },
      { privateKey: PEM, fetchImpl: apple.fetchImpl },
      '001.user',
    );
    assert.deepEqual(out, { status: 'sub-mismatch', sub: '002.other' });
    assert.equal(apple.calls.length, 1, 'no revoke call was made');
  });

  it('revokes a web access token directly with the Services ID', async () => {
    const apple = fakeApple({ [REVOKE]: () => ({ status: 200 }) });
    const out = await revokeAppleGrant(
      { accessToken: 'at-web' },
      { privateKey: PEM, fetchImpl: apple.fetchImpl },
      '001.user',
    );
    assert.deepEqual(out, { status: 'revoked', via: 'access_token', sub: null });
    const [revoke] = apple.calls;
    assert.equal(revoke.form.get('client_id'), APPLE_WEB_CLIENT_ID);
    assert.equal(revoke.form.get('token'), 'at-web');
    assert.equal(revoke.form.get('token_type_hint'), 'access_token');
    assert.equal(decodeJwtSub(revoke.form.get('client_secret')), APPLE_WEB_CLIENT_ID);
  });

  it('reports a rejected client_secret as misconfiguration, a spent code as a plain failure', async () => {
    const badSecret = fakeApple({ [TOKEN]: () => ({ status: 400, body: { error: 'invalid_client' } }) });
    const a = await revokeAppleGrant(
      { authorizationCode: 'c0de' },
      { privateKey: PEM, fetchImpl: badSecret.fetchImpl },
    );
    assert.equal(a.status, 'failed');
    assert.equal((a as { misconfigured: boolean }).misconfigured, true);

    const spent = fakeApple({
      [TOKEN]: () => ({
        status: 400,
        body: { error: 'invalid_grant', error_description: 'The code has expired or has been revoked.' },
      }),
    });
    const b = await revokeAppleGrant({ authorizationCode: 'c0de' }, { privateKey: PEM, fetchImpl: spent.fetchImpl });
    assert.deepEqual(b, {
      status: 'failed',
      reason: 'exchange: invalid_grant (The code has expired or has been revoked.)',
      misconfigured: false,
    });
  });

  it('treats a network failure as a non-fatal failure and an empty request as skipped', async () => {
    const down = (async () => {
      throw new Error('getaddrinfo ENOTFOUND appleid.apple.com');
    }) as unknown as typeof fetch;
    const a = await revokeAppleGrant({ accessToken: 'at' }, { privateKey: PEM, fetchImpl: down });
    assert.deepEqual(a, {
      status: 'failed',
      reason: 'request: getaddrinfo ENOTFOUND appleid.apple.com',
      misconfigured: false,
    });

    const idle = fakeApple({});
    const b = await revokeAppleGrant({}, { privateKey: PEM, fetchImpl: idle.fetchImpl });
    assert.deepEqual(b, { status: 'skipped', reason: 'nothing-to-revoke' });
    assert.equal(idle.calls.length, 0);
  });
});
