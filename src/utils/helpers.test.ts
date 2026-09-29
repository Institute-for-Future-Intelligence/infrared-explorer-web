import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration } from './helpers';

describe('formatDuration', () => {
  it('keeps m:ss below an hour, exactly as before', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(5), '0:05');
    assert.equal(formatDuration(75), '1:15');
    assert.equal(formatDuration(28.2), '0:28');
    assert.equal(formatDuration(59.6), '1:00');
    assert.equal(formatDuration(3599), '59:59');
    assert.equal(formatDuration(-3), '0:00');
  });

  it('adds an hours field at an hour and above, with two-digit minutes', () => {
    assert.equal(formatDuration(3600), '1:00:00');
    assert.equal(formatDuration(3661), '1:01:01');
    assert.equal(formatDuration(4800), '1:20:00');
    assert.equal(formatDuration(86400), '24:00:00');
    assert.equal(formatDuration(86400 + 5 * 60 + 9), '24:05:09');
  });
});
