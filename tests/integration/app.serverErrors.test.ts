/**
 * Diagnosis of a 500 in a test: the app of `startTestApp` keeps the errors the server logs, and prints each one to stderr
 * as soon as it is written, with the same `requestId` the client got in `details.requestId`. Two failures that are
 * known in advance: a plain error (its message and stack are logged) and a database error that the server logs by
 * class and code only (a Prisma transaction timeout, P2028). Nothing secret may be printed.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { Prisma } from '../../src/generated/prisma/client.js';
import type { OperationHandlers } from '../../src/http/operations.js';
import { bearer, bodyOf, startTestApp, type TestApp } from '../helpers/app.js';

const KNOWN_MESSAGE = 'known failure 7c1f for the diagnosis test';

describe('test app: the cause of a 500 is recorded', () => {
  let t: TestApp;
  const ref: { app?: TestApp } = {};
  const handlers: OperationHandlers = {
    // A plain error: the server logs its message and stack.
    getOnboardingSummary: () => {
      throw new Error(KNOWN_MESSAGE);
    },
    // A database error: a transaction that outlives its timeout (Prisma P2028).
    getIndicators: async () => {
      await ref.app!.db.base.$transaction(
        async (tx) => {
          // The timeout (50 ms) expires while the code waits; the next statement finds the transaction closed.
          await new Promise((resolve) => setTimeout(resolve, 300));
          await tx.$queryRaw(Prisma.sql`SELECT 1`);
        },
        { timeout: 50 },
      );
    },
  };

  before(async () => {
    t = await startTestApp({ handlers });
    ref.app = t;
  });
  after(async () => {
    await t.close();
  });

  const stderr = mock.method(console, 'error', () => undefined);
  beforeEach(() => {
    stderr.mock.resetCalls();
  });
  const printed = (): string => stderr.mock.calls.map((c) => String(c.arguments[0])).join('\n');
  const call = (path: string) => t.http.get(`/api/v1${path}`).set('Authorization', bearer(t.users.admin.token));

  it('a plain error: the log of the 500 has the same requestId, the message and the stack', async () => {
    const res = await call('/onboarding/summary?applicationId=1');
    assert.equal(res.status, 500);
    assert.equal(bodyOf(res).code, 'INTERNAL_ERROR');
    const requestId = bodyOf(res).details.requestId;
    assert.ok(requestId);

    const entry = t.errorLogs().find((e) => e.requestId === requestId);
    assert.ok(entry, 'the error log of that request was kept');
    assert.equal(entry.errorClass, 'Error');
    assert.equal(entry.message, KNOWN_MESSAGE);
    assert.match(entry.stack ?? '', /known failure 7c1f/);
    assert.match(entry.stack ?? '', /\n\s+at /);
    assert.equal(entry.path, '/api/v1/onboarding/summary');

    assert.ok(printed().includes(`requestId=${requestId}`), 'and it was printed at once');
    assert.ok(printed().includes(KNOWN_MESSAGE));
  });

  it('the response to the client has none of it', async () => {
    const res = await call('/onboarding/summary?applicationId=1');
    assert.ok(!JSON.stringify(res.body).includes(KNOWN_MESSAGE));
    assert.ok(!JSON.stringify(res.body).includes(' at '));
  });

  it('a database error: the log has the Prisma code and the reason, which is what a P2028 needs', async () => {
    const res = await call('/dashboard/indicators?applicationId=1');
    assert.equal(res.status, 500);
    const requestId = bodyOf(res).details.requestId;
    const entry = t.errorLogs().find((e) => e.requestId === requestId);
    assert.ok(entry, 'the error log of that request was kept');
    assert.equal(entry.prismaCode, 'P2028');
    assert.equal(entry.reason, 'DB_ERROR_P2028');
    assert.equal(entry.errorClass, 'PrismaClientKnownRequestError');
    assert.ok(printed().includes('"prismaCode":"P2028"'));
    assert.ok(printed().includes(`requestId=${requestId}`));
  });

  it('never prints the token, the cookie or a password', async () => {
    await call('/onboarding/summary?applicationId=1').set('Cookie', 'rt=secret-refresh-value');
    await call('/dashboard/indicators?applicationId=1');
    const out = printed();
    assert.ok(out.length > 0);
    assert.ok(!out.includes(t.users.admin.token), 'the access token');
    assert.ok(!out.includes('secret-refresh-value'), 'the cookie');
    assert.ok(!/authorization|cookie|password/i.test(out.replace(/"path":"[^"]*"/g, '')), 'no sensitive key');
  });

  it('a request that is not a server error leaves no entry', async () => {
    const before = t.errorLogs().length;
    const res = await t.http.get('/api/v1/onboarding/summary?applicationId=1');
    assert.equal(res.status, 401);
    assert.equal(t.errorLogs().length, before);
  });
});
