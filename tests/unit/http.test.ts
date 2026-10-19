/** src/http utilities: ETag / If-Match, pagination, sort whitelist, ids, Location. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { assertIfMatch, etagOf, etagOfJson, setEtag, setLocation } from '../../src/http/etag.js';
import { assertIdInRange, elementOfPath, INT32_MAX } from '../../src/http/ids.js';
import { paged, parsePagination, parseSort } from '../../src/http/pagination.js';
import { ApiError } from '../../src/security/errors.js';

const reqWith = (ifMatch?: string): Request =>
  ({ get: (h: string) => (h === 'if-match' ? ifMatch : undefined) }) as unknown as Request;
const resWith = (headers: Record<string, string>): Response =>
  ({ setHeader: (k: string, v: string) => (headers[k] = v) }) as unknown as Response;
const thrown = (fn: () => void): ApiError => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ApiError);
    return e;
  }
  return assert.fail('should have thrown');
};

describe('ETag and If-Match', () => {
  it('derives a weak validator from updatedAt (epoch ms), as the contract states', () => {
    assert.equal(etagOf({ updatedAt: new Date(1727548800123) }), 'W/"1727548800123"');
    assert.equal(etagOf({ updatedAt: '2024-09-28T18:40:00.123Z' }), 'W/"1727548800123"');
  });

  it('hashes a JSON representation only as a fallback', () => {
    assert.match(etagOfJson({ a: 1 }), /^W\/"[0-9a-f]{16}"$/);
    assert.equal(etagOfJson({ a: 1 }), etagOfJson({ a: 1 }));
    assert.notEqual(etagOfJson({ a: 1 }), etagOfJson({ a: 2 }));
  });

  it('sets the header', () => {
    const headers: Record<string, string> = {};
    setEtag(resWith(headers), 'W/"1"');
    assert.deepEqual(headers, { ETag: 'W/"1"' });
  });

  it('If-Match is optional, compared exactly, and a mismatch is 412 with currentETag', () => {
    assertIfMatch(reqWith(undefined), 'screen', 'W/"2"');
    assertIfMatch(reqWith('W/"2"'), 'screen', 'W/"2"');
    const e = thrown(() => assertIfMatch(reqWith('W/"1"'), 'screen', 'W/"2"'));
    assert.equal(e.status, 412);
    assert.equal(e.code, 'PRECONDITION_FAILED');
    assert.deepEqual(e.details, { element: 'screen', currentETag: 'W/"2"' });
    assert.equal(
      e.message,
      'Someone else saved changes to this screen after you opened it. Reload to see their version.',
    );
    assert.equal(thrown(() => assertIfMatch(reqWith('"2"'), 'screen', 'W/"2"')).status, 412); // exact comparison
  });

  it('builds Location for a 201', () => {
    const headers: Record<string, string> = {};
    setLocation(resWith(headers), '/variables', 42);
    assert.equal(headers.Location, '/api/v1/variables/42');
  });
});

describe('pagination and sort', () => {
  it('defaults to page 1, size 20', () => {
    assert.deepEqual(parsePagination({}), { page: 1, pageSize: 20, skip: 0, take: 20 });
    assert.deepEqual(parsePagination({ page: '3', pageSize: '100' }), { page: 3, pageSize: 100, skip: 200, take: 100 });
  });

  it('rejects out-of-range values with VALIDATION_ERROR', () => {
    for (const q of [{ pageSize: '101' }, { pageSize: '0' }, { page: '0' }, { page: 'x' }]) {
      assert.equal(thrown(() => parsePagination(q)).code, 'VALIDATION_ERROR');
    }
  });

  it('parses sort over the whitelist of the contract', () => {
    const allowed = ['name', 'updatedAt'];
    const fallback = { field: 'name', direction: 'asc' as const };
    assert.deepEqual(parseSort(undefined, allowed, fallback), fallback);
    assert.deepEqual(parseSort('-updatedAt', allowed, fallback), { field: 'updatedAt', direction: 'desc' });
    assert.deepEqual(parseSort('name', allowed, fallback), { field: 'name', direction: 'asc' });
    assert.equal(thrown(() => parseSort('passwordHash', allowed, fallback)).code, 'VALIDATION_ERROR');
    assert.equal(thrown(() => parseSort('--name', allowed, fallback)).code, 'VALIDATION_ERROR');
  });

  it('builds the collection envelope', () => {
    assert.deepEqual(paged([1, 2], { page: 2, pageSize: 2 }, 5), { data: [1, 2], page: 2, pageSize: 2, total: 5 });
  });
});

describe('ids', () => {
  it('answers 404 for an integer that cannot exist', () => {
    assertIdInRange(INT32_MAX, 'screen');
    const e = thrown(() => assertIdInRange(INT32_MAX + 1, 'screen'));
    assert.equal(e.status, 404);
    assert.equal(e.code, 'NOT_FOUND');
  });

  it('names the element from the contract path', () => {
    assert.equal(elementOfPath('/screens/{id}/status'), 'screen');
    assert.equal(elementOfPath('/users/{id}'), 'user');
    assert.equal(elementOfPath('/nothing'), 'resource');
  });
});
