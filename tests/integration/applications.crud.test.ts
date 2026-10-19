/**
 * Applications resource (FR-27, NFR-16; SDD Table 47; D-47, D-62, D-63) against the real service: the four
 * operations, the App (OnStart) screen created by the trigger, the role matrix, DUPLICATE_NAME, ETag / If-Match,
 * archiving and the audit trail.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import {
  applicationOf,
  applicationsPageOf,
  createApplication,
  putBodyOf,
  uniqueName,
} from '../helpers/applications.js';
import { asUser } from '../helpers/users.js';

describe('applications', () => {
  let t: TestApp;
  let admin: ReturnType<typeof asUser>;
  let developer: ReturnType<typeof asUser>;
  let reader: ReturnType<typeof asUser>;

  before(async () => {
    t = await startTestApp();
    admin = asUser(t, t.users.admin.token);
    developer = asUser(t, t.users.developer.token);
    reader = asUser(t, t.users.reader.token);
  });
  after(async () => {
    await t.close();
  });

  const fresh = (over: Parameters<typeof createApplication>[2] = {}) => createApplication(t, t.users.admin.token, over);

  describe('POST /applications', () => {
    it('201 with the App (OnStart) screen, the creator as Ref, Location and ETag', async () => {
      const name = uniqueName('SAR');
      const res = await admin.post('/applications', {
        name,
        description: 'Sistema de Administración de Requerimientos',
        platform: 'Power Apps',
        jiraProjectKey: 'TECHEA',
      });
      assert.equal(res.status, 201);
      const a = applicationOf(res);
      assert.equal(res.headers.location, `/api/v1/applications/${a.id}`);
      assert.match(res.headers.etag as string, /^W\/"\d+"$/);
      assert.equal(res.headers.etag, `W/"${new Date(a.updatedAt).getTime()}"`);
      assert.deepEqual(
        { ...a, id: 0, appContextScreen: { ...a.appContextScreen, id: 0 }, createdAt: '', updatedAt: '' },
        {
          id: 0,
          name,
          description: 'Sistema de Administración de Requerimientos',
          platform: 'Power Apps',
          jiraProjectKey: 'TECHEA',
          status: 'ACTIVE',
          appContextScreen: { id: 0, name: 'App (OnStart)' },
          createdBy: { id: t.users.admin.id, name: 'Ada Admin' },
          createdAt: '',
          updatedAt: '',
        },
      );
      const screen = await t.db.base.screen.findUniqueOrThrow({ where: { id: a.appContextScreen.id } });
      assert.equal(screen.applicationId, a.id);
      assert.equal(screen.isAppContext, true);
      assert.equal(screen.authorId, t.users.admin.id);
    });

    it('optional fields omitted are stored as null', async () => {
      const res = await admin.post('/applications', { name: uniqueName(), platform: 'Web' });
      assert.equal(res.status, 201);
      assert.equal(applicationOf(res).description, null);
      assert.equal(applicationOf(res).jiraProjectKey, null);
    });

    it('a repeated name is 409 DUPLICATE_NAME with the exact message (D-63)', async () => {
      const { application } = await fresh();
      const res = await admin.post('/applications', { name: application.name, platform: 'Other' });
      assert.equal(res.status, 409);
      assert.equal(bodyOf(res).code, 'DUPLICATE_NAME');
      assert.equal(
        bodyOf(res).message,
        `An application named ${application.name} already exists in Documentación técnica.`,
      );
      assert.deepEqual((res.body as { details: unknown }).details, {
        field: 'name',
        type: 'application',
        name: application.name,
        application: 'Documentación técnica',
        container: 'system',
      });
    });

    it('400 for a missing platform, an unknown field, a bad Jira key and a blank name', async () => {
      const cases: [object, string][] = [
        [{ name: uniqueName() }, 'platform'],
        [{ name: uniqueName(), platform: 'x', status: 'ARCHIVED' }, 'status'],
        [{ name: uniqueName(), platform: 'x', jiraProjectKey: 'techea' }, 'jiraProjectKey'],
        [{ name: uniqueName(), platform: 'x', jiraProjectKey: 'A' }, 'jiraProjectKey'],
        [{ name: '   ', platform: 'x' }, 'name'],
      ];
      for (const [body, field] of cases) {
        const res = await admin.post('/applications', body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
        assert.ok(
          bodyOf(res).details.fields.some((f) => f.field.includes(field)),
          JSON.stringify(bodyOf(res).details.fields),
        );
      }
    });
  });

  describe('GET /applications and /applications/{id}', () => {
    it('lists name ascending with id as tie-breaker, in the collection envelope', async () => {
      const a = await fresh({ name: 'Zeta list' });
      const b = await fresh({ name: 'Alpha list' });
      const res = await admin.get('/applications?q=list&pageSize=100');
      assert.equal(res.status, 200);
      const page = applicationsPageOf(res);
      assert.deepEqual(
        page.data.map((x) => x.id),
        [b.application.id, a.application.id],
      );
      assert.equal(page.page, 1);
      assert.equal(page.pageSize, 100);
      assert.equal(page.total, 2);
      assert.ok(page.data.every((x) => x.appContextScreen.name === 'App (OnStart)' && x.createdBy.id > 0));
    });

    it('q is case-insensitive over the name only and treats % and _ literally', async () => {
      await fresh({ name: 'Needle Case', description: 'haystack' });
      assert.equal(applicationsPageOf(await admin.get('/applications?q=nEEdle')).total, 1);
      assert.equal(applicationsPageOf(await admin.get('/applications?q=haystack')).total, 0);
      assert.equal(applicationsPageOf(await admin.get('/applications?q=%25')).total, 0);
      assert.equal(applicationsPageOf(await admin.get('/applications?q=_')).total, 0);
    });

    it('paginates and filters by status', async () => {
      const { application } = await fresh({ name: 'Zzz archived' });
      await admin.put(`/applications/${application.id}`, putBodyOf(application, { status: 'ARCHIVED' }));
      const archived = applicationsPageOf(await admin.get('/applications?status=ARCHIVED'));
      assert.ok(archived.data.length >= 1 && archived.data.every((x) => x.status === 'ARCHIVED'));
      const all = applicationsPageOf(await admin.get('/applications?pageSize=1&page=2'));
      assert.equal(all.data.length, 1);
      assert.equal(all.page, 2);
      assert.ok(all.total > 2);
      assert.equal((await admin.get('/applications?pageSize=101')).status, 400);
      assert.equal((await admin.get('/applications?status=DELETED')).status, 400);
    });

    it('GET /applications/{id}: 200 with ETag; 404 for a missing id and for one above the integer range (D-62)', async () => {
      const { application, etag } = await fresh();
      const res = await admin.get(`/applications/${application.id}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.etag, etag);
      assert.deepEqual(applicationOf(res), application);
      for (const id of [999_999, 2_147_483_648]) {
        const missing = await admin.get(`/applications/${id}`);
        assert.equal(missing.status, 404, String(id));
        assert.equal(bodyOf(missing).code, 'NOT_FOUND');
        assert.equal(bodyOf(missing).message, "This application doesn't exist. It may have been deleted.");
      }
      assert.equal((await admin.get('/applications/abc')).status, 400);
    });
  });

  describe('PUT /applications/{id}', () => {
    it('replaces the whole representation; omitted description and jiraProjectKey become null', async () => {
      const { application } = await fresh({ description: 'old', jiraProjectKey: 'ABC' });
      const res = await admin.put(`/applications/${application.id}`, {
        name: `${application.name} v2`,
        platform: 'Web',
        status: 'ACTIVE',
      });
      assert.equal(res.status, 200);
      const a = applicationOf(res);
      assert.equal(a.name, `${application.name} v2`);
      assert.equal(a.platform, 'Web');
      assert.equal(a.description, null);
      assert.equal(a.jiraProjectKey, null);
      assert.equal(a.createdBy.id, application.createdBy.id);
      assert.deepEqual(a.appContextScreen, application.appContextScreen);
      assert.equal(res.headers.etag, `W/"${new Date(a.updatedAt).getTime()}"`);
      assert.notEqual(a.updatedAt, application.updatedAt);
    });

    it('archives and unarchives; an archived application can still be edited by PUT', async () => {
      const { application } = await fresh();
      const archived = await admin.put(
        `/applications/${application.id}`,
        putBodyOf(application, { status: 'ARCHIVED' }),
      );
      assert.equal(archived.status, 200);
      assert.equal(applicationOf(archived).status, 'ARCHIVED');
      const renamed = await admin.put(
        `/applications/${application.id}`,
        putBodyOf(applicationOf(archived), { description: 'edited while archived' }),
      );
      assert.equal(renamed.status, 200);
      assert.equal(applicationOf(renamed).description, 'edited while archived');
      const restored = await admin.put(
        `/applications/${application.id}`,
        putBodyOf(applicationOf(renamed), { status: 'ACTIVE' }),
      );
      assert.equal(applicationOf(restored).status, 'ACTIVE');
      assert.equal(applicationOf(await admin.get(`/applications/${application.id}`)).status, 'ACTIVE');
    });

    it('If-Match: the current ETag is accepted, a stale one is 412 with details.currentETag (D-62)', async () => {
      const { application, etag } = await fresh();
      const ok = await admin.put(`/applications/${application.id}`, putBodyOf(application, { platform: 'One' }), etag);
      assert.equal(ok.status, 200);
      const stale = await admin.put(
        `/applications/${application.id}`,
        putBodyOf(application, { platform: 'Two' }),
        etag,
      );
      assert.equal(stale.status, 412);
      assert.equal(bodyOf(stale).code, 'PRECONDITION_FAILED');
      assert.equal(bodyOf(stale).details.element, 'application');
      assert.equal((bodyOf(stale).details as unknown as { currentETag: string }).currentETag, ok.headers.etag);
      assert.equal(applicationOf(await admin.get(`/applications/${application.id}`)).platform, 'One');
    });

    it('errors are ordered 404, 412, 409', async () => {
      const a = await fresh();
      const b = await fresh();
      const missing = await admin.put('/applications/999999', putBodyOf(a.application), 'W/"1"');
      assert.equal(missing.status, 404);
      const big = await admin.put('/applications/2147483648', putBodyOf(a.application));
      assert.equal(big.status, 404);
      const both = await admin.put(
        `/applications/${a.application.id}`,
        putBodyOf(a.application, { name: b.application.name }),
        'W/"1"',
      );
      assert.equal(both.status, 412);
      const taken = await admin.put(
        `/applications/${a.application.id}`,
        putBodyOf(a.application, { name: b.application.name }),
      );
      assert.equal(taken.status, 409);
      assert.equal(bodyOf(taken).code, 'DUPLICATE_NAME');
      assert.equal(
        bodyOf(taken).message,
        `An application named ${b.application.name} already exists in Documentación técnica.`,
      );
      assert.equal(applicationOf(await admin.get(`/applications/${a.application.id}`)).name, a.application.name);
    });

    it('keeping its own name is not a conflict', async () => {
      const { application } = await fresh();
      assert.equal((await admin.put(`/applications/${application.id}`, putBodyOf(application))).status, 200);
    });

    it('400 for a missing status, a missing platform and a bad Jira key', async () => {
      const { application } = await fresh();
      const { status: _status, ...withoutStatus } = putBodyOf(application);
      for (const body of [
        withoutStatus,
        putBodyOf(application, { jiraProjectKey: 'bad key' }),
        { name: 'x', status: 'ACTIVE' },
      ]) {
        const res = await admin.put(`/applications/${application.id}`, body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      }
    });
  });

  describe('roles', () => {
    it('Developer and Reader read (200) but cannot write (403); no token is 401', async () => {
      const { application } = await fresh();
      for (const who of [developer, reader]) {
        assert.equal((await who.get('/applications')).status, 200);
        assert.equal((await who.get(`/applications/${application.id}`)).status, 200);
        const post = await who.post('/applications', { name: uniqueName(), platform: 'x' });
        assert.equal(post.status, 403);
        assert.equal(bodyOf(post).code, 'FORBIDDEN');
        assert.equal((await who.put(`/applications/${application.id}`, putBodyOf(application))).status, 403);
      }
      assert.equal((await t.http.get('/api/v1/applications')).status, 401);
      assert.equal((await t.http.post('/api/v1/applications').send({})).status, 401);
    });

    it('the four operations are implemented (no NOT_IMPLEMENTED)', async () => {
      const { application } = await fresh();
      const responses = [
        await admin.get('/applications'),
        await admin.post('/applications', { name: uniqueName(), platform: 'x' }),
        await admin.get(`/applications/${application.id}`),
        await admin.put(`/applications/${application.id}`, putBodyOf(application)),
      ];
      for (const res of responses) assert.notEqual(bodyOf(res).details?.reason, 'NOT_IMPLEMENTED');
      assert.deepEqual(
        responses.map((r) => r.status),
        [200, 201, 200, 200],
      );
    });
  });

  describe('audit (R-1, R-2)', () => {
    it('creating records the application and its App (OnStart) screen with the acting administrator', async () => {
      const { application } = await fresh();
      const rows = await t.db.base.auditLog.findMany({
        where: { applicationId: application.id },
        orderBy: { id: 'asc' },
      });
      assert.deepEqual(
        // The order of the two records depends on the audit triggers (the screen is inserted by the AFTER INSERT one).
        rows.map((r) => [r.entityType, r.action]).sort(),
        [
          ['application', 'CREATE'],
          ['screen', 'CREATE'],
        ],
      );
      assert.ok(rows.every((r) => r.actorUserId === t.users.admin.id && r.dbRole === 'docs_app'));
    });

    it('archiving records an UPDATE of status with the actor', async () => {
      const { application } = await fresh();
      await admin.put(`/applications/${application.id}`, putBodyOf(application, { status: 'ARCHIVED' }));
      const row = await t.db.base.auditLog.findFirstOrThrow({
        where: { entityType: 'application', entityId: String(application.id), action: 'UPDATE' },
      });
      assert.equal(row.actorUserId, t.users.admin.id);
      assert.ok(row.changedFields.includes('status'));
    });
  });
});
