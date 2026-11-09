/**
 * GET /audit-log (FR-21; D-107) through the whole application and the contract validator: roles, filters and their
 * combinations, the inclusive limits of `from` and `to`, the 400 rules, pagination, the deterministic order, ETag and
 * 304. Every 200 is checked against the contract. The records come from real writes by the API (the trigger writes
 * them); nothing is written to `audit_log` by hand.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { createApplication } from '../helpers/applications.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { asUser } from '../helpers/users.js';
import { createBodyOf as variableBody, variableOf } from '../helpers/variables.js';

type Entry = {
  id: string;
  action: string;
  eventName: string | null;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  applicationId: number | null;
  actor: { id: number; name: string } | null;
  dbRole?: string;
  changedFields: string[];
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  createdAt: string;
};
type ListBody = { data: Entry[]; page: number; pageSize: number; total: number };

describe('GET /audit-log', () => {
  let t: TestApp;
  const pgOverlap = watchPgOverlap();
  let appA: number;
  let appB: number;
  let varA1: number;
  let varB1: number;
  let tied: number[];

  /** Calls the endpoint as `token`; the query is encoded by supertest, so `+` of a zone survives. */
  const get = (token: string, query: Record<string, string | number> = {}) =>
    t.http.get('/api/v1/audit-log').query(query).set('Authorization', `Bearer ${token}`);
  /** The same, requiring a 200 that conforms to the contract. */
  const ok = async (token: string, query: Record<string, string | number> = {}): Promise<ListBody> => {
    const res = await get(token, query);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertConformsToContract(res);
    return res.body as ListBody;
  };
  const rule = (res: { body: unknown }) => bodyOf(res).details.fields;

  before(async () => {
    t = await startTestApp();
    try {
      const admin = asUser(t, t.users.admin.token);
      const dev = asUser(t, t.users.developer.token);
      appA = (await createApplication(t, t.users.admin.token)).application.id;
      appB = (await createApplication(t, t.users.admin.token)).application.id;
      varA1 = variableOf(await admin.post('/variables', variableBody(appA, { name: 'gAdminA' }))).id;
      varB1 = variableOf(await dev.post('/variables', variableBody(appB, { name: 'gDevB' }))).id;
      await dev.post('/variables', variableBody(appA, { name: 'gDevA' }));
      // Three rows changed by ONE statement share the instant of the transaction: they tie on createdAt.
      const ids: number[] = [];
      for (const name of ['gTie1', 'gTie2', 'gTie3']) {
        ids.push(variableOf(await admin.post('/variables', variableBody(appA, { name }))).id);
      }
      tied = ids;
      await t.owner.query(`UPDATE variable SET description = 'tied' WHERE id = ANY($1::int[])`, [ids]);
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  describe('access', () => {
    it('401 without a token', async () => {
      assert.equal((await t.http.get('/api/v1/audit-log')).status, 401);
    });
    it('a Reader is 403 from x-roles, even with a malformed request', async () => {
      for (const query of [{}, { entityId: '1' }] as Record<string, string>[]) {
        const res = await get(t.users.reader.token, query);
        assert.equal(res.status, 403);
        assert.equal(bodyOf(res).code, 'FORBIDDEN');
        assert.deepEqual(bodyOf(res).details, { requiredRoles: ['ADMINISTRATOR', 'DEVELOPER'] });
      }
    });
  });

  describe('roles', () => {
    it('the Administrator sees every record, with dbRole', async () => {
      const body = await ok(t.users.admin.token, { pageSize: 100 });
      assert.ok(body.total > 10);
      assert.ok(body.data.every((e) => typeof e.dbRole === 'string'));
      const actors = new Set(body.data.map((e) => e.actor?.id ?? null));
      assert.ok(actors.has(t.users.admin.id) && actors.has(t.users.developer.id) && actors.has(null));
    });
    it('a Developer without actorUserId sees only their own actions, without dbRole', async () => {
      const body = await ok(t.users.developer.token, { pageSize: 100 });
      const own = await t.owner.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE actor_user_id = $1`, [
        t.users.developer.id,
      ]);
      assert.equal(body.total, Number(own.rows[0]!.n));
      assert.ok(body.total >= 2);
      assert.ok(body.data.every((e) => e.actor?.id === t.users.developer.id));
      assert.ok(body.data.every((e) => !('dbRole' in e)));
    });
    it('a Developer with their own id is valid', async () => {
      const mine = await ok(t.users.developer.token, { actorUserId: t.users.developer.id });
      const implicit = await ok(t.users.developer.token);
      assert.equal(mine.total, implicit.total);
    });
    it('a Developer asking for another user is 403 FORBIDDEN with OWN_ACTIONS', async () => {
      for (const actorUserId of [t.users.admin.id, 99_999, 99_999_999_999]) {
        const res = await get(t.users.developer.token, { actorUserId });
        assert.equal(res.status, 403, String(actorUserId));
        assert.equal(bodyOf(res).code, 'FORBIDDEN');
        assert.equal(bodyOf(res).message, "Your role doesn't allow this action.");
        assert.deepEqual(bodyOf(res).details, { reason: 'OWN_ACTIONS' });
      }
    });
    it('the 400 comes before the 403', async () => {
      const bad: Record<string, string | number>[] = [
        { actorUserId: t.users.admin.id, entityId: '1' },
        { actorUserId: t.users.admin.id, from: '2026-11-02T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' },
        { actorUserId: t.users.admin.id, from: '2026-11-02' },
        { actorUserId: t.users.admin.id, action: 'NOPE' },
      ];
      for (const query of bad)
        assert.equal((await get(t.users.developer.token, query)).status, 400, JSON.stringify(query));
    });
    it('the Administrator can filter by any actor', async () => {
      const body = await ok(t.users.admin.token, { actorUserId: t.users.developer.id, pageSize: 100 });
      assert.ok(body.total >= 2);
      assert.ok(body.data.every((e) => e.actor?.id === t.users.developer.id));
    });
  });

  describe('filters', () => {
    it('applicationId', async () => {
      const body = await ok(t.users.admin.token, { applicationId: appB, pageSize: 100 });
      assert.ok(body.total >= 1);
      assert.ok(body.data.every((e) => e.applicationId === appB));
      assert.ok(body.data.some((e) => e.entityType === 'variable' && e.entityId === String(varB1)));
    });
    it('an application that does not exist (or cannot) gives an empty page, not a 404', async () => {
      for (const applicationId of [99_999, 2_147_483_648, 99_999_999_999]) {
        const body = await ok(t.users.admin.token, { applicationId });
        assert.deepEqual(body, { data: [], page: 1, pageSize: 20, total: 0 });
      }
    });
    it('an actor that does not exist gives an empty page for the Administrator', async () => {
      for (const actorUserId of [99_999, 2_147_483_648]) {
        assert.equal((await ok(t.users.admin.token, { actorUserId })).total, 0);
      }
    });
    it('entityType, and entityId with it', async () => {
      const types = await ok(t.users.admin.token, { entityType: 'application', pageSize: 100 });
      assert.ok(types.total >= 2 && types.data.every((e) => e.entityType === 'application'));
      const one = await ok(t.users.admin.token, { entityType: 'variable', entityId: String(varA1) });
      assert.equal(one.total, 1);
      assert.equal(one.data[0]?.entityLabel, 'gAdminA');
      assert.equal((await ok(t.users.admin.token, { entityType: 'screen', entityId: String(varA1) })).total, 0);
    });
    it('action', async () => {
      for (const action of ['CREATE', 'UPDATE']) {
        const body = await ok(t.users.admin.token, { action, pageSize: 100 });
        assert.ok(body.total >= 1 && body.data.every((e) => e.action === action), action);
      }
      assert.equal((await ok(t.users.admin.token, { action: 'DELETE' })).total, 0);
    });
    it('a combination narrows the page and the total together', async () => {
      const body = await ok(t.users.admin.token, {
        applicationId: appA,
        entityType: 'variable',
        action: 'CREATE',
        actorUserId: t.users.developer.id,
      });
      assert.equal(body.total, 1);
      assert.equal(body.data[0]?.entityLabel, 'gDevA');
      assert.equal(
        (await ok(t.users.admin.token, { applicationId: appB, entityType: 'variable', actorUserId: t.users.admin.id }))
          .total,
        0,
      );
    });
    it('a value that looks like SQL is data, not SQL', async () => {
      const body = await ok(t.users.admin.token, { entityType: 'variable', entityId: `1' OR '1'='1` });
      assert.equal(body.total, 0);
    });
  });

  describe('from and to', () => {
    /** One known record and its instant. */
    const target = async () => {
      const [entry] = (await ok(t.users.admin.token, { entityType: 'variable', entityId: String(varA1) })).data;
      assert.ok(entry);
      return { id: entry.id, at: entry.createdAt, ms: Date.parse(entry.createdAt) };
    };
    const iso = (ms: number) => new Date(ms).toISOString();
    const has = (body: ListBody, id: string) => body.data.some((e) => e.id === id);

    it('both limits are inclusive to the millisecond', async () => {
      const { id, at, ms } = await target();
      const q = { entityType: 'variable', entityId: String(varA1) };
      assert.ok(has(await ok(t.users.admin.token, { ...q, from: at }), id), 'from = instant');
      assert.ok(has(await ok(t.users.admin.token, { ...q, to: at }), id), 'to = instant');
      assert.ok(has(await ok(t.users.admin.token, { ...q, from: at, to: at }), id), 'from = to = instant');
      assert.ok(!has(await ok(t.users.admin.token, { ...q, from: iso(ms + 1) }), id), 'from one ms later');
      assert.ok(!has(await ok(t.users.admin.token, { ...q, to: iso(ms - 1) }), id), 'to one ms earlier');
    });
    it('an offset zone is read as an instant', async () => {
      const { id, ms } = await target();
      const q = { entityType: 'variable', entityId: String(varA1) };
      // The same instant written in another zone: the clock text shifted by +2 h, with the zone said.
      const local = `${new Date(ms + 2 * 3_600_000).toISOString().slice(0, 23)}+02:00`;
      assert.ok(has(await ok(t.users.admin.token, { ...q, from: local, to: local }), id));
    });
    it('a date without a time is 400 with rule format', async () => {
      for (const name of ['from', 'to']) {
        const res = await get(t.users.admin.token, { [name]: '2026-11-01' });
        assert.equal(res.status, 400, name);
        assert.equal(rule(res)[0]?.field, name);
        assert.equal(rule(res)[0]?.rule, 'format');
      }
    });
    it('from later than to is 400 with rule range on to; equal is valid', async () => {
      const res = await get(t.users.admin.token, { from: '2026-11-02T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' });
      assert.equal(res.status, 400);
      assert.deepEqual(bodyOf(res).details, {
        fields: [{ field: 'to', rule: 'range', message: "'to' must not be earlier than 'from'." }],
      });
      assert.equal(
        (await get(t.users.admin.token, { from: '2026-11-01T00:00:00Z', to: '2026-11-01T00:00:00Z' })).status,
        200,
      );
    });
    it('a range in the past or in the future is an empty page', async () => {
      assert.equal((await ok(t.users.admin.token, { to: '2000-01-01T00:00:00.000Z' })).total, 0);
      assert.equal((await ok(t.users.admin.token, { from: '2999-01-01T00:00:00.000Z' })).total, 0);
    });
  });

  describe('400 rules', () => {
    it('entityId without entityType: rule required on entityType', async () => {
      const res = await get(t.users.admin.token, { entityId: '12' });
      assert.equal(res.status, 400);
      assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      assert.equal(bodyOf(res).message, 'Check the highlighted fields.');
      assert.deepEqual(bodyOf(res).details, {
        fields: [{ field: 'entityType', rule: 'required', message: 'This value is required.' }],
      });
    });
    it('values outside the contract are 400', async () => {
      const invalid: Record<string, string | number>[] = [
        { entityType: 'nope' },
        { action: 'nope' },
        { applicationId: 0 },
        { actorUserId: 'x' },
        { entityId: 'x'.repeat(51), entityType: 'variable' },
        { pageSize: 101 },
        { page: 0 },
      ];
      for (const query of invalid) {
        assert.equal((await get(t.users.admin.token, query)).status, 400, JSON.stringify(query));
      }
    });
  });

  describe('pagination and order', () => {
    it('pages add up to the whole list, with the same total', async () => {
      const whole = await ok(t.users.admin.token, { pageSize: 100 });
      const seen: string[] = [];
      for (let page = 1; page <= Math.ceil(whole.total / 4); page += 1) {
        const body = await ok(t.users.admin.token, { page, pageSize: 4 });
        assert.equal(body.total, whole.total);
        assert.equal(body.page, page);
        assert.equal(body.pageSize, 4);
        seen.push(...body.data.map((e) => e.id));
      }
      assert.deepEqual(
        seen,
        whole.data.map((e) => e.id),
      );
      const beyond = await ok(t.users.admin.token, { page: 1000 });
      assert.deepEqual(beyond.data, []);
      assert.equal(beyond.total, whole.total);
    });
    it('the default page size is 20', async () => {
      const body = await ok(t.users.admin.token);
      assert.equal(body.pageSize, 20);
      assert.ok(body.data.length <= 20);
    });
    it('newest first: createdAt descending, then id descending', async () => {
      const { data } = await ok(t.users.admin.token, { pageSize: 100 });
      for (let i = 1; i < data.length; i += 1) {
        const a = data[i - 1]!;
        const b = data[i]!;
        const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
        assert.ok(byTime > 0 || (byTime === 0 && BigInt(a.id) > BigInt(b.id)), `${a.id} before ${b.id}`);
      }
    });
    it('rows that tie on createdAt come by id descending', async () => {
      const { data } = await ok(t.users.admin.token, {
        applicationId: appA,
        entityType: 'variable',
        action: 'UPDATE',
        pageSize: 100,
      });
      const group = data.filter((e) => tied.includes(Number(e.entityId)) && e.newValue?.['description'] === 'tied');
      assert.equal(group.length, 3);
      assert.equal(new Set(group.map((e) => e.createdAt)).size, 1, 'one instant');
      const ids = group.map((e) => BigInt(e.id));
      assert.deepEqual(
        [...ids].sort((x, y) => (x < y ? 1 : -1)),
        ids,
      );
    });
  });

  describe('ETag and 304 (D-72)', () => {
    it('two equal reads give the same body and ETag; If-None-Match answers 304 without a body', async () => {
      const q = { applicationId: appA, pageSize: 5 };
      const first = await get(t.users.admin.token, q);
      const second = await get(t.users.admin.token, q);
      assert.equal(first.status, 200);
      assert.deepEqual(first.body, second.body);
      assert.match(String(first.headers.etag), /^W\//);
      assert.equal(first.headers.etag, second.headers.etag);
      const cached = await get(t.users.admin.token, q).set('If-None-Match', String(first.headers.etag));
      assert.equal(cached.status, 304);
      assert.deepEqual(cached.body, {});
    });
    it('a new record changes the ETag', async () => {
      const q = { applicationId: appB };
      const before = await get(t.users.admin.token, q);
      assert.equal(
        (await asUser(t, t.users.admin.token).post('/variables', variableBody(appB, { name: 'gMore' }))).status,
        201,
      );
      const after = await get(t.users.admin.token, q);
      assert.notEqual(before.headers.etag, after.headers.etag);
      const stale = await get(t.users.admin.token, q).set('If-None-Match', String(before.headers.etag));
      assert.equal(stale.status, 200);
    });
  });

  it('never sends two statements at once on one database connection (no pg deprecation notice)', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pgOverlap.stop(), []);
  });
});
