/**
 * Sign in with Apple grant revocation — the part of account deletion Apple itself insists on.
 *
 * Since June 2022 an app that offers Sign in with Apple must, when the user deletes their account,
 * also revoke the Apple-side grant (TN3194; App Store Review 5.1.1(v)), so the app disappears from
 * the user's "Sign in with Apple" list and a later sign-in starts clean. Firebase's deleteUser does
 * not do this. The capture app revokes on-device (Firebase's revokeToken, fed by the native sheet's
 * authorization code) before it calls the purge; the web page cannot — Firebase consumed the
 * authorization code inside its popup and hands the page only Apple's access token — so the purge
 * callable revokes for it here, with our own Sign in with Apple key.
 *
 * Two inputs, one endpoint:
 *  - a fresh `authorizationCode` from the native sheet (client_id = the iOS App ID): exchanged at
 *    /auth/token for a refresh token, whose id_token also says WHOSE grant it is, then revoked;
 *  - the `accessToken` Firebase returned to the web popup (client_id = the Services ID): revoked
 *    directly.
 * Both calls carry a client_secret: a short-lived ES256 JWT signed with the team's .p8 key —
 * APPLE_SIGNIN_PRIVATE_KEY in Secret Manager, the same key the Firebase console holds. The key is
 * issued to the primary App ID, so it signs for both client ids.
 *
 * Nothing here throws for an Apple-side "no": the outcome says what happened and the caller
 * decides. The one outcome worth aborting a deletion over is `misconfigured` (Apple rejected the
 * client_secret itself — our key, key id or team id is wrong), because no retry by the user can fix
 * it and a purge that silently skips revocation would violate the requirement forever.
 */
import * as crypto from 'crypto';

export const APPLE_TEAM_ID = 'BW5V78V378';
/** Key ID of the Sign in with Apple key whose .p8 is APPLE_SIGNIN_PRIVATE_KEY. */
export const APPLE_KEY_ID = 'W6BDZN6U6Y';
/** client_id for authorization codes minted by the native sheet — the iOS App ID. */
export const APPLE_IOS_CLIENT_ID = 'org.intofuture.infraredexplorer.ios';
/** client_id for tokens minted through the Firebase web popup — the Services ID. */
export const APPLE_WEB_CLIENT_ID = 'org.intofuture.infraredexplorer.web';
/** Where Firebase's popup flow lands; Apple wants it echoed when a WEB code is exchanged. */
const APPLE_WEB_REDIRECT_URI = 'https://infrared-explorer.firebaseapp.com/__/auth/handler';

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const APPLE_AUDIENCE = 'https://appleid.apple.com';

/** Apple's codes and tokens are well under 2 KB; anything larger is not one of them. */
const MAX_TOKEN_CHARS = 4096;

export type AppleClient = 'ios' | 'web';

export interface AppleRevokeRequest {
  /** One-shot code from the native sheet (iOS). Exchanged, then the refresh token is revoked. */
  authorizationCode?: string;
  /** Apple access token from the Firebase web popup. Revoked directly. */
  accessToken?: string;
  /** Which client minted it; defaults to `ios` for a code and `web` for an access token. */
  client?: AppleClient;
}

export interface AppleRevokeDeps {
  /** PEM contents of the .p8 (APPLE_SIGNIN_PRIVATE_KEY). */
  privateKey: string;
  teamId?: string;
  keyId?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Seconds since the epoch; injectable for tests. */
  nowSec?: () => number;
}

export type AppleRevokeOutcome =
  | { status: 'revoked'; via: 'authorization_code' | 'access_token'; sub: string | null }
  | { status: 'skipped'; reason: 'nothing-to-revoke' }
  /** The code exchanged to a DIFFERENT Apple user than the caller — not revoked. */
  | { status: 'sub-mismatch'; sub: string }
  | { status: 'failed'; reason: string; misconfigured: boolean };

/**
 * Validate the `apple` block a client attaches to the deleteAccount request. Returns null when
 * there is nothing usable (absent, malformed, or oversize), never throws — an old client sending
 * nothing is the common case, not an error.
 */
export function parseAppleRevokeRequest(raw: unknown): AppleRevokeRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' && v.length <= MAX_TOKEN_CHARS ? v.trim() : undefined;
  const authorizationCode = str(o.authorizationCode);
  const accessToken = str(o.accessToken);
  if (!authorizationCode && !accessToken) return null;
  const client = o.client === 'ios' || o.client === 'web' ? o.client : undefined;
  return { authorizationCode, accessToken, client };
}

const b64url = (v: string | Buffer): string => Buffer.from(v).toString('base64url');

/**
 * Apple's client_secret: an ES256 JWT (issuer = team, subject = the client id it will be used
 * with, audience = Apple) signed with the .p8. Apple allows up to six months' validity; five
 * minutes is plenty for the two requests it accompanies.
 */
