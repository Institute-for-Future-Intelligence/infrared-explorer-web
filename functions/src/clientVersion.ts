/*
 * Which build is calling, and the refusal a build too old to be served gets
 * (the app repository's docs/DECISIONS.md "A build that cannot read something says so"; the app's
 * half is its src/lib/compat.ts, whose strings these are — this is a copy of the
 * app repository's functions/src/clientVersion.ts, kept the same by hand).
 *
 * The app names itself on every call: `X-Client-Version` (its version name,
 * "3.2.0") and `X-Client-Platform` ("android" | "ios"). Builds up to 3.1.3
 * send neither; a browser sends neither but always sends `Origin`. So:
 *
 *   both headers                    that build of the app
 *   neither, and an Origin          the website (always the deployed one)
 *   neither, and no Origin          an app from before the headers (≤ 3.1.3)
 *
 * A callable that can no longer serve a build calls requireClient() first. It
 * throws `failed-precondition` with `details: {reason: 'update-required',
 * minVersion}`: a build with the headers shows its "Update Needed"
 * dialog; a build from before them shows the message as an error — which is
 * why the message is a whole sentence a person can act on.
 *
 * Nothing calls requireClient yet: it is here so the first contract change
 * that needs it is one line, in the function that changed.
 */

import { HttpsError } from 'firebase-functions/v2/https';

export const CLIENT_VERSION_HEADER = 'x-client-version';
export const CLIENT_PLATFORM_HEADER = 'x-client-platform';

/** `details.reason` of a refusal that an update cures (the app's compat.ts). */
export const UPDATE_REQUIRED_REASON = 'update-required';

export type Client =
  | { kind: 'app'; platform: 'android' | 'ios'; version: string }
  /** An app from before the headers: its version is not known, only that it is old. */
  | { kind: 'legacy-app' }
  | { kind: 'web' };

/** The headers of a request, as Express gives them (lower-cased names). */
export type HeaderBag = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();

const VERSION_RE = /^\d+(\.\d+){0,2}$/;

/** "3.1" → [3, 1, 0]; null for anything that is not one to three dot-separated integers. */
export function parseVersion(name: string): [number, number, number] | null {
  const s = name.trim();
  if (!VERSION_RE.test(s)) {
    return null;
  }
  const parts = s.split('.').map(Number);
  return [parts[0], parts[1] ?? 0, parts[2] ?? 0];
}

/** -1 / 0 / 1 as `a` precedes / equals / follows `b`; unparseable compares equal. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    return 0;
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Who is calling, from the request's headers (see the table above). */
export function clientOf(headers: HeaderBag | undefined): Client {
  const h = headers ?? {};
  const version = one(h[CLIENT_VERSION_HEADER]);
  const platform = one(h[CLIENT_PLATFORM_HEADER]).toLowerCase();
  if ((platform === 'android' || platform === 'ios') && parseVersion(version)) {
    return { kind: 'app', platform, version };
  }
  return one(h.origin) ? { kind: 'web' } : { kind: 'legacy-app' };
}

/** The version each platform's app must be at; a platform left out is not held to one. */
export interface ClientFloors {
  android?: string;
  ios?: string;
}

/**
 * The version `client` is held to and does not meet, or null when it may be
 * served. The website always may (it is whatever is deployed). An app from
 * before the headers is under any floor: it is older than the first build
 * that sent them. Pure.
 */
export function floorOver(client: Client, floors: ClientFloors): string | null {
  if (client.kind === 'web') {
    return null;
  }
  if (client.kind === 'legacy-app') {
    // Its platform is not known either: either floor is one it is under.
    return floors.android ?? floors.ios ?? null;
  }
  const floor = floors[client.platform];
  return floor && compareVersions(client.version, floor) < 0 ? floor : null;
}

/** What a refused build is told when the caller gives no sentence of its own. */
export const UPDATE_REQUIRED_MESSAGE = 'This needs a newer version of the app. Update from the store and try again.';

/**
 * First line of a callable that can no longer serve older builds:
 *
 *   requireClient(request.rawRequest.headers, {android: '3.3.0', ios: '3.3.0'});
 *
 * Throws the "update required" refusal for a build under its platform's floor
 * (and for any app from before the headers); returns who is calling otherwise.
 */
export function requireClient(
  headers: HeaderBag | undefined,
  floors: ClientFloors,
  opts: { message?: string } = {},
): Client {
  const client = clientOf(headers);
  const minVersion = floorOver(client, floors);
  if (minVersion != null) {
    throw new HttpsError('failed-precondition', opts.message ?? UPDATE_REQUIRED_MESSAGE, {
      reason: UPDATE_REQUIRED_REASON,
      minVersion,
    });
  }
  return client;
}
