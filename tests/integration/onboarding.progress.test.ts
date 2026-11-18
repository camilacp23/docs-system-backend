/**
 * Module 11, the progress of the user in the onboarding (FR-25; D-133) through HTTP on disposable data: the three
 * operations for the three roles, that the progress is personal and belongs to one application, idempotence (also with
 * requests at the same time), the 400, 401 and 404 answers, the archived application, the ETag and the 304, that
 * nothing is written to the audit log, the CHECK and the foreign keys of the table, and the contract.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bearer, bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { insertApplication, setApplicationStatus } from '../helpers/fixtures.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { asUser } from '../helpers/users.js';

/** `data` of the progress responses. */
type ProgressBody = { applicationId: number; totalSteps: number; completedSteps: number[] };

const dataOf = (res: { body: unknown }): ProgressBody => (res.body as { data: ProgressBody }).data;

describe('onboarding: the progress of the user', () => {
  let t: TestApp;
  const pgOverlap = watchPgOverlap();

  before(async () => {
    t = await startTestApp();
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  const as = (token: string) => asUser(t, token);
  const get = (applicationId: number | string, token = t.users.admin.token) =>
    as(token).get(`/onboarding/progress?applicationId=${applicationId}`);
  const complete = (applicationId: number | string, step: number | string, token = t.users.admin.token) =>
    as(token).put(`/onboarding/progress/steps/${step}?applicationId=${applicationId}`, {});
  const reset = (applicationId: number | string, token = t.users.admin.token) =>
    as(token).delete(`/onboarding/progress?applicationId=${applicationId}`);

  /** A call that must answer 200 and conform to the contract; returns `data`. */
  const ok = async (res: Awaited<ReturnType<typeof get>>): Promise<ProgressBody> => {
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertConformsToContract(res);
    return dataOf(res);
  };

  /** A fresh application, so every test starts from an empty progress. */
  const freshApplication = async (status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE') => {
    const app = await insertApplication(t, { status });
    return app.id;
  };

  const rowsOf = async (applicationId: number, userId?: number) =>
    (
      await t.owner.query<{ user_id: number; step: number; completed_at: Date }>(
        `SELECT user_id, step, completed_at FROM onboarding_progress
          WHERE application_id = $1 AND ($2::int IS NULL OR user_id = $2) ORDER BY user_id, step`,
        [applicationId, userId ?? null],
      )
    ).rows;

  describe('reading', () => {
    it('is empty for a user who completed nothing, with the total of steps', async () => {
      const applicationId = await freshApplication();
      assert.deepEqual(await ok(await get(applicationId)), { applicationId, totalSteps: 5, completedSteps: [] });
    });

    it('is the same operation for the three roles', async () => {
      const applicationId = await freshApplication();
      for (const token of [t.users.admin.token, t.users.developer.token, t.users.reader.token]) {
        assert.deepEqual((await ok(await get(applicationId, token))).completedSteps, []);
      }
    });

    it('has an ETag and answers 304 while nothing changes, and a new ETag after a change', async () => {
      const applicationId = await freshApplication();
      await complete(applicationId, 2);
      const first = await get(applicationId);
      const etag = first.headers.etag as string;
      assert.ok(etag, 'has an ETag');
      const again = await as(t.users.admin.token)
        .get(`/onboarding/progress?applicationId=${applicationId}`)
        .set('If-None-Match', etag);
      assert.equal(again.status, 304);
      await complete(applicationId, 3);
      const changed = await get(applicationId);
      assert.notEqual(changed.headers.etag, etag);
    });
  });

  describe('completing a step', () => {
    it('answers 200 with the whole progress, conforming to the contract', async () => {
      const applicationId = await freshApplication();
      const res = await complete(applicationId, 1);
      assert.deepEqual(await ok(res), { applicationId, totalSteps: 5, completedSteps: [1] });
    });

    it('lists the steps ascending whatever the order in which they were completed', async () => {
      const applicationId = await freshApplication();
      for (const step of [4, 1, 5, 2]) await complete(applicationId, step);
      assert.deepEqual((await ok(await get(applicationId))).completedSteps, [1, 2, 4, 5]);
    });

    it('is idempotent: repeating a step is the same 200 and keeps its first completed_at', async () => {
      const applicationId = await freshApplication();
      const first = await ok(await complete(applicationId, 3));
      const before = await rowsOf(applicationId);
      const second = await ok(await complete(applicationId, 3));
      assert.deepEqual(second, first);
      const after = await rowsOf(applicationId);
      assert.equal(after.length, 1);
      assert.equal(after[0]!.completed_at.getTime(), before[0]!.completed_at.getTime());
    });

    it('is idempotent with requests at the same time: every one answers 200 and there is one row', async () => {
      const applicationId = await freshApplication();
      const responses = await Promise.all(Array.from({ length: 12 }, () => complete(applicationId, 2)));
      for (const res of responses) assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(await rowsOf(applicationId), [
        { user_id: t.users.admin.id, step: 2, completed_at: (await rowsOf(applicationId))[0]!.completed_at },
      ]);
    });

    it('lets a Reader and a Developer keep their own progress too', async () => {
      const applicationId = await freshApplication();
      assert.deepEqual((await ok(await complete(applicationId, 1, t.users.reader.token))).completedSteps, [1]);
      assert.deepEqual((await ok(await complete(applicationId, 2, t.users.developer.token))).completedSteps, [2]);
    });
  });

  describe('it is personal and belongs to one application', () => {
    it('a user never sees or changes the progress of another', async () => {
      const applicationId = await freshApplication();
      await complete(applicationId, 1, t.users.admin.token);
      await complete(applicationId, 2, t.users.developer.token);
      await complete(applicationId, 3, t.users.developer.token);
      assert.deepEqual((await ok(await get(applicationId, t.users.admin.token))).completedSteps, [1]);
      assert.deepEqual((await ok(await get(applicationId, t.users.developer.token))).completedSteps, [2, 3]);
      assert.deepEqual((await ok(await get(applicationId, t.users.reader.token))).completedSteps, []);
    });

    it('resetting removes only the progress of the user who asks', async () => {
      const applicationId = await freshApplication();
      await complete(applicationId, 1, t.users.admin.token);
      await complete(applicationId, 4, t.users.developer.token);
      assert.equal((await reset(applicationId, t.users.admin.token)).status, 204);
      assert.deepEqual((await ok(await get(applicationId, t.users.admin.token))).completedSteps, []);
      assert.deepEqual((await ok(await get(applicationId, t.users.developer.token))).completedSteps, [4]);
    });

    it('the progress of one application does not leak into another', async () => {
      const one = await freshApplication();
      const other = await freshApplication();
      await complete(one, 1);
      await complete(one, 2);
      await complete(other, 5);
      assert.deepEqual((await ok(await get(one))).completedSteps, [1, 2]);
      assert.deepEqual((await ok(await get(other))).completedSteps, [5]);
      assert.equal((await reset(one)).status, 204);
      assert.deepEqual((await ok(await get(other))).completedSteps, [5]);
    });

    it('the user comes from the token: the request has no way to name another user', async () => {
      const applicationId = await freshApplication();
      const res = await as(t.users.developer.token).put(
        `/onboarding/progress/steps/1?applicationId=${applicationId}&userId=${t.users.admin.id}`,
        { userId: t.users.admin.id },
      );
      // The contract does not know a `userId`: it is either ignored (200) or rejected (400); it is never obeyed.
      assert.ok([200, 400].includes(res.status), String(res.status));
      assert.deepEqual(await rowsOf(applicationId, t.users.admin.id), []);
      const mine = (await rowsOf(applicationId, t.users.developer.id)).map((row) => row.step);
      assert.deepEqual(mine, res.status === 200 ? [1] : []);
    });
  });

  describe('resetting', () => {
    it('answers 204 with no body, the steps are gone, and repeating it is 204 too', async () => {
      const applicationId = await freshApplication();
      await complete(applicationId, 1);
      await complete(applicationId, 2);
      const res = await reset(applicationId);
      assert.equal(res.status, 204);
      assert.equal(res.text, '');
      await assertConformsToContract({ status: 204, body: undefined, request: res.request });
      assert.deepEqual((await ok(await get(applicationId))).completedSteps, []);
      assert.equal((await reset(applicationId)).status, 204);
    });

    it('lets the user start again after a reset', async () => {
      const applicationId = await freshApplication();
      await complete(applicationId, 5);
      await reset(applicationId);
      assert.deepEqual((await ok(await complete(applicationId, 1))).completedSteps, [1]);
    });
  });

  describe('an archived application', () => {
    it('accepts reading, completing and resetting: the progress is not documentation (D-47)', async () => {
      const applicationId = await freshApplication();
      await complete(applicationId, 1);
      await setApplicationStatus(t, applicationId, 'ARCHIVED');
      assert.deepEqual((await ok(await get(applicationId))).completedSteps, [1]);
      assert.deepEqual((await ok(await complete(applicationId, 2))).completedSteps, [1, 2]);
      assert.equal((await reset(applicationId)).status, 204);
      assert.deepEqual((await ok(await get(applicationId))).completedSteps, []);
    });
  });

  describe('errors', () => {
    it('401 without a token, on the three operations', async () => {
      const applicationId = await freshApplication();
      const calls = [
        () => t.http.get(`/api/v1/onboarding/progress?applicationId=${applicationId}`),
        () => t.http.put(`/api/v1/onboarding/progress/steps/1?applicationId=${applicationId}`),
        () => t.http.delete(`/api/v1/onboarding/progress?applicationId=${applicationId}`),
      ];
      for (const call of calls) {
        const res = await call();
        assert.equal(res.status, 401);
        assert.equal(bodyOf(res).code, 'UNAUTHENTICATED');
      }
    });

    it('401 for a user who was deactivated, at the very next request', async () => {
      const applicationId = await freshApplication();
      const res = await t.http
        .get(`/api/v1/onboarding/progress?applicationId=${applicationId}`)
        .set('Authorization', bearer(t.users.inactive.token));
      assert.equal(res.status, 401);
    });

    it('400 for a step outside 1 to 5 or that is not a whole number, and nothing is written', async () => {
      const applicationId = await freshApplication();
      for (const step of ['0', '6', '-1', '1.5', 'abc', '99999999999']) {
        const res = await complete(applicationId, step);
        assert.equal(res.status, 400, `step ${step}: ${res.status}`);
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      }
      assert.deepEqual(await rowsOf(applicationId), []);
    });

    it('400 for a missing or malformed applicationId, on the three operations', async () => {
      const bad = ['', '?applicationId=0', '?applicationId=-3', '?applicationId=abc', '?applicationId=1.5'];
      for (const query of bad) {
        for (const res of [
          await as(t.users.admin.token).get(`/onboarding/progress${query}`),
          await as(t.users.admin.token).put(`/onboarding/progress/steps/1${query}`, {}),
          await as(t.users.admin.token).delete(`/onboarding/progress${query}`),
        ]) {
          assert.equal(res.status, 400, `${query || '(none)'}: ${res.status}`);
          assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
        }
      }
    });

    it('404 for an application that does not exist (or is outside the integer range), on the three operations', async () => {
      for (const id of [999_999, 2_147_483_647, 2_147_483_648]) {
        for (const res of [await get(id), await complete(id, 1), await reset(id)]) {
          assert.equal(res.status, 404, `application ${id}: ${res.status}`);
          assert.equal(bodyOf(res).code, 'NOT_FOUND');
          await assertConformsToContract(res);
        }
      }
      assert.deepEqual(
        (await t.owner.query(`SELECT 1 FROM onboarding_progress WHERE application_id = 999999`)).rows,
        [],
      );
    });

    it('answers every error with the X-Request-Id header and no internal detail', async () => {
      const res = await complete(999_999, 1);
      assert.ok(res.headers['x-request-id']);
      assert.ok(!JSON.stringify(res.body).includes('onboarding_progress'));
    });
  });

  describe('the audit log and the table', () => {
    it('writes nothing to the audit log: the progress is not documentation (D-133)', async () => {
      const applicationId = await freshApplication();
      const count = async () =>
        Number((await t.owner.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log`)).rows[0]!.n);
      const before = await count();
      await complete(applicationId, 1);
      await complete(applicationId, 2);
      await reset(applicationId);
      assert.equal(await count(), before);
    });

    it('the step is limited to 1 to 5 by the database too', async () => {
      const applicationId = await freshApplication();
      for (const step of [0, 6, -1]) {
        await assert.rejects(
          t.owner.query(`INSERT INTO onboarding_progress (user_id, application_id, step) VALUES ($1, $2, $3)`, [
            t.users.admin.id,
            applicationId,
            step,
          ]),
          /onboarding_progress_step_chk/,
          `step ${step}`,
        );
      }
    });

    it('a step is stored once per user, application and step (primary key)', async () => {
      const applicationId = await freshApplication();
      const insert = () =>
        t.owner.query(`INSERT INTO onboarding_progress (user_id, application_id, step) VALUES ($1, $2, 1)`, [
          t.users.admin.id,
          applicationId,
        ]);
      await insert();
      await assert.rejects(insert(), /onboarding_progress_pkey/);
    });

    it('rejects a user or an application that does not exist (foreign keys)', async () => {
      const applicationId = await freshApplication();
      await assert.rejects(
        t.owner.query(`INSERT INTO onboarding_progress (user_id, application_id, step) VALUES (999999, $1, 1)`, [
          applicationId,
        ]),
        /onboarding_progress_user_id_fkey/,
      );
      await assert.rejects(
        t.owner.query(`INSERT INTO onboarding_progress (user_id, application_id, step) VALUES ($1, 999999, 1)`, [
          t.users.admin.id,
        ]),
        /onboarding_progress_application_id_fkey/,
      );
    });

    it('the progress goes away with its user', async () => {
      const applicationId = await freshApplication();
      const user = await t.owner.query<{ id: number }>(
        `INSERT INTO app_user (name, email, password_hash, role)
         VALUES ('Progress only', 'progress-only@example.test', 'not-a-real-hash', 'READER') RETURNING id`,
      );
      const userId = user.rows[0]!.id;
      await t.owner.query(
        `INSERT INTO onboarding_progress (user_id, application_id, step) VALUES ($1, $2, 1), ($1, $2, 2)`,
        [userId, applicationId],
      );
      assert.equal((await rowsOf(applicationId, userId)).length, 2);
      await t.owner.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
      assert.deepEqual(await rowsOf(applicationId, userId), []);
    });

    it('the API role can read and write the table but cannot change its structure', async () => {
      const applicationId = await freshApplication();
      await complete(applicationId, 1);
      assert.equal(
        (await t.db.base.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM onboarding_progress`).length,
        1,
      );
      await assert.rejects(t.db.base.$executeRawUnsafe(`ALTER TABLE onboarding_progress DROP COLUMN step`));
    });
  });
});