export function appleClientSecret(
  deps: Pick<AppleRevokeDeps, 'privateKey' | 'teamId' | 'keyId' | 'nowSec'>,
  clientId: string,
): string {
  const now = (deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  const header = { alg: 'ES256', kid: deps.keyId ?? APPLE_KEY_ID, typ: 'JWT' };
  const payload = { iss: deps.teamId ?? APPLE_TEAM_ID, iat: now, exp: now + 300, aud: APPLE_AUDIENCE, sub: clientId };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  // JWT wants the raw r||s signature, not the DER wrapping Node emits by default.
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: crypto.createPrivateKey(deps.privateKey),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(signature)}`;
}

/** The `sub` of a JWT we received over TLS from Apple's own token endpoint — read, not verified. */
export function decodeJwtSub(jwt: unknown): string | null {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof payload.sub === 'string' && payload.sub !== '' ? payload.sub : null;
  } catch {
    return null;
  }
}

interface AppleResponse {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

async function postForm(fetchImpl: typeof fetch, url: string, form: Record<string, string>): Promise<AppleResponse> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  // Revoke answers 200 with an empty body; token answers JSON either way.
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { raw: text.slice(0, 200) };
    }
  }
  return { ok: res.ok, status: res.status, body };
}

const failure = (step: string, res: AppleResponse): AppleRevokeOutcome => {
  const error = typeof res.body.error === 'string' ? res.body.error : `http ${res.status}`;
  const detail = typeof res.body.error_description === 'string' ? ` (${res.body.error_description})` : '';
  return { status: 'failed', reason: `${step}: ${error}${detail}`, misconfigured: error === 'invalid_client' };
};

/**
 * Revoke the Sign in with Apple grant the request material identifies. `expectedSub` is the
 * caller's Apple user id (from their Firebase token's identities); when a CODE exchanges to a
 * different user the grant is left alone and `sub-mismatch` is returned — a client must never be
 * able to sign somebody else out of the app by handing over a code that is not theirs.
 */
export async function revokeAppleGrant(
  req: AppleRevokeRequest,
  deps: AppleRevokeDeps,
  expectedSub: string | null = null,
): Promise<AppleRevokeOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    if (req.authorizationCode) {
      const client = req.client ?? 'ios';
      const clientId = client === 'ios' ? APPLE_IOS_CLIENT_ID : APPLE_WEB_CLIENT_ID;
      const secret = appleClientSecret(deps, clientId);
      const exchanged = await postForm(fetchImpl, APPLE_TOKEN_URL, {
        client_id: clientId,
        client_secret: secret,
        grant_type: 'authorization_code',
        code: req.authorizationCode,
        ...(client === 'web' ? { redirect_uri: APPLE_WEB_REDIRECT_URI } : {}),
      });
      if (!exchanged.ok) return failure('exchange', exchanged);
      const sub = decodeJwtSub(exchanged.body.id_token);
      if (expectedSub && sub && sub !== expectedSub) return { status: 'sub-mismatch', sub };
      // The refresh token is the durable grant; revoking it takes every access token with it.
      const refreshToken = typeof exchanged.body.refresh_token === 'string' ? exchanged.body.refresh_token : null;
      const accessToken = typeof exchanged.body.access_token === 'string' ? exchanged.body.access_token : null;
      const token = refreshToken ?? accessToken;
      if (!token) return { status: 'failed', reason: 'exchange: no token in Apple’s response', misconfigured: false };
      const revoked = await postForm(fetchImpl, APPLE_REVOKE_URL, {
        client_id: clientId,
        client_secret: secret,
        token,
        token_type_hint: refreshToken ? 'refresh_token' : 'access_token',
      });
      return revoked.ok ? { status: 'revoked', via: 'authorization_code', sub } : failure('revoke', revoked);
    }
    if (req.accessToken) {
      const client = req.client ?? 'web';
      const clientId = client === 'ios' ? APPLE_IOS_CLIENT_ID : APPLE_WEB_CLIENT_ID;
      const revoked = await postForm(fetchImpl, APPLE_REVOKE_URL, {
        client_id: clientId,
        client_secret: appleClientSecret(deps, clientId),
        token: req.accessToken,
        token_type_hint: 'access_token',
      });
      return revoked.ok ? { status: 'revoked', via: 'access_token', sub: null } : failure('revoke', revoked);
    }
    return { status: 'skipped', reason: 'nothing-to-revoke' };
  } catch (e) {
    // Network / DNS / a key the crypto layer could not parse. Not Apple saying no.
    const message = e instanceof Error ? e.message : String(e);
    return { status: 'failed', reason: `request: ${message}`, misconfigured: /private key|PEM|DECODER/i.test(message) };
  }
}
