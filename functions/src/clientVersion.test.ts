import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { HttpsError } from 'firebase-functions/v2/https';

import {
  clientOf,
  compareVersions,
  floorOver,
  requireClient,
  UPDATE_REQUIRED_MESSAGE,
  UPDATE_REQUIRED_REASON,
} from './clientVersion';

const app = (platform: string, version: string) => ({ 'x-client-platform': platform, 'x-client-version': version });

test('who is calling: the app by its two headers, the website by its Origin, an older app by neither', () => {
  assert.deepEqual(clientOf(app('android', '3.2.0')), { kind: 'app', platform: 'android', version: '3.2.0' });
  assert.deepEqual(clientOf(app('iOS', '3.2')), { kind: 'app', platform: 'ios', version: '3.2' });
  assert.deepEqual(clientOf({ origin: 'https://ie.intofuture.org' }), { kind: 'web' });
  assert.deepEqual(clientOf({}), { kind: 'legacy-app' });
  assert.deepEqual(clientOf(undefined), { kind: 'legacy-app' });
  // headers this file does not trust are as good as none
  assert.deepEqual(clientOf(app('windows', '3.2.0')), { kind: 'legacy-app' });
  assert.deepEqual(clientOf(app('android', 'v3')), { kind: 'legacy-app' });
  assert.deepEqual(clientOf({ ...app('android', 'v3'), origin: 'https://x' }), { kind: 'web' });
  // a header given twice reads by its first value
  assert.deepEqual(clientOf({ 'x-client-platform': ['ios', 'android'], 'x-client-version': ['3.4.1'] }), {
    kind: 'app',
    platform: 'ios',
    version: '3.4.1',
  });
});

test('versions compare as major.minor.patch, a missing segment as 0', () => {
  assert.equal(compareVersions('3.1.3', '3.2.0'), -1);
  assert.equal(compareVersions('3.2', '3.2.0'), 0);
  assert.equal(compareVersions('3.10.0', '3.9.9'), 1);
  assert.equal(compareVersions('junk', '3.0.0'), 0);
});

test('a build under its platform’s floor is refused; at it or over it, served', () => {
  const floors = { android: '3.3.0', ios: '3.4.0' };
  assert.equal(floorOver({ kind: 'app', platform: 'android', version: '3.2.9' }, floors), '3.3.0');
  assert.equal(floorOver({ kind: 'app', platform: 'android', version: '3.3.0' }, floors), null);
  assert.equal(floorOver({ kind: 'app', platform: 'ios', version: '3.3.5' }, floors), '3.4.0');
  assert.equal(floorOver({ kind: 'app', platform: 'ios', version: '4.0' }, floors), null);
  // a platform with no floor is not held to one
  assert.equal(floorOver({ kind: 'app', platform: 'ios', version: '1.0' }, { android: '3.3.0' }), null);
});

test('the website is always served; an app from before the headers is under any floor', () => {
  assert.equal(floorOver({ kind: 'web' }, { android: '9.0.0', ios: '9.0.0' }), null);
  assert.equal(floorOver({ kind: 'legacy-app' }, { android: '3.3.0' }), '3.3.0');
  assert.equal(floorOver({ kind: 'legacy-app' }, { ios: '3.4.0' }), '3.4.0');
  assert.equal(floorOver({ kind: 'legacy-app' }, {}), null);
});

test('the refusal is failed-precondition with the reason the app looks for and a sentence for the builds that do not', () => {
  assert.throws(
    () => requireClient(app('android', '3.1.3'), { android: '3.3.0' }),
    (e: unknown) => {
      assert.ok(e instanceof HttpsError);
      assert.equal(e.code, 'failed-precondition');
      assert.equal(e.message, UPDATE_REQUIRED_MESSAGE);
      assert.deepEqual(e.details, { reason: UPDATE_REQUIRED_REASON, minVersion: '3.3.0' });
      // what goes over the wire: {message, status, details} — the app reads details.reason
      assert.deepEqual(e.toJSON(), {
        message: UPDATE_REQUIRED_MESSAGE,
        status: 'FAILED_PRECONDITION',
        details: { reason: UPDATE_REQUIRED_REASON, minVersion: '3.3.0' },
      });
      return true;
    },
  );
  assert.throws(() => requireClient({}, { android: '3.3.0' }, { message: 'Update the app to hand in a report.' }), {
    message: 'Update the app to hand in a report.',
  });
  assert.deepEqual(requireClient(app('android', '3.3.0'), { android: '3.3.0' }), {
    kind: 'app',
    platform: 'android',
    version: '3.3.0',
  });
  assert.deepEqual(requireClient({ origin: 'https://ie.intofuture.org' }, { android: '3.3.0' }), { kind: 'web' });
});
