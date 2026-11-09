/**
 * Recent activity of an application (FR-19; the audit service function the dashboard will use): the 10 newest records
 * of the application, of any actor, in the shape of `ActivitySummary` and nothing else, never from another application,
 * with the actor resolved like in the list. Read inside a transaction passed by the caller, or in one of its own.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { createApplication } from '../helpers/applications.js';
import { prepareAuthUsers } from '../helpers/auth.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import { RECENT_ACTIVITY_LIMIT } from '../../src/modules/audit/repository.js';
import { createAuditModuleService } from '../../src/modules/audit/routes.js';
import { asUser } from '../helpers/users.js';
import { createBodyOf as variableBody } from '../helpers/variables.js';

const KEYS = ['action', 'actor', 'createdAt', 'entityId', 'entityLabel', 'entityType', 'eventName'];

describe('audit: recent activity of an application', () => {
  let t: TestApp;
  const pgOverlap = watchPgOverlap();
  let busy: number;
  let quiet: number;
  let other: number;
  let reservedId: number;

  /** Runs `sql` as the database user `userId` would through the API (the setting the audit trigger reads). */
  const writeAs = async (userId: number, sql: string, params: unknown[]) => {
    await t.owner.query('BEGIN');
    try {
      await t.owner.query(`SELECT set_config('app.user_id', $1, true)`, [String(userId)]);
      await t.owner.query(sql, params);
      await t.owner.query('COMMIT');
    } catch (error) {
      await t.owner.query('ROLLBACK');
      throw error;
    }
  };
  const describeApp = (applicationId: number, text: string, userId: number) =>
    writeAs(userId, `UPDATE application SET description = $2 WHERE id = $1`, [applicationId, text]);

  before(async () => {
    t = await startTestApp();
    try {
      await prepareAuthUsers(t);
      reservedId = (
        await t.owner.query<{ id: number }>('SELECT id FROM app_user WHERE email = $1', [t.config.integrationUserEmail])
      ).rows[0]!.id;
      busy = (await createApplication(t, t.users.admin.token)).application.id;
      quiet = (await createApplication(t, t.users.admin.token)).application.id;
      other = (await createApplication(t, t.users.admin.token)).application.id;
      const admin = asUser(t, t.users.admin.token);
      const dev = asUser(t, t.users.developer.token);
      // More than ten records in `busy`, from the API (admin, developer), the owner without a user, an inactive user
      // and the reserved account; and records in `other` that must never show.
      for (let i = 1; i <= 4; i += 1) {
        await admin.post('/variables', variableBody(busy, { name: `gAdmin${i}` }));
        await dev.post('/variables', variableBody(busy, { name: `gDev${i}` }));
        await admin.post('/variables', variableBody(other, { name: `gOther${i}` }));
      }
      await t.owner.query(`UPDATE application SET description = 'no actor' WHERE id = $1`, [busy]);
      await describeApp(busy, 'inactive', t.users.inactive.id);
      await describeApp(busy, 'integration', reservedId);
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  const service = () => createAuditModuleService(t.db);
  const adminCaller = () => ({ id: t.users.admin.id, role: 'ADMINISTRATOR' });

  it('the limit is a named constant of 10', () => {
    assert.equal(RECENT_ACTIVITY_LIMIT, 10);
  });

  it('returns the 10 newest records of the application, of any actor, in the order of the list', async () => {
    const recent = await service().recentActivity(busy);
    assert.equal(recent.length, 10);
    const full = await service().list(adminCaller(), { applicationId: busy, skip: 0, take: 100 });
    assert.ok(full.total > 10);
    assert.deepEqual(
      recent,
      full.data.slice(0, 10).map((e) => ({
        actor: e.actor,
        action: e.action,
        eventName: e.eventName,
        entityType: e.entityType,
        entityId: e.entityId,
        entityLabel: e.entityLabel,
        createdAt: e.createdAt,
      })),
    );
    const actors = new Set(recent.map((r) => r.actor?.id ?? null));
    assert.ok(actors.has(reservedId) && actors.has(t.users.inactive.id) && actors.has(null), [...actors].join());
  });

  it('is a summary: exactly the keys of ActivitySummary, never values or the database role', async () => {
    const recent = await service().recentActivity(busy);
    for (const record of recent) {
      assert.deepEqual(Object.keys(record).sort(), KEYS);
      assert.match(record.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.ok(['CREATE', 'UPDATE', 'DELETE', 'EVENT'].includes(record.action));
    }
    const text = JSON.stringify(recent);
    for (const forbidden of ['oldValue', 'newValue', 'dbRole', 'docs_app', 'docs_owner', 'changedFields']) {
      assert.ok(!text.includes(forbidden), forbidden);
    }
  });

  it('resolves the actor like the list: the reserved account, an inactive user, and null outside the API', async () => {
    const [first, second, third] = await service().recentActivity(busy);
    assert.deepEqual(first?.actor, { id: reservedId, name: 'Integración Jira' });
    assert.deepEqual(second?.actor, { id: t.users.inactive.id, name: 'Ina Ctive' });
    assert.equal(third?.actor, null);
  });

  it('holds nothing of another application', async () => {
    const mine = await service().recentActivity(busy);
    assert.ok(!mine.some((r) => r.entityLabel?.startsWith('gOther')));
    const theirs = await service().recentActivity(other);
    assert.ok(theirs.length > 0);
    assert.ok(theirs.every((r) => !r.entityLabel?.startsWith('gAdmin') && !r.entityLabel?.startsWith('gDev')));
    assert.ok(theirs.some((r) => r.entityLabel?.startsWith('gOther')));
  });

  it('is not filtered by actor: the whole team is returned', async () => {
    const actors = new Set((await service().recentActivity(busy)).map((r) => r.actor?.id));
    assert.ok(actors.size > 1);
  });

  it('has fewer than 10 when there are fewer, and none for an unknown application', async () => {
    assert.ok((await service().recentActivity(quiet)).length < 10);
    assert.deepEqual(await service().recentActivity(99_999), []);
    assert.deepEqual(await service().recentActivity(2_147_483_648), []);
  });

  it('runs inside the transaction passed by the caller', async () => {
    const result = await t.db.base.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const a = await service().recentActivity(busy, tx);
        const b = await service().recentActivity(busy, tx);
        return { a, b };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    assert.equal(result.a.length, 10);
    assert.deepEqual(result.b, result.a);
  });

  it('never sends two statements at once on one database connection (no pg deprecation notice)', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pgOverlap.stop(), []);
  });
});
