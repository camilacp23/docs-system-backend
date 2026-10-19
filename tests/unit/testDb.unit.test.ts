/** Unit tests of the pure parts of the test database helper (no database needed). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migrationsHash } from '../helpers/testDb.js';

describe('migrationsHash', () => {
  it('is a deterministic SHA-256 hex digest', () => {
    const first = migrationsHash();
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(migrationsHash(), first);
  });
});
