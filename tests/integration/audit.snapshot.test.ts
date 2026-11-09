/**
 * Module 8, one snapshot per list (FR-21): the total and the page are read in the same REPEATABLE READ transaction, so
 * a record written by another connection between the two statements is in neither. The repository takes an optional
 * callback that production never passes; here it commits an audited write with the owner connection after the total
 * was read and before the page is. Without REPEATABLE READ the page would hold a record that the total does not count.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { createApplication } from '../helpers/applications.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { createAuditModuleService } from '../../src/modules/audit/routes.js';
import { asUser } from '../helpers/users.js';
import { createBodyOf as variableBody } from '../helpers/variables.js';

describe('audit: one snapshot per read', () => {
  let t: TestApp;
  const pgOverlap = watchPgOverlap();
  let applicationId: number;
  const admin = { id: 0, role: 'ADMINISTRATOR' };

  before(async () => {
    t = await startTestApp();
    try {
      admin.id = t.users.admin.id;
      applicationId = (await createApplication(t, t.users.admin.token)).application.id;
      for (const name of ['gSnap1', 'gSnap2']) {
        await asUser(t, t.users.admin.token).post('/variables', variableBody(applicationId, { name }));
      }
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  /** An audit service whose repository runs `change` once, inside the snapshot, between the total and the page. */
  const serviceWith = (change: () => Promise<unknown>) => {
    let done = false;
    return createAuditModuleService(t.db, {
      afterCount: async () => {
        if (done) return;
        done = true;
        await change();
      },
    });
  };
  const write = (label: string) => () =>
    t.owner.query(`UPDATE application SET description = $2 WHERE id = $1`, [applicationId, label]);

  it('a record committed by another connection between the total and the page is in neither', async () => {
    const plain = createAuditModuleService(t.db);
    const before = await plain.list(admin, { applicationId, skip: 0, take: 100 });
    assert.equal(before.data.length, before.total);

    const racing = await serviceWith(write('written in the middle')).list(admin, { applicationId, skip: 0, take: 100 });
    assert.equal(racing.total, before.total, 'the total is from the snapshot');
    assert.equal(racing.data.length, racing.total, 'and so is the page');
    assert.ok(!racing.data.some((e) => e.newValue?.['description'] === 'written in the middle'));

    // The next read, a new snapshot, sees the committed record.
    const next = await plain.list(admin, { applicationId, skip: 0, take: 100 });
    assert.equal(next.total, before.total + 1);
    assert.equal(next.data.length, next.total);
    assert.equal(next.data[0]?.newValue?.['description'], 'written in the middle');
  });

  it('the same holds for a page in the middle of the list', async () => {
    const plain = createAuditModuleService(t.db);
    const total = (await plain.list(admin, { applicationId, skip: 0, take: 1 })).total;
    const expected = (await plain.list(admin, { applicationId, skip: 1, take: 2 })).data.map((e) => e.id);
    const racing = await serviceWith(write('written while paging')).list(admin, { applicationId, skip: 1, take: 2 });
    assert.equal(racing.total, total);
    assert.deepEqual(
      racing.data.map((e) => e.id),
      expected,
      'the page does not shift under the reader',
    );
    assert.ok(!racing.data.some((e) => e.newValue?.['description'] === 'written while paging'));
    assert.equal((await plain.list(admin, { applicationId, skip: 0, take: 1 })).total, total + 1);
  });

  it('the recent activity read inside a snapshot of the caller does not see a later commit', async () => {
    const service = createAuditModuleService(t.db);
    const { Prisma } = await import('../../src/generated/prisma/client.js');
    const seen = await t.db.base.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const first = await service.recentActivity(applicationId, tx);
        await write('written inside the caller snapshot')();
        const second = await service.recentActivity(applicationId, tx);
        return { first, second };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    assert.deepEqual(seen.second, seen.first);
    const after = await service.recentActivity(applicationId);
    assert.notDeepEqual(after, seen.first);
  });

  it('never sends two statements at once on one database connection (no pg deprecation notice)', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pgOverlap.stop(), []);
  });
});
