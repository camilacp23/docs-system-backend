/** The real application: horizontal chain, observable order, uniform errors (SDD 4.1, 7.1, 11). */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import YAML from 'yaml';
import { buildApp, DEFAULT_OPENAPI_PATH } from '../../src/app.js';
import { auditContext } from '../../src/db/prisma.js';
import type { OperationHandlers } from '../../src/http/operations.js';
import { bearer, bodyOf, startTestApp, TEST_ORIGIN, type TestApp } from '../helpers/app.js';

const SECRET_TEXT = 'SELECT * FROM secret_table WHERE password = hunter2';

const handlers: OperationHandlers = {
  listUsers: () => {
    throw new Error(SECRET_TEXT);
  },
  listApplications: () => Promise.reject(new Error(SECRET_TEXT)),
  getUser: (req, res) => {
    res.json({ data: { seenByAuditContext: auditContext.getStore()?.userId ?? null, user: req.user } });
  },
};

describe('application chain', () => {
  let t: TestApp;
  const tmp = mkdtempSync(join(tmpdir(), 'docs-contract-'));

  before(async () => {
    t = await startTestApp({ handlers });
  });
  after(async () => {
    rmSync(tmp, { recursive: true, force: true });
    await t.close();
  });

  type Spec = { paths: Record<string, Record<string, Record<string, unknown>>> };
  const contractCopy = (mutate: (spec: Spec) => void): string => {
    const spec = YAML.parse(readFileSync(DEFAULT_OPENAPI_PATH, 'utf8')) as Spec;
    mutate(spec);
    const file = join(tmp, `openapi-${Math.random().toString(16).slice(2)}.yaml`);
    writeFileSync(file, YAML.stringify(spec));
    return file;
  };

  describe('startup', () => {
    it('mounts the 50 operations of the contract', () => {
      assert.equal(t.built.policies.size, 50);
      assert.equal(t.built.notImplemented.length, 47); // listUsers, listApplications and getUser have handlers
    });

    it('refuses to start when an operation loses x-roles', () => {
      const openapiPath = contractCopy((spec) => {
        delete spec.paths['/users']!.get!['x-roles'];
      });
      assert.throws(() => buildApp({ config: t.config, db: t.db, openapiPath }), /listUsers has no x-roles/);
    });

    it('refuses to start when a non-public operation declares empty roles (it would be public)', () => {
      const openapiPath = contractCopy((spec) => {
        spec.paths['/users']!.get!['x-roles'] = [];
      });
      assert.throws(() => buildApp({ config: t.config, db: t.db, openapiPath }), /listUsers declares empty x-roles/);
    });

    it('refuses a handler that is not an operation of the contract', () => {
      assert.throws(
        () => buildApp({ config: t.config, db: t.db, handlers: { nope: () => undefined } }),
        /handler "nope" is not an operation/,
      );
    });
  });

  describe('order: 401 before 403 before 400 before the handler', () => {
    const badBody = { name: '' };

    it('no token -> 401, even with an invalid body', async () => {
      const res = await t.http.post('/api/v1/users').send(badBody);
      assert.equal(res.status, 401);
      assert.deepEqual(bodyOf(res), {
        code: 'UNAUTHENTICATED',
        message: 'Your session is not valid. Sign in again.',
        details: null,
      });
    });

    it('wrong role -> 403 with requiredRoles, even with an invalid body', async () => {
      const res = await t.http.post('/api/v1/users').set('Authorization', bearer(t.users.reader.token)).send(badBody);
      assert.equal(res.status, 403);
      assert.equal(bodyOf(res).code, 'FORBIDDEN');
      assert.equal(bodyOf(res).message, "Your role doesn't allow this action.");
      assert.deepEqual(bodyOf(res).details, { requiredRoles: ['ADMINISTRATOR'] });
    });

    it('right role, invalid body -> 400 VALIDATION_ERROR with fields', async () => {
      const res = await t.http.post('/api/v1/users').set('Authorization', bearer(t.users.admin.token)).send(badBody);
      assert.equal(res.status, 400);
      assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      assert.equal(bodyOf(res).message, 'Check the highlighted fields.');
      assert.ok(Array.isArray(bodyOf(res).details.fields) && bodyOf(res).details.fields.length > 0);
      for (const f of bodyOf(res).details.fields) {
        assert.deepEqual(Object.keys(f).sort(), ['field', 'message', 'rule']);
      }
      assert.ok(bodyOf(res).details.fields.some((f: { field: string }) => f.field === 'name'));
    });

    it('right role, invalid query -> 400 with the field name', async () => {
      const res = await t.http
        .get('/api/v1/variables?applicationId=1&pageSize=500')
        .set('Authorization', bearer(t.users.admin.token));
      assert.equal(res.status, 400);
      assert.equal(bodyOf(res).details.fields[0]?.field, 'pageSize');
    });

    it('right role, valid request, no module yet -> 404 NOT_FOUND / NOT_IMPLEMENTED (after validation)', async () => {
      const res = await t.http
        .get('/api/v1/onboarding/summary?applicationId=1')
        .set('Authorization', bearer(t.users.admin.token));
      assert.equal(res.status, 404);
      assert.equal(bodyOf(res).code, 'NOT_FOUND');
      assert.equal(bodyOf(res).details.reason, 'NOT_IMPLEMENTED');
    });

    it('an inactive user and a garbage token are 401', async () => {
      assert.equal(
        (await t.http.get('/api/v1/users').set('Authorization', bearer(t.users.inactive.token))).status,
        401,
      );
      assert.equal((await t.http.get('/api/v1/users').set('Authorization', 'Bearer not.a.jwt')).status, 401);
      assert.equal((await t.http.get('/api/v1/users').set('Authorization', 'Basic abc')).status, 401);
    });

    it('the audit context is open for the handler (R-1) and req.user comes from the database', async () => {
      const res = await t.http.get('/api/v1/users/1').set('Authorization', bearer(t.users.admin.token));
      assert.equal(res.status, 200);
      const data = (res.body as { data: { seenByAuditContext: number | null; user: { role: string } } }).data;
      assert.equal(data.seenByAuditContext, t.users.admin.id);
      assert.equal(data.user.role, 'ADMINISTRATOR');
    });

    it('a Reader may read only their own user (SELF_OR_ROLE)', async () => {
      const own = await t.http
        .get(`/api/v1/users/${t.users.reader.id}`)
        .set('Authorization', bearer(t.users.reader.token));
      assert.equal(own.status, 200);
      const other = await t.http
        .get(`/api/v1/users/${t.users.admin.id}`)
        .set('Authorization', bearer(t.users.reader.token));
      assert.equal(other.status, 403);
    });

    it('an id that cannot exist is 404 without reaching the module', async () => {
      const res = await t.http.get('/api/v1/users/2147483648').set('Authorization', bearer(t.users.admin.token));
      assert.equal(res.status, 404);
      assert.equal(bodyOf(res).code, 'NOT_FOUND');
      assert.equal(bodyOf(res).message, "This user doesn't exist. It may have been deleted.");
      const text = await t.http.get('/api/v1/users/abc').set('Authorization', bearer(t.users.admin.token));
      assert.equal(text.status, 400);
    });
  });

  describe('public operations', () => {
    it('login validates its body and then reaches the module', async () => {
      const bad = await t.http.post('/api/v1/auth/login').send({ email: 'x' });
      assert.equal(bad.status, 400);
      const ok = await t.http
        .post('/api/v1/auth/login')
        .send({ email: 'a@b.co', password: 'a-long-enough-password-1' });
      assert.equal(ok.status, 404);
      assert.equal(bodyOf(ok).details.reason, 'NOT_IMPLEMENTED');
    });

    it('refresh and logout accept only the exact frontend Origin', async () => {
      for (const path of ['/api/v1/auth/refresh', '/api/v1/auth/logout']) {
        const foreign = await t.http.post(path).set('Origin', 'https://evil.example');
        assert.equal(foreign.status, 403, path);
        assert.equal(bodyOf(foreign).code, 'FORBIDDEN');
        const none = await t.http.post(path);
        assert.equal(none.status, 403, path);
        const ok = await t.http.post(path).set('Origin', TEST_ORIGIN);
        assert.equal(ok.status, 404, path);
        assert.equal(bodyOf(ok).details.reason, 'NOT_IMPLEMENTED');
      }
    });

    it('the Jira webhook needs no user token: its gate answers 401 INVALID_SIGNATURE before anything else (1 MB limit)', async () => {
      const unsigned = await t.http
        .post('/api/v1/integrations/jira/webhook')
        .set('Content-Type', 'application/json')
        .send('{"a":1}');
      assert.equal(unsigned.status, 401);
      assert.equal(bodyOf(unsigned).code, 'INVALID_SIGNATURE');
      const big = await t.http
        .post('/api/v1/integrations/jira/webhook')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ a: 'x'.repeat(1_100_000) }));
      assert.equal(big.status, 413);
      assert.equal(bodyOf(big).code, 'PAYLOAD_TOO_LARGE');
    });
  });

  describe('uniform errors', () => {
    it('unknown path or method -> 404 ROUTE_NOT_FOUND', async () => {
      for (const res of [
        await t.http.get('/api/v1/nope'),
        await t.http.get('/'),
        await t.http.patch('/api/v1/users'),
        await t.http.delete('/api/v1/auth/login'),
      ]) {
        assert.equal(res.status, 404);
        assert.deepEqual(bodyOf(res), {
          code: 'NOT_FOUND',
          message: "This resource doesn't exist. It may have been deleted.",
          details: { element: 'resource', id: null, reason: 'ROUTE_NOT_FOUND' },
        });
      }
    });

    it('body over 1 MB -> 413 PAYLOAD_TOO_LARGE with the catalog message', async () => {
      const res = await t.http
        .post('/api/v1/users')
        .set('Authorization', bearer(t.users.admin.token))
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ name: 'x'.repeat(1_100_000) }));
      assert.equal(res.status, 413);
      assert.deepEqual(bodyOf(res), {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'This is too much text to save at once. Shorten the longest fields and try again.',
        details: null,
      });
    });

    it('malformed JSON -> 400 VALIDATION_ERROR', async () => {
      const res = await t.http
        .post('/api/v1/users')
        .set('Authorization', bearer(t.users.admin.token))
        .set('Content-Type', 'application/json')
        .send('{"name": ');
      assert.equal(res.status, 400);
      assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      assert.equal(bodyOf(res).details.fields[0]?.field, 'body');
      assert.doesNotMatch(JSON.stringify(bodyOf(res)), /Unexpected|position|JSON\.parse/);
    });

    it('an unexpected error -> 500 INTERNAL_ERROR with the same requestId as the header and the log, nothing leaked', async () => {
      for (const path of ['/api/v1/users', '/api/v1/applications']) {
        const res = await t.http.get(path).set('Authorization', bearer(t.users.admin.token));
        assert.equal(res.status, 500, path);
        const requestId = res.headers['x-request-id'];
        assert.ok(typeof requestId === 'string' && requestId.length >= 8);
        assert.deepEqual(bodyOf(res), {
          code: 'INTERNAL_ERROR',
          message: `Something went wrong on our side. Try again in a moment. Reference: ${requestId}.`,
          details: { requestId },
        });
        const text = JSON.stringify(bodyOf(res));
        assert.doesNotMatch(text, /secret_table|hunter2|stack|at .*\.ts|SELECT/);
        assert.ok(
          t.logs.some((l) => l.includes(requestId) && l.includes('request failed')),
          'logged with the same id',
        );
        assert.equal(res.headers.etag, undefined, 'an error carries no ETag');
      }
    });
  });

  describe('headers', () => {
    it('helmet: JSON API policy', async () => {
      const res = await t.http.get('/api/v1/nope');
      assert.equal(res.headers['content-security-policy'], "default-src 'none';frame-ancestors 'none'");
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.ok(res.headers['strict-transport-security']);
      assert.equal(res.headers['x-powered-by'], undefined);
    });

    it('CORS: exact allowlist with credentials, exposed headers, methods and headers', async () => {
      const ok = await t.http.get('/api/v1/nope').set('Origin', TEST_ORIGIN);
      assert.equal(ok.headers['access-control-allow-origin'], TEST_ORIGIN);
      assert.equal(ok.headers['access-control-allow-credentials'], 'true');
      assert.equal(ok.headers['access-control-expose-headers'], 'ETag,Location,Retry-After,X-Request-Id');
      assert.match(String(ok.headers.vary), /Origin/);

      for (const origin of ['https://evil.example', 'http://localhost:5174', `${TEST_ORIGIN}/`]) {
        const res = await t.http.get('/api/v1/nope').set('Origin', origin);
        assert.equal(res.headers['access-control-allow-origin'], undefined, origin);
        assert.equal(res.headers['access-control-allow-credentials'], undefined, origin);
      }

      const pre = await t.http
        .options('/api/v1/screens/1')
        .set('Origin', TEST_ORIGIN)
        .set('Access-Control-Request-Method', 'PUT')
        .set('Access-Control-Request-Headers', 'Authorization, Content-Type, If-Match');
      assert.equal(pre.status, 204);
      assert.equal(pre.headers['access-control-allow-methods'], 'GET,POST,PUT,DELETE');
      assert.equal(pre.headers['access-control-allow-headers'], 'Authorization,Content-Type,If-Match');

      const denied = await t.http
        .options('/api/v1/screens/1')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'PUT');
      assert.equal(denied.headers['access-control-allow-origin'], undefined);
    });

    it('X-Request-Id on every response; a safe client id is kept, an unsafe one is replaced', async () => {
      const generated = await t.http.get('/api/v1/nope');
      assert.match(String(generated.headers['x-request-id']), /^[0-9a-f-]{12}$/);
      const kept = await t.http.get('/api/v1/nope').set('X-Request-Id', 'client-req-0001');
      assert.equal(kept.headers['x-request-id'], 'client-req-0001');
      const unsafe = await t.http.get('/api/v1/nope').set('X-Request-Id', 'bad id\twith spaces');
      assert.notEqual(unsafe.headers['x-request-id'], 'bad id\twith spaces');
      const parseError = await t.http.post('/api/v1/users').set('Content-Type', 'application/json').send('{');
      assert.ok(parseError.headers['x-request-id'], 'also on errors raised by the body parser');
    });

    it('the log never contains tokens or cookies', async () => {
      const token = t.users.admin.token;
      await t.http
        .get('/api/v1/users/1')
        .set('Authorization', bearer(token))
        .set('Cookie', 'rt=super-secret-refresh-token');
      const all = t.logs.join('\n');
      assert.ok(all.length > 0);
      assert.ok(!all.includes(token));
      assert.ok(!all.includes('super-secret-refresh-token'));
    });
  });
});
