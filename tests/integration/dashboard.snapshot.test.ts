/**
 * Module 7, one snapshot per read (FR-19): the figures and the recent activity come from the same REPEATABLE READ
 * transaction, so a write committed by another connection between the two statements is in neither. The repository
 * takes an optional callback that production never passes; here it commits a screen (audited by the trigger) with the
 * owner connection after the indicators were read and before the activity is. Without REPEATABLE READ the activity
 * would hold the record of a screen that the figures do not count.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createAuditModuleService } from '../../src/modules/audit/routes.js';
import { createDashboardRepository } from '../../src/modules/dashboard/repository.js';
import { createDashboardService } from '../../src/modules/dashboard/service.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication, insertScreen } from '../helpers/fixtures.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';

describe('dashboard: one snapshot per read', () => {
  let t: TestApp;
  const pgOverlap = watchPgOverlap();
  let applicationId: number;
  const admin = { id: 0, role: 'ADMINISTRATOR' };

  before(async () => {
    t = await startTestApp();
    try {
      admin.id = t.users.admin.id;
      applicationId = (await insertApplication(t)).id;
      await insertScreen(t, applicationId, { documentationStatus: 'APPROVED' });
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  const audit = () => createAuditModuleService(t.db);
  const jira = { jiraAvailable: true };
  const plain = () => createDashboardService(createDashboardRepository(t.db), audit(), jira);
  /** A service whose repository runs `change` once, inside the snapshot, between the indicators and the activity. */
  const racing = (change: () => Promise<unknown>) => {
    let done = false;
    return createDashboardService(
      createDashboardRepository(t.db, {
        afterIndicators: async () => {
          if (done) return;
          done = true;
          await change();
        },
      }),
      audit(),
      jira,
    );
  };

  /** The ids of the screens that the activity reports as created. */
  const createdScreens = (data: Awaited<ReturnType<ReturnType<typeof plain>['indicators']>>) =>
    (data.recentActivity ?? [])
      .map((r) => r as { action: string; entityType: string; entityId: string })
      .filter((r) => r.entityType === 'screen' && r.action === 'CREATE')
      .map((r) => Number(r.entityId));

  it('a screen committed between the figures and the activity is in neither', async () => {
    const before = await plain().indicators(admin, applicationId);
    const racingId = { value: 0 };
    const during = await racing(async () => {
      racingId.value = (await insertScreen(t, applicationId, { documentationStatus: 'APPROVED' })).id;
    }).indicators(admin, applicationId);

    assert.notEqual(racingId.value, 0, 'the write was committed in the middle of the read');
    assert.deepEqual(during.documentation, before.documentation, 'the figures are those of the snapshot');
    assert.ok(!createdScreens(during).includes(racingId.value), 'and the activity does not show the new screen');
    assert.deepEqual(during.recentActivity, before.recentActivity, 'the activity is the one of before the write');

    // The next read is a new snapshot and sees the committed screen in both.
    const next = await plain().indicators(admin, applicationId);
    assert.equal(next.documentation.totalScreens, before.documentation.totalScreens + 1);
    assert.equal(next.documentation.byStatus.APPROVED, before.documentation.byStatus.APPROVED + 1);
    assert.ok(createdScreens(next).includes(racingId.value));
  });

  it('the figures and the activity agree: every screen the activity shows is counted in the figures', async () => {
    const result = await racing(() => insertScreen(t, applicationId)).indicators(admin, applicationId);
    const shown = createdScreens(result).length;
    // App (OnStart) is created with the application, and its record is in the activity too.
    assert.ok(shown <= result.documentation.totalScreens);
    const counted = (
      await t.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE application_id = $1 AND entity_type = 'screen' AND action = 'CREATE'`,
        [applicationId],
      )
    ).rows[0]!.n;
    // One more screen was created in the middle: the audit table has it, the snapshot does not.
    assert.equal(counted, result.documentation.totalScreens + 1);
  });

  it('a Reader reads one statement in the snapshot and gets the same figures', async () => {
    const reader = { id: t.users.reader.id, role: 'READER' };
    const during = await racing(() => insertScreen(t, applicationId)).indicators(reader, applicationId);
    const after = await plain().indicators(reader, applicationId);
    assert.equal(after.documentation.totalScreens, during.documentation.totalScreens + 1);
    assert.ok(!('recentActivity' in during));
  });
});
