/**
 * Module 7, the recent activity (FR-19; D-106 e, D-34; READER_OVERVIEW). Administrators and Developers receive the 10
 * newest audit records of the application, of any actor, as summaries; Readers receive no `recentActivity` key and the
 * audit query is not even run. The audit service is wrapped by a spy that records each call and the transaction it ran in.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { OperationHandlers } from '../../src/http/operations.js';
import { createAuditModuleService } from '../../src/modules/audit/routes.js';
import type { AuditService } from '../../src/modules/audit/service.js';
import { dashboardHandlers } from '../../src/modules/dashboard/routes.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { getIndicators, indicatorsOk, type ActivityBody } from '../helpers/dashboard.js';
import { insertApplication, insertVariable } from '../helpers/fixtures.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';

const KEYS = ['action', 'actor', 'createdAt', 'entityId', 'entityLabel', 'entityType', 'eventName'];

type SpyCall = { applicationId: number; isolation: string; readOnly: string };

describe('dashboard: the recent activity', () => {
  let t: TestApp;
  const pgOverlap = watchPgOverlap();
  const ref: { handlers?: OperationHandlers } = {};
  const calls: SpyCall[] = [];
  let busy: number;
  let quiet: number;
  let other: number;

  before(async () => {
    t = await startTestApp({
      // The real handler is built once the database exists: the registry only delegates to it.
      handlers: { getIndicators: (req, res, next) => ref.handlers!['getIndicators']!(req, res, next) },
    });
    try {
      const real = createAuditModuleService(t.db);
      const spy: Pick<AuditService, 'recentActivity'> = {
        recentActivity: async (applicationId, client) => {
          assert.ok(client, 'the dashboard passes the client of its transaction');
          const [isolation] = await client.$queryRaw<{ transaction_isolation: string }[]>`SHOW transaction_isolation`;
          const [readOnly] = await client.$queryRaw<{ transaction_read_only: string }[]>`SHOW transaction_read_only`;
          calls.push({
            applicationId,
            isolation: isolation!.transaction_isolation,
            readOnly: readOnly!.transaction_read_only,
          });
          return real.recentActivity(applicationId, client);
        },
      };
      ref.handlers = dashboardHandlers(t.db, { jira: { jiraAvailable: false }, audit: spy });

      busy = (await insertApplication(t)).id;
      quiet = (await insertApplication(t)).id;
      other = (await insertApplication(t)).id;
      // Records of several actors (administrator, developer, none, an inactive user) and of another application.
      for (let i = 1; i <= 4; i += 1) {
        await insertVariable(t, busy, { name: `gBusy${i}` });
        await insertVariable(t, other, { name: `gOther${i}` });
      }
      await describeAs(t.users.admin.id, busy, 'by the administrator');
      await describeAs(t.users.developer.id, busy, 'by the developer');
      await describeAs(t.users.inactive.id, busy, 'by an inactive user');
      await describeAs(t.users.admin.id, other, 'other application');
      await describeAs(t.users.developer.id, busy, 'by the developer again');
      await describeAs(t.users.admin.id, busy, 'the newest');
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  /** Updates an application as the database user `userId` would through the API (what the audit trigger reads). */
  async function describeAs(userId: number, applicationId: number, text: string): Promise<void> {
    await t.owner.query('BEGIN');
    try {
      await t.owner.query(`SELECT set_config('app.user_id', $1, true)`, [String(userId)]);
      await t.owner.query(`UPDATE application SET description = $2 WHERE id = $1`, [applicationId, text]);
      await t.owner.query('COMMIT');
    } catch (error) {
      await t.owner.query('ROLLBACK');
      throw error;
    }
  }

  /** The 10 newest records of an application, straight from the table, in the shape of a summary. */
  async function expectedRecent(applicationId: number): Promise<ActivityBody[]> {
    const r = await t.owner.query<{
      action: string;
      event_name: string | null;
      entity_type: string;
      entity_id: string;
      entity_label: string | null;
      created_at: Date;
      actor_id: number | null;
      actor_name: string | null;
    }>(
      `SELECT a.action, a.event_name, a.entity_type, a.entity_id, a.entity_label, a.created_at,
              u.id AS actor_id, u.name AS actor_name
         FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_user_id
        WHERE a.application_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT 10`,
      [applicationId],
    );
    return r.rows.map((row) => ({
      actor: row.actor_id === null ? null : { id: row.actor_id, name: row.actor_name! },
      action: row.action,
      eventName: row.event_name,
      entityType: row.entity_type,
      entityId: row.entity_id,
      entityLabel: row.entity_label,
      createdAt: row.created_at.toISOString(),
    }));
  }

  for (const [role, token] of [
    ['Administrator', () => t.users.admin.token],
    ['Developer', () => t.users.developer.token],
  ] as const) {
    describe(role, () => {
      it('receives exactly the 10 most recent records of the application, of any actor', async () => {
        const { recentActivity } = await indicatorsOk(t, busy, token());
        const expected = await expectedRecent(busy);
        assert.equal(expected.length, 10);
        assert.deepEqual(recentActivity, expected);
        const actors = new Set(recentActivity.map((r) => r.actor?.id ?? null));
        assert.ok(actors.has(t.users.admin.id) && actors.has(t.users.developer.id), 'the whole team, not the caller');
        assert.equal(recentActivity[0]!.entityType, 'application');
      });

      it('each record is a summary: no oldValue, newValue, dbRole or anything else', async () => {
        const { recentActivity } = await indicatorsOk(t, busy, token());
        for (const record of recentActivity!) {
          assert.deepEqual(Object.keys(record).sort(), KEYS);
          assert.match(record.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        }
      });

      it('never holds a record of another application', async () => {
        const { recentActivity } = await indicatorsOk(t, busy, token());
        const labels = recentActivity!.map((r) => r.entityLabel);
        assert.ok(!labels.some((label) => label?.startsWith('gOther')));
        const otherIds = (
          await t.owner.query<{ id: number }>('SELECT id FROM variable WHERE application_id = $1', [other])
        ).rows;
        const seen = new Set(recentActivity!.filter((r) => r.entityType === 'variable').map((r) => r.entityId));
        for (const row of otherIds) assert.ok(!seen.has(String(row.id)));
      });

      it('an application with few records gets all of them (here: its own creation), as an array', async () => {
        const { recentActivity } = await indicatorsOk(t, quiet, token());
        assert.ok(Array.isArray(recentActivity));
        assert.deepEqual(recentActivity, await expectedRecent(quiet));
      });

      it('the audit read runs in the read-only REPEATABLE READ transaction of the dashboard', async () => {
        const before = calls.length;
        await indicatorsOk(t, busy, token());
        assert.equal(calls.length, before + 1);
        const last = calls.at(-1)!;
        assert.deepEqual(last, { applicationId: busy, isolation: 'repeatable read', readOnly: 'on' });
      });
    });
  }

  describe('Reader', () => {
    it('the recentActivity key does not exist: absent, not null and not an empty array', async () => {
      const res = await getIndicators(t, busy, t.users.reader.token);
      assert.equal(res.status, 200);
      const data = (res.body as { data: Record<string, unknown> }).data;
      assert.ok(!('recentActivity' in data));
      assert.ok(!res.text.includes('recentActivity'));
      assert.deepEqual(Object.keys(data).sort(), ['collections', 'documentation', 'jira', 'variables']);
    });

    it('the audit query is not run for a Reader (spy), and conforms to the contract', async () => {
      const before = calls.length;
      await indicatorsOk(t, busy, t.users.reader.token);
      await indicatorsOk(t, quiet, t.users.reader.token);
      assert.equal(calls.length, before, 'recentActivity was not called');
      await indicatorsOk(t, busy, t.users.admin.token);
      assert.equal(calls.length, before + 1, 'and the spy does see the calls it should');
    });

    it('the figures are the same as the Administrator sees', async () => {
      const { recentActivity: _a, ...admin } = await indicatorsOk(t, busy, t.users.admin.token);
      const reader = await indicatorsOk(t, busy, t.users.reader.token);
      assert.deepEqual(reader, admin);
    });
  });

  it('an application that does not exist is 404 and no activity is read', async () => {
    const before = calls.length;
    const res = await getIndicators(t, 999999);
    assert.equal(res.status, 404);
    assert.equal(calls.length, before);
  });
});
