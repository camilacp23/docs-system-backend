/**
 * Module 9, `PUT /reports/{id}/publication` (FR-22; D-47, D-62, D-71, D-121): the answers in their order (400 -> 404 ->
 * 412 -> 409), the same value that writes nothing, unpublishing, an archived application, the roles, and the two
 * concurrency guarantees: a report that is being generated (its row locked by the worker) answers 409 at once without
 * waiting for it, and two simultaneous PUTs on a READY report both succeed and leave ONE audit record. Several rounds.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication, setApplicationStatus } from '../helpers/fixtures.js';
import { auditOfReport, insertReport, reportOf } from '../helpers/reports.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { asUser } from '../helpers/users.js';

const ROUNDS = 5;

describe('reports: PUT /reports/{id}/publication', () => {
  let t: TestApp;
  let applicationId: number;
  const pgOverlap = watchPgOverlap();

  before(async () => {
    t = await startTestApp();
    try {
      applicationId = (await insertApplication(t)).id;
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  const admin = () => asUser(t, t.users.admin.token);
  const put = (id: number | string, isPublished: boolean | undefined, ifMatch?: string, as = admin()) =>
    as.put(`/reports/${id}/publication`, isPublished === undefined ? {} : { isPublished }, ifMatch);
  const read = async (id: number) => reportOf(await admin().get(`/reports/${id}`));
  const etagOf = (updatedAt: string) => `W/"${new Date(updatedAt).getTime()}"`;

  describe('200', () => {
    it('publishes a READY report: isPublished and publishedAt, a new ETag, one UPDATE in the audit', async () => {
      const id = await insertReport(t, { applicationId });
      const before = await read(id);
      const res = await put(id, true);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      await assertConformsToContract(res);
      const report = reportOf(res);
      assert.equal(report.isPublished, true);
      assert.ok(report.publishedAt !== null);
      assert.equal('parameters' in report, false);
      assert.equal(res.headers['etag'], etagOf(report.updatedAt));
      assert.notEqual(report.updatedAt, before.updatedAt);
      const records = await auditOfReport(t, id, 'UPDATE');
      assert.equal(records.length, 1);
      assert.equal(records[0]!.action, 'UPDATE');
      assert.equal(records[0]!.actor_user_id, t.users.admin.id);
      assert.deepEqual([...records[0]!.changed_fields].sort(), ['is_published', 'published_at']);
    });

    it('unpublishes: isPublished false and publishedAt null', async () => {
      const id = await insertReport(t, { applicationId, published: true });
      const res = await put(id, false);
      assert.equal(res.status, 200);
      const report = reportOf(res);
      assert.deepEqual([report.isPublished, report.publishedAt], [false, null]);
      assert.deepEqual([(await read(id)).isPublished, (await read(id)).publishedAt], [false, null]);
    });

    it('the same value writes nothing: 200 with the same ETag and updatedAt, and no audit record', async () => {
      for (const published of [true, false]) {
        const id = await insertReport(t, { applicationId, published });
        const before = await read(id);
        const res = await put(id, published);
        assert.equal(res.status, 200);
        assert.equal(reportOf(res).updatedAt, before.updatedAt);
        assert.equal(res.headers['etag'], etagOf(before.updatedAt));
        assert.deepEqual(await auditOfReport(t, id, 'UPDATE'), []);
      }
    });

    it('a Developer can publish; an archived application does not stop it (D-47)', async () => {
      const archived = (await insertApplication(t)).id;
      const id = await insertReport(t, { applicationId: archived });
      await setApplicationStatus(t, archived, 'ARCHIVED');
      const res = await put(id, true, undefined, asUser(t, t.users.developer.token));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(reportOf(res).isPublished, true);
    });

    it('a Reader sees the report once it is published, and not after it is unpublished', async () => {
      const id = await insertReport(t, { applicationId });
      const reader = asUser(t, t.users.reader.token);
      assert.equal((await reader.get(`/reports/${id}`)).status, 404);
      await put(id, true);
      assert.equal((await reader.get(`/reports/${id}`)).status, 200);
      await put(id, false);
      assert.equal((await reader.get(`/reports/${id}`)).status, 404);
    });
  });

  describe('errors, in order', () => {
    it('a Reader is 403 before anything else, even for a report that does not exist', async () => {
      const id = await insertReport(t, { applicationId });
      const reader = asUser(t, t.users.reader.token);
      for (const target of [id, 999_999]) {
        const res = await put(target, true, undefined, reader);
        assert.equal(res.status, 403);
        assert.equal(bodyOf(res).code, 'FORBIDDEN');
      }
      assert.equal((await t.http.put(`/api/v1/reports/${id}/publication`).send({ isPublished: true })).status, 401);
    });

    it('400 comes first: a text id, no body, a text value, an unknown property', async () => {
      const id = await insertReport(t, { applicationId });
      const cases: [string, () => ReturnType<typeof put>][] = [
        ['a text id', () => put('abc', true)],
        ['no isPublished', () => put(id, undefined)],
        ['a text value', () => admin().put(`/reports/${id}/publication`, { isPublished: 'yes' })],
        ['an unknown property', () => admin().put(`/reports/${id}/publication`, { isPublished: true, extra: 1 })],
      ];
      for (const [name, send] of cases) {
        const res = await send();
        assert.equal(res.status, 400, name);
        await assertConformsToContract(res);
      }
    });

    it('404 for a report that does not exist, also outside the integer range, before the If-Match is read', async () => {
      for (const id of [999_999, 2_147_483_648]) {
        const res = await put(id, true, 'W/"1"');
        assert.equal(res.status, 404, String(id));
        assert.deepEqual(bodyOf(res).details, { element: 'report', id: id > 2_147_483_647 ? String(id) : id });
        await assertConformsToContract(res);
      }
    });

    it('412 with details.currentETag when If-Match is not the current one; the matching one passes', async () => {
      const id = await insertReport(t, { applicationId });
      const current = etagOf((await read(id)).updatedAt);
      const stale = await put(id, true, 'W/"1"');
      assert.equal(stale.status, 412);
      assert.equal(bodyOf(stale).code, 'PRECONDITION_FAILED');
      assert.equal((bodyOf(stale).details as unknown as { currentETag: string }).currentETag, current);
      await assertConformsToContract(stale);
      assert.equal((await read(id)).isPublished, false, 'nothing was written');
      assert.equal((await put(id, true, current)).status, 200);
    });

    it('If-Match is checked also when the value does not change', async () => {
      const id = await insertReport(t, { applicationId, published: true });
      assert.equal((await put(id, true, 'W/"1"')).status, 412);
      assert.equal((await put(id, true, etagOf((await read(id)).updatedAt))).status, 200);
    });

    it('409 REPORT_NOT_READY for a PENDING or FAILED report, also to unpublish; the 412 comes before it', async () => {
      for (const status of ['PENDING', 'FAILED'] as const) {
        const id = await insertReport(t, { applicationId, status });
        for (const value of [true, false]) {
          const res = await put(id, value);
          assert.equal(res.status, 409, `${status} ${value}`);
          assert.equal(bodyOf(res).code, 'REPORT_NOT_READY');
          assert.deepEqual(bodyOf(res).details, { status });
          await assertConformsToContract(res);
        }
        assert.equal((await put(id, true, 'W/"1"')).status, 412, 'the 412 goes first');
        assert.equal((await read(id)).isPublished, false);
      }
    });
  });

  describe('concurrency', () => {
    /** A connection of its own, as the worker's transaction: it locks the row and keeps the lock until `release`. */
    async function lockLikeTheWorker(id: number) {
      const worker = new pg.Client({ connectionString: t.testDb.ownerUrl });
      await worker.connect();
      await worker.query('BEGIN');
      await worker.query(`SELECT id FROM report WHERE id = $1 FOR UPDATE`, [id]);
      return {
        release: async () => {
          await worker.query('ROLLBACK');
          await worker.end();
        },
      };
    }

    it('a report that is being generated answers 409 at once, without waiting for the worker (several rounds)', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const id = await insertReport(t, { applicationId, status: 'PENDING' });
        const lock = await lockLikeTheWorker(id);
        try {
          // If the PUT waited for the lock this would never resolve (the lock is released only after the answer): the
          // race turns that into a failure instead of a hang.
          const started = performance.now();
          const res = await Promise.race([
            put(id, true),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('the PUT waited for the lock of the report')), 20_000).unref(),
            ),
          ]);
          assert.equal(res.status, 409, `round ${round}`);
          assert.deepEqual(bodyOf(res).details, { status: 'PENDING' });
          assert.ok(performance.now() - started < 5_000, 'it answered without waiting');
        } finally {
          await lock.release();
        }
      }
    });

    it('the reads do not wait for the worker either: the detail of a report being generated is answered', async () => {
      const id = await insertReport(t, { applicationId, status: 'PENDING' });
      const lock = await lockLikeTheWorker(id);
      try {
        const [detail, file] = await Promise.race([
          Promise.all([admin().get(`/reports/${id}`), admin().get(`/reports/${id}/file`)]),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('a read waited for the lock of the report')), 20_000).unref(),
          ),
        ]);
        assert.equal(detail.status, 200);
        assert.equal(file.status, 409);
      } finally {
        await lock.release();
      }
    });

    it('two simultaneous PUTs on a READY report both succeed, with ONE audit record (several rounds)', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const id = await insertReport(t, { applicationId });
        const [first, second] = await Promise.all([put(id, true), put(id, true)]);
        assert.equal(first.status, 200, `round ${round}: ${JSON.stringify(first.body)}`);
        assert.equal(second.status, 200, `round ${round}: ${JSON.stringify(second.body)}`);
        assert.equal(first.headers['etag'], second.headers['etag'], "the second saw the first one's write");
        const records = await auditOfReport(t, id, 'UPDATE');
        assert.equal(records.length, 1, `round ${round}`);
      }
    });

    it('two PUTs with the same If-Match: one writes, the other is a 412 (several rounds)', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const id = await insertReport(t, { applicationId });
        const current = etagOf((await read(id)).updatedAt);
        const results = await Promise.all([put(id, true, current), put(id, true, current)]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 412], `round ${round}`);
        assert.equal((await auditOfReport(t, id, 'UPDATE')).length, 1, `round ${round}`);
      }
    });
  });
});
