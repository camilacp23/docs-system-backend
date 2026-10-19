/** Retry-After and details.minutes of a 429 come from one calculation (D-60). */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { retryAfter } from '../../src/http/rateLimit.js';

describe('retryAfter', () => {
  const now = 1_000_000;
  it('rounds the remaining time up to whole seconds and minutes', () => {
    assert.deepEqual(retryAfter(new Date(now + 90_000), 900_000, now), { seconds: 90, minutes: 2 });
    assert.deepEqual(retryAfter(new Date(now + 60_000), 900_000, now), { seconds: 60, minutes: 1 });
    assert.deepEqual(retryAfter(new Date(now + 60_001), 900_000, now), { seconds: 61, minutes: 2 });
    assert.deepEqual(retryAfter(new Date(now + 899_001), 900_000, now), { seconds: 900, minutes: 15 });
  });
  it('is never less than one second or one minute', () => {
    assert.deepEqual(retryAfter(new Date(now + 1), 900_000, now), { seconds: 1, minutes: 1 });
    assert.deepEqual(retryAfter(new Date(now - 5_000), 900_000, now), { seconds: 1, minutes: 1 });
  });
  it('falls back to the full window when the reset time is unknown', () => {
    assert.deepEqual(retryAfter(undefined, 900_000, now), { seconds: 900, minutes: 15 });
  });
});
