/** ETag of a comment (D-123) and the error of an edit by someone else (AUTHOR_ONLY). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commentEtagOf } from '../../src/http/etag.js';
import { E } from '../../src/security/errors.js';

describe('commentEtagOf (D-123)', () => {
  const created = new Date('2026-11-12T09:00:00.123Z');

  it('uses createdAt while the comment was never edited', () => {
    assert.equal(commentEtagOf({ createdAt: created, updatedAt: null }), `W/"${created.getTime()}"`);
  });

  it('uses updatedAt once it was edited, and accepts ISO strings', () => {
    const edited = new Date('2026-11-12T09:20:00.456Z');
    assert.equal(commentEtagOf({ createdAt: created, updatedAt: edited }), `W/"${edited.getTime()}"`);
    assert.equal(
      commentEtagOf({ createdAt: created.toISOString(), updatedAt: edited.toISOString() }),
      `W/"${edited.getTime()}"`,
    );
  });
});

describe('E.forbiddenAuthorOnly (D-123)', () => {
  it('is a 403 FORBIDDEN with the contract message and details.reason AUTHOR_ONLY', () => {
    const error = E.forbiddenAuthorOnly();
    assert.equal(error.status, 403);
    assert.equal(error.code, 'FORBIDDEN');
    assert.equal(error.message, 'You can only edit your own comments.');
    assert.deepEqual(error.details, { reason: 'AUTHOR_ONLY' });
  });
});
