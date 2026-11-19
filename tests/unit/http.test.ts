/** src/http utilities: ETag / If-Match, pagination, sort whitelist, ids, Location. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import {
  assertIfMatch,
  assertScreenIfMatch,
  etagOf,
  etagOfJson,
  screenEtagOf,
  screenFingerprintOf,
  setEtag,
  setLocation,
} from '../../src/http/etag.js';
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

  /** A screen as the API returns it, with an item of every kind that comes from another row (D-153). */
  const screenOf = () => ({
    updatedAt: new Date(1727548800123),
    pendingSubtasks: 3,
    commentCount: 5,
    author: { id: 1, name: 'Ana' },
    components: [{ uses: [{ id: 10, targetType: 'VARIABLE', target: { id: 7, name: 'gA' } }] }],
    variableLinks: [
      { id: 20, variable: { id: 7, name: 'gA' }, isOrigin: false, originUsedIn: null },
      { id: 21, variable: { id: 8, name: 'gOrigin' }, isOrigin: true, originUsedIn: 'OnStart' },
    ],
    collectionLinks: [{ id: 30, collection: { id: 4, name: 'colA' } }],
    navigations: [{ id: 40, targetScreen: { id: 9, name: 'Home' } }],
  });

  it('builds the ETag of a screen from updatedAt, the two counters and a fingerprint (D-153)', () => {
    const base = screenOf();
    const etag = screenEtagOf(base);
    assert.match(etag, /^W\/"1727548800123-3-5-[0-9a-f]{8}"$/);
    assert.equal(screenEtagOf({ ...base, updatedAt: '2024-09-28T18:40:00.123Z' }), etag);
    assert.notEqual(screenEtagOf({ ...base, pendingSubtasks: 2 }), etag);
    assert.notEqual(screenEtagOf({ ...base, commentCount: 6 }), etag);
  });

  it('the fingerprint is stable, ignores the order of the arrays and changes with every item of another row', () => {
    const base = screenOf();
    const fingerprint = screenFingerprintOf(base);
    assert.match(fingerprint, /^[0-9a-f]{8}$/);
    assert.equal(screenFingerprintOf(screenOf()), fingerprint, 'stable');
    assert.equal(screenFingerprintOf({ ...base, variableLinks: [...base.variableLinks].reverse() }), fingerprint);
    const changes: Record<string, ReturnType<typeof screenOf>> = {
      author: { ...base, author: { id: 1, name: 'Ana María' } },
      use: { ...base, components: [{ uses: [{ id: 10, targetType: 'VARIABLE', target: { id: 7, name: 'gB' } }] }] },
      variable: {
        ...base,
        variableLinks: [{ ...base.variableLinks[0]!, variable: { id: 7, name: 'gB' } }, base.variableLinks[1]!],
      },
      originUsedIn: {
        ...base,
        variableLinks: [base.variableLinks[0]!, { ...base.variableLinks[1]!, originUsedIn: 'X' }],
      },
      originRemoved: { ...base, variableLinks: [base.variableLinks[0]!] },
      collection: { ...base, collectionLinks: [{ id: 30, collection: { id: 4, name: 'colB' } }] },
      navigation: { ...base, navigations: [{ id: 40, targetScreen: { id: 9, name: 'Start' } }] },
    };
    for (const [what, changed] of Object.entries(changes)) {
      assert.notEqual(screenFingerprintOf(changed), fingerprint, what);
    }
  });

  it('If-Match of a screen compares only the updatedAt part and accepts the three formats (D-101, D-153)', () => {
    const current = 'W/"2000-3-5-0a1b2c3d"';
    assertScreenIfMatch(reqWith(undefined), 'screen', current);
    assertScreenIfMatch(reqWith('W/"2000-3-5-0a1b2c3d"'), 'screen', current);
    assertScreenIfMatch(reqWith('W/"2000-3-5-ffffffff"'), 'screen', current); // another fingerprint: not a 412
    assertScreenIfMatch(reqWith('W/"2000-3-5"'), 'screen', current); // the format of three parts
    assertScreenIfMatch(reqWith('W/"2000-0-0"'), 'screen', current); // the counters changed: not a 412
    assertScreenIfMatch(reqWith('W/"2000"'), 'screen', current); // former format
    for (const supplied of [
      'W/"1999-3-5"',
      'W/"1999"',
      '2000',
      '"2000"',
      'W/"2000-3"',
      'W/"2000-a-b"',
      'W/"2000-1-2-3"',
      'W/"2000-3-5-0A1B2C3D"',
      'W/"2000-3-5-0a1b2c3"',
      'W/"2000-3-5-0a1b2c3d4"',
      'W/"2000-3-5-0a1b2c3d-1"',
      '*',
    ]) {
      const e = thrown(() => assertScreenIfMatch(reqWith(supplied), 'screen', current));
      assert.equal(e.status, 412, supplied);
      assert.deepEqual(e.details, { element: 'screen', currentETag: current });
    }
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
