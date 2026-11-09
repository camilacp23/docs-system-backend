/**
 * `assertApplicationActive` (CP-01, D-47) used the way the other modules will: inside an `auditedTransaction`.
 * Nothing exposes the guard over HTTP yet, so it is called through the service object, as D-42 requires.
 * The race with an archiving is deterministic: one side holds its lock until the other is seen waiting.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { applicationOf, createApplication, putBodyOf } from '../helpers/applications.js';
import { auditContext } from '../../src/db/prisma.js';
import { createApplicationService } from '../../src/modules/applications/service.js';
import { ApiError } from '../../src/security/errors.js';
import { asUser } from '../helpers/users.js';

describe('assertApplicationActive', () => {
  let t: TestApp;
  let admin: ReturnType<typeof asUser>;
  let guard: ReturnType<typeof createApplicationService>['assertApplicationActive'];

  before(async () => {
    t = await startTestApp();
    admin = asUser(t, t.users.admin.token);
    guard = createApplicationService(t.db).assertApplicationActive;
  });
  after(async () => {
    await t.close();
  });

  /** Runs `fn` in an audited transaction, as a service of another module would. */
  const inTransaction = <T>(fn: (tx: Parameters<Parameters<typeof t.db.auditedTransaction>[0]>[0]) => Promise<T>) =>
    auditContext.run({ userId: t.users.admin.id }, () => t.db.auditedTransaction(fn));

  const archive = async (id: number) => {
    const current = applicationOf(await admin.get(`/applications/${id}`));
    return admin.put(`/applications/${id}`, putBodyOf(current, { status: 'ARCHIVED' }));
  };

  it('lets an active application through', async () => {
    const { application } = await createApplication(t, t.users.admin.token);
    await inTransaction((tx) => guard(tx, application.id));
  });

  it('422 APPLICATION_ARCHIVED with details.applicationId for an archived one, and ACTIVE again after unarchiving', async () => {
    const { application } = await createApplication(t, t.users.admin.token);
    const archived = await archive(application.id);
    assert.equal(archived.status, 200);
    await assert.rejects(
      inTransaction((tx) => guard(tx, application.id)),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 422);
        assert.equal(error.code, 'APPLICATION_ARCHIVED');
        assert.equal(error.message, "This application is archived, so its documentation can't be changed.");
        assert.deepEqual(error.details, { applicationId: application.id });
        return true;
      },
    );
    const restored = await admin.put(
      `/applications/${application.id}`,
      putBodyOf(applicationOf(archived), { status: 'ACTIVE' }),
    );
    assert.equal(restored.status, 200);
    await inTransaction((tx) => guard(tx, application.id));
  });

  it('404 NOT_FOUND for a missing application and for an id above the integer range', async () => {
    for (const id of [999_999, 2_147_483_648]) {
      await assert.rejects(
        inTransaction((tx) => guard(tx, id)),
        (error: unknown) => error instanceof ApiError && error.status === 404 && error.code === 'NOT_FOUND',
        String(id),
      );
    }
  });

  it('an archiving committed meanwhile is seen: the guard waits for the lock and then answers 422', async () => {
    const { application } = await createApplication(t, t.users.admin.token);
    await t.owner.query('BEGIN');
    try {
      await t.owner.query(`UPDATE application SET status = 'ARCHIVED' WHERE id = $1`, [application.id]);
      let wrote = false;
      let settled = false;
      const pending = inTransaction(async (tx) => {
        await guard(tx, application.id);
        wrote = true; // the protected write would go here
      }).finally(() => {
        settled = true;
      });
      pending.catch(() => undefined);
      await sleep(600);
      assert.equal(settled, false, 'the guard must wait for the archiving in progress');
      await t.owner.query('COMMIT');
      await assert.rejects(
        pending,
        (error: unknown) => error instanceof ApiError && error.code === 'APPLICATION_ARCHIVED',
      );
      assert.equal(wrote, false);
    } catch (error) {
      await t.owner.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });

  it('a write that already passed the guard keeps the archiving waiting until it commits', async () => {
    const { application } = await createApplication(t, t.users.admin.token);
    const events: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let passed!: () => void;
    const guardPassed = new Promise<void>((resolve) => (passed = resolve));

    const writer = inTransaction(async (tx) => {
      await guard(tx, application.id);
      passed();
      await released; // the protected write is in progress
      events.push('write committed');
    });
    await guardPassed;

    let settled = false;
    const archiving = archive(application.id).then((res) => {
      settled = true;
      events.push('archived');
      return res;
    });
    await sleep(600);
    assert.equal(settled, false, 'the archiving must wait for the writer holding the SHARE lock');
    release();
    await writer;
    const res = await archiving;
    assert.equal(res.status, 200);
    assert.deepEqual(events, ['write committed', 'archived']);
    assert.equal(applicationOf(await admin.get(`/applications/${application.id}`)).status, 'ARCHIVED');
  });
});
